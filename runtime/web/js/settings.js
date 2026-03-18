import { state } from "./config.js";
import { saveConfigData } from "./api.js";

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

  if (config.hasApiKey) {
    keyStatus.textContent = "API key configured";
    keyStatus.className = "status-text success";
  } else {
    keyStatus.textContent = "";
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
}

async function handleSave() {
  const key = apiKeyInput.value.trim();
  const provider = providerSelect.value;
  const telegramToken = telegramTokenInput.value.trim();
  const slackBotToken = slackBotTokenInput.value.trim();
  const slackAppToken = slackAppTokenInput.value.trim();

  const adapters = {};
  if (telegramToken) adapters.telegram = { token: telegramToken };
  if (slackBotToken || slackAppToken) {
    adapters.slack = { 
       botToken: slackBotToken || undefined, 
       appToken: slackAppToken || undefined 
    };
  }

  const updates = { provider, adapters };
  if (key) {
    updates.key = key;
  }

  try {
    const res = await saveConfigData(updates);
    keyStatus.textContent = "Settings saved";
    keyStatus.className = "status-text success";
    apiKeyInput.value = ""; // clear after save
    
    // Update local config
    state.config.provider = res.provider;
    state.config.adapters = res.adapters;
    if (key) state.config.hasApiKey = true;

  } catch (err) {
    keyStatus.textContent = "Save failed: " + err.message;
    keyStatus.className = "status-text error";
  }
}
