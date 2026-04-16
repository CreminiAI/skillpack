# Electron 桌面 App — skill-pack 修改计划

## 目标

在 `skill-pack` 中新增 IPC 通信能力，使 Electron 桌面 App 可以：

1. 通过 Node.js IPC（无需端口）与 skillpack 子进程通信
2. 查看所有 IM 会话列表（含元数据）
3. 加载指定会话的历史消息
4. 在任意会话中发送消息并接收实时响应
5. 实时接收所有平台（Telegram/Slack/Web）的入站消息

---

## IPC 消息协议定义

### Electron → Skillpack（请求）

```typescript
type IpcRequest =
  // 会话管理
  | { id: string; type: "get_conversations" }
  | { id: string; type: "get_messages"; channelId: string; limit?: number }

  // 消息发送（Electron 在某个会话中回复）
  | { id: string; type: "send_message"; channelId: string; text: string }

  // 命令
  | { id: string; type: "command"; command: BotCommand; channelId: string }

  // 配置与状态
  | { id: string; type: "get_config" }
  | { id: string; type: "update_config"; updates: Partial<DataConfig> }
  | { id: string; type: "get_status" }

  // 定时任务
  | { id: string; type: "get_scheduled_jobs" }
  | { id: string; type: "add_scheduled_job"; job: ScheduledJobConfig }
  | { id: string; type: "remove_scheduled_job"; name: string };
```

### Skillpack → Electron（响应 & 推送）

```typescript
// 响应（有 id，对应请求）
type IpcResponse =
  | { id: string; type: "result"; data: any }
  | { id: string; type: "error"; message: string };

// 推送事件（无 id，实时流）
type IpcPushEvent =
  // Agent 处理过程中的事件流（text_delta / tool_start 等）
  | { type: "agent_event"; channelId: string; event: AgentEvent }

  // 入站消息通知（Telegram/Slack 用户发来的消息）
  | {
      type: "inbound_message";
      channelId: string;
      platform: string;
      sender: { id: string; username: string };
      text: string;
      timestamp: number;
    }

  // 就绪通知
  | { type: "ready"; port: number };
```

### 会话数据结构

```typescript
// getConversations 返回值 — 轻量列表，不含消息内容
interface ConversationSummary {
  channelId: string; // "telegram-12345" / "slack-C07xxx" / "web-xxx"
  platform: "telegram" | "slack" | "web" | "scheduler";
  sessionFile: string | null; // .jsonl 文件路径
  messageCount: number; // 消息总数
  lastMessageAt: string; // 最后消息时间 (ISO)
  lastMessagePreview: string; // 最后一条消息的前 100 字
}

// getMessages 返回值 — 精简后的消息列表（去掉 tool 细节、thinking 等）
interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string; // 纯文本内容
  timestamp: string;
  // 可选：工具调用摘要（不含完整参数/结果）
  toolCalls?: Array<{ name: string; isError: boolean }>;
}
```

---

## 修改文件清单

### 改动总览

```
src/runtime/
├── adapters/
│   ├── ipc.ts              ← [NEW] IPC 适配器（核心）
│   ├── telegram.ts         ← [MODIFY] 注入 IPC 广播
│   ├── slack.ts            ← [MODIFY] 注入 IPC 广播
│   ├── web.ts              ← [MODIFY] 注入 IPC 广播
│   └── types.ts            ← [MODIFY] 新增 IpcBroadcaster 接口
├── services/
│   └── conversation.ts     ← [NEW] 会话读取服务
└── server.ts               ← [MODIFY] 注册 IpcAdapter + 注入广播器
```

---

### 1. [NEW] `src/runtime/services/conversation.ts`（~120 行）

**职责**：从磁盘读取会话数据，提供结构化查询能力。

