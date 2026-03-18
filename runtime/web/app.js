const API_BASE = "";
let chatHistory = [];
let currentSessionId = localStorage.getItem("skillpack_session_id") || null;
let tunnelPollTimer = null;
let healthPollTimer = null;
let slackChannelsCache = [];

// Initialize
async function init() {
  ensureSessionId();
  setupEventListeners();
  await Promise.all([
    loadConfig(),
    loadSlackConfig(),
    loadSlackChannels(),
    loadCurrentSlackBinding(),
    loadTunnelStatus(),
    loadSlackHealth(),
  ]);
  startTunnelPolling();
  startHealthPolling();
}

function ensureSessionId() {
  if (currentSessionId) {
    renderSessionId();
    return currentSessionId;
  }

  currentSessionId = crypto.randomUUID();
  localStorage.setItem("skillpack_session_id", currentSessionId);
  renderSessionId();
  return currentSessionId;
}

function renderSessionId() {
  const el = document.getElementById("session-id-text");
  if (!el) {
    return;
  }

  if (!currentSessionId) {
    el.textContent = "Session ID unavailable";
    el.className = "status-text error";
    return;
  }

  el.textContent = `SID: ${currentSessionId}`;
  el.className = "status-text";
}

async function loadConfig() {
  try {
    const res = await fetch(API_BASE + "/api/config");
    const config = await res.json();

    document.getElementById("pack-name").textContent = config.name;
    document.getElementById("pack-desc").textContent = config.description;
    document.title = config.name;

    // Skills
    const skillsList = document.getElementById("skills-list");
    skillsList.innerHTML = config.skills
      .map(
        (s) =>
          `<li><div class="skill-name">${s.name}</div><div class="skill-desc">${s.description}</div></li>`,
      )
      .join("");

    // Pre-fill when there is exactly one prompt
    if (config.prompts && config.prompts.length === 1) {
      const input = document.getElementById("user-input");
      input.value = config.prompts[0];
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    }

    // API key status and provider
    const keyStatus = document.getElementById("key-status");
    if (config.hasApiKey) {
      keyStatus.textContent = "API key configured";
      keyStatus.className = "status-text success";
    }

    const providerSelect = document.getElementById("provider-select");
    if (providerSelect && config.provider) {
      providerSelect.value = config.provider;
    }

    const updatePlaceholder = () => {
      const p = providerSelect.value;
      const input = document.getElementById("api-key-input");
      if (p === "openai") input.placeholder = "sk-proj-...";
      else if (p === "anthropic") input.placeholder = "sk-ant-api03-...";
      else input.placeholder = "sk-...";
    };

    providerSelect.addEventListener("change", updatePlaceholder);
    updatePlaceholder();

    // Show welcome view
    showWelcome(config);
  } catch (err) {
    console.error("Failed to load config:", err);
  }
}

async function loadSlackConfig() {
  const status = document.getElementById("slack-status");
  const eventsPathInput = document.getElementById("slack-events-path-input");

  if (!status || !eventsPathInput) {
    return;
  }

  try {
    const res = await fetch(API_BASE + "/api/slack/config");
    if (!res.ok) {
      throw new Error("Failed to load Slack config");
    }

    const config = await res.json();
    eventsPathInput.value = config.eventsPath || "/api/slack/events";

    const useThreadInput = document.getElementById("slack-use-thread-input");
    if (useThreadInput) {
      useThreadInput.checked = !!config.useThread;
    }

    if (config.hasBotToken && config.hasSigningSecret) {
      status.textContent = "Slack configured";
      status.className = "status-text success";
    } else {
      status.textContent = "Slack not configured";
      status.className = "status-text";
    }
  } catch (err) {
    status.textContent = "Slack config unavailable";
    status.className = "status-text error";
  }
}

function showWelcome(config) {
  const welcomeContent = document.getElementById("welcome-content");

  let promptsHtml = "";
  if (config.prompts && config.prompts.length > 1) {
    promptsHtml = `
      <div class="prompt-cards">
        ${config.prompts
          .map(
            (u, i) => `
          <div class="prompt-card" data-index="${i}" title="${u}">
            ${u.length > 60 ? u.substring(0, 60) + "..." : u}
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  }

  if (welcomeContent) {
    welcomeContent.innerHTML = `
      <div class="welcome-message">
        <h2>Turn Skills into a Standalone App with UI</h2>
        <p>One command to orchestrate skills into a standalone app users can download and use on their computer</p>
        ${promptsHtml}
      </div>
    `;
  }
}

