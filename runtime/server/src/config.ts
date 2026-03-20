import fs from "node:fs";
import path from "node:path";

export interface DataConfig {
  apiKey?: string;
  provider?: string;
  adapters?: {
    telegram?: { token?: string };
    slack?: {
      botToken?: string;
      appToken?: string;
    };
    [key: string]: any;
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
    
    // Deep merge for adapters to avoid losing other objects not provided in this update 
    if (updates.adapters !== undefined) {
      this.configData.adapters = {
        ...(this.configData.adapters || {}),
        ...updates.adapters
      };
    }

    try {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.configData, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }
}

export const configManager = ConfigManager.getInstance();
