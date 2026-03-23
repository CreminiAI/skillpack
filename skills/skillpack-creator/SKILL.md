---
name: skillpack-creator
description: Create a reusable SkillPack from a successful completed task. Use when the user wants to convert a one-off research, coding, analysis, or content workflow into a distributable local SkillPack with `skillpack.json`, local skills under `skills/`, starter prompts, start scripts, and an optional zip package.
---

# Skillpack Creator

## Overview

Turn a successful task into a reusable SkillPack. Extract the stable workflow, decide what belongs in a local skill versus pack-level prompts, generate the pack structure, and package it only after the workflow is explicit and repeatable.

## Workflow

### 1. Normalize the source task

Start by reducing the finished task into a clean execution spec:

- Capture the user goal and the concrete deliverable.
- Capture the final successful workflow, not the full exploratory transcript.
- List required skills, tools, files, secrets, and environment assumptions.
- Separate deterministic steps from heuristic steps.
- Remove dead ends, retries, and one-off debugging noise.

If the prior work is still ambiguous, ask for the missing stable facts or infer only the pieces that are low risk.

### 2. Decide what the pack should contain

Use this split:

- Put reusable procedural knowledge in a local skill under the target pack's `skills/`.
- Put repeated shell or file-generation logic into scripts inside that local skill when reliability matters.
- Put detailed schemas, API notes, or conventions into reference files.
- Put 1 to 3 pack-level prompts in `skillpack.json` as the pack's user-facing entry points.

Do not treat `prompts` as a strict workflow engine. In this codebase they are starter inputs for the UI, not a DAG or state machine. Read `references/skillpack-format.md` when you need the exact pack semantics.

### 3. Create the pack specification

Before writing files, define:

- Pack name
- Pack description
- Preset prompts
- Skill list with `name`, `source`, and `description`
- Which skill is the new local orchestrator skill
- Expected output files and success criteria

Prefer one local orchestrator skill plus a small number of external skills. Keep the pack narrow and job-focused.

### 4. Create the local orchestrator skill

In the target pack:

- Create `skills/<skill-name>/SKILL.md`.
- Write frontmatter that clearly describes what the local skill does and when it should trigger.
- Move the stable workflow into imperative instructions.
- Add `scripts/` only for fragile or repeated operations.
- Add `references/` only for detailed information that should not bloat `SKILL.md`.

If the workflow is mostly instructions, keep the local skill simple. If reproducibility depends on exact file generation, add scripts.

### 5. Materialize the pack

Use `scripts/scaffold_skillpack.py` in this skill when you already know the pack spec. It will:

- validate a JSON manifest shaped like `skillpack.json`
- write `skillpack.json`
- create `skills/`
- copy `start.sh` and `start.bat` from this repository's `templates/`
- optionally run `npx -y @cremini/skillpack zip`

Typical usage:

```bash
python3 skills/skillpack-creator/scripts/scaffold_skillpack.py \
  --manifest /tmp/skillpack.json \
  --output /absolute/path/to/output-pack
```

With zip generation:

```bash
python3 skills/skillpack-creator/scripts/scaffold_skillpack.py \
  --manifest /tmp/skillpack.json \
  --output /absolute/path/to/output-pack \
  --zip
```

### 6. Validate the result

Before handing the pack back:

- Confirm the manifest matches the intended pack scope.
- Confirm every declared skill has a valid `name`, `source`, and `description`.
- Confirm local skills are present under the target pack's `skills/`.
- Confirm the starter prompts are concrete enough to reproduce the workflow.
- Zip only after the pack can already run as a directory.

## Decision Rules

- If the reusable value is mostly workflow knowledge, create a local skill and keep scripts minimal.
- If the task depends on exact file emission or repetitive shell steps, script those parts.
- If the task is still too broad, split it into a narrower pack instead of writing a vague mega-skill.
- If key success conditions depend on hidden human judgment, state that the pack is a best-effort assistant workflow, not a deterministic pipeline.

## Output Standard

When you use this skill, produce:

1. A short summary of the stabilized workflow.
2. The target pack structure and skill inventory.
3. The created or updated local skill files.
4. The generated `skillpack.json`.
5. Whether the pack was zipped and where the zip lives.
