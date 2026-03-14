import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import chalk from "chalk";
import { fileURLToPath } from "node:url";
import { loadConfig, type PackConfig } from "./pack-config.js";
import { installPendingSkills } from "./skill-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to the runtime directory.
 * tsup bundles the CLI into dist/cli.js, so __dirname points at dist/.
 * The project root is one level up, with runtime/ next to dist/.
 */
function getRuntimeDir(): string {
  // dist/cli.js -> dist/ -> project-root/runtime/
  const projectRoot = path.resolve(__dirname, "..");
  return path.join(projectRoot, "runtime");
}

/**
 * Package the pack as a zip file.
 */
export async function bundle(workDir: string): Promise<string> {
  const config = loadConfig(workDir);
  const zipName = `${config.name}.zip`;
  const zipPath = path.join(workDir, zipName);
  const runtimeDir = getRuntimeDir();

  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Runtime directory not found: ${runtimeDir}`);
  }

  await installPendingSkills(workDir, config);

  console.log(chalk.blue(`Packaging ${config.name}...`));

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(chalk.green(`Packaging complete: ${zipName} (${(archive.pointer() / 1024).toFixed(1)} KB)`));
      resolve(zipPath);
    });

    archive.on("error", (err) => reject(err));
    archive.pipe(output);

    const prefix = config.name;

    // 1. app.json
    archive.file(path.join(workDir, "app.json"), { name: `${prefix}/app.json` });

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

/**
 * Add runtime files to the zip archive.
 * server/ and web/ keep their structure, while launcher scripts from
 * scripts/ are placed at the archive root.
 */
function addRuntimeFiles(archive: archiver.Archiver, runtimeDir: string, prefix: string): void {
  // server/ directory, excluding node_modules
  const serverDir = path.join(runtimeDir, "server");
  if (fs.existsSync(serverDir)) {
    archive.glob("**/*", {
      cwd: serverDir,
      ignore: ["node_modules/**"],
    }, { prefix: `${prefix}/server` });
  }

  // web/ directory
  const webDir = path.join(runtimeDir, "web");
  if (fs.existsSync(webDir)) {
    archive.directory(webDir, `${prefix}/web`);
  }

  // launcher scripts from scripts/ -> archive root
  const scriptsDir = path.join(runtimeDir, "scripts");
  if (fs.existsSync(scriptsDir)) {
    const startSh = path.join(scriptsDir, "start.sh");
    if (fs.existsSync(startSh)) {
      archive.file(startSh, { name: `${prefix}/start.sh`, mode: 0o755 });
    }
    const startBat = path.join(scriptsDir, "start.bat");
    if (fs.existsSync(startBat)) {
      archive.file(startBat, { name: `${prefix}/start.bat` });
    }
  }

  // README.md
  const readme = path.join(runtimeDir, "README.md");
  if (fs.existsSync(readme)) {
    archive.file(readme, { name: `${prefix}/README.md` });
  }
}
