# SkillPack Architecture

## Project Overview

`@cremini/skillpack` is a Node.js CLI that packages a set of AI skills, prompt templates, and a built-in runtime into a single distributable local web application.

End users run `npx @cremini/skillpack run` (or extract a generated zip and execute `start.sh` / `start.bat`). A browser page opens locally, and the runtime's built-in `pi-coding-agent` executes the packaged skills on their behalf.

> If this document conflicts with the source code, the source code takes precedence.  
> "Pack" throughout this document refers to one distributable SkillPack application.

---

## Source Tree

```text
skill-pack/
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── commands/
│   │   ├── create.ts             # Interactive pack creation (+ --config <url>)
│   │   ├── run.ts                # Start the runtime server
│   │   └── zip.ts                # Lightweight zip packaging
│   ├── pack-config.ts            # skillpack.json read / write / validate
│   ├── skill-manager.ts          # Skill install, scan, remove, description sync
│   └── runtime/                  # Server runtime (compiled into dist/)
│       ├── server.ts             # Exports startServer()
│       ├── agent.ts              # PackAgent — platform-agnostic agent layer
│       ├── config.ts             # Runtime config loading
│       ├── lifecycle.ts          # Graceful shutdown / restart
│       └── adapters/
│           ├── types.ts          # Shared interfaces
│           ├── web.ts            # WebAdapter (HTTP + WebSocket)
│           ├── telegram.ts       # TelegramAdapter (polling)
│           ├── slack.ts          # SlackAdapter (Socket Mode)
│           └── markdown.ts       # Markdown → platform text converter
├── web/                          # Frontend static assets
├── templates/                    # start.sh / start.bat templates
├── package.json                  # Merged dependencies
├── tsconfig.json
└── tsup.config.ts
```

---

## Core Data Model

### `skillpack.json`

```json
{
  "name": "Comic Explainer",
  "description": "A skill App, powered by SkillPack.sh",
  "version": "1.0.0",
  "prompts": [
    "Prompt 1",
    "Prompt 2"
  ],
  "skills": [
    {
      "name": "baoyu-comic",
      "source": "https://github.com/JimLiu/baoyu-skills/tree/main/skills",
      "description": "Knowledge comic creator..."
    }
  ]
}
```

Field constraints:

- `name` — required
- `description` — must be a string
- `version` — must be a string
- `prompts` — must be a string array
- `skills` — must be an array
- `skills[].name` — deduplicated case-insensitively
- `skills[].source` — required
- `skills[].description` — must exist; empty string is allowed

### Prompt semantics

`prompts` serves two roles in the current runtime:

- Acts as preset task templates for the pack.
- Populates the frontend homepage with quick-input shortcuts.

UI behavior:

- If there is exactly one prompt, it is pre-filled into the input box.
- If there are multiple prompts, the homepage shows prompt cards that fill the input box on click.

---

## CLI Design

The CLI entry point is `src/cli.ts`, built on `commander`:

| Command | Description |
| --- | --- |
| `skillpack create [directory]` | Interactively create a new pack (also accepts `--config <url>` to initialize from a remote or local config file) |
| `skillpack run [directory]` | Start the runtime server; prompts to create `skillpack.json` if missing; auto-installs missing remote skills |
| `skillpack zip` | Package `skillpack.json`, optional `job.json`, optional pack prompt files, `start.sh`, `start.bat`, and `skills/` into a zip |

---

## Key Flows

### 1. `create`

`src/commands/create.ts`:

1. Resolves the target directory; creates it if a `directory` argument is passed.
2. If `skillpack.json` already exists in the target, prompts for confirmation before overwriting.
3. If `--config <url|path>` is supplied, fetches and validates the remote or local config file (replaces the old `init` command).
4. Otherwise, interactively collects `name`, `description`, skill sources and names, and prompts (first prompt required).
5. Saves `skillpack.json`.
6. Installs declared skills and syncs descriptions back into `skillpack.json`.
7. Copies `templates/start.sh` and `templates/start.bat` into the target directory.

### 2. `run`

`src/commands/run.ts`:

1. Resolves the working directory (defaults to `process.cwd()`).
2. If `skillpack.json` is missing, prompts for `name` and `description`, generates a default config, saves it, and copies start scripts.
3. Loads the config and detects missing remote skills.
4. Auto-installs any missing remote skills.
5. Calls `startServer({ rootDir })` to launch the runtime.

### 3. Skill management

Skill management is centralized in `src/skill-manager.ts`.

**Installation** — the CLI ultimately invokes:

```bash
npx -y skills add <source> --agent openclaw --copy -y --skill <name>
```

- Multiple skills from the same source are grouped and installed together.
- The install target is `skills/` in the working directory.
- An install failure aborts the current flow.

**Scan and description sync** — after installation, `skills/` is recursively scanned for `SKILL.md` files. Frontmatter fields `name` and `description` are read back and written into `skillpack.json`.

### 4. `zip`

`src/commands/zip.ts`:

Packages only the essentials for distribution:

- `skillpack.json`
- optional `job.json`
- `skills/` directory
- optional `AGENTS.md` / `SOUL.md`
- `start.sh` / `start.bat`

The runtime is no longer bundled inside the zip. The start scripts invoke `npx @cremini/skillpack run` so the runtime is resolved from npm at startup.

---

## Runtime Architecture

The runtime source lives in `src/runtime/`. It is compiled into `dist/` by `tsup` and shipped as part of the npm package. See [runtime/runtime-architecture.md](./runtime/runtime-architecture.md) for the detailed server-side design.

### Distributed pack structure

The zip produced by `skillpack zip` contains:

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

The start scripts run `npx @cremini/skillpack run .` so users need only Node.js installed.

### Start scripts

`templates/start.sh`:

```bash
#!/bin/bash
cd "$(dirname "$0")"
npx -y @cremini/skillpack run .
```

`templates/start.bat`:

```bat
@echo off
cd /d "%~dp0"
npx -y @cremini/skillpack run .
```

Node.js >= 20 is required.

---

## npm Package Contents

Files published to npm (`"files"` in `package.json`):

| Path | Purpose |
| --- | --- |
| `dist/` | Compiled CLI and runtime |
| `web/` | Frontend static assets |
| `templates/` | start.sh / start.bat templates |
| `README.md` | — |
| `LICENSE` | — |

Source files (`src/`), docs, and local build artifacts are excluded.
