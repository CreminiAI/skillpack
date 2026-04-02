# SkillPack 定时任务功能设计探讨

## 1. 现有架构回顾（与定时任务相关的部分）

```
skillpack run → startServer()
    ├── PackAgent（平台无关的 Agent 核心）
    │     └── handleMessage(channelId, text, onEvent) → 流式执行技能
    └── PlatformAdapters（各平台接入层）
          ├── WebAdapter   → 用户主动触发
          ├── TelegramAdapter → 用户主动触发
          └── SlackAdapter   → 用户主动触发
```

现有模型是**完全被动式**的：用户发消息 → Adapter 接收 → 调用 PackAgent.handleMessage → 结果推回用户。

定时任务要引入**主动触发**能力，即：时间到了 → 自动构造一条消息 → 调用 PackAgent → 把结果推到指定 IM channel。

---

## 2. 设计方案对比

### 方案 A：新增 `SchedulerAdapter`（推荐）

在现有 [PlatformAdapter](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#179-189) 体系内，新增一个 `SchedulerAdapter`，与 Telegram/Slack 等适配器平级。

```
server.ts
  └── startAdapters()
        ├── WebAdapter
        ├── TelegramAdapter（可选）
        ├── SlackAdapter（可选）
        └── SchedulerAdapter（可选，新增）← 定时任务
```

**SchedulerAdapter 的职责：**
- 读取 `data/config.json` 中的定时任务配置
- 内部维护定时器（`node-cron` / 原生 `setInterval`）
- 时间触发后，用指定的 `channelId`（如 `scheduler-<jobName>`）调用 `agent.handleMessage()`
- 监听 `onEvent`，在 `agent_end` 时，通过已有的 IM adapter（Telegram/Slack）把结果推送出去

**优点：**
- 完全符合现有架构模式，改动最小
- `SchedulerAdapter` 实现 [PlatformAdapter](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#179-189) 接口，天然支持 graceful stop
- 复用 PackAgent 的 session/channel 机制，无需额外状态管理
- 结果推送复用已有的 IM adapter，不重复造轮子

**缺点：**
- SchedulerAdapter 需要持有对其他 adapter 的引用（或通过 agent 输出结果后，再调用 IM adapter 发送）

---

### 方案 B：在 [server.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/server.ts) 中直接添加定时逻辑

在 [startServer()](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/server.ts#22-179) 中直接写定时器，触发后直接调用 `agent.handleMessage()`。

**缺点：**
- 把调度逻辑混入服务器启动代码，违反单一职责
- 不支持 graceful stop（`lifecycle.stop()` 不会停止定时器）
- 难以扩展多任务、动态增删任务

❌ 不推荐

---

### 方案 C：独立进程 / 外部 cron

用系统 cron 或 PM2 定时任务，通过 HTTP 调用 skillpack 的 API 触发。

**优点：** 不改动 skillpack 代码  
**缺点：** 需要暴露专门的内部 API，运行环境依赖外部调度，不适合普通用户的 skillpack 分发包

❌ 不适合嵌入式场景

---

## 3. 推荐方案详细设计

### 3.1 配置结构（`data/config.json` 扩展）

```json
{
  "adapters": {
    "telegram": { "token": "..." },
    "slack": { "botToken": "...", "appToken": "..." }
  },
  "scheduledJobs": [
    {
      "name": "morning-briefing",
      "cron": "0 9 * * 1-5",
      "prompt": "生成今日市场早报，重点关注科技股和宏观数据。",
      "notify": {
        "adapter": "telegram",
        "channelId": "telegram-1234567890"
      },
      "enabled": true
    },
    {
      "name": "weekly-summary",
      "cron": "0 18 * * 5",
      "prompt": "总结本周市场表现，生成周报。",
      "notify": {
        "adapter": "slack",
        "channelId": "slack-dm-T0001-D0001"
      }
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 任务唯一名称 |
| `cron` | string | 标准 cron 表达式（5字段） |
| `prompt` | string | 触发时发给 Agent 的指令 |
| `notify.adapter` | `"telegram" \| "slack"` | 结果推送目标适配器 |
| `notify.channelId` | string | 目标 channel，格式与适配器一致 |
| `enabled` | boolean? | 默认 true，false 时跳过 |

---

### 3.2 `SchedulerAdapter` 实现骨架

```typescript
// src/runtime/adapters/scheduler.ts

import { PlatformAdapter, AdapterContext, IPackAgent } from "./types.js";

export interface ScheduledJob {
  name: string;
  cron: string;
  prompt: string;
  notify: { adapter: string; channelId: string };
  enabled?: boolean;
}

export class SchedulerAdapter implements PlatformAdapter {
  readonly name = "scheduler";

  private jobs: ScheduledJob[];
  private timers: ReturnType<typeof setInterval>[] = [];
  private agent!: IPackAgent;
  private notifyFn!: (adapter: string, channelId: string, text: string) => Promise<void>;

  constructor(jobs: ScheduledJob[]) {
    this.jobs = jobs;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;
    this.notifyFn = ctx.notify; // 由 server.ts 注入

    for (const job of this.jobs) {
      if (job.enabled === false) continue;
      const ms = cronToNextMs(job.cron); // 计算下次触发时间
      this.scheduleJob(job, ms);
      console.log(`[Scheduler] Job "${job.name}" scheduled, next run in ${ms}ms`);
    }
  }

  private async runJob(job: ScheduledJob) {
    const channelId = `scheduler-${job.name}`;
    console.log(`[Scheduler] Running job "${job.name}"`);

    let fullText = "";

    const result = await this.agent.handleMessage(
      channelId,
      job.prompt,
      (event) => {
        if (event.type === "text_delta") fullText += event.delta;
      }
    );

    if (result.errorMessage) {
      console.error(`[Scheduler] Job "${job.name}" failed: ${result.errorMessage}`);
      fullText = `❌ 定时任务 "${job.name}" 执行失败：${result.errorMessage}`;
    }

    await this.notifyFn(job.notify.adapter, job.notify.channelId, fullText);
  }

  private scheduleJob(job: ScheduledJob, initialDelayMs: number) {
    const timer = setTimeout(async () => {
      await this.runJob(job);
      // 下次调度
      const next = cronToNextMs(job.cron);
      this.scheduleJob(job, next);
    }, initialDelayMs);

    this.timers.push(timer as unknown as ReturnType<typeof setInterval>);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t as unknown as ReturnType<typeof setTimeout>);
    this.timers = [];
    console.log("[Scheduler] All jobs stopped.");
  }
}
```

---

### 3.3 结果推送到 IM Channel 的机制

关键问题：`SchedulerAdapter` 产生结果后，如何把文字发到 Telegram/Slack？

有两种实现路径：

#### 路径 1：Notify 函数注入（推荐，低耦合）

在 [server.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/server.ts) 的 `startAdapters()` 中，将各 IM adapter 的"发送方法"包装成统一的 `notify` 函数，注入给 `SchedulerAdapter`：

```typescript
// server.ts 中组装 notifyFn

async function buildNotifyFn(adapters: Map<string, { sendMessage(channelId, text): Promise<void> }>) {
  return async (adapterName: string, channelId: string, text: string) => {
    const adapter = adapters.get(adapterName);
    if (!adapter) {
      console.warn(`[Scheduler] Notify target adapter "${adapterName}" not found`);
      return;
    }
    await adapter.sendMessage(channelId, text);
  };
}
```

这要求 `TelegramAdapter` 和 `SlackAdapter` 暴露一个 `sendMessage(channelId, text)` 公共方法（不依赖用户触发，主动推送）。

#### 路径 2：利用 PackAgent 的 channelId 作为回调目标

让各 IM adapter 注册 "可写" 的 channelId（用户的 channel），然后 scheduler 触发时用同样的 channelId 去 handleMessage，结果由 agent 通过 `onEvent` 回调返回，再由对应 adapter 的已有 channel 连接发出去。

> ⚠️ 这种方式依赖 channelId 与 adapter 的一一对应，且 Telegram/Slack 的 channel 在没有活跃连接时可能无法"回写"，需要各 adapter 维护一个主动发送的方法，回到路径 1 的本质。

**结论：路径 1（注入 notifyFn）更清晰，推荐采用。**

---

### 3.4 [AdapterContext](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#171-178) 的轻量扩展

为了传递 `notify` 函数，可以给 [AdapterContext](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#171-178) 加一个可选字段：

```typescript
// types.ts
export interface AdapterContext {
  agent: IPackAgent;
  server: Server;
  app: Express;
  rootDir: string;
  lifecycle: LifecycleInfo & LifecycleHandler;
  notify?: (adapter: string, channelId: string, text: string) => Promise<void>; // 新增
}
```

---

## 4. 对 `skillpack.json` 的考虑

定时任务配置**不建议**放到 `skillpack.json`，原因如下：

- `skillpack.json` 是"包描述"文件，它定义的是 skill 和 prompt 模板，属于发布物的一部分
- 定时任务配置（尤其是 channelId、cron 表达式）是**部署时的运行配置**，与用户环境强绑定
- 放在 `data/config.json` 与现有 Telegram/Slack token 的存放位置一致，符合已有约定

如果希望在 `skillpack.json` 中定义"默认定时任务模板"（只有 prompt 和 cron，无 channelId），然后在 `data/config.json` 中做绑定覆盖，也是一种合理的分层方式：

```json
// skillpack.json（发布物中定义模板）
{
  "scheduledJobTemplates": [
    { "name": "morning-briefing", "cron": "0 9 * * 1-5", "prompt": "生成今日早报" }
  ]
}

// data/config.json（部署时配置）
{
  "scheduledJobs": [
    {
      "name": "morning-briefing",
      "notify": { "adapter": "telegram", "channelId": "telegram-1234567890" }
    }
  ]
}
```

---

## 5. 实现路线图

```
Phase 1：基础 SchedulerAdapter
  ✅ 读取 data/config.json 中的 scheduledJobs
  ✅ 实现简单的 cron 解析（或引入 node-cron）
  ✅ 触发 agent.handleMessage()，收集 text_delta
  ✅ 将结果 console.log 出来（先不推 IM）

Phase 2：IM 推送
  ✅ TelegramAdapter / SlackAdapter 暴露 sendMessage() 公共方法
  ✅ server.ts 构造 notifyFn 并注入 SchedulerAdapter
  ✅ 定时任务结果推送到配置的 IM channel

Phase 3：管理能力（可选）
  ✅ Web UI 展示定时任务列表和上次执行状态
  ✅ POST /api/scheduler/run/:name 手动触发某个任务（调试用）
  ✅ 动态启停任务（无需重启 server）
```

---

## 6. 需要引入的依赖

| 功能 | 推荐方案 |
|---|---|
| Cron 解析与调度 | `node-cron`（轻量，支持标准 5 字段 cron 表达式）|
| 时区支持 | `node-cron` 内置 timezone 选项 |
| 不需要 cron | 也可自己实现简单的 next-tick 计算，避免额外依赖 |
