---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

A skill for creating new skills and iteratively improving them inside this SkillPack.

At a high level, the process of creating a skill goes like this:

- Decide what the skill should do and when it should trigger.
- Write a draft of the skill.
- Create a few realistic test prompts.
- Run the tests, review the results with the user, and improve the skill.
- Repeat until the skill is good enough for the user's needs.

Your job when using this skill is to figure out where the user is in this process and help them move forward without overcomplicating things.

## Communicating with the user

Adjust your language to the user's level of familiarity. Avoid unnecessary jargon. Briefly explain terms like "frontmatter", "assertion", or "benchmark" if the user does not appear comfortable with them.

If the user clearly wants a lightweight collaboration rather than a full evaluation loop, keep things simple and iterate directly with them.

## Pack-specific rules

This SkillPack uses a fixed project-level skills directory and config file:

- Skills directory: `{{SKILLS_PATH}}`
- SkillPack config: `{{PACK_CONFIG_PATH}}`

These paths override any generic advice you may know from other environments.

When creating or updating skills in this SkillPack:

- Always place the skill under `{{SKILLS_PATH}}/<skill-name>/`.
- Always write the main skill file to `{{SKILLS_PATH}}/<skill-name>/SKILL.md`.
- Treat `skill-name` as the canonical directory name unless the user explicitly asks to preserve an existing directory layout.
- Never create new skills inside the current workspace directory just because the active cwd is elsewhere.

## Creating a skill

### Capture intent

Start by understanding the user's intent. The current conversation may already contain the workflow the user wants to capture. Extract answers from the conversation first, then fill the gaps with targeted questions.

Confirm these points before writing the first draft:

1. What should this skill enable the model to do?
2. When should this skill trigger?
3. What output should it produce?
4. Does the user want a lightweight draft, or a tested and iterated skill?

### Interview and research

Ask about:

- edge cases
- input/output formats
- example prompts or files
- success criteria
- dependencies or required tools

Wait to write test prompts until these basics are clear enough.

### Write the skill

Create the skill directory at `{{SKILLS_PATH}}/<skill-name>/`.

Create `SKILL.md` with YAML frontmatter. The frontmatter must include:

- `name`
- `description`

The `description` is the primary triggering mechanism. Make it concrete and slightly "pushy": include both what the skill does and the situations where it should be used.

Keep the skill practical:

- Put "when to use" information in the `description`, not buried in the body.
- Keep the body focused on the workflow, decisions, and output expectations.
- If the skill needs deterministic helpers, place them under `scripts/`.
- If the skill needs long reference material, place it under `references/` and tell the model when to read it.

### Required save location

For a newly created skill named `example-skill`, the target layout must be:

```text
{{SKILLS_PATH}}/example-skill/
{{SKILLS_PATH}}/example-skill/SKILL.md
```

If the user is improving an existing skill, preserve the existing skill name unless they explicitly request a rename.

### Update skillpack.json

After you create or update a skill, you must sync `{{PACK_CONFIG_PATH}}`.

Do not guess the metadata from memory. Instead:

1. Read the final `SKILL.md`.
2. Parse the YAML frontmatter.
3. Extract:
   - `name`
   - `description`
4. Upsert an entry into the `skills` array in `{{PACK_CONFIG_PATH}}`:

```json
{
  "name": "<frontmatter.name>",
  "description": "<frontmatter.description>",
  "source": "./skills/<frontmatter.name>"
}
```

Rules for this update:

- `name` must come from `frontmatter.name`.
- `description` must come from `frontmatter.description`.
- `source` must be `./skills/<frontmatter.name>`.
- If an entry for the same skill already exists, update it instead of creating a duplicate.

### Writing guide

Prefer imperative, clear instructions. Explain why important constraints exist. Avoid overly rigid language unless strict behavior is actually required.

Useful structure:

- purpose
- trigger guidance
- required inputs
- step-by-step workflow
- output format
- edge cases

If the skill supports multiple domains or frameworks, organize the references by variant and tell the model how to choose the right one.

## Test and iterate

After drafting the skill, propose 2-3 realistic test prompts. The prompts should sound like something a real user would actually say.

If the user wants evaluation:

- run the test prompts with the skill
- compare the outputs against the user's expectations
- note what worked and what failed
- revise the skill

If the user does not want a heavy evaluation loop, do at least a lightweight sanity check before calling the skill complete.

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
