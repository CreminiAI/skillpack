import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";

import {
  handleWsConnection,
  promptSession,
  hasActiveWebSubscriber,
  broadcastToSession,
} from "./chat-proxy.js";

function getPackConfig(rootDir) {
  const raw = fs.readFileSync(path.join(rootDir, "skillpack.json"), "utf-8");
  return JSON.parse(raw);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function safeCompareHex(a, b) {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifySlackSignature(req, signingSecret) {
  if (!signingSecret) {
    return false;
  }

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) {
    return false;
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 60 * 5) {
    return false;
  }

  const rawBody = req.rawBody
    ? req.rawBody.toString("utf-8")
    : JSON.stringify(req.body || {});
  const base = `v0:${timestamp}:${rawBody}`;

  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex");
  const expected = `v0=${digest}`;

  return safeCompareHex(expected, String(signature));
}

function stripBotMention(text, botUserId) {
  if (!text || !botUserId) {
    return text || "";
  }

  const mention = `<@${botUserId}>`;
  return text.replaceAll(mention, "").trim();
}

async function slackApiCall(token, method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.error || "unknown_error"}`);
  }
  return json;
}

function isCommandAvailable(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function readCloudflaredHostname() {
  const configPath = path.join(os.homedir(), ".cloudflared", "config.yml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/hostname:\s*(\S+)/);
    if (match) {
      const hostname = match[1];
      return hostname.startsWith("http") ? hostname : `https://${hostname}`;
    }
  } catch {
    // config.yml not found or unreadable
  }
  return "";
}

function extractPublicUrl(line) {
  const matches = String(line).match(/https:\/\/[\w.-]+(?:\:[0-9]+)?(?:\/[^\s]*)?/g);
  if (!matches || matches.length === 0) {
    return "";
  }

  const tunnelUrl = matches.find(
    (u) =>
      u.includes("trycloudflare.com") ||
      u.includes("ngrok") ||
      u.includes("loca.lt"),
  );

  return tunnelUrl || matches[0];
}

