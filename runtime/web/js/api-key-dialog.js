/**
 * API Key Dialog Module
 * 
 * 负责 Model API Key 的配置管理。
 * 独立的 Dialog，从原 SettingDialog 的 API Key 部分拆分出来。
 */
import { state } from "./config.js";
import { saveConfigData } from "./api.js";

// --- DOM Elements ---
let dialog;
let openBtn;
let closeBtn;
let saveBtn;
let providerSelect;
let apiKeyInput;
let statusEl;

// --- Public API ---

export function initApiKeyDialog() {
  dialog = document.getElementById("apikey-dialog");
  openBtn = document.getElementById("open-apikey-btn");
  closeBtn = document.getElementById("close-apikey-btn");
  saveBtn = document.getElementById("save-apikey-btn");
  providerSelect = document.getElementById("apikey-provider-select");
  apiKeyInput = document.getElementById("apikey-input");
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
  if (providerSelect) {
    providerSelect.addEventListener("change", updatePlaceholder);
  }
}

/**
 * 根据当前连接状态更新按钮外观
 */
export function updateApiKeyButton() {
  if (!openBtn) return;
  const config = state.config;
  if (config && config.hasApiKey) {
    openBtn.classList.add("connected");
    openBtn.querySelector(".action-btn-label").textContent = "API Key Configured";
  } else {
    openBtn.classList.remove("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Provide Model API Key";
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
  updatePlaceholder();

  setStatus("", "");

  if (config.hasApiKey && config.apiKey) {
    apiKeyInput.value = config.apiKey;
  } else if (config.hasApiKey) {
    apiKeyInput.value = "***************************************************";
  } else {
    apiKeyInput.value = "";
  }
}

function updatePlaceholder() {
  if (!providerSelect || !apiKeyInput) return;
  const p = providerSelect.value;
  if (p === "openai") apiKeyInput.placeholder = "sk-proj-...";
  else if (p === "anthropic") apiKeyInput.placeholder = "sk-ant-api03-...";
  else apiKeyInput.placeholder = "sk-...";
}

async function handleSave() {
  const key = apiKeyInput.value.trim();
  const provider = providerSelect.value;

  if (!key) {
    setStatus("Please enter an API key", "error");
    return;
  }

  const updates = { provider };
  if (key !== "***************************************************" && key !== state.config.apiKey) {
    updates.key = key;
  }

  try {
    saveBtn.disabled = true;
    const res = await saveConfigData(updates);

    state.config.provider = res.provider;
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
    
    state.config.runtimeControl = res.runtimeControl;
    state.restartRequired = !!res.requiresRestart;

    setStatus("API key saved successfully", "success");
    updateApiKeyButton();

    // 延迟关闭让用户看到成功消息
    setTimeout(() => close(), 1200);
  } catch (err) {
    setStatus("Save failed: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
}

function setStatus(message, status) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = status ? `status-text ${status}` : "status-text";
}
