/**
 * Auth Dialog Module
 *
 * Manages authentication configuration: API Key and OAuth login.
 * Model selection is dynamic — populated from the server's availableModels list.
 */
import { state } from "./config.js";
import { saveAuthApiKey, saveConfigData, getOAuthProviders, startOAuthLogin, getOAuthLoginStatus, logoutOAuth, restartRuntime } from "./api.js";

// --- DOM Elements ---
let dialog;
let openBtn;
let closeBtn;
let saveBtn;
let restartBtn;
let statusEl;

// API Key tab
let modelSelect;
let apiKeyInput;

// OAuth tab
let oauthProviderSelect;
let oauthLoginBtn;
let oauthLogoutBtn;
let oauthStatusSection;
let oauthProgressText;
let oauthLoginSection;

// Tab buttons
let tabs;
let apikeyTabContent;
let oauthTabContent;

// Polling
let oauthPollTimer = null;

// --- Public API ---

export function initAuthDialog() {
  dialog = document.getElementById("auth-dialog");
  openBtn = document.getElementById("open-auth-btn");
  closeBtn = document.getElementById("close-auth-btn");
  saveBtn = document.getElementById("save-auth-btn");
  restartBtn = document.getElementById("restart-auth-btn");
  statusEl = document.getElementById("auth-status");

  // API Key tab elements
  modelSelect = document.getElementById("auth-model-select");
  apiKeyInput = document.getElementById("auth-apikey-input");

  // OAuth tab elements
  oauthProviderSelect = document.getElementById("oauth-provider-select");
  oauthLoginBtn = document.getElementById("oauth-login-btn");
  oauthLogoutBtn = document.getElementById("oauth-logout-btn");
  oauthStatusSection = document.getElementById("oauth-status-section");
  oauthProgressText = document.getElementById("oauth-progress-text");
  oauthLoginSection = document.getElementById("oauth-login-section");

  // Tabs
  tabs = dialog?.querySelectorAll(".auth-tab");
  apikeyTabContent = document.getElementById("auth-apikey-tab");
  oauthTabContent = document.getElementById("auth-oauth-tab");

  if (!dialog) return;

  if (openBtn) openBtn.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (saveBtn) saveBtn.addEventListener("click", handleSave);
  if (restartBtn) restartBtn.addEventListener("click", handleRestart);
  if (modelSelect) modelSelect.addEventListener("change", updatePlaceholder);
  if (oauthLoginBtn) oauthLoginBtn.addEventListener("click", handleOAuthLogin);
  if (oauthLogoutBtn) oauthLogoutBtn.addEventListener("click", handleOAuthLogout);

  // Tab switching
  if (tabs) {
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
  }
}

/**
 * Update button appearance based on auth state
 */