function setupEventListeners() {
  // Send button
  document.getElementById("send-btn").addEventListener("click", sendMessage);

  // CJK IME composition tracking to prevent Enter from double-sending
  const userInput = document.getElementById("user-input");
  let imeComposing = false;
  userInput.addEventListener("compositionstart", () => {
    imeComposing = true;
  });
  userInput.addEventListener("compositionend", () => {
    // Delay clearing — the Enter keydown that ends composition fires BEFORE
    // compositionend in some browsers, so we swallow it with this timeout
    setTimeout(() => { imeComposing = false; }, 200);
  });

  // Send on Enter (blocked during IME composition)
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !imeComposing && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize the input box
  document.getElementById("user-input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  });

  // Save API key
  document.getElementById("save-key-btn").addEventListener("click", saveApiKey);

  const saveSlackBtn = document.getElementById("save-slack-btn");
  if (saveSlackBtn) {
    saveSlackBtn.addEventListener("click", saveSlackConfig);
  }

  const startTunnelBtn = document.getElementById("start-tunnel-btn");
  if (startTunnelBtn) {
    startTunnelBtn.addEventListener("click", startTunnel);
  }

  const stopTunnelBtn = document.getElementById("stop-tunnel-btn");
  if (stopTunnelBtn) {
    stopTunnelBtn.addEventListener("click", stopTunnel);
  }

  const copyCallbackBtn = document.getElementById("copy-callback-btn");
  if (copyCallbackBtn) {
    copyCallbackBtn.addEventListener("click", copyCallbackUrl);
  }

  const tunnelProviderSelect = document.getElementById("tunnel-provider-select");
  if (tunnelProviderSelect) {
    tunnelProviderSelect.addEventListener("change", () => loadTunnelStatus());
  }

  const refreshHealthBtn = document.getElementById("refresh-health-btn");
  if (refreshHealthBtn) {
    refreshHealthBtn.addEventListener("click", () => loadSlackHealth(true));
  }

  const refreshChannelsBtn = document.getElementById("refresh-channels-btn");
  if (refreshChannelsBtn) {
    refreshChannelsBtn.addEventListener("click", () => loadSlackChannels(true));
  }

  const bindSessionBtn = document.getElementById("bind-session-btn");
  if (bindSessionBtn) {
    bindSessionBtn.addEventListener("click", bindCurrentSession);
  }

  const copySessionIdBtn = document.getElementById("copy-session-id-btn");
  if (copySessionIdBtn) {
    copySessionIdBtn.addEventListener("click", copySessionId);
  }

  const unbindSessionBtn = document.getElementById("unbind-session-btn");
  if (unbindSessionBtn) {
    unbindSessionBtn.addEventListener("click", unbindCurrentSession);
  }

  // Prompt click
  const welcomeContent = document.getElementById("welcome-content");
  if (welcomeContent) {
    welcomeContent.addEventListener("click", (e) => {
      const item = e.target.closest(".prompt-card");
      if (!item) return;
      const index = parseInt(item.dataset.index);

      // Get the full prompt text
      fetch(API_BASE + "/api/config")
        .then((r) => r.json())
        .then((config) => {
          if (config.prompts[index]) {
            const input = document.getElementById("user-input");
            input.value = config.prompts[index];
            input.focus();
            input.style.height = "auto";
            input.style.height = Math.min(input.scrollHeight, 120) + "px";
          }
        });
    });
  }
}

function renderHealthItem(label, ok, extra = "") {
  const icon = ok ? "✅" : "❌";
  const suffix = extra ? ` - ${extra}` : "";
  return `${icon} ${label}${suffix}`;
}

function setSlackBindingStatus(text, cls = "") {
  const statusEl = document.getElementById("slack-binding-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = text;
  statusEl.className = cls ? `status-text ${cls}` : "status-text";
}

function renderSlackChannels(channels = []) {
  const select = document.getElementById("slack-channel-select");
  if (!select) {
    return;
  }

  slackChannelsCache = channels;

  const previous = select.value;
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = channels.length
    ? "Select a Slack channel..."
    : "No channels available";
  select.appendChild(placeholder);

  channels.forEach((ch) => {
    const option = document.createElement("option");
    option.value = ch.id;
    option.textContent = `#${ch.name}${ch.isPrivate ? " (private)" : ""}`;
    select.appendChild(option);
  });

  if (previous && channels.some((c) => c.id === previous)) {
    select.value = previous;
  }
}

async function loadSlackChannels(force = false) {
  try {
    setSlackBindingStatus(force ? "Refreshing channels..." : "Loading channels...");
    const res = await fetch(API_BASE + "/api/slack/channels");
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load channels");
    }

    const channels = Array.isArray(data.channels) ? data.channels : [];
    renderSlackChannels(channels);
    setSlackBindingStatus(
      channels.length
        ? `Loaded ${channels.length} channel(s)`
        : "No channels found. Invite the bot and check scopes.",
      channels.length ? "success" : "",
    );
  } catch (err) {
    renderSlackChannels([]);
    setSlackBindingStatus(
      `Channels unavailable: ${err.message || "error"}`,
      "error",
    );
  }
}

async function copySessionId() {
  const sid = ensureSessionId();
  try {
    await navigator.clipboard.writeText(sid);
    setSlackBindingStatus("Session ID copied", "success");
  } catch (_err) {
    setSlackBindingStatus("Copy failed. Please copy SID manually.", "error");
  }
}

function renderCurrentSlackBinding(mapping) {
  const currentEl = document.getElementById("slack-current-binding");
  const linkEl = document.getElementById("slack-deep-link");
  if (!currentEl) {
    return;
  }

  if (linkEl) {
    linkEl.innerHTML = "";
    linkEl.className = "status-text";
  }

  if (!mapping) {
    currentEl.textContent = "Current session not bound";
    currentEl.className = "status-text";
    if (linkEl) {
      linkEl.textContent = "No Slack thread link";
    }
    return;
  }

  const channelMeta = slackChannelsCache.find((c) => c.id === mapping.channelId);
  const channelLabel = channelMeta
    ? `#${channelMeta.name}${channelMeta.isPrivate ? " (private)" : ""}`
    : mapping.channelId;
  const threadShort = String(mapping.threadTs || "").slice(0, 10);
  currentEl.textContent = `Bound: ${channelLabel} / thread ${threadShort}...`;
  currentEl.className = "status-text success";

  if (linkEl) {
    if (mapping.permalink) {
      linkEl.innerHTML = `<a href="${escapeHtml(mapping.permalink)}" target="_blank" rel="noopener noreferrer">Open Slack thread</a>`;
      linkEl.className = "status-text success";
    } else {
      linkEl.textContent = "Slack thread link unavailable";
      linkEl.className = "status-text";
    }
  }
}

async function loadCurrentSlackBinding() {
  const sessionId = ensureSessionId();

  try {
    const res = await fetch(
      API_BASE + `/api/slack/mappings?sessionId=${encodeURIComponent(sessionId)}`,
    );

    if (!res.ok) {
      throw new Error("Failed to load mapping");
    }

    const data = await res.json();
    const mapping = Array.isArray(data.mappings) ? data.mappings[0] : null;
    renderCurrentSlackBinding(mapping || null);
  } catch (_err) {
    renderCurrentSlackBinding(null);
  }
}

async function bindCurrentSession() {
  const sessionId = ensureSessionId();
  const channelSelect = document.getElementById("slack-channel-select");
  const channelIdInput = document.getElementById("slack-channel-id-input");

  const channelId =
    (channelSelect && channelSelect.value) ||
    (channelIdInput && channelIdInput.value.trim()) ||
    "";

  if (!channelId) {
    setSlackBindingStatus("Select a channel or enter a channel ID", "error");
    return;
  }

  try {
    setSlackBindingStatus("Binding current session...");

    const res = await fetch(API_BASE + "/api/slack/bind-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        channelId,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Bind failed");
    }

    setSlackBindingStatus("Session bound successfully", "success");
    renderCurrentSlackBinding(data.mapping || null);
  } catch (err) {
    setSlackBindingStatus(`Bind failed: ${err.message || "error"}`, "error");
  }
}

