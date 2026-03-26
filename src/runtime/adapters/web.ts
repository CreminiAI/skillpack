import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { configManager, parseModelSpec } from "../config.js";
import type { DataConfig } from "../config.js";
import { authManager } from "../auth-manager.js";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  BotCommand,
  IPackAgent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPackConfig(rootDir: string): any {
  const raw = fs.readFileSync(path.join(rootDir, "skillpack.json"), "utf-8");
  return JSON.parse(raw);
}

const COMMANDS: Record<string, BotCommand> = {
  "/new": "new",
  "/clear": "clear",
  "/restart": "restart",
  "/shutdown": "shutdown",
};

function parseCommand(text: string): BotCommand | null {
  const trimmed = text.trim().toLowerCase();
  return COMMANDS[trimmed] ?? null;
}

function getRuntimeConfigSignature(config: DataConfig): string {
  return JSON.stringify({
    model: config.model || "",
    telegramToken: config.adapters?.telegram?.token || "",
    slackBotToken: config.adapters?.slack?.botToken || "",
    slackAppToken: config.adapters?.slack?.appToken || "",
  });
}

// ---------------------------------------------------------------------------
// WebAdapter
// ---------------------------------------------------------------------------

export class WebAdapter implements PlatformAdapter {
  readonly name = "web";

  private wss: WebSocketServer | null = null;
  private agent: IPackAgent | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    const { agent, server, app, rootDir, lifecycle, modelRegistry } = ctx;
    this.agent = agent;

    // -- HTTP API routes ----------------------------------------------------

    app.get("/api/config", (_req, res) => {
      const config = getPackConfig(rootDir);
      const conf = configManager.getConfig();

      // Build available models list from ModelRegistry
      const availableModels = modelRegistry
        ? modelRegistry.getAll().map((m: any) => ({
            id: `${m.provider}/${m.id}`,
            provider: m.provider,
            modelId: m.id,
            name: m.name || m.id,
            hasAuth: authManager.hasAuth(m.provider),
          }))
        : [];

      // Determine current model spec and whether auth is set up
      const currentModel = conf.model || "";
      const parsed = currentModel ? parseModelSpec(currentModel) : null;
      const currentProvider = parsed?.provider || "";
      const hasAuth = currentProvider ? authManager.hasAuth(currentProvider) : false;

      res.json({
        name: config.name,
        description: config.description,
        prompts: config.prompts || [],
        skills: config.skills || [],
        model: currentModel,
        hasAuth,
        availableModels,
        adapters: conf.adapters || {},
        runtimeControl: lifecycle.getRuntimeControl(),
      });
    });

    app.get("/api/skills", (_req, res) => {
      const config = getPackConfig(rootDir);
      res.json(config.skills || []);
    });

    app.post("/api/config/update", (req, res) => {
      const { model, adapters } = req.body;
      const updates: any = {};
      const beforeConfig = JSON.parse(JSON.stringify(configManager.getConfig()));

      if (model !== undefined) {
        updates.model = model;
      }
      if (adapters !== undefined) {
        updates.adapters = adapters;
      }

      configManager.save(rootDir, updates);

      const newConf = configManager.getConfig();
      const requiresRestart =
        getRuntimeConfigSignature(beforeConfig) !==
        getRuntimeConfigSignature(newConf);
      res.json({
        success: true,
        model: newConf.model,
        adapters: newConf.adapters,
        requiresRestart,
        runtimeControl: lifecycle.getRuntimeControl(),
      });
    });

    app.post("/api/runtime/restart", async (_req, res) => {
      const runtimeControl = lifecycle.getRuntimeControl();
      if (!runtimeControl.canManagedRestart) {
        res.status(409).json({
          success: false,
          message: "Managed restart is unavailable for this process.",
          runtimeControl,
        });
        return;
      }

      const result = await lifecycle.requestRestart("web");
      res.status(202).json({ ...result, runtimeControl });
    });

    app.delete("/api/chat", (_req, res) => {
      res.json({ success: true });
    });

    // -- Auth management API -------------------------------------------------

    app.get("/api/auth/status", (_req, res) => {
      res.json({
        providers: authManager.listProvidersWithTypes(),
      });
    });

