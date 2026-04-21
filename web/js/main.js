import { state, loadConfig } from "./config.js";
import { initApiKeyDialog, updateApiKeyButton } from "./api-key-dialog.js";
import { initChatAppsDialog, updateChatAppsButton } from "./chat-apps-dialog.js";
import { initChat, showWelcome } from "./chat.js";

async function init() {
  try {
    const config = await loadConfig();
    
    // Set Pack Name & Description
    const elName = document.getElementById("pack-name");
    const elDesc = document.getElementById("pack-desc");
    if (elName) elName.textContent = config.name || "Skills Pack";
    if (elDesc) elDesc.textContent = config.description || "";
    document.title = config.name || "Skills Pack";

    // Set Sidebar Skills list
    const skillsList = document.getElementById("skills-list");
    if (skillsList && config.skills) {
      skillsList.innerHTML = config.skills
        .map(
          (s) =>
            `<li><div class="skill-name">${s.name}</div><div class="skill-desc">${s.description}</div></li>`,
        )
        .join("");
    }

    // Pre-fill prompt if exactly one
    if (config.prompts && config.prompts.length === 1) {
      const input = document.getElementById("user-input");
      if (input) {
        input.value = config.prompts[0];
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 120) + "px";
      }
    }

    showWelcome(config);
  } catch (err) {
    console.error("Initialization Failed:", err);
  }

  initApiKeyDialog();
  initChatAppsDialog();

  try {
    await initChat();
  } catch (err) {
    console.error("Chat initialization failed:", err);
  }

  updateApiKeyButton();
  updateChatAppsButton();
}

// Start application
init();
