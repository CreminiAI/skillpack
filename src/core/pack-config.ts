import fs from "node:fs";
import path from "node:path";

export interface SkillEntry {
  name: string;
  source: string;
  description: string;
}

export interface PackConfig {
  name: string;
  description: string;
  version: string;
  prompts: string[];
  skills: SkillEntry[];
}

export const PACK_FILE = "skillpack.json";

export function getPackPath(workDir: string): string {
  return path.join(workDir, PACK_FILE);
}

export function createDefaultConfig(
  name: string,
  description: string,
): PackConfig {
  return {
    name,
    description,
    version: "1.0.0",
    prompts: [],
    skills: [],
  };
}

function validateSkillEntry(
  value: unknown,
  sourceLabel: string,
  index: number,
): asserts value is SkillEntry {
  if (!value || typeof value !== "object") {
    throw new Error(
      `Invalid config from ${sourceLabel}: "skills[${index}]" must be an object`,
    );
  }

  const skill = value as Record<string, unknown>;
  if ("installSource" in skill || "specificSkills" in skill) {
    throw new Error(
      `Invalid config from ${sourceLabel}: legacy skill fields are no longer supported; keep only "source", "name", and "description"`,
    );
  }

  if (typeof skill.source !== "string" || !skill.source.trim()) {
    throw new Error(
      `Invalid config from ${sourceLabel}: "skills[${index}].source" is required`,
    );
  }

  if (typeof skill.name !== "string" || !skill.name.trim()) {
    throw new Error(
      `Invalid config from ${sourceLabel}: "skills[${index}].name" is required`,
    );
  }

  if (typeof skill.description !== "string") {
    throw new Error(
      `Invalid config from ${sourceLabel}: "skills[${index}].description" must be a string`,
    );
  }
}

export function validateConfigShape(
  value: unknown,
  sourceLabel: string,
): asserts value is PackConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid config from ${sourceLabel}: expected a JSON object`);
  }

  const config = value as Record<string, unknown>;
  if (typeof config.name !== "string" || !config.name.trim()) {
    throw new Error(`Invalid config from ${sourceLabel}: "name" is required`);
  }

  if (typeof config.description !== "string") {
    throw new Error(
      `Invalid config from ${sourceLabel}: "description" must be a string`,
    );
  }

  if (typeof config.version !== "string") {
    throw new Error(
      `Invalid config from ${sourceLabel}: "version" must be a string`,
    );
  }

  if (
    !Array.isArray(config.prompts) ||
    !config.prompts.every((prompt) => typeof prompt === "string")
  ) {
    throw new Error(
      `Invalid config from ${sourceLabel}: "prompts" must be a string array`,
    );
  }

  if (!Array.isArray(config.skills)) {
    throw new Error(`Invalid config from ${sourceLabel}: "skills" must be an array`);
  }

  const names = new Set<string>();
  config.skills.forEach((skill, index) => {
    validateSkillEntry(skill, sourceLabel, index);
    const normalizedName = skill.name.trim().toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(
        `Invalid config from ${sourceLabel}: duplicate skill name "${skill.name}" is not allowed`,
      );
    }
    names.add(normalizedName);
  });
}

export function loadConfig(workDir: string): PackConfig {
  const filePath = getPackPath(workDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Could not find ${PACK_FILE}. Run npx @cremini/skillpack create first or work in a directory that contains ${PACK_FILE}`,
    );
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  validateConfigShape(parsed, filePath);
  return parsed;
}

export function saveConfig(workDir: string, config: PackConfig): void {
  const filePath = getPackPath(workDir);
  validateConfigShape(config, filePath);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configExists(workDir: string): boolean {
  return fs.existsSync(getPackPath(workDir));
}
