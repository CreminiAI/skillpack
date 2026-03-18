## 运行时架构

运行时源码位于 `runtime/server/src/`，使用 TypeScript 编写，编译后的产物（`dist/`）进入分发包。

### 运行时产物结构

```text
<pack-name>/
├── skillpack.json
├── skills/
├── data/                      # 运行时配置目录（不打包进 zip）
│   └── config.json            # 可选：API key、provider、adapter 配置
├── server/
│   ├── dist/                  # 编译产物（进入 npm 包和 zip）
│   │   ├── index.js
│   │   ├── agent.js
│   │   └── adapters/
│   │       ├── types.js
│   │       ├── web.js
│   │       └── telegram.js
│   ├── src/                   # TypeScript 源码（不进入分发包）
│   │   ├── index.ts
│   │   ├── agent.ts
│   │   └── adapters/
│   │       ├── types.ts
│   │       ├── web.ts
│   │       └── telegram.ts
│   ├── package.json
│   └── tsconfig.json
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── marked.min.js
├── start.sh
├── start.bat
└── README.md
```

### 启动脚本

当前启动方式：

- `start.sh`：如果 `server/node_modules` 不存在，则执行 `npm install --omit=dev`
- `start.bat`：如果 `server/node_modules` 不存在，则执行 `npm ci --omit=dev`
- 然后进入 `server/` 执行 `node dist/index.js`

运行时要求：

- Node.js >= 20

### 服务端

服务端入口是 `runtime/server/src/index.ts`，编译后以 `dist/index.js` 运行，基于 `express` + `ws` + `@mariozechner/pi-coding-agent`。

职责分层如下：

#### `index.ts`（入口）

- 决定 `rootDir`：优先取 `PACK_ROOT` 环境变量，否则取 `server/` 上一级目录
- 读取 `data/config.json`，环境变量（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）优先级更高
- 托管 `web/` 静态资源（优先读 `rootDir/web`，否则回退 `serverDir/../web`）
- 创建共享 `PackAgent` 实例
- 按配置依次启动 `WebAdapter`（始终启用）和 `TelegramAdapter`（有 token 时启用，动态 import）
- 监听 `HOST:PORT`，默认 `127.0.0.1:26313`；端口占用自动递增
- 启动成功后自动打开浏览器（`open` / `start` / `xdg-open`）

环境变量：

| 变量               | 说明                         | 默认值        |
| ------------------ | ---------------------------- | ------------- |
| `PACK_ROOT`        | Pack 根目录                  | server 上一级 |
| `HOST`             | 监听地址                     | `127.0.0.1`   |
| `PORT`             | 监听端口                     | `26313`       |
| `OPENAI_API_KEY`   | OpenAI API Key（优先级最高） | —             |
| `ANTHROPIC_API_KEY`| Anthropic API Key            | —             |

#### `agent.ts`（PackAgent）

`PackAgent` 是平台无关的核心 Agent 层，实现 `IPackAgent` 接口。

- 以 `channelId` 为 key，维护一个 `Map<string, ChannelSession>`
- 每个 channel 的 session **懒加载**：首次 `handleMessage` 时创建，复用 `AuthStorage.inMemory`、`ModelRegistry`、`SessionManager.inMemory`、`DefaultResourceLoader`
- `handleMessage` 订阅 pi session 事件，将以下事件转发给 Adapter 的 `onEvent` 回调：

| pi 事件                | 转发为 AgentEvent               |
| ---------------------- | ------------------------------- |
| `agent_start`          | `{ type: "agent_start" }`       |
| `agent_end`            | `{ type: "agent_end" }`         |
| `message_start`        | `{ type: "message_start", role }` |
| `message_end`          | `{ type: "message_end", role }` |
| `message_update` (text_delta)    | `{ type: "text_delta", delta }` |
| `message_update` (thinking_delta)| `{ type: "thinking_delta", delta }` |
| `tool_execution_start` | `{ type: "tool_start", toolName, toolInput }` |
| `tool_execution_end`   | `{ type: "tool_end", toolName, isError, result }` |

- 每轮结束时检查 `diagnostics`（stopReason、errorMessage、有无可见输出），异常时返回错误信息
- 支持 `abort(channelId)` 中断当前运行、`dispose(channelId)` 销毁 session

provider 与模型的当前固定映射（`index.ts` 中：

```typescript
const modelId = provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";
```

#### `adapters/types.ts`（共享接口）

定义所有 Adapter 共用的类型：

- `PlatformAdapter`：`{ name, start(ctx), stop() }`
- `AdapterContext`：`{ agent, server, app, rootDir }`
- `IPackAgent`：Agent 接口（handleMessage、handleCommand、abort、isRunning、dispose、listSessions、restoreSession）
- `AgentEvent`：8 种事件 union type
- `BotCommand`：`"clear" | "restart" | "shutdown"`
- `ChannelMessage` / `ChannelAttachment` / `SessionInfo`：预留扩展接口

#### 运行时 API key 策略

1. 读取 `data/config.json` 的 `apiKey` / `provider` 字段
2. 环境变量 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` 覆盖（设置了环境变量则强制对应 provider）
3. Web 前端可通过 `POST /api/config/key` 在内存中临时覆盖（重启失效）
4. 不写入磁盘

### 前端

前端为纯静态 HTML/CSS/JavaScript，不依赖前端框架。

#### 页面结构

- 左侧 sidebar：pack 名称、描述、skills 列表、provider 选择、API key 输入
- 右侧主区：welcome view、chat view、输入框

#### 初始化行为

页面加载后首先请求 `/api/config`，再完成以下渲染：

- 设置页面标题和 pack 基本信息
- 渲染 skills 列表
- 根据 provider 更新 API key placeholder
- 根据 prompts 数量切换预填或欢迎卡片展示

#### 聊天交互

聊天采用单条 WebSocket 长连接：

- 发送消息前先切换到 chat 模式
- 输入框会在等待回复时禁用
- assistant 输出按增量事件流式渲染
- tool 调用会展示为可折叠卡片
- thinking 过程会展示为独立可折叠卡片
- markdown 由 `marked.min.js` 渲染

当前前端里存在一个 `chatHistory` 数组，但它只是本地记录，没有用于向后端回放上下文；真正的会话状态依赖 `pi-coding-agent` session 本身。
