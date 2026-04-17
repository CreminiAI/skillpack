import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { configManager, SUPPORTED_PROVIDERS } from "../config.js";
import type { DataConfig } from "../config.js";
import { resolveCommand } from "../commands/index.js";
import {
  ConversationService,
  DEFAULT_WEB_CHANNEL_ID,
} from "../services/conversation.js";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  IPackAgent,
  IpcBroadcaster,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPackConfig(rootDir: string): any {
  const raw = fs.readFileSync(path.join(rootDir, "skillpack.json"), "utf-8");
  return JSON.parse(raw);
}

function parseCommand(text: string) {
  return resolveCommand(text.trim().toLowerCase());
}

function sendWsEvent(ws: WebSocket, event: AgentEvent): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(event));
}

function getRuntimeConfigSignature(config: DataConfig): string {
  return JSON.stringify({
    apiKey: config.apiKey || "",
    provider: config.provider || "openai",
    baseUrl: config.baseUrl || "",
    modelId: config.modelId || "",
    apiProtocol: config.apiProtocol || "",
    telegramToken: config.adapters?.telegram?.token || "",
    slackBotToken: config.adapters?.slack?.botToken || "",
    slackAppToken: config.adapters?.slack?.appToken || "",
  });
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// WebAdapter
// ---------------------------------------------------------------------------

export class WebAdapter implements PlatformAdapter {
  readonly name = "web";

  private wss: WebSocketServer | null = null;
  private agent: IPackAgent | null = null;
  private ipcBroadcaster: IpcBroadcaster | null = null;
  private conversationService: ConversationService | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    const { agent, server, app, rootDir, lifecycle } = ctx;
    this.agent = agent;
    this.ipcBroadcaster = ctx.ipcBroadcaster ?? null;
    this.conversationService = new ConversationService(rootDir);
    const resultsQueryService = ctx.resultsQueryService ?? null;

    // -- API key & provider (in-memory, can be overridden by frontend) ------

    const currentConf = configManager.getConfig();
    let apiKey = currentConf.apiKey || "";
    let currentProvider = currentConf.provider || "openai";

    // -- HTTP API routes ----------------------------------------------------

    app.get("/api/config", (_req, res) => {
      const config = getPackConfig(rootDir);
      const conf = configManager.getConfig();
      const currentProvider = conf.provider || "openai";
      const providerMeta = SUPPORTED_PROVIDERS[currentProvider];

      const oauthConnected = providerMeta?.authType === "oauth"
        ? agent.getAuthStorage().hasAuth(currentProvider)
        : false;

      res.json({
        name: config.name,
        description: config.description,
        prompts: config.prompts || [],
        skills: config.skills || [],
        hasApiKey: !!conf.apiKey,
        apiKey: conf.apiKey || "",
        provider: currentProvider,
        baseUrl: conf.baseUrl || "",
        modelId: conf.modelId || "",
        apiProtocol: conf.apiProtocol || "",
        adapters: conf.adapters || {},
        supportedProviders: SUPPORTED_PROVIDERS,
        oauthConnected,
      });
    });

    app.get("/api/skills", (_req, res) => {
      const config = getPackConfig(rootDir);
      res.json(config.skills || []);
    });

    app.post("/api/config/update", (req, res) => {
      const { key, provider, baseUrl, modelId, apiProtocol, adapters } = req.body;
      const updates: any = {};
      const beforeConfig = JSON.parse(JSON.stringify(configManager.getConfig()));

      if (key !== undefined) {
        updates.apiKey = key;
        apiKey = key;
      }
      if (provider !== undefined) {
        updates.provider = provider;
        currentProvider = provider;
      }
      if (baseUrl !== undefined) {
        updates.baseUrl = baseUrl;
      }
      if (modelId !== undefined) {
        updates.modelId = modelId;
      }
      if (apiProtocol !== undefined) {
        updates.apiProtocol = apiProtocol;
      }
      if (adapters !== undefined) {
        updates.adapters = adapters;
      }

      configManager.save(rootDir, updates);

      // Sink changes into the agent immediately
      agent.updateAuth(currentProvider, apiKey);

      const afterConfig = configManager.getConfig();
      const requiresRestart = getRuntimeConfigSignature(beforeConfig) !== getRuntimeConfigSignature(afterConfig);

      res.json({
        ...afterConfig,
        requiresRestart
      });
    });

    // -- OAuth API routes ----------------------------------------------------

    app.post("/api/oauth/login", async (req, res) => {
      const { provider } = req.body;
      const meta = SUPPORTED_PROVIDERS[provider];
      if (!meta || meta.authType !== "oauth") {
        return res.status(400).json({ error: "Provider does not support OAuth" });
      }

      try {
        const authStorage = agent.getAuthStorage();
        let authUrl = "";

        // Start login flow. Results in authUrl via callback.
        const loginPromise = authStorage.login(provider, {
          onAuth: (info: any) => {
            authUrl = info.url;
          },
          onPrompt: async (prompt: any) => {
            // For Web UI, we don't handle manual prompt yet.
            return "";
          },
          onProgress: (msg: string) => {
            console.log(`[OAuth] ${provider} login progress: ${msg}`);
          },
        });

        // Wait for authUrl to be populated (small delay as SDK starts local server)
        await new Promise((r) => setTimeout(r, 1500));

        if (authUrl) {
          res.json({ status: "pending", authUrl });
        } else {
          // If it didn't populate yet, it might still be working or failed.
          res.json({ status: "pending" });
        }

        // The promise continues in the background.
        loginPromise.catch((err: any) => {
          console.error(`[OAuth] ${provider} login error:`, err);
        });
      } catch (err: any) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/oauth/status", (_req, res) => {
      const conf = configManager.getConfig();
      const provider = conf.provider || "openai";
      const meta = SUPPORTED_PROVIDERS[provider];
      if (!meta || meta.authType !== "oauth") {
        return res.json({ connected: false });
      }
      const connected = agent.getAuthStorage().hasAuth(provider);
      res.json({ connected, provider });
    });

    app.post("/api/oauth/logout", (req, res) => {
      const { provider } = req.body;
      agent.getAuthStorage().logout(provider);
      res.json({ success: true });
    });

    app.post("/api/runtime/restart", async (_req, res) => {
      const result = await lifecycle.requestRestart("web");
      res.status(202).json(result);
    });

    app.delete("/api/chat", (_req, res) => {
      res.json({ success: true });
    });

    // -- Conversation API ---------------------------------------------------

    const getWebConversations = () => {
      const activeChannels = new Set(agent.getActiveChannelIds());
      return this.conversationService!.listConversations(activeChannels, {
        includeDefaultWeb: true,
        includeLegacyWeb: false,
        allowedPlatforms: ["web"],
      });
    };

    app.get("/api/conversations", (_req, res) => {
      res.json(getWebConversations());
    });

    app.post("/api/conversations", (_req, res) => {
      res.json({ channelId: DEFAULT_WEB_CHANNEL_ID });
    });

    app.get("/api/conversations/:channelId/messages", (req, res) => {
      if (req.params.channelId !== DEFAULT_WEB_CHANNEL_ID) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      res.json(
        this.conversationService!.getMessages(
          req.params.channelId,
          parsePositiveInt(req.query.limit, 100),
        ),
      );
    });

    // -- Persisted results API ----------------------------------------------

    app.get("/api/results/runs", (req, res) => {
      if (!resultsQueryService) {
        res.status(503).json({ error: "Results query service is not available" });
        return;
      }

      res.json(resultsQueryService.listRecentRuns({
        channelId: typeof req.query.channelId === "string" ? req.query.channelId : undefined,
        limit: parsePositiveInt(req.query.limit, 50),
      }));
    });

    app.get("/api/results/runs/:runId/artifacts", (req, res) => {
      if (!resultsQueryService) {
        res.status(503).json({ error: "Results query service is not available" });
        return;
      }

      res.json(resultsQueryService.getRunArtifacts(req.params.runId));
    });

    app.get("/api/results/artifacts", (req, res) => {
      if (!resultsQueryService) {
        res.status(503).json({ error: "Results query service is not available" });
        return;
      }

      res.json(resultsQueryService.listRecentArtifacts({
        channelId: typeof req.query.channelId === "string" ? req.query.channelId : undefined,
        limit: parsePositiveInt(req.query.limit, 100),
      }));
    });

    // -- File download endpoint (for outbound attachments) -------------------

    app.get("/api/files", (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "Missing 'path' query parameter" });
        return;
      }

      // Security: only allow files under data/ directory
      const resolvedPath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(rootDir, filePath);
      const dataDir = path.resolve(rootDir, "data");
      if (!resolvedPath.startsWith(dataDir)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      if (!fs.existsSync(resolvedPath)) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const filename = path.basename(resolvedPath);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      fs.createReadStream(resolvedPath).pipe(res);
    });

    // -- Scheduler management API -------------------------------------------

    // Helper: get SchedulerAdapter from adapterMap
    const getScheduler = () => {
      const schedulerAdapter = ctx.adapterMap?.get("scheduler");
      if (!schedulerAdapter) return null;
      // Dynamic import type to avoid circular dep
      return schedulerAdapter as import("./scheduler.js").SchedulerAdapter;
    };

    app.get("/api/scheduler/jobs", (_req, res) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        res.json([]);
        return;
      }
      res.json(scheduler.listJobs());
    });

    app.post("/api/scheduler/jobs", (req, res) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        res.status(503).json({ success: false, message: "Scheduler not available" });
        return;
      }
      const { name, cron: cronExpr, prompt, notify, enabled, timezone } = req.body;
      if (!name || !cronExpr || !prompt || !notify?.adapter || !notify?.channelId) {
        res.status(400).json({
          success: false,
          message: "Required fields: name, cron, prompt, notify.adapter, notify.channelId",
        });
        return;
      }
      const result = scheduler.addJob({
        name,
        cron: cronExpr,
        prompt,
        notify,
        enabled: enabled !== false,
        timezone,
      });
      res.json(result);
    });

    app.delete("/api/scheduler/jobs/:name", (req, res) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        res.status(503).json({ success: false, message: "Scheduler not available" });
        return;
      }
      const result = scheduler.removeJob(req.params.name);
      res.json(result);
    });

    app.post("/api/scheduler/jobs/:name/trigger", async (req, res) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        res.status(503).json({ success: false, message: "Scheduler not available" });
        return;
      }
      const result = await scheduler.triggerJob(req.params.name);
      res.json(result);
    });

    app.patch("/api/scheduler/jobs/:name", (req, res) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        res.status(503).json({ success: false, message: "Scheduler not available" });
        return;
      }
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ success: false, message: "Field 'enabled' (boolean) is required" });
        return;
      }
      const result = scheduler.setEnabled(req.params.name, enabled);
      res.json(result);
    });

    // -- WebSocket ----------------------------------------------------------

    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (request.url?.startsWith("/api/chat")) {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws: WebSocket, request) => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host || "127.0.0.1"}`,
      );
      const _reqProvider =
        url.searchParams.get("provider") || currentProvider;

      const providerMeta = SUPPORTED_PROVIDERS[_reqProvider];
      const hasAuth = providerMeta?.authType === "oauth"
        ? agent.getAuthStorage().hasAuth(_reqProvider)
        : !!apiKey;

      if (!hasAuth) {
        ws.send(JSON.stringify({ error: "Please configure authentication first" }));
        ws.close();
        return;
      }

      const requestedChannelId = url.searchParams.get("channelId");
      const channelId =
        requestedChannelId && requestedChannelId === DEFAULT_WEB_CHANNEL_ID
          ? requestedChannelId
          : DEFAULT_WEB_CHANNEL_ID;

      this.handleWsConnection(ws, channelId, agent);
    });

    console.log("[WebAdapter] Started");
  }

  async stop(): Promise<void> {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }
    console.log("[WebAdapter] Stopped");
  }

  // -------------------------------------------------------------------------
  // WebSocket message handler
  // -------------------------------------------------------------------------

  private handleWsConnection(
    ws: WebSocket,
    channelId: string,
    agent: IPackAgent,
  ): void {
    ws.on("message", async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (!payload.text) return;

        const text: string = payload.text;

        // Check for bot commands
        const command = parseCommand(text);
        if (command) {
          const result = await agent.handleCommand(command, channelId);

          // sendWsEvent(ws, { type: "agent_start" });
          // sendWsEvent(ws, { type: "message_start", role: "assistant" });

          if (result.message) {
            sendWsEvent(ws, { type: "text_delta", delta: result.message });
          }

          // sendWsEvent(ws, { type: "message_end", role: "assistant" });
          // sendWsEvent(ws, { type: "agent_end" });
          ws.send(JSON.stringify({ done: true }));
          return;
        }

        // Regular message → stream events via WebSocket
        const onEvent = (event: AgentEvent) => {
          sendWsEvent(ws, event);
          this.ipcBroadcaster?.broadcastAgentEvent(channelId, event);
        };

        const result = await agent.handleMessage("web", channelId, text, onEvent);

        if (result.errorMessage) {
          ws.send(JSON.stringify({ error: result.errorMessage }));
          return;
        }

        ws.send(JSON.stringify({ done: true }));
      } catch (err) {
        ws.send(JSON.stringify({ error: String(err) }));
      }
    });

    ws.on("close", () => {
      if (channelId !== DEFAULT_WEB_CHANNEL_ID) {
        agent.dispose(channelId);
      }
    });
  }
}
