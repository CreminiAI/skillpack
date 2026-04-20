# What Is SkillPack

## The SkillPack Idea

SkillPack is a way to turn a set of reusable AI skills into a runnable local agent application.

In this repository, a SkillPack is not just a loose collection of prompts or tools. It is a packaged unit that combines:

- a pack-level configuration file: `skillpack.json`
- one or more installed skills under `skills/`
- a built-in runtime, including the local server and web UI

The main goal is to make an AI workflow portable and distributable. Instead of asking every user to install skills, wire prompts together, and configure a runtime manually, SkillPack assembles those pieces into one pack that can be initialized, bundled, extracted, and run locally.

This is the core philosophy behind SkillPack:

- Skills are the building blocks.
- Prompts define how those skills should be orchestrated.
- The runtime turns the pack into a working local agent.
- The final pack can be shared as a self-contained app-like bundle.

If individual skills are like LEGO bricks, a SkillPack is the finished product assembled for a specific job.

## The Role of `skillpack.json`

`skillpack.json` is the root configuration file of a SkillPack. The CLI reads it, validates it, installs the declared skills, and packages it into the final zip. The runtime also reads it at startup to display pack metadata and the configured skills in the UI.

A typical file looks like this:

```json
{
  "name": "Comic Explainer",
  "description": "Explains complex concepts to children through educational comics.",
  "version": "1.0.0",
  "prompts": [
    "Create a children's science comic in English and save the final PDF to the current directory."
  ],
  "skills": [
    {
      "name": "baoyu-comic",
      "source": "https://github.com/JimLiu/baoyu-skills/tree/main/skills",
      "description": "Knowledge comic creator supporting multiple art styles and tones."
    },
    {
      "name": "local-image-gen",
      "source": "./skills/image-gen",
      "description": "A locally referenced image generation skill."
    }
  ]
}
```

### Top-level fields

- `name`: the pack name. It is required.
- `description`: a human-readable summary of the pack.
- `version`: the pack version string.
- `prompts`: an array of preset task instructions.
- `skills`: an array of declared skill entries.

### `prompts`

`prompts` are pack-level starter instructions. In the current web runtime:

- if there is exactly one prompt, it is prefilled into the input box
- if there are multiple prompts, they are presented as selectable prompt cards

This makes prompts more than documentation. They are part of the packaged user experience.

### `skills`

Each entry in `skills` describes one skill that the pack depends on. Each item contains:

- `name`: the unique skill name
- `source`: where the skill comes from
- `description`: a short description of the skill

In the current implementation, duplicate skill names are not allowed, and the config validator requires every skill to have a non-empty `name`, `source`, and `description` field.

Also note that `description` is not only hand-written metadata. After installation, the CLI scans `SKILL.md` files under `skills/` and syncs the description from skill frontmatter back into `skillpack.json`.

## `source`: Remote vs Local

From a product and packaging perspective, `skills[].source` can be understood as having two categories: `remote` and `local`.

### Remote source

A remote source points to an external skill repository or remote location. Common examples include GitHub repository references or URLs such as:

```json
{
  "name": "reddit",
  "source": "https://github.com/resciencelab/opc-skills",
  "description": "Research Reddit discussions to extract relevant community feedback."
}
```

This tells the SkillPack workflow that the skill should be resolved from outside the current pack workspace.

### Local source

A local source points to a directory already available in the local pack workspace.

For this documentation, a `source` that starts with `./skills` should be treated as a local source. For example:

```json
{
  "name": "local-image-gen",
  "source": "./skills/image-gen",
  "description": "A locally referenced image generation skill."
}
```

This means the skill is referenced from a local directory inside the pack itself rather than fetched from a remote repository.

That distinction matters because local skills are useful when:

- you are developing or testing a custom skill
- you want the pack to ship with an edited local copy
- you want the pack to depend on a local directory under version control

## The `skills/` Directory

The repository implementation uses a real `skills/` directory at the pack root. That is the on-disk location used by the CLI and by the packaged output.

If you see `.skills` mentioned elsewhere, treat it as a conceptual shorthand for the installed skill area. In this codebase, the actual directory name is `skills/`.

This directory is important for three reasons:

### 1. It is the mounted skill workspace

Installed skills ultimately live under `skills/`. The CLI installs declared skills into this directory, and the bundled pack includes it as part of the final archive.

### 2. It is the metadata source of truth

The CLI recursively scans `skills/` for `SKILL.md` files. When it finds them, it reads frontmatter such as:

- `name`
- `description`

That metadata is then used to refresh the corresponding entries in `skillpack.json`.

### 3. It is part of the distributed zip

When `zip` creates the final archive, it packages:

- `skillpack.json`
- optional `job.json`
- optional `AGENTS.md` / `SOUL.md`
- the entire `skills/` directory
- `start.sh` and `start.bat`

The extracted pack structure stays lightweight:

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

The start scripts invoke `npx @cremini/skillpack run .`, so the runtime is resolved from npm at startup — no pre-bundled server directory is needed. This is why `skills/` is not just a temporary install cache. It is part of the packaged application itself.

### Optional root context files

A pack can also include these optional root files:

- `job.json` — scheduled job definitions that ship with the pack

- `AGENTS.md` — the pack's operational policy and workflow rules
- `SOUL.md` — the pack's persona, tone, and working style

These files are not declared in `skillpack.json`. They are pack assets that travel with the directory and zip output.

At runtime, SkillPack reads them when a new session is created and appends a structured block to the final system prompt. This is handled by SkillPack itself rather than by relying on host-level pi context-file discovery. As a result:

- the pack controls its own policy/persona layer
- host-machine `AGENTS.md`, `.pi/SYSTEM.md`, and `APPEND_SYSTEM.md` do not affect the pack's system prompt
- changes take effect for new sessions, not already-running sessions

## Summary

SkillPack packages AI skills, prompts, and a runtime into one local agent application.

- `skillpack.json` defines the pack's metadata, prompts, and skill declarations.
- `job.json` optionally defines scheduled jobs that should ship inside the pack zip.
- `AGENTS.md` and `SOUL.md` are optional pack-level policy/persona files controlled by SkillPack runtime.
- `skills[].source` can be understood as either `remote` or `local`.
- A source beginning with `./skills` represents a local directory reference inside the pack.
- `skills/` is the real installed-skill directory used by the CLI, metadata sync process, and final zip.
- `skillpack zip` produces a lightweight archive; the runtime is fetched from npm via `npx @cremini/skillpack run` at startup.

Together, these pieces make SkillPack a practical format for building, shipping, and running local AI agents.
