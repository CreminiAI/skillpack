import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

import { handleWsConnection } from "./chat-proxy.js";

/**
 * Read the app.json config.
 * @param {string} rootDir
 */
function getPackConfig(rootDir) {
  const raw = fs.readFileSync(path.join(rootDir, "app.json"), "utf-8");
  return JSON.parse(raw);
}

/**
 * Register all API routes.
 * @param {import("express").Express} app
 * @param {import("node:http").Server} server
 * @param {string} rootDir - Root directory containing app.json and skills/
 */
export function registerRoutes(app, server, rootDir) {
  // API key and provider are stored in runtime memory
  let apiKey = "";
  let currentProvider = "openai";

  if (process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
    currentProvider = "openai";
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    currentProvider = "anthropic";
  }

  // Get pack config
  app.get("/api/config", (req, res) => {
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

  // Get skills list
  app.get("/api/skills", (req, res) => {
    const config = getPackConfig(rootDir);
    res.json(config.skills || []);
  });

  // Set API key
  app.post("/api/config/key", (req, res) => {
    const { key, provider } = req.body;
    if (!key) {
      return res.status(400).json({ error: "API key is required" });
    }
    apiKey = key;
    if (provider) {
      currentProvider = provider;
    }
    res.json({ success: true, provider: currentProvider });
  });

  // WebSocket chat service
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request.url.startsWith("/api/chat")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const reqProvider = url.searchParams.get("provider") || currentProvider;

    if (!apiKey) {
      ws.send(JSON.stringify({ error: "Please set an API key first" }));
      ws.close();
      return;
    }

    const config = getPackConfig(rootDir);

    const modelId = reqProvider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";

    handleWsConnection(ws, { apiKey, rootDir, provider: reqProvider, modelId });
  });

  // Clear session
  app.delete("/api/chat", (req, res) => {
    res.json({ success: true });
  });
}
