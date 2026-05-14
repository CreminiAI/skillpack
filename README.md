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

1. Download the example
- [Garry Tan SkillPack](https://github.com/CreminiAI/skillpack-examples/releases/download/v.0.0.3/garry-tan.zip)
- [Company Deep Research SkillPack](https://github.com/FinpeakInc/downloads/releases/download/v.0.0.1/Company-Deep-Research.zip)
2. Unzip it and Run ./start.sh on Mac OS, Or double click start.bat on Windows (see below), the server starts and opens http://127.0.0.1:26313 in your browser

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
npx @cremini/skillpack create comic-explainer --config https://raw.githubusercontent.com/CreminiAI/skillpack/refs/heads/main/examples/comic-explainer.json
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

The archive produced by `zip` is intentionally lightweight:

```text
<pack-name>/
├── skillpack.json       # Pack configuration
├── AGENTS.md            # Optional pack policy
├── SOUL.md              # Optional pack persona
├── skills/              # Installed skills
├── start.sh             # One-click launcher for macOS / Linux
└── start.bat            # One-click launcher for Windows
```

The start scripts use `npx @cremini/skillpack run .` so Node.js is the only prerequisite — no pre-bundled server directory is included.

If present, `AGENTS.md` and `SOUL.md` are read by SkillPack itself when a new chat session starts. SkillPack injects them into the runtime system prompt as pack-level policy and persona, without depending on the host machine's `AGENTS.md`, `.pi/SYSTEM.md`, or `APPEND_SYSTEM.md`.

## Slack/Telegram Integrations

Talk to your Agents on Slack and Telegram

### 5 mins to get Slack `App Token` and `Bot Token`
https://frevana.gitbook.io/frevana-docs/integrations/slack-integration

### 1 min to get Telegram `Bot Token`
https://frevana.gitbook.io/frevana-docs/integrations/telegram-integration

---

## Example Use Cases

The main use case is to **run local agents on your computer and integrate them with Slack or Telegram** so they can work for you and your team — operating entirely on your machine to keep all team data local and private, while continuously improving by learning new skills. Each SkillPack organizes skills around a well-defined job — for example: research a company by gathering information from multiple sources and produce a PowerPoint presentation from the findings.

Download [Company Deep Research](https://github.com/FinpeakInc/downloads/releases/download/v.0.0.1/Company-Deep-Research.zip) and try it! More examples can be found at [skillpack.sh](https://skillpack.sh)

## License

MIT
