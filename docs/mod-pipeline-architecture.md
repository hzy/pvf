# PVF Mod Pipeline Architecture

这份文档不是面向最终用户的使用说明，而是给后续维护者、代码审阅者、以及上下文被压缩后的 agent 的“架构恢复文档”。

对应的用户向说明在 `README.md`。这里重点解释：

- 为什么要引入这套系统
- 它的核心运行模型是什么
- 各层代码分别负责什么
- 新 mod 应该怎么接入
- 当前的边界、约束和后续可演进方向

## 1. 设计目标

这套系统主要为了解决原先 mod 体系里的三个核心问题：

- 单个 mod 容易长成巨型脚本，CLI、输出、业务逻辑、数据处理都堆在一起
- 多 mod 很难串联执行，后一个 mod 读不到前一个 mod 的最终效果
- 常用工具函数在各个 mod 里重复出现，维护成本高

这次重构后的目标是：

- mod 只负责“对 session 做 patch”，不负责 CLI、不负责输出文件布局、不负责 manifest
- pipeline 负责按顺序执行多个 mod，第 `n + 1` 个 mod 能看到前 `1..n` 个 mod 合并后的结果
- 常用的 EQU、`.lst`、路径安全、manifest 逻辑统一下沉到共享包
- CLI 只是一层薄调度入口，不与具体某个 mod 绑定

## 2. 核心心智模型

可以把整套系统理解成：

1. 先打开一个基础 PVF archive
2. 在内存里维护一个 overlay map
3. 所有 mod 依次操作同一个 `PvfModSession`
4. session 读文件时，总是优先读 overlay，再回退到底层 archive
5. 所有 mod 执行完后，才统一导出 overlay 目录，或者统一写出新的 PVF

这意味着：

- 不需要每个 mod 执行完都真的回写一次 PVF
- 后一个 mod 看到的是“前面所有 mod 合并后的最终文本结果”
- 多 mod 链接的行为是天然顺序化的，避免了“每个 mod 都自己做一次独立构建”导致的结果割裂

## 3. 分层结构

当前分层如下：

- `packages/pvf-mod`
  - 共享运行时和 pipeline 基础设施
- `mods/`
  - 仓库内建 mod 的注册与 pipeline 配置
- `mods/<mod-name>/`
  - 单个 mod 的纯 patch 逻辑
- `apps/pvf-mod-cli`
  - commander 实现的统一流水线 CLI

一句话总结职责边界：

- `mod` 负责“改什么”
- `pipeline` 负责“按什么顺序改”
- `cli` 负责“怎么触发改、怎么输出结果”

## 4. 关键抽象

### 4.1 `PvfMod`

定义在 `packages/pvf-mod/src/runtime.ts`。

它表示一个可执行 mod：

```ts
interface PvfMod<TResult = void> {
  id: string;
  apply(session: PvfModSession): Promise<TResult>;
}
```

约束：

- `apply()` 是 mod 的唯一入口
- mod 的输入是 `PvfModSession`
- mod 的输出是一个 summary/result，可用于 manifest 或调试

### 4.2 `PvfModSession`

`PvfModSession` 是整个系统最重要的对象。

它内部持有：

- 已打开的 `PvfArchive`
- `archivePath`
- `textProfile`
- overlay map
- rendered cache
- 一个 `state` map

它提供的能力包括：

- `readRenderedFile()`
- `readScriptDocument()`
- `updateScriptDocument()`
- `writeTextFile()`
- `writeScriptDocument()`
- `deleteFile()`
- `listOverlays()`
- `write()`

关键语义：

- 读文件时优先读 overlay
- 如果 overlay 标记为 delete，则视为文件不存在
- `updateScriptDocument()` 是最常见的 patch 入口
- `listOverlays()` 返回当前 session 的最终 overlay 视图

### 4.3 `PvfRegisteredMod`

定义在 `packages/pvf-mod/src/pipeline.ts`。

它是“可注册的 mod 定义”，区别于直接可执行的 `PvfMod`：

```ts
interface PvfRegisteredMod<TOptions = unknown, TResult = unknown> {
  id: string;
  description?: string;
  create(options: TOptions | undefined): PvfMod<TResult>;
}
```

它解决的是：

- registry 里保存的是“如何创建 mod”
- pipeline config 里保存的是“要用哪个 mod，以及传什么 options”

### 4.4 `PvfPipelineConfig`

同样定义在 `packages/pvf-mod/src/pipeline.ts`。

它描述一个命名流水线：

```ts
interface PvfPipelineConfig {
  id: string;
  description?: string;
  mods: readonly {
    id: string;
    options?: unknown;
  }[];
}
```

这里的 `mods` 顺序就是执行顺序。