async function unbindCurrentSession() {
  const sessionId = ensureSessionId();
  const channelSelect = document.getElementById("slack-channel-select");

  try {
    setSlackBindingStatus("Unbinding current session...");
    const res = await fetch(API_BASE + "/api/slack/unbind-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Unbind failed");
    }

    renderCurrentSlackBinding(null);
    if (channelSelect) {
      channelSelect.value = "";
    }
    setSlackBindingStatus(
      data.removed
        ? "Session unbound. Select a channel to bind again."
        : "No existing binding. Select a channel to bind.",
      "success",
    );
  } catch (err) {
    setSlackBindingStatus(`Unbind failed: ${err.message || "error"}`, "error");
  }
}

function renderSlackHealth(health) {
  const summaryEl = document.getElementById("slack-health-summary");
  const detailsEl = document.getElementById("slack-health-details");

  if (!summaryEl || !detailsEl) {
    return;
  }

  if (!health || !health.checks) {
    summaryEl.textContent = "Health unavailable";
    summaryEl.className = "status-text error";
    detailsEl.innerHTML = "";
    return;
  }

  summaryEl.textContent = health.ok
    ? "Slack integration healthy"
    : "Slack integration not ready";
  summaryEl.className = health.ok ? "status-text success" : "status-text error";

  const checks = health.checks;
  const lines = [
    renderHealthItem("API key", checks.apiKeyConfigured),
    renderHealthItem("Slack bot token", checks.botTokenConfigured),
    renderHealthItem("Slack signing secret", checks.signingSecretConfigured),
    renderHealthItem("Tunnel", checks.tunnelRunning, checks.callbackUrl || ""),
    renderHealthItem("Slack auth.test", checks.slackAuthOk, checks.slackTeam || checks.error || ""),
  ];

  detailsEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}

