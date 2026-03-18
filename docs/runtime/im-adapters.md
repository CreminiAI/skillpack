# IM 平台适配器架构

## 概述

Runtime 支持多个 IM 平台同时接入，共用一个 `PackAgent` 实例和配置读取逻辑。目前已实现 **Web**、**Telegram** 和 **Slack** 三个 Adapter。

## 架构

```
                    ┌──────────────────┐
                    │     index.ts     │
                    │  读取配置，编排   │
                    └────────┬─────────┘
                             │ 创建共享 PackAgent
          ┌──────────────────┼──────────────────┬──────────────────┐
          ▼                  ▼                  ▼                  ▼
   ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
   │  WebAdapter  │  │TelegramAdapter│  │ SlackAdapter │  │ (未来扩展)   │
   └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  └──────────────┘
          │                  │                 │
          └────────┬─────────┴─────────────────┘
                   ▼
          ┌────────────────┐
          │   PackAgent    │  平台无关 Agent 层
          │  (per channel) │  管理 AgentSession
          └────────────────┘
```

所有 Adapter 实现同一个 `PlatformAdapter` 接口，`PackAgent` 完全不感知平台。每个 channel 的 session 懒加载创建，不同 Adapter 之间的 channel 相互隔离。

## 文件结构

```
runtime/server/
├── tsconfig.json              # TS 编译配置
├── package.json
├── src/                       # TypeScript 源码（不进入分发包）
│   ├── index.ts               # 入口：读配置、启动 Adapter
│   ├── agent.ts               # PackAgent（核心 Agent 层）
│   └── adapters/
│       ├── types.ts           # 共享接口定义
│       ├── web.ts             # WebAdapter
│       ├── telegram.ts        # TelegramAdapter
│       └── slack.ts           # SlackAdapter
└── dist/                      # 编译产物（进入 npm 包和 zip）
    ├── index.js
    ├── agent.js
    └── adapters/
        ├── types.js
        ├── web.js
        ├── telegram.js
        └── slack.js
```

## 核心接口

### PlatformAdapter

```typescript
interface PlatformAdapter {
  name: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
}

interface AdapterContext {
  agent: IPackAgent;
  server: http.Server;
  app: Express;
  rootDir: string;
}
```

### IPackAgent

```typescript
interface IPackAgent {
  /** 流式处理消息，通过 onEvent 回调实时吐出 AgentEvent */
  handleMessage(
    channelId: string,
    text: string,
    onEvent: (e: AgentEvent) => void,
  ): Promise<HandleResult>;

  /** 处理统一命令（/clear /restart /shutdown） */
  handleCommand(command: BotCommand, channelId: string): Promise<CommandResult>;

  abort(channelId: string): void;
  isRunning(channelId: string): boolean;
  dispose(channelId: string): void;

  // 预留：会话历史
  listSessions(): SessionInfo[];
  restoreSession(sessionId: string): Promise<void>;
}
```

### AgentEvent

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start"; role: string }
  | { type: "message_end"; role: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolInput: unknown }
  | { type: "tool_end"; toolName: string; isError: boolean; result: unknown };
