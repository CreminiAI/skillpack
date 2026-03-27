/**
 * Per-pack SkillPack Registry — ~/.skillpack/registry.d/*.json
 *
 * Each `skillpack run` instance owns a single registry entry file keyed by the
 * canonical pack directory. This avoids the old global read-modify-write race
 * on ~/.skillpack/registry.json while keeping local discovery simple.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  /** ISO timestamp of the last registry update */
  updatedAt?: string;
}

export interface RegistryData {
  packs: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SKILLPACK_HOME = path.join(os.homedir(), ".skillpack");
const LEGACY_REGISTRY_FILE = path.join(SKILLPACK_HOME, "registry.json");
const REGISTRY_DIR = path.join(SKILLPACK_HOME, "registry.d");

let migrationChecked = false;

export function getRegistryPath(): string {
  ensureRegistryReady();
  return REGISTRY_DIR;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureHomeDir(): void {
  if (!fs.existsSync(SKILLPACK_HOME)) {
    fs.mkdirSync(SKILLPACK_HOME, { recursive: true });
  }
}

function ensureRegistryDir(): void {
  ensureHomeDir();
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

export function canonicalizeDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function hashDir(dir: string): string {
  return crypto.createHash("md5").update(canonicalizeDir(dir)).digest("hex");
}

function getEntryPathForCanonicalDir(dir: string): string {
  return path.join(REGISTRY_DIR, `${hashDir(dir)}.json`);
}

export function getEntryPath(dir: string): string {
  ensureRegistryReady();
  return getEntryPathForCanonicalDir(canonicalizeDir(dir));
}

function listEntryFiles(): string[] {
  ensureRegistryReady();
  return fs
    .readdirSync(REGISTRY_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => path.join(REGISTRY_DIR, file));
}

function readEntryFile(filePath: string): RegistryEntry | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Partial<RegistryEntry>;
    if (
      typeof data?.dir !== "string" ||
      typeof data?.name !== "string" ||
      typeof data?.version !== "string" ||
      typeof data?.port !== "number" ||
      (typeof data?.pid !== "number" && data?.pid !== null) ||
      (data?.status !== "running" && data?.status !== "stopped")
    ) {
      return null;
    }

    return {
      dir: canonicalizeDir(data.dir),
      name: data.name,
      version: data.version,
      port: data.port,
      pid: data.pid,
      status: data.status,
      startedAt: data.startedAt,
      stoppedAt: data.stoppedAt,
      updatedAt: data.updatedAt,
    };
  } catch {
    return null;
  }
}

function createTmpPath(entryPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${entryPath}.tmp.${suffix}`;
}

function writeEntryFile(entry: RegistryEntry): void {
  ensureRegistryReady();
  const normalized: RegistryEntry = {
    ...entry,
    dir: canonicalizeDir(entry.dir),
    updatedAt: entry.updatedAt ?? new Date().toISOString(),
  };
  const entryPath = getEntryPathForCanonicalDir(normalized.dir);
  const tmpPath = createTmpPath(entryPath);
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), "utf-8");
  fs.renameSync(tmpPath, entryPath);
}

function migrateLegacyRegistryIfNeeded(): void {
  if (migrationChecked) {
    return;
  }
  migrationChecked = true;

  ensureRegistryDir();

  if (!fs.existsSync(LEGACY_REGISTRY_FILE)) {
    return;
  }

  if (listEntryFiles().length > 0) {
    return;
  }

  try {
    const raw = fs.readFileSync(LEGACY_REGISTRY_FILE, "utf-8");
    const data = JSON.parse(raw) as RegistryData;
    const packs = Array.isArray(data?.packs) ? data.packs : [];

    for (const pack of packs) {
      try {
        writeEntryFile({
          ...pack,
          dir: canonicalizeDir(pack.dir),
          updatedAt: pack.updatedAt ?? pack.stoppedAt ?? pack.startedAt ?? new Date().toISOString(),
        });
      } catch {
        // Ignore individual invalid legacy entries during migration.
      }
    }

    fs.renameSync(LEGACY_REGISTRY_FILE, `${LEGACY_REGISTRY_FILE}.legacy`);
  } catch (err) {
    console.warn("  [Registry] Failed to migrate legacy registry.json:", err);
  }
}

function ensureRegistryReady(): void {
  ensureRegistryDir();
  migrateLegacyRegistryIfNeeded();
}

function entriesEqual(a: RegistryEntry, b: RegistryEntry): boolean {
  return (
    a.dir === b.dir &&
    a.name === b.name &&
    a.version === b.version &&
    a.port === b.port &&
    a.pid === b.pid &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.stoppedAt === b.stoppedAt
  );
}

// ---------------------------------------------------------------------------
// Read / Write helpers
// ---------------------------------------------------------------------------

export function readEntry(dir: string): RegistryEntry | null {
  ensureRegistryReady();
  return readEntryFile(getEntryPath(dir));
}

export function writeEntry(entry: RegistryEntry): void {
  writeEntryFile(entry);
}

export function deleteEntry(dir: string): void {
  ensureRegistryReady();
  const entryPath = getEntryPath(dir);
  if (fs.existsSync(entryPath)) {
    fs.unlinkSync(entryPath);
  }
}

export function readRegistry(): RegistryData {
  return { packs: readAll() };
}

/**
 * Compatibility helper for legacy callers that still expect a single write
 * entrypoint. It now rewrites the registry directory to match the provided set.
 */
export function writeRegistry(data: RegistryData): void {
  ensureRegistryReady();

  const nextPaths = new Set<string>();
  for (const pack of data.packs) {
    const normalized: RegistryEntry = {
      ...pack,
      dir: canonicalizeDir(pack.dir),
      updatedAt: pack.updatedAt ?? new Date().toISOString(),
    };
    const entryPath = getEntryPathForCanonicalDir(normalized.dir);
    nextPaths.add(entryPath);
    writeEntryFile(normalized);
  }

  for (const existingPath of listEntryFiles()) {
    if (!nextPaths.has(existingPath)) {
      fs.unlinkSync(existingPath);
    }
  }
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
 * Register a running Pack in the local registry directory.
 * Called from `server.ts` once the HTTP server is listening.
 */
export function register(opts: RegisterOptions): void {
  try {
    const now = new Date().toISOString();
    const entry: RegistryEntry = {
      dir: canonicalizeDir(opts.dir),
      name: opts.name,
      version: opts.version,
      port: opts.port,
      pid: process.pid,
      status: "running",
      startedAt: now,
      updatedAt: now,
    };

    writeEntryFile(entry);
    console.log(`  [Registry] Registered "${opts.name}" (pid ${process.pid})`);
  } catch (err) {
    // Registry is a best-effort feature — never crash the main process
    console.warn("  [Registry] Failed to register:", err);
  }
}

/**
 * Deregister a Pack from the local registry directory.
 * Only writes stopped state when the current entry still belongs to the caller pid.
 */
export function deregister(dir: string, pid: number): void {
  try {
    const entry = readEntry(dir);
    if (!entry || entry.pid !== pid) {
      return;
    }

    const now = new Date().toISOString();
    writeEntryFile({
      ...entry,
      pid: null,
      status: "stopped",
      stoppedAt: now,
      updatedAt: now,
    });
    console.log(`  [Registry] Deregistered "${entry.name}"`);
  } catch (err) {
    console.warn("  [Registry] Failed to deregister:", err);
  }
}

/**
 * Read all registry entries. Exported for `@cremini/skillpack-node`.
 */
export function readAll(): RegistryEntry[] {
  return listEntryFiles()
    .map((entryPath) => readEntryFile(entryPath))
    .filter((entry): entry is RegistryEntry => entry !== null);
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
 * Legacy helper: performs a local pid-only cleanup and returns the current set.
 * Deeper health validation now lives in skillpack-node.
 */
export function validateEntries(): RegistryEntry[] {
  const entries = readAll();
  const now = new Date().toISOString();

  for (const entry of entries) {
    if (entry.status === "running" && entry.pid !== null && !isPidAlive(entry.pid)) {
      writeEntryFile({
        ...entry,
        pid: null,
        status: "stopped",
        stoppedAt: now,
        updatedAt: now,
      });
    }
  }

  const nextEntries = readAll();
  if (entries.length === nextEntries.length && entries.every((entry, index) => entriesEqual(entry, nextEntries[index]!))) {
    return entries;
  }
  return nextEntries;
}
