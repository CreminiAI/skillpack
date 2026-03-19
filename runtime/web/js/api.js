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
