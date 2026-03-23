import { Command } from "commander";
import chalk from "chalk";
import { createCommand } from "./commands/create.js";
import { runCommand } from "./commands/run.js";
import { zipCommand } from "./commands/zip.js";
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
  .option("--config <path-or-url>", "Initialize from a local or remote skillpack.json")
  .action(async (directory?: string, options?: { config?: string }) => {
    await createCommand(directory, options);
  });

// run command
program
  .command("run [directory]")
  .description("Start the SkillPack runtime server")
  .option("--port <port>", "Port to listen on")
  .option("--host <host>", "Host to bind to")
  .action(async (directory?: string, options?: { port?: string; host?: string }) => {
    if (options?.port) process.env.PORT = options.port;
    if (options?.host) process.env.HOST = options.host;
    await runCommand(directory);
  });

// zip command
program
  .command("zip")
  .description("Package the current pack as a zip file (skillpack.json + skills/ + start scripts)")
  .action(async () => {
    try {
      await zipCommand(process.cwd());
    } catch (err) {
      console.error(chalk.red(`Packaging failed: ${err}`));
      process.exit(1);
    }
  });

program.parse();
