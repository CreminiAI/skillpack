import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RuntimeTemplateEntry {
  absolutePath: string;
  relativePath: string;
  stats: fs.Stats;
  type: "file" | "directory";
}

const EXECUTABLE_RUNTIME_FILES = new Set(["start.sh", "start.bat"]);

function isExecutableRuntimeFile(relativePath: string): boolean {
  return EXECUTABLE_RUNTIME_FILES.has(relativePath);
}

function withExecuteBits(mode: number): number {
  return mode | 0o111;
}

/**
 * Resolve the absolute path to the packaged runtime template directory.
 * tsup bundles the CLI into dist/cli.js, so __dirname points at dist/.
 * The project root is one level up, with runtime/ next to dist/.
 */
export function getRuntimeDir(): string {
  const projectRoot = path.resolve(__dirname, "..");
  return path.join(projectRoot, "runtime");
}

export function assertRuntimeDirExists(runtimeDir: string): void {
  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Runtime directory not found: ${runtimeDir}`);
  }
}

export function collectRuntimeTemplateEntries(
  runtimeDir: string,
): RuntimeTemplateEntry[] {
  assertRuntimeDirExists(runtimeDir);

  const entries: RuntimeTemplateEntry[] = [];

  function visit(currentDir: string, relativeDir = ""): void {
    const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const dirEntry of dirEntries) {
      if (dirEntry.name === "node_modules") {
        continue;
      }

      // Skip TypeScript source files from runtime/server/ (only ship compiled dist/)
      const currentRelative = relativeDir
        ? path.posix.join(relativeDir, dirEntry.name)
        : dirEntry.name;
      if (
        currentRelative === "server/src" ||
        currentRelative === "server/tsconfig.json"
      ) {
        continue;
      }

      const absolutePath = path.join(currentDir, dirEntry.name);
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, dirEntry.name)
        : dirEntry.name;
      const stats = fs.statSync(absolutePath);

      if (dirEntry.isDirectory()) {
        entries.push({
          absolutePath,
          relativePath,
          stats,
          type: "directory",
        });
        visit(absolutePath, relativePath);
        continue;
      }

      if (dirEntry.isFile()) {
        entries.push({
          absolutePath,
          relativePath,
          stats,
          type: "file",
        });
      }
    }
  }

  visit(runtimeDir);
  return entries;
}

export function copyRuntimeTemplate(runtimeDir: string, workDir: string): void {
  const entries = collectRuntimeTemplateEntries(runtimeDir);

  for (const entry of entries) {
    const destinationPath = path.join(workDir, entry.relativePath);

    if (entry.type === "directory") {
      fs.mkdirSync(destinationPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(entry.absolutePath, destinationPath);
    fs.chmodSync(destinationPath, entry.stats.mode);
  }
}

export function ensureRuntimeLaunchersExecutable(workDir: string): void {
  for (const relativePath of EXECUTABLE_RUNTIME_FILES) {
    const filePath = path.join(workDir, relativePath);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const currentMode = fs.statSync(filePath).mode;
    fs.chmodSync(filePath, withExecuteBits(currentMode));
  }
}

export function addRuntimeFiles(
  archive: archiver.Archiver,
  runtimeDir: string,
  prefix: string,
): void {
  const entries = collectRuntimeTemplateEntries(runtimeDir);

  for (const entry of entries) {
    const archivePath = `${prefix}/${entry.relativePath}`;

    if (entry.type === "directory") {
      archive.append("", {
        name: `${archivePath}/`,
        mode: entry.stats.mode,
      });
      continue;
    }

    archive.file(entry.absolutePath, {
      name: archivePath,
      mode: isExecutableRuntimeFile(entry.relativePath)
        ? withExecuteBits(entry.stats.mode)
        : entry.stats.mode,
    });
  }
}
