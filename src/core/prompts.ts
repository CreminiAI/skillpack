import chalk from "chalk";
import { loadConfig, saveConfig } from "./pack-config.js";

/**
 * Add a prompt.
 */
export function addPrompt(workDir: string, text: string): void {
  const config = loadConfig(workDir);
  config.prompts.push(text);
  saveConfig(workDir, config);
  console.log(chalk.green(`Added Prompt #${config.prompts.length}`));
}

/**
 * Remove a prompt by index, starting from 1.
 */
export function removePrompt(workDir: string, index: number): boolean {
  const config = loadConfig(workDir);
  const idx = index - 1; // user input is 1-based
  if (idx < 0 || idx >= config.prompts.length) {
    console.log(chalk.yellow(`Invalid index: ${index} (${config.prompts.length} total)`));
    return false;
  }

  const removed = config.prompts.splice(idx, 1)[0];
  saveConfig(workDir, config);
  console.log(chalk.green(`Removed Prompt #${index}: "${removed.substring(0, 50)}..."`));
  return true;
}

/**
 * List all prompts.
 */
export function listPrompts(workDir: string): string[] {
  const config = loadConfig(workDir);
  return config.prompts;
}
