import fs from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import { bundle } from "../core/bundler.js";
import {
  configExists,
  PACK_FILE,
  saveConfig,
  validateConfigShape,
  type PackConfig,
} from "../core/pack-config.js";
import {
  installConfiguredSkills,
  refreshDescriptionsAndSave,
} from "../core/skill-manager.js";
import {
  copyRuntimeTemplate,
  ensureRuntimeLaunchersExecutable,
  getRuntimeDir,
} from "../core/runtime-template.js";

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

  installConfiguredSkills(workDir, config);
  refreshDescriptionsAndSave(workDir, config);
  copyRuntimeTemplate(getRuntimeDir(), workDir);
  ensureRuntimeLaunchersExecutable(workDir);

  if (options.bundle) {
    await bundle(workDir);
  }

  console.log(chalk.green(`\n  ${PACK_FILE} saved\n`));
  console.log(chalk.green("  Runtime template expanded.\n"));
  console.log(chalk.green("  Initialization complete.\n"));

  if (!options.bundle) {
    console.log(
      chalk.dim("  Run npx @cremini/skillpack build to create the zip when needed\n"),
    );
  }
}
