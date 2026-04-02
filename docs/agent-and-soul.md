## SkillPack v1: 显式把 `AGENTS.md` / `SOUL.md` 合并进 System Prompt

### Summary

为 SkillPack 增加两个可选根目录文件：

- `AGENTS.md`：pack 的行为准则
- `SOUL.md`：pack 的人格与表达风格

v1 不依赖 `pi-coding-agent` 对父目录 `AGENTS.md` / `CLAUDE.md` 的自动发现。SkillPack runtime 自己读取这两个文件，并在创建新 session 时**显式修改最终 system prompt**。同时，宿主机器上的 `AGENTS.md`、`.pi/SYSTEM.md`、`APPEND_SYSTEM.md` 不参与该 pack 的 system prompt 组装。

### Key Changes

#### 1. Runtime prompt 组装

在 [`src/runtime/agent.ts`](/Users/yava/myspace/finpeak/skillpack/skill-pack/src/runtime/agent.ts) 增加 pack-level prompt assembly：

- 新建 session 时，从 pack 根目录读取可选的 `AGENTS.md` 与 `SOUL.md`
- 将两者原文包进固定结构的 wrapper，而不是直接裸拼
- 固定结构至少包含：
  - 一个总标题，说明这段内容由 SkillPack 注入
  - 明确优先级：用户显式指令 > `AGENTS.md` > `SOUL.md`
  - `AGENTS.md` 原文区块
  - `SOUL.md` 原文区块，并注明它只定义人格/语气/工作风格，不覆盖任务目标与规则

实现方式固定为：

- `agentsFilesOverride: () => ({ agentsFiles: [] })`
  - 禁用宿主全局/父目录/当前目录 context files 自动注入
- `systemPromptOverride: () => undefined`
  - 屏蔽宿主 `.pi/SYSTEM.md`
  - 继续使用 pi 的默认内建 system prompt
- `appendSystemPromptOverride: () => [packPromptBlock]` 或 `[]`
  - 只注入 SkillPack 自己生成的 prompt block
  - 不继承宿主 `APPEND_SYSTEM.md`

这样最终 prompt 结构是：

- pi 默认内建 system prompt
- SkillPack 生成的 `AGENTS.md` / `SOUL.md` 结构化附加段
- skills、日期时间、cwd 等底层正常附加内容

#### 2. 文件读取与生效时机

文件读取规则固定为：

- 读取位置：pack 根目录 `AGENTS.md`、`SOUL.md`
- 生效时机：仅在创建新 channel session 时读取一次
- 已有 session 不热更新
- 文件不存在或内容为空白时，直接跳过该区块
- 文件读取失败时，记录 warning 并跳过，不中断启动

v1 不做：

- workspace 文件物化
- 每轮重读
- Markdown 语义解析或内容摘要
- 自动把 `SOUL.md` 转成别的文件名

#### 3. Pack 格式与打包

SkillPack 根目录格式扩展为：

```text
<pack>/
├── skillpack.json
├── AGENTS.md    # optional
├── SOUL.md      # optional
├── skills/
├── start.sh
└── start.bat
```

公开契约：

- `skillpack.json` 不改 schema
- CLI flags 不新增
- `AGENTS.md` / `SOUL.md` 是可选 pack 资产，不是 JSON 配置项

[`src/commands/zip.ts`](/Users/yava/myspace/finpeak/skillpack/skill-pack/src/commands/zip.ts) 调整为：

- 文件存在时，把 `AGENTS.md` 和 `SOUL.md` 打进 zip
- 文件不存在时跳过
- 其余打包行为不变

`create` / `run` / `create --config`：

- v1 不新增交互问题
- v1 不自动生成这两个文件
- `create --config` 仍只处理 `skillpack.json` 与 skills

#### 4. 文档与可观测性

更新文档：

- [`README.md`](/Users/yava/myspace/finpeak/skillpack/skill-pack/README.md)
- [`docs/what-is-skillpack.md`](/Users/yava/myspace/finpeak/skillpack/skill-pack/docs/what-is-skillpack.md)
- [`docs/runtime/runtime-architecture.md`](/Users/yava/myspace/finpeak/skillpack/skill-pack/docs/runtime/runtime-architecture.md)

需要写清：

- 这是 SkillPack 自己控制的 pack-level persona/policy 机制
- 不依赖宿主机器的上下文文件
- 只在新 session 生效
- `AGENTS.md` 是 policy，`SOUL.md` 是 persona

运行时日志增加简短诊断：

- 是否发现 `AGENTS.md`
- 是否发现 `SOUL.md`
- 是否注入 pack prompt block
- `session.systemPrompt` 调试输出中应能看到该结构化区块

### Public Interfaces

- `skillpack.json`：无变化
- CLI：无变化
- Pack 文件格式：新增两个可选根目录文件
  - `AGENTS.md`
  - `SOUL.md`

### Test Plan

至少验证这些场景：

1. 两个文件都不存在
- system prompt 不包含 pack 注入区块
- 宿主 `AGENTS.md` / `.pi/SYSTEM.md` / `APPEND_SYSTEM.md` 不生效

2. 只有 `AGENTS.md`
- system prompt 出现 policy 区块
- 内容为该文件原文
- zip 包含 `AGENTS.md`

3. 只有 `SOUL.md`
- system prompt 出现 persona 区块
- 内容为该文件原文
- zip 包含 `SOUL.md`

4. 两个文件都存在
- 两个区块都出现
- 优先级说明存在
- `AGENTS.md` 在 `SOUL.md` 前

5. 宿主上下文隔离
- 在宿主环境放置全局/父目录 `AGENTS.md`、`.pi/SYSTEM.md`、`APPEND_SYSTEM.md`
- 新 session 的 system prompt 不包含这些内容

6. 生效时机
- 修改 pack 根目录文件后，旧 session 不变
- 新 session 读取新内容

7. 回归检查
- `npm run check` 通过
- 手动启动一个 pack，观察日志和 `session.systemPrompt` 输出符合预期

### Assumptions

- v1 只隔离 system-prompt 相关宿主上下文，不改现有 global skills / prompts / extensions 的加载策略
- `AGENTS.md` 与 `SOUL.md` 都按原文注入，不做摘要或智能改写
- `AGENTS.md` 定义规则，`SOUL.md` 定义人格；两者冲突时，以 `AGENTS.md` 为准
- 本次不引入新的自动化测试框架；以 `npm run check` 和手动集成验证为主
