/**
 * API Key Dialog Module
 * 
 * 负责 Model 认证配置管理。支持 API Key 模式和 OAuth 模式切换。
 */
import { state } from "./config.js";
import { saveConfigData, restartRuntime } from "./api.js";

// --- DOM Elements ---
let dialog;
let openBtn;
let closeBtn;
let saveBtn;
let restartBtn;
let providerSelect;
let apiKeyInput;
let baseUrlInput;
let baseUrlGroup;
let apikeySection;
let oauthSection;
let oauthLoginBtn;
let oauthLogoutBtn;
let oauthStatusIndicator;
let oauthStatusText;
let statusEl;

// --- Public API ---

export function initApiKeyDialog() {
  dialog = document.getElementById("apikey-dialog");
  openBtn = document.getElementById("open-apikey-btn");
  closeBtn = document.getElementById("close-apikey-btn");
  saveBtn = document.getElementById("save-apikey-btn");
  restartBtn = document.getElementById("restart-apikey-btn");
  providerSelect = document.getElementById("apikey-provider-select");
  apiKeyInput = document.getElementById("apikey-input");
  baseUrlInput = document.getElementById("apikey-baseurl-input");
  baseUrlGroup = document.getElementById("apikey-baseurl-group");
  apikeySection = document.getElementById("apikey-apikey-section");
  oauthSection = document.getElementById("apikey-oauth-section");
  oauthLoginBtn = document.getElementById("oauth-login-btn");
  oauthLogoutBtn = document.getElementById("oauth-logout-btn");
  oauthStatusIndicator = document.getElementById("oauth-status-indicator");
  oauthStatusText = document.getElementById("oauth-status-text");
  statusEl = document.getElementById("apikey-status");

  if (!dialog) return;

  if (openBtn) {
    openBtn.addEventListener("click", open);
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", close);
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", handleSave);
  }
  if (restartBtn) {
    restartBtn.addEventListener("click", handleRestart);
  }
  if (providerSelect) {
    providerSelect.addEventListener("change", updateProviderUI);
  }
  if (oauthLoginBtn) {
    oauthLoginBtn.addEventListener("click", handleOAuthLogin);
  }
  if (oauthLogoutBtn) {
    oauthLogoutBtn.addEventListener("click", handleOAuthLogout);
  }
}

/**
 * 根据当前连接状态更新按钮外观
 */
