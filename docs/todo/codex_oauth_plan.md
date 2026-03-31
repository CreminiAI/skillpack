# 支持 Codex OAuth 认证方案

## 背景

当前 SkillPack 仅支持 API Key 方式认证 AI 模型。`pi-coding-agent` SDK 已原生内置 OAuth 支持，包括 `openai-codex`、`anthropic`、`github-copilot`、`google-gemini-cli` 等 provider。本方案旨在利用 SDK 已有能力，让用户可以选择 OAuth 方式（特别是 OpenAI Codex OAuth）登录。

### SDK OAuth 能力概览

| 组件 | 说明 |
|---|---|
| `AuthStorage.login(providerId, callbacks)` | 发起 OAuth 登录流程 |
| `AuthStorage.logout(provider)` | 登出 |
| `AuthStorage.getApiKey(provider)` | 获取 API Key（OAuth 自动刷新 token） |
| `AuthStorage.getOAuthProviders()` | 获取所有注册的 OAuth provider 列表 |
| `openaiCodexOAuthProvider` | 内置的 OpenAI Codex OAuth 实现 |
| `OAuthLoginCallbacks` | 登录回调接口：`onAuth(url)` 打开认证页、`onPrompt()` 获取用户输入 |

### OAuth 登录流程（Codex 示例）

```
用户点击 "OAuth Login"
  → 服务端调用 AuthStorage.login("openai-codex", callbacks)
  → SDK 在本地启动临时 HTTP 回调服务器
  → SDK 通过 onAuth 回调返回 OAuth 认证 URL
  → 服务端将 URL 返回给前端
  → 用户在浏览器打开 URL 进行 ChatGPT 授权
  → 授权完成后 SDK 回调服务器接收 code
  → SDK 自动交换为 access_token + refresh_token
  → 登录完成，credentials 存入 AuthStorage
```

## 用户审查要点

> [!IMPORTANT]
> **架构选型**：此方案将 `AuthStorage` 从当前的 `inMemory` 模式改为 `FileAuthStorageBackend` 模式（持久化到 `data/auth.json`）。这样 OAuth credentials（含 refresh token）会被持久化，服务重启后无需重新授权。

> [!WARNING]
> **部署场景限制**：OpenAI Codex OAuth 登录流程需要本地启动临时 HTTP 回调服务器（`localhost`），因此**仅适用于本地运行**的 SkillPack 实例。远程服务器部署仍需使用 API Key。SDK 提供了 `onManualCodeInput` 作为 fallback 方案。

> [!IMPORTANT]
> **认证模式共存**：方案设计为 API Key 和 OAuth **二选一**。用户可以在两种模式间切换。当使用 OAuth 时，`apiKey` 字段将由 SDK 自动从 OAuth credentials 中生成。

## 方案设计

### 认证模式

```
authMode: "api_key" | "oauth"
```

