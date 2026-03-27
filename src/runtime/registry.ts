/**
 * Global SkillPack Registry — ~/.skillpack/registry.json
 *
 * Every `skillpack run` instance registers itself on startup and deregisters
 * on graceful shutdown.  The registry file acts as the discovery mechanism
 * for `@cremini/skillpack-node` (the enterprise node manager).
 *
 * This module is intentionally free of enterprise dependencies – it is pure
 * open-source infrastructure that happens to be useful for node management.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  /** Absolute path to the Pack root directory (unique per machine) */
  dir: string;
  /** Human-readable pack name from skillpack.json */
  name: string;
  /** Pack version from skillpack.json */
  version: string;
  /** HTTP port the pack is listening on */
  port: number;
  /** OS process id (null when stopped) */
  pid: number | null;
  /** Current status */
  status: "running" | "stopped";
  /** ISO timestamp of when the pack was started */
  startedAt?: string;
  /** ISO timestamp of when the pack was stopped */
  stoppedAt?: string;
}

export interface RegistryData {
  packs: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SKILLPACK_HOME = path.join(os.homedir(), ".skillpack");
const REGISTRY_FILE = path.join(SKILLPACK_HOME, "registry.json");

export function getRegistryPath(): string {
  return REGISTRY_FILE;
}

// ---------------------------------------------------------------------------
// Read / Write helpers
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!fs.existsSync(SKILLPACK_HOME)) {
    fs.mkdirSync(SKILLPACK_HOME, { recursive: true });
  }
}

export function readRegistry(): RegistryData {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return { packs: [] };
  }
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
    const data = JSON.parse(raw) as RegistryData;
    if (!Array.isArray(data.packs)) {
      return { packs: [] };
    }
    return data;
  } catch {
    return { packs: [] };
  }
}

/**
 * Atomic write: write to a temp file first, then rename.
 * This avoids partial reads by other processes.
 */
export function writeRegistry(data: RegistryData): void {
  ensureDir();
  const tmpFile = REGISTRY_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpFile, REGISTRY_FILE);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  dir: string;
  name: string;
  version: string;
  port: number;
}

/**
 * Register a running Pack in the global registry.
 * Called from `server.ts` once the HTTP server is listening.
 */
export function register(opts: RegisterOptions): void {
  try {
    const data = readRegistry();
    const idx = data.packs.findIndex((p) => p.dir === opts.dir);

    const entry: RegistryEntry = {
      dir: opts.dir,
      name: opts.name,
      version: opts.version,
      port: opts.port,
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    if (idx >= 0) {
      data.packs[idx] = entry;
    } else {
      data.packs.push(entry);
    }

    writeRegistry(data);
    console.log(`  [Registry] Registered "${opts.name}" (pid ${process.pid})`);
  } catch (err) {
    // Registry is a best-effort feature — never crash the main process
    console.warn("  [Registry] Failed to register:", err);
  }
}

/**
 * Deregister a Pack from the global registry.
 * Called on graceful shutdown (SIGINT / SIGTERM).
 */
export function deregister(dir: string): void {
  try {
    const data = readRegistry();
    const idx = data.packs.findIndex((p) => p.dir === dir);

    if (idx >= 0) {
      data.packs[idx] = {
        ...data.packs[idx],
        pid: null,
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      };
      writeRegistry(data);
      console.log(`  [Registry] Deregistered "${data.packs[idx].name}"`);
    }
  } catch (err) {
    console.warn("  [Registry] Failed to deregister:", err);
  }
}

/**
 * Read all registry entries. Exported for `@cremini/skillpack-node`.
 */
export function readAll(): RegistryEntry[] {
  return readRegistry().packs;
}

/**
 * Check whether a pid is still alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate all "running" entries: mark dead processes as "stopped".
 * Returns the cleaned list.
 */
export function validateEntries(): RegistryEntry[] {
  try {
    const data = readRegistry();
    let changed = false;

    for (const entry of data.packs) {
      if (entry.status === "running" && entry.pid !== null) {
        if (!isPidAlive(entry.pid)) {
          entry.status = "stopped";
          entry.pid = null;
          entry.stoppedAt = new Date().toISOString();
          changed = true;
        }
      }
    }

    if (changed) {
      writeRegistry(data);
    }

    return data.packs;
  } catch {
    return [];
  }
}