export function updateApiKeyButton() {
  if (!openBtn) return;
  const config = state.config;
  const currentProvider = config?.provider || "openai";
  const meta = config?.supportedProviders?.[currentProvider];
  
  const connected = meta?.authType === "oauth" 
    ? config?.oauthConnected 
    : config?.hasApiKey;

  if (connected) {
    openBtn.classList.add("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Model Configured";
  } else {
    openBtn.classList.remove("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Provide Model Auth";
  }
}

// --- Internal Helpers ---

function open() {
  populateForm();
  dialog.showModal();
}

function close() {
  dialog.close();
  setStatus("", "");
}

function populateForm() {
  const config = state.config;
  if (!config) return;

  // Provider
  if (config.provider && providerSelect) {
    providerSelect.value = config.provider;
  }
  updateProviderUI();

  setStatus("", "");

  // API Key & BaseURL
  if (config.hasApiKey && config.apiKey) {
    apiKeyInput.value = config.apiKey;
  } else if (config.hasApiKey) {
    apiKeyInput.value = "***************************************************";
  } else {
    apiKeyInput.value = "";
  }
  if (baseUrlInput) {
    baseUrlInput.value = config.baseUrl || "";
  }

  // OAuth Status
  if (config.oauthConnected) {
    updateOAuthUI(true);
  } else {
    updateOAuthUI(false);
  }
}

function updateProviderUI() {
  if (!providerSelect) return;
  const p = providerSelect.value;
  const meta = state.config?.supportedProviders?.[p];
  
  if (!meta) return;

  if (meta.authType === "oauth") {
    // Show OAuth section, hide API Key section
    if (apikeySection) apikeySection.style.display = "none";
    if (oauthSection) oauthSection.style.display = "";
    if (saveBtn) saveBtn.style.display = "none";
    checkOAuthStatus();
  } else {
    // Show API Key section, hide OAuth section
    if (apikeySection) apikeySection.style.display = "";
    if (oauthSection) oauthSection.style.display = "none";
    if (saveBtn) saveBtn.style.display = "";
    
    // Toggle BaseURL input
    if (baseUrlGroup) {
      baseUrlGroup.style.display = meta.supportsBaseUrl ? "" : "none";
    }

    if (baseUrlInput) {
      baseUrlInput.placeholder =
        meta.baseUrlPlaceholder || "https://api.openai.com/v1";
    }
    
    // Update placeholder
    if (apiKeyInput) {
      apiKeyInput.placeholder = meta.placeholder || "sk-...";
    }
  }
}

async function handleSave() {
  const key = apiKeyInput.value.trim();
  const provider = providerSelect.value;
  const baseUrl = baseUrlInput.value.trim();

  // If OAuth is selected, we don't handle it here but it shouldn't happen as save button is hidden
  const meta = state.config?.supportedProviders?.[provider];
  if (meta?.authType === "oauth") return;

  const updates = { provider };
  if (baseUrl !== state.config.baseUrl) {
    updates.baseUrl = baseUrl;
  }
  
  if (key && key !== "***************************************************" && key !== state.config.apiKey) {
    updates.key = key;
  }

  try {
    saveBtn.disabled = true;
    const res = await saveConfigData(updates);

    state.config.provider = res.provider;
    state.config.baseUrl = res.baseUrl || "";
    if (updates.key) {
      state.config.hasApiKey = true;
      state.config.apiKey = updates.key;
    }
    
    populateForm();
    state.restartRequired = !!res.requiresRestart;
    updateApiKeyButton();

    if (res.requiresRestart) {
      setStatus("Settings saved. Restart service to apply changes.", "warning");
      updateRestartButton(true);
    } else {
      setStatus("Settings saved successfully", "success");
      setTimeout(() => close(), 1200);
    }
  } catch (err) {
    setStatus("Save failed: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleOAuthLogin() {
  const provider = providerSelect.value;
  oauthLoginBtn.disabled = true;
  setStatus("Starting OAuth login...", "warning");

  try {
    // Ensure provider is saved first
    await saveConfigData({ provider });
    
    const res = await fetch("/api/oauth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const data = await res.json();

    if (data.authUrl) {
      window.open(data.authUrl, "_blank");
      setStatus("Waiting for authorization in browser...", "warning");
      pollOAuthStatus();
    } else {
      setStatus("OAuth process started. Check terminal for URL if browser didn't open.", "warning");
      pollOAuthStatus();
    }
  } catch (err) {
    setStatus("Login failed: " + err.message, "error");
    oauthLoginBtn.disabled = false;
  }
}

async function handleOAuthLogout() {
  const provider = providerSelect.value;
  try {
    await fetch("/api/oauth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    updateOAuthUI(false);
    state.config.oauthConnected = false;
    updateApiKeyButton();
    setStatus("Logged out successfully", "success");
  } catch (err) {
    setStatus("Logout failed: " + err.message, "error");
  }
}

async function checkOAuthStatus() {
  try {
    const res = await fetch("/api/oauth/status");
    const { connected } = await res.json();
    updateOAuthUI(connected);
    state.config.oauthConnected = connected;
    updateApiKeyButton();
  } catch (err) {
    console.error("Failed to check OAuth status:", err);
  }
}

function pollOAuthStatus() {
  const interval = setInterval(async () => {
    const res = await fetch("/api/oauth/status");
    const { connected } = await res.json();
    if (connected) {
      clearInterval(interval);
      updateOAuthUI(true);
      state.config.oauthConnected = true;
      state.restartRequired = true;
      updateApiKeyButton();
      setStatus("Connected successfully!", "success");
      updateRestartButton(true);
    }
  }, 2000);
  
  // Timeout after 5 minutes
  setTimeout(() => clearInterval(interval), 300000);
}

function updateOAuthUI(connected) {
  if (connected) {
    if (oauthStatusIndicator) {
      oauthStatusIndicator.classList.remove("oauth-disconnected");
      oauthStatusIndicator.classList.add("oauth-connected");
    }
    if (oauthStatusText) oauthStatusText.textContent = "Connected";
    if (oauthLoginBtn) oauthLoginBtn.style.display = "none";
    if (oauthLogoutBtn) oauthLogoutBtn.style.display = "";
  } else {
    if (oauthStatusIndicator) {
      oauthStatusIndicator.classList.add("oauth-disconnected");
      oauthStatusIndicator.classList.remove("oauth-connected");
    }
    if (oauthStatusText) oauthStatusText.textContent = "Not Connected";
    if (oauthLoginBtn) {
      oauthLoginBtn.style.display = "";
      oauthLoginBtn.disabled = false;
    }
    if (oauthLogoutBtn) oauthLogoutBtn.style.display = "none";
  }
}

async function handleRestart() {
  if (!restartBtn) return;

  restartBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  setStatus("Restarting service...", "warning");

  try {
    await restartRuntime();
    setTimeout(() => {
      window.location.reload();
    }, 6000);
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false;
    restartBtn.disabled = false;
    setStatus("Restart failed: " + err.message, "error");
  }
}

function updateRestartButton(show) {
  if (!restartBtn) return;
  restartBtn.hidden = !show;
  restartBtn.disabled = false;
}

function setStatus(message, status) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = status ? `status-text ${status}` : "status-text";
}
