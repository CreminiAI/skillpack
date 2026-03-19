# Agent Memory 功能架构设计 —— 基于 OpenViking

## 背景

当前 [PackAgent](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts#80-315) 使用 `pi-coding-agent` SDK 管理会话（Session），每个 channel 独立维护一个 `AgentSession`，聊天记录存储在 pi 的内存中。进程重启后所有历史对话丢失，Agent 也无法跨会话"记住"用户偏好或历史经验。

**目标**：借助 [OpenViking](https://github.com/volcengine/OpenViking) 为 Agent 增加 **Memory 功能**，使其：
1. **长期记忆** —— 自动从对话中提取 profile、preferences、entities、events、cases、patterns 等 6 类记忆，跨会话复用
2. **上下文检索** —— 每次对话开头，从 OpenViking 检索相关记忆注入 system prompt
3. **资源管理** —— 可选：将外部知识导入 OpenViking 作为 Agent 的知识库

## 核心方案

### 集成方式：OpenViking HTTP Server（Sidecar 模式）

> [!IMPORTANT]
> OpenViking 是 Python 项目，skill-pack 是 TypeScript 项目。**推荐通过 HTTP API 集成**，而非嵌入式 SDK。

```
┌───────────────────────────────────┐     ┌──────────────────────────────┐
│        skill-pack runtime         │     │     OpenViking Server        │
│  ┌─────────────────────────────┐  │     │     (Python, port 1933)      │
│  │       PackAgent             │  │     │                              │
│  │  ┌───────────────────────┐  │──┼────▶│  /api/v1/sessions            │
│  │  │  MemoryManager        │  │  │     │  /api/v1/sessions/:id/messages│
│  │  │  (HTTP Client)        │  │  │     │  /api/v1/sessions/:id/commit │
│  │  └───────────────────────┘  │  │     │  /api/v1/search/find         │
│  │  ┌───────────────────────┐  │  │     │  /api/v1/fs/read             │
│  │  │  pi AgentSession      │  │  │     │                              │
│  │  │  (聊天记录/推理引擎)  │  │  │     │  viking://                   │
│  │  └───────────────────────┘  │  │     │  ├── user/memories/          │
│  └─────────────────────────────┘  │     │  │   ├── profile.md          │
│                                   │     │  │   ├── preferences/        │
│  Adapters: Web / Telegram / Slack │     │  │   ├── entities/           │
└───────────────────────────────────┘     │  │   └── events/             │
                                          │  ├── agent/memories/         │
                                          │  │   ├── cases/              │
                                          │  │   └── patterns/           │
                                          │  └── resources/              │
                                          └──────────────────────────────┘
```

**职责分工**：
- **pi AgentSession**：继续管理当前对话的推理循环（prompt → LLM → tool → response）
- **MemoryManager**：新组件，负责与 OpenViking HTTP API 通信，管理记忆同步和检索
- **OpenViking Server**：独立部署的 Sidecar 服务，负责记忆存储、LLM 记忆提取、语义检索

---

## 数据流设计

### 1. 对话开始 —— 检索记忆注入 Context

```
用户发送消息
       │
       ▼
PackAgent.handleMessage(channelId, text)
       │
       ├── 1. memoryManager.retrieveMemories(text)
       │     └── POST /api/v1/search/find { query: text, target_uri: "viking://user/memories" }
       │     └── 返回相关记忆片段 (L0/L1 摘要)
       │
       ├── 2. 将记忆注入 system prompt 或作为前置 context
       │     └── session.systemPromptSuffix = formatMemoryContext(memories)
       │
       └── 3. session.prompt(text)  // pi 正常推理
```

### 2. 对话进行中 —— 同步消息到 OpenViking Session

```
pi AgentSession 的每条消息
       │
       ├── user 消息  ──▶  POST /api/v1/sessions/{ovSessionId}/messages
       │                    { role: "user", content: text }
       │
       └── assistant 消息 ──▶  POST /api/v1/sessions/{ovSessionId}/messages
                                { role: "assistant", content: text }
```

> 消息同步是**异步、尽力而为**的，不阻塞主推理流程。tool_start/tool_end 事件可选同步为 ToolPart。

### 3. 会话结束/清除 —— 提交并提取记忆

```
PackAgent.handleCommand("clear", channelId)
  或  WebSocket 断开 (dispose)
  或  消息轮次结束后手动触发
       │
       ▼
memoryManager.commitSession(ovSessionId)
       └── POST /api/v1/sessions/{ovSessionId}/commit?wait=false
             └── OpenViking 后台异步：
                 1. 归档当前消息
                 2. LLM 生成结构化摘要
                 3. LLM 提取 6 类记忆候选
                 4. 向量去重 + LLM 去重决策
                 5. 写入 viking://user/memories/ 和 viking://agent/memories/
```

---

## 新增模块设计

### `MemoryManager` 类 (`runtime/server/src/memory.ts`)

```typescript
interface MemoryManagerOptions {
  /** OpenViking server base URL, 例如 http://localhost:1933 */
  serverUrl: string;
  /** 单次检索返回的最大记忆数 */
  maxMemories?: number;       // 默认 5
  /** 是否启用 Memory 功能 */
  enabled: boolean;
}

class MemoryManager {
  // ── 生命周期 ──
  /**
   * 为 channel 创建 OpenViking Session，
   * 映射关系：channelId → ovSessionId
   */
  async createSession(channelId: string): Promise<string>;

  /** 健康检查 */
  async healthCheck(): Promise<boolean>;

  // ── 消息同步 ──
  /** 添加消息到 OV Session（异步、fire-and-forget） */
  syncMessage(channelId: string, role: "user" | "assistant", content: string): void;

  // ── 记忆检索 ──
  /** 根据用户消息检索相关记忆，返回格式化的 context 字符串 */
  async retrieveMemories(query: string): Promise<string>;

  // ── 会话提交 ──
  /** 提交 OV Session，触发记忆提取（异步后台） */
  async commitSession(channelId: string): Promise<void>;

  /** 销毁 channel 的 OV Session */
  async disposeSession(channelId: string): Promise<void>;
}
```

### [PackAgent](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts#80-315) 改动 ([runtime/server/src/agent.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts))

```diff
 export class PackAgent implements IPackAgent {
   private options: PackAgentOptions;
   private channels = new Map<string, ChannelSession>();
+  private memoryManager?: MemoryManager;

   constructor(options: PackAgentOptions) {
     this.options = options;
+    if (options.memory?.enabled) {
+      this.memoryManager = new MemoryManager(options.memory);
+    }
   }

   // getOrCreateSession: 在创建 pi session 后，同步创建 OV session
   // handleMessage: 在 prompt 前检索记忆；订阅事件同步消息
   // handleCommand("clear"): 追加 commitSession
   // dispose: 追加 disposeSession
 }
```

### 配置扩展 (`data/config.json`)

```json
{
  "apiKey": "sk-...",
  "provider": "openai",
  "memory": {
    "enabled": true,
    "serverUrl": "http://localhost:1933",
    "maxMemories": 5
  },
  "adapters": { ... }
}
```

---

## 记忆注入策略

检索到的记忆将以 **System Prompt 后缀** 的方式注入：

```markdown
## 历史记忆（来自以往对话）

以下是与当前用户相关的历史记忆，请在回答时参考：

### 用户偏好
- 用户偏好使用中文交流
- 用户关注金融科技领域

### 相关经验
- 上次讨论过 IM 适配器架构重构...
```

pi-coding-agent 的 `AgentSession` 如果不直接支持修改 system prompt，可以将记忆作为每次 `prompt()` 调用前的一段隐式前置消息插入。

---

## 部署架构

```
┌─────────────────────────────────────────┐
│              用户部署环境                │
│                                          │
│  ┌──────────────┐   ┌────────────────┐  │
│  │ start.sh     │   │ openviking     │  │
│  │ node dist/   │   │ -server        │  │
│  │ index.js     │   │ (port 1933)    │  │
│  │ (port 3000)  │   │                │  │
│  └──────┬───────┘   └───────┬────────┘  │
│         │                   │            │
│         └───── HTTP ────────┘            │
│                                          │
│  PM2 管理两个进程                        │
└─────────────────────────────────────────┘
```

用户需要：
1. 安装 Python 3.10+ 并 `pip install openviking`
2. 配置 `~/.openviking/ov.conf`（需要配置 embedding 和 VLM 模型的 API Key）
3. 启动 `openviking-server`
4. 在 `data/config.json` 中启用 `memory.enabled` 并指定 `memory.serverUrl`

---

## User Review Required

> [!WARNING]
> **OpenViking 需要独立的 VLM 和 Embedding 模型配置**。记忆提取和语义检索依赖这些模型，会产生额外的 API 调用成本。这些模型配置（在 `ov.conf` 中）与 skill-pack 自身的 LLM 配置（在 `data/config.json` 中）是独立的。

> [!IMPORTANT]
> **架构决策**：以下几点需要你确认：
> 1. **记忆注入时机**：是每次用户消息都检索记忆，还是仅在新会话首条消息时检索？（推荐：每次检索，但限制频率）
> 2. **消息同步粒度**：是否需要同步 tool 调用信息到 OpenViking？（推荐：先只同步 user/assistant 文本，tool 信息可后续迭代）
> 3. **会话提交时机**：在 `/clear` 命令时提交，还是每 N 轮自动提交？（推荐：`/clear` 时提交 + 定时自动提交）
> 4. **部署方式**：是否考虑将 OpenViking Server 的启停也纳入 PM2 管理，还是让用户手动管理？

---

## 文件变更总览

| 操作 | 文件 | 说明 |
|------|------|------|
| **[NEW]** | `runtime/server/src/memory.ts` | MemoryManager：OpenViking HTTP 客户端封装 |
| **[MODIFY]** | [runtime/server/src/agent.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts) | PackAgent 注入 MemoryManager，改造流程 |
| **[MODIFY]** | [runtime/server/src/adapters/types.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/adapters/types.ts) | PackAgentOptions 增加 memory 配置 |
| **[MODIFY]** | [runtime/server/src/config.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/config.ts) | 读取 memory 配置 |
| **[MODIFY]** | [runtime/server/src/index.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/index.ts) | 传递 memory 配置给 PackAgent |
| **[NEW]** | `docs/runtime/memory.md` | Memory 功能的架构文档 |

---

## Verification Plan

### 手动验证

由于此功能依赖外部 OpenViking Server，且涉及 LLM 调用，建议手动验证：

1. **前置条件**：启动 OpenViking Server (`openviking-server`)
2. **验证 MemoryManager 连接**：启动 skill-pack runtime，检查日志确认 OpenViking 健康检查通过
3. **验证消息同步**：在 Web 界面发送几条消息，通过 `ov ls viking://session/` 确认 OV Session 创建且消息同步
4. **验证记忆提取**：执行 `/clear` 命令后，通过 `ov ls viking://user/memories/` 查看是否提取出记忆
5. **验证记忆检索**：新建会话，发送与历史相关的问题，检查 Agent 回复是否引用了历史记忆
6. **验证降级**：关闭 OpenViking Server，确认 skill-pack 仍能正常工作（Memory 功能优雅降级）
