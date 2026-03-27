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

  const adapters: import("./adapters/types.js").PlatformAdapter[] = [];
  const adapterMap = new Map<string, import("./adapters/types.js").PlatformAdapter>();

  // Web adapter is always enabled
  const webAdapter = new WebAdapter();
  await webAdapter.start({ agent, server, app, rootDir, lifecycle, adapterMap });
  adapters.push(webAdapter);
  adapterMap.set(webAdapter.name, webAdapter);

  // Telegram adapter (conditional)
  if (dataConfig.adapters?.telegram?.token) {
    try {
      const { TelegramAdapter } = await import("./adapters/telegram.js");
      const telegramAdapter = new TelegramAdapter({
        token: dataConfig.adapters.telegram.token,
      });
      await telegramAdapter.start({ agent, server, app, rootDir, lifecycle });
      adapters.push(telegramAdapter);
      adapterMap.set(telegramAdapter.name, telegramAdapter);
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
        adapterMap.set(slackAdapter.name, slackAdapter);
      } catch (err) {
        console.error("[Slack] Failed to start:", err);
      }
    }
  }

  // Build the unified notify function for scheduler → IM push
  const { isMessageSender } = await import("./adapters/types.js");
  const notifyFn = async (adapterName: string, channelId: string, text: string) => {
    const adapter = adapterMap.get(adapterName);
    if (!adapter || !isMessageSender(adapter)) {
      console.warn(
        `[Scheduler] Target adapter "${adapterName}" not found or doesn't support sendMessage`,
      );
      return;
    }
    await adapter.sendMessage(channelId, text);
  };

  // Scheduler adapter (conditional – starts AFTER all IM adapters)
  const scheduledJobs = dataConfig.scheduledJobs || [];
  let schedulerAdapter: import("./adapters/scheduler.js").SchedulerAdapter | null = null;

  // Always import scheduler so that the Agent tool can manage jobs dynamically
  try {
    const { SchedulerAdapter } = await import("./adapters/scheduler.js");
    schedulerAdapter = new SchedulerAdapter();
    await schedulerAdapter.start({
      agent,
      server,
      app,
      rootDir,
      lifecycle,
      notify: notifyFn,
      adapterMap,
    });
    adapters.push(schedulerAdapter);
    adapterMap.set(schedulerAdapter.name, schedulerAdapter);

    if (scheduledJobs.length > 0) {
      console.log(`[Server] Scheduler started with ${scheduledJobs.length} job(s)`);
    }
  } catch (err) {
    console.error("[Scheduler] Failed to start:", err);
  }

  // Inject scheduler reference into agent for the manage_scheduled_task tool
  if (schedulerAdapter) {
    agent.setScheduler(schedulerAdapter);
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
