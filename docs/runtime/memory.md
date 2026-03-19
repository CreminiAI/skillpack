# Agent Memory 功能

## 概述

Runtime 通过 [OpenViking](https://github.com/volcengine/OpenViking) 为 Agent 提供长期记忆功能。每次对话时自动检索相关记忆注入上下文，对话结束时自动提取并存储记忆。

## 架构

```
skill-pack runtime (TypeScript)          OpenViking Server (Python)
┌──────────────────────────┐             ┌──────────────────────────┐
│  PackAgent               │             │  port 1933 (默认)        │
│  ├── pi AgentSession     │             │                          │
│  └── MemoryManager ──────┼── HTTP ────▶│  /api/v1/sessions        │
│       (memory.ts)        │             │  /api/v1/search/find     │
└──────────────────────────┘             │                          │
                                         │  viking://               │
                                         │  ├── user/memories/      │
                                         │  └── agent/memories/     │
                                         └──────────────────────────┘
```

## 工作流程

1. **对话开始** → 创建 OV Session；检索相关记忆注入 prompt
2. **对话进行** → 异步同步 user/assistant 消息到 OV Session
3. **对话结束** (`/clear` 或连接断开) → 提交 OV Session，后台提取记忆

## 配置

在 `data/config.json` 中启用：

```json
{
  "apiKey": "sk-...",
  "provider": "openai",
  "memory": {
    "enabled": true,
    "serverUrl": "http://localhost:1933",
    "maxMemories": 5
  }
}
```

## 前置条件

1. 安装 Python 3.10+
2. `pip install openviking`
3. 配置 `~/.openviking/ov.conf`（需要 embedding 和 VLM 模型的 API Key）
4. 启动：`openviking-server`

## 记忆类型

OpenViking 自动提取 6 类记忆：

| 类别 | 归属 | 描述 | 可合并 |
|------|------|------|--------|
| profile | user | 用户身份/属性 | ✅ |
| preferences | user | 用户偏好 | ✅ |
| entities | user | 关联实体（人/项目） | ✅ |
| events | user | 事件/决策 | ❌ |
| cases | agent | 问题 + 解决方案 | ❌ |
| patterns | agent | 可复用模式 | ✅ |

## 降级策略

Memory 功能完全可选。当 OpenViking Server 不可达时：
- 健康检查失败 → 标记为 unhealthy，跳过所有记忆操作
- 消息同步失败 → 静默忽略，不影响主流程
- 记忆检索超时 → 返回空字符串，正常对话
