# Runtime 多平台 IM 集成架构设计 v2

## 背景

将现有紧耦合的 [chat-proxy.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/chat-proxy.js) + [routes.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/routes.js) 重构为 **Adapter 模式**，使 Web / Telegram 等 IM 平台共用统一的 `PackAgent`。

## 确认的设计决策

| 决策 | 结论 |
|---|---|
| 开发语言 | **TypeScript**，在 build 阶段预编译为 JS，zip 只包含编译产物 |
| Telegram 依赖 | `node-telegram-bot-api` |
| 配置位置 | `data/config.json`（不打包到 zip） |
| 前端协议 | WebSocket 协议保持不变，前端 [app.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/web/app.js) 无需改动 |
| Telegram 事件 | 只发最终结果（文本 + 附件），不发 thinking/tool 中间过程 |
| Web 会话管理 | 预留会话历史接口（列表 + 恢复），后续扩展 |

## 架构概览

```
                    ┌──────────────────┐
                    │     index.ts     │
                    │  读取配置,编排    │
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
          │   PackAgent    │  统一 Agent 层 (per channel)
          └────────────────┘
```

## 统一命令系统

所有 Adapter 需支持以下命令（文本消息以 `/` 开头触发）：

| 命令 | 行为 |
|---|---|
| `/clear` | 存档当前会话，清空聊天记录（开启新会话） |
| `/restart` | 重启整个进程（`process.exit()` + 进程管理器自动重启） |
| `/shutdown` | 退出进程 |

命令处理在 `PackAgent` 层统一实现，Adapter 只需将以 `/` 开头的消息传递给 Agent 的 `handleCommand()` 方法。

## Proposed Changes

### TypeScript 构建支持

#### [NEW] [tsconfig.json](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/tsconfig.json)

runtime/server 独立的 TypeScript 配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

TS 源码放在 `runtime/server/src/`，编译输出到 `runtime/server/dist/`。[start.sh](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.sh) 改为执行 `node dist/index.js`。