async function loadSlackHealth(force = false) {
  try {
    const url = force
      ? API_BASE + "/api/slack/health?refresh=1"
      : API_BASE + "/api/slack/health";
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error("Failed to load health");
    }

    const health = await res.json();
    renderSlackHealth(health);
  } catch (_err) {
    renderSlackHealth(null);
  }
}

function renderTunnelStatus(status) {
  const statusEl = document.getElementById("tunnel-status");
  const urlEl = document.getElementById("tunnel-url");
  const callbackEl = document.getElementById("tunnel-callback-url");
  const providerSelect = document.getElementById("tunnel-provider-select");
  const tunnelNameInput = document.getElementById("tunnel-name-input");
  const portInput = document.getElementById("tunnel-port-input");
  const startBtn = document.getElementById("start-tunnel-btn");
  const stopBtn = document.getElementById("stop-tunnel-btn");

  if (!statusEl || !urlEl || !callbackEl) {
    return;
  }

  if (providerSelect && status.provider) {
    providerSelect.value = status.provider;
  }
  if (tunnelNameInput && status.tunnelName) {
    tunnelNameInput.value = status.tunnelName;
  }
  if (portInput && status.port) {
    portInput.value = String(status.port);
  } else if (portInput && !portInput.value) {
    portInput.value = window.location.port || "26313";
  }

  const providerName = providerSelect ? providerSelect.value : "cloudflared";
  const isAvailable = !!status.available?.[providerName];

  if (!isAvailable) {
    statusEl.textContent = `${providerName} not installed`;
    statusEl.className = "status-text error";
  } else if (status.status === "running") {
    statusEl.textContent = `Tunnel running (${status.provider})`;
    statusEl.className = "status-text success";
  } else if (status.status === "starting") {
    statusEl.textContent = `Starting ${status.provider}...`;
    statusEl.className = "status-text";
  } else if (status.status === "error") {
    statusEl.textContent = status.lastError || "Tunnel error";
    statusEl.className = "status-text error";
  } else {
    statusEl.textContent = "Tunnel stopped";
    statusEl.className = "status-text";
  }

  urlEl.textContent = status.publicUrl ? status.publicUrl : "";
  callbackEl.textContent = status.callbackUrl
    ? `Slack callback: ${status.callbackUrl}`
    : "";

  if (startBtn) {
    const isBusy = status.status === "starting" || status.status === "running";
    startBtn.disabled = !isAvailable || isBusy;
    startBtn.textContent = status.status === "running" ? "Running" : "Start";
  }
  if (stopBtn) {
    stopBtn.disabled = status.status !== "running" && status.status !== "starting";
  }
}

async function loadTunnelStatus() {
  try {
    const res = await fetch(API_BASE + "/api/tunnel/status");
    if (!res.ok) {
      throw new Error("Failed to load tunnel status");
    }

    const status = await res.json();
    renderTunnelStatus(status);
  } catch (_err) {
    const statusEl = document.getElementById("tunnel-status");
    if (statusEl) {
      statusEl.textContent = "Tunnel status unavailable";
      statusEl.className = "status-text error";
    }
  }
}

function startTunnelPolling() {
  if (tunnelPollTimer) {
    clearInterval(tunnelPollTimer);
  }

  tunnelPollTimer = setInterval(() => {
    loadTunnelStatus();
  }, 2000);
}

function startHealthPolling() {
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
  }

  healthPollTimer = setInterval(() => {
    loadSlackHealth();
  }, 5000);
}

