import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import {
  PACK_FILE,
  configExists,
  createDefaultConfig,
  saveConfig,
  type SkillEntry,
} from "../core/pack-config.js";
import { bundle } from "../core/bundler.js";
import {
  installConfiguredSkills,
  refreshDescriptionsAndSave,
  upsertSkills,
} from "../core/skill-manager.js";

function parseSkillNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export async function createCommand(directory?: string): Promise<void> {
  const workDir = directory ? path.resolve(directory) : process.cwd();

  if (directory) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  if (configExists(workDir)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: `Overwrite the existing ${PACK_FILE}?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.yellow("Cancelled"));
      return;
    }
  }

  console.log(chalk.blue("\n  Create a new Skill App\n"));

  const { name, description } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "App name:",
      validate: (value: string) => (value.trim() ? true : "Name is required"),
    },
    {
      type: "input",
      name: "description",
      message: "Description:",
      default: "A skill App, powered by SkillPack.sh",
    },
  ]);

  const config = createDefaultConfig(name.trim(), description.trim());
  const requestedSkills: SkillEntry[] = [];

  console.log(
    chalk.blue("\n  Add Skills (enter a skill source, leave blank to skip)\n"),
  );
  console.log(
    chalk.dim("  Supported formats: owner/repo, GitHub URL, or local path"),
  );
  console.log(chalk.dim("  Example source: vercel-labs/agent-skills"));
  console.log(chalk.dim("  Example skill names: frontend-design, skill-creator\n"));

  while (true) {
    const { source } = await inquirer.prompt([
      {
        type: "input",
        name: "source",
        message: "Skill source (leave blank to skip):",
      },
    ]);

    if (!source.trim()) {
      break;
    }

    const { skillNames } = await inquirer.prompt([
      {
        type: "input",
        name: "skillNames",
        message: "Skill names (comma-separated):",
        validate: (value: string) =>
          parseSkillNames(value).length > 0
            ? true
            : "Enter at least one skill name",
      },
    ]);

    const nextSkills = parseSkillNames(skillNames).map((skillName) => ({
      source: source.trim(),
      name: skillName,
      description: "",
    }));

    upsertSkills(config, nextSkills);
    requestedSkills.push(...nextSkills);
  }

  console.log(chalk.blue("\n  Add Prompts\n"));
  console.log(
    chalk.blue(
      "Use prompts to explain how the pack should orchestrate the selected skills\n",
    ),
  );

  let promptIndex = 1;
  while (true) {
    const isFirst = promptIndex === 1;
    const { prompt } = await inquirer.prompt([
      {
        type: "input",
        name: "prompt",
        message: isFirst
          ? `Prompt #${promptIndex} (required):`
          : `Prompt #${promptIndex} (leave blank to finish):`,
        validate: isFirst
          ? (value: string) =>
              value.trim() ? true : "The first Prompt cannot be empty"
          : undefined,
      },
    ]);

    if (!isFirst && !prompt.trim()) {
      break;
    }

    config.prompts.push(prompt.trim());
    promptIndex++;
  }

  const { shouldBundle } = await inquirer.prompt([
    {
      type: "confirm",
      name: "shouldBundle",
      message: "Bundle as a zip now?",
      default: true,
    },
  ]);

  saveConfig(workDir, config);
  console.log(chalk.green(`\n  ${PACK_FILE} saved\n`));

  if (requestedSkills.length > 0) {
    installConfiguredSkills(workDir, config);
    refreshDescriptionsAndSave(workDir, config);
  }

  if (shouldBundle) {
    await bundle(workDir);
  }

  console.log(chalk.green("\n  Done!"));
  if (!shouldBundle) {
    console.log(
      chalk.dim("  Run npx @cremini/skillpack build to create the zip\n"),
    );
  }
}
