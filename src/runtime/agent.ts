import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import { ConfigFileAuthBackend, SUPPORTED_PROVIDERS } from "./config.js";

import {
  formatAttachmentsPrompt,
  attachmentsToImageContent,
  isImageMime,
} from "./adapters/attachment-utils.js";
import {
  createSendFileTool,
  type FileOutputCallback,
} from "./tools/send-file-tool.js";
import { createManageScheduleTool } from "./tools/manage-schedule-tool.js";
import type { SchedulerAdapter } from "./adapters/scheduler.js";

import type {
  IPackAgent,
  PackAgentOptions,
  HandleResult,
  AgentEvent,
  BotCommand,
  CommandResult,
  ChannelAttachment,
  LifecycleTrigger,
  SessionInfo,
} from "./adapters/types.js";

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log(...args);
const write = (data: string) => DEBUG && process.stdout.write(data);

const BUILTIN_SKILL_CREATOR_NAME = "skill-creator";
const BUILTIN_SKILL_CREATOR_DESCRIPTION =
  "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.";
const BUILTIN_SKILL_CREATOR_TEMPLATE_DIR = fileURLToPath(
  new URL("../templates/builtin-skills/skill-creator", import.meta.url),
);
const PACK_AGENTS_FILE = "AGENTS.md";
const PACK_SOUL_FILE = "SOUL.md";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssistantDiagnostics {
  stopReason: string;
  errorMessage: string;
  hasText: boolean;
  toolCalls: number;
}

interface PackPromptFiles {
  agentsPath: string;
  soulPath: string;
  agentsContent?: string;
  soulContent?: string;
  promptBlock?: string;
}

function materializeBuiltinSkillCreator(
  rootDir: string,
  skillsPath: string,
): Skill | null {
  if (!fs.existsSync(BUILTIN_SKILL_CREATOR_TEMPLATE_DIR)) {
    log(
      `[PackAgent] Built-in skill-creator template missing: ${BUILTIN_SKILL_CREATOR_TEMPLATE_DIR}`,
    );
    return null;
  }

  const packConfigPath = path.resolve(rootDir, "skillpack.json");
  const skillDir = path.resolve(skillsPath, BUILTIN_SKILL_CREATOR_NAME);
  const skillPath = path.join(skillDir, "SKILL.md");

  const renderTemplate = (content: string): string =>
    content
      .replaceAll("{{SKILLS_PATH}}", skillsPath)
      .replaceAll("{{PACK_CONFIG_PATH}}", packConfigPath);

  const copyDir = (srcDir: string, destDir: string): void => {
    fs.mkdirSync(destDir, { recursive: true });

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith(".md") || entry.name.endsWith(".py")) {
        const content = fs.readFileSync(srcPath, "utf-8");
        fs.writeFileSync(destPath, renderTemplate(content), "utf-8");
        continue;
      }

      fs.copyFileSync(srcPath, destPath);
    }
  };

  if (!fs.existsSync(skillDir)) {
    copyDir(BUILTIN_SKILL_CREATOR_TEMPLATE_DIR, skillDir);
  }

  if (!fs.existsSync(skillPath)) {
    log(
      `[PackAgent] Materialized built-in skill-creator but SKILL.md is missing: ${skillPath}`,
    );
    return null;
  }

  return {
    name: BUILTIN_SKILL_CREATOR_NAME,
    description: BUILTIN_SKILL_CREATOR_DESCRIPTION,
    filePath: skillPath,
    baseDir: skillDir,
    source: "path",
    disableModelInvocation: false,
  };
}

function overrideBuiltinSkillCreator(
  base: { skills: Skill[]; diagnostics: any[] },
  materializedSkill: Skill | null,
): { skills: Skill[]; diagnostics: any[] } {
  if (!materializedSkill) {
    return base;
  }

  const filtered = base.skills.filter(
    (skill) => skill.name !== BUILTIN_SKILL_CREATOR_NAME,
  );

  return {
    skills: [materializedSkill, ...filtered],
    diagnostics: base.diagnostics,
  };
}

function readOptionalPackPromptFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch (error) {
    console.warn(`[PackAgent] Warning: Could not read ${filePath}:`, error);
    return undefined;
  }
}

function buildPackPromptBlock(rootDir: string): PackPromptFiles {
  const agentsPath = path.resolve(rootDir, PACK_AGENTS_FILE);
  const soulPath = path.resolve(rootDir, PACK_SOUL_FILE);
  const agentsContent = readOptionalPackPromptFile(agentsPath);
  const soulContent = readOptionalPackPromptFile(soulPath);

  if (!agentsContent && !soulContent) {
    return {
      agentsPath,
      soulPath,
    };
  }

  const sections = [
    "# SkillPack Pack Context",
    "The following instructions are injected by the SkillPack runtime from files packaged with this pack.",
    "Priority order:",
    "1. Follow the user's explicit instructions first.",
    "2. Follow `AGENTS.md` as the pack's operational policy and workflow rules.",
    "3. Follow `SOUL.md` as the pack's persona, tone, and working style.",
    "4. If `SOUL.md` conflicts with `AGENTS.md`, `AGENTS.md` wins.",
    "5. `SOUL.md` does not override task goals, safety boundaries, or `AGENTS.md`.",
  ];

  if (agentsContent) {
    sections.push("## Pack Policy (`AGENTS.md`)", agentsContent);
  }

  if (soulContent) {
    sections.push(
      "## Pack Persona (`SOUL.md`)",
      "Treat the following as persona, tone, and working-style guidance only. Do not let it override task requirements, safety constraints, or `AGENTS.md`.",
      soulContent,
    );
  }

  return {
    agentsPath,
    soulPath,
    agentsContent,
    soulContent,
    promptBlock: sections.join("\n\n"),
  };
}

function getAssistantDiagnostics(message: any): AssistantDiagnostics | null {
  if (!message || message.role !== "assistant") {
    return null;
  }

  const stopReason = message.stopReason ?? "unknown";
  const errorMessage =
    message.errorMessage ||
    (stopReason === "error" || stopReason === "aborted"
      ? `Request ${stopReason}`
      : "");

  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => item.text || "")
    .join("")
    .trim();
  const toolCalls = content.filter(
    (item: any) => item?.type === "toolCall",
  ).length;

  return { stopReason, errorMessage, hasText: text.length > 0, toolCalls };
}

function getLifecycleTrigger(channelId: string): LifecycleTrigger {
  if (channelId.startsWith("telegram-")) return "telegram";
  if (channelId.startsWith("slack-")) return "slack";
  return "web";
}

// ---------------------------------------------------------------------------
// ChannelSession – per-channel agent session wrapper
// ---------------------------------------------------------------------------

interface ChannelSession {
  session: any; // AgentSession from pi-coding-agent
  running: boolean;
  pending: Promise<void>;
}

// ---------------------------------------------------------------------------
// PackAgent
// ---------------------------------------------------------------------------

export class PackAgent implements IPackAgent {
  private options: PackAgentOptions;
  private channels = new Map<string, ChannelSession>();
  private pendingSessionCreations = new Map<string, Promise<ChannelSession>>();
  private fileOutputCallbackRef: { current: FileOutputCallback | null } = {
    current: null,
  };
  private schedulerRef: { current: SchedulerAdapter | null } = { current: null };
  private authStorage: AuthStorage;

  constructor(options: PackAgentOptions) {
    this.options = options;

    // Use ConfigFileAuthBackend to persist OAuth credentials in config.json._auth
    const configPath = path.resolve(options.rootDir, "data", "config.json");
    const backend = new ConfigFileAuthBackend(configPath);
    this.authStorage = AuthStorage.fromStorage(backend);

    // For API Key providers, set runtime key (not persisted to _auth)
    const providerMeta = SUPPORTED_PROVIDERS[options.provider];
    if (providerMeta?.authType === "api_key" && options.apiKey) {
      this.authStorage.setRuntimeApiKey(options.provider, options.apiKey);
    }
  }

