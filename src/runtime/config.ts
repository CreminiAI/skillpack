import fs from "node:fs";
import path from "node:path";

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
  /** Skillpack Dashboard server URL, e.g. "https://api.skillpack.sh" */
  serverUrl?: string;
  /** Agent token from Dashboard registration (used for Socket.IO auth) */
  agentToken?: string;
  adapters?: {
    telegram?: { token?: string };
    slack?: {
      botToken?: string;
      appToken?: string;
    };
    [key: string]: any;
  };
  scheduledJobs?: ScheduledJobConfig[];
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
    let { apiKey = "", provider = "openai" } = this.configData;
    if (!apiKey) {
      if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
        provider = "openai";
      } else if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
        provider = "anthropic";
      }
    }

    this.configData.apiKey = apiKey;
    this.configData.provider = provider;
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
    if (updates.serverUrl !== undefined) this.configData.serverUrl = updates.serverUrl;
    if (updates.agentToken !== undefined) this.configData.agentToken = updates.agentToken;

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
