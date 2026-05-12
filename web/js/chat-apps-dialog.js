/**
 * Chat Apps (IM Bots) Dialog Module
 *
 * 负责 IM Bots（Telegram / Slack / Feishu / Lark）配置管理。
 * 独立的 Dialog，从原 SettingDialog 的 IM Bots 部分拆分出来。
 */
import { state } from "./config.js";
import { saveConfigData, restartRuntime } from "./api.js";

const TELEGRAM_GUIDE_URL =
  "https://skillpack.gitbook.io/skillpack-docs/getting-started/telegram-integration";
const SLACK_GUIDE_URL =
  "https://skillpack.gitbook.io/skillpack-docs/getting-started/slack-integration";
const DEFAULT_FEISHU_DOMAIN = "feishu";

// --- DOM Elements ---
let dialog;
let openBtn;
let closeBtn;
let saveBtn;
let restartBtn;
let telegramTokenInput;
let slackBotTokenInput;
let slackAppTokenInput;
let feishuDomainSelect;
let feishuAppIdInput;
let feishuAppSecretInput;
let telegramGuideBtn;
let slackGuideBtn;
let statusEl;
let tabButtons = [];
let tabPanels = [];

function normalizeFeishuDomain(domain) {
  return domain === "lark" ? "lark" : DEFAULT_FEISHU_DOMAIN;
}

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

function getInitialChatAppsTab(adapters = {}) {
  if (adapters.telegram?.token) {
    return "telegram";
  }

  if (adapters.slack?.botToken || adapters.slack?.appToken) {
    return "slack";
  }

  if (
    adapters.feishu?.appId ||
    adapters.feishu?.appSecret ||
    normalizeFeishuDomain(adapters.feishu?.domain) !== DEFAULT_FEISHU_DOMAIN
  ) {
    return "feishu";
  }

  return "telegram";
}

function openGuide(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function selectChatAppsTab(tabName) {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.chatappsTab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.chatappsPanel !== tabName;
  });
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
  feishuDomainSelect = document.getElementById("chatapps-feishu-domain");
  feishuAppIdInput = document.getElementById("chatapps-feishu-app-id");
  feishuAppSecretInput = document.getElementById("chatapps-feishu-app-secret");
  telegramGuideBtn = document.getElementById("chatapps-open-telegram-guide");
  slackGuideBtn = document.getElementById("chatapps-open-slack-guide");
  statusEl = document.getElementById("chatapps-status");
  tabButtons = Array.from(document.querySelectorAll("[data-chatapps-tab]"));
  tabPanels = Array.from(document.querySelectorAll("[data-chatapps-panel]"));

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
  if (telegramGuideBtn) {
    telegramGuideBtn.addEventListener("click", () => openGuide(TELEGRAM_GUIDE_URL));
  }
  if (slackGuideBtn) {
    slackGuideBtn.addEventListener("click", () => openGuide(SLACK_GUIDE_URL));
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectChatAppsTab(button.dataset.chatappsTab || "telegram");
    });
  });
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
  selectChatAppsTab(getInitialChatAppsTab(state.config?.adapters || {}));
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
    feishuDomainSelect.value = normalizeFeishuDomain(adapters.feishu.domain);
    feishuAppIdInput.value = adapters.feishu.appId || "";
    feishuAppSecretInput.value = adapters.feishu.appSecret || "";
  } else {
    feishuDomainSelect.value = DEFAULT_FEISHU_DOMAIN;
    feishuAppIdInput.value = "";
    feishuAppSecretInput.value = "";
  }

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
  const feishuDomain = normalizeFeishuDomain(feishuDomainSelect.value);
  const feishuAppId = feishuAppIdInput.value.trim();
  const feishuAppSecret = feishuAppSecretInput.value.trim();
  const hasFeishuConfig = Boolean(
    feishuAppId ||
      feishuAppSecret ||
      feishuDomain !== DEFAULT_FEISHU_DOMAIN,
  );

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
    feishu: hasFeishuConfig
      ? {
          appId: feishuAppId || undefined,
          appSecret: feishuAppSecret || undefined,
          domain: feishuDomain,
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
