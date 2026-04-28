# SkillPack Runtime Architecture

The runtime source lives in `src/runtime/` and is compiled by `tsup` into `dist/` alongside the CLI. It is shipped as part of the `@cremini/skillpack` npm package. There is no longer a separate `runtime/server/` subproject.

## Distributed Pack Structure

A pack zip produced by `skillpack zip` contains the lightweight runtime essentials plus optional pack-level assets:

```text
<pack-name>/
├── skillpack.json
├── job.json
├── AGENTS.md
├── SOUL.md
├── skills/
├── start.sh
└── start.bat
```

The start scripts invoke `npx @cremini/skillpack run .` so the runtime is resolved from npm at startup—no pre-bundled server directory is needed.

## Start Scripts

`start.sh` (macOS / Linux):

```bash
#!/bin/bash
cd "$(dirname "$0")"
npx -y @cremini/skillpack run .
```

`start.bat` (Windows):

```bat
@echo off
cd /d "%~dp0"
npx -y @cremini/skillpack run .
```

Node.js >= 20 is required.

## Server Architecture

When `skillpack run` executes, it calls `startServer({ rootDir })` from `src/runtime/server.ts`. The server is built on **Express** + **ws** + **`@mariozechner/pi-coding-agent`** and loads runtime config from `data/config.json` plus scheduled jobs from root-level `job.json`.

### `server.ts` (entry)