```typescript
import fs from "node:fs";
import path from "node:path";
import {
  parseSessionEntries,
  buildSessionContext,
  type SessionEntry,
  type SessionMessageEntry,
  type FileEntry,
} from "@mariozechner/pi-coding-agent";

export interface ConversationSummary {
  /* 见上方定义 */
}
export interface ConversationMessage {
  /* 见上方定义 */
}

export class ConversationService {
  constructor(private rootDir: string) {}

  /**
   * 扫描 data/sessions/ 获取所有会话摘要
   */
  listConversations(activeChannels: Set<string>): ConversationSummary[] {
    const sessionsDir = path.resolve(this.rootDir, "data", "sessions");
    if (!fs.existsSync(sessionsDir)) return [];

    const results: ConversationSummary[] = [];

    for (const channelId of fs.readdirSync(sessionsDir)) {
      const channelDir = path.join(sessionsDir, channelId);
      if (!fs.statSync(channelDir).isDirectory()) continue;

      // 找到最新的 .jsonl 文件
      const sessionFiles = fs
        .readdirSync(channelDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      const sessionFile = sessionFiles[0]
        ? path.join(channelDir, sessionFiles[0])
        : null;
      let messageCount = 0;
      let lastMessageAt = "";
      let lastMessagePreview = "";

      if (sessionFile) {
        const entries = this.loadEntries(sessionFile);
        const messages = entries.filter(
          (e): e is SessionMessageEntry => e.type === "message",
        );
        messageCount = messages.length;

        const lastMsg = messages[messages.length - 1];
        if (lastMsg) {
          lastMessageAt = lastMsg.timestamp;
          lastMessagePreview = this.extractTextPreview(lastMsg, 100);
        }
      }

      results.push({
        channelId,
        platform: this.detectPlatform(channelId),
        sessionFile,
        messageCount,
        lastMessageAt,
        lastMessagePreview,
      });
    }

    // 按最后消息时间倒序
    return results.sort((a, b) =>
      (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""),
    );
  }

  /**
   * 读取指定会话的消息历史（精简格式）
   */
  getMessages(channelId: string, limit = 100): ConversationMessage[] {
    const sessionsDir = path.resolve(
      this.rootDir,
      "data",
      "sessions",
      channelId,
    );
    if (!fs.existsSync(sessionsDir)) return [];

    const sessionFiles = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (sessionFiles.length === 0) return [];

    const sessionFile = path.join(sessionsDir, sessionFiles[0]);
    const entries = this.loadEntries(sessionFile);

    // 只取 user 和 assistant 消息，跳过 toolResult、thinking 等
    const messages: ConversationMessage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = (entry as SessionMessageEntry).message;
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const text = this.extractText(msg);
      if (!text) continue;

      const toolCalls =
        msg.role === "assistant"
          ? this.extractToolCallSummaries(msg)
          : undefined;

      messages.push({
        id: entry.id,
        role: msg.role as "user" | "assistant",
        text,
        timestamp: entry.timestamp,
        toolCalls,
      });
    }

    return messages.slice(-limit);
  }

  private loadEntries(filePath: string): SessionEntry[] {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileEntries = parseSessionEntries(content);
    // parseSessionEntries 返回 FileEntry[]，过滤掉 header
    return fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  private extractText(message: any): string {
    if (!message.content) return "";
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("")
        .trim();
    }
    return "";
  }

  private extractTextPreview(
    entry: SessionMessageEntry,
    maxLen: number,
  ): string {
    const text = this.extractText(entry.message);
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  private extractToolCallSummaries(
    msg: any,
  ): Array<{ name: string; isError: boolean }> | undefined {
    if (!Array.isArray(msg.content)) return undefined;
    const calls = msg.content
      .filter((c: any) => c.type === "toolCall")
      .map((c: any) => ({ name: c.name || "unknown", isError: false }));
    return calls.length > 0 ? calls : undefined;
  }

  private detectPlatform(
    channelId: string,
  ): "telegram" | "slack" | "web" | "scheduler" {
    if (channelId.startsWith("telegram-")) return "telegram";
    if (channelId.startsWith("slack-")) return "slack";
    if (channelId.startsWith("scheduler-")) return "scheduler";
    return "web";
  }
}
```

---

### 2. [NEW] `src/runtime/adapters/ipc.ts`（~150 行）

**职责**：通过 `process.send` / `process.on('message')` 与 Electron 通信。

