# SkillPack 当前实现架构说明


## 项目描述

`@cremini/skillpack` 是一个 Node.js CLI，用来把一组 skills、提示词模板和内置运行时打包成一个可直接分发的本地 Web 应用 zip。

最终用户拿到 zip 后，解压并运行 `start.sh` 或 `start.bat`，浏览器会打开本地页面，通过运行时中的 `pi-coding-agent` 调用已打包好的 skills。

- 如果本文与源码不一致，以源码为准
- 文中提到的 pack 统一指一个可分发的 SkillPack 应用

## 当前代码结构

```text
skill-pack/
├── src/
│   ├── cli.ts                    # CLI 入口
│   ├── commands/
│   │   ├── create.ts            # 交互式创建 pack
│   │   ├── init.ts              # 从本地/远程配置初始化 pack
│   │   ├── prompts-cmd.ts       # prompts 子命令
│   │   └── skills-cmd.ts        # skills 子命令
│   └── core/
│       ├── bundler.ts           # zip 打包
│       ├── pack-config.ts       # skillpack.json 读写与校验
│       ├── prompts.ts           # prompts 增删查
│       ├── runtime-template.ts  # runtime 模板复制/归档
│       └── skill-manager.ts     # skills 安装、扫描、删除、描述同步
├── runtime/
│   ├── server/                  # 运行时后端，直接以 JS 形式分发
│   ├── web/                     # 运行时前端静态资源
│   ├── start.sh                 # macOS / Linux 启动脚本
│   ├── start.bat                # Windows 启动脚本
│   └── README.md                # 运行时使用说明
├── examples/                    # skillpack.json 示例
├── docs/
└── dist/                        # tsup 构建后的 CLI
```


## 核心数据模型

### `skillpack.json`

当前配置结构如下：

```json
{
  "name": "Comic Explainer",
  "description": "A skill App, powered by SkillApp.sh",
  "version": "1.0.0",
  "prompts": [
    "Prompt 1",
    "Prompt 2"
  ],
  "skills": [
    {
      "name": "baoyu-comic",
      "source": "https://github.com/JimLiu/baoyu-skills/tree/main/skills",
      "description": "Knowledge comic creator..."
    }
  ]
}
```

字段约束：

- `name` 必填
- `description` 必须为字符串
- `version` 必须为字符串
- `prompts` 必须为字符串数组
- `skills` 必须为数组
- `skills[].name` 大小写不敏感去重
- `skills[].source` 必填
- `skills[].description` 必须存在，允许为空字符串

### Prompt 语义

当前实现里，`prompts` 主要承担两类职责：

- 作为 pack 的预设任务模板
- 为前端首页提供可点击的快捷输入内容

现有 UI 行为：

- 只有 1 条 prompt 时，页面会自动预填到输入框
- 多于 1 条 prompt 时，首页会展示 prompt cards，点击后回填输入框

## CLI 设计

CLI 入口在 `src/cli.ts`，基于 `commander` 注册如下命令：

| 命令 | 作用 |
| --- | --- |
| `skillpack create [directory]` | 交互式创建一个 pack |
| `skillpack init [directory] --config <path-or-url>` | 从本地文件或远程 URL 初始化 pack |
| `skillpack skills add <source> --skill <names...>` | 安装一个或多个 skill |
| `skillpack skills remove <name>` | 删除 skill |
| `skillpack skills list` | 列出当前 skills |
| `skillpack prompts add <text>` | 添加 prompt |
| `skillpack prompts remove <index>` | 删除 prompt，索引从 1 开始 |
| `skillpack prompts list` | 列出 prompts |
| `skillpack build` | 打包当前目录为 zip |

## 关键流程

### 1. `create`

`src/commands/create.ts` 的实际行为：

1. 解析目标目录；如果传了 `directory` 则先创建目录
2. 如果目标目录已存在 `skillpack.json`，先确认是否覆盖
3. 交互式采集 `name`、`description`
4. 循环采集 skill source 和 skill names
5. 循环采集 prompts，其中第 1 条必填
6. 询问是否立即打包 zip
7. 保存 `skillpack.json`
8. 如果声明了 skills，则安装 skills 并回填 description
9. 如果用户选择打包，则调用 `bundle`

这里有一个实现细节很重要：

- `create` 会生成配置并可直接打包
- 但它不会像 `init` 一样把 `runtime/` 模板展开到当前工作目录
- zip 中的 runtime 来自打包阶段直接读取项目自带的 `runtime/` 模板

### 2. `init`

`src/commands/init.ts` 适合“有现成配置文件，快速初始化工作目录”的场景。

实际行为：

1. 支持从本地路径或 HTTP/HTTPS URL 读取 `skillpack.json`
2. 对配置执行严格结构校验
3. 写入目标目录的 `skillpack.json`
4. 按配置安装所有 skills
5. 扫描 `skills/` 中的 `SKILL.md` frontmatter，回填 description
6. 把 `runtime/` 模板完整复制到目标目录
7. 为 `start.sh` / `start.bat` 补执行位
8. 可选直接打包 zip

因此，`init` 产出的工作目录是一个“可本地直接运行，也可再打包”的完整目录。

### 3. `skills` 管理

skills 管理集中在 `src/core/skill-manager.ts`。

#### 安装

CLI 最终会调用：

```bash
npx -y skills add <source> --agent openclaw --copy -y --skill <name>
```

实现特点：

- 同一个 source 的多个 skill 会被分组后一次安装
- 安装目标是当前工作目录下的 `skills/`
- 安装失败会直接终止当前流程

#### 扫描与描述同步