async function startTunnel() {
  const providerSelect = document.getElementById("tunnel-provider-select");
  const tunnelNameInput = document.getElementById("tunnel-name-input");
  const portInput = document.getElementById("tunnel-port-input");

  const provider = providerSelect ? providerSelect.value : "cloudflared";
  const tunnelName = tunnelNameInput ? tunnelNameInput.value.trim() : "";
  const port = Number(portInput?.value || window.location.port || 26313);

  try {
    const res = await fetch(API_BASE + "/api/tunnel/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, port, tunnelName }),
    });
    const status = await res.json();
    renderTunnelStatus(status);
    loadSlackHealth();
  } catch (_err) {
    const statusEl = document.getElementById("tunnel-status");
    if (statusEl) {
      statusEl.textContent = "Failed to start tunnel";
      statusEl.className = "status-text error";
    }
  }
}

async function stopTunnel() {
  try {
    const res = await fetch(API_BASE + "/api/tunnel/stop", {
      method: "POST",
    });
    const status = await res.json();
    renderTunnelStatus(status);
    loadSlackHealth();
  } catch (_err) {
    const statusEl = document.getElementById("tunnel-status");
    if (statusEl) {
      statusEl.textContent = "Failed to stop tunnel";
      statusEl.className = "status-text error";
    }
  }
}

async function copyCallbackUrl() {
  const callbackEl = document.getElementById("tunnel-callback-url");
  if (!callbackEl || !callbackEl.textContent) {
    return;
  }

  const prefix = "Slack callback: ";
  const callbackUrl = callbackEl.textContent.startsWith(prefix)
    ? callbackEl.textContent.slice(prefix.length)
    : callbackEl.textContent;

  if (!callbackUrl) {
    return;
  }

  try {
    await navigator.clipboard.writeText(callbackUrl);
    const statusEl = document.getElementById("tunnel-status");
    if (statusEl) {
      statusEl.textContent = "Callback URL copied";
      statusEl.className = "status-text success";
    }
  } catch (_err) {
    const statusEl = document.getElementById("tunnel-status");
    if (statusEl) {
      statusEl.textContent = "Copy failed";
      statusEl.className = "status-text error";
    }
  }
}

async function saveSlackConfig() {
  const botTokenInput = document.getElementById("slack-bot-token-input");
  const signingSecretInput = document.getElementById(
    "slack-signing-secret-input",
  );
  const appTokenInput = document.getElementById("slack-app-token-input");
  const eventsPathInput = document.getElementById("slack-events-path-input");
  const status = document.getElementById("slack-status");

  if (!status || !botTokenInput || !signingSecretInput || !eventsPathInput) {
    return;
  }

  const useThreadInput = document.getElementById("slack-use-thread-input");
  const payload = {
    botToken: botTokenInput.value.trim(),
    signingSecret: signingSecretInput.value.trim(),
    appToken: appTokenInput ? appTokenInput.value.trim() : "",
    eventsPath: eventsPathInput.value.trim() || "/api/slack/events",
    useThread: useThreadInput ? useThreadInput.checked : false,
  };

  if (!payload.botToken || !payload.signingSecret) {
    status.textContent = "Bot token and signing secret are required";
    status.className = "status-text error";
    return;
  }

  try {
    const res = await fetch(API_BASE + "/api/slack/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error("Save failed");
    }

    const saved = await res.json();
    status.textContent = "Slack settings saved";
    status.className = "status-text success";

    if (saved.eventsPath && eventsPathInput.value !== saved.eventsPath) {
      eventsPathInput.value = saved.eventsPath;
    }

    loadTunnelStatus();
    loadSlackHealth(true);
    loadSlackChannels(true);
    loadCurrentSlackBinding();

    botTokenInput.value = "";
    signingSecretInput.value = "";
    if (appTokenInput) appTokenInput.value = "";
  } catch (err) {
    status.textContent = "Save failed";
    status.className = "status-text error";
  }
}

async function saveApiKey() {
  const input = document.getElementById("api-key-input");
  const providerSelect = document.getElementById("provider-select");
  const status = document.getElementById("key-status");
  const key = input.value.trim();
  const provider = providerSelect ? providerSelect.value : "openai";

  if (!key) {
    status.textContent = "Enter an API key";
    status.className = "status-text error";
    return;
  }

  try {
    const res = await fetch(API_BASE + "/api/config/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, provider }),
    });

    if (res.ok) {
      status.textContent = "API key saved";
      status.className = "status-text success";
      input.value = "";
    } else {
      status.textContent = "Save failed";
      status.className = "status-text error";
    }
  } catch (err) {
    status.textContent = "Save failed: " + err.message;
    status.className = "status-text error";
  }
}

