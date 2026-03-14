import { Command } from "commander";
import chalk from "chalk";
import { removeSkill } from "../core/skill-manager.js";
import { loadConfig, saveConfig } from "../core/pack-config.js";

export function registerSkillsCommand(program: Command): void {
  const skills = program.command("skills").description("Manage skills in the app");

  skills
    .command("add <source>")
    .description("Add a skill from a git repo, URL, or local path")
    .option("-s, --skill <names...>", "Specify skill name(s)")
    .action(async (source: string, opts: { skill?: string[] }) => {
      const workDir = process.cwd();
      const config = loadConfig(workDir);

      config.skills.push({
        name: opts.skill ? opts.skill.join(", ") : source,
        source: source,
        description: "Pending installation",
        installSource: source,
        specificSkills: opts.skill && opts.skill.length > 0 ? opts.skill : undefined,
      });

      saveConfig(workDir, config);
      console.log(chalk.green(`Skill list updated (${config.skills.length} total). Skills will be installed during build.`));
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
