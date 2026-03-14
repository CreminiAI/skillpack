import fs from "node:fs";
import path from "node:path";

/**
 * Recursively load the contents of all SKILL.md files under skills/.
 * @param {string} rootDir - Root directory containing skills/
 * @returns {string[]} Array of SKILL.md file contents
 */
export function loadSkillContents(rootDir) {
  const skillsDir = path.join(rootDir, "skills");
  const contents = [];

  if (!fs.existsSync(skillsDir)) {
    return contents;
  }

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "SKILL.md") {
        contents.push(fs.readFileSync(full, "utf-8"));
      }
    }
  }

  walk(skillsDir);
  return contents;
}
