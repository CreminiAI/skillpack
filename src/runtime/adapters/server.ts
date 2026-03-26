/**
 * Server Adapter – connects the local Skillpack agent to a remote
 * skillpack-server (Dashboard Control Plane) via Socket.IO.
 *
 * Responsibilities:
 * 1. Authenticate with agentToken
 * 2. Send periodic heartbeats (status, skills, config, host/port)
 * 3. Forward AgentEvents from all adapters to the server
 * 4. Receive and execute commands from the Dashboard (restart, shutdown, etc.)
 */

import { io, type Socket } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { configManager } from "../config.js";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  LifecycleHandler,
  LifecycleInfo,
} from "./types.js";

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

export interface ServerAdapterOptions {
  serverUrl: string;
  agentToken: string;
}

export class ServerAdapter implements PlatformAdapter {
  readonly name = "server";

  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private options: ServerAdapterOptions;
  private rootDir = "";
  private lifecycle: (LifecycleInfo & LifecycleHandler) | null = null;
  private localHost = "127.0.0.1";
  private localPort = 26313;

  constructor(options: ServerAdapterOptions) {
    this.options = options;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.rootDir = ctx.rootDir;
    this.lifecycle = ctx.lifecycle;

    // Detect the local host/port from the HTTP server
    const addr = ctx.server.address();
    if (addr && typeof addr !== "string") {
      this.localPort = addr.port;
      // If listening on 0.0.0.0, report the machine hostname
      this.localHost =
        addr.address === "0.0.0.0" || addr.address === "::"
          ? os.hostname()
          : addr.address;
    }

    const { serverUrl, agentToken } = this.options;

    // Connect to the server's /agent namespace with the token
    this.socket = io(`${serverUrl}/agent`, {
      auth: { token: agentToken },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on("connect", () => {
      console.log(`[ServerAdapter] Connected to ${serverUrl}`);
      // Send initial heartbeat immediately
      this.sendHeartbeat();
    });

    this.socket.on("disconnect", (reason) => {
      console.log(`[ServerAdapter] Disconnected: ${reason}`);
    });

    this.socket.on("connect_error", (err) => {
      console.warn(`[ServerAdapter] Connection error: ${err.message}`);
    });

    // Listen for commands from the Dashboard
    this.socket.on("agent:command", async (cmd: {
      commandId: string;
      type: string;
      action: string;
      payload: any;
    }) => {
      console.log(
        `[ServerAdapter] Received command: ${cmd.action} (${cmd.type})`,
      );
      await this.handleCommand(cmd);
    });

    // Start periodic heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);

    console.log(`[ServerAdapter] Started (server: ${serverUrl})`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    console.log("[ServerAdapter] Stopped");
  }

  /**
   * Forward an AgentEvent to the Dashboard via Socket.IO.
   * Called by the runtime when any adapter produces events.
   */
  forwardEvent(event: AgentEvent): void {
    if (this.socket?.connected) {
      this.socket.emit("agent:event", event);
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private sendHeartbeat(): void {
    if (!this.socket?.connected) return;

    // Read skills from skillpack.json
    let skills: any[] = [];
    try {
      const packPath = path.join(this.rootDir, "skillpack.json");
      if (fs.existsSync(packPath)) {
        const pack = JSON.parse(fs.readFileSync(packPath, "utf-8"));
        skills = pack.skills || [];
      }
    } catch {
      // ignore
    }

    const config = configManager.getConfig();

    this.socket.emit("agent:heartbeat", {
      status: "running",
      skills,
      config: {
        provider: config.provider,
        hasApiKey: !!config.apiKey,
        adapters: Object.keys(config.adapters || {}),
      },
      uptime: process.uptime(),
      host: this.localHost,
      port: this.localPort,
    });
  }

  // ---------------------------------------------------------------------------
  // Command handler
  // ---------------------------------------------------------------------------

  private async handleCommand(cmd: {
    commandId: string;
    type: string;
    action: string;
    payload: any;
  }): Promise<void> {
    try {
      switch (cmd.action) {
        case "restart":
          if (this.lifecycle) {
            this.reportCommandResult(cmd.commandId, "applied", {
              message: "Restarting...",
            });
            setTimeout(() => {
              this.lifecycle!.requestRestart("web");
            }, 500);
          } else {
            this.reportCommandResult(cmd.commandId, "failed", undefined, "Lifecycle handler not available");
          }
          return;

        case "shutdown":
          if (this.lifecycle) {
            this.reportCommandResult(cmd.commandId, "applied", {
              message: "Shutting down...",
            });
            setTimeout(() => {
              this.lifecycle!.requestShutdown("web");
            }, 500);
          } else {
            this.reportCommandResult(cmd.commandId, "failed", undefined, "Lifecycle handler not available");
          }
          return;

        case "update_config":
          if (cmd.payload) {
            configManager.save(this.rootDir, cmd.payload);
            this.reportCommandResult(cmd.commandId, "applied", {
              message: "Config updated",
            });
          } else {
            this.reportCommandResult(cmd.commandId, "failed", undefined, "No payload");
          }
          return;

        default:
          this.reportCommandResult(
            cmd.commandId,
            "failed",
            undefined,
            `Unknown action: ${cmd.action}`,
          );
          return;
      }
    } catch (err: any) {
      this.reportCommandResult(cmd.commandId, "failed", undefined, err.message);
    }
  }

  private reportCommandResult(
    commandId: string,
    status: "applied" | "failed",
    result?: any,
    error?: string,
  ): void {
    if (!this.socket?.connected) return;
    this.socket.emit("agent:command:result", {
      commandId,
      status,
      result,
      error,
    });
  }
}