```typescript
import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  IPackAgent,
  BotCommand,
} from './types.js';
import { ConversationService } from '../services/conversation.js';
import { configManager } from '../config.js';
import { isMessageSender } from './types.js';

type IpcRequest = /* 见协议定义 */;

export class IpcAdapter implements PlatformAdapter {
  readonly name = 'ipc';
  private agent: IPackAgent | null = null;
  private conversationService: ConversationService | null = null;
  private adapterMap: Map<string, PlatformAdapter> | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    // 没有 IPC 通道则跳过（普通 CLI 模式）
    if (typeof process.send !== 'function') {
      console.log('[IpcAdapter] No IPC channel, skipping');
      return;
    }

    this.agent = ctx.agent;
    this.adapterMap = ctx.adapterMap ?? null;
    this.conversationService = new ConversationService(ctx.rootDir);

    process.on('message', (msg: IpcRequest) => {
      void this.handleRequest(msg);
    });

    console.log('[IpcAdapter] Started');
  }

  /**
   * 被 server.ts 调用，通知实际监听端口
   */
  notifyReady(port: number): void {
    if (typeof process.send === 'function') {
      process.send({ type: 'ready', port });
    }
  }

  /**
   * 广播入站消息事件（被 Telegram/Slack/Web 适配器调用）
   */
  broadcastInbound(channelId: string, platform: string,
                    sender: { id: string; username: string },
                    text: string): void {
    if (typeof process.send !== 'function') return;
    process.send({
      type: 'inbound_message',
      channelId, platform, sender, text,
      timestamp: Date.now(),
    });
  }

  /**
   * 广播 Agent 事件（被所有适配器的 onEvent 回调调用）
   */
  broadcastAgentEvent(channelId: string, event: AgentEvent): void {
    if (typeof process.send !== 'function') return;
    process.send({ type: 'agent_event', channelId, event });
  }

  private async handleRequest(msg: IpcRequest): Promise<void> {
    if (!msg?.id || !msg?.type) return;
    if (!this.agent) return;

    try {
      switch (msg.type) {
        case 'get_conversations': {
          // 获取活跃 channel 集合
          const activeChannels = new Set<string>();
          // 注意：需要 PackAgent 暴露一个方法来获取活跃 channel 列表
          const conversations = this.conversationService!.listConversations(activeChannels);
          this.reply(msg.id, conversations);
          break;
        }

        case 'get_messages': {
          const messages = this.conversationService!.getMessages(msg.channelId, msg.limit);
          this.reply(msg.id, messages);
          break;
        }

        case 'send_message': {
          let fullText = '';
          const platform = this.detectPlatform(msg.channelId);

          const result = await this.agent.handleMessage(
            platform, msg.channelId, msg.text,
            (event) => {
              if (event.type === 'text_delta') fullText += event.delta;
              this.broadcastAgentEvent(msg.channelId, event);
            },
          );

          // ★ 关键：将 Agent 回复转发到对应 IM 平台
          if (fullText.trim() && platform !== 'web') {
            const adapter = this.adapterMap?.get(platform);
            if (adapter && isMessageSender(adapter)) {
              await adapter.sendMessage(msg.channelId, fullText);
            }
          }

          this.reply(msg.id, { ...result, text: fullText });
          break;
        }

        case 'command': {
          const result = await this.agent.handleCommand(msg.command as BotCommand, msg.channelId);
          this.reply(msg.id, result);
          break;
        }

        case 'get_config': {
          this.reply(msg.id, configManager.getConfig());
          break;
        }

        case 'get_status': {
          this.reply(msg.id, { status: 'running', pid: process.pid });
          break;
        }

        default:
          this.replyError(msg.id, `Unknown request type: ${(msg as any).type}`);
      }
    } catch (err) {
      this.replyError(msg.id, err instanceof Error ? err.message : String(err));
    }
  }

  private reply(id: string, data: any): void {
    process.send!({ id, type: 'result', data });
  }

  private replyError(id: string, message: string): void {
    process.send!({ id, type: 'error', message });
  }

  private detectPlatform(channelId: string): 'telegram' | 'slack' | 'web' | 'scheduler' {
    if (channelId.startsWith('telegram-')) return 'telegram';
    if (channelId.startsWith('slack-')) return 'slack';
    if (channelId.startsWith('scheduler-')) return 'scheduler';
    return 'web';
  }

  async stop(): Promise<void> {
    console.log('[IpcAdapter] Stopped');
  }
}
```

