# Final Artifact Catalog 与快照保留方案

## 摘要
- 目标是为每次 chat 的成功 run 建立“最终产物目录”，供 dashboard 稳定展示和查询。
- 最终产物的唯一真相来源不是 `send_file` 或 workspace 扫描，而是 Agent 显式调用 `set_final_artifacts` tool 声明。
- 为避免后续 run 覆盖、移动或删除原文件，成功 run 的最终产物在提交时复制到 `data/artifacts/<runId>/`；dashboard 以该快照为展示源。
- `/clear` 和 `/new` 只清 session，上下文重置不影响结果历史和产物快照。

## 架构设计
- `PackAgent` 只负责 run 生命周期编排：创建 `runId`、维护单次 run 的内存上下文、在 run 结束时统一提交结果。它不直接处理 SQL，也不直接操作 dashboard 查询。
- 新增 `RunArtifactCoordinator` 作为单次 run 的内存协调器，职责仅包含：累积最终 assistant 文本、记录多次 `set_final_artifacts` 声明、为每次声明分配 `declaration_seq`。它不负责持久化。
- 新增 `set_final_artifacts` tool，职责仅包含：校验文件、提取文件元数据、将本次声明追加到 coordinator。它不做数据库写入，不做复制，不依赖 adapter。
- 新增 `ArtifactSnapshotService`，职责仅包含：把已声明的最终产物复制到 `data/artifacts/<runId>/`，生成稳定快照路径。复制策略、命名冲突处理、目录创建都封装在该服务里。
- 新增 `ResultStore`，职责仅包含：SQLite 初始化、migration、事务写入、只读查询接口。所有 SQL 只存在这一层。
- 新增 `ResultsQueryService`，职责仅包含 dashboard 所需查询方法；未来 HTTP / IPC / Web UI 只通过它读数据，不直接查表。

## 数据模型与接口
- `runs` 表：`run_id`，`channel_id`，`user_text`，`assistant_text`，`status`，`stop_reason`，`error_message`，`started_at`，`completed_at`。索引 `(channel_id, completed_at DESC)`。
- `artifacts` 表：`artifact_id`，`run_id`，`channel_id`，`declaration_seq`，`artifact_order`，`original_path`，`snapshot_path`，`file_name`，`mime_type`，`size_bytes`，`title`，`description`，`is_primary`，`declared_at`。索引 `(run_id, declaration_seq, artifact_order)` 和 `(channel_id, declared_at DESC)`。
- `channel_id` 在 `artifacts` 中冗余保留，作为 dashboard 查询优化字段。
- `set_final_artifacts` 输入固定为 `artifacts: [{ filePath, title?, description?, isPrimary? }]`。
- 同一 run 内多次调用 `set_final_artifacts` 时，全部保留，不删除旧声明；`declaration_seq` 表示第几次声明，`artifact_order` 表示该次声明内的顺序。
- `snapshot_path` 是 dashboard 的稳定读取路径，`original_path` 仅用于审计和回溯；UI 默认不依赖原路径。

## 运行时行为
- `handleMessage()` 开始时创建 `runId`，插入 `runs(status='running')`，初始化 coordinator。
- run 过程中持续累积 assistant 最终文本；每次 `set_final_artifacts` 调用只更新 coordinator 中的声明列表。
- `session.prompt()` 成功完成后，`PackAgent` 执行一次提交流程：
  1. 读取 coordinator 中全部 artifact 声明
  2. 调用 `ArtifactSnapshotService` 将这些文件复制到 `data/artifacts/<runId>/`
  3. 在单个事务内更新 `runs` 为 `completed`，并插入所有 artifact 记录
- 如果 run 失败或 abort，则只更新 `runs.status / error_message / stop_reason`；不复制文件，不写 `artifacts`。
- `/clear` 和 `/new` 继续只删除 `data/sessions/<channelId>`；不删 `data/workspaces/<channelId>`，不删 `data/result.db`，不删 `data/artifacts/`。
- 结果数据库路径固定为 `data/result.db`；SQLite 保持 `Node >=20`，通过第三方 SQLite 库封装在 `ResultStore` 内部，不向外泄漏实现细节。

## 测试与验收
- 单次成功 run，单次声明：`runs` 与 `artifacts` 记录正确，文件被复制到 `data/artifacts/<runId>/`，`snapshot_path` 可直接读取。
- 单次成功 run，多次声明：所有声明都保留，`declaration_seq` 与 `artifact_order` 顺序正确，历史声明不丢失。
- 非法输入：文件不存在、是目录、不可读、路径越界时，tool 报错且 run 最终不写 artifact 记录。
- 失败或中止 run：`runs` 状态正确，`artifacts` 表为空，`data/artifacts/<runId>/` 不产生残留快照。
- `/clear` 执行后：session 被清空，但 `result.db` 与 `data/artifacts/` 中的历史仍可被 `ResultsQueryService` 查询和展示。
- 查询服务验证：支持按 channel 列最近 runs、按 run 列 artifacts、按 channel 列最近 artifacts，且全部基于 `result.db`，不依赖 session jsonl 或内存状态。

## 默认假设
- v1 的“最终产物”仅包含文件，不把最终 assistant 文本记为 artifact。
- dashboard 默认展示 `snapshot_path`，不直接打开 workspace 原文件。
- 快照复制是产品语义的一部分，不是备份兜底；它是为了提供不可变、可追溯、与会话生命周期解耦的产物视图。
