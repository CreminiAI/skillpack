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