---

### 3. [MODIFY] `src/runtime/adapters/types.ts`（+10 行）

新增 `IpcBroadcaster` 接口，让适配器可以通知 IPC 层：

```typescript
// 新增到 AdapterContext 中
export interface AdapterContext {
  // ... 现有字段 ...

  /** IPC 广播器（可选，仅桌面 App 模式有）*/
  ipcBroadcaster?: IpcBroadcaster;
}

/** IPC 广播接口，用于将 IM 消息转发给 Electron */
export interface IpcBroadcaster {
  broadcastInbound(
    channelId: string,
    platform: string,
    sender: { id: string; username: string },
    text: string,
  ): void;
  broadcastAgentEvent(channelId: string, event: AgentEvent): void;
}
```

---

### 4. [MODIFY] `src/runtime/adapters/telegram.ts`（+8 行）

在消息处理中注入 IPC 广播，**两处**：

**4a. 入站消息广播** — `handleTelegramMessage()` 方法开头（约第 101 行后）：

```typescript
// 在 const channelId = `telegram-${chatId}`; 之后添加：
if (this.ipcBroadcaster) {
  this.ipcBroadcaster.broadcastInbound(
    channelId,
    "telegram",
    {
      id: String(msg.from?.id || ""),
      username: msg.from?.username || "",
    },
    text,
  );
}
```

**4b. Agent 事件广播** — `onEvent` 回调中（约第 133 行）：

```typescript
const onEvent = (event: AgentEvent) => {
  switch (event.type /* 现有逻辑不变 */) {
  }
  // ★ 新增一行
  this.ipcBroadcaster?.broadcastAgentEvent(channelId, event);
};
```

**4c. 保存 broadcaster 引用** — `start()` 方法中：

```typescript
async start(ctx: AdapterContext): Promise<void> {
  this.agent = ctx.agent;
  this.rootDir = ctx.rootDir;
  this.ipcBroadcaster = ctx.ipcBroadcaster ?? null;  // ★ 新增
  // ... 后续不变 ...
}
```

---

### 5. [MODIFY] `src/runtime/adapters/slack.ts`（+8 行）

与 Telegram 完全对称的修改：

- `start()` 中保存 `ipcBroadcaster`
- 入站消息处调用 `broadcastInbound`
- `onEvent` 回调中调用 `broadcastAgentEvent`

---

### 6. [MODIFY] `src/runtime/adapters/web.ts`（+5 行）

Web 适配器的 `handleWsConnection` 中同样广播 Agent 事件：

```typescript
// handleWsConnection 中的 onEvent 回调
const onEvent = (event: AgentEvent) => {
  sendWsEvent(ws, event);
  this.ipcBroadcaster?.broadcastAgentEvent(channelId, event); // ★ 新增
};
```

---

### 7. [MODIFY] `src/runtime/server.ts`（+20 行）

**7a. 导入并实例化 IpcAdapter：**

```typescript
import { IpcAdapter } from "./adapters/ipc.js";

// 在创建 adapters 数组之后、WebAdapter 之前：
const ipcAdapter = new IpcAdapter();
```

**7b. 注册 IpcAdapter 并构建 broadcaster：**

```typescript
// 在 WebAdapter.start() 之前
await ipcAdapter.start({ agent, server, app, rootDir, lifecycle, adapterMap });
adapters.push(ipcAdapter);
adapterMap.set(ipcAdapter.name, ipcAdapter);

// 构建 broadcaster 引用，传给后续的适配器
const ipcBroadcaster =
  typeof process.send === "function" ? ipcAdapter : undefined;
```

**7c. 传递 broadcaster 给其他适配器的 start()：**