打包流程不变：[runtime-template.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/core/runtime-template.ts) 中的 [collectRuntimeTemplateEntries](file:///Users/yava/myspace/finpeak/skill-pack/src/core/runtime-template.ts#41-87) 已会自动跳过 `node_modules`，只需额外排除 `src/` 目录，使 zip 里只包含编译后的 `dist/`。

#### [MODIFY] [tsup.config.ts](file:///Users/yava/myspace/finpeak/skill-pack/tsup.config.ts)

在根 build 脚本中增加 runtime 编译步骤，或在 [package.json](file:///Users/yava/myspace/finpeak/skill-pack/package.json) 的 `build` 脚本中串联执行。

#### [MODIFY] [runtime-template.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/core/runtime-template.ts)

排除 `runtime/server/src/` 和 `runtime/server/tsconfig.json`，使它们不被打包到 zip 中。

#### [MODIFY] [.npmignore](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/.npmignore)

npm 发布时排除 TS 源码，只保留编译产物：

```diff
 node_modules/
 *.log
+src/
+tsconfig.json
```

---

### 核心抽象层

#### [NEW] [types.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/adapters/types.ts)

核心接口定义：

```typescript
import type { Server } from "node:http";
import type { Express } from "express";

export interface PlatformAdapter {
  name: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
}

export interface AdapterContext {
  agent: PackAgent;
  server: Server;
  app: Express;
  rootDir: string;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  timestamp: string;
  sender: { id: string; username: string; displayName?: string; isBot: boolean };
  text: string;
  attachments: ChannelAttachment[];
  isMention: boolean;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

// 统一命令枚举
export type BotCommand = "clear" | "restart" | "shutdown";
```

---

### PackAgent

#### [NEW] [agent.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/agent.ts)

从 [chat-proxy.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/chat-proxy.js) 提取的平台无关 Agent 层：

```typescript
export class PackAgent {
  constructor(options: PackAgentOptions);

  /** 处理消息，通过 onEvent 回调流式返回事件 */
  async handleMessage(
    channelId: string,
    text: string,
    onEvent: (event: AgentSessionEvent) => void,
  ): Promise<HandleResult>;

  /** 处理统一命令 */
  async handleCommand(command: BotCommand, channelId: string): Promise<CommandResult>;

  /** 中止 / 检查运行状态 / 销毁会话 */
  abort(channelId: string): void;
  isRunning(channelId: string): boolean;
  dispose(channelId: string): void;

  /** 预留：列出所有会话 */
  listSessions(): SessionInfo[];

  /** 预留：恢复历史会话 */
  restoreSession(sessionId: string): Promise<void>;
}
```

`handleCommand` 实现：
- `/clear`：存档当前会话，调用 `session.dispose()`，下次消息自动创建新会话
- `/restart`：调用 `process.exit(0)`，依赖外部进程管理器重启
- `/shutdown`：调用 `process.exit(0)`

---

### WebAdapter

#### [NEW] [web.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/adapters/web.ts)

- 保留现有 HTTP API（`/api/config`、`/api/skills`、`/api/config/key`、`DELETE /api/chat`）
- 保留 WebSocket `/api/chat` 端点，协议不变
- **流式生成**：`onEvent` 回调中 `ws.send()` 实时推送每个事件
- 命令处理：前端发 `/clear` 等文本时，交由 `packAgent.handleCommand()` 处理
- 预留会话历史接口：
  - `GET /api/sessions`：返回会话列表（后续实现）
  - `GET /api/sessions/:id`：恢复指定会话（后续实现）

---

### TelegramAdapter

#### [NEW] [telegram.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/adapters/telegram.ts)

- 使用 `node-telegram-bot-api` polling 模式
- 消息流程：
  1. 收到 Telegram 消息 → 转为 `ChannelMessage`
  2. 如果是 `/` 命令 → `packAgent.handleCommand()`
  3. 否则 → `packAgent.handleMessage(channelId, text, onEvent)`
  4. **只收集最终结果**（文本 + 附件），不转发 thinking / tool 中间事件
  5. `agent_end` 时发送完整回复，若有附件则通过 `sendDocument` / `sendPhoto` 发送
  6. 出错时发送错误消息
- Markdown → Telegram MarkdownV2 格式转换
- 长消息自动分割（4096 字符限制）
- 429 Rate limit 自动重试

---

### 配置

#### [NEW] data/config.json（用户创建，不打包）

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

#### [MODIFY] [index.ts](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/src/index.ts)

读取 `data/config.json`（如果存在），用于获取 API key 和 adapter 配置。**配置文件先读取，环境变量后读取并覆盖**，使用户可通过环境变量自定义。Web adapter 始终启用。

---

### 文件变更

#### 删除

- [DELETE] [chat-proxy.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/chat-proxy.js)
- [DELETE] [routes.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/routes.js)
- [DELETE] [index.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/index.js)

#### 新增

```
runtime/server/
├── tsconfig.json                 # TS 编译配置
├── src/
│   ├── index.ts                  # 入口
│   ├── agent.ts                  # PackAgent
│   └── adapters/
│       ├── types.ts              # 接口定义
│       ├── web.ts                # WebAdapter
│       └── telegram.ts           # TelegramAdapter
├── dist/                         # 编译产物（打包到 zip）
│   ├── index.js
│   ├── agent.js
│   └── adapters/
│       ├── types.js
│       ├── web.js
│       └── telegram.js
└── package.json                  # 新增依赖 + build 脚本
```

#### 修改

- [runtime/start.sh](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.sh)：`node dist/index.js`（替换 `node index.js`）
- [runtime/start.bat](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.bat)：同上
- [src/core/runtime-template.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/core/runtime-template.ts)：打包时排除 `server/src/` 和 `server/tsconfig.json`
- 根 [package.json](file:///Users/yava/myspace/finpeak/skill-pack/package.json) build 脚本：增加 runtime 编译步骤

---

## 实施顺序

### Phase 1：TS 基础设施 + 核心抽象

1. 创建 `runtime/server/tsconfig.json`
2. 创建 `runtime/server/src/adapters/types.ts`
3. 创建 `runtime/server/src/agent.ts`（从 [chat-proxy.js](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/chat-proxy.js) 提取重构）
4. 更新 [runtime/server/package.json](file:///Users/yava/myspace/finpeak/skill-pack/runtime/server/package.json)（新增 build 脚本 + 依赖）

### Phase 2：WebAdapter + 入口重构

1. 创建 `runtime/server/src/adapters/web.ts`
2. 创建 `runtime/server/src/index.ts`
3. 编译验证，启动服务器确认 Web 聊天功能正常

### Phase 3：TelegramAdapter

1. 新增 `node-telegram-bot-api` 依赖
2. 创建 `runtime/server/src/adapters/telegram.ts`
3. 需要用户提供 Bot Token 进行功能测试

### Phase 4：构建流程整合

1. 修改 [runtime-template.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/core/runtime-template.ts)（排除 src 目录）
2. 更新 [start.sh](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.sh) / [start.bat](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.bat)
3. 更新根 build 脚本
4. 端到端验证：build → bundle → 解压 → 启动

## npm 发布流程

```
开发者: npm run build → 编译 CLI(tsup) + 编译 runtime/server/src(tsc)
        npm publish → runtime/server/dist/ 进入包，src/ 被 .npmignore 排除
用户:   npx skillpack init → 复制 runtime/(含 dist/) 到目标目录
        npx skillpack bundle → addRuntimeFiles 排除 src/，zip 只含 dist/
终端用户: 解压 → start.sh → node dist/index.js
```

## Verification Plan

### Phase 2 验证

1. `cd runtime/server && npm run build && node dist/index.js`
2. 浏览器访问 → 验证 WebSocket 聊天、API key 设置、skills 列表均正常

### Phase 3 验证

1. 创建 `data/config.json` 配置 Telegram token
2. 启动服务器，在 Telegram 中向 Bot 发消息，验证回复
3. 测试 `/clear`、`/restart`、`/shutdown` 命令

### Phase 4 验证

1. `npm run build`（根目录）
2. `skillpack init && skillpack bundle`
3. 解压 zip，确认不包含 `server/src/`，确认包含 `server/dist/`
4. 运行 [start.sh](file:///Users/yava/myspace/finpeak/skill-pack/runtime/start.sh)，验证功能