export function registerRoutes(app, server, rootDir) {
  const runtimeDir = path.join(rootDir, ".skillpack-runtime");
  const runtimeConfigFile = path.join(runtimeDir, "runtime-config.json");
  const persistedRuntimeConfig = readJsonSafe(runtimeConfigFile, {});

  if (!persistedRuntimeConfig.slack || typeof persistedRuntimeConfig.slack !== "object") {
    persistedRuntimeConfig.slack = {};
  }
  if (!persistedRuntimeConfig.api || typeof persistedRuntimeConfig.api !== "object") {
    persistedRuntimeConfig.api = {};
  }
  if (!persistedRuntimeConfig.tunnel || typeof persistedRuntimeConfig.tunnel !== "object") {
    persistedRuntimeConfig.tunnel = {};
  }

  const persistedApiConfig = persistedRuntimeConfig.api || {};
  let apiKey = persistedApiConfig.key || "";
  let currentProvider = persistedApiConfig.provider || "openai";

  const persistedSlackConfig = persistedRuntimeConfig.slack || {};
  const slackConfig = {
    botToken: process.env.SLACK_BOT_TOKEN || persistedSlackConfig.botToken || "",
    signingSecret:
      process.env.SLACK_SIGNING_SECRET || persistedSlackConfig.signingSecret || "",
    appToken: process.env.SLACK_APP_TOKEN || persistedSlackConfig.appToken || "",
    eventsPath:
      process.env.SLACK_EVENTS_PATH ||
      persistedSlackConfig.eventsPath ||
      "/api/slack/events",
    useThread: persistedSlackConfig.useThread === true,
  };

  const mappingFile = path.join(runtimeDir, "slack-mappings.json");

  const mappingsState = readJsonSafe(mappingFile, { mappings: [] });
  const dedupe = new Map();
  let botUserId = process.env.SLACK_BOT_USER_ID || "";
  const persistedTunnelConfig = persistedRuntimeConfig.tunnel || {};
  let tunnelProcess = null;
  let tunnelState = {
    provider: "",
    port: 26313,
    tunnelName: persistedTunnelConfig.name || "",
    publicUrl: "",
    status: "stopped",
    startedAt: "",
    lastError: "",
  };
  let healthCache = {
    at: 0,
    value: null,
  };

  if (process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
    currentProvider = "openai";
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    currentProvider = "anthropic";
  }

  function persistMappings() {
    writeJsonSafe(mappingFile, mappingsState);
  }

  function persistApiConfig() {
    persistedRuntimeConfig.api = {
      key: apiKey,
      provider: currentProvider,
    };
    writeJsonSafe(runtimeConfigFile, persistedRuntimeConfig);
  }

  function persistSlackConfig() {
    persistedRuntimeConfig.slack = {
      botToken: slackConfig.botToken,
      signingSecret: slackConfig.signingSecret,
      appToken: slackConfig.appToken,
      eventsPath: slackConfig.eventsPath,
      useThread: slackConfig.useThread,
    };
    writeJsonSafe(runtimeConfigFile, persistedRuntimeConfig);
  }

  function persistTunnelConfig() {
    persistedRuntimeConfig.tunnel = {
      name: tunnelState.tunnelName || "",
    };
    writeJsonSafe(runtimeConfigFile, persistedRuntimeConfig);
  }

  function getTunnelStatus() {
    return {
      ...tunnelState,
      tunnelName: tunnelState.tunnelName || "",
      available: {
        ngrok: isCommandAvailable("ngrok"),
        cloudflared: isCommandAvailable("cloudflared"),
      },
      callbackUrl: tunnelState.publicUrl
        ? `${tunnelState.publicUrl}${slackConfig.eventsPath}`
        : "",
      eventsPath: slackConfig.eventsPath,
    };
  }

  async function getSlackHealth({ force = false } = {}) {
    const cacheTtlMs = 15 * 1000;
    const now = Date.now();
    if (!force && healthCache.value && now - healthCache.at < cacheTtlMs) {
      return healthCache.value;
    }

    const tunnel = getTunnelStatus();
    const checks = {
      apiKeyConfigured: !!apiKey,
      botTokenConfigured: !!slackConfig.botToken,
      signingSecretConfigured: !!slackConfig.signingSecret,
      tunnelRunning: tunnel.status === "running" && !!tunnel.publicUrl,
      callbackUrlReady: !!tunnel.callbackUrl,
      callbackUrl: tunnel.callbackUrl,
      eventsPath: slackConfig.eventsPath,
      slackAuthOk: false,
      slackTeam: "",
      slackBotUserId: botUserId || "",
      error: "",
    };

    if (checks.botTokenConfigured) {
      try {
        const auth = await slackApiCall(slackConfig.botToken, "auth.test", {});
        checks.slackAuthOk = !!auth.ok;
        checks.slackTeam = auth.team || "";
        checks.slackBotUserId = auth.user_id || checks.slackBotUserId;
        if (auth.user_id) {
          botUserId = auth.user_id;
        }
      } catch (err) {
        checks.slackAuthOk = false;
        checks.error = String(err?.message || err);
      }
    }

    const ok =
      checks.apiKeyConfigured &&
      checks.botTokenConfigured &&
      checks.signingSecretConfigured &&
      checks.tunnelRunning &&
      checks.callbackUrlReady &&
      checks.slackAuthOk;

    const result = {
      ok,
      checks,
      tunnel,
      generatedAt: new Date().toISOString(),
    };

    healthCache = {
      at: now,
      value: result,
    };

    return result;
  }

  function attachTunnelOutput(proc, isNamedTunnel) {
    const onData = (buf) => {
      const text = String(buf || "").trim();
      if (!text) return;

      if (isNamedTunnel) {
        if (text.includes("Registered tunnel connection") || text.includes("registered connIndex")) {
          tunnelState.status = "running";
          tunnelState.lastError = "";
        }
      } else {
        const maybeUrl = extractPublicUrl(text);
        if (maybeUrl && maybeUrl !== tunnelState.publicUrl) {
          tunnelState.publicUrl = maybeUrl;
          tunnelState.status = "running";
          tunnelState.lastError = "";
        }
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
  }

  function stopTunnel() {
    if (!tunnelProcess) {
      tunnelState.status = "stopped";
      tunnelState.publicUrl = "";
      return;
    }

    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
    tunnelState.status = "stopped";
    tunnelState.publicUrl = "";
    tunnelState.startedAt = "";
  }

  function startTunnel(provider, port, tunnelName) {
    const normalizedProvider = provider === "ngrok" ? "ngrok" : "cloudflared";
    const targetPort = Number(port) || 26313;
    const isNamedTunnel = !!(normalizedProvider === "cloudflared" && tunnelName);

    if (tunnelProcess) {
      stopTunnel();
    }

    if (!isCommandAvailable(normalizedProvider)) {
      tunnelState.status = "error";
      tunnelState.lastError = `${normalizedProvider} is not installed`;
      throw new Error(tunnelState.lastError);
    }

    let args;
    if (normalizedProvider === "ngrok") {
      args = ["http", String(targetPort), "--log", "stdout"];
    } else if (isNamedTunnel) {
      args = ["tunnel", "run", tunnelName];
    } else {
      args = ["tunnel", "--url", `http://127.0.0.1:${targetPort}`];
    }

    const command = normalizedProvider;

    const proc = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let presetUrl = "";
    if (isNamedTunnel) {
      presetUrl = readCloudflaredHostname();
    }

    tunnelProcess = proc;
    tunnelState = {
      provider: normalizedProvider,
      port: targetPort,
      tunnelName: tunnelName || "",
      publicUrl: presetUrl,
      status: "starting",
      startedAt: new Date().toISOString(),
      lastError: "",
    };

    attachTunnelOutput(proc, isNamedTunnel);
    persistTunnelConfig();

    proc.on("exit", (code, signal) => {
      const expectedStop = tunnelState.status === "stopped";
      tunnelProcess = null;
      tunnelState.status = expectedStop ? "stopped" : "error";
      tunnelState.lastError =
        expectedStop || code === 0
          ? ""
          : `Tunnel exited (code=${code ?? "?"}, signal=${signal ?? "none"})`;
      tunnelState.publicUrl = "";
    });
  }

  function findMappingBySessionId(sessionId) {
    return mappingsState.mappings.find((m) => m.sessionId === sessionId) || null;
  }

  function findMappingBySlackThread(channelId, threadTs) {
    return (
      mappingsState.mappings.find(
        (m) => m.channelId === channelId && m.threadTs === threadTs,
      ) || null
    );
  }

  function findLatestMappingByChannelId(channelId) {
    const matches = mappingsState.mappings.filter((m) => m.channelId === channelId);
    if (matches.length === 0) {
      return null;
    }

    matches.sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || "");
      const tb = Date.parse(b.updatedAt || b.createdAt || "");
      return tb - ta;
    });

    return matches[0] || null;
  }

  function findPreferredMappingByChannelId(channelId) {
    const matches = mappingsState.mappings.filter((m) => m.channelId === channelId);
    if (matches.length === 0) {
      return null;
    }

    const active = matches
      .filter((m) => hasActiveWebSubscriber(m.sessionId))
      .sort((a, b) => {
        const ta = Date.parse(a.updatedAt || a.createdAt || "");
        const tb = Date.parse(b.updatedAt || b.createdAt || "");
        return tb - ta;
      });

    if (active.length > 0) {
      return active[0];
    }

    return findLatestMappingByChannelId(channelId);
  }

  function upsertMapping({ sessionId, channelId, threadTs, source = "manual" }) {
    const now = new Date().toISOString();
    const existing = findMappingBySessionId(sessionId);

    if (existing) {
      existing.channelId = channelId;
      existing.threadTs = threadTs;
      existing.updatedAt = now;
      existing.source = source;
      persistMappings();
      return existing;
    }

    const created = {
      id: randomUUID(),
      sessionId,
      channelId,
      threadTs,
      source,
      createdAt: now,
      updatedAt: now,
    };

    mappingsState.mappings.push(created);
    persistMappings();
    return created;
  }

  function removeMappingBySessionId(sessionId) {
    const index = mappingsState.mappings.findIndex((m) => m.sessionId === sessionId);
    if (index < 0) {
      return null;
    }

    const [removed] = mappingsState.mappings.splice(index, 1);
    persistMappings();
    return removed || null;
  }

  function shouldSkipDuplicate(eventId) {
    if (!eventId) {
      return false;
    }

    const now = Date.now();
    const ttlMs = 10 * 60 * 1000;

    for (const [key, timestamp] of dedupe) {
      if (now - timestamp > ttlMs) {
        dedupe.delete(key);
      }
    }

    if (dedupe.has(eventId)) {
      return true;
    }

    dedupe.set(eventId, now);
    return false;
  }

  async function ensureBotUserId() {
    if (botUserId || !slackConfig.botToken) {
      return botUserId;
    }

    try {
      const auth = await slackApiCall(slackConfig.botToken, "auth.test", {});
      botUserId = auth.user_id || "";
      return botUserId;
    } catch (err) {
      console.error("[Slack] auth.test failed:", err);
      return "";
    }
  }

  async function postToSlack(channelId, threadTs, text) {
    if (!slackConfig.botToken || !channelId || !text?.trim()) {
      return;
    }

    const payload = { channel: channelId, text };
    if (slackConfig.useThread && threadTs) {
      payload.thread_ts = threadTs;
    }

    try {
      await slackApiCall(slackConfig.botToken, "chat.postMessage", payload);
    } catch (err) {
      console.error("[Slack] chat.postMessage failed:", err);
    }
  }

  async function listSlackChannels() {
    if (!slackConfig.botToken) {
      throw new Error("Slack bot token is not configured");
    }

    const channels = [];
    let cursor = "";

    do {
      const payload = {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
      };
      if (cursor) {
        payload.cursor = cursor;
      }

      const result = await slackApiCall(
        slackConfig.botToken,
        "conversations.list",
        payload,
      );

      for (const ch of result.channels || []) {
        channels.push({
          id: ch.id,
          name: ch.name,
          isPrivate: !!ch.is_private,
        });
      }

      cursor = result.response_metadata?.next_cursor || "";
    } while (cursor);

    channels.sort((a, b) => a.name.localeCompare(b.name));
    return channels;
  }

  async function getSlackThreadPermalink(channelId, messageTs) {
    if (!slackConfig.botToken || !channelId || !messageTs) {
      return "";
    }

    try {
      const result = await slackApiCall(slackConfig.botToken, "chat.getPermalink", {
        channel: channelId,
        message_ts: messageTs,
      });
      return result.permalink || "";
    } catch {
      return "";
    }
  }

  app.get("/api/config", (req, res) => {
    const config = getPackConfig(rootDir);
    res.json({
      name: config.name,
      description: config.description,
      prompts: config.prompts || [],
      skills: config.skills || [],
      hasApiKey: !!apiKey,
      provider: currentProvider,
      hasSlackConfig: !!(slackConfig.botToken && slackConfig.signingSecret),
    });
  });

  app.get("/api/slack/config", (req, res) => {
    res.json({
      hasBotToken: !!slackConfig.botToken,
      hasSigningSecret: !!slackConfig.signingSecret,
      hasAppToken: !!slackConfig.appToken,
      eventsPath: slackConfig.eventsPath,
      useThread: slackConfig.useThread,
    });
  });

  app.post("/api/slack/config", (req, res) => {
    const { botToken, signingSecret, appToken, eventsPath, useThread } = req.body || {};

    if (typeof botToken === "string") {
      slackConfig.botToken = botToken.trim();
      botUserId = "";
    }
    if (typeof signingSecret === "string") {
      slackConfig.signingSecret = signingSecret.trim();
    }
    if (typeof appToken === "string") {
      slackConfig.appToken = appToken.trim();
    }
    if (typeof eventsPath === "string" && eventsPath.trim()) {
      const normalized = eventsPath.trim();
      slackConfig.eventsPath = normalized.startsWith("/")
        ? normalized
        : `/${normalized}`;
    }
    if (typeof useThread === "boolean") {
      slackConfig.useThread = useThread;
    }

    persistSlackConfig();

    res.json({
      success: true,
      hasBotToken: !!slackConfig.botToken,
      hasSigningSecret: !!slackConfig.signingSecret,
      hasAppToken: !!slackConfig.appToken,
      eventsPath: slackConfig.eventsPath,
      note:
        "If eventsPath changed, update Slack callback URL to match and restart app if you use a non-default path.",
    });
  });

  app.get("/api/tunnel/status", (req, res) => {
    res.json(getTunnelStatus());
  });

  app.post("/api/tunnel/start", (req, res) => {
    const provider = String(req.body?.provider || "cloudflared");
    const port = Number(req.body?.port) || 26313;
    const tunnelName = String(req.body?.tunnelName || "").trim();

    try {
      startTunnel(provider, port, tunnelName || undefined);
      res.json({ success: true, ...getTunnelStatus() });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: String(err?.message || err),
        ...getTunnelStatus(),
      });
    }
  });

  app.post("/api/tunnel/stop", (_req, res) => {
    stopTunnel();
    res.json({ success: true, ...getTunnelStatus() });
  });

  app.get("/api/slack/health", async (req, res) => {
    const force = String(req.query?.refresh || "") === "1";
    const health = await getSlackHealth({ force });
    res.json(health);
  });

  app.get("/api/slack/mappings", async (req, res) => {
    const sessionId = String(req.query?.sessionId || "").trim();
    if (sessionId) {
      const mapping = findMappingBySessionId(sessionId);
      if (!mapping) {
        return res.json({ mappings: [] });
      }

      const permalink = await getSlackThreadPermalink(
        mapping.channelId,
        mapping.threadTs,
      );
      return res.json({ mappings: [{ ...mapping, permalink }] });
    }

    res.json({ mappings: mappingsState.mappings });
  });

  app.get("/api/slack/channels", async (_req, res) => {
    try {
      const channels = await listSlackChannels();
      res.json({ channels });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/slack/bind-session", async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const channelId = String(req.body?.channelId || "").trim();
    const introText =
      String(req.body?.introText || "").trim() ||
      "Web session bound to this Slack thread.";

    if (!sessionId || !channelId) {
      return res.status(400).json({
        error: "sessionId and channelId are required",
      });
    }

    if (!slackConfig.botToken) {
      return res.status(400).json({
        error: "Slack bot token is not configured",
      });
    }

    try {
      const posted = await slackApiCall(slackConfig.botToken, "chat.postMessage", {
        channel: channelId,
        text: introText,
      });

      const mapping = upsertMapping({
        sessionId,
        channelId,
        threadTs: posted.ts,
        source: "manual-ui",
      });

      const permalink = await getSlackThreadPermalink(channelId, posted.ts);

      res.json({
        success: true,
        mapping: { ...mapping, permalink },
        channelId,
        threadTs: posted.ts,
        permalink,
      });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/slack/unbind-session", (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const removed = removeMappingBySessionId(sessionId);
    res.json({ success: true, removed: !!removed });
  });

  app.post("/api/slack/mappings", (req, res) => {
    const { sessionId, channelId, threadTs } = req.body || {};

    if (!sessionId || !channelId || !threadTs) {
      return res.status(400).json({
        error: "sessionId, channelId, and threadTs are required",
      });
    }

    const mapping = upsertMapping({
      sessionId: String(sessionId),
      channelId: String(channelId),
      threadTs: String(threadTs),
      source: "manual",
    });

    res.json({ success: true, mapping });
  });

  app.post(slackConfig.eventsPath, async (req, res) => {
    const body = req.body || {};

    // Slack Request URL verification expects a direct challenge response.
    if (body.type === "url_verification") {
      return res.json({ challenge: body.challenge });
    }

    if (!verifySlackSignature(req, slackConfig.signingSecret)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    if (body.type !== "event_callback") {
      return res.json({ ok: true });
    }

    if (shouldSkipDuplicate(body.event_id)) {
      return res.json({ ok: true, duplicate: true });
    }

    const event = body.event || {};
    const eventType = String(event.type || "");
    if (eventType !== "message" && eventType !== "app_mention") {
      return res.json({ ok: true });
    }

    if (event.subtype || event.bot_id) {
      return res.json({ ok: true });
    }

    if (!apiKey) {
      await postToSlack(
        event.channel,
        "I am not configured with an AI API key yet. Please set it in the web UI first.",
      );
      return res.json({ ok: true });
    }

    const resolvedBotUserId = await ensureBotUserId();
    const mentionToken = resolvedBotUserId ? `<@${resolvedBotUserId}>` : "";
    const isMention =
      eventType === "app_mention" ||
      (mentionToken ? (event.text || "").includes(mentionToken) : false);
    let rootThreadTs = event.thread_ts || event.ts;

    let mapping = findMappingBySlackThread(event.channel, rootThreadTs);
    if (!mapping && !event.thread_ts) {
      // For plain channel messages (with or without @mention), reuse the
      // latest mapped session in this channel to keep Slack->Web continuity.
      mapping = findPreferredMappingByChannelId(event.channel);
      if (mapping) {
        rootThreadTs = mapping.threadTs;
      }
    }

    if (!mapping && !isMention) {
      return res.json({ ok: true });
    }

    if (!mapping) {
      mapping = upsertMapping({
        sessionId: randomUUID(),
        channelId: event.channel,
        threadTs: rootThreadTs,
        source: "slack-auto",
      });
    }

    const promptText = stripBotMention(event.text || "", resolvedBotUserId);
    if (!promptText) {
      return res.json({ ok: true });
    }

    const modelId =
      currentProvider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";

    broadcastToSession(mapping.sessionId, {
      type: "slack_user_message",
      text: promptText,
    });

    const result = await promptSession(
      {
        sessionId: mapping.sessionId,
        apiKey,
        rootDir,
        provider: currentProvider,
        modelId,
      },
      promptText,
    );

    if (!result.ok) {
      broadcastToSession(mapping.sessionId, {
        type: "slack_assistant_response",
        text: `Error: ${result.error || "assistant request failed"}`,
        isError: true,
      });
      await postToSlack(
        event.channel,
        rootThreadTs,
        `Error: ${result.error || "assistant request failed"}`,
      );
      return res.json({ ok: true });
    }

    if (result.assistantText) {
      broadcastToSession(mapping.sessionId, {
        type: "slack_assistant_response",
        text: result.assistantText,
      });
      await postToSlack(event.channel, rootThreadTs, result.assistantText);
    }

    return res.json({ ok: true });
  });

  app.get("/api/skills", (req, res) => {
    const config = getPackConfig(rootDir);
    res.json(config.skills || []);
  });

  app.post("/api/config/key", (req, res) => {
    const { key, provider } = req.body;
    if (!key) {
      return res.status(400).json({ error: "API key is required" });
    }
    apiKey = key;
    if (provider) {
      currentProvider = provider;
    }
    persistApiConfig();
    res.json({ success: true, provider: currentProvider });
  });

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
    const url = new URL(
      request.url,
      `http://${request.headers.host || "127.0.0.1"}`,
    );
    const reqProvider = url.searchParams.get("provider") || currentProvider;
    const sessionId = url.searchParams.get("sessionId") || randomUUID();

    if (!apiKey) {
      ws.send(JSON.stringify({ error: "Please set an API key first" }));
      ws.close();
      return;
    }

    const modelId = reqProvider === "anthropic" ? "claude-opus-4-6" : "gpt-5.4";

    handleWsConnection(ws, {
      sessionId,
      apiKey,
      rootDir,
      provider: reqProvider,
      modelId,
      onUserMessage: ({ sessionId: sid, text }) => {
        const mapping = findMappingBySessionId(sid);
        if (!mapping) {
          return;
        }

        postToSlack(
          mapping.channelId,
          mapping.threadTs,
          `Web user: ${text}`,
        );
      },
      onAssistantFinal: ({ sessionId: sid, text }) => {
        const mapping = findMappingBySessionId(sid);
        if (!mapping) {
          return;
        }

        postToSlack(mapping.channelId, mapping.threadTs, text);
      },
    });
  });

  app.delete("/api/chat", (req, res) => {
    res.json({ success: true });
  });
}