- `api_key`（默认）：与现有行为完全一致，通过 [config.json](file:///Users/yava/myspace/finpeak/skill-pack/tsconfig.json) 的 `apiKey` 字段
- `oauth`：通过 OAuth provider 登录，credentials 持久化到 `data/auth.json`

---

### 1. 配置层改造

#### [MODIFY] [config.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/config.ts)

- [DataConfig](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/config.ts#4-16) 接口新增 `authMode?: "api_key" | "oauth"` 和 `oauthProvider?: string` 字段
- `authMode` 默认为 `"api_key"`，保持向后兼容

```diff
 export interface DataConfig {
   apiKey?: string;
   provider?: string;
+  authMode?: "api_key" | "oauth";
+  oauthProvider?: string;  // e.g. "openai-codex"
   adapters?: { ... };
 }
```

- `ConfigManager.save()` 增加对 `authMode` 和 `oauthProvider` 的保存逻辑

---

### 2. Agent 层改造

#### [MODIFY] [agent.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/agent.ts)

核心变更在 [getOrCreateSession()](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/agent.ts#107-186) 方法中 `AuthStorage` 的创建方式：

```diff
- const authStorage = AuthStorage.inMemory({
-   [provider]: { type: "api_key", key: apiKey },
- });
- (authStorage as any).setRuntimeApiKey(provider, apiKey);
+ // 使用 FileAuthStorageBackend 持久化 credentials
+ const authPath = path.resolve(rootDir, "data", "auth.json");
+ const authStorage = AuthStorage.create(authPath);
+ if (authMode === "api_key" && apiKey) {
+   authStorage.setRuntimeApiKey(provider, apiKey);
+ }
+ // OAuth 模式下，credentials 已由登录流程写入 auth.json
```

- [PackAgentOptions](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#97-104) 新增 `authMode` 字段
- 同步修改 [types.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts) 中的 [PackAgentOptions](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts#97-104) 接口

#### [MODIFY] [types.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/types.ts)

```diff
 export interface PackAgentOptions {
   apiKey: string;
   rootDir: string;
   provider: string;
   modelId: string;
+  authMode: "api_key" | "oauth";
   lifecycleHandler: LifecycleHandler;
 }
```

#### [MODIFY] [server.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/server.ts)

- 读取 `authMode` 配置并传入 [PackAgent](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/agent.ts#94-417)

---

### 3. OAuth 登录 API

#### [MODIFY] [web.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/web.ts)

新增三个 HTTP API 端点：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/oauth/providers` | GET | 返回可用的 OAuth provider 列表 |
| `/api/oauth/login` | POST | 启动 OAuth 登录流程，返回认证 URL |
| `/api/oauth/logout` | POST | 登出 OAuth |

**登录流程 API 设计**：

```
POST /api/oauth/login
Body: { provider: "openai-codex" }
Response: { authUrl: "https://...", instructions: "..." }
```

> 由于 OAuth 登录是异步过程（用户需要在浏览器中完成授权），设计采用 **轮询模式**：
> 1. 前端调用 `/api/oauth/login` 启动登录
> 2. 服务端返回 `authUrl` 并打开新窗口
> 3. 前端轮询 `/api/oauth/status` 等待完成
> 4. 用户完成浏览器授权后，SDK 回调服务器接收 code
> 5. 登录完成后状态标记为 `completed`

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/oauth/status` | GET | 查询当前 OAuth 登录状态 |

---

### 4. Web UI 改造

#### [MODIFY] [api-key-dialog.js](file:///Users/yava/myspace/finpeak/skill-pack/web/js/api-key-dialog.js)

在 API Key 配置对话框中新增 OAuth 登录选项卡：

- 添加 **Auth Mode 切换**：`API Key` / `OAuth Login` 两个 tab
- API Key tab：保持现有行为
- OAuth tab：
  - Provider 选择下拉框（从 `/api/oauth/providers` 获取）
  - "Login with ChatGPT"/"Login with Anthropic" 等按钮
  - 登录状态反馈（进行中 / 成功 / 失败）
  - 已登录状态下显示 Logout 按钮

#### [MODIFY] [index.html](file:///Users/yava/myspace/finpeak/skill-pack/web/index.html)

- 在 API Key dialog 中添加 OAuth tab 的 HTML 结构

#### [MODIFY] [api.js](file:///Users/yava/myspace/finpeak/skill-pack/web/js/api.js)

- 新增 `startOAuthLogin(provider)`, `getOAuthStatus()`, `logoutOAuth()` 等 API 调用函数

---

### 5. WebSocket 连接检查

#### [MODIFY] [web.ts](file:///Users/yava/myspace/finpeak/skill-pack/src/runtime/adapters/web.ts)

当前 WebSocket 连接时的 API Key 检查需要适配 OAuth 模式：

```diff
- if (!apiKey) {
-   ws.send(JSON.stringify({ error: "Please set an API key first" }));
+ const authMode = configManager.getConfig().authMode || "api_key";
+ const hasAuth = authMode === "oauth"
+   ? authStorage.hasAuth(provider)
+   : !!apiKey;
+ if (!hasAuth) {
+   ws.send(JSON.stringify({ error: "Please configure authentication first" }));
```

---

## 验证方案

### 手动验证

1. **API Key 模式兼容性**：使用现有 API Key 方式启动，确认行为不变
2. **OAuth 登录流程**：
   - 启动 SkillPack → 打开 Web UI → 点击 API Key 配置 → 切换到 OAuth tab
   - 选择 `openai-codex` provider → 点击登录按钮
   - 在弹出的浏览器窗口中完成 ChatGPT 授权
   - 返回 Web UI 确认登录状态为"已连接"
   - 发送消息给 Agent 确认正常响应
3. **持久化与重启**：OAuth 登录后重启 SkillPack，确认无需重新授权
4. **模式切换**：从 OAuth 切换回 API Key 模式，确认正常工作

> [!NOTE]
> 由于 OAuth 流程依赖实际的 OpenAI/Anthropic 账户授权，自动化测试不太现实。建议主要依赖手动测试验证完整流程。
