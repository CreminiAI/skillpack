# SkillPack — Pack and deploy local AI agents for your team in minutes

Skillpack helps teams turn AI skills into trusted local agents that can run in their own environment and be used directly from **Slack** and **Telegram**. Our vision is to achieve distributed intelligence network, much like cremini mushrooms that grow from a vast, interconnected mycelial network.

## What is SkillPack

[skillpack.sh](https://skillpack.sh) is an open-source way to package AI skills into runnable local agents.
Instead of juggling prompts, scripts, docs, and one-off automations, Skillpack gives you a simple way to:
- package AI skills into reusable agents
- run them locally
- keep sensitive data in your own environment
- use agents from tools your team already uses, like Slack and Telegram

Skillpack is built for teams that want AI Agents to be deployable, trusted, and easy to use.

## Why use SkillPack

AI workflows are easy to prototype, but hard to use across a team. Today, most teams deal with:
- scattered prompts and scripts
- unclear setup steps
- no standard way to reuse workflows
- poor team adoption
- sensitive company data leaving their environment

Skillpack solves this by making AI Skillpacks:

**Trusted**
Use packaged agents instead of piecing together random prompts and tools by hand.
**Local**
Run agents in your own machine or environment so sensitive data stays local.
**Team-ready**
Use agents directly from Slack and Telegram, where work already happens.
**Fast**
Pack and deploy local agents in seconds.

## Who is SkillPack for

Skillpack is designed for: startup teams, founders and operators, e-commerce teams, sales and growth teams, support teams, marketing teams, recruiting teams, developers building reusable AI workflows, If your team has repeatable work that AI can help with, Skillpack gives you a better way to package and run it.

## Use Case

The main use case is to **run local agents on your computer and integrate them with Slack or Telegram** so they can work for you and your team — operating entirely on your machine to keep all team data local and private, while continuously improving by learning new skills.

If skills and tools are like LEGO pieces, a SkillPack is the finished product that assembles them into a complete solution. Go to [skillpack.sh](https://skillpack.sh) to download ready-made packs.

Each SkillPack organizes skills around a well-defined job — for example: research a company by gathering information from multiple sources and produce a PowerPoint presentation from the findings.

---

## Quick Start

### Create a new pack interactively

```bash
npx @cremini/skillpack create
```

Step by step:

1. Set the pack name and description.
2. Add skills from GitHub repos, URLs, or local paths.
3. Add prompts to tell the agent how to orchestrate those skills.
4. Optionally package the result as a zip immediately.

### Initialize from an existing config

```bash
# From a local file
npx @cremini/skillpack create --config ./skillpack.json

# From a remote URL (no directory = current directory)
npx @cremini/skillpack create comic-explainer --config https://raw.githubusercontent.com/CreminiAI/skillpack/refs/heads/main/examples/comic_explainer.json
```

Downloads and validates the config, installs all declared skills, and copies the start scripts — ready to run in one step.

### Run a pack

```bash
npx @cremini/skillpack run
npx @cremini/skillpack run ./comic-explainer
```

- If `skillpack.json` is missing, you are prompted to create one on the spot.
- Any remote skills declared in the config but not yet installed are installed automatically.
- The server starts and opens [http://127.0.0.1:26313](http://127.0.0.1:26313) in your browser.

### Package a pack for distribution

```bash
npx @cremini/skillpack zip
```

Produces `<pack-name>.zip` in the current directory.

---

## Skill Source Formats

When adding skills through `create`, the source field accepts:

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

### Run a distributed pack

```bash
# macOS / Linux
./start.sh

# Windows
start.bat
```

The browser opens [http://127.0.0.1:26313](http://127.0.0.1:26313) automatically. Enter your API key and start working.

---

## IM Integrations

The runtime supports **Slack** and **Telegram** in addition to the built-in web UI. Configure them in `data/config.json` (created at runtime, not included in the zip):

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

See [docs/runtime/im-adapters.md](docs/runtime/im-adapters.md) for setup requirements.

---

## Development

For build commands, CLI reference, and environment variables, see [Development Guide](docs/development.md).

## License

MIT
