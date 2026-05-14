# SkillPack 定时任务

## 概览

SkillPack 的定时任务由 `SchedulerAdapter` 提供，定时任务定义存放在 **pack 根目录**的 `job.json` 中，而不是 `data/config.json`。

这样做的目的很明确：

- `data/config.json` 只负责运行时私有配置，例如 provider、API key、Slack / Telegram 凭据、OAuth 状态
- `job.json` 负责可随包分发的计划任务定义
- `skillpack zip` 在 `job.json` 存在时会一并打包，因此一个 zip 可以预置可运行的定时任务

## 文件位置

```text
<pack-root>/
├── skillpack.json
├── job.json
├── skills/
├── start.sh
└── start.bat
```

- `skillpack.json`：Pack 元数据、提示词、技能声明
- `job.json`：定时任务定义
- `data/config.json`：运行时私有配置，不会被打进 zip

## `job.json` 结构

`job.json` 固定使用对象结构：

```json
{
  "jobs": [
    {
      "id": "morning-briefing",
      "name": "morning-briefing",
      "cron": "0 9 * * 1-5",
      "prompt": "生成今日市场早报，重点关注科技股和宏观数据。",
      "promptExamples": [
        "总结今天盘前最重要的三条市场消息",
        "列出值得关注的科技股异动"
      ],
      "notify": {
        "adapter": "telegram",
        "channelId": "telegram-1234567890"
      },
      "enabled": true,
      "timezone": "Asia/Shanghai"
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `jobs` | array | 定时任务列表 |
| `id` | string | 任务稳定标识；`job.json` 中必须唯一 |
| `name` | string | 给人看的显示名称 |
| `cron` | string? | 可选 5 段 cron 表达式；省略时表示“仅手动触发”的一次性任务 |
| `prompt` | string | 触发时发送给 Agent 的工作指令 |
| `promptExamples` | string[]? | 可选提示词示例；会在宿主应用中作为快捷入口展示 |
| `notify.adapter` | string | 推送目标适配器，例如 `telegram`、`slack`、`feishu`、`web` |
| `notify.channelId` | string | 目标 channel/chat 标识 |
| `enabled` | boolean? | 仅对有 `cron` 的循环任务生效；默认为启用 |
| `timezone` | string? | 可选时区，例如 `Asia/Shanghai`；仅对有 `cron` 的循环任务生效 |

约束：

- `job.json` 不存在时，等价于“没有任何定时任务”
- `jobs` 必须是数组
- `id` 必填，保存时会去掉首尾空白；按大小写不敏感去重
- `id` 不能包含 `/`、`\`、换行，且长度不能超过 128
- `name` 必填，但不是唯一键；如果多个任务同名，按名称做启停/删除会变得不明确
- `cron` 可省略；为空字符串时会被规范化为“无调度”的一次性任务
- `promptExamples` 可省略；每一项保存时会去掉首尾空白，空字符串会被过滤
- 一次性任务不会持久化 `enabled` 和 `timezone`
- 文件结构非法时，scheduler 启动失败并输出错误日志；其他适配器仍可继续启动

例如，下面这个任务没有 `cron`，只能通过手动触发运行：

```json
{
  "jobs": [
    {
      "id": "manual-market-scan",
      "name": "manual-market-scan",
      "prompt": "手动生成一次市场扫描报告。",
      "notify": {
        "adapter": "web",
        "channelId": "web"
      }
    }
  ]
}
```

## 运行时行为

SkillPack 启动时的相关职责如下：

1. `ConfigManager` 只加载 `data/config.json`
2. `SchedulerAdapter` 单独加载 `job.json`
3. IM 适配器先启动，scheduler 再启动
4. 即使 `job.json` 不存在，scheduler 也会启动，以便运行期动态管理任务
5. 定时任务触发后，scheduler 调用共享的 `PackAgent`
6. 结果通过 `notify.adapter` / `notify.channelId` 推送到对应适配器

运行期通过 Agent 工具、Web API 或宿主侧 IPC 新增、删除、启停任务时：

- 只会读写 `job.json`
- 不会再写回 `data/config.json`
- `job.json` 是调度配置的单一真源
- 运行期创建的任务如果没有显式提供 `id`，系统会自动生成一个 UUID

## Zip 集成

`skillpack zip` 的打包规则：

- 始终包含 `skillpack.json`
- 若存在则包含 `job.json`
- 若存在则包含 `AGENTS.md` / `SOUL.md`
- 包含 `skills/`
- 包含 `start.sh` / `start.bat`

这意味着：

- Pack 作者可以直接在仓库里维护 `job.json`
- 打出来的 zip 解压后即可带着预置定时任务运行
- 部署节点不需要再从 `data/config.json` 恢复任务定义

## 迁移说明

旧版本把定时任务放在 `data/config.json.scheduledJobs`。

当前实现已经**立即切断**旧字段：

- 运行时不再读取 `data/config.json.scheduledJobs`
- 如果检测到旧字段，会输出迁移告警
- 必须手动迁移到 pack 根目录的 `job.json`

迁移前：

```json
{
  "adapters": {
    "telegram": { "token": "..." }
  },
  "scheduledJobs": [
    {
      "name": "morning-briefing",
      "cron": "0 9 * * 1-5",
      "prompt": "生成今日市场早报",
      "notify": {
        "adapter": "telegram",
        "channelId": "telegram-1234567890"
      }
    }
  ]
}
```

迁移时需要注意：旧字段没有 `id` 的话，迁到 `job.json` 时要补一个稳定 ID。

迁移后：

`data/config.json`

```json
{
  "adapters": {
    "telegram": { "token": "..." }
  }
}
```

`job.json`

```json
{
  "jobs": [
    {
      "id": "morning-briefing",
      "name": "morning-briefing",
      "cron": "0 9 * * 1-5",
      "prompt": "生成今日市场早报",
      "notify": {
        "adapter": "telegram",
        "channelId": "telegram-1234567890"
      }
    }
  ]
}
```

## 验证建议

最小验证流程：

```bash
npm run check
npm run build
npm test
```

手工 smoke：

1. 在 pack 根目录新增 `job.json`
2. 执行 `npx @cremini/skillpack zip`
3. 解压 zip，确认根目录包含 `job.json`
4. 启动 pack，确认 scheduler 能加载任务
5. 通过 Agent、Web API 或 IPC 修改任务，确认只落盘到 `job.json`
