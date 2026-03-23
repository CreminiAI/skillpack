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

export interface ServerOptions {
  rootDir: string;
  host?: string;
  port?: number;
  firstRun?: boolean;
}

/**
 * Start the SkillPack runtime server.
 * Reads skillpack.json and data/config.json from rootDir, starts Express + WS,
 * loads adapters (Web always, Telegram/Slack if configured).
 */
export async function startServer(options: ServerOptions): Promise<void> {
  const {
    rootDir,
    host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT) || 26313,
    firstRun = true,
  } = options;

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

  // Resolve web directory: prefer rootDir/web, fallback to package-distributed web/
  const packageRoot = path.resolve(__dirname, "..");
  const webDir = fs.existsSync(path.join(rootDir, "web"))
    ? path.join(rootDir, "web")
    : path.join(packageRoot, "web");

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

  // ---------------------------------------------------------------------------
  // Listen
  // ---------------------------------------------------------------------------

  server.once("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "string" ? address : address?.port;
    const url = `http://${host}:${actualPort}`;
    console.log(`\n  Skills Pack Server`);
    console.log(`  Running at ${url}\n`);

    // Open the browser automatically on first run
    if (firstRun) {
      const cmd =
        process.platform === "darwin"
          ? `open ${url}`
          : process.platform === "win32"
            ? `start ${url}`
            : `xdg-open ${url}`;
      exec(cmd, (err) => {
        if (err) console.warn(`  Could not open browser: ${err.message}`);
      });
    }
  });

  process.on("SIGINT", () => {
    void lifecycle.requestShutdown("signal");
  });

  process.on("SIGTERM", () => {
    void lifecycle.requestShutdown("signal");
  });

  await new Promise<void>((resolve, reject) => {
    function tryListen(listenPort: number) {
      server.listen(listenPort, host);

      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.log(`  Port ${listenPort} is in use, trying ${listenPort + 1}...`);
          server.close();
          tryListen(listenPort + 1);
        } else {
          reject(err);
        }
      });

      server.once("listening", () => resolve());
    }

    tryListen(port);
  });

  // Keep process alive
  await new Promise<void>(() => {});
}
