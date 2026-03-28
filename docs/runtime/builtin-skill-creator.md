# Built-in `skill-creator` Design

## Overview

SkillPack ships with a built-in `skill-creator` skill template inside the npm package and materializes it into each pack at runtime.

This feature exists so a pack can:

- provide a customized `skill-creator` workflow without requiring the user's global `~/.pi/agent/skills/skill-creator`
- keep the skill localized to the current pack
- inject pack-specific paths such as the pack's `skills/` directory and `skillpack.json`
- preserve relative references inside the `skill-creator` directory (`agents/`, `references/`, `scripts/`, `eval-viewer/`, assets, etc.)

The implementation lives in [`src/runtime/agent.ts`](../../src/runtime/agent.ts).

## Goals

The built-in `skill-creator` should satisfy these requirements:

1. Be distributed with the npm package.
2. Work even when the user has no global `skill-creator` installed.
3. Override any same-name global `skill-creator` at runtime.
4. Use the current pack's absolute paths rather than generic instructions.
5. Keep the full upstream-style directory layout intact so relative references still work.
6. Avoid overwriting an already materialized pack-local copy on every startup.

## Why a packaged template is needed

The active agent session runs with a workspace cwd under:

```text
<pack>/data/workspaces/<channel-id>/
```

That cwd is not the pack root. A generic `skill-creator` cannot reliably infer where new skills should be created or which `skillpack.json` should be updated.

Because of that, SkillPack does not rely on the global `skill-creator` content alone. Instead, it injects pack-specific absolute paths into a bundled template and exposes the materialized copy to the agent.

## Source of truth

The packaged template directory is:

```text
templates/builtin-skills/skill-creator/
```

This directory is published because `templates/` is already included in the npm package's `files` list.

The bundled directory is intended to contain the entire skill payload, not just `SKILL.md`. That includes:

- `SKILL.md`
- `agents/`
- `references/`
- `scripts/`
- `eval-viewer/`
- static assets
- licensing files

This preserves upstream relative references without needing to flatten or rewrite the directory structure.

## Runtime materialization

When a channel session is first created, `PackAgent` computes:

- `rootDir`
- `skillsPath = <rootDir>/skills`
- `packConfigPath = <rootDir>/skillpack.json`

It then materializes the bundled template into:

```text
<rootDir>/skills/skill-creator/
```

The copy is recursive.

### Placeholder replacement

During materialization, SkillPack replaces placeholders in text files:

- `{{SKILLS_PATH}}`
- `{{PACK_CONFIG_PATH}}`

At the moment, placeholder replacement is applied to:

- `*.md`
- `*.py`

Binary or static files are copied as-is.

### Copy policy

Materialization uses an initialization-only policy:

- if `<rootDir>/skills/skill-creator/` does not exist, copy the bundled template directory
- if it already exists, reuse it and do not overwrite the user's pack-local copy

This allows a pack to keep a local, editable copy after first startup.

## Override strategy

After materialization, the runtime still has to deal with global skills discovered by `pi-coding-agent`.

SkillPack therefore uses `DefaultResourceLoader(..., { skillsOverride })` to enforce precedence:

1. load the normal skill set from pi
2. remove any skill whose name is `skill-creator`
3. prepend the pack-local materialized `skill-creator`

This makes the pack-local version the effective one even if the user has a global `~/.pi/agent/skills/skill-creator`.

## Why the system prompt still shows other global skills

This override is intentionally narrow.

SkillPack only replaces `skill-creator`. Other skills such as:

- `editorial-card-screenshot`
- `find-skills`
- `skillpack-creator`
- `twitter-content-analyzer`

are still allowed to come from the global pi installation unless the pack provides its own overrides for them.

## Path behavior inside the skill

The bundled `skill-creator` is expected to tell the model to:

- create new skills under the current pack's `skillsPath`
- write the main file to `<skillsPath>/<skill-name>/SKILL.md`
- read the final frontmatter from the generated skill
- upsert the corresponding entry in `<rootDir>/skillpack.json`

The intended `skillpack.json` entry format is:

```json
{
  "name": "<frontmatter.name>",
  "description": "<frontmatter.description>",
  "source": "./skills/<frontmatter.name>"
}
```

This behavior is encoded in the bundled skill content, not hardcoded in the runtime.

## Lifecycle summary

The full flow is:

1. `skillpack run` starts the server.
2. A channel sends its first message.
3. `PackAgent` lazily creates a session.
4. `PackAgent` computes `skillsPath`.
5. If `skills/skill-creator/` does not exist, the bundled template directory is copied there.
6. `DefaultResourceLoader` loads skills from the pack and from pi defaults.
7. `skillsOverride` removes any same-name `skill-creator` and injects the pack-local one first.
8. `pi-coding-agent` rebuilds the system prompt and advertises the pack-local `skill-creator`.

## Current tradeoffs

### Benefits

- The pack does not depend on the user's global `skill-creator`.
- Relative resources continue to work because the whole directory is copied.
- The runtime can inject absolute pack paths.
- Users can edit the materialized pack-local copy after first startup.

### Costs

- The bundled template and the materialized copy can diverge over time.
- Existing packs created before a template update will keep their old materialized copy unless they delete `skills/skill-creator/`.
- Placeholder replacement is currently limited to Markdown and Python files.

## Future improvements

Possible follow-ups:

- add a version marker to the materialized directory and support opt-in refresh
- support placeholder replacement for more text file types
- add a CLI command to reinstall or refresh the built-in `skill-creator`
- generalize the same mechanism for other bundled built-in skills

## Files involved

- [`src/runtime/agent.ts`](../../src/runtime/agent.ts)
- [`templates/builtin-skills/skill-creator/SKILL.md`](../../templates/builtin-skills/skill-creator/SKILL.md)
- [`docs/runtime/runtime-architecture.md`](./runtime-architecture.md)