- Determines `rootDir` from the argument (or `PACK_ROOT` env var).
- Reads `data/config.json`; environment variables `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` take higher priority.
- Starts the scheduler from `job.json` when the file exists.
- Serves `web/` static assets (tries `rootDir/web`, falls back to the package's own `web/`).
- Creates a shared `PackAgent` instance.
- In embedded mode, loads delegated custom tools from the parent IPC process.
- Starts `WebAdapter` (always enabled), `TelegramAdapter` (if token configured), `SlackAdapter` (if both `botToken` and `appToken` are configured), and `SchedulerAdapter`.
- Listens on `HOST:PORT`, defaults to `127.0.0.1:26313`; auto-increments port on conflict.
- Opens the browser automatically after a successful start.

Environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `PACK_ROOT` | Pack root directory | argument passed to `startServer` |
| `HOST` | Listen address | `127.0.0.1` |
| `PORT` | Listen port | `26313` |
| `OPENAI_API_KEY` | OpenAI API key (highest priority) | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |

### `agent.ts` (PackAgent)

`PackAgent` is the platform-agnostic core agent layer that implements `IPackAgent`.

- Maintains a `Map<string, ChannelSession>` keyed by `channelId`.
- Each channel session is **lazily created** on the first `handleMessage` call.
- On session creation, reads optional pack-root `AGENTS.md` and `SOUL.md` and appends a structured SkillPack-owned policy/persona block to the final system prompt.
- Explicitly disables host-level `AGENTS.md`, `.pi/SYSTEM.md`, and `APPEND_SYSTEM.md` from affecting the pack's system prompt. This isolation applies only to system-prompt sources, not to the existing skill/prompt/extension loading behavior.
- `handleMessage` subscribes to `pi` session events and forwards them to the adapter's `onEvent` callback:

| pi event | Forwarded as AgentEvent |
| --- | --- |
| `agent_start` | `{ type: "agent_start" }` |
| `agent_end` | `{ type: "agent_end" }` |
| `message_start` | `{ type: "message_start", role }` |
| `message_end` | `{ type: "message_end", role }` |
| `message_update` (text_delta) | `{ type: "text_delta", delta }` |
| `message_update` (thinking_delta) | `{ type: "thinking_delta", delta }` |
| `tool_execution_start` | `{ type: "tool_start", toolName, toolInput }` |
| `tool_execution_end` | `{ type: "tool_end", toolName, isError, result }` |

- Checks `diagnostics` (stopReason, errorMessage, visible output) at the end of each turn and returns an error message on failure.
- Supports `abort(channelId)` to interrupt a running session and `dispose(channelId)` to tear it down.

### Delegated custom tools

Embedded hosts can create SkillPack custom tools through IPC. `skill-pack` requests definitions from the parent process and registers them as pi-coding-agent custom tools; tool execution is then forwarded back to the parent with the active `{ runId, channelId, adapter }` context.

See [`ipc-custom-tools.md`](ipc-custom-tools.md) for the contract and Frevana-side module layout.

### Pack-level policy and persona files

SkillPack supports two optional root files:

- `AGENTS.md` — pack policy, rules, and workflow guidance
- `SOUL.md` — pack persona, tone, and working style

These files are read once when a new channel session is created. They do not hot-reload into an existing session.

The injected prompt block uses this priority:

1. User instructions
2. `AGENTS.md`
3. `SOUL.md`

If `SOUL.md` conflicts with `AGENTS.md`, `AGENTS.md` wins. `SOUL.md` is treated as persona/style guidance only and does not override task requirements or safety boundaries.

Provider and model mapping (in `server.ts`):

```typescript
const modelId = provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";
```

### `adapters/types.ts` (shared interfaces)

Defines all types shared across adapters:

- `PlatformAdapter`: `{ name, start(ctx), stop() }`
- `AdapterContext`: `{ agent, server, app, rootDir }`
- `IPackAgent`: agent interface (`handleMessage`, `handleCommand`, `abort`, `isRunning`, `dispose`, `listSessions`, `restoreSession`)
- `AgentEvent`: union of 8 event types
- `BotCommand`: `"clear" | "restart" | "shutdown"`
- `ChannelMessage` / `ChannelAttachment`: attachment handling interfaces (inbound download + outbound `send_file` tool)
- `SessionInfo`: reserved extension interface

### `adapters/telegram.ts`

- Polling mode — no public webhook required.
- Each Telegram Chat ID gets its own channel (`telegram-<chatId>`); the session persists for the process lifetime.
- Responds only with the final text result; `thinking_delta` / `tool_start` / `tool_end` events are not forwarded.
- Long messages are split at 4096-character boundaries; HTTP 429 responses trigger automatic retries.

### `adapters/slack.ts`

- Socket Mode (`@slack/bolt`) — no public webhook required.
- Listens to `message.im` and `app_mention`.
- DM channel ID: `slack-dm-<teamId>-<channelId>`.
- Thread channel ID: `slack-thread-<teamId>-<channelId>-<threadTs|ts>`.
- Responds only with the final text result.
- Supports Slack slash commands `/skillpack-clear`, `/skillpack-restart`, `/skillpack-shutdown`.

### API key priority

1. `data/config.json` `apiKey` / `provider` fields — read first.
2. `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variables — override the config file.
3. Web frontend `POST /api/config/update` — persists to `data/config.json`; requires a restart to take effect.

### `job.json` scheduled jobs

`job.json` lives at the pack root beside `skillpack.json` and is the only persisted source for scheduler jobs.

```json
{
  "jobs": [
    {
      "name": "morning-briefing",
      "cron": "0 9 * * 1-5",
      "prompt": "Generate the morning market brief.",
      "notify": {
        "adapter": "telegram",
        "channelId": "telegram-1234567890"
      },
      "enabled": true,
      "timezone": "Asia/Shanghai"
    }
  ]
}
```

- If `job.json` is absent, the scheduler starts with no configured jobs.
- `job.json` is included in `skillpack zip` when present, so distributed packs can ship with preconfigured schedules.
- Legacy `data/config.json.scheduledJobs` is ignored and should be migrated into `job.json`.

### `data/config.json` IM configuration

```json
{
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

- Slack credentials are read only from `data/config.json`; no environment variable override.
- If only one of `botToken` or `appToken` is supplied, the Slack adapter logs a warning and is skipped.
- After saving config via the web UI, the API returns `requiresRestart: true`. If running under PM2, `POST /api/runtime/restart` triggers a managed restart.

## Frontend

The frontend is pure static HTML / CSS / JavaScript with no framework dependency.

### Page structure

- Left sidebar: pack name, description, skills list, provider selector, API key input.
- Right area: welcome view, chat view, input box.

### Initialization

On load, the page calls `GET /api/config` and then:

- Sets page title and pack metadata.
- Renders the skills list.
- Updates the API key placeholder based on the active provider.
- Shows the input pre-filled (one prompt) or welcome cards (multiple prompts).

### Chat interaction

Chat uses a single persistent WebSocket connection:

- Switches to chat mode before sending a message.
- Disables the input box while waiting for a response.
- Streams assistant output as incremental events.
- Renders tool calls as collapsible cards.
- Renders thinking output as separate collapsible cards.
- Markdown is rendered by `marked.min.js`.

> `chatHistory` exists in the frontend as a local record only; it is not replayed to the backend. The actual session state lives inside the `pi-coding-agent` session.

## Adding a New Adapter

1. Create `src/runtime/adapters/xxx.ts`.
2. Implement the `PlatformAdapter` interface (`name`, `start(ctx)`, `stop()`).
3. In `src/runtime/server.ts`, conditionally start the adapter inside `startAdapters()` based on `dataConfig.adapters.xxx`.
4. Run `npm run build` to compile.
