import fs from "node:fs";
import path from "node:path";
import type { AuthStorageBackend } from "@mariozechner/pi-coding-agent";

type LockResult<T> = { result: T; next?: string };

// ---------------------------------------------------------------------------
// Provider Metadata
// ---------------------------------------------------------------------------

export interface ProviderMeta {
  label: string;
  defaultModelId: string;
  authType: "api_key" | "oauth";
  /** Environment variable name for API key fallback (api_key mode only) */
  envKey?: string;
  /** Input placeholder hint (api_key mode only) */
  placeholder?: string;
  /** Custom base URL placeholder hint (providers that support proxying only) */
  baseUrlPlaceholder?: string;
  /** OAuth provider ID registered in SDK (oauth mode only) */
  oauthProviderId?: string;
  /** Whether this provider supports custom base URL (for proxying) */
  supportsBaseUrl: boolean;
}

export const SUPPORTED_PROVIDERS: Record<string, ProviderMeta> = {
  openai: {
    label: "OpenAI",
    defaultModelId: "gpt-5.4",
    authType: "api_key",
    envKey: "OPENAI_API_KEY",
    placeholder: "sk-proj-...",
    baseUrlPlaceholder: "https://api.openai.com/v1",
    supportsBaseUrl: true,
  },
  anthropic: {
    label: "Anthropic",
    defaultModelId: "claude-opus-4-6",
    authType: "api_key",
    envKey: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api03-...",
    baseUrlPlaceholder: "https://api.anthropic.com",
    supportsBaseUrl: true,
  },
  google: {
    label: "Google (Gemini)",
    defaultModelId: "gemini-2.5-pro",
    authType: "api_key",
    envKey: "GOOGLE_API_KEY",
    placeholder: "AIza...",
    supportsBaseUrl: false,
  },
  "openai-codex": {
    label: "OpenAI Codex",
    defaultModelId: "gpt-5.4",
    authType: "oauth",
    oauthProviderId: "openai-codex",
    supportsBaseUrl: false,
  },
};

// ---------------------------------------------------------------------------
// Data Config
// ---------------------------------------------------------------------------

export interface DataConfig {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  modelId?: string;
  apiProtocol?: "openai-responses" | "openai-completions";
  reasoning?: boolean;
  adapters?: {
    telegram?: { token?: string };
    slack?: {
      botToken?: string;
      appToken?: string;
    };
    feishu?: {
      appId?: string;
      appSecret?: string;
      domain?: "feishu" | "lark";
    };
    [key: string]: any;
  };
  /** OAuth credentials managed by AuthStorage (do not edit manually) */
  _auth?: Record<string, unknown>;
}

export const SKILLPACK_RUNTIME_ENV = {
  apiKey: "SKILLPACK_API_KEY",
  provider: "SKILLPACK_PROVIDER",
  baseUrl: "SKILLPACK_BASE_URL",
  apiProtocol: "SKILLPACK_API_PROTOCOL",
  reasoning: "SKILLPACK_REASONING",
} as const;

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function hasEnvOverride(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeFeishuAdapterConfig(
  value: unknown,
): { appId?: string; appSecret?: string; domain?: "feishu" | "lark" } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;

  return {
    appId: typeof raw.appId === "string" ? raw.appId : undefined,
    appSecret: typeof raw.appSecret === "string" ? raw.appSecret : undefined,
    domain: raw.domain === "lark" ? "lark" : "feishu",
  };
}