```typescript
// WebAdapter
await webAdapter.start({
  agent,
  server,
  app,
  rootDir,
  lifecycle,
  adapterMap,
  ipcBroadcaster,
});

// TelegramAdapter
await telegramAdapter.start({
  agent,
  server,
  app,
  rootDir,
  lifecycle,
  ipcBroadcaster,
});

// SlackAdapter
await slackAdapter.start({
  agent,
  server,
  app,
  rootDir,
  lifecycle,
  ipcBroadcaster,
});
```

**7d. 监听完成后通知 Electron：**

```typescript
server.once('listening', () => {
  const actualPort = /* 现有逻辑 */;
  // ... 现有的日志和 registry 代码 ...

  // ★ 新增：通知 Electron 已就绪
  ipcAdapter.notifyReady(typeof actualPort === 'number' ? actualPort : port);
});
```

---

## 不需要修改的文件

| 文件                   | 原因                                                      |
| ---------------------- | --------------------------------------------------------- |
| `agent.ts` (PackAgent) | IPC 层调用的是已有的 `handleMessage`/`handleCommand` 接口 |
| `config.ts`            | 配置管理接口不变                                          |
| `lifecycle.ts`         | 生命周期管理不变                                          |
| `registry.ts`          | 注册表机制不变（Electron 用 IPC 不用 registry）           |
| `cli.ts`               | CLI 入口不变                                              |

---

## 改动量统计

| 文件                       | 类型   | 新增行数 | 修改行数 |
| -------------------------- | ------ | -------- | -------- |
| `services/conversation.ts` | 新文件 | ~120     | -        |
| `adapters/ipc.ts`          | 新文件 | ~150     | -        |
| `adapters/types.ts`        | 修改   | ~10      | 0        |
| `adapters/telegram.ts`     | 修改   | ~8       | 0        |
| `adapters/slack.ts`        | 修改   | ~8       | 0        |
| `adapters/web.ts`          | 修改   | ~5       | 0        |
| `server.ts`                | 修改   | ~20      | ~3       |
| **合计**                   |        | **~321** | **~3**   |

---

## 验证方案

### 自动测试

```bash
# 1. 编译
npm run build

# 2. 单元测试：ConversationService
# 用现有的 output2/data/sessions/ 测试数据验证会话读取

# 3. 集成测试：IPC 通信
# 写一个测试脚本，spawn skillpack 进程 + stdio: 'ipc'，
# 发送 get_conversations / get_messages / send_message 请求验证响应
```

### 手动验证

1. **普通 CLI 模式**不受影响：`skillpack run .` 照常工作，IpcAdapter 自动跳过
2. **IPC 模式**：用测试脚本模拟 Electron spawn，验证会话列表、消息加载、消息发送

---

## 开放问题

> [!IMPORTANT]
>
> ### Q1: PackAgent 是否需要暴露活跃 channel 列表？
>
> 当前 `PackAgent.channels` 是 private Map，`getConversations` 需要知道哪些 channel 有在内存中的活跃 session。
> 选择：(a) 给 PackAgent 加一个 `getActiveChannelIds(): string[]` 方法 (b) ConversationService 只看磁盘，不关心内存状态

> [!WARNING]
>
> ### Q2: Electron 发送消息到 IM 的回复格式
>
> 当 Electron 通过 `send_message` 在 `telegram-12345` 会话中发消息时，Agent 会处理并生成回复。这个回复需要发到 Telegram。但当前 Agent 的回复是**原始 Markdown**，而 Telegram 需要 HTML 格式（通过 `formatTelegramMessage` 转换）。
> 需要确认：IpcAdapter 转发到 Telegram 时是否需要走 `sendLongMessage`（自带格式转换和分段）而不是 `sendMessage`？

> [!NOTE]
>
> ### Q3: 是否需要在此阶段实现 update_config 和 scheduled_jobs 的 IPC 接口？
>
> 这些功能目前 WebAdapter 已有 HTTP 接口。如果仅用于 MVP，可以先只实现会话相关的 IPC 协议，配置管理走 HTTP 兜底。
