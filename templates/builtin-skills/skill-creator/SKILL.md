---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

Create new skills and iteratively improve them inside this SkillPack. Determine where the user is in the create → draft → test → improve cycle and help them move forward.

## Pack-specific rules

All skills live under `{{SKILLS_PATH}}/<skill-name>/SKILL.md` and config is at `{{PACK_CONFIG_PATH}}`. These paths override any generic advice. Never create skills in the current workspace directory — always use `{{SKILLS_PATH}}`.

## Creating a skill

### Capture intent

Extract answers from the current conversation first, then fill gaps with targeted questions. Confirm before writing the first draft:

1. What should this skill enable the model to do?
2. When should this skill trigger?
3. What output should it produce?
4. Does the user want a lightweight draft, or a tested and iterated skill?

Clarify edge cases, input/output formats, success criteria, and dependencies as needed before writing test prompts.

### Write the skill

Create the skill at `{{SKILLS_PATH}}/<skill-name>/SKILL.md`. Example template:

```yaml
---
name: example-skill
description: "Analyze competitor pricing pages and generate a comparison matrix. Use when the user wants to benchmark pricing tiers, feature gaps, or positioning against specific competitors."
---

# Example Skill

## Workflow

1. Collect the target URLs from the user.
2. Extract pricing tiers, features, and limits from each page.
3. Generate a comparison matrix as a markdown table.

## Output

Return a markdown table with one column per competitor and one row per feature.
```

The `description` is the primary triggering mechanism — make it concrete with both what the skill does and when to use it. Keep the body focused on workflow, decisions, and output expectations. Place deterministic helpers under `scripts/` and long reference material under `references/`.

Preserve the existing skill name when improving unless the user explicitly requests a rename.

### Sync skillpack.json

After creating or updating a skill, sync `{{PACK_CONFIG_PATH}}`. Read the final `SKILL.md`, parse the YAML frontmatter, and upsert into the `skills` array:

```json
{
  "name": "<frontmatter.name>",
  "description": "<frontmatter.description>",
  "source": "./skills/<frontmatter.name>"
}
```

All three fields must come from frontmatter — do not guess from memory. Update existing entries instead of creating duplicates.

### Writing guide

Prefer imperative instructions. Structure skills as: purpose, trigger guidance, required inputs, step-by-step workflow, output format, edge cases. For multi-domain skills, organize references by variant and tell the model how to choose.

## Test and iterate

After drafting the skill, propose 2–3 realistic test prompts phrased as a real user would.

If the user wants evaluation, run the prompts, compare outputs against expectations, note failures, and revise. Otherwise, do at least a lightweight sanity check before calling the skill complete.

## Improving an existing skill

When updating an existing skill:

- preserve its canonical `name` unless the user explicitly asks to rename it
- keep the directory aligned with the canonical skill name
- update `SKILL.md` first
- then re-read the final frontmatter and sync `{{PACK_CONFIG_PATH}}`

Focus on general improvements rather than overfitting to one example. Keep the prompt lean and remove instructions that are not earning their place.

## Completion checklist

Before you say the work is done, verify all of the following:

- the skill exists under `{{SKILLS_PATH}}/<skill-name>/SKILL.md`
- `SKILL.md` has `name` and `description` frontmatter
- `{{PACK_CONFIG_PATH}}` has a matching entry in `skills`
- the `source` field is `./skills/<skill-name>`
- you have either tested the skill or explicitly told the user what remains untested
