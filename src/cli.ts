import { Command } from "commander";
import chalk from "chalk";
import { createCommand } from "./commands/create.js";
import { registerSkillsCommand } from "./commands/skills-cmd.js";
import { registerPromptsCommand } from "./commands/prompts-cmd.js";
import { bundle } from "./core/bundler.js";

const program = new Command();

program
  .name("skillapp")
  .description("Assemble, package, and run Agent Skills packs")
  .version("1.0.0");

// create command
program
  .command("create [directory]")
  .description("Create a skills pack interactively")
  .action(async (directory?: string) => {
    await createCommand(directory);
  });

// skills subcommands
registerSkillsCommand(program);

// prompts subcommands
registerPromptsCommand(program);

// build command
program
  .command("build")
  .description("Package the current pack as a zip file")
  .action(async () => {
    try {
      await bundle(process.cwd());
    } catch (err) {
      console.error(chalk.red(`Packaging failed: ${err}`));
      process.exit(1);
    }
  });

program.parse();
