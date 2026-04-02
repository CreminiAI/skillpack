import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  loadConfig,
  saveConfig,
  type PackConfig,
  type SkillEntry,
} from "./pack-config.js";

const SKILLS_DIR = "skills";

interface InstalledSkill {
  name: string;
  description: string;
  dir: string;
}

interface InstallGroup {
  source: string;
  names: string[];
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function getSkillsDir(workDir: string): string {
  return path.join(workDir, SKILLS_DIR);
}

function groupSkillsBySource(skills: SkillEntry[]): InstallGroup[] {
  const groups = new Map<string, string[]>();

  for (const skill of skills) {
    const source = skill.source.trim();
    const name = skill.name.trim();
    const names = groups.get(source) ?? [];

    if (!names.some((entry) => normalizeName(entry) === normalizeName(name))) {
      names.push(name);
    }

    groups.set(source, names);
  }

  return Array.from(groups, ([source, names]) => ({ source, names }));
}

function buildInstallArgs(group: InstallGroup): string[] {
  const args = [
    "-y",
    "skills",
    "add",
    group.source,
    "--agent",
    "openclaw",
    "--copy",
    "-y",
  ];

  for (const name of group.names) {
    args.push("--skill", name);
  }

  return args;
}

export function installSkills(workDir: string, skills: SkillEntry[]): void {
  if (skills.length === 0) {
    return;
  }

  for (const group of groupSkillsBySource(skills)) {
    const args = buildInstallArgs(group);
    const displayArgs = args
      .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
      .join(" ");

    console.log(chalk.dim(`> npx ${displayArgs}`));

    const result = spawnSync("npx", args, {
      cwd: workDir,
      stdio: "inherit",
      encoding: "utf-8",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(
        `Failed to install skills from ${group.source} (exit code ${result.status ?? "unknown"})`,
      );
    }
  }
}

export function scanInstalledSkills(workDir: string): InstalledSkill[] {
  const installed: InstalledSkill[] = [];
  const skillsDir = getSkillsDir(workDir);

  if (!fs.existsSync(skillsDir)) {
    return installed;
  }

  function visit(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (entry.name !== "SKILL.md") {
        continue;
      }

      const skill = parseSkillMd(fullPath);
      if (skill) {
        installed.push(skill);
      }
    }
  }

  visit(skillsDir);
  return installed;
}

function parseSkillMd(filePath: string): InstalledSkill | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const name = readFrontmatterField(frontmatter, "name");
    if (!name) {
      return null;
    }

    return {
      name,
      description: readFrontmatterField(frontmatter, "description") ?? "",
      dir: path.dirname(filePath),
    };
  } catch {
    return null;
  }
}

function readFrontmatterField(frontmatter: string, field: string): string | null {
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match || match[1] !== field) {
      continue;
    }

    const rawValue = (match[2] ?? "").trim();
    if (isBlockScalar(rawValue)) {
      const [value] = readBlockScalar(lines, index + 1, rawValue);
      return value;
    }

    if (rawValue === "") {
      const [value] = readIndentedScalar(lines, index + 1);
      return value;
    }

    return stripWrappingQuotes(rawValue);
  }

  return null;
}

function isBlockScalar(value: string): boolean {
  return /^[>|][0-9+-]*$/.test(value);
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  marker: string,
): [string, number] {
  const blockLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      blockLines.push("");
      index += 1;
      continue;
    }

    if (!/^\s/.test(line)) {
      break;
    }

    blockLines.push(line);
    index += 1;
  }

  const normalized = normalizeBlockIndent(blockLines);
  const style = marker[0];
  const chomp = marker.includes("-") ? "strip" : marker.includes("+") ? "keep" : "clip";
  const value =
    style === ">"
      ? foldBlockScalar(normalized)
      : normalized.join("\n");

  return [applyChomp(value, chomp), index];
}

