---
name: skillpack-creator
description: Create a reusable SkillPack from a successful completed task. Use when the user wants to convert a one-off research, coding, analysis, or content workflow into a distributable local SkillPack with `skillpack.json`, local skills under `skills/`, starter prompts, start scripts, and an optional zip package.
---

# Skillpack Creator

## Overview

Turn a successful task into a reusable SkillPack. Extract the stable workflow, decide what belongs in a local skill versus pack-level prompts, generate the pack structure, and package it only after the workflow is explicit and repeatable.

## Workflow

### 1. Normalize the source task

Reduce the finished task into a clean execution spec:

- Capture the user goal, concrete deliverable, and the final successful workflow (not the full exploratory transcript).
- List required skills, tools, files, secrets, and environment assumptions.
- Separate deterministic steps from heuristic steps; remove dead ends and debugging noise.
- If the task is still too broad, narrow the scope instead of writing a vague mega-skill. If key success conditions depend on hidden human judgment, mark the pack as a best-effort assistant workflow.

Ask for missing stable facts or infer only the low-risk pieces.

### 2. Decide what the pack should contain

- **Local skill** (`skills/`): reusable procedural knowledge. Keep scripts minimal unless reproducibility depends on exact file generation or repetitive shell steps.
- **Scripts** (`scripts/`): repeated shell or file-generation logic where reliability matters.
- **References** (`references/`): detailed schemas, API notes, or conventions that should not bloat `SKILL.md`.
- **Prompts** (`skillpack.json`): 1–3 pack-level starter inputs for the UI — not a DAG or state machine. See `references/skillpack-format.md` for exact pack semantics.

### 3. Create the pack specification

Before writing files, define the pack spec. Prefer one local orchestrator skill plus a small number of external skills. Example minimal manifest:

```json
{
  "name": "company-research",
  "description": "Research a company and produce a summary report",
  "version": "1.0.0",
  "prompts": ["Research {company} and create a report with financials and competitors"],
  "skills": [
    { "name": "research-orchestrator", "source": "./skills/research-orchestrator", "description": "Orchestrate company research across multiple sources" }
  ]
}
```

### 4. Create the local orchestrator skill

Create `skills/<skill-name>/SKILL.md` with frontmatter and imperative workflow instructions:

```yaml
---
name: research-orchestrator
description: "Orchestrate multi-source company research. Use when the user wants a structured company report covering financials, competitors, and market position."
---
```

- Write the stable workflow as imperative steps in the body.
- Add `scripts/` only for fragile or repeated operations; add `references/` only for detailed information.

### 5. Materialize the pack

Use `scripts/scaffold_skillpack.py` when you have the pack spec:

```bash
# Basic
python3 skills/skillpack-creator/scripts/scaffold_skillpack.py \
  --manifest /tmp/skillpack.json \
  --output /absolute/path/to/output-pack

# With zip
python3 skills/skillpack-creator/scripts/scaffold_skillpack.py \
  --manifest /tmp/skillpack.json \
  --output /absolute/path/to/output-pack \
  --zip
```

The script validates the manifest, writes `skillpack.json`, creates `skills/`, copies `start.sh`/`start.bat` from `templates/`, and optionally runs `npx -y @cremini/skillpack zip`.

### 6. Validate the result

Before handing the pack back, confirm:

- The manifest matches the intended pack scope
- Every declared skill has a valid `name`, `source`, and `description`
- Local skills are present under the target pack's `skills/`
- Starter prompts are concrete enough to reproduce the workflow
- Zip only after the pack runs as a directory

## Output Standard

Produce:

1. A short summary of the stabilized workflow.
2. The target pack structure and skill inventory.
3. The created or updated local skill files.
4. The generated `skillpack.json`.
5. Whether the pack was zipped and where the zip lives.