## 5. 运行流程

一次典型的 pipeline 执行流程如下：

```text
CLI -> resolve pipeline -> open session -> run mod 1 -> run mod 2 -> ... -> run mod N
    -> collect overlays + per-mod result
    -> build overlay dir / write PVF
    -> write manifest
```

更具体地说：

### 5.1 构建 overlay 目录

`buildPvfPipelineToDirectory()` 会：

- 打开 session
- 顺序执行 pipeline 里的所有 mod
- 收集最终 overlays
- 把 overlays 导出到目录
- 写出 manifest

### 5.2 直接生成 PVF

`applyPvfPipeline()` 会：

- 打开 session
- 顺序执行所有 mod
- 基于最终 overlays 一次性写出新 PVF
- 调用方再写出 manifest

### 5.3 每个 mod 的 changed paths

pipeline 层会在每个 mod 执行前后抓取 overlay 快照，计算该 mod 新增或改动了哪些路径，并记录到 manifest 的 `changedPaths`。

这对排查问题很有帮助，因为它回答了两个问题：

- 某个 mod 实际影响了哪些文件
- 多 mod 串起来以后，问题到底是在哪一环引入的

## 6. 共享包 `@pvf/pvf-mod` 的职责拆分

### 6.1 `runtime.ts`

职责：

- `PvfModSession`
- `openPvfModSession()`
- `runPvfMods()`
- `applyPvfMods()`
- `writeOverlayDirectory()`

这是最底层的 mod 运行时。

### 6.2 `pipeline.ts`

职责：

- `PvfRegisteredMod`
- `PvfPipelineConfig`
- `createPvfModRegistry()`
- `buildPvfPipeline()`
- `buildPvfPipelineToDirectory()`
- `applyPvfPipeline()`
- `createPvfPipelineManifest()`
- `writePvfPipelineManifest()`

这是 mod runtime 之上的编排层。

### 6.3 `equ.ts`

职责：

- EQU 文档常用 helper
- section/statement 判断
- 读取 section/string/int
- 替换顶层 section

这部分的目标是避免每个 mod 都重复写一遍 AST 处理小工具。

### 6.4 `listed-path.ts`

职责：

- 读取 `.lst` 文件里的 id -> path 映射
- 找下一个可用 id
- 生成新的 listed path statement
- 更新整个 listed path document

这类逻辑在装备、道具索引类 mod 中会频繁出现，所以抽到共享层。

### 6.5 `path.ts`

职责：

- 判断路径是否仍在目标目录内
- 安全地 resolve 输出路径

这是为了解决两个具体问题：

- overlay 导出时的路径逃逸风险
- CLI 默认输出路径基于 pipeline id 推导时的路径逃逸风险

## 7. 为什么 mod 里不应该再有 CLI 和 manifest 逻辑

这是这次重构里最重要的边界之一。

原则上：

- mod 不应该关心命令行参数
- mod 不应该决定输出目录结构
- mod 不应该自己写 manifest
- mod 不应该自己决定是 build overlays 还是 apply 成 PVF

原因很直接：

- 这些都是“编排层”的职责，不是“patch 层”的职责
- 一旦放回 mod 里，就会重新长成旧式的大脚本
- 多 mod 组合会再次失去统一入口

现在推荐的职责边界是：

- mod 返回 summary
- pipeline 统一收集 summary
- CLI 或上层应用决定如何展示、如何落盘

## 8. 仓库里的具体挂载点

当前仓库的关键挂载点如下：

- `mods/registry.ts`
  - 所有内建 mod 的注册表
- `mods/pipelines.ts`
  - 所有命名 pipeline 的配置
- `apps/pvf-mod-cli/src/index.ts`
  - commander CLI 的主入口

当前内建 mod 包括：

- `example_wild_strawberry_hp_up`
- `2_3_choro_partset_skill_up`

当前内建 pipeline 包括：

- `wild-strawberry-only`
- `demo`

## 9. CLI 架构

CLI 现在是 commander 实现，而不是手写参数解析。

当前命令：

- `list`
- `build`
- `apply`

### 9.1 `list`

输出：

- 所有已注册 pipeline
- 每个 pipeline 的 mod 顺序
- 所有已注册 mod

### 9.2 `build`

职责：

- 运行 pipeline
- 输出 overlay 目录
- 输出 manifest

默认输出：

- `out/<pipeline-id>/`
- `out/<pipeline-id>/manifest.json`

### 9.3 `apply`

职责：

- 运行 pipeline
- 输出新的 PVF
- 输出 manifest

默认输出：

- `out/<pipeline-id>.pvf`
- `out/<pipeline-id>.pvf.manifest.json`

