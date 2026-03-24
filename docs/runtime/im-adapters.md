# IM Platform Adapters

## Overview

The runtime supports multiple IM platforms simultaneously through a shared `PackAgent` instance.
Currently three adapters are implemented: **Web**, **Telegram**, and **Slack**.

## Architecture

```
                    ┌──────────────────┐
                    │    server.ts     │
                    │  Load config,    │
                    │  start adapters  │
                    └────────┬─────────┘
                             │  Create shared PackAgent
          ┌──────────────────┼──────────────────┬──────────────────┐
          ▼                  ▼                  ▼                  ▼
   ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
   │  WebAdapter  │  │TelegramAdapter│  │ SlackAdapter │  │  (future)    │
   └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  └──────────────┘
          │                  │                  │
          └────────┬─────────┴──────────────────┘
                   ▼
          ┌────────────────┐
          │   PackAgent    │  Platform-agnostic agent layer
          │  (per channel) │  Manages AgentSession per channelId
          └────────────────┘
```

All adapters implement the same `PlatformAdapter` interface. `PackAgent` has no awareness of the underlying platform. Sessions are created lazily per `channelId` and are fully isolated across adapters.

## File Structure

```
src/runtime/
├── server.ts                    # Entry: read config, start adapters
├── agent.ts                     # PackAgent (core agent layer)
├── config.ts                    # Runtime config loading
├── lifecycle.ts                 # Graceful shutdown / restart
└── adapters/
    ├── types.ts                 # Shared interface definitions
    ├── web.ts                   # WebAdapter (HTTP + WebSocket)
    ├── telegram.ts              # TelegramAdapter (polling)
    ├── slack.ts                 # SlackAdapter (Socket Mode)
    └── markdown.ts              # Markdown → platform text converter
```

## Core Interfaces

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
  /** Stream a message; emit AgentEvents via onEvent callback in real time */
  handleMessage(
    channelId: string,
    text: string,
    onEvent: (e: AgentEvent) => void,
    attachments?: ChannelAttachment[],
  ): Promise<HandleResult>;

  /** Handle a unified command (/clear /restart /shutdown) */
  handleCommand(command: BotCommand, channelId: string): Promise<CommandResult>;

  abort(channelId: string): void;
  isRunning(channelId: string): boolean;
  dispose(channelId: string): void;

  // Reserved: session history
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
  | { type: "tool_end"; toolName: string; isError: boolean; result: unknown }
  | { type: "file_output"; filePath: string; filename: string; mimeType?: string; caption?: string };
```

## Configuration

Runtime configuration is read from `data/config.json` (this directory is **not** included in the zip). Environment variables take higher priority and override the config file.

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

- `data/config.json` is read first.
- If the `apiKey` / `provider` fields are absent or the file cannot be read, the environment variables `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are used as a fallback.
- **WebAdapter is always enabled.**
- TelegramAdapter is only dynamically imported and started when `adapters.telegram.token` is configured.
- SlackAdapter requires both `adapters.slack.botToken` and `adapters.slack.appToken`; if either is missing a warning is logged and the adapter is skipped.

## Unified Command System

All adapters support the following commands (triggered by a `/`-prefixed message), handled by `PackAgent.handleCommand()`:

| Command | Behavior |
| --- | --- |
| `/clear` | Destroys the current channel's AgentSession; the next message creates a new one |
| `/restart` | Triggers a `Lifecycle` graceful exit with exit code `75` |
| `/shutdown` | Triggers a `Lifecycle` graceful exit with exit code `64` |

> The `start.sh` wrapper loop interprets the exit code: `75` automatically restarts the process; `64` is treated as an explicit shutdown and exits the script.

Slack additionally exposes namespaced slash commands:

| Slack command | Maps to |
| --- | --- |
| `/skillpack-clear` | `clear` |
| `/skillpack-restart` | `restart` |
| `/skillpack-shutdown` | `shutdown` |

> Slack slash commands cannot be triggered directly from within a thread. In a channel context, the command targets the most recently active Skillpack thread in that channel. If no active thread exists, the user is prompted to `@mention` the bot first, or to send a text command like `@bot /clear` inside the relevant thread.

## WebAdapter

- **Always enabled**; handles HTTP REST API and WebSocket chat.
- Each WebSocket connection generates a unique `channelId` (`web-<timestamp>-<random>`); disposing happens automatically on disconnect.
- Streams every `AgentEvent` to the frontend immediately via `ws.send()`.
- WebSocket upgrades are only accepted on the `/api/chat` path; all other upgrade requests are destroyed.

### HTTP API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/config` | GET | Pack metadata, provider, API key presence, adapter config, runtimeControl |
| `/api/skills` | GET | Skills list (reads `skillpack.json`) |
| `/api/config/update` | POST | Save API key / provider / adapter config; returns `requiresRestart` |
| `/api/runtime/restart` | POST | Triggers a managed restart under supported process managers |
| `/api/chat` | WebSocket | Main chat channel |
| `/api/chat` | DELETE | Placeholder; returns `{ success: true }` |
| `/api/sessions` | GET | Session list (reserved; currently returns an empty array) |
| `/api/sessions/:id` | GET | Restore a historical session (reserved; returns 501) |

