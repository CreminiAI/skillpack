import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import {
  PACK_FILE,
  configExists,
  createDefaultConfig,
  saveConfig,
  validateConfigShape,
  type SkillEntry,
  type PackConfig,
} from "../pack-config.js";
import { zipCommand } from "./zip.js";
import {
  installConfiguredSkills,
  refreshDescriptionsAndSave,
  upsertSkills,
} from "../skill-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSkillNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizeSourceInput(value: string): string {
  return value.trim().replace(/^npx\s+skills\s+add\s+/u, "");
}

function parseSourceInput(value: string): {
  source: string;
  inlineSkillNames: string[];
} {
  const trimmedValue = normalizeSourceInput(value);
  const skillFlagIndex = trimmedValue.indexOf(" --skill ");

  if (skillFlagIndex === -1) {
    return {
      source: trimmedValue,
      inlineSkillNames: [],
    };
  }

  const source = trimmedValue.slice(0, skillFlagIndex).trim();
  const inlineSkillValue = trimmedValue
    .slice(skillFlagIndex + " --skill ".length)
    .trim();

  return {
    source,
    inlineSkillNames: inlineSkillValue
      .split(/[,\s]+/)
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readConfigSource(source: string): Promise<PackConfig> {
  let raw = "";

  if (isHttpUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to download config: ${response.status} ${response.statusText}`,
      );
    }
    raw = await response.text();
  } else {
    const filePath = path.resolve(source);
    raw = fs.readFileSync(filePath, "utf-8");
  }

  const parsed = JSON.parse(raw) as unknown;
  validateConfigShape(parsed, source);
  return parsed;
}

/**
 * Copy templates/start.sh and templates/start.bat to workDir.
 */
function copyStartTemplates(workDir: string): void {
  const templateDir = path.resolve(
    new URL("../templates", import.meta.url).pathname,
  );

  for (const file of ["start.sh", "start.bat"]) {
    const src = path.join(templateDir, file);
    const dest = path.join(workDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      if (file === "start.sh") {
        fs.chmodSync(dest, 0o755);
      }
    } else {
      console.warn(chalk.yellow(`  [warn] Template not found: ${src}`));
    }
  }
}

// ---------------------------------------------------------------------------
// create command
// ---------------------------------------------------------------------------

export interface CreateCommandOptions {
  config?: string;
}

export async function createCommand(
  directory?: string,
  options: CreateCommandOptions = {},
): Promise<void> {
  const workDir = directory ? path.resolve(directory) : process.cwd();

  if (directory) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  // --config mode: initialize from remote/local skillpack.json
  if (options.config) {
    await initFromConfig(workDir, options.config);
    return;
  }

  // Interactive creation mode
  await interactiveCreate(workDir);
}

// ---------------------------------------------------------------------------
// --config mode (formerly init command)
// ---------------------------------------------------------------------------

async function initFromConfig(workDir: string, configSource: string): Promise<void> {
  if (configExists(workDir)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: `A ${PACK_FILE} file already exists in this directory. Overwrite it?`,
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log(chalk.yellow("Cancelled"));
      return;
    }
  }

  const config = await readConfigSource(configSource);
  saveConfig(workDir, config);

  console.log(chalk.blue(`\n  Initialize ${config.name} from ${configSource}\n`));

  installConfiguredSkills(workDir, config);
  refreshDescriptionsAndSave(workDir, config);
  copyStartTemplates(workDir);

  console.log(chalk.green(`\n  ${PACK_FILE} saved`));
  console.log(chalk.green(`  start.sh / start.bat created`));
  console.log(chalk.green(`  Initialization complete.\n`));
  console.log(chalk.dim(`  Run npx @cremini/skillpack run . to start\n`));
}

// ---------------------------------------------------------------------------
// Interactive creation mode
// ---------------------------------------------------------------------------

async function interactiveCreate(workDir: string): Promise<void> {
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
  console.log(
    chalk.dim("  Example inline skill: vercel-labs/agent-skills --skill find-skills"),
  );
  console.log();

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

    const parsedSource = parseSourceInput(source);
    let skillNames = parsedSource.inlineSkillNames;

    if (skillNames.length === 0) {
      console.log(
        chalk.dim("  Example skill names: frontend-design, skill-creator"),
      );
      const promptResult = await inquirer.prompt([
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
      skillNames = parseSkillNames(promptResult.skillNames);
    }

    const nextSkills = skillNames.map((skillName) => ({
      source: parsedSource.source,
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
          ? `Prompt #${promptIndex} (leave blank to skip):`
          : `Prompt #${promptIndex} (leave blank to finish):`,
      },
    ]);

    if (!prompt.trim()) {
      break;
    }

    config.prompts.push(prompt.trim());
    promptIndex++;
  }

  const { shouldZip } = await inquirer.prompt([
    {
      type: "confirm",
      name: "shouldZip",
      message: "Package as a zip now?",
      default: true,
    },
  ]);

  saveConfig(workDir, config);
  copyStartTemplates(workDir);
  console.log(chalk.green(`\n  ${PACK_FILE} saved`));
  console.log(chalk.green(`  start.sh / start.bat created\n`));

  if (requestedSkills.length > 0) {
    installConfiguredSkills(workDir, config);
    refreshDescriptionsAndSave(workDir, config);
  }

  if (shouldZip) {
    await zipCommand(workDir);
  }

  console.log(chalk.green("\n  Done!"));
  if (!shouldZip) {
    console.log(
      chalk.dim(
        "  Run npx @cremini/skillpack run . to start\n" +
        "  Run npx @cremini/skillpack zip to create the zip\n",
      ),
    );
  }
}
