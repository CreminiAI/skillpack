import path from "node:path";
import fs from "node:fs";
import inquirer from "inquirer";
import chalk from "chalk";
import {
  configExists,
  createDefaultConfig,
  loadConfig,
  saveConfig,
} from "../pack-config.js";
import { installSkills, scanInstalledSkills,  syncSkillDescriptions, } from "../skill-manager.js";
import { startServer } from "../runtime/server.js";
import type { SkillEntry } from "../pack-config.js";

/**
 * Find remote skills declared in config but not yet installed in skills/.
 * Local sources (./skills/...) are skipped.
 */
function findMissingSkills(workDir: string, config: ReturnType<typeof loadConfig>): SkillEntry[] {
  const installed = scanInstalledSkills(workDir);
  const installedNames = new Set(
    installed.map((s) => s.name.trim().toLowerCase()),
  );

  return config.skills.filter((skill) => {
    // Skip local source references
    if (skill.source.startsWith("./skills")) return false;
    return !installedNames.has(skill.name.trim().toLowerCase());
  });
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
    }
  }
}

export async function runCommand(directory?: string): Promise<void> {
  const workDir = directory ? path.resolve(directory) : process.cwd();

  // Ensure workDir exists
  fs.mkdirSync(workDir, { recursive: true });

  // No skillpack.json → quickly prompt and create one
  if (!configExists(workDir)) {
    console.log(chalk.blue("\n  No skillpack.json found. Let's set one up.\n"));

    const { name, description } = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "App name:",
        validate: (v: string) => v.trim() ? true : "Name is required",
      },
      {
        type: "input",
        name: "description",
        message: "Description:",
        default: "A skill App, powered by SkillPack.sh",
      },
    ]);

    const config = createDefaultConfig(name.trim(), description.trim());
    saveConfig(workDir, config);
    copyStartTemplates(workDir);
    console.log(chalk.green(`\n  skillpack.json created\n`));
  }

  const config = loadConfig(workDir);

  // Auto-install missing remote skills
  const missing = findMissingSkills(workDir, config);
  if (missing.length > 0) {
    console.log(chalk.blue(`\n  Installing ${missing.length} missing skill(s)...\n`));
    try {
      installSkills(workDir, missing);
    } catch (err) {
      console.warn(chalk.yellow(`  Warning: Some skills could not be installed: ${err}`));
    }
  }
  syncSkillDescriptions(workDir, config);
  saveConfig(workDir, config);

  // Start the runtime server
  await startServer({
    rootDir: workDir,
    daemonRun: process.env.DAEMON_RUN === "1",
  });
}
