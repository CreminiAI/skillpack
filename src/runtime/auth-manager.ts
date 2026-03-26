import path from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// AuthManager — centralised credential management via SDK AuthStorage
// ---------------------------------------------------------------------------

export class AuthManager {
  private static instance: AuthManager;
  private authStorage: AuthStorage | null = null;

  private constructor() {}

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager();
    }
    return AuthManager.instance;
  }

  /** Initialise AuthStorage with FileAuthStorageBackend. */
  init(rootDir: string): AuthStorage {
    const authPath = path.resolve(rootDir, "data", "auth.json");
    this.authStorage = AuthStorage.create(authPath);
    return this.authStorage;
  }

  /** Get the AuthStorage instance (must call init() first). */
  getAuthStorage(): AuthStorage {
    if (!this.authStorage) {
      throw new Error("AuthManager not initialised. Call init() first.");
    }
    return this.authStorage;
  }

  /** Set an API key for a provider (persisted to auth.json). */
  setApiKey(provider: string, apiKey: string): void {
    this.getAuthStorage().set(provider, { type: "api_key", key: apiKey });
  }

  /** Remove credential for a provider. */
  removeAuth(provider: string): void {
    this.getAuthStorage().remove(provider);
  }

  /** Check if any auth is configured for a provider. */
  hasAuth(provider: string): boolean {
    return this.getAuthStorage().hasAuth(provider);
  }

  /** List all providers that have credentials. */
  listProviders(): string[] {
    return this.getAuthStorage().list();
  }

  /** Get the credential type for a provider. */
  getCredentialType(provider: string): "api_key" | "oauth" | null {
    const cred = this.getAuthStorage().get(provider);
    if (!cred) return null;
    return cred.type === "api_key" ? "api_key" : "oauth";
  }

  /** List all providers with their credential types. */
  listProvidersWithTypes(): Array<{ provider: string; type: string; hasAuth: boolean }> {
    return this.listProviders().map((provider) => ({
      provider,
      type: this.getCredentialType(provider) ?? "unknown",
      hasAuth: this.hasAuth(provider),
    }));
  }
}

export const authManager = AuthManager.getInstance();