### WebSocket Message Protocol

**Frontend → server**

```json
{ "text": "user input" }
```

**Server → frontend (streaming AgentEvents)**

Each `AgentEvent` is sent as an individual JSON frame. When the stream ends:

```json
{ "done": true }
```

On error:

```json
{ "error": "error message" }
```

Command result:

```json
{
  "type": "command_result",
  "command": "clear",
  "success": true,
  "message": "Session cleared."
}
```

## TelegramAdapter

- Polling mode (`node-telegram-bot-api`) — suitable for private deployments; no public webhook required.
- Each Telegram Chat ID maps to a dedicated channel (`telegram-<chatId>`); the session persists for the process lifetime.
- Registers a command menu (`/clear`, `/restart`, `/shutdown`) with Telegram on startup.
- Adds a `👀` reaction to the incoming message to acknowledge receipt before processing.
- **Only the final result is sent**; `thinking_delta` / `tool_start` / `tool_end` events are not exposed.
- Markdown is converted to Telegram's HTML subset before sending; ` ```md ` / ` ```markdown ` code blocks are unwrapped and rendered inline.
- Long messages are split at 4096 characters, preferring paragraph (`\n\n`) → newline (`\n`) → space boundaries.
- HTTP 429 responses trigger automatic retries (up to 3 attempts, waiting `retry_after` seconds).

## SlackAdapter

- Socket Mode (`@slack/bolt`) — suitable for private deployments; no public webhook required.
- Listens to `message.im` and `app_mention`.
- DM session ID: `slack-dm-<teamId>-<channelId>`
- Thread session ID: `slack-thread-<teamId>-<channelId>-<threadTs|ts>`
- Channel replies are always sent back to the originating thread. If the mention occurs on a non-thread message, that message's `ts` is used to start a new thread.
- Filters out bot/self messages, system messages with a subtype, and non-mention messages.
- Strips the leading bot mention from the text before forwarding to the agent. If nothing remains after stripping, a short prompt is returned.
- Adds a `:eyes:` reaction to acknowledge receipt before processing.
- **Only the final result is sent**; `thinking_delta` / `tool_start` / `tool_end` events are not exposed.
- Markdown is converted to Slack `mrkdwn` before sending; ` ```md ` / ` ```markdown ` blocks are unwrapped and rendered inline.
- Long messages are split by paragraph and sent sequentially; Slack API rate limits trigger up to 3 automatic retries.
- Text commands `/clear`, `/restart`, `/shutdown` are supported inside threads.

### Slack App Requirements

- Socket Mode must be enabled.
- An app-level token with the `connections:write` scope is required.
- Bot scopes must include at least: `chat:write`, `im:history`, `app_mentions:read`, `reactions:write`.
- Event subscriptions must include at least: `message.im`, `app_mention`.
- Slash commands to configure: `/skillpack-clear`, `/skillpack-restart`, `/skillpack-shutdown`.

## Attachment Handling

### Inbound (User → Agent)

All IM adapters extract file attachments from incoming messages, download them to the session directory, and pass them to the agent:

- **Storage path**: `data/sessions/<channelId>/attachments/<timestamp>-<filename>`
- **Image attachments** (`image/*`): converted to `ImageContent` (base64) and passed directly to the LLM via `session.prompt(text, { images })` — the model can "see" the image natively.
- **Non-image attachments** (PDF, CSV, etc.): a text description with the local file path is prepended to the prompt. The agent can then use `read` / `bash` tools to access the file content.

| Adapter | Supported types |
| --- | --- |
| Telegram | `photo`, `document`, `audio`, `video`, `voice` |
| Slack | `event.files` (all file types, downloaded via Bot Token) |
| Web | Planned (Phase 2) |

### Outbound (Agent → User)

A custom LLM tool `send_file` is registered via `createAgentSession({ customTools })`. When the agent generates a file and wants to deliver it to the user, it calls `send_file` with the file path. This emits a `file_output` AgentEvent, which each adapter handles:

| Adapter | Send method |
| --- | --- |
| Telegram | `bot.sendDocument(chatId, filePath)` |
| Slack | `client.files.uploadV2({ channel, file, filename })` |
| Web | `file_output` event via WebSocket + `GET /api/files/*` download endpoint |

### File structure

```
src/runtime/
├── adapters/
│   ├── attachment-utils.ts      # Shared download/save/format helpers
│   ...
└── tools/
    └── send-file-tool.ts        # send_file customTool definition
```

## Adding a New Adapter

1. Create `src/runtime/adapters/xxx.ts`.
2. Implement the `PlatformAdapter` interface (`name`, `start(ctx)`, `stop()`).
3. In `src/runtime/server.ts`, conditionally call the adapter inside `startAdapters()` based on `dataConfig.adapters.xxx`.
4. Run `npm run build` to compile.
