## 运行时架构

运行时并不是从 TypeScript 编译生成，而是直接以 `runtime/` 目录中的模板文件分发。

### 运行时产物结构

```text
<pack-name>/
├── skillpack.json
├── skills/
├── server/
│   ├── index.js
│   ├── routes.js
│   ├── chat-proxy.js
│   ├── package.json
│   └── package-lock.json
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
- 然后进入 `server/` 执行 `node index.js`

运行时要求：

- Node.js >= 20

### 服务端

服务端入口是 `runtime/server/index.js`，基于 `express` + `ws` + `@mariozechner/pi-coding-agent`。

职责分层如下：

#### `index.js`

- 决定 `rootDir`，优先取 `PACK_ROOT` 环境变量，否则取 runtime 上一级目录
- 托管 `web/` 静态资源
- 创建 HTTP Server
- 注册 API 与 WebSocket 路由
- 默认监听 `127.0.0.1:26313`
- 如果端口占用，会自动递增尝试下一个端口
- 启动成功后自动打开浏览器

#### `routes.js`

提供以下接口：

| 端点              | 方法        | 作用                                                                   |
| ----------------- | ----------- | ---------------------------------------------------------------------- |
| `/api/config`     | `GET`       | 返回 pack 名称、描述、prompts、skills、当前 provider、是否已有 API key |
| `/api/skills`     | `GET`       | 返回 skills 列表                                                       |
| `/api/config/key` | `POST`      | 在服务端内存中保存 API key 和 provider                                 |
| `/api/chat`       | `WebSocket` | 聊天主通道                                                             |
| `/api/chat`       | `DELETE`    | 当前仅返回 `{ success: true }`，没有真正清空后端持久状态               |

运行时的 API key 策略：

- 优先读取环境变量 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`
- 也允许前端调用 `/api/config/key` 在内存中设置
- 不写入磁盘

provider 与模型的当前固定映射：

- `openai` -> `gpt-5.4`
- `anthropic` -> `claude-opus-4-6`

#### `chat-proxy.js`

每个 WebSocket 连接会：

1. 用内存版 `AuthStorage` 注入 API key
2. 创建 `ModelRegistry`
3. 创建内存版 `SessionManager`
4. 把 `rootDir/skills` 作为 `additionalSkillPaths`
5. 用 `DefaultResourceLoader` 重新加载资源
6. 调用 `createAgentSession(...)`
7. 将 agent 事件实时转发给前端

当前会转发的主要事件类型：

- `agent_start`
- `message_start`
- `thinking_delta`
- `text_delta`
- `tool_start`
- `tool_end`
- `message_end`
- `agent_end`

前端发送的消息格式目前非常简单：

```json
{ "text": "user input" }
```

连接关闭时会调用 `session.dispose()`。

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
