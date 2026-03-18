# IM 平台适配器架构

## 概述

Runtime 支持多个 IM 平台同时接入，共用一套 `PackAgent` 和配置逻辑。目前已实现 **Web** 和 **Telegram** 两个 Adapter。

## 架构

```
                    ┌──────────────────┐
                    │     index.ts     │
                    │  读取配置，编排   │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌──────────────┐  ┌───────────────┐  ┌──────────────┐
   │  WebAdapter  │  │TelegramAdapter│  │ (未来扩展)   │
   └──────┬───────┘  └───────┬───────┘  └──────────────┘
          │                  │
          └────────┬─────────┘
                   ▼
          ┌────────────────┐
          │   PackAgent    │  平台无关 Agent 层
          │  (per channel) │  管理 AgentSession
          └────────────────┘
```

所有 Adapter 实现同一个 `PlatformAdapter` 接口，`PackAgent` 完全不感知平台。

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
│       └── telegram.ts        # TelegramAdapter
└── dist/                      # 编译产物（进入 npm 包和 zip）
    ├── index.js
    ├── agent.js
    └── adapters/
        ├── types.js
        ├── web.js
        └── telegram.js
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
  handleMessage(channelId: string, text: string, onEvent: (e: AgentEvent) => void): Promise<HandleResult>;

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

## 配置

运行时配置通过 `data/config.json` 提供（此目录**不打包进 zip**），环境变量优先级更高可覆盖配置文件。

```json
{
  "apiKey": "sk-...",
  "provider": "openai",
  "adapters": {
    "telegram": {
      "token": "123456:ABC-DEF..."
    }
  }
}
```

- `data/config.json` 先读取
- 环境变量 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 后读取并覆盖
- **Web Adapter 始终启用**；Telegram 仅在配置了 `token` 时启动

## 统一命令系统

所有 Adapter 均支持以下命令（消息文本以 `/` 开头触发），由 `PackAgent.handleCommand()` 统一处理：

| 命令 | 行为 |
|---|---|
| `/clear` | 清空当前会话，下次消息起新建 AgentSession |
| `/restart` | 延迟 500ms 后 `process.exit(0)`，由进程管理器重启 |
| `/shutdown` | 延迟 500ms 后 `process.exit(0)` |

## WebAdapter

- **始终启用**，负责 HTTP API 和 WebSocket 聊天
- WebSocket 端点 `/api/chat` 协议与旧版完全兼容，前端 `app.js` 无需修改
- 流式生成：每个 `AgentEvent` 立即通过 `ws.send()` 推送到前端

### HTTP API

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/config` | GET | pack 名称、描述、prompts、skills、provider、是否有 API Key |
| `/api/skills` | GET | skills 列表 |
| `/api/config/key` | POST | 在内存中设置 API Key 和 provider |
| `/api/chat` | WebSocket | 聊天主通道 |
| `/api/chat` | DELETE | 占位，返回 `{ success: true }` |
| `/api/sessions` | GET | 会话列表（预留，待实现） |
| `/api/sessions/:id` | GET | 恢复历史会话（预留，待实现） |

## TelegramAdapter

- Polling 模式（`node-telegram-bot-api`），适合私有部署，无需公网 webhook
- 每个 Telegram Chat ID 对应一个独立的 channel（`telegram-<chatId>`）
- **只发最终结果**（文本 + 附件），不暴露 thinking / tool 中间事件
- 消息发送：文本通过 `sendMessage`，附件通过 `sendDocument` / `sendPhoto`
- 长消息自动按段落分割（Telegram 上限 4096 字符）
- HTTP 429 自动重试

## 新增 Adapter 指南

1. 在 `src/adapters/` 下新建 `xxx.ts`
2. 实现 `PlatformAdapter` 接口
3. 在 `src/index.ts` 中根据 `dataConfig.adapters.xxx` 条件启动

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
