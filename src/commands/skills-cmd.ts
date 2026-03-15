import { Command } from "commander";
import chalk from "chalk";
import {
  installSkills,
  refreshDescriptionsAndSave,
  removeSkill,
  upsertSkills,
} from "../core/skill-manager.js";
import { loadConfig, saveConfig } from "../core/pack-config.js";

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage skills in the app");

  skills
    .command("add <source>")
    .description("Add a skill from a git repo, URL, or local path")
    .option("-s, --skill <names...>", "Specify skill name(s)")
    .action(async (source: string, opts: { skill?: string[] }) => {
      if (!opts.skill || opts.skill.length === 0) {
        console.log(
          chalk.red(
            "Specify at least one skill name with --skill when adding a source",
          ),
        );
        process.exitCode = 1;
        return;
      }

      const workDir = process.cwd();
      const config = loadConfig(workDir);
      const requestedSkills = opts.skill.map((name) => ({
        name: name.trim(),
        source,
        description: "",
      }));

      upsertSkills(config, requestedSkills);

      saveConfig(workDir, config);

      try {
        installSkills(workDir, requestedSkills);
        refreshDescriptionsAndSave(workDir, config);
      } catch (error) {
        console.log(
          chalk.red(
            `Skill installation failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`Installed ${requestedSkills.length} skill(s).`));
    });

  skills
    .command("remove <name>")
    .description("Remove a skill")
    .action((name: string) => {
      removeSkill(process.cwd(), name);
    });

  skills
    .command("list")
    .description("List installed skills")
    .action(() => {
      const config = loadConfig(process.cwd());
      if (config.skills.length === 0) {
        console.log(chalk.dim("  No skills installed"));
        return;
      }
      console.log(chalk.blue(`\n  ${config.name} Skills:\n`));
      for (const skill of config.skills) {
        console.log(`  ${chalk.green("●")} ${chalk.bold(skill.name)}`);
        if (skill.description) {
          console.log(`    ${chalk.dim(skill.description)}`);
        }
      }
      console.log();
    });
}
