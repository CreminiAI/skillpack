import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import chalk from "chalk";
import {
  getPackPath,
  loadConfig,
  PACK_FILE,
  saveConfig,
} from "../pack-config.js";
import {
  installConfiguredSkills,
  syncSkillDescriptions,
} from "../skill-manager.js";

/**
 * Package the pack as a lightweight zip file.
 * Includes only: skillpack.json, start.sh, start.bat, skills/
 * Does NOT include server/, web/, or any other runtime files.
 */
export async function zipCommand(workDir: string): Promise<string> {
  const config = loadConfig(workDir);
  const slug = config.name.toLowerCase().replace(/\s+/g, "-");
  const zipName = `${slug}.zip`;
  const zipPath = path.join(workDir, zipName);

  // Reinstall and sync skills before packaging
  installConfiguredSkills(workDir, config);
  syncSkillDescriptions(workDir, config);
  saveConfig(workDir, config);

  console.log(chalk.blue(`Packaging ${config.name}...`));

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(
        chalk.green(
          `Packaging complete: ${zipName} (${(archive.pointer() / 1024).toFixed(1)} KB)`,
        ),
      );
      resolve(zipPath);
    });

    archive.on("error", (err) => reject(err));
    archive.pipe(output);

    const prefix = slug;

    // 1. skillpack.json
    archive.file(getPackPath(workDir), {
      name: `${prefix}/${PACK_FILE}`,
    });

    // 2. skills directory
    const skillsDir = path.join(workDir, "skills");
    if (fs.existsSync(skillsDir)) {
      archive.directory(skillsDir, `${prefix}/skills`);
    }

    // 3. start.sh (with execute bit)
    const startSh = path.join(workDir, "start.sh");
    if (fs.existsSync(startSh)) {
      archive.file(startSh, { name: `${prefix}/start.sh`, mode: 0o755 });
    }

    // 4. start.bat
    const startBat = path.join(workDir, "start.bat");
    if (fs.existsSync(startBat)) {
      archive.file(startBat, { name: `${prefix}/start.bat` });
    }

    archive.finalize();
  });
}