function readIndentedScalar(lines: string[], startIndex: number): [string, number] {
  const blockLines: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      blockLines.push("");
      index += 1;
      continue;
    }

    if (!/^\s/.test(line)) {
      break;
    }

    blockLines.push(line);
    index += 1;
  }

  return [foldBlockScalar(normalizeBlockIndent(blockLines)), index];
}

function normalizeBlockIndent(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^[ \t]*/)![0].length);

  const trimLength = indents.length > 0 ? Math.min(...indents) : 0;

  return lines.map((line) => line.slice(trimLength));
}

function foldBlockScalar(lines: string[]): string {
  let result = "";
  let previousBlank = false;

  for (const line of lines) {
    const isBlank = line.trim() === "";

    if (isBlank) {
      result += "\n";
      previousBlank = true;
      continue;
    }

    if (result !== "" && !previousBlank) {
      result += " ";
    }

    result += line;
    previousBlank = false;
  }

  return result;
}

function applyChomp(value: string, mode: "strip" | "clip" | "keep"): string {
  if (mode === "keep") {
    return value;
  }

  if (mode === "strip") {
    return value.replace(/\n+$/g, "");
  }

  return value.replace(/\n*$/g, "");
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function syncSkillDescriptions(
  workDir: string,
  config: PackConfig,
): PackConfig {
  const descriptionByName = new Map<string, string>();

  for (const skill of scanInstalledSkills(workDir)) {
    descriptionByName.set(normalizeName(skill.name), skill.description);
  }

  config.skills = config.skills.map((skill) => {
    const description = descriptionByName.get(normalizeName(skill.name));
    return description === undefined ? skill : { ...skill, description };
  });

  return config;
}

export function upsertSkills(
  config: PackConfig,
  skills: SkillEntry[],
): PackConfig {
  for (const skill of skills) {
    const normalizedName = normalizeName(skill.name);
    const normalizedSource = skill.source.trim();
    const existing = config.skills.find(
      (entry) => normalizeName(entry.name) === normalizedName,
    );

    if (
      existing &&
      existing.source.trim() !== normalizedSource
    ) {
      throw new Error(
        `Skill "${skill.name}" is already declared from source "${existing.source}"`,
      );
    }

    const sameEntry = config.skills.findIndex(
      (entry) =>
        normalizeName(entry.name) === normalizedName &&
        entry.source.trim() === normalizedSource,
    );

    if (sameEntry >= 0) {
      config.skills[sameEntry] = {
        ...config.skills[sameEntry],
        name: skill.name.trim(),
        source: normalizedSource,
        description: skill.description,
      };
      continue;
    }

    config.skills.push({
      name: skill.name.trim(),
      source: normalizedSource,
      description: skill.description,
    });
  }

  return config;
}

export function installConfiguredSkills(workDir: string, config: PackConfig): void {
  installSkills(workDir, config.skills);
}

export function refreshDescriptionsAndSave(
  workDir: string,
  config: PackConfig,
): PackConfig {
  syncSkillDescriptions(workDir, config);
  saveConfig(workDir, config);
  return config;
}

export function removeSkill(workDir: string, skillName: string): boolean {
  const config = loadConfig(workDir);
  const normalizedName = normalizeName(skillName);
  const nextSkills = config.skills.filter(
    (skill) => normalizeName(skill.name) !== normalizedName,
  );

  if (nextSkills.length === config.skills.length) {
    console.log(chalk.yellow(`Skill not found: ${skillName}`));
    return false;
  }

  config.skills = nextSkills;
  saveConfig(workDir, config);

  const installedMatches = scanInstalledSkills(workDir).filter(
    (skill) => normalizeName(skill.name) === normalizedName,
  );

  if (installedMatches.length === 0) {
    console.log(
      chalk.yellow(`Removed config for ${skillName}, but no installed files were found`),
    );
    return true;
  }

  for (const skill of installedMatches) {
    if (fs.existsSync(skill.dir)) {
      fs.rmSync(skill.dir, { recursive: true, force: true });
    }
  }

  console.log(chalk.green(`Removed skill: ${skillName}`));
  return true;
}