安装后，程序会递归扫描 `skills/` 目录下所有 `SKILL.md`，读取 frontmatter 中的：

- `name`
- `description`

然后用扫描出的 description 回写 `skillpack.json`。因此：

- `skillpack.json` 中的 description 既是配置字段，也是安装后同步得到的展示字段
- 配置中的 skill 名称需要和实际 skill frontmatter 名称匹配，才能正确回填

#### 删除

`skills remove <name>` 会：

1. 从 `skillpack.json` 中移除同名 skill
2. 扫描 `skills/` 目录中匹配的已安装 skill
3. 删除对应的 skill 目录

删除依据是 skill frontmatter 的 `name`，并按大小写不敏感处理。

### 4. `prompts` 管理

`src/core/prompts.ts` 只做非常轻量的配置操作：

- `add`：直接追加到 `config.prompts`
- `remove`：按 1-based index 删除
- `list`：返回当前 prompt 列表

这部分没有额外的语义加工，也没有单独的数据文件。

### 5. `build`

`src/core/bundler.ts` 的当前打包流程如下：

1. 读取并校验 `skillpack.json`
2. 重新安装配置中声明的全部 skills
3. 再次扫描并同步 skills description
4. 确认项目内置 `runtime/` 模板存在
5. 生成 `<config.name>.zip`
6. zip 根目录使用 pack 名作为前缀目录
7. 写入 `skillpack.json`
8. 写入整个 `skills/` 目录
9. 写入整个 `runtime/` 模板，但跳过其中的 `node_modules/`

这一设计意味着：

- `build` 是幂等偏重型操作，会再次触发 skill 安装
- zip 内不会预装 `server/node_modules`
- 运行时依赖由解压后的启动脚本首次执行时安装

## 运行时架构

运行时并不是从 TypeScript 编译生成，而是直接以 `runtime/` 目录中的模板文件分发。

### 运行时产物结构

```text
<pack-name>/
├── skillpack.json
├── skills/
├── server/
│   ├── index.js
│   ├── routes.js
│   ├── chat-proxy.js
│   ├── package.json
│   └── package-lock.json
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── marked.min.js
├── start.sh
├── start.bat
└── README.md
```

### 启动脚本

当前启动方式：

- `start.sh`：如果 `server/node_modules` 不存在，则执行 `npm install --omit=dev`
- `start.bat`：如果 `server/node_modules` 不存在，则执行 `npm ci --omit=dev`
- 然后进入 `server/` 执行 `node index.js`

运行时要求：

- Node.js >= 20

### 服务端

服务端入口是 `runtime/server/index.js`，基于 `express` + `ws` + `@mariozechner/pi-coding-agent`。

职责分层如下：

#### `index.js`

- 决定 `rootDir`，优先取 `PACK_ROOT` 环境变量，否则取 runtime 上一级目录
- 托管 `web/` 静态资源
- 创建 HTTP Server
- 注册 API 与 WebSocket 路由
- 默认监听 `127.0.0.1:26313`
- 如果端口占用，会自动递增尝试下一个端口
- 启动成功后自动打开浏览器

#### `routes.js`

提供以下接口：

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/config` | `GET` | 返回 pack 名称、描述、prompts、skills、当前 provider、是否已有 API key |
| `/api/skills` | `GET` | 返回 skills 列表 |
| `/api/config/key` | `POST` | 在服务端内存中保存 API key 和 provider |
| `/api/chat` | `WebSocket` | 聊天主通道 |
| `/api/chat` | `DELETE` | 当前仅返回 `{ success: true }`，没有真正清空后端持久状态 |

运行时的 API key 策略：

- 优先读取环境变量 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`
- 也允许前端调用 `/api/config/key` 在内存中设置
- 不写入磁盘

provider 与模型的当前固定映射：

- `openai` -> `gpt-5.4`
- `anthropic` -> `claude-opus-4-6`

#### `chat-proxy.js`

每个 WebSocket 连接会：

1. 用内存版 `AuthStorage` 注入 API key
2. 创建 `ModelRegistry`
3. 创建内存版 `SessionManager`
4. 把 `rootDir/skills` 作为 `additionalSkillPaths`
5. 用 `DefaultResourceLoader` 重新加载资源
6. 调用 `createAgentSession(...)`
7. 将 agent 事件实时转发给前端

当前会转发的主要事件类型：

- `agent_start`
- `message_start`
- `thinking_delta`
- `text_delta`
- `tool_start`
- `tool_end`
- `message_end`
- `agent_end`

前端发送的消息格式目前非常简单：

```json
{ "text": "user input" }
```

连接关闭时会调用 `session.dispose()`。

### 前端

前端为纯静态 HTML/CSS/JavaScript，不依赖前端框架。

#### 页面结构

- 左侧 sidebar：pack 名称、描述、skills 列表、provider 选择、API key 输入
- 右侧主区：welcome view、chat view、输入框

#### 初始化行为

页面加载后首先请求 `/api/config`，再完成以下渲染：

- 设置页面标题和 pack 基本信息
- 渲染 skills 列表
- 根据 provider 更新 API key placeholder
- 根据 prompts 数量切换预填或欢迎卡片展示

#### 聊天交互

聊天采用单条 WebSocket 长连接：

- 发送消息前先切换到 chat 模式
- 输入框会在等待回复时禁用
- assistant 输出按增量事件流式渲染
- tool 调用会展示为可折叠卡片
- thinking 过程会展示为独立可折叠卡片
- markdown 由 `marked.min.js` 渲染

当前前端里存在一个 `chatHistory` 数组，但它只是本地记录，没有用于向后端回放上下文；真正的会话状态依赖 `pi-coding-agent` session 本身。