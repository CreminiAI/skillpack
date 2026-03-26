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
  /** Model selection in "provider/modelId" format, e.g. "openai/gpt-5.4" */
  model?: string;
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

/** Parse a "provider/modelId" string into its parts. */
export function parseModelSpec(model: string): { provider: string; modelId: string } | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return null;
  return {
    provider: model.slice(0, slashIndex),
    modelId: model.slice(slashIndex + 1),
  };
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
    if (updates.model !== undefined) this.configData.model = updates.model;

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
