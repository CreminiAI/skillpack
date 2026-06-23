import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveJobFile } from "../src/job-config.js";
import { saveConfig } from "../src/pack-config.js";
import { zipCommand } from "../src/commands/zip.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-zip-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createPack(dir: string): void {
  saveConfig(dir, {
    name: "Zip Pack",
    description: "Pack used for zip tests",
    version: "1.0.0",
    prompts: [],
    skills: [],
  });
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "start.sh"), "#!/bin/sh\n", "utf-8");
  fs.writeFileSync(path.join(dir, "start.bat"), "@echo off\r\n", "utf-8");
}

test("zipCommand includes job.json when it exists", async () => {
  await withTempDir(async (dir) => {
    createPack(dir);
    saveJobFile(dir, {
      jobs: [
        {
          id: "daily-brief",
          name: "daily-brief",
          cron: "0 9 * * 1-5",
          prompt: "Send the daily brief",
          notify: {
            adapter: "telegram",
            channelId: "telegram-1",
          },
        },
      ],
    });

    const zipPath = await zipCommand(dir);
    const zipText = fs.readFileSync(zipPath, "utf-8");

    assert.equal(zipText.includes("zip-pack/job.json"), true);
    assert.equal(zipText.includes("zip-pack/skillpack.json"), true);
  });
});

test("zipCommand skips job.json when it does not exist", async () => {
  await withTempDir(async (dir) => {
    createPack(dir);

    const zipPath = await zipCommand(dir);
    const zipText = fs.readFileSync(zipPath, "utf-8");

    assert.equal(zipText.includes("zip-pack/job.json"), false);
    assert.equal(zipText.includes("zip-pack/skillpack.json"), true);
  });
});

test("zipCommand includes app.html when it exists", async () => {
  await withTempDir(async (dir) => {
    createPack(dir);
    fs.writeFileSync(path.join(dir, "app.html"), "<!doctype html>", "utf-8");

    const zipPath = await zipCommand(dir);
    const zipText = fs.readFileSync(zipPath, "utf-8");

    assert.equal(zipText.includes("zip-pack/app.html"), true);
  });
});

test("zipCommand skips app.html when it does not exist", async () => {
  await withTempDir(async (dir) => {
    createPack(dir);

    const zipPath = await zipCommand(dir);
    const zipText = fs.readFileSync(zipPath, "utf-8");

    assert.equal(zipText.includes("zip-pack/app.html"), false);
  });
});

test("zipCommand continues installing other skills after one fails", async () => {
  await withTempDir(async (dir) => {
    createPack(dir);
    const binDir = path.join(dir, "bin");
    const installLog = path.join(dir, "install.log");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "npx"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$SKILLPACK_TEST_INSTALL_LOG"',
        'case "$*" in',
        "  *first-skill*) exit 1 ;;",
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o755 },
    );
    saveConfig(dir, {
      name: "Zip Pack",
      description: "Pack used for zip tests",
      version: "1.0.0",
      prompts: [],
      skills: [
        {
          name: "first-skill",
          source: "first-source",
          description: "",
        },
        {
          name: "second-skill",
          source: "second-source",
          description: "",
        },
      ],
    });

    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    process.env.SKILLPACK_TEST_INSTALL_LOG = installLog;
    try {
      const zipPath = await zipCommand(dir);
      const zipText = fs.readFileSync(zipPath, "utf-8");
      const installAttempts = fs.readFileSync(installLog, "utf-8");

      assert.match(installAttempts, /--skill first-skill/);
      assert.match(installAttempts, /--skill second-skill/);
      assert.equal(zipText.includes("zip-pack/skillpack.json"), true);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.SKILLPACK_TEST_INSTALL_LOG;
    }
  });
});
