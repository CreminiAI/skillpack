import { execSync } from "node:child_process";
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

/**
 * Get the working skills directory.
 */
function getSkillsDir(workDir: string): string {
  return path.join(workDir, SKILLS_DIR);
}

/**
 * Install pending skills that haven't been downloaded yet.
 */
export async function installPendingSkills(
  workDir: string,
  config: PackConfig,
): Promise<void> {
  const pendingSkills = config.skills.filter((s) => s.installSource);

  if (pendingSkills.length === 0) {
    return;
  }

  console.log(chalk.blue(`\n  Installing pending skills...`));
  const skillsDir = getSkillsDir(workDir);
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const skill of pendingSkills) {
    // Install in copy mode into the skills directory
    let addCmd = `npx -y skills add ${skill.installSource} --agent openclaw --copy -y`;
    if (skill.specificSkills && skill.specificSkills.length > 0) {
      for (const name of skill.specificSkills) {
        addCmd += ` --skill "${name}"`;
      }
    }

    console.log(chalk.dim(`> ${addCmd}`));

    try {
      execSync(addCmd, { encoding: "utf-8", cwd: workDir, stdio: "inherit" });
    } catch (err) {
      console.error(chalk.red(`Failed to install skill: ${err}`));
    }
  }

  // Scan installed skills
  config.skills = scanInstalledSkills(workDir);
  saveConfig(workDir, config);
  console.log(chalk.green(`  Skill installation complete.\n`));
}

/**
 * Scan the local skills directory and parse SKILL.md metadata.
 */
export function scanInstalledSkills(workDir: string): SkillEntry[] {
  const results: SkillEntry[] = [];
  const skillsDir = getSkillsDir(workDir);

  if (!fs.existsSync(skillsDir)) {
    return results;
  }

  // Recursively find SKILL.md files
  function findSkillFiles(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findSkillFiles(fullPath);
      } else if (entry.name === "SKILL.md") {
        const skill = parseSkillMd(fullPath, workDir);
        if (skill) {
          results.push(skill);
        }
      }
    }
  }

  findSkillFiles(skillsDir);
  return results;
}

/**
 * Parse SKILL.md frontmatter to get name and description.
 */
function parseSkillMd(filePath: string, workDir: string): SkillEntry | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    const frontmatter = frontmatterMatch[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim(),
      source: path.relative(workDir, path.dirname(filePath)),
      description: descMatch ? descMatch[1].trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * Remove a skill from the pack.
 */
export function removeSkill(workDir: string, skillName: string): boolean {
  const config = loadConfig(workDir);
  const idx = config.skills.findIndex(
    (s) => s.name.toLowerCase() === skillName.toLowerCase(),
  );
  if (idx === -1) {
    console.log(chalk.yellow(`Skill not found: ${skillName}`));
    return false;
  }

  // Delete the skill directory
  const skillDir = path.join(workDir, config.skills[idx].source);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
  }

  config.skills.splice(idx, 1);
  saveConfig(workDir, config);
  console.log(chalk.green(`Removed skill: ${skillName}`));
  return true;
}
