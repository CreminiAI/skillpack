import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

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
  "/clear": "clear",
  "/restart": "restart",
  "/shutdown": "shutdown",
};

function parseCommand(text: string): BotCommand | null {
  const trimmed = text.trim().toLowerCase();
  return COMMANDS[trimmed] ?? null;
}

// ---------------------------------------------------------------------------
// WebAdapter
// ---------------------------------------------------------------------------

export class WebAdapter implements PlatformAdapter {
  readonly name = "web";

  private wss: WebSocketServer | null = null;
  private agent: IPackAgent | null = null;

  async start(ctx: AdapterContext): Promise<void> {
    const { agent, server, app, rootDir } = ctx;
    this.agent = agent;

    // -- API key & provider (in-memory, can be overridden by frontend) ------

    // Read from data/config.json first
    let apiKey = "";
    let currentProvider = "openai";

    const configPath = path.join(rootDir, "data", "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const dataConfig = JSON.parse(
          fs.readFileSync(configPath, "utf-8"),
        );
        if (dataConfig.apiKey) apiKey = dataConfig.apiKey;
        if (dataConfig.provider) currentProvider = dataConfig.provider;
      } catch {
        // ignore malformed config
      }
    }

    // Environment variables override config file
    if (process.env.OPENAI_API_KEY) {
      apiKey = process.env.OPENAI_API_KEY;
      currentProvider = "openai";
    } else if (process.env.ANTHROPIC_API_KEY) {
      apiKey = process.env.ANTHROPIC_API_KEY;
      currentProvider = "anthropic";
    }

    // -- HTTP API routes ----------------------------------------------------

    app.get("/api/config", (_req, res) => {
      const config = getPackConfig(rootDir);
      res.json({
        name: config.name,
        description: config.description,
        prompts: config.prompts || [],
        skills: config.skills || [],
        hasApiKey: !!apiKey,
        provider: currentProvider,
      });
    });

    app.get("/api/skills", (_req, res) => {
      const config = getPackConfig(rootDir);
      res.json(config.skills || []);
    });

    app.post("/api/config/key", (req, res) => {
      const { key, provider } = req.body;
      if (!key) {
        res.status(400).json({ error: "API key is required" });
        return;
      }
      apiKey = key;
      if (provider) currentProvider = provider;
      res.json({ success: true, provider: currentProvider });
    });

    app.delete("/api/chat", (_req, res) => {
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

      if (!apiKey) {
        ws.send(JSON.stringify({ error: "Please set an API key first" }));
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
          if (command === "clear") {
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
