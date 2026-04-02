# 扩展 AI 模型提供商实施计划：Google / OpenAI Codex (OAuth) + 自定义 URL

## 背景与目标

当前 SkillPack 仅支持 OpenAI 和 Anthropic。为了提升灵活性和模型覆盖度，我们将进行以下改进：
1. **新增 Google Gemini 支持**（通过 API Key）。
2. **新增 OpenAI Codex 支持**（通过 **OAuth 认证**，即 ChatGPT 授权登录）。
3. **支持自定义 BaseURL**：允许 OpenAI 和 Anthropic 使用第三方 LLM 代理（如 OneAPI 等）。
4. **统一配置管理**：所有配置（包括 OAuth 凭据）均存储在单个 `config.json` 文件中。

---

## 核心设计

### 1. 认证方案设计
| 提供商 | 认证方式 | 凭据存储位置 | 说明 |
|---|---|---|---|
| `openai` | API Key | `config.json` -> `apiKey` | 手动输入 |
| `anthropic` | API Key | `config.json` -> `apiKey` | 手动输入 |
| `google` | API Key | `config.json` -> `apiKey` | 手动输入 |
| `openai-codex` | **OAuth** | `config.json` -> `_auth` | 浏览器授权，SDK 自动管理 |

### 2. 存储架构：单文件模式
为了满足用户“全部存入一个配置文件”的要求，我们实现了自定义的 `ConfigFileAuthBackend`。
- **配置数据** (`apiKey`, `provider`, `baseUrl`等) 存储在根级别。
- **OAuth 凭据** (refresh tokens 等) 存储在 `_auth` 隐藏字段中。
- 此设计避免了产生额外的 `auth.json` 文件，方便用户迁移和备份配置。

### 3. 提供商注册表 (Metadata)
所有提供商的行为通过 `SUPPORTED_PROVIDERS` 常量统一驱动，新增提供商只需在此处声明。

---

## 存储结构示例 (config.json)

```json
{
  "provider": "openai-codex",
  "apiKey": "...", 
  "baseUrl": "https://api.openai.com/v1",
  "adapters": { ... },
  "scheduledJobs": [ ... ],
  "_auth": {
    "openai-codex": {
      "type": "oauth",
      "refresh": "rt-xxxx...",
      "access": "at-xxxx...",
      "expires": 1743523200
    }
  }
}
```

---

## 实施阶段

### 阶段 1：配置层与基础设施 (已完成)
- [x] 在 `config.ts` 中定义 `SUPPORTED_PROVIDERS`。
- [x] 实现 `ConfigFileAuthBackend`，拦截 SDK 的持久化操作并定向到 `config.json` 的 `_auth` 字段。
- [x] 扩展环境变量回退逻辑（支持 `GOOGLE_API_KEY`）。

### 阶段 2：运行时与后端适配 (已完成/进行中)
- [x] 修改 `server.ts`，动态从注册表获取各提供商的默认 `modelId`。
- [x] 修改 `agent.ts`，将 `AuthStorage` 升级为全局单例，并注入 `ConfigFileAuthBackend`。
- [ ] 修改 `web.ts`，新增 OAuth 登录、状态查询、登出 API。
- [ ] 适配 WebSocket 握手逻辑，支持 OAuth 状态检查。

### 阶段 3：Web UI 重构 (待执行)
- [ ] **双模式对话框**：重构 API Key 对话框，根据所选 Provider 动态切换“API Key 输入模式”和“OAuth 登录模式”。
- [ ] **BaseURL 支持**：在 UI 中为支持代理的提供商显式提供 URL 输入框。
- [ ] **状态感知**：实现 OAuth 登录状态的实时轮询和显示。

---

## 风险与注意点
- **OAuth 回调**：OpenAI Codex OAuth 依赖本地 `localhost` 端口接收回调。在远程无桌面环境下部署时，建议使用 API Key 模式。
- **并发写入**：由于 `AuthStorage` 和 `ConfigManager` 都会操作 `config.json`，已实现读-改-写锁机制确保数据不丢失。
