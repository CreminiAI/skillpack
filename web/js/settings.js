import { state } from "./config.js";
import { restartRuntime, saveConfigData } from "./api.js";

// DOM Elements
let dialog;
let settingsBtn;
let closeBtn;
let saveBtn;
let providerSelect;
let apiKeyInput;
let telegramTokenInput;
let slackBotTokenInput;
let slackAppTokenInput;
let keyStatus;
let restartBtn;
let serverUrlInput;
let agentTokenInput;

export function initSettings() {
  dialog = document.getElementById("settings-dialog");
  settingsBtn = document.getElementById("open-settings-btn");
  closeBtn = document.getElementById("close-settings-btn");
  saveBtn = document.getElementById("save-settings-btn");

  providerSelect = document.getElementById("provider-select");
  apiKeyInput = document.getElementById("api-key-input");
  telegramTokenInput = document.getElementById("telegram-token-input");
  slackBotTokenInput = document.getElementById("slack-bot-token-input");
  slackAppTokenInput = document.getElementById("slack-app-token-input");
  keyStatus = document.getElementById("key-status");
  restartBtn = document.getElementById("restart-service-btn");
  serverUrlInput = document.getElementById("server-url-input");
  agentTokenInput = document.getElementById("agent-token-input");

  if (!dialog) return;

  // Open/Close dialog
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      populateForm();
      dialog.showModal();
    });
  }
  
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      dialog.close();
      keyStatus.textContent = ""; // clear status on close
    });
  }

  // Save Settings
  if (saveBtn) {
    saveBtn.addEventListener("click", handleSave);
  }
  if (restartBtn) {
    restartBtn.addEventListener("click", handleRestart);
  }

  // Placeholder logic
  if (providerSelect) {
    providerSelect.addEventListener("change", updatePlaceholder);
  }
}

function updatePlaceholder() {
  const p = providerSelect.value;
  if (p === "openai") apiKeyInput.placeholder = "sk-proj-...";
  else if (p === "anthropic") apiKeyInput.placeholder = "sk-ant-api03-...";
  else apiKeyInput.placeholder = "sk-...";
}

function populateForm() {
  const config = state.config;
  if (!config) return;

  if (state.restartRequired) {
    setStatus(
      config.runtimeControl?.canManagedRestart
        ? "Settings saved. Restart service to apply changes."
        : "Settings saved. Restart the service manually to apply changes.",
      "warning",
    );
    updateRestartButton(true);
  } else {
    setStatus("", "");
    updateRestartButton(false);
  }

  if (config.hasApiKey && config.apiKey) {
    apiKeyInput.value = config.apiKey;
  } else if (config.hasApiKey) {
    apiKeyInput.value = "***************************************************";
  } else {
    apiKeyInput.value = "";
  }

  if (config.provider) {
    providerSelect.value = config.provider;
  }
  updatePlaceholder();

  const adapters = config.adapters || {};
  if (adapters.telegram && adapters.telegram.token) {
    telegramTokenInput.value = adapters.telegram.token;
  } else {
    telegramTokenInput.value = "";
  }

  if (adapters.slack) {
    slackBotTokenInput.value = adapters.slack.botToken || "";
    slackAppTokenInput.value = adapters.slack.appToken || "";
  } else {
    slackBotTokenInput.value = "";
    slackAppTokenInput.value = "";
  }

  // Dashboard connection
  if (serverUrlInput) serverUrlInput.value = config.serverUrl || "";
  if (agentTokenInput) agentTokenInput.value = config.agentToken || "";
}

async function handleSave() {
  const key = apiKeyInput.value.trim();
  const provider = providerSelect.value;
  const telegramToken = telegramTokenInput.value.trim();
  const slackBotToken = slackBotTokenInput.value.trim();
  const slackAppToken = slackAppTokenInput.value.trim();

  const serverUrl = serverUrlInput ? serverUrlInput.value.trim() : "";
  const agentToken = agentTokenInput ? agentTokenInput.value.trim() : "";

  const adapters = {};
  if (telegramToken) adapters.telegram = { token: telegramToken };
  if (slackBotToken || slackAppToken) {
    adapters.slack = {
       botToken: slackBotToken || undefined,
       appToken: slackAppToken || undefined
    };
  }

  const updates = { provider, adapters };
  if (key && key !== "***************************************************" && key !== state.config.apiKey) {
    updates.key = key;
  }
  if (serverUrl) updates.serverUrl = serverUrl;
  if (agentToken) updates.agentToken = agentToken;

  try {
    const res = await saveConfigData(updates);
    
    // Update local config
    state.config.provider = res.provider;
    state.config.adapters = res.adapters;
    state.config.runtimeControl = res.runtimeControl;
    if (updates.key) {
      state.config.hasApiKey = true;
      state.config.apiKey = updates.key;
    }
    
    if (state.config.hasApiKey && state.config.apiKey) {
      apiKeyInput.value = state.config.apiKey;
    } else if (state.config.hasApiKey) {
      apiKeyInput.value = "***************************************************";
    } else {
      apiKeyInput.value = "";
    }
    state.restartRequired = !!res.requiresRestart;

    if (res.requiresRestart) {
      setStatus(
        res.runtimeControl.canManagedRestart
          ? "Settings saved. Restart service to apply changes."
          : "Settings saved. Restart the service manually to apply changes.",
        "warning",
      );
      updateRestartButton(res.runtimeControl.canManagedRestart);
      return;
    }

    setStatus("Settings saved", "success");
    updateRestartButton(false);

  } catch (err) {
    setStatus("Save failed: " + err.message, "error");
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
  if (!keyStatus) return;
  keyStatus.textContent = message;
  keyStatus.className = status ? `status-text ${status}` : "status-text";
}
