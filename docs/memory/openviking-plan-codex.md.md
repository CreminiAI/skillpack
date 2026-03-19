# 为 Skillpack Agent 引入 OpenViking Memory 闭环

## Summary

目标是把现有 `pi-coding-agent` 的“短期会话推理”保留不动，再在外侧增加一层 `OpenViking` Memory 编排，使每个会话具备：

- 新消息前检索长期记忆并注入本轮推理
- 回答完成后把本轮消息、引用上下文、工具调用镜像到 OpenViking
- 异步 `commit`，自动沉淀 user/agent memories
- 默认按平台会话隔离 Memory，不跨平台自动合并

推荐接入方式是：Skillpack runtime 继续是 Node 主进程，OpenViking 作为独立 HTTP 服务，由启动脚本和 PM2 负责“探活 -> 复用已有实例 -> 必要时自动拉起”。

## Implementation Changes

### 1. 增加 OpenViking 集成层

在 [`runtime/server/src/agent.ts`](/Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts) 外围引入一组新内部组件，不改 `pi` SDK 本身：

- `OpenVikingClient`
  - 负责 HTTP 调用 `/health`、`/api/v1/search/search`、`/api/v1/sessions/*`
  - 统一附带 `X-API-Key`、`X-OpenViking-Account`、`X-OpenViking-User`、`X-OpenViking-Agent`
- `MemoryOrchestrator`
  - `beforeTurn(channelKey, userText)`: 等待上次 commit 完成、确保 session 存在、写入 user message、执行 search、返回注入上下文
  - `afterTurn(channelKey, turnRecord)`: 写 assistant message、记录 used contexts、后台 commit
- `ConversationRegistry`
  - 持久化 `conversationKey -> { ovSessionId, epoch, lastSeenAt }`
  - 存在 `data/openviking-sessions.json`
  - `/clear` 时只递增 `epoch` 创建新 OpenViking session，不删除历史 session 与已沉淀 memory

### 2. 会话与身份映射

默认按“平台会话”隔离，而不是按真实人身份聚合：

- Telegram: `conversationKey = telegram-<chatId>`
- Slack DM: `conversationKey = slack-dm-<teamId>-<channelId>`
- Slack thread: `conversationKey = slack-thread-<teamId>-<channelId>-<threadTs>`
- Web: 改为稳定 `conversationId`，前端保存在 `localStorage`，通过 WebSocket URL 传 `?conversationId=<uuid>`

OpenViking headers 固定映射为：

- `X-OpenViking-Account = skillpack`
- `X-OpenViking-User = <sanitized conversationKey>`
- `X-OpenViking-Agent = <packSlug>`

OpenViking session id 使用稳定命名，避免重启丢失关联：

- `ovSessionId = <packSlug>__<hash(conversationKey)>__v<epoch>`

### 3. Memory 检索注入策略

每轮 `handleMessage()` 流程改为：

1. `beforeTurn()` 确保 OpenViking 可用
2. 将当前用户消息写入 OpenViking session
3. 调用 `POST /api/v1/search/search`，带当前 `session_id`
4. v1 只消费返回结果里的 `memories`
5. 取前 `topK` 条记忆，整理成一段固定格式的上下文块，拼到本轮传给 `pi` 的 prompt 前面

注入格式固定为：

- 每条包含 `category / uri / abstract`
- 总长度受 `injectTopK` 与 `maxAbstractChars` 限制
- 没有命中时不注入任何 Memory block

v1 不把 OpenViking 的 `resources/skills` 接入到 `pi` prompt，避免范围膨胀；先把目标收敛在长期记忆。

### 4. 写回与 commit 策略

本轮 `pi` 执行过程中收集：

- assistant 最终文本
- 所有 tool start/end 事件，整理为 OpenViking `ToolPart`
- 所有注入过的 memory URI，作为 `used(contexts=...)`

回答结束后：

