import fs from "node:fs";
import path from "node:path";

export interface SkillEntry {
  name: string;
  source: string;
  description: string;
  installSource?: string;
  specificSkills?: string[];
}

export interface PackConfig {
  name: string;
  description: string;
  version: string;
  prompts: string[];
  skills: SkillEntry[];
}

const PACK_FILE = "app.json";

function getPackPath(workDir: string): string {
  return path.join(workDir, PACK_FILE);
}

export function createDefaultConfig(name: string, description: string): PackConfig {
  return {
    name,
    description,
    version: "1.0.0",
    prompts: [],
    skills: [],
  };
}

export function loadConfig(workDir: string): PackConfig {
  const filePath = getPackPath(workDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Could not find ${PACK_FILE}. Run skillapp create first or work in a directory that contains app.json`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as PackConfig;
}

export function saveConfig(workDir: string, config: PackConfig): void {
  const filePath = getPackPath(workDir);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configExists(workDir: string): boolean {
  return fs.existsSync(getPackPath(workDir));
}
