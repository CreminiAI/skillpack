/**
 * MemoryManager – OpenViking HTTP 客户端封装
 *
 * 负责与 OpenViking Server 通信，管理记忆同步和检索。
 * 所有操作均为尽力而为（best-effort），失败不影响主推理流程。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryConfig {
  /** 是否启用 Memory 功能 */
  enabled: boolean;
  /** OpenViking Server 的 base URL，例如 http://localhost:1933 */
  serverUrl: string;
  /** 单次检索返回的最大记忆数 */
  maxMemories?: number;
}

interface OVResponse<T = unknown> {
  status: "ok" | "error";
  result?: T;
  error?: { code: string; message: string };
}

interface FindResultItem {
  uri: string;
  abstract?: string;
  content?: string;
  score?: number;
}

interface FindResult {
  items?: FindResultItem[];
  results?: FindResultItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (...args: unknown[]) => console.log("[Memory]", ...args);
const warn = (...args: unknown[]) => console.warn("[Memory]", ...args);

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private serverUrl: string;
  private maxMemories: number;
  /** channelId → OpenViking session ID */
  private channelSessions = new Map<string, string>();
  private healthy = false;

  constructor(config: MemoryConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.maxMemories = config.maxMemories ?? 5;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<OVResponse<T> | null> {
    const url = `${this.serverUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      return (await res.json()) as OVResponse<T>;
    } catch (err) {
      warn(`Request failed: ${method} ${path}`, err);
      return null;
    }
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /** 检查 OpenViking Server 是否可达 */
  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.serverUrl}/api/v1/system/status`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
    if (this.healthy) {
      log("OpenViking server is healthy at", this.serverUrl);
    } else {
      warn("OpenViking server is unreachable at", this.serverUrl);
    }
    return this.healthy;
  }

  /**
   * 为指定 channel 创建 OpenViking Session。
   * 如果已有 session 则返回已有的 ID。
   */
  async createSession(channelId: string): Promise<string | null> {
    const existing = this.channelSessions.get(channelId);
    if (existing) return existing;

    const resp = await this.request<{ session_id: string }>(
      "POST",
      "/api/v1/sessions",
      {},
    );
    if (!resp || resp.status !== "ok" || !resp.result?.session_id) {
      warn("Failed to create OV session for channel", channelId);
      return null;
    }
    const ovSessionId = resp.result.session_id;
    this.channelSessions.set(channelId, ovSessionId);
    log(`Created OV session: ${ovSessionId} for channel: ${channelId}`);
    return ovSessionId;
  }

  // ── 消息同步 ──────────────────────────────────────────────────────────

  /**
   * 添加消息到 OV Session（异步、fire-and-forget）。
   * 不阻塞主推理流程。
   */
  syncMessage(
    channelId: string,
    role: "user" | "assistant",
    content: string,
  ): void {
    const ovSessionId = this.channelSessions.get(channelId);
    if (!ovSessionId || !content.trim()) return;

    // Fire-and-forget
    this.request("POST", `/api/v1/sessions/${ovSessionId}/messages`, {
      role,
      content,
    }).catch((err) => {
      warn("Failed to sync message:", err);
    });
  }

  // ── 记忆检索 ──────────────────────────────────────────────────────────

  /**
   * 根据用户消息检索相关记忆。
   * 返回格式化好的 context 字符串，可直接注入 system prompt。
   * 如果无可用记忆或出错则返回空字符串。
   */
  async retrieveMemories(query: string): Promise<string> {
    if (!this.healthy) return "";

    // 同时检索 user memories 和 agent memories
    const [userMemories, agentMemories] = await Promise.all([
      this.findMemories(query, "viking://user/memories"),
      this.findMemories(query, "viking://agent/memories"),
    ]);

    const allMemories = [...userMemories, ...agentMemories];
    if (allMemories.length === 0) return "";

    return this.formatMemoryContext(allMemories);
  }

  private async findMemories(
    query: string,
    targetUri: string,
  ): Promise<FindResultItem[]> {
    try {
      const resp = await this.request<FindResult>(
        "POST",
        "/api/v1/search/find",
        {
          query,
          target_uri: targetUri,
          limit: this.maxMemories,
        },
      );
      if (!resp || resp.status !== "ok") return [];
      // OpenViking find 返回 results 或 items
      return resp.result?.results ?? resp.result?.items ?? [];
    } catch {
      return [];
    }
  }

  private formatMemoryContext(memories: FindResultItem[]): string {
    if (memories.length === 0) return "";

    const lines = [
      "## 历史记忆（来自以往对话）",
      "",
      "以下是与当前用户相关的历史记忆，请在回答时参考：",
      "",
    ];

    for (const mem of memories) {
      const label = this.categorizeUri(mem.uri);
      const text = mem.abstract || mem.content || "";
      if (text.trim()) {
        lines.push(`### ${label}`);
        lines.push(text.trim());
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  private categorizeUri(uri: string): string {
    if (uri.includes("/profile")) return "用户画像";
    if (uri.includes("/preferences")) return "用户偏好";
    if (uri.includes("/entities")) return "关联实体";
    if (uri.includes("/events")) return "历史事件";
    if (uri.includes("/cases")) return "相关案例";
    if (uri.includes("/patterns")) return "经验模式";
    return "记忆片段";
  }

  // ── 会话提交 ──────────────────────────────────────────────────────────

  /**
   * 提交 OV Session，触发后台记忆提取。
   * 使用 wait=false 让 OpenViking 异步处理。
   */
  async commitSession(channelId: string): Promise<void> {
    const ovSessionId = this.channelSessions.get(channelId);
    if (!ovSessionId) return;

    log(`Committing OV session: ${ovSessionId} for channel: ${channelId}`);
    const resp = await this.request(
      "POST",
      `/api/v1/sessions/${ovSessionId}/commit?wait=false`,
      {},
    );
    if (resp?.status === "ok") {
      log("OV session commit accepted (background processing)");
    } else {
      warn("OV session commit failed:", resp?.error?.message);
    }
  }

  /**
   * 销毁 channel 的 OV Session 映射。
   * 先尝试提交以提取记忆，然后移除映射。
   */
  async disposeSession(channelId: string): Promise<void> {
    if (this.channelSessions.has(channelId)) {
      await this.commitSession(channelId);
      this.channelSessions.delete(channelId);
    }
  }
}