export function updateAuthButton() {
  if (!openBtn) return;
  const config = state.config;
  if (config && config.hasAuth) {
    openBtn.classList.add("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Authenticated";
  } else {
    openBtn.classList.remove("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Authentication";
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
  stopOAuthPolling();
}

function switchTab(tab) {
  if (!tabs) return;
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (apikeyTabContent) {
    apikeyTabContent.hidden = tab !== "apikey";
    apikeyTabContent.classList.toggle("active", tab === "apikey");
  }
  if (oauthTabContent) {
    oauthTabContent.hidden = tab !== "oauth";
    oauthTabContent.classList.toggle("active", tab === "oauth");
  }

  // Load OAuth providers when switching to OAuth tab
  if (tab === "oauth") {
    loadOAuthProviders();
  }

  // Update save button visibility
  if (saveBtn) {
    saveBtn.hidden = tab === "oauth";
  }
  setStatus("", "");
}

function populateForm() {
  const config = state.config;
  if (!config) return;

  // Populate model select from availableModels
  if (modelSelect && config.availableModels) {
    // Group models by provider for cleaner display
    const groups = {};
    for (const m of config.availableModels) {
      if (!groups[m.provider]) groups[m.provider] = [];
      groups[m.provider].push(m);
    }

    modelSelect.innerHTML = "";
    for (const [provider, models] of Object.entries(groups)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = provider.charAt(0).toUpperCase() + provider.slice(1);
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id; // "provider/modelId"
        opt.textContent = m.name || m.modelId;
        if (!m.hasAuth) opt.textContent += " (no key)";
        optgroup.appendChild(opt);
      }
      modelSelect.appendChild(optgroup);
    }

    // Select current model
    if (config.model) {
      modelSelect.value = config.model;
    }
  }

  updatePlaceholder();
  setStatus("", "");

  if (config.hasAuth) {
    apiKeyInput.value = "***************************************************";
  } else {
    apiKeyInput.value = "";
  }
}

function updatePlaceholder() {
  if (!modelSelect || !apiKeyInput) return;
  const modelSpec = modelSelect.value; // "provider/modelId"
  const provider = modelSpec.split("/")[0] || "";
  if (provider === "openai") apiKeyInput.placeholder = "sk-proj-...";
  else if (provider === "anthropic") apiKeyInput.placeholder = "sk-ant-api03-...";
  else apiKeyInput.placeholder = "Enter API key...";
}

async function handleSave() {
  const key = apiKeyInput.value.trim();
  const modelSpec = modelSelect?.value || "";
  const provider = modelSpec.split("/")[0] || "";

  if (!key || key === "***************************************************") {
    // User didn't change the key — just save model selection
    if (modelSpec && modelSpec !== state.config.model) {
      try {
        saveBtn.disabled = true;
        const res = await saveConfigData({ model: modelSpec });
        state.config.model = res.model;
        state.config.runtimeControl = res.runtimeControl;
        state.restartRequired = !!res.requiresRestart;

        if (res.requiresRestart) {
          setStatus(
            res.runtimeControl?.canManagedRestart
              ? "Model changed. Restart service to apply."
              : "Model changed. Restart the service manually to apply.",
            "warning",
          );
          updateRestartButton(!!res.runtimeControl?.canManagedRestart);
        } else {
          setStatus("Model selection saved", "success");
          setTimeout(() => close(), 1200);
        }
      } catch (err) {
        setStatus("Save failed: " + err.message, "error");
      } finally {
        saveBtn.disabled = false;
      }
      return;
    }
    setStatus("Please enter an API key", "error");
    return;
  }

  if (!provider) {
    setStatus("Please select a model first", "error");
    return;
  }

  try {
    saveBtn.disabled = true;

    // Save API key
    const authRes = await saveAuthApiKey(provider, key);

    // Also save model selection
    if (modelSpec) {
      await saveConfigData({ model: modelSpec });
      state.config.model = modelSpec;
    }

    state.config.hasAuth = true;
    apiKeyInput.value = "***************************************************";
    state.config.runtimeControl = authRes.runtimeControl;
    state.restartRequired = !!authRes.requiresRestart;

    updateAuthButton();

    if (authRes.requiresRestart) {
      setStatus(
        authRes.runtimeControl?.canManagedRestart
          ? "API key saved. Restart service to apply changes."
          : "API key saved. Restart the service manually to apply changes.",
        "warning",
      );
      updateRestartButton(!!authRes.runtimeControl?.canManagedRestart);
    } else {
      setStatus("API key saved successfully", "success");
      setTimeout(() => close(), 1200);
    }
  } catch (err) {
    setStatus("Save failed: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
}

// --- OAuth ---

async function loadOAuthProviders() {
  try {
    const providers = await getOAuthProviders();
    if (oauthProviderSelect) {
      oauthProviderSelect.innerHTML = providers
        .map((p) => `<option value="${p.id}">${p.name}</option>`)
        .join("");
    }
  } catch (err) {
    console.error("Failed to load OAuth providers:", err);
  }
}

async function handleOAuthLogin() {
  const providerId = oauthProviderSelect?.value;
  if (!providerId) return;

  oauthLoginBtn.disabled = true;
  setStatus("Starting OAuth login...", "warning");

  try {
    const res = await startOAuthLogin(providerId);
    if (res.authUrl) {
      window.open(res.authUrl, "_blank");
      setStatus("Please complete authorization in the browser window.", "warning");
    } else {
      setStatus("Waiting for OAuth callback...", "warning");
    }
    // Start polling for completion
    startOAuthPolling();
  } catch (err) {
    setStatus("OAuth login failed: " + err.message, "error");
    oauthLoginBtn.disabled = false;
  }
}

function startOAuthPolling() {
  stopOAuthPolling();
  oauthPollTimer = setInterval(async () => {
    try {
      const status = await getOAuthLoginStatus();
      if (status.status === "completed") {
        stopOAuthPolling();
        setStatus("OAuth login successful!", "success");
        state.config.hasAuth = true;
        updateAuthButton();
        oauthLoginBtn.disabled = false;

        // Show logout button
        if (oauthLogoutBtn) oauthLogoutBtn.hidden = false;
        if (oauthStatusSection) oauthStatusSection.hidden = false;
        if (oauthProgressText) oauthProgressText.textContent = `Connected via ${status.providerId}`;
      } else if (status.status === "error") {
        stopOAuthPolling();
        setStatus("OAuth login failed: " + (status.error || "Unknown error"), "error");
        oauthLoginBtn.disabled = false;
      }
    } catch (err) {
      // Polling error, keep trying
    }
  }, 2000);
}

function stopOAuthPolling() {
  if (oauthPollTimer) {
    clearInterval(oauthPollTimer);
    oauthPollTimer = null;
  }
}

async function handleOAuthLogout() {
  const providerId = oauthProviderSelect?.value;
  if (!providerId) return;

  try {
    await logoutOAuth(providerId);
    setStatus("Logged out", "success");
    state.config.hasAuth = false;
    updateAuthButton();
    if (oauthLogoutBtn) oauthLogoutBtn.hidden = true;
    if (oauthStatusSection) oauthStatusSection.hidden = true;
  } catch (err) {
    setStatus("Logout failed: " + err.message, "error");
  }
}

// --- Shared helpers ---

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
