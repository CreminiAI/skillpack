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
// Scheduled Job Configuration
// ---------------------------------------------------------------------------

export interface ScheduledJobConfig {
  /** Unique job name */
  name: string;
  /** Standard 5-field cron expression */
  cron: string;
  /** Prompt to send to the Agent when triggered */
  prompt: string;
  /** Where to push the result */
  notify: {
    adapter: string;   // "telegram" | "slack"
    channelId: string; // e.g. "telegram-123456"
  };
  /** Defaults to true; set false to skip */
  enabled?: boolean;
  /** Optional timezone, e.g. "Asia/Shanghai" */
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Data Config
// ---------------------------------------------------------------------------

export interface DataConfig {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  modelId?: string;
  apiProtocol?: "openai-responses" | "openai-completions";
  adapters?: {
    telegram?: { token?: string };
    slack?: {
      botToken?: string;
      appToken?: string;
    };
    [key: string]: any;
  };
  scheduledJobs?: ScheduledJobConfig[];
  /** OAuth credentials managed by AuthStorage (do not edit manually) */
  _auth?: Record<string, unknown>;
}

export class ConfigManager {
  private static instance: ConfigManager;
  private configData: DataConfig = {};
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
    if (fs.existsSync(this.configPath)) {
      try {
        this.configData = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
        console.log("  Loaded config from data/config.json");
      } catch (err) {
        console.warn("  Warning: Failed to parse data/config.json:", err);
      }
    }

    // Environment variables as fallback if not set in config file
    let { apiKey = "", provider = "openai", baseUrl = "" } = this.configData;
    if (!apiKey) {
      if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
        provider = "openai";
      } else if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
        provider = "anthropic";
      } else if (process.env.GOOGLE_API_KEY) {
        apiKey = process.env.GOOGLE_API_KEY;
        provider = "google";
      }
    }

    this.configData.apiKey = apiKey;
    this.configData.provider = provider;
    this.configData.baseUrl = baseUrl?.trim() || undefined;
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
    if (updates.apiKey !== undefined) this.configData.apiKey = updates.apiKey;
    if (updates.provider !== undefined) this.configData.provider = updates.provider;
    if (updates.baseUrl !== undefined) {
      this.configData.baseUrl = updates.baseUrl?.trim() || undefined;
    }
    if (updates.modelId !== undefined) {
      this.configData.modelId = updates.modelId?.trim() || undefined;
    }
    if (updates.apiProtocol !== undefined) {
      this.configData.apiProtocol = updates.apiProtocol || undefined;
    }

    // Per-adapter key handling: null = delete, object = overwrite
    if (updates.adapters !== undefined) {
      const merged: DataConfig["adapters"] = { ...(this.configData.adapters || {}) };
      for (const [adapterKey, adapterVal] of Object.entries(updates.adapters)) {
        if (adapterVal === null || adapterVal === undefined) {
          delete merged[adapterKey];
        } else {
          merged[adapterKey] = adapterVal;
        }
      }
      this.configData.adapters = merged;
    }

    // Scheduled jobs: full replacement (array merge semantics are ambiguous)
    if (updates.scheduledJobs !== undefined) {
      this.configData.scheduledJobs = updates.scheduledJobs;
    }

    try {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.configData, null, 2),
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
