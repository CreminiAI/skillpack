# Electron App 对接 SkillPack IPC 指南

本文面向 `electron-app` 主进程开发，说明当前 `skill-pack` 已实现的 IPC 能力、对接方式、注意事项与上线检查项。

## 1. 当前已实现能力（skill-pack 侧）

`skill-pack` 已支持通过 Node IPC（`process.send` / `process.on("message")`）与 Electron 通信，覆盖：

1. 会话列表：`get_conversations`
2. 会话消息历史：`get_messages`
3. 在指定会话发送消息并实时接收事件流：`send_message`
4. 命令执行：`command`
5. 配置查询/更新：`get_config`、`update_config`
6. 运行状态：`get_status`
7. 定时任务管理：`get_scheduled_jobs`、`add_scheduled_job`、`remove_scheduled_job`
8. 推送事件：
   - `ready`
   - `agent_event`
   - `inbound_message`（Telegram/Slack 入站）
9. 子进程发起的自定义工具请求：
   - `get_custom_tool_definitions`
   - `execute_custom_tool`

## 2. 进程启动要求（Electron 主进程）

必须以带 IPC 管道的方式启动 `skill-pack` 子进程，例如：

- 使用 `child_process.fork`，或 `spawn` 且 `stdio` 包含 `"ipc"`
- 建议设置环境变量：`SKILLPACK_RUNTIME_MODE=embedded`（禁用 web adapter、本地端口和自动打开浏览器）

建议等待 `ready` 事件后再发首个业务请求：

```ts
{ type: "ready", port: number }
```

`port` 可作为 HTTP 兜底（例如复用已有 REST 接口）或健康检查用途。

## 3. IPC 协议（请求 / 响应 / 推送）

### 3.1 请求（Electron -> skill-pack）

```ts
type IpcRequest =
  | { id: string; type: "get_conversations" }
  | { id: string; type: "get_messages"; channelId: string; limit?: number }
  | { id: string; type: "send_message"; channelId: string; text: string }
  | { id: string; type: "command"; command: BotCommand; channelId: string }
  | { id: string; type: "get_config" }
  | { id: string; type: "update_config"; updates: Partial<DataConfig> }
  | { id: string; type: "get_status" }
  | { id: string; type: "get_scheduled_jobs" }
  | { id: string; type: "add_scheduled_job"; job: ScheduledJobConfig }
  | { id: string; type: "remove_scheduled_job"; name: string };
```

### 3.2 响应（skill-pack -> Electron）

```ts
type IpcResponse =
  | { id: string; type: "result"; data: unknown }
  | { id: string; type: "error"; message: string };
```

同一个响应 envelope 也用于 Electron 回复 skill-pack 发起的自定义工具请求。

### 3.3 推送事件（skill-pack -> Electron）

```ts
type IpcPushEvent =
  | { type: "ready"; port: number }
  | { type: "agent_event"; channelId: string; event: AgentEvent }
  | {
      type: "inbound_message";
      channelId: string;
      platform: string;
      sender: { id: string; username: string };
      text: string;
      timestamp: number;
    };
```

### 3.4 自定义工具请求（skill-pack -> Electron）

在 embedded 模式下，skill-pack 可以通过 IPC 向 Electron 主进程请求工具定义和执行工具。详见 [`docs/runtime/ipc-custom-tools.md`](runtime/ipc-custom-tools.md)。

```ts
type SkillpackCustomToolRequest =
  | { id: string; type: "get_custom_tool_definitions" }
  | {
      id: string;
      type: "execute_custom_tool";
      toolName: string;
      toolCallId: string;
      runContext: {
        runId: string;
        channelId: string;
        adapter: "telegram" | "slack" | "web" | "scheduler";
      };
      params: unknown;
    };
```

Electron 必须返回：

```ts
type SkillpackCustomToolResponse =
  | { id: string; type: "result"; data: unknown }
  | { id: string; type: "error"; message: string };
```

首个迁移工具是 `save_artifacts`：LLM 仍在 skill-pack agent 内看到该工具，但路径校验、快照、SQLite 写入和查询全部由 Frevana 主进程负责。

## 4. 关键行为说明（对接时必须知晓）

### 4.1 `send_message` 的平台行为

`send_message` 会触发完整 Agent 执行流程，并流式推送 `agent_event`。

- 若 `channelId` 属于 `telegram-*` / `slack-*`：
  Agent 最终文本会自动经对应 adapter 回发到 IM 平台。
- 若 `channelId` 属于 `web-*`：
  不会向外部 IM 回发，仅返回执行结果与流式事件。

### 4.2 `get_conversations` 数据来源

会从 `data/sessions/*` 扫描历史会话，同时合并当前内存中活跃 channel。

返回结构：

```ts
interface ConversationSummary {
  channelId: string;
  platform: "telegram" | "slack" | "web" | "scheduler";
  sessionFile: string | null;
  messageCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
}
```

### 4.3 `get_messages` 返回的是“精简消息”

仅返回 `user` / `assistant` 的纯文本消息；`thinking`、`toolResult` 等不会直接作为消息行返回。`assistant` 可携带 `toolCalls` 摘要。

### 4.4 `update_config` 会即时影响运行态

`update_config` 成功后会立即更新运行中的鉴权状态（无需重启进程即可生效于后续请求）。

## 5. Electron 主进程推荐封装

建议在主进程封装 `SkillpackIpcClient`：

1. 维护 `pendingRequests: Map<string, {resolve,reject,timer}>`
2. `sendRequest(type, payload)` 自动生成 `id` + 超时处理（建议 30-60s）
3. 统一分流：
   - 带 `id` -> 命中 pending promise
   - 带 `id` 但未命中 pending，且 `type` 是 `get_custom_tool_definitions` / `execute_custom_tool` -> 作为子进程请求交给 custom tool executor
   - 无 `id` -> 事件总线广播（`ready/agent_event/inbound_message`）
4. 进程退出时 reject 全部 pending，触发重连逻辑

## 6. UI 对接清单（MVP）

1. 会话页：
   - 首次加载调用 `get_conversations`
   - 支持按 `lastMessageAt` 排序显示
2. 聊天页：
   - 进入会话调用 `get_messages`
   - 发送消息调用 `send_message`
   - 实时消费 `agent_event`（`text_delta` 拼接渲染）
3. IM 入站：
   - 监听 `inbound_message`，更新会话列表未读状态
4. 配置页：
   - 读取 `get_config`
   - 保存 `update_config`
5. 定时任务页：
   - 列表：`get_scheduled_jobs`
   - 新增：`add_scheduled_job`
   - 删除：`remove_scheduled_job`

## 7. 风险与注意事项

1. `channelId` 由外部传入时需做基本校验，避免空值或错误前缀。
2. 同一会话并发 `send_message` 可能引发 UI 流渲染混杂，建议前端按 channel 做串行发送控制。
3. 若子进程未收到 `ready` 且提前发送请求，可能出现超时；建议主进程加“就绪门闩”。
4. 对 `type: "error"` 响应，UI 应保留原始 message 便于排查（不要吞错）。

## 8. 联调建议

1. 启动 `skill-pack` 子进程并等待 `ready`
2. 依次验证：
   - `get_status`
   - `get_conversations`
   - `get_messages`
   - `send_message`（检查 `agent_event` 流）
3. 用 Telegram/Slack 实际发消息，验证 `inbound_message` 推送
4. 验证配置更新与定时任务增删是否立即生效
