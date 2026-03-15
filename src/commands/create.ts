import inquirer from "inquirer";
import chalk from "chalk";
import {
  createDefaultConfig,
  saveConfig,
  configExists,
} from "../core/pack-config.js";
import { scanInstalledSkills } from "../core/skill-manager.js";
import { bundle } from "../core/bundler.js";
import fs from "node:fs";
import path from "node:path";

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
        message:
          "An app.json file already exists in this directory. Overwrite it?",
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.yellow("Cancelled"));
      return;
    }
  }

  console.log(chalk.blue("\n  Create a new Skill App\n"));

  // Step 1: Basic information
  const { name, description } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "App name:",
      validate: (v: string) => (v.trim() ? true : "Name is required"),
    },
    {
      type: "input",
      name: "description",
      message: "Description:",
      default: "A skill App, powered by SkillPack.sh",
    },
  ]);

  const config = createDefaultConfig(name.trim(), description.trim());

  // Step 2: Add skills
  console.log(
    chalk.blue("\n  Add Skills (enter a skill source, leave blank to skip)\n"),
  );
  console.log(
    chalk.dim(
      "  Supported formats: owner/repo, GitHub URL, local path, or a full npx skills add command",
    ),
  );
  console.log(chalk.dim("  Example: vercel-labs/agent-skills"));
  console.log(
    chalk.dim(
      "  Example: npx skills add https://github.com/vercel-labs/skills --skill find-skillsclear\n",
    ),
  );

  while (true) {
    const { source } = await inquirer.prompt([
      {
        type: "input",
        name: "source",
        message: "Skill source (leave blank to skip):",
      },
    ]);

    if (!source.trim()) break;

    let parsedSource = source.trim();
    let parsedSpecificSkill: string | undefined;

    // Handle format like `... --skill <name>`
    const skillMatch = parsedSource.match(/(.*?)\s+--skill\s+([^\s]+)(.*)/);
    if (skillMatch) {
      parsedSpecificSkill = skillMatch[2];
      parsedSource = `${skillMatch[1]} ${skillMatch[3]}`.trim();
    }

    // Handle `npx <cli> add <source>`
    const npxMatch = parsedSource.match(/^npx\s+[^\s]+\s+add\s+(.+)$/);
    if (npxMatch) {
      parsedSource = npxMatch[1].trim();
    }

    if (!parsedSource) continue;

    let specificSkill = parsedSpecificSkill;

    if (specificSkill !== undefined) {
      console.log(chalk.dim(`  Auto-detected skill source: ${parsedSource}`));
      console.log(
        chalk.dim(`  Auto-detected specific skill: ${specificSkill}`),
      );
    } else {
      if (parsedSource !== source.trim()) {
        console.log(chalk.dim(`  Auto-detected skill source: ${parsedSource}`));
      }

      // Ask whether to install a specific skill
      const answer = await inquirer.prompt([
        {
          type: "input",
          name: "specificSkill",
          message: "Specific skill name (leave blank to install all):",
        },
      ]);
      specificSkill = answer.specificSkill;
    }

    const skillNames =
      specificSkill && specificSkill.trim()
        ? [specificSkill.trim()]
        : undefined;

    config.skills.push({
      name: skillNames ? skillNames.join(", ") : parsedSource,
      source: parsedSource,
      description: "Pending installation",
      installSource: parsedSource,
      specificSkills: skillNames,
    });
  }

  // Step 3: Prompt
  console.log(chalk.blue("\n  Add Prompts\n"));
  console.log(
    chalk.blue(
      "Use a prompt to explain how you will organize the skills you added to complete the task\n",
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
          ? (v: string) =>
            v.trim() ? true : "The first Prompt cannot be empty"
          : undefined,
      },
    ]);

    if (!isFirst && !prompt.trim()) break;

    config.prompts.push(prompt.trim());
    promptIndex++;
  }

  // Save config
  saveConfig(workDir, config);
  console.log(chalk.green("\n  app.json saved\n"));

  // Ask whether to bundle immediately
  const { shouldBundle } = await inquirer.prompt([
    {
      type: "confirm",
      name: "shouldBundle",
      message: "Bundle as a zip now?",
      default: true,
    },
  ]);

  if (shouldBundle) {
    await bundle(workDir);
  }

  console.log(chalk.green("\n  Done!"));
  if (!shouldBundle) {
    console.log(chalk.dim("  Run npx skillpack build to create the zip\n"));
  }
}
