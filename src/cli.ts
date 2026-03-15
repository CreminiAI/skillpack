import { Command } from "commander";
import chalk from "chalk";
import { createCommand } from "./commands/create.js";
import { initCommand } from "./commands/init.js";
import { registerSkillsCommand } from "./commands/skills-cmd.js";
import { registerPromptsCommand } from "./commands/prompts-cmd.js";
import { bundle } from "./core/bundler.js";
import fs from "node:fs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const program = new Command();

program
  .name("skillpack")
  .description("Assemble, package, and run Agent Skills packs")
  .version(packageJson.version);

// create command
program
  .command("create [directory]")
  .description("Create a skills pack interactively")
  .action(async (directory?: string) => {
    await createCommand(directory);
  });

program
  .command("init [directory]")
  .description(
    "Initialize a skills pack from a local config file or URL and expand runtime files",
  )
  .requiredOption("--config <path-or-url>", "Path or URL to a skillpack.json file")
  .option("--bundle", "Bundle as a zip after initialization")
  .action(
    async (
      directory: string | undefined,
      options: { config: string; bundle?: boolean },
    ) => {
      await initCommand(directory, options);
    },
  );

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
