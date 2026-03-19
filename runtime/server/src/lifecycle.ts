import type { Server } from "node:http";

import type {
  CommandResult,
  LifecycleHandler,
  LifecycleInfo,
  LifecycleTrigger,
  PlatformAdapter,
  ProcessManager,
  RuntimeControl,
} from "./adapters/types.js";

export const SHUTDOWN_EXIT_CODE = 64;
export const RESTART_EXIT_CODE = 75;
const STOP_TIMEOUT_MS = 3_000;

type StopReason = "restart" | "shutdown";
type ExitFn = (code: number) => never | void;

function detectProcessManager(): ProcessManager {
  return process.env.SKILLPACK_PROCESS_MANAGER === "pm2" ? "pm2" : "none";
}

export class Lifecycle implements LifecycleHandler, LifecycleInfo {
  private readonly server: Server;
  private readonly exitFn: ExitFn;
  private readonly processManager: ProcessManager;
  private adapters: PlatformAdapter[] = [];
  private stopReason: StopReason | null = null;

  constructor(server: Server, exitFn: ExitFn = (code) => process.exit(code)) {
    this.server = server;
    this.exitFn = exitFn;
    this.processManager = detectProcessManager();
  }

  registerAdapters(adapters: PlatformAdapter[]): void {
    this.adapters = adapters;
  }

  getRuntimeControl(): RuntimeControl {
    return {
      canManagedRestart: this.processManager === "pm2",
      processManager: this.processManager,
    };
  }

  async requestRestart(trigger: LifecycleTrigger): Promise<CommandResult> {
    return this.requestStop("restart", trigger);
  }

  async requestShutdown(trigger: LifecycleTrigger): Promise<CommandResult> {
    return this.requestStop("shutdown", trigger);
  }

  private async requestStop(
    reason: StopReason,
    trigger: LifecycleTrigger,
  ): Promise<CommandResult> {
    if (this.stopReason) {
      const message =
        this.stopReason === "restart"
          ? "Restart already in progress."
          : "Shutdown already in progress.";
      return { success: true, message };
    }

    this.stopReason = reason;
    console.log(`[Lifecycle] ${reason} requested via ${trigger}`);

    setTimeout(() => {
      void this.gracefulStopAndExit(reason);
    }, 50);

    return {
      success: true,
      message: reason === "restart" ? "Restarting..." : "Shutting down...",
    };
  }

  private async gracefulStopAndExit(reason: StopReason): Promise<void> {
    try {
      await Promise.race([
        this.gracefulStop(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            console.warn("[Lifecycle] Graceful stop timed out, forcing exit.");
            resolve();
          }, STOP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.error("[Lifecycle] Error during graceful stop:", err);
    }

    const exitCode =
      reason === "restart" ? RESTART_EXIT_CODE : SHUTDOWN_EXIT_CODE;
    this.exitFn(exitCode);
  }

  private async gracefulStop(): Promise<void> {
    for (const adapter of [...this.adapters].reverse()) {
      try {
        await adapter.stop();
      } catch (err) {
        console.error(`[Lifecycle] Failed to stop ${adapter.name}:`, err);
      }
    }

    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