  /** Get the shared AuthStorage instance (used by OAuth API endpoints) */
  getAuthStorage(): AuthStorage {
    return this.authStorage;
  }

  /** Update runtime auth when provider/apiKey changes */
  updateAuth(provider: string, apiKey?: string): void {
    // Remove old runtime key
    this.authStorage.removeRuntimeApiKey(this.options.provider);
    this.options.provider = provider;
    if (apiKey) {
      this.options.apiKey = apiKey;
      this.authStorage.setRuntimeApiKey(provider, apiKey);
    }
  }

  /**
   * Inject scheduler reference (called by server.ts after adapter init).
   */
  setScheduler(scheduler: SchedulerAdapter): void {
    this.schedulerRef.current = scheduler;
  }

  private createCustomTools(adapter: "telegram" | "slack" | "web" | "scheduler", channelId: string) {
    const tools = [createSendFileTool(this.fileOutputCallbackRef) as any];
    if (adapter === "telegram" || adapter === "slack") {
      tools.push(createManageScheduleTool(this.schedulerRef, adapter, channelId) as any);
    }
    return tools;
  }

  /**
   * Lazily create (or return existing) session for a channel.
   */
  private async getOrCreateSession(adapter: "telegram" | "slack" | "web" | "scheduler", channelId: string): Promise<ChannelSession> {
    const existing = this.channels.get(channelId);
    if (existing) return existing;

    const pendingCreation = this.pendingSessionCreations.get(channelId);
    if (pendingCreation) return pendingCreation;

    const createSessionPromise = (async () => {
      const { rootDir, provider, modelId, baseUrl } = this.options;

      // Use the shared AuthStorage instance (supports both API Key and OAuth)
      const authStorage = this.authStorage;

      const modelRegistry = new ModelRegistry(authStorage);
      const resolvedModel = modelRegistry.find(provider, modelId);
      const model =
        resolvedModel && baseUrl
          ? { ...resolvedModel, baseUrl }
          : resolvedModel;
      if (resolvedModel && baseUrl) {
        log(`[PackAgent] Overriding ${provider}/${modelId} baseUrl -> ${baseUrl}`);
      }

      const sessionDir = path.resolve(
        rootDir,
        "data",
        "sessions",
        channelId,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionManager = SessionManager.continueRecent(rootDir, sessionDir);
      log(`[PackAgent] Session dir: ${sessionDir}`);

      const workspaceDir = path.resolve(
        rootDir,
        "data",
        "workspaces",
        channelId,
      );
      fs.mkdirSync(workspaceDir, { recursive: true });
      log(`[PackAgent] Workspace dir: ${workspaceDir}`);

      const skillsPath = path.resolve(rootDir, "skills");
      log(`[PackAgent] Loading skills from: ${skillsPath}`);
      const materializedSkillCreator = materializeBuiltinSkillCreator(
        rootDir,
        skillsPath,
      );
      if (materializedSkillCreator) {
        log(
          `[PackAgent] Materialized built-in skill-creator to: ${materializedSkillCreator.filePath}`,
        );
      }

      const packPromptFiles = buildPackPromptBlock(rootDir);
      if (packPromptFiles.agentsContent) {
        log(`[PackAgent] Loaded pack policy from: ${packPromptFiles.agentsPath}`);
      } else {
        log(`[PackAgent] No pack policy file found at: ${packPromptFiles.agentsPath}`);
      }
      if (packPromptFiles.soulContent) {
        log(`[PackAgent] Loaded pack persona from: ${packPromptFiles.soulPath}`);
      } else {
        log(`[PackAgent] No pack persona file found at: ${packPromptFiles.soulPath}`);
      }
      log(
        `[PackAgent] Pack prompt injection: ${packPromptFiles.promptBlock ? "enabled" : "disabled"}`,
      );

      const resourceLoader = new DefaultResourceLoader({
        cwd: rootDir,
        additionalSkillPaths: [skillsPath],
        skillsOverride: (base) =>
          overrideBuiltinSkillCreator(base, materializedSkillCreator),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () =>
          packPromptFiles.promptBlock ? [packPromptFiles.promptBlock] : [],
      });
      await resourceLoader.reload();

      const tools = createCodingTools(workspaceDir);
      const customTools = this.createCustomTools(adapter, channelId);

      const { session } = await createAgentSession({
        cwd: workspaceDir,
        authStorage,
        modelRegistry,
        sessionManager,
        resourceLoader,
        model,
        tools,
        customTools,
      });

      const channelSession: ChannelSession = {
        session,
        running: false,
        pending: Promise.resolve(),
      };
      this.channels.set(channelId, channelSession);
      return channelSession;
    })();

    this.pendingSessionCreations.set(channelId, createSessionPromise);

    try {
      return await createSessionPromise;
    } finally {
      this.pendingSessionCreations.delete(channelId);
    }
  }

  async handleMessage(
    adapter: "telegram" | "slack" | "web" | "scheduler",
    channelId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    attachments?: ChannelAttachment[],
  ): Promise<HandleResult> {
    const cs = await this.getOrCreateSession(adapter, channelId);
    const run = async (): Promise<HandleResult> => {
      cs.running = true;

      let turnHadVisibleOutput = false;

      // Wire up file output callback for this run
      this.fileOutputCallbackRef.current = (event) => {
        onEvent(event);
      };

      // Subscribe to agent events and forward to adapter
      const unsubscribe = cs.session.subscribe((event: any) => {
        switch (event.type) {
          case "agent_start":
            log("\n=== [AGENT SESSION START] ===");
            log("System Prompt:\n", cs.session.systemPrompt);
            log("============================\n");
            onEvent({ type: "agent_start" });
            break;

          case "message_start":
            log(`\n--- [Message Start: ${event.message?.role}] ---`);
            if (event.message?.role === "user") {
              log(JSON.stringify(event.message.content, null, 2));
            }
            onEvent({ type: "message_start", role: event.message?.role ?? "" });
            break;

          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              turnHadVisibleOutput = true;
              write(event.assistantMessageEvent.delta);
              onEvent({
                type: "text_delta",
                delta: event.assistantMessageEvent.delta,
              });
            } else if (event.assistantMessageEvent?.type === "thinking_delta") {
              turnHadVisibleOutput = true;
              onEvent({
                type: "thinking_delta",
                delta: event.assistantMessageEvent.delta,
              });
            }
            break;

          case "message_end":
            log(`\n--- [Message End: ${event.message?.role}] ---`);
            if (event.message?.role === "assistant") {
              const diagnostics = getAssistantDiagnostics(event.message);
              if (diagnostics) {
                log(
                  `[Assistant Diagnostics] stopReason=${diagnostics.stopReason} text=${diagnostics.hasText ? "yes" : "no"} toolCalls=${diagnostics.toolCalls}`,
                );
                if (diagnostics.errorMessage) {
                  log(`[Assistant Error] ${diagnostics.errorMessage}`);
                }
              }
            }
            onEvent({ type: "message_end", role: event.message?.role ?? "" });
            break;

          case "tool_execution_start":
            turnHadVisibleOutput = true;
            log(`\n>>> [Tool Start: ${event.toolName}] >>>`);
            log("Args:", JSON.stringify(event.args, null, 2));
            onEvent({
              type: "tool_start",
              toolName: event.toolName,
              toolInput: event.args,
            });
            break;

          case "tool_execution_end":
            turnHadVisibleOutput = true;
            log(`<<< [Tool End: ${event.toolName}] <<<`);
            log(`Error: ${event.isError ? "Yes" : "No"}`);
            onEvent({
              type: "tool_end",
              toolName: event.toolName,
              isError: event.isError,
              result: event.result,
            });
            break;

          case "agent_end":
            log("\n=== [AGENT SESSION END] ===\n");
            onEvent({ type: "agent_end" });
            break;
        }
      });

      try {
        // Build prompt with attachments
        let promptText = text;
        const promptOptions: { images?: Array<{ type: "image"; data: string; mimeType: string }> } = {};

        if (attachments && attachments.length > 0) {
          // Separate image vs non-image attachments
          const imageAttachments = attachments.filter((a) => isImageMime(a.mimeType));
          const nonImageAttachments = attachments.filter((a) => !isImageMime(a.mimeType));

          // Images → ImageContent[] for direct LLM vision
          if (imageAttachments.length > 0) {
            promptOptions.images = attachmentsToImageContent(imageAttachments);
            log(`[PackAgent] Passing ${imageAttachments.length} image(s) to LLM`);
          }

          // Non-images → text description prepended to prompt
          if (nonImageAttachments.length > 0) {
            const attachmentPrompt = formatAttachmentsPrompt(nonImageAttachments);
            promptText = `${attachmentPrompt}\n\n${text}`;
            log(`[PackAgent] Injecting ${nonImageAttachments.length} non-image attachment(s) into prompt`);
          }
        }

        await cs.session.prompt(promptText, promptOptions);

        const lastMessage = cs.session.state.messages.at(-1);
        const diagnostics = getAssistantDiagnostics(lastMessage);

        if (diagnostics?.errorMessage) {
          return {
            stopReason: diagnostics.stopReason,
            errorMessage: diagnostics.errorMessage,
          };
        }

        if (
          diagnostics &&
          !diagnostics.hasText &&
          diagnostics.toolCalls === 0 &&
          !turnHadVisibleOutput
        ) {
          return {
            stopReason: diagnostics.stopReason,
            errorMessage:
              "Assistant returned no visible output. Check the server logs for details.",
          };
        }

        return { stopReason: diagnostics?.stopReason ?? "unknown" };
      } finally {
        cs.running = false;
        this.fileOutputCallbackRef.current = null;
        unsubscribe();
      }
    };

    const resultPromise = cs.pending.catch(() => undefined).then(run);
    cs.pending = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  async handleCommand(
    command: BotCommand,
    channelId: string,
  ): Promise<CommandResult> {
    switch (command) {
      case "new":
      case "clear": {
        const cs = this.channels.get(channelId);
        if (cs) {
          cs.session.dispose();
          this.channels.delete(channelId);
        }
        const { rootDir } = this.options;
        const sessionDir = path.resolve(rootDir, "data", "sessions", channelId);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          log(`[PackAgent] Cleared session dir: ${sessionDir}`);
        }
        return {
          success: true,
          message: command === "new" ? "New session started." : "Session cleared.",
        };
      }

      case "restart":
        log("[PackAgent] Restart requested");
        return this.options.lifecycleHandler.requestRestart(
          getLifecycleTrigger(channelId),
        );

      case "shutdown":
        log("[PackAgent] Shutdown requested");
        return this.options.lifecycleHandler.requestShutdown(
          getLifecycleTrigger(channelId),
        );

      default:
        return { success: false, message: `Unknown command: ${command}` };
    }
  }

  abort(channelId: string): void {
    const cs = this.channels.get(channelId);
    if (cs?.running) {
      cs.session.abort?.();
    }
  }

  isRunning(channelId: string): boolean {
    return this.channels.get(channelId)?.running ?? false;
  }

  dispose(channelId: string): void {
    const cs = this.channels.get(channelId);
    if (cs) {
      cs.session.dispose();
      this.channels.delete(channelId);
    }
  }

  /** Reserved: list all sessions */
  listSessions(): SessionInfo[] {
    return [];
  }

  /** Reserved: restore a historical session */
  async restoreSession(_sessionId: string): Promise<void> {
    // TODO: Implement session restoration
  }
}
