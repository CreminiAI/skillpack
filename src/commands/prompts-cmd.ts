import { Command } from "commander";
import chalk from "chalk";
import { addPrompt, removePrompt, listPrompts } from "../core/prompts.js";

export function registerPromptsCommand(program: Command): void {
  const prompts = program.command("prompts").description("Manage prompts");

  prompts
    .command("add <text>")
    .description("Add a prompt")
    .action((text: string) => {
      addPrompt(process.cwd(), text);
    });

  prompts
    .command("remove <index>")
    .description("Remove a prompt by number, starting from 1")
    .action((index: string) => {
      const num = parseInt(index, 10);
      if (isNaN(num)) {
        console.log(chalk.red("Enter a valid numeric index"));
        return;
      }
      removePrompt(process.cwd(), num);
    });

  prompts
    .command("list")
    .description("List all prompts")
    .action(() => {
      const prompts = listPrompts(process.cwd());
      if (prompts.length === 0) {
        console.log(chalk.dim("  No prompts yet"));
        return;
      }
      console.log(chalk.blue("\n  Prompts:\n"));
      prompts.forEach((u, i) => {
        const marker = i === 0 ? chalk.green("★") : chalk.dim("●");
        const label = i === 0 ? chalk.dim(" (default)") : "";
        const display = u.length > 80 ? u.substring(0, 80) + "..." : u;
        console.log(`  ${marker} #${i + 1}${label} ${display}`);
      });
      console.log();
    });
}