```

## 配置

运行时配置通过 `data/config.json` 提供（此目录**不打包进 zip**），环境变量优先级更高可覆盖配置文件。

```json
{
  "apiKey": "sk-...",
  "provider": "openai",
  "adapters": {
    "telegram": {
      "token": "123456:ABC-DEF..."
    },
    "slack": {
      "botToken": "xoxb-...",
      "appToken": "xapp-..."
    }
  }
}
```

- `data/config.json` 先读取，优先级最高
- 如果 `data/config.json` 未设置或读取失败，则读取环境变量 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- **Web Adapter 始终启用**
- Telegram 仅在配置了 `adapters.telegram.token` 时动态 import 并启动
- Slack 仅在同时配置了 `adapters.slack.botToken` 与 `adapters.slack.appToken` 时动态 import 并启动；缺一则记录 warning 并跳过

## 统一命令系统

所有 Adapter 均支持以下命令（消息文本以 `/` 开头触发），由 `PackAgent.handleCommand()` 统一处理：

| 命令        | 行为                                                  |
| ----------- | ----------------------------------------------------- |
| `/clear`    | 销毁当前 channel 的 AgentSession，下次消息重新创建    |
| `/restart`  | 延迟 500ms 后 `process.exit(0)`，由进程管理器负责重启 |
| `/shutdown` | 延迟 500ms 后 `process.exit(0)`                       |

> `/restart` 与 `/shutdown` 在代码层面行为相同，均为 `process.exit(0)`；语义区分由外部进程管理器（如 `pm2`）决定。

Slack 额外暴露 namespaced slash commands：

| Slack 命令            | 映射到     |
| --------------------- | ---------- |
| `/skillpack-clear`    | `clear`    |
| `/skillpack-restart`  | `restart`  |
| `/skillpack-shutdown` | `shutdown` |

> Slack 限制 slash command 不能在消息线程内直接触发，因此频道内会优先作用于该频道最近一个活跃的 Skillpack 线程；若没有活跃线程，会提示用户先 `@bot` 发起线程，或直接在对应线程里发送 `@bot /clear` 这类文本命令。

## WebAdapter

- **始终启用**，负责 HTTP REST API 和 WebSocket 聊天
- 每个 WebSocket 连接生成独立 `channelId`（格式：`web-<timestamp>-<random>`），连接断开时自动 `dispose`
- 流式生成：每个 `AgentEvent` 立即通过 `ws.send()` 推送到前端
- WebSocket 握手仅处理 `/api/chat` 路径，其他 upgrade 请求直接 `socket.destroy()`

### HTTP API

| 端点                | 方法      | 作用                                                                  |
| ------------------- | --------- | --------------------------------------------------------------------- |
| `/api/config`       | GET       | pack 名称、描述、prompts、skills、provider、是否有 API Key            |
| `/api/skills`       | GET       | skills 列表（读 `skillpack.json`）                                    |
| `/api/config/key`   | POST      | 保存并在内存中更新 API Key 和 provider（持久化到 `data/config.json`） |
| `/api/chat`         | WebSocket | 聊天主通道                                                            |
| `/api/chat`         | DELETE    | 占位，返回 `{ success: true }`                                        |
| `/api/sessions`     | GET       | 会话列表（预留，当前返回空数组）                                      |
| `/api/sessions/:id` | GET       | 恢复历史会话（预留，返回 501）                                        |

### WebSocket 消息协议

**前端 → 服务端**

```json
{ "text": "user input" }
```

**服务端 → 前端（流式 AgentEvent）**

各类 `AgentEvent` 逐条 JSON 发送；结束时：

```json
{ "done": true }
```

若有错误：

```json
{ "error": "error message" }
```

命令执行结果：

```json
{
  "type": "command_result",
  "command": "clear",
  "success": true,
  "message": "Session cleared."
}
```

## TelegramAdapter

- Polling 模式（`node-telegram-bot-api`），适合私有部署，无需公网 webhook
- 每个 Telegram Chat ID 对应一个独立的 channel（`telegram-<chatId>`），session 在进程生命周期内持久复用
- 启动时向 Telegram 注册命令菜单（`/clear`、`/restart`、`/shutdown`）
- **只发最终结果**（纯文本），不暴露 `thinking_delta` / `tool_start` / `tool_end` 中间事件
- 消息发送前发送 `typing` 动作作为"思考中"指示器
- 长消息自动分割（上限 4096 字符），分割优先在段落（`\n\n`）→ 换行（`\n`）→ 空格处断开
- HTTP 429 自动重试（最多 3 次，等待 `retry_after` 秒）

> **注意**：当前 Telegram 发送纯文本，Markdown 转义函数（`escapeMarkdownV2` / `toTelegramFormat`）已定义但暂未启用，复杂 Markdown 格式化留待后续增强。

## SlackAdapter

- Socket Mode（`@slack/bolt`），适合私有部署，无需公网 webhook
- 监听 `message.im` 与 `app_mention`
- DM 会话使用 `channelId = slack-dm-<teamId>-<channelId>`
- 频道 mention 会话按线程隔离，使用 `channelId = slack-thread-<teamId>-<channelId>-<threadTs|ts>`
- 频道回复始终发回原线程；如果 mention 发生在非线程消息上，则以该消息的 `ts` 新开线程
- 过滤 bot/self message、带 subtype 的系统消息、以及未命中的非 mention 消息
- 发送给 Agent 前移除开头的 bot mention；若 mention 后没有正文，会返回简短提示
- **只发最终结果**（纯文本），不暴露 `thinking_delta` / `tool_start` / `tool_end` 中间事件
- 长消息按段落优先分片发送；Slack API 限流时最多自动重试 3 次
- 线程内文本命令继续支持 `/clear`、`/restart`、`/shutdown`

### Slack App 准备要求

- 开启 Socket Mode
- 创建 app-level token，并授予 `connections:write`
- Bot scopes 至少包含 `chat:write`、`im:history`、`app_mentions:read`
- 事件订阅至少包含 `message.im`、`app_mention`
- 配置 slash commands：`/skillpack-clear`、`/skillpack-restart`、`/skillpack-shutdown`

## 新增 Adapter 指南

1. 在 `src/adapters/` 下新建 `xxx.ts`
2. 实现 `PlatformAdapter` 接口（`name`、`start(ctx)`、`stop()`）
3. 在 `src/index.ts` 的 `startAdapters()` 中根据 `dataConfig.adapters.xxx` 条件启动
4. 构建：`npm run build`（`cd runtime/server && tsc`）

## 构建 & 分发流程

```
开发者:  npm run build
         └─ build:runtime: cd runtime/server && tsc  →  dist/
         └─ tsup: 构建 CLI  →  dist/cli.js
         npm publish
         └─ runtime/server/dist/ 进入 npm 包
         └─ runtime/server/src/  被 .npmignore 排除

用户:    npx skillpack init
         └─ 复制 runtime/（含 dist/）到目标目录
         npx skillpack bundle
         └─ addRuntimeFiles 排除 server/src/ 和 server/tsconfig.json
         └─ zip 只含 dist/

终端用户: 解压 zip → start.sh → node dist/index.js
```