- 追加 assistant message，parts 由 `TextPart + ContextPart[] + ToolPart[]` 组成
- 成功返回时调用 `used(contexts=selectedMemoryUris)`
- 立即发起 `POST /api/v1/sessions/{id}/commit?wait=false`
- 记录后台任务状态；下一轮 `beforeTurn()` 必须先等待该会话上次 commit 完成，避免并发 commit 冲突

如果 OpenViking 暂时不可用：

- Agent 继续工作，不阻断 `pi` 主链路
- 本轮跳过检索与写回
- 在服务端日志和 `/api/config` 状态里暴露 degraded 状态

### 5. 启动与配置

扩展 [`runtime/server/src/config.ts`](/Users/yava/myspace/finpeak/skill-pack/runtime/server/src/config.ts) 的 `DataConfig`：

- `openviking.enabled`
- `openviking.baseUrl`
- `openviking.apiKey`
- `openviking.autoStart`
- `openviking.command`
- `openviking.configPath`
- `openviking.host`
- `openviking.port`
- `openviking.startupTimeoutMs`
- `openviking.searchLimit`
- `openviking.injectTopK`
- `openviking.maxAbstractChars`

环境变量覆盖：

- `OPENVIKING_URL`
- `OPENVIKING_API_KEY`
- `OPENVIKING_CONFIG`
- `OPENVIKING_BIN`

启动链路放在 [`runtime/ecosystem.config.cjs`](/Users/yava/myspace/finpeak/skill-pack/runtime/ecosystem.config.cjs) 和 `runtime/start.sh` / `runtime/start.bat`：

- 启动前先探活 `GET <baseUrl>/health`
- 健康则直接启动 Skillpack
- 不健康且 `autoStart=true` 时，再把 `openviking-server --config ... --host ... --port ...` 纳入 PM2 一起拉起
- 等待健康成功后再启动 Skillpack server
- 已有外部 OpenViking 在跑时，不重复拉起

## Public API / Interface Changes

- WebSocket 聊天连接新增可选查询参数 `conversationId`
  - 用于让 Web 端拥有稳定会话身份
- `/api/config` 与 `/api/config/update`
  - 返回并保存 `openviking` 配置
  - 返回 `openviking.status`，至少包括 `enabled / reachable / autoStarted`
- 内部新增类型
  - `MemoryConfig`
  - `ConversationBinding`
  - `RetrievedMemoryContext`
  - `TurnRecord`

`IPackAgent` 对 Telegram/Slack 可保持不变；Web 端协议是唯一需要扩展的公共接口。

## Test Plan

- 单元测试
  - `conversationKey -> OpenViking headers/sessionId` 映射正确
  - `/clear` 会创建新 epoch，不影响旧 memory
  - Memory 注入块能正确裁剪、排序、为空时不注入
  - commit 后台任务会在下一轮前被串行等待
- 集成测试
  - 用 mock OpenViking HTTP server 覆盖 `health/search/add_message/commit`
  - 验证一次完整回合的调用顺序：`add user -> search -> pi -> add assistant -> used -> commit`
  - OpenViking 不可用时，Agent 仍能正常回复
- Web 回归
  - 刷新页面后复用同一 `conversationId`
  - 断开 WebSocket 不立即丢失会话绑定
- IM 回归
  - Telegram/Slack 继续维持当前 channel/thread 隔离语义
  - `/clear` 后新消息使用新 OpenViking session

## Assumptions

- v1 只引入 OpenViking 的 Memory 能力，不把资源导入、技能同步、历史会话浏览一起做掉
- 现阶段“按平台身份隔离”落实为“按平台会话隔离”，因为项目里还没有可靠的人类用户统一身份层
- OpenViking `commit` 使用后台模式，避免增加用户可感知回复延迟
- 如果 Web 端没有传 `conversationId`，服务端生成一个并回传，前端落本地后后续复用
- OpenViking 失败时采用 graceful degradation，而不是让聊天主功能不可用
