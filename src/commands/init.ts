import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import { bundle } from "../core/bundler.js";
import {
  configExists,
  PACK_FILE,
  saveConfig,
  type PackConfig,
} from "../core/pack-config.js";
import { installPendingSkills } from "../core/skill-manager.js";

export interface InitCommandOptions {
  config: string;
  bundle?: boolean;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateConfigShape(
  value: unknown,
  source: string,
): asserts value is PackConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid config from ${source}: expected a JSON object`);
  }

  const config = value as Record<string, unknown>;

  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new Error(`Invalid config from ${source}: "name" is required`);
  }

  if (typeof config.description !== "string") {
    throw new Error(`Invalid config from ${source}: "description" must be a string`);
  }

  if (typeof config.version !== "string") {
    throw new Error(`Invalid config from ${source}: "version" must be a string`);
  }

  if (!Array.isArray(config.prompts) || !config.prompts.every((p) => typeof p === "string")) {
    throw new Error(`Invalid config from ${source}: "prompts" must be a string array`);
  }

  if (!Array.isArray(config.skills)) {
    throw new Error(`Invalid config from ${source}: "skills" must be an array`);
  }
}

async function readConfigSource(source: string): Promise<PackConfig> {
  let raw = "";

  if (isHttpUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download config: ${response.status} ${response.statusText}`);
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

export async function initCommand(
  directory: string | undefined,
  options: InitCommandOptions,
): Promise<void> {
  const workDir = directory ? path.resolve(directory) : process.cwd();

  if (directory) {
    fs.mkdirSync(workDir, { recursive: true });
  }

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

  const config = await readConfigSource(options.config);
  saveConfig(workDir, config);

  console.log(chalk.blue(`\n  Initialize ${config.name} from ${options.config}\n`));

  await installPendingSkills(workDir, config);

  if (options.bundle) {
    await bundle(workDir);
  }

  console.log(chalk.green(`\n  ${PACK_FILE} saved\n`));
  console.log(chalk.green("  Initialization complete.\n"));

  if (!options.bundle) {
    console.log(
      chalk.dim("  Run npx @cremini/skillpack build to create the zip when needed\n"),
    );
  }
}
