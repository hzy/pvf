# Agent Notes

在这个仓库里处理 PVF mod pipeline 相关工作前，先读：

- `docs/mod-pipeline-architecture.md`
- `README.md`

其中：

- `README.md` 面向使用者，主要说明 CLI 和日常用法
- `docs/mod-pipeline-architecture.md` 面向维护者和后续 agent，主要说明设计目标、运行模型、分层职责和扩展方式

## Mod Pipeline Guardrails

处理多 mod / pipeline / CLI 相关改动时，优先遵守这些约束：

- mod 只负责 patch 逻辑，不要把 CLI、manifest 输出、输出目录规划重新塞回 mod 包
- pipeline 的执行顺序就是 `mods` 数组顺序；后一个 mod 必须能看到前面 overlays 合并后的结果
- 通用 EQU、`.lst`、路径安全、manifest 逻辑优先放在 `@pvf/pvf-mod`
- 不要重新引入 sibling package 的 `../../foo/src/index.ts` 式导入，优先使用 workspace 包导入
- 改动如果涉及架构边界，先看 `docs/mod-pipeline-architecture.md` 再动手

## Fast Entry Points

如果只是想快速恢复上下文，优先看这些文件：

- `docs/mod-pipeline-architecture.md`
- `mods/registry.ts`
- `mods/pipelines.ts`
- `packages/pvf-mod/src/runtime.ts`
- `packages/pvf-mod/src/pipeline.ts`
- `apps/pvf-mod-cli/src/index.ts`
