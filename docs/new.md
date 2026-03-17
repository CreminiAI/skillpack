# Skill Pack Redesign: Multi-Platform Chat Support

## Goals

1. Support multiple chat platforms (Web, Telegram, Slack, etc.)
2. Unified storage layer for all platforms
3. Platform-agnostic agent that doesn't care where messages come from
4. Adapters that are independently testable
5. Agent that is independently testable

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI / Entry Point                          │
│  ./start ./data                                                         │
│  (reads config.json, starts all configured adapters)                    │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            Platform Adapter                             │
│    ┌───────────────┐     ┌───────────────┐     ┌───────────────┐        │
│    │  WebAdapter   │     │TelegramAdapter│     │  SlackAdapter │        │
│    └───────┬───────┘     └───────┬───────┘     └───────┬───────┘        │
│            │                     │                     │                │
│            └─────────────────────┴─────────────────────┘                │
│                                  │                                      │
│                                  ▼                                      │
│                      ┌───────────────────────┐                          │
│                      │    PlatformAdapter    │  (common interface)      │
│                      │  - onMessage()        │                          │
│                      │  - onStop()           │                          │
│                      │  - sendMessage()      │                          │
│                      │  - updateMessage()    │                          │
│                      │  - deleteMessage()    │                          │
│                      │  - uploadFile()       │                          │
│                      │  - getChannelInfo()   │                          │
│                      │  - getUserInfo()      │                          │
│                      └───────────┬───────────┘                          │
└──────────────────────────────────┼──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              PackAgent                                  │
│  - Platform agnostic                                                    │
│  - Receives messages via handleMessage(message, context, onEvent)       │
│  - Forwards AgentSessionEvent to adapter via callback                   │
│  - Provides: abort(), isRunning()                                       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ChannelStore                                  │
│  - Unified storage schema for all platforms                             │
│  - log.jsonl: channel history (messages only)                           │
│  - context.jsonl: LLM context (messages + tool results)                 │
│  - attachments/: downloaded files                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Interfaces

### 1. ChannelMessage (Unified Message Format)

```typescript
interface ChannelMessage {
  /** Unique ID within the channel (platform-specific format preserved) */
  id: string;

  /** Channel/conversation ID */
  channelId: string;

  /** Timestamp (ISO 8601) */
  timestamp: string;

  /** Sender info */
  sender: {
    id: string;
    username: string;
    displayName?: string;
    isBot: boolean;
  };

  /** Message content (as received from platform) */
  text: string;

  /** Optional: original platform-specific text (for debugging) */
  rawText?: string;

  /** Attachments */
  attachments: ChannelAttachment[];

  /** Is this a direct mention/trigger of the bot? */
  isMention: boolean;

  /** Optional: reply-to message ID (for threaded conversations) */
  replyTo?: string;

  /** Platform-specific metadata (for platform-specific features) */
  metadata?: Record<string, unknown>;
}

interface ChannelAttachment {
  /** Original filename */
  filename: string;

  /** Local path (relative to channel dir) */
  localPath: string;

  /** MIME type if known */
  mimeType?: string;

  /** File size in bytes */
  size?: number;
}
```

### 2. PlatformAdapter

Adapters handle platform connection and UI. They receive events from PackAgent and render however they want.

```typescript
interface PlatformAdapter {
  /** Adapter name (used in channel paths, e.g., "slack-acme") */
  name: string;

  /** Start the adapter (connect to platform) */
  start(): Promise<void>;

  /** Stop the adapter */
  stop(): Promise<void>;

  /** Get all known channels */
  getChannels(): ChannelInfo[];

  /** Get all known users */
  getUsers(): UserInfo[];
}

interface ChannelInfo {
  id: string;
  name: string;
  type: "channel" | "dm" | "group";
}

interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
}
```

### 3. PackAgent

PackAgent wraps `AgentSession` from coding-agent. Agent is platform-agnostic; it just forwards events to the adapter.

```typescript
import { type AgentSessionEvent } from "@mariozechner/pi-coding-agent";

interface PackAgent {
  /**
   * Handle an incoming message.
   * Adapter receives events via callback and renders however it wants.
   */
  handleMessage(
    message: ChannelMessage,
    context: ChannelContext,
    onEvent: (event: AgentSessionEvent) => Promise<void>,
  ): Promise<{ stopReason: string; errorMessage?: string }>;

  /** Abort the current run for a channel */
  abort(channelId: string): void;

  /** Check if a channel is currently running */
  isRunning(channelId: string): boolean;
}

interface ChannelContext {
  /** Adapter name (for channel path: channels/<adapter>/<channelId>/) */
  adapter: string;
  users: UserInfo[];
  channels: ChannelInfo[];
}
```

## Event Handling

Adapter receives `AgentSessionEvent` and renders however it wants:

```typescript
// Slack adapter example
async function handleEvent(event: AgentSessionEvent, ctx: SlackContext) {
  switch (event.type) {
    case "tool_execution_start": {
      const label = (event.args as any).label || event.toolName;
      await ctx.updateMain(`_→ ${label}_`);
      break;
    }

    case "tool_execution_end": {
      // Format tool result for thread
      const result = extractText(event.result);
      const formatted = `**${event.toolName}** (${event.durationMs}ms)\n\`\`\`\n${result}\n\`\`\``;
      await ctx.appendThread(this.toSlackFormat(formatted));
      break;
    }

    case "message_end": {
      if (event.message.role === "assistant") {
        const text = extractAssistantText(event.message);
        await ctx.replaceMain(this.toSlackFormat(text));
        await ctx.appendThread(this.toSlackFormat(text));

        // Usage from AssistantMessage
        if (event.message.usage) {
          await ctx.appendThread(formatUsage(event.message.usage));
        }
      }
      break;
    }

    case "auto_compaction_start":
      await ctx.updateMain("_Compacting context..._");
      break;
  }
}
```

Each adapter decides:

- Message formatting (markdown → mrkdwn, embeds, etc.)
- Message splitting for platform limits
- What goes in main message vs thread
- How to show tool results, usage, errors

## Storage Format

### log.jsonl (Channel History)

Messages stored as received from platform:

```jsonl
{"id":"1734567890.123456","ts":"2024-12-20T10:00:00.000Z","sender":{"id":"U123","username":"mario","displayName":"Mario Z","isBot":false},"text":"<@U789> what's the weather?","attachments":[],"isMention":true}
{"id":"1734567890.234567","ts":"2024-12-20T10:00:05.000Z","sender":{"id":"bot","username":"mom","isBot":true},"text":"The weather is sunny!","attachments":[]}
```

### context.jsonl (LLM Context)

Same format as current (coding-agent compatible):

```jsonl
{"type":"session","id":"uuid","timestamp":"...","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"message","timestamp":"...","message":{"role":"user","content":"[mario]: what's the weather?"}}
{"type":"message","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"The weather is sunny!"}]}}
```

## Directory Structure

```
data/
├── config.json                    # Host only - tokens, adapters, access control
└── workspace/
    ├── MEMORY.md
    ├── skills/
    ├── tools/
    ├── events/
    └── channels/
        ├── slack-acme/
        │   └── C0A34FL8PMH/
        │       ├── MEMORY.md
        │       ├── log.jsonl
        │       ├── context.jsonl
        │       ├── attachments/
        │       ├── skills/
        │       └── scratch/
        └── discord-mybot/
            └── 1234567890123456789/
                └── ...
```

**config.json** (not mounted, stays on host):

```json
{
  "adapters": {
    "slack-acme": {
      "type": "slack",
      "botToken": "xoxb-...",
      "appToken": "xapp-..."
    },
    "discord-mybot": {
      "type": "discord",
      "botToken": "..."
    }
  }
}
```

**Channels** are namespaced by adapter name: `channels/<adapter>/<channelId>/`

**Events** use qualified channelId: `{"channelId": "slack-acme/C123", ...}`

// Usage
const userChannels = adapter.getUserChannels(userId); // ["public", "team-a"]
const allChannels = await fs.readdir("/workspace/channels/");
const denied = allChannels.filter((ch) => !userChannels.includes(ch));

## System Prompt Changes

The system prompt is platform-agnostic. Agent outputs standard markdown, adapter converts.

```typescript
function buildSystemPrompt(
  workspacePath: string,
  channelId: string,
  memory: string,
  sandbox: SandboxConfig,
  context: ChannelContext,
  skills: Skill[],
): string {
  return `You are pi, a chat bot assistant. Be concise. No emojis.

## Text Formatting
Use standard markdown: **bold**, *italic*, \`code\`, \`\`\`block\`\`\`, [text](url)
For mentions, use @username format.

## Users
${context.users.map((u) => `@${u.username}\t${u.displayName || ""}`).join("\n")}

## Channels
${context.channels.map((c) => `#${c.name}`).join("\n")}

... rest of prompt ...
`;
}
```

The adapter converts markdown to platform format internally:

```typescript
// Inside SlackAdapter
private formatForSlack(markdown: string): string {
  let text = markdown;

  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Links: [text](url) → <url|text>
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');

  // Mentions: @username → <@U123>
  text = text.replace(/@(\w+)/g, (match, username) => {
    const user = this.users.find(u => u.username === username);
    return user ? `<@${user.id}>` : match;
  });

  return text;
}
```

## Decisions

1. **Channel ID collision**: Prefix with adapter name (`channels/slack-acme/C123/`).

2. **Threads**: Adapter decides. Slack uses threads, Discord can use threads or embeds.

3. **Mentions**: Store as-is from platform. Agent outputs `@username`, adapter converts.

4. **Rate limiting**: Each adapter handles its own.

5. **Config**: Single `config.json` with all adapter configs and tokens.

## File Structure

```
runtime/
├── main.ts                    # CLI entry point
├── agent.ts                   # PackAgent
├── store.ts                   # ChannelStore
├── context.ts                 # Session management
├── events.ts                  # Scheduled events
├── log.ts                     # Console logging
│
├── adapters/
│   ├── types.ts              # PlatformAdapter, ChannelMessage interfaces
│   ├── slack.ts              # SlackAdapter
│   ├── discord.ts            # DiscordAdapter
│   └── cli.ts                # CLIAdapter (for testing)
│
└── tools/
    ├── index.ts
    ├── bash.ts
    ├── read.ts
    ├── write.ts
    ├── edit.ts
    └── attach.ts
```
