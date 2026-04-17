import { state } from "./config.js";

export async function saveConfigData(updates) {
  const res = await fetch(state.API_BASE + "/api/config/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error("Save Config Failed");
  }
  return await res.json();
}

export async function restartRuntime() {
  const res = await fetch(state.API_BASE + "/api/runtime/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.message || "Restart Failed");
  }
  return payload;
}

export async function listConversations() {
  const res = await fetch(state.API_BASE + "/api/conversations");
  if (!res.ok) {
    throw new Error("Load Conversations Failed");
  }
  return await res.json();
}

export async function createConversation() {
  const res = await fetch(state.API_BASE + "/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error("Create Conversation Failed");
  }
  return await res.json();
}

export async function getConversationMessages(channelId, limit = 200) {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(
    state.API_BASE + `/api/conversations/${encodeURIComponent(channelId)}/messages?${params.toString()}`,
  );
  if (!res.ok) {
    throw new Error("Load Conversation Messages Failed");
  }
  return await res.json();
}