let ws = null;
let currentAssistantMsg = null;

function renderMarkdown(mdText, { renderEmbeddedMarkdown = true } = {}) {
  if (typeof marked === "undefined") {
    return escapeHtml(mdText);
  }

  const html = ensureLinksOpenInNewTab(marked.parse(mdText));
  if (!renderEmbeddedMarkdown) {
    return html;
  }

  return renderEmbeddedMarkdownBlocks(html);
}

function ensureLinksOpenInNewTab(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  template.content.querySelectorAll("a[href]").forEach((linkEl) => {
    linkEl.setAttribute("target", "_blank");
    linkEl.setAttribute("rel", "noopener noreferrer");
  });

  return template.innerHTML;
}

function renderEmbeddedMarkdownBlocks(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const codeBlocks = template.content.querySelectorAll("pre > code");
  codeBlocks.forEach((codeEl) => {
    const languageClass = Array.from(codeEl.classList).find((className) =>
      className.startsWith("language-"),
    );
    const language = languageClass
      ? languageClass.slice("language-".length)
      : "";

    if (!/^(markdown|md)$/i.test(language)) {
      return;
    }

    const preview = document.createElement("div");
    preview.className = "embedded-markdown-preview markdown-body";
    preview.innerHTML = renderMarkdown(codeEl.textContent || "", {
      renderEmbeddedMarkdown: false,
    });

    const pre = codeEl.parentElement;
    if (pre) {
      pre.replaceWith(preview);
    }
  });

  return template.innerHTML;
}

