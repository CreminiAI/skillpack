# SkillPack — Pack and deploy local AI agents for your team in minutes

Skillpack helps teams turn AI skills into trusted local agents that can run in their own environment and be used directly from **Slack** and **Telegram**. Our vision is to achieve distributed intelligence network, much like cremini mushrooms that grow from a vast, interconnected mycelial network.

## What is SkillPack

[skillpack.sh](https://skillpack.sh) is an open-source way to package AI skills into runnable local agents. If skills and tools are like LEGO pieces, a SkillPack is the finished product that assembles them into a complete solution.
Instead of juggling prompts, scripts, docs, and one-off automations, Skillpack gives you a simple way to:
- package AI skills into reusable agents
- run them locally
- keep sensitive data in your own environment
- use agents from tools your team already uses, like Slack and Telegram

Skillpack is built for teams that want AI Agents to be deployable, trusted, and easy to use. 

---

## Quick Start

### 1. Run a skillpack 
1. Download the example [Company Deep Research](https://github.com/FinpeakInc/downloads/releases/download/v.0.0.1/Company-Deep-Research.zip)
2. Unzip it and Run ./start.sh on Mac OS, and double click start.bat on Windows (see below), the server starts and opens http://127.0.0.1:26313 in your browser
```bash
# macOS / Linux
./start.sh

# Windows
start.bat
```
3. Enter an LLM API key (OpenAI or Claude API Key) in the left menu, use the prompt example to try it!
4. (Optional) Refer to the instructions **Slack/Telegram Integrations** below to integrate with Slack and Telegram.


### 2. Create a new skillpack

```bash
npx @cremini/skillpack create
```

Step by step:

1. Set the pack name and description.
2. Add skills from GitHub repos, URLs, or local paths.
3. Add prompts to tell the agent how to orchestrate those skills.
4. Optionally package the result as a zip immediately.

### 3. Create a new skillpack from an existing config

```bash
# From a local file
npx @cremini/skillpack create --config ./skillpack.json

# From a remote URL (no directory = current directory)
npx @cremini/skillpack create comic-explainer --config https://raw.githubusercontent.com/CreminiAI/skillpack/refs/heads/main/examples/comic_explainer.json
```

Ready to run using "Run a skillpack" part

### 4. Package a pack for distribution

```bash
npx @cremini/skillpack zip
```

Produces `<pack-name>.zip` in the current directory.

---

## Skill Source URL Formats

When adding skills through `create`, the source accepts:

```bash
# GitHub shorthand
vercel-labs/agent-skills --skill frontend-design

# Full GitHub URL
https://github.com/JimLiu/baoyu-skills/tree/main/skills --skill baoyu-comic

# Local path
./skills/my-local-skill
```

Multiple skill names from the same source can be listed comma-separated.

---

## Zip Output

The archive produced by `zip` is intentionally minimal:

```text
<pack-name>/
├── skillpack.json       # Pack configuration
├── skills/              # Installed skills
├── start.sh             # One-click launcher for macOS / Linux
└── start.bat            # One-click launcher for Windows
```

The start scripts use `npx @cremini/skillpack run .` so Node.js is the only prerequisite — no pre-bundled server directory is included.

## Slack/Telegram Integrations

**Slack Configuration**: requires Slack `App Token` and `Bot Token`<br>
**Telegram configuration**: requires `Bot Token`

### Slack App Setup and how to get `App Token` and `Bot Token`
1. Create a new Slack app at https://api.slack.com/apps
2. Enable Socket Mode (Settings → Socket Mode → Enable)
3. Generate an App-Level Token with `connections:write` scope. This is **`App Token`**
4. Add Bot Token Scopes (OAuth & Permissions):
- `app_mentions:read`
- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `users:read`

5. Subscribe to Bot Events (Event Subscriptions):
- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`

6. Enable Direct Messages (App Home):
Go to App Home in the left sidebar
Under Show Tabs, enable the Messages Tab
Check Allow users to send Slash commands and messages from the messages tab

7. Install the app to your workspace. Get the Bot User OAuth Token. This is **`Bot Token`**
8. Add the app to any channels where you want the agent to operate (it'll only see messages in channels it's added to)
9. On the SkillPack buit-in UI http://127.0.0.1:26313, Tap "Connect to Chat App" button and Enter the **`Bot Token`** and **`App Token`**, Save

### Telegram Setup and how to get `Bot Token`
1. **Open Telegram** and search for the official account **`@BotFather`** (it will have a blue verified checkmark).
2. **Start a chat** by tapping "Start" or sending the `/start` command.
3. **Send the command** `/newbot` to the BotFather.
4. **Follow the prompts** to choose a display name and a unique username for your bot. The username must end with the word "bot" (e.g., `MyHelperBot` or `My_Helper_bot`).
5. **Receive the token**. Once the bot is successfully created, the BotFather will provide you with a message containing your unique API token. 
The token will look like a long string of numbers and letters, formatted as `123456789:AABBCCddEeff.... `
6. On the SkillPack buit-in UI http://127.0.0.1:26313, Tap "Connect to Chat App" button and Enter the **`Bot Token`**, Save

### (Optional) Put tokens into data/config.json if you don't use Web UI
Or Once you have telegram or slack tokens, you can also configure them in `data/config.json` (created at runtime, not included in the zip):
The runtime supports **Slack** and **Telegram** in addition to the built-in web UI. 

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

---

## Example Use Cases

The main use case is to **run local agents on your computer and integrate them with Slack or Telegram** so they can work for you and your team — operating entirely on your machine to keep all team data local and private, while continuously improving by learning new skills. Each SkillPack organizes skills around a well-defined job — for example: research a company by gathering information from multiple sources and produce a PowerPoint presentation from the findings. 

Download [Company Deep Research](https://github.com/FinpeakInc/downloads/releases/download/v.0.0.1/Company-Deep-Research.zip) and try it! More examples can be found at [skillpack.sh](https://skillpack.sh)

## License

MIT
