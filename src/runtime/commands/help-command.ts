import fs from "node:fs";
import path from "node:path";
import { getVisibleCommands } from "./index.js";
import type { CommandResult } from "../adapters/types.js";

interface SkillConfigEntry {
  name: string;
  description?: string;
}

export function buildHelpMessage(rootDir: string): string {
  const sections: string[] = [];

  const commands = getVisibleCommands();
  const commandLines = commands.map(
    (cmd) => `• \`/${cmd.command}\` — ${cmd.description}`,
  );
  sections.push(`📋 **Available Commands**\n${commandLines.join("\n")}`);

  const configPath = path.resolve(rootDir, "skillpack.json");
  const skills = readInstalledSkills(configPath);

  if (skills.length > 0) {
    const skillLines = skills.map(
      (skill) =>
        `• **${skill.name}**${skill.description ? ` — ${skill.description}` : ""}`,
    );
    sections.push(
      `🧩 **Installed Skills** (${skills.length})\n${skillLines.join("\n")}`,
    );
  } else {
    sections.push("🧩 **Installed Skills**\nNo skills installed.");
  }

  sections.push(
    [
      "⏰ **Scheduled Tasks**",
      "You can set up recurring tasks using natural language. For example:",
      '• "Send me a daily market briefing every morning at 9 AM"',
      '• "Summarize this week\'s trading data every Friday at 6 PM"',
      '• "Check for new announcements every 30 minutes"',
      "I will handle the cron scheduling automatically.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export function handleHelpCommand(rootDir: string): CommandResult {
  return {
    success: true,
    message: buildHelpMessage(rootDir),
  };
}

function readInstalledSkills(configPath: string): SkillConfigEntry[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    return Array.isArray(config.skills) ? config.skills : [];
  } catch {
    return [];
  }
}
