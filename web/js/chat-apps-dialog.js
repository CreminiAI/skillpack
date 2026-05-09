/**
 * Chat Apps (IM Bots) Dialog Module
 * 
 * 负责 IM Bots（Telegram / Slack / Feishu）配置管理。
 * 独立的 Dialog，从原 SettingDialog 的 IM Bots 部分拆分出来。
 */
import { state } from "./config.js";
import { saveConfigData, restartRuntime } from "./api.js";

// --- DOM Elements ---
let dialog;
let openBtn;
let closeBtn;
let saveBtn;
let restartBtn;
let telegramTokenInput;
let slackBotTokenInput;
let slackAppTokenInput;
let feishuAppIdInput;
let feishuAppSecretInput;
let statusEl;

function hasConfiguredChatApp(adapters = {}) {
  const telegramConfigured = Boolean(adapters.telegram?.token);
  const slackConfigured = Boolean(
    adapters.slack?.botToken && adapters.slack?.appToken,
  );
  const feishuConfigured = Boolean(
    adapters.feishu?.appId && adapters.feishu?.appSecret,
  );

  return telegramConfigured || slackConfigured || feishuConfigured;
}

// --- Public API ---

export function initChatAppsDialog() {
  dialog = document.getElementById("chatapps-dialog");
  openBtn = document.getElementById("open-chatapps-btn");
  closeBtn = document.getElementById("close-chatapps-btn");
  saveBtn = document.getElementById("save-chatapps-btn");
  restartBtn = document.getElementById("restart-chatapps-btn");
  telegramTokenInput = document.getElementById("chatapps-telegram-token");
  slackBotTokenInput = document.getElementById("chatapps-slack-bot-token");
  slackAppTokenInput = document.getElementById("chatapps-slack-app-token");
  feishuAppIdInput = document.getElementById("chatapps-feishu-app-id");
  feishuAppSecretInput = document.getElementById("chatapps-feishu-app-secret");
  statusEl = document.getElementById("chatapps-status");

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
}

/**
 * 根据当前连接状态更新按钮外观
 */
export function updateChatAppsButton() {
  if (!openBtn) return;
  const config = state.config;
  const adapters = config?.adapters || {};
  const hasAnyToken = hasConfiguredChatApp(adapters);

  if (hasAnyToken) {
    openBtn.classList.add("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Connected to Chat Apps";
  } else {
    openBtn.classList.remove("connected");
    openBtn.querySelector(".action-btn-label").textContent = "Connect Chat Apps";
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

  if (adapters.feishu) {
    feishuAppIdInput.value = adapters.feishu.appId || "";
    feishuAppSecretInput.value = adapters.feishu.appSecret || "";
  } else {
    feishuAppIdInput.value = "";
    feishuAppSecretInput.value = "";
  }

  // Restart required status
  if (state.restartRequired) {
    setStatus(
      "Settings changed. Restart service to apply.",
      "warning",
    );
    updateRestartButton(true);
  } else {
    setStatus("", "");
    updateRestartButton(false);
  }
}

async function handleSave() {
  const telegramToken = telegramTokenInput.value.trim();
  const slackBotToken = slackBotTokenInput.value.trim();
  const slackAppToken = slackAppTokenInput.value.trim();
  const feishuAppId = feishuAppIdInput.value.trim();
  const feishuAppSecret = feishuAppSecretInput.value.trim();

  // 始终写入所有 adapter 键，空值也要显式传递，让后端能感知「清空」操作
  const adapters = {
    telegram: telegramToken ? { token: telegramToken } : null,
    slack:
      slackBotToken || slackAppToken
        ? {
            botToken: slackBotToken || undefined,
            appToken: slackAppToken || undefined,
          }
        : null,
    feishu:
      feishuAppId || feishuAppSecret
        ? {
            appId: feishuAppId || undefined,
            appSecret: feishuAppSecret || undefined,
          }
        : null,
  };

  const updates = { adapters };

  try {
    saveBtn.disabled = true;
    const res = await saveConfigData(updates);

    state.config.adapters = res.adapters;
    state.restartRequired = !!res.requiresRestart;

    if (res.requiresRestart) {
      setStatus(
        "Settings saved. Restart service to apply changes.",
        "warning",
      );
      updateRestartButton(true);
    } else {
      close();
    }

    updateChatAppsButton();
  } catch (err) {
    setStatus("Save failed: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
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
