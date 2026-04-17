import { state } from "./config.js";
import {
  createConversation,
  getConversationMessages,
  listConversations,
} from "./api.js";

export const chatHistory = [];
const DEFAULT_WEB_CHANNEL_ID = "web";
let ws = null;
let currentAssistantMsg = null;
let currentChannelId = DEFAULT_WEB_CHANNEL_ID;

export async function initChat() {
  // Send button
  document.getElementById("send-btn").addEventListener("click", sendMessage);

  // Send on Enter
  document.getElementById("user-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize the input box
  document.getElementById("user-input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  });

  // Prompt click (Welcome message prompts)
  const welcomeContent = document.getElementById("welcome-content");
  if (welcomeContent) {
    welcomeContent.addEventListener("click", (e) => {
      const item = e.target.closest(".prompt-card");
      if (!item) return;
      const index = parseInt(item.dataset.index);

      if (state.config && state.config.prompts[index]) {
        const input = document.getElementById("user-input");
        input.value = state.config.prompts[index];
        input.focus();
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
      }
    });
  }

  await initializeConversation();
}

export function showWelcome(config) {
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
        <h2>Pack and deploy local AI agents for your team in minutes</h2>
        <p>Deploy verified AI Skillpacks locally and use them directly from Slack and Telegram</p>
        ${promptsHtml}
      </div>
    `;
  }
}

export async function sendMessage() {
  const input = document.getElementById("user-input");
  const text = input.value.trim();
  if (!text) return;

  const chatArea = document.getElementById("chat-area");
  if (chatArea.classList.contains("mode-welcome")) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  }

  input.value = "";
  input.style.height = "auto";

  appendMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;

  currentAssistantMsg = appendMessage("assistant", "");
  showLoadingIndicator();

  try {
    const socket = await getOrCreateWs();
    socket.send(JSON.stringify({ text }));
  } catch (err) {
    handleError(err.message);
  }
}

export async function sendBotCommand(cmdText) {
  const chatArea = document.getElementById("chat-area");
  if (chatArea.classList.contains("mode-welcome")) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  }

  appendMessage("user", cmdText);
  chatHistory.push({ role: "user", content: cmdText });

  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;

  currentAssistantMsg = appendMessage("assistant", "");
  showLoadingIndicator();

  try {
    const socket = await getOrCreateWs();
    socket.send(JSON.stringify({ text: cmdText }));
  } catch (err) {
    handleError(err.message);
  }
}

// ========== Internal Rendering & WS logic ==========

function renderMarkdown(mdText, { renderEmbeddedMarkdown = true } = {}) {
  if (typeof window.marked === "undefined") {
    return escapeHtml(mdText);
  }

  const html = ensureLinksOpenInNewTab(window.marked.parse(mdText));
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
      className.startsWith("language-")
    );
    const language = languageClass ? languageClass.slice("language-".length) : "";

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
    const provider = state.config && state.config.provider ? state.config.provider : "openai";
    const params = new URLSearchParams({
      provider,
      channelId: currentChannelId || DEFAULT_WEB_CHANNEL_ID,
    });
    const wsUrl = `${protocol}//${window.location.host}${state.API_BASE}/api/chat?${params.toString()}`;

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
        } else if (parsed.done) {
          handleDone();
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

async function initializeConversation() {
  const channelId = await ensureConversation();
  currentChannelId = channelId;
  await loadConversationHistory(channelId);
}

async function ensureConversation() {
  const conversations = await listConversations();
  const existing = conversations.find(
    (conversation) => conversation.channelId === DEFAULT_WEB_CHANNEL_ID,
  );
  if (existing) {
    return existing.channelId;
  }

  const created = await createConversation();
  return created.channelId || DEFAULT_WEB_CHANNEL_ID;
}

async function loadConversationHistory(channelId) {
  const messages = await getConversationMessages(channelId, 200);
  const messagesEl = document.getElementById("messages");
  const chatArea = document.getElementById("chat-area");

  messagesEl.innerHTML = "";
  chatHistory.length = 0;

  for (const message of messages) {
    appendMessage(message.role, message.text);
    chatHistory.push({ role: message.role, content: message.text });
  }

  if (messages.length > 0) {
    chatArea.classList.remove("mode-welcome");
    chatArea.classList.add("mode-chat");
  } else {
    chatArea.classList.remove("mode-chat");
    chatArea.classList.add("mode-welcome");
  }
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

function handleAgentEvent(event) {
  if (!currentAssistantMsg) return;

  if (
    ["text_delta", "thinking_delta", "tool_start", "tool_end"].includes(
      event.type
    )
  ) {
    hideLoadingIndicator();
  }

  switch (event.type) {
    case "agent_start":
    case "message_start":
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
      if (typeof window.marked !== "undefined") {
        contentEl.innerHTML = renderMarkdown(thinkingBlock.dataset.mdContent);
      } else {
        contentEl.textContent = thinkingBlock.dataset.mdContent;
      }
      scrollToBottom();
      break;

    case "text_delta":
      const textBlock = getOrCreateTextBlock();
      textBlock.dataset.mdContent += event.delta;
      if (typeof window.marked !== "undefined") {
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
      if (typeof window.marked !== "undefined") {
        inputHtml = ensureLinksOpenInNewTab(
          window.marked.parse("\`\`\`json\n" + safeInput + "\n\`\`\`")
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

      const toolIndicator = currentAssistantMsg.querySelector(".loading-indicator");
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
      const cards = Array.from(currentAssistantMsg.querySelectorAll(".tool-card.running"));
      const card = cards.reverse().find((c) => c.dataset.toolName === event.toolName);
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
            ? "\`\`\`bash\n" + safeResult + "\n\`\`\`"
            : "\`\`\`json\n" + safeResult + "\n\`\`\`";

        if (typeof window.marked !== "undefined") {
          resultEl.innerHTML = ensureLinksOpenInNewTab(window.marked.parse(mdText));
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
    (c) => !c.classList.contains("loading-indicator")
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
  const children = Array.from(currentAssistantMsg.children).filter(
    (c) => !c.classList.contains("loading-indicator")
  );
  let lastChild = children[children.length - 1];

  if (!lastChild || !lastChild.classList.contains("text-block")) {
    lastChild = document.createElement("div");
    lastChild.className = "content text-block markdown-body";
    lastChild.dataset.mdContent = "";

    const indicator = currentAssistantMsg.querySelector(".loading-indicator");
    if (indicator) {
      currentAssistantMsg.insertBefore(lastChild, indicator);
    } else {
      currentAssistantMsg.appendChild(lastChild);
    }
  }
  return lastChild;
}

function enableInput() {
  const sendBtn = document.getElementById("send-btn");
  if (sendBtn) sendBtn.disabled = false;
  currentAssistantMsg = null;
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