### 9.4 ad-hoc pipeline

CLI 支持重复传 `--mod` 来临时组装 pipeline。

例如：

```bash
pnpm --filter pvf-mod-cli start build \
  --pipeline adhoc-preview \
  --mod example_wild_strawberry_hp_up \
  --mod 2_3_choro_partset_skill_up
```

如果提供了 `--mod`，CLI 会优先把它视为 ad-hoc pipeline，而不是读取 `mods/pipelines.ts` 里的命名配置。

## 10. Manifest 的作用

manifest 不是给 mod 自己消费的，而是给“构建结果的观察者”消费的。

它至少应该回答这些问题：

- 基于哪个 archive 构建的
- 用了哪个 pipeline
- pipeline 里有哪些 mod
- 每个 mod 改了哪些路径
- 最终有哪些 overlay 路径
- 如果是 apply，最终写出了哪些 added/updated/deleted paths

因此 manifest 是 pipeline 层输出，而不是 mod 层输出。

## 11. 如何新增一个 mod

推荐流程：

1. 在 `mods/<your-mod>/` 下创建独立 workspace 包
2. 在 `src/index.ts` 导出 `PvfRegisteredMod`
3. 如果逻辑复杂，把数据读取、转换、类型拆到多个文件
4. 尽量只在 mod 内写“业务 patch 逻辑”
5. 如果发现通用 helper 已经在 `@pvf/pvf-mod` 里有，就直接复用
6. 如果发现 helper 会被多个 mod 复用，再考虑提升到 `packages/pvf-mod`
7. 把 mod 注册到 `mods/registry.ts`
8. 需要命名流水线时，再把它挂到 `mods/pipelines.ts`

一个健康的 mod 包应该具备这些特征：

- 没有自己的 CLI
- 没有自己的 manifest writer
- 没有自己的输出目录规划
- 大部分 I/O 都通过 `PvfModSession` 完成

## 12. 何时把代码提升到共享层

如果某段逻辑满足以下任一条件，就应该优先考虑提升到 `packages/pvf-mod`：

- 两个以上 mod 都会重复使用
- 它本质上是 AST 操作 helper，而不是业务规则
- 它本质上是 pipeline/manifest/path safety 的基础设施
- 它是对 `PvfModSession` 的通用操作封装

如果逻辑明显和某个具体业务强绑定，就留在 mod 包里，不要急着“抽象”。

## 13. 当前已知约束

这套架构目前有一些明确的边界：

- mod 执行是顺序的，不支持并行
- registry 和 pipeline 配置目前是代码静态注册，不是动态插件发现
- CLI 默认仍然面向仓库内建 pipeline，不是一个通用插件市场
- `writeOverlayDirectory()` 只支持 text/script overlay 导出
- per-mod `changedPaths` 的计算目前是基于 overlay 快照比较，偏正确性优先，不是极致性能优化

这些都不是 bug，而是当前阶段有意保持简单的结果。

## 14. 最近一次重构特别强调的约束

这几条最好不要被后续改动破坏：

- 不要把 CLI 再塞回 mod 包
- 不要让 mod 自己写 manifest
- 不要让每个 mod 自己决定输出目录和文件名
- 不要重新引入 sibling package 的 `../../foo/src/index.ts` 式导入
- 不要破坏“后一个 mod 读取到前面所有 overlays 合并结果”这个核心语义

如果未来要扩展，也应该围绕这几条继续长，而不是往回退。

## 15. 推荐的后续演进方向

如果要继续做大，这几个方向是自然的：

- 支持从外部配置文件加载 pipeline，而不只是 `mods/pipelines.ts`
- 支持更丰富的 mod options schema 和校验
- 把 manifest 做成更稳定的审计格式
- 对 `changedPaths` 的计算做更轻量的签名优化
- 增加更多 session 级通用 helper，进一步减少 mod 内重复代码

## 16. 给后续 agent 的快速恢复提示

如果上下文被压缩了，先看这些文件：

- `docs/mod-pipeline-architecture.md`
- `README.md`
- `packages/pvf-mod/src/runtime.ts`
- `packages/pvf-mod/src/pipeline.ts`
- `mods/registry.ts`
- `mods/pipelines.ts`
- `apps/pvf-mod-cli/src/index.ts`

然后用这组问题快速恢复上下文：

- 当前问题是 mod 逻辑本身，还是 pipeline 编排，还是 CLI/输出层问题？
- 这次改动应该放进某个具体 mod，还是放进 `@pvf/pvf-mod`？
- 改动会不会破坏多 mod 顺序可见性？
- 改动会不会把编排职责重新塞回 mod？

如果这四个问题都答清楚了，通常就不会走偏。