async function getOrCreateWs() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }

  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const providerSelect = document.getElementById("provider-select");
    const provider = providerSelect ? providerSelect.value : "openai";

    // URLSearchParams would be cleaner if more query params are added later
    const qs = new URLSearchParams({ provider });
    if (currentSessionId) {
      qs.set("sessionId", currentSessionId);
    }
    const wsUrl = `${protocol}//${window.location.host}${API_BASE}/api/chat?${qs.toString()}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => resolve(ws);
    ws.onerror = (err) => {
      console.error(err);
      reject(new Error("WebSocket connection failed"));
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.error) {
          handleError(parsed.error);
        } else if (parsed.type === "session_info" && parsed.sessionId) {
          currentSessionId = parsed.sessionId;
          localStorage.setItem("skillpack_session_id", currentSessionId);
          renderSessionId();
          loadCurrentSlackBinding();
        } else if (parsed.done) {
          handleDone();
        } else if (parsed.type === "slack_user_message") {
          handleSlackUserMessage(parsed);
        } else if (parsed.type === "slack_assistant_response") {
          handleSlackAssistantResponse(parsed);
        } else if (parsed.type) {
          handleAgentEvent(parsed);
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    };

    ws.onclose = () => {
      ws = null;
      enableInput();
    };
  });
}

function handleSlackUserMessage(event) {
  const chatArea = document.getElementById("chat-area");
  if (chatArea.classList.contains("mode-welcome")) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  }

  appendMessage("user", "[Slack] " + (event.text || ""));
  chatHistory.push({ role: "user", content: event.text || "" });
}

function handleSlackAssistantResponse(event) {
  const chatArea = document.getElementById("chat-area");
  if (chatArea.classList.contains("mode-welcome")) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  }

  const msg = appendMessage("assistant", event.text || "");
  if (event.isError) {
    msg.classList.add("error");
  }
  chatHistory.push({ role: "assistant", content: event.text || "" });
}

function handleError(errorMsg) {
  if (!currentAssistantMsg) {
    appendMessage("assistant", "Error: " + errorMsg).classList.add("error");
  } else {
    const errDiv = document.createElement("div");
    errDiv.className = "content error-text";
    errDiv.textContent = "Error: " + errorMsg;
    currentAssistantMsg.appendChild(errDiv);
    currentAssistantMsg.classList.add("error");
  }
  enableInput();
}

function handleDone() {
  let fullText = "";
  if (currentAssistantMsg) {
    const blocks = currentAssistantMsg.querySelectorAll(".text-block");
    blocks.forEach((b) => {
      fullText += b.dataset.mdContent + "\n";
    });
  }
  chatHistory.push({ role: "assistant", content: fullText });
  enableInput();
}

function showLoadingIndicator() {
  if (!currentAssistantMsg) return;
  let indicator = currentAssistantMsg.querySelector(".loading-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "loading-indicator";
    indicator.innerHTML = `<span></span><span></span><span></span>`;
    currentAssistantMsg.appendChild(indicator);
  }
  indicator.style.display = "flex";
  scrollToBottom();
}

function hideLoadingIndicator() {
  if (!currentAssistantMsg) return;
  const indicator = currentAssistantMsg.querySelector(".loading-indicator");
  if (indicator) {
    indicator.style.display = "none";
  }
}

function isAssistantPlaceholderEmpty(node) {
  if (!node) {
    return true;
  }

  const nonLoadingChildren = Array.from(node.children).filter(
    (c) => !c.classList.contains("loading-indicator"),
  );
  return nonLoadingChildren.length === 0;
}

function ensureAssistantMessageForStream() {
  if (!currentAssistantMsg) {
    currentAssistantMsg = appendMessage("assistant", "");
  }
  return currentAssistantMsg;
}

function maybeAppendRemoteUserMessage(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return;
  }

  const messages = document.getElementById("messages");
  const allUserMsgs = messages?.querySelectorAll(".message.user");
  const lastUserMsg = allUserMsgs?.[allUserMsgs.length - 1];
  const lastUserText = (lastUserMsg?.querySelector(".content")?.textContent || "").trim();

  if (lastUserText === normalized) {
    return;
  }

  appendMessage("user", normalized);
}

function handleAgentEvent(event) {
  if (
    ["text_delta", "thinking_delta", "tool_start", "tool_end"].includes(
      event.type,
    )
  ) {
    ensureAssistantMessageForStream();
    hideLoadingIndicator();
  }

  switch (event.type) {
    case "agent_start":
      showLoadingIndicator();
      break;

    case "message_start":
      if (event.role === "user") {
        maybeAppendRemoteUserMessage(event.text);
        break;
      }

      if (event.role === "assistant") {
        ensureAssistantMessageForStream();
      }

      showLoadingIndicator();
      break;

    case "agent_end":
    case "message_end":
      hideLoadingIndicator();
      break;

    case "thinking_delta":
      const thinkingBlock = getOrCreateThinkingBlock();
      thinkingBlock.dataset.mdContent += event.delta;
      const contentEl = thinkingBlock.querySelector(".thinking-content");
      if (typeof marked !== "undefined") {
        contentEl.innerHTML = renderMarkdown(thinkingBlock.dataset.mdContent);
      } else {
        contentEl.textContent = thinkingBlock.dataset.mdContent;
      }
      scrollToBottom();
      break;

    case "text_delta":
      const textBlock = getOrCreateTextBlock();
      textBlock.dataset.mdContent += event.delta;
      if (typeof marked !== "undefined") {
        textBlock.innerHTML = renderMarkdown(textBlock.dataset.mdContent);
      } else {
        textBlock.textContent = textBlock.dataset.mdContent;
      }
      scrollToBottom();
      break;

    case "tool_start":
      const toolCard = document.createElement("div");
      toolCard.className = "tool-card running collapsed";
      const safeInput =
        typeof event.toolInput === "string"
          ? event.toolInput
          : JSON.stringify(event.toolInput, null, 2);

      let inputHtml = "";
      if (typeof marked !== "undefined") {
        inputHtml = ensureLinksOpenInNewTab(
          marked.parse("```json\n" + safeInput + "\n```"),
        );
      } else {
        inputHtml = escapeHtml(safeInput);
      }

      toolCard.innerHTML = `
        <div class="tool-header">
          <span class="tool-chevron">
            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </span>
          <span class="tool-icon">🛠️</span>
          <span class="tool-name">${escapeHtml(event.toolName)}</span>
          <span class="tool-status spinner"></span>
        </div>
        <div class="tool-content">
          <div class="tool-input markdown-body">${inputHtml}</div>
          <div class="tool-result markdown-body" style="display: none;"></div>
        </div>
      `;

      toolCard.querySelector(".tool-header").addEventListener("click", () => {
        toolCard.classList.toggle("collapsed");
      });

      // Insert before loading indicator if exists
      const toolIndicator =
        currentAssistantMsg.querySelector(".loading-indicator");
      if (toolIndicator) {
        currentAssistantMsg.insertBefore(toolCard, toolIndicator);
      } else {
        currentAssistantMsg.appendChild(toolCard);
      }

      toolCard.dataset.toolName = event.toolName;
      scrollToBottom();

      showLoadingIndicator();
      break;

    case "tool_end":
      const cards = Array.from(
        currentAssistantMsg.querySelectorAll(".tool-card.running"),
      );
      const card = cards
        .reverse()
        .find((c) => c.dataset.toolName === event.toolName);
      if (card) {
        card.classList.remove("running");
        card.classList.add(event.isError ? "error" : "success");

        if (event.isError) {
          card.classList.remove("collapsed");
        }

        const statusEl = card.querySelector(".tool-status");
        statusEl.className = "tool-status";
        statusEl.textContent = event.isError ? "❌" : "✅";

        const resultEl = card.querySelector(".tool-result");
        resultEl.style.display = "block";
        const safeResult =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result, null, 2);

        const mdText =
          event.result &&
          typeof event.result === "string" &&
          (event.result.includes("\n") || event.result.length > 50)
            ? "```bash\n" + safeResult + "\n```"
            : "```json\n" + safeResult + "\n```";

        if (typeof marked !== "undefined") {
          resultEl.innerHTML = ensureLinksOpenInNewTab(marked.parse(mdText));
        } else {
          resultEl.textContent = safeResult;
        }
      }
      scrollToBottom();

      showLoadingIndicator();
      break;
  }
}

function getOrCreateThinkingBlock() {
  const children = Array.from(currentAssistantMsg.children).filter(
    (c) => !c.classList.contains("loading-indicator"),
  );
  let lastChild = children[children.length - 1];

  if (!lastChild || !lastChild.classList.contains("thinking-card")) {
    lastChild = document.createElement("div");
    lastChild.className = "tool-card thinking-card collapsed";
    lastChild.dataset.mdContent = "";

    lastChild.innerHTML = `
      <div class="tool-header thinking-header">
        <span class="tool-chevron">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </span>
        <span class="tool-icon">🧠</span>
        <span class="tool-name" style="color: var(--text-secondary);">Thinking Process</span>
      </div>
      <div class="tool-content thinking-content markdown-body"></div>
    `;

    lastChild.querySelector(".tool-header").addEventListener("click", () => {
      lastChild.classList.toggle("collapsed");
    });

    const indicator = currentAssistantMsg.querySelector(".loading-indicator");
    if (indicator) {
      currentAssistantMsg.insertBefore(lastChild, indicator);
    } else {
      currentAssistantMsg.appendChild(lastChild);
    }
  }
  return lastChild;
}

function getOrCreateTextBlock() {
  // Always reuse the existing text-block for this assistant message.
  // Only create a new one after a real tool card (not thinking).
  const existing = currentAssistantMsg.querySelector(".text-block");
  if (existing) {
    return existing;
  }

  const lastChild = document.createElement("div");
  lastChild.className = "content text-block markdown-body";
  lastChild.dataset.mdContent = "";

  const indicator = currentAssistantMsg.querySelector(".loading-indicator");
  if (indicator) {
    currentAssistantMsg.insertBefore(lastChild, indicator);
  } else {
    currentAssistantMsg.appendChild(lastChild);
  }
  return lastChild;
}

function enableInput() {
  const sendBtn = document.getElementById("send-btn");
  if (sendBtn) sendBtn.disabled = false;
  currentAssistantMsg = null;
}

async function sendMessage() {
  const sendBtn = document.getElementById("send-btn");
  if (sendBtn && sendBtn.disabled) return;

  const input = document.getElementById("user-input");
  const text = input.value.trim();
  if (!text) return;

  if (sendBtn) sendBtn.disabled = true;

  const chatArea = document.getElementById("chat-area");
  if (chatArea.classList.contains("mode-welcome")) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  }

  input.value = "";
  input.style.height = "auto";

  // Add the user message
  appendMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  // sendBtn already disabled at top of function

  // Create an assistant message placeholder
  currentAssistantMsg = appendMessage("assistant", "");
  showLoadingIndicator();

  try {
    const socket = await getOrCreateWs();
    socket.send(JSON.stringify({ text }));
  } catch (err) {
    handleError(err.message);
  }
}

function appendMessage(role, text) {
  const messages = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "message " + role;

  if (role === "user") {
    div.innerHTML = '<div class="content">' + escapeHtml(text) + "</div>";
  } else if (text) {
    const tb = document.createElement("div");
    tb.className = "content text-block markdown-body";
    tb.dataset.mdContent = text;
    tb.innerHTML = renderMarkdown(text);
    div.appendChild(tb);
  }

  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  const messages = document.getElementById("messages");
  messages.scrollTop = messages.scrollHeight;
}

// Start the app
init();
