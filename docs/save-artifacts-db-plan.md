# 最终产物保存简化方案

## 目标
- 最终产物的唯一入口仍然是 `save_artifacts`。
- 工具调用成功即立即保存文件快照和数据库记录，不再依赖 run 结束时统一提交。
- `result.db` 只保存 artifacts，不再记录 run 状态、统计或失败信息。
- 定时任务结果统一通过 `channelId = scheduler-${jobName}` 查询，不在数据库中冗余 `jobName`。

## 模块职责
- `save-artifacts-tool.ts`
  - 只负责参数定义、路径校验、元数据提取、调用保存回调。
  - 不负责数据库写入，不维护声明历史，也不处理 run 级状态。
- `persistence-service.ts`
  - 统一负责一次工具调用的完整保存流程。
  - 生成 `declaredAt`，协调快照创建与数据库写入，并在写库失败时回滚本次快照。
- `snapshot-service.ts`
  - 只负责文件快照。
  - 每次调用向 `data/artifacts/<runId>/` 追加新文件，文件名使用时间戳 + UUID，避免重复覆盖。
- `store.ts`
  - 只负责 SQLite 初始化、写入 artifact 记录、按 `channelId` 查询最近结果。
  - 不做 migration，不维护 `runs` 表。

## 数据结构
- `artifacts`
  - `artifact_id`
  - `run_id`
  - `channel_id`
  - `original_path`
  - `snapshot_path`
  - `file_name`
  - `mime_type`
  - `size_bytes`
  - `title`
  - `is_primary`
  - `declared_at`
- 索引
  - `(channel_id, declared_at DESC)`

## 运行时流程
1. `PackAgent.handleMessage()` 启动一次 run 时生成 `runId`。
2. 本次 run 内，`save_artifacts` 通过 run 级回调直接调用 `ArtifactPersistenceService.saveArtifacts()`。
3. `ArtifactPersistenceService` 先创建快照，再在单个事务里写入 `artifacts` 表。
4. 同一次 run 中多次调用工具时，继续复用同一个 `runId`，结果追加保存。
5. 如果 run 后续失败，已经成功保存的 artifact 不回滚。

## 查询与集成
- `skill-pack`
  - 仅保留 recent artifacts 查询接口。
  - 删除 runs 相关 HTTP / IPC 查询接口。
- `frevana`
  - overview 和详情页按 `scheduler-${jobName}` 构造 `channelId` 后查询 recent artifacts。
  - renderer 继续使用 `snapshotPath` 进行预览和下载。

## 验收点
- 单次调用 `save_artifacts` 后，快照文件和数据库记录立即可见。
- 同一次 run 中多次调用时，同一 `runId` 下会追加多条 artifact 记录。
- 单次工具调用中任一文件非法时，该次调用整体失败，且不产生快照和数据库记录。
- scheduled overview / results page 仍可正常展示和分页。
