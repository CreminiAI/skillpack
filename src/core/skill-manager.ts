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
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    if (!nameMatch) {
      return null;
    }

    return {
      name: nameMatch[1].trim(),
      description: descMatch ? descMatch[1].trim() : "",
      dir: path.dirname(filePath),
    };
  } catch {
    return null;
  }
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