    app.post("/api/auth/apikey", (req, res) => {
      const { provider, apiKey } = req.body;
      if (!provider || !apiKey) {
        res.status(400).json({ success: false, message: "provider and apiKey are required" });
        return;
      }
      authManager.setApiKey(provider, apiKey);
      res.json({ success: true, provider, requiresRestart: true, runtimeControl: lifecycle.getRuntimeControl() });
    });

    app.delete("/api/auth/apikey", (req, res) => {
      const { provider } = req.body;
      if (!provider) {
        res.status(400).json({ success: false, message: "provider is required" });
        return;
      }
      authManager.removeAuth(provider);
      res.json({ success: true });
    });

    app.get("/api/auth/oauth/providers", (_req, res) => {
      const storage = authManager.getAuthStorage();
      const oauthProviders = storage.getOAuthProviders().map((p) => ({
        id: p.id,
        name: p.name,
      }));
      res.json(oauthProviders);
    });

    // OAuth login state tracking
    let oauthLoginState: {
      status: "idle" | "pending" | "completed" | "error";
      providerId?: string;
      authUrl?: string;
      error?: string;
    } = { status: "idle" };

    app.post("/api/auth/oauth/login", async (req, res) => {
      const { provider: providerId } = req.body;
      if (!providerId) {
        res.status(400).json({ success: false, message: "provider is required" });
        return;
      }

      oauthLoginState = { status: "pending", providerId };

      const storage = authManager.getAuthStorage();
      try {
        // Start login — non-blocking from the HTTP perspective
        const loginPromise = storage.login(providerId, {
          onAuth: (info) => {
            oauthLoginState.authUrl = info.url;
          },
          onPrompt: async (prompt) => {
            // For device code flows that need user input
            return "";
          },
          onProgress: (message) => {
            console.log(`[OAuth] ${message}`);
          },
        });

        // Wait briefly for authUrl to be populated
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Return the auth URL immediately
        res.json({
          success: true,
          authUrl: oauthLoginState.authUrl,
          status: "pending",
        });

        // Let login complete in background
        loginPromise
          .then(() => {
            oauthLoginState = { status: "completed", providerId };
            console.log(`[OAuth] Login completed for ${providerId}`);
          })
          .catch((err) => {
            oauthLoginState = {
              status: "error",
              providerId,
              error: String(err),
            };
            console.error(`[OAuth] Login failed for ${providerId}:`, err);
          });
      } catch (err) {
        oauthLoginState = {
          status: "error",
          providerId,
          error: String(err),
        };
        res.status(500).json({ success: false, message: String(err) });
      }
    });

    app.get("/api/auth/oauth/status", (_req, res) => {
      res.json(oauthLoginState);
    });

    app.post("/api/auth/oauth/logout", (req, res) => {
      const { provider: providerId } = req.body;
      if (!providerId) {
        res.status(400).json({ success: false, message: "provider is required" });
        return;
      }
      authManager.removeAuth(providerId);
      oauthLoginState = { status: "idle" };
      res.json({ success: true });
    });

    // -- Reserved: session history endpoints (stub) -------------------------

    app.get("/api/sessions", (_req, res) => {
      const sessions = agent.listSessions();
      res.json(sessions);
    });

    app.get("/api/sessions/:id", (_req, res) => {
      // TODO: restore session by id
      res.status(501).json({ error: "Not implemented yet" });
    });

    // -- File download endpoint (for outbound attachments) -------------------

    app.get("/api/files", (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "Missing 'path' query parameter" });
        return;
      }

      // Security: only allow files under data/ directory
      const resolvedPath = path.resolve(filePath);
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
      // Check that at least one provider has auth configured
      const conf = configManager.getConfig();
      const parsed = conf.model ? parseModelSpec(conf.model) : null;
      const hasAuth = parsed ? authManager.hasAuth(parsed.provider) : authManager.listProviders().length > 0;

      if (!hasAuth) {
        ws.send(JSON.stringify({ error: "Please configure authentication first" }));
        ws.close();
        return;
      }

      // Each WebSocket connection maps to a unique channel
      const channelId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
          ws.send(
            JSON.stringify({
              type: "command_result",
              command,
              ...result,
            }),
          );
          if (command === "clear" || command === "new") {
            ws.send(JSON.stringify({ done: true }));
          }
          return;
        }

        // Regular message → stream events via WebSocket
        const onEvent = (event: AgentEvent) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify(event));
        };

        const result = await agent.handleMessage(channelId, text, onEvent);

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
      agent.dispose(channelId);
    });
  }
}
