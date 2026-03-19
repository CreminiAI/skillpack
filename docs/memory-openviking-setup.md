# OpenViking Memory 安装与配置指南

本文档介绍如何为 skill-pack 安装、配置并启动 OpenViking Memory 功能。

## 前置条件

- Python 3.10+
- 一个支持的 LLM API Key（OpenAI / Anthropic / 火山引擎等）

## 1. 安装 OpenViking

```bash
pip install openviking --upgrade
```

验证安装：

```bash
openviking-server --help
```

## 2. 创建配置文件

```bash
mkdir -p ~/.openviking
```

创建 `~/.openviking/ov.conf`：

### OpenAI 示例

````json
{
  "storage": {
    "workspace": "~/.openviking/workspace"
  },
  "log": {
    "level": "INFO",
    "output": "stdout"
  },
  "embedding": {
    "dense": {
      "api_base": "https://api.openai.com/v1",
      "api_key": "sk-你的OpenAI密钥",
      "provider": "openai",
      "dimension": 3072,
      "model": "text-embedding-3-large"
    },
    "max_concurrent": 10
  },
  "vlm": {
    "api_base": "https://api.openai.com/v1",
    "api_key": "sk-你的OpenAI密钥",
    "provider": "openai",
    "model": "gpt-4o",
    "max_concurrent": 100
  }
}

### 配置说明

| 字段 | 说明 |
|------|------|
| `storage.workspace` | OpenViking 数据存储目录，建议放在稳定路径 |
| `embedding.dense` | Embedding 模型配置，用于向量化和语义检索 |
| `vlm` | VLM/LLM 配置，用于记忆提取和摘要生成 |

> `vlm` 和 `embedding` 的 API Key 是 OpenViking 自身使用的，与 skill-pack 的 Agent LLM 配置（`data/config.json` 中的 `apiKey`）**相互独立**。

## 3. 设置环境变量

在 `~/.zshrc`（或 `~/.bashrc`）中添加：

```bash
export OPENVIKING_CONFIG_FILE=~/.openviking/ov.conf
````

然后执行 `source ~/.zshrc` 使其生效。

## 4. 启动 OpenViking Server

```bash
openviking-server
```

默认监听 `http://localhost:1933`。

验证是否启动成功（另一个终端）：

```bash
curl http://localhost:1933/api/v1/system/status
```

应返回类似 `{"status":"ok", ...}` 的响应。

## 5. 在 skill-pack 中启用 Memory

编辑 `data/config.json`，添加 `memory` 字段：

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

| 字段          | 说明                       | 默认值                  |
| ------------- | -------------------------- | ----------------------- |
| `enabled`     | 是否启用 Memory 功能       | `false`                 |
| `serverUrl`   | OpenViking Server 地址     | `http://localhost:1933` |
| `maxMemories` | 每次检索返回的最大记忆条数 | `5`                     |

然后重启 skill-pack runtime 即可。

## 6. 长期运行（PM2）

建议使用 PM2 管理 OpenViking Server：

```bash
# 添加到 PM2
pm2 start openviking-server --name openviking --interpreter python3

# 保存配置
pm2 save

# 查看状态
pm2 status

# 查看日志
pm2 logs openviking
```

> **启动顺序**：建议先启动 OpenViking，再启动 skill-pack。不过顺序反了也没关系 —— Memory 功能会自动检测连接状态，不可用时优雅降级。

## 7. 验证 Memory 功能

1. 启动 OpenViking Server 和 skill-pack
2. 在 Web 界面发送几条消息进行对话
3. 发送 `/clear` 命令（触发记忆提取）
4. 通过 CLI 查看提取的记忆：

```bash
# 安装 CLI（可选）
pip install openviking

# 配置 CLI
echo '{"url": "http://localhost:1933", "timeout": 60.0, "output": "table"}' > ~/.openviking/ovcli.conf
export OPENVIKING_CLI_CONFIG_FILE=~/.openviking/ovcli.conf

# 查看记忆
ov ls viking://user/memories/
ov ls viking://agent/memories/
```

## 常见问题

### Memory 功能未生效

1. 检查 `data/config.json` 中 `memory.enabled` 是否为 `true`
2. 检查 OpenViking Server 是否正在运行：`curl http://localhost:1933/api/v1/system/status`
3. 查看 skill-pack 日志中是否有 `[Memory] OpenViking server is healthy` 字样

### OpenViking Server 启动失败

1. 检查 `ov.conf` 格式是否正确（JSON 中不能有注释）
2. 确认 `OPENVIKING_CONFIG_FILE` 环境变量已设置
3. 确认 workspace 目录有写入权限

### 关闭 Memory 不影响正常使用

将 `data/config.json` 中 `memory.enabled` 设为 `false`（或删除整个 `memory` 字段），重启 skill-pack 即可。OpenViking Server 可以独立停止，不影响 skill-pack 的正常聊天功能。
