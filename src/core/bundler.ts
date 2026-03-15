import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import chalk from "chalk";
import {
  getPackPath,
  loadConfig,
  PACK_FILE,
  saveConfig,
} from "./pack-config.js";
import {
  installConfiguredSkills,
  syncSkillDescriptions,
} from "./skill-manager.js";
import { addRuntimeFiles, assertRuntimeDirExists, getRuntimeDir } from "./runtime-template.js";

/**
 * Package the pack as a zip file.
 */
export async function bundle(workDir: string): Promise<string> {
  const config = loadConfig(workDir);
  const zipName = `${config.name}.zip`;
  const zipPath = path.join(workDir, zipName);
  const runtimeDir = getRuntimeDir();

  assertRuntimeDirExists(runtimeDir);

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

    const prefix = config.name;

    // 1. skillpack.json
    archive.file(getPackPath(workDir), {
      name: `${prefix}/${PACK_FILE}`,
    });

    // 2. skills directory
    const skillsDir = path.join(workDir, "skills");
    if (fs.existsSync(skillsDir)) {
      archive.directory(skillsDir, `${prefix}/skills`);
    }

    // 3. runtime directory, excluding node_modules
    addRuntimeFiles(archive, runtimeDir, prefix);

    archive.finalize();
  });
}
