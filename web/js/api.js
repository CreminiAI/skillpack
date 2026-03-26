import { state } from "./config.js";

// ---------------------------------------------------------------------------
// Config API (adapters, model selection — no auth)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auth API — API Key
// ---------------------------------------------------------------------------

export async function saveAuthApiKey(provider, apiKey) {
  const res = await fetch(state.API_BASE + "/api/auth/apikey", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
  if (!res.ok) {
    throw new Error("Save API Key Failed");
  }
  return await res.json();
}

export async function deleteAuthApiKey(provider) {
  const res = await fetch(state.API_BASE + "/api/auth/apikey", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    throw new Error("Delete API Key Failed");
  }
  return await res.json();
}

export async function getAuthStatus() {
  const res = await fetch(state.API_BASE + "/api/auth/status");
  if (!res.ok) {
    throw new Error("Get Auth Status Failed");
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Auth API — OAuth
// ---------------------------------------------------------------------------

export async function getOAuthProviders() {
  const res = await fetch(state.API_BASE + "/api/auth/oauth/providers");
  if (!res.ok) {
    throw new Error("Get OAuth Providers Failed");
  }
  return await res.json();
}

export async function startOAuthLogin(provider) {
  const res = await fetch(state.API_BASE + "/api/auth/oauth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    throw new Error("Start OAuth Login Failed");
  }
  return await res.json();
}

export async function getOAuthLoginStatus() {
  const res = await fetch(state.API_BASE + "/api/auth/oauth/status");
  if (!res.ok) {
    throw new Error("Get OAuth Status Failed");
  }
  return await res.json();
}

export async function logoutOAuth(provider) {
  const res = await fetch(state.API_BASE + "/api/auth/oauth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    throw new Error("OAuth Logout Failed");
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

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
