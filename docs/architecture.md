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

运行时服务端以 TypeScript 开发，在构建阶段编译为 JS，`runtime/server/dist/` 进入分发包。详见 [im-adapters.md](./im-adapters.md)。

### 运行时产物结构

```text
<pack-name>/
├── skillpack.json
├── skills/
├── data/                        # 用户本地配置（不打包进 zip）
│   └── config.json
├── server/
│   ├── dist/                    # 编译产物（入口为 dist/index.js）
│   │   ├── index.js
│   │   ├── agent.js
│   │   └── adapters/
│   │       ├── types.js
│   │       ├── web.js
│   │       └── telegram.js
│   ├── package.json
│   └── package-lock.json
├── web/                         # 前端静态资源（不变）
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── marked.min.js
├── start.sh
├── start.bat
└── README.md
```

### 启动脚本

- `start.sh` / `start.bat`：如果 `server/node_modules` 不存在，先执行 `npm install --omit=dev`
- 然后进入 `server/` 执行 `node dist/index.js`

运行时要求：Node.js >= 20

### 服务端

服务端基于 **Adapter 模式**，支持多 IM 平台接入：

- **`dist/index.ts`**：读取 `data/config.json` + 环境变量，创建 `PackAgent`，按配置启动各 Adapter
- **`dist/agent.js`**：`PackAgent`，平台无关的 Agent 层，管理 per-channel 的 `AgentSession`
- **`dist/adapters/web.js`**：`WebAdapter`，HTTP API + WebSocket，与前端协议保持兼容
- **`dist/adapters/telegram.js`**：`TelegramAdapter`，Telegram Bot polling 模式

#### HTTP API（由 WebAdapter 提供）

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/config` | GET | pack 名称、描述、prompts、skills、provider、是否有 API key |
| `/api/skills` | GET | skills 列表 |
| `/api/config/key` | POST | 内存中设置 API key 和 provider |
| `/api/chat` | WebSocket | 聊天主通道（流式事件推送） |
| `/api/sessions` | GET | 会话列表（预留） |

#### API key 优先级

1. `data/config.json` 中的 `apiKey`（首先读取）
2. 环境变量 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`（覆盖配置文件）
3. 前端调用 `/api/config/key`（进一步覆盖，内存中生效）

### 前端

前端为纯静态 HTML/CSS/JavaScript，不依赖前端框架，与原版完全相同。

- 左侧 sidebar：pack 名称、描述、skills 列表、provider 选择、API key 输入
- 右侧主区：welcome view、chat view、输入框
- 聊天采用 WebSocket 长连接，流式渲染 assistant 输出、tool 调用卡片、thinking 卡片
- markdown 由 `marked.min.js` 渲染