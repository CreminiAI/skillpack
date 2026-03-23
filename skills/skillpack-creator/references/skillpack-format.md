# SkillPack Format Notes

Use this reference when converting a finished task into a distributable SkillPack in this repository.

## Core Rules

- A pack is defined by `skillpack.json`.
- The runtime loads skills from the pack root `skills/` directory.
- `prompts` are preset starter instructions for the UI.
- The packaged zip is intentionally minimal.

## `skillpack.json` shape

The current implementation expects:

```json
{
  "name": "Pack Name",
  "description": "Short summary",
  "version": "1.0.0",
  "prompts": [
    "Concrete starter instruction"
  ],
  "skills": [
    {
      "name": "local-or-remote-skill",
      "source": "./skills/local-or-remote-skill",
      "description": "What the skill does"
    }
  ]
}
```

## Field constraints

- `name` is required.
- `description` must be a string.
- `version` must be a string.
- `prompts` must be an array of strings.
- `skills` must be an array.
- each skill entry must have `name`, `source`, and `description`
- duplicate skill names are not allowed

## Source rules

Use one of these source styles:

- Local skill in the pack: `./skills/<skill-name>`
- Remote skill repo or URL: the source accepted by `npx skills add ...`

For local skills, still declare the skill in `skills[]`. The runtime uses the on-disk `skills/` directory, and the pack metadata should stay in sync with the actual skill folder.

## What the zip contains

The current `zip` command packages only:

```text
<pack-name>/
├── skillpack.json
├── skills/
├── start.sh
└── start.bat
```

It does not embed the runtime server. The launcher scripts call:

```bash
npx -y @cremini/skillpack run .
```

## Practical implications

- A SkillPack is best for packaging a stable workflow, not an exact execution graph.
- Put the real reusable process into local skills.
- Use `prompts` as polished starting instructions for users.
- If stability depends on exact commands or file generation, add scripts inside the local skill instead of relying on a long prompt alone.
