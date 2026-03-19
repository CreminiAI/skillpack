import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { exec } from "node:child_process";

import { PackAgent } from "./agent.js";
import { WebAdapter } from "./adapters/web.js";
import { configManager } from "./config.js";
import { Lifecycle } from "./lifecycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Resolve root directory
// ---------------------------------------------------------------------------

// In dev (running from dist/), go up two levels: dist/ → server/ → pack root
// In production (copied to target), go up one level: dist/ → server/ → pack root
const serverDir = path.resolve(__dirname, "..");
const rootDir =
  process.env.PACK_ROOT || path.resolve(serverDir, "..");

// ---------------------------------------------------------------------------
// Read configuration: data/config.json first, env vars override
// ---------------------------------------------------------------------------

const dataConfig = configManager.load(rootDir);
const apiKey = dataConfig.apiKey || "";
const provider = dataConfig.provider || "openai";

const modelId = provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";


// ---------------------------------------------------------------------------
// Create Express app & HTTP server
// ---------------------------------------------------------------------------

const webDir = fs.existsSync(path.join(rootDir, "web"))
  ? path.join(rootDir, "web")
  : path.join(serverDir, "..", "web");

const app = express();
app.use(express.json());
app.use(express.static(webDir));

const server = createServer(app);
const lifecycle = new Lifecycle(server);

// ---------------------------------------------------------------------------
// Create PackAgent (shared instance)
// ---------------------------------------------------------------------------

const agent = new PackAgent({
  apiKey,
  rootDir,
  provider,
  modelId,
  lifecycleHandler: lifecycle,
});

// ---------------------------------------------------------------------------
// Start adapters
// ---------------------------------------------------------------------------

async function startAdapters() {
  const adapters = [];

  // Web adapter is always enabled
  const webAdapter = new WebAdapter();
  await webAdapter.start({ agent, server, app, rootDir, lifecycle });
  adapters.push(webAdapter);

  // Telegram adapter (conditional)
  if (dataConfig.adapters?.telegram?.token) {
    try {
      const { TelegramAdapter } = await import("./adapters/telegram.js");
      const telegramAdapter = new TelegramAdapter({
        token: dataConfig.adapters.telegram.token,
      });
      await telegramAdapter.start({ agent, server, app, rootDir, lifecycle });
      adapters.push(telegramAdapter);
    } catch (err) {
      console.error("[Telegram] Failed to start:", err);
    }
  }

  // Slack adapter (conditional)
  const slackConfig = dataConfig.adapters?.slack;
  if (slackConfig?.botToken || slackConfig?.appToken) {
    if (!slackConfig.botToken || !slackConfig.appToken) {
      console.warn(
        "[Slack] Skipped: both adapters.slack.botToken and adapters.slack.appToken are required.",
      );
    } else {
      try {
        const { SlackAdapter } = await import("./adapters/slack.js");
        const slackAdapter = new SlackAdapter({
          botToken: slackConfig.botToken,
          appToken: slackConfig.appToken,
        });
        await slackAdapter.start({ agent, server, app, rootDir, lifecycle });
        adapters.push(slackAdapter);
      } catch (err) {
        console.error("[Slack] Failed to start:", err);
      }
    }
  }

  lifecycle.registerAdapters(adapters);
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = 26313;

server.once("listening", () => {
  const address = server.address();
  const actualPort = typeof address === "string" ? address : address?.port;
  const url = `http://${HOST}:${actualPort}`;
  console.log(`\n  Skills Pack Server`);
  console.log(`  Running at ${url}\n`);

  // Open the browser automatically
  const cmd =
    process.platform === "darwin"
      ? `open ${url}`
      : process.platform === "win32"
        ? `start ${url}`
        : `xdg-open ${url}`;
  exec(cmd, () => {});
});

function tryListen(port: number) {
  server.listen(port, HOST);

  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`  Port ${port} is in use, trying ${port + 1}...`);
      server.close();
      tryListen(port + 1);
    } else {
      throw err;
    }
  });
}

process.on("SIGINT", () => {
  void lifecycle.requestShutdown("signal");
});

process.on("SIGTERM", () => {
  void lifecycle.requestShutdown("signal");
});

// Start adapters, then listen
startAdapters()
  .then(() => {
    const startPort = Number(process.env.PORT) || DEFAULT_PORT;
    tryListen(startPort);
  })
  .catch((err) => {
    console.error("Failed to start adapters:", err);
    process.exit(1);
  });
