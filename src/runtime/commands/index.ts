import type { BotCommand } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Command Definition
// ---------------------------------------------------------------------------

export interface CommandDefinition {
  /** Internal command identifier */
  command: BotCommand;
  /** User-facing description */
  description: string;
  /** Whether to show in /help output */
  visibleInHelp: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Unified command registry — single source of truth for all bot commands.
 * Order here determines display order in /help output.
 */
export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    command: "help",
    description: "Show available commands, skills, and usage tips",
    visibleInHelp: true,
  },
  {
    command: "clear",
    description: "Clear current session and start fresh",
    visibleInHelp: true,
  },
  {
    command: "restart",
    description: "Restart the server process",
    visibleInHelp: true,
  },
  {
    command: "shutdown",
    description: "Shut down the server process",
    visibleInHelp: true,
  },
  // "new" is a hidden alias for "clear" — not shown in /help
  {
    command: "new",
    description: "Start a new session (alias for /clear)",
    visibleInHelp: false,
  },
];

// ---------------------------------------------------------------------------
// Alias mapping – maps user input strings to BotCommand
// ---------------------------------------------------------------------------

const COMMAND_ALIASES: Record<string, BotCommand> = {
  "/help": "help",
  "/clear": "clear",
  "/new": "clear",
  "/restart": "restart",
  "/shutdown": "shutdown",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a user input string (e.g. "/clear", "/new") into a BotCommand.
 * Returns null if the input is not a recognized command.
 */
export function resolveCommand(input: string): BotCommand | null {
  const key = input.split(/\s/)[0].toLowerCase();
  return COMMAND_ALIASES[key] ?? null;
}

/**
 * Get commands that should appear in /help output.
 */
export function getVisibleCommands(): CommandDefinition[] {
  return COMMAND_REGISTRY.filter((cmd) => cmd.visibleInHelp);
}

/**
 * Generate the command list for Telegram's Bot.setMyCommands().
 * Only includes visible commands.
 */
export function getTelegramBotCommands(): Array<{
  command: string;
  description: string;
}> {
  return COMMAND_REGISTRY.filter((cmd) => cmd.visibleInHelp).map((cmd) => ({
    command: cmd.command,
    description: cmd.description,
  }));
}