function normalizeDataConfig(value: unknown): DataConfig {
  if (!value || typeof value !== "object") {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const normalized: DataConfig = {};

  if (typeof raw.apiKey === "string") {
    normalized.apiKey = raw.apiKey;
  }
  if (typeof raw.provider === "string") {
    normalized.provider = raw.provider;
  }
  if (typeof raw.baseUrl === "string") {
    normalized.baseUrl = raw.baseUrl;
  }
  if (typeof raw.modelId === "string") {
    normalized.modelId = raw.modelId;
  }
  if (
    raw.apiProtocol === "openai-responses" ||
    raw.apiProtocol === "openai-completions"
  ) {
    normalized.apiProtocol = raw.apiProtocol;
  }
  if (typeof raw.reasoning === "boolean") {
    normalized.reasoning = raw.reasoning;
  }
  if (raw.adapters && typeof raw.adapters === "object" && !Array.isArray(raw.adapters)) {
    const rawAdapters = raw.adapters as Record<string, unknown>;
    const adapters = { ...rawAdapters } as NonNullable<DataConfig["adapters"]>;
    const feishu = normalizeFeishuAdapterConfig(rawAdapters.feishu);
    if (feishu) {
      adapters.feishu = feishu;
    }
    normalized.adapters = adapters;
  }
  if (raw._auth && typeof raw._auth === "object" && !Array.isArray(raw._auth)) {
    normalized._auth = raw._auth as Record<string, unknown>;
  }

  return normalized;
}

export function resolveRuntimeConfig(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): DataConfig {
  const normalized = normalizeDataConfig(value);
  let { apiKey = "", provider = "openai", baseUrl = "" } = normalized;
  let { apiProtocol, reasoning } = normalized;

  if (!apiKey) {
    if (env.OPENAI_API_KEY) {
      apiKey = env.OPENAI_API_KEY;
      provider = "openai";
    } else if (env.ANTHROPIC_API_KEY) {
      apiKey = env.ANTHROPIC_API_KEY;
      provider = "anthropic";
    } else if (env.GOOGLE_API_KEY) {
      apiKey = env.GOOGLE_API_KEY;
      provider = "google";
    }
  }

  if (hasEnvOverride(env, SKILLPACK_RUNTIME_ENV.apiKey)) {
    apiKey = env[SKILLPACK_RUNTIME_ENV.apiKey] ?? "";
  }

  if (hasEnvOverride(env, SKILLPACK_RUNTIME_ENV.provider)) {
    const providerOverride = normalizeOptionalString(env[SKILLPACK_RUNTIME_ENV.provider]);
    if (providerOverride) {
      provider = providerOverride;
    }
  }

  if (hasEnvOverride(env, SKILLPACK_RUNTIME_ENV.baseUrl)) {
    baseUrl = env[SKILLPACK_RUNTIME_ENV.baseUrl] ?? "";
  }

  if (hasEnvOverride(env, SKILLPACK_RUNTIME_ENV.apiProtocol)) {
    const apiProtocolOverride = env[SKILLPACK_RUNTIME_ENV.apiProtocol];
    if (
      apiProtocolOverride === "openai-responses" ||
      apiProtocolOverride === "openai-completions"
    ) {
      apiProtocol = apiProtocolOverride;
    } else if ((apiProtocolOverride ?? "").trim() === "") {
      apiProtocol = undefined;
    }
  }

  if (hasEnvOverride(env, SKILLPACK_RUNTIME_ENV.reasoning)) {
    const reasoningOverride = parseBooleanEnv(env[SKILLPACK_RUNTIME_ENV.reasoning]);
    if (reasoningOverride !== undefined) {
      reasoning = reasoningOverride;
    }
  }

  return {
    ...normalized,
    apiKey,
    provider,
    baseUrl: baseUrl?.trim() || undefined,
    apiProtocol,
    reasoning,
  };
}

export class ConfigManager {
  private static instance: ConfigManager;
  private configData: DataConfig = {};
  private fileConfigData: DataConfig = {};
  private configPath: string = "";

  private constructor() {}

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public load(rootDir: string): DataConfig {
    this.configPath = path.join(rootDir, "data", "config.json");
    this.configData = {};
    this.fileConfigData = {};
    if (fs.existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          "scheduledJobs" in (parsed as Record<string, unknown>)
        ) {
          console.warn(
            '  Warning: data/config.json contains deprecated "scheduledJobs". Move them to job.json at the pack root; the old field is ignored.',
          );
        }
        this.fileConfigData = normalizeDataConfig(parsed);
        console.log("  Loaded config from data/config.json");
      } catch (err) {
        console.warn("  Warning: Failed to parse data/config.json:", err);
      }
    }
    this.configData = resolveRuntimeConfig(this.fileConfigData);
    return this.configData;
  }

  public getConfig(): DataConfig {
    return this.configData;
  }

  public save(rootDir: string, updates: Partial<DataConfig>): void {
    const configDir = path.join(rootDir, "data");
    if (!this.configPath) {
      this.configPath = path.join(rootDir, "data", "config.json");
    }
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Merge configuration
    if (updates.apiKey !== undefined) this.fileConfigData.apiKey = updates.apiKey;
    if (updates.provider !== undefined) this.fileConfigData.provider = updates.provider;
    if (updates.baseUrl !== undefined) {
      this.fileConfigData.baseUrl = updates.baseUrl?.trim() || undefined;
    }
    if (updates.modelId !== undefined) {
      this.fileConfigData.modelId = updates.modelId?.trim() || undefined;
    }
    if (updates.apiProtocol !== undefined) {
      this.fileConfigData.apiProtocol = updates.apiProtocol || undefined;
    }
    if (updates.reasoning !== undefined) {
      this.fileConfigData.reasoning = updates.reasoning;
    }

    // Per-adapter key handling: null = delete, object = overwrite
    if (updates.adapters !== undefined) {
      const merged: DataConfig["adapters"] = { ...(this.fileConfigData.adapters || {}) };
      for (const [adapterKey, adapterVal] of Object.entries(updates.adapters)) {
        if (adapterVal === null || adapterVal === undefined) {
          delete merged[adapterKey];
        } else {
          merged[adapterKey] = adapterVal;
        }
      }
      this.fileConfigData.adapters = merged;
    }

    if (updates._auth !== undefined) {
      this.fileConfigData._auth = updates._auth;
    }

    try {
      this.fileConfigData = normalizeDataConfig(this.fileConfigData);
      this.configData = resolveRuntimeConfig(this.fileConfigData);
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.fileConfigData, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }
}

export const configManager = ConfigManager.getInstance();

// ---------------------------------------------------------------------------
// ConfigFileAuthBackend – stores OAuth credentials inside config.json._auth
// ---------------------------------------------------------------------------

/**
 * Custom AuthStorageBackend that persists OAuth credentials to the `_auth`
 * field of config.json, keeping all configuration in a single file.
 */
export class ConfigFileAuthBackend implements AuthStorageBackend {
  constructor(private configPath: string) {}

  private ensureFile(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, "{}", "utf-8");
    }
  }

  private readAuthJson(): string | undefined {
    this.ensureFile();
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const config = JSON.parse(raw);
      if (config._auth && typeof config._auth === "object") {
        return JSON.stringify(config._auth);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private writeAuthJson(authJson: string): void {
    this.ensureFile();
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const config = JSON.parse(raw);
      config._auth = JSON.parse(authJson);
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch {
      // If config.json is unreadable, write a minimal file
      const config = { _auth: JSON.parse(authJson) };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    }
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const current = this.readAuthJson();
    const { result, next } = fn(current);
    if (next !== undefined) {
      this.writeAuthJson(next);
    }
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const current = this.readAuthJson();
    const { result, next } = await fn(current);
    if (next !== undefined) {
      this.writeAuthJson(next);
    }
    return result;
  }
}
