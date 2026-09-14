# `@deepseek-ai/dsh-client-frames`（工作区暂存）

Frame Manager 的核心：窗口布局是一棵纯数据的树，运行时每次变更都是可逆操作，所有渲染端画同一份投影。

本目录按仓库的包布局组织，**代码在工作区里开发与验证，之后再迁入 `E:\dsh\deepseek-harness`**。

---

## 测试

```sh
node tools/run-tests.ts        # 在工作区根目录执行
```

沙箱不允许 `node --test`（它为每个文件 spawn 子进程，撞命名管道限制），因此全部套件在**同一进程**内导入运行；Node 24 原生剥离 TypeScript 类型，不需要打包器，也没有任何依赖。

---

## `src/vendor/` 是我们自持的副本

| 副本 | 来源 |
|---|---|
| `vendor/ui-dockkit/engine/` | `E:\dsh\deepseek-harness\packages\client\ui-dockkit\src\engine\`（第三方工程，只读） |
| `vendor/ui-dockkit/contract/types.ts` | 同上，`src/contract/types.ts` |
| `vendor/brand/index.ts` | 同上，`packages/util/brand/src/index.ts` |

**这不是临时占位，而是长期方案。** 第三方工程不可修改，而它的 `ui-dockkit` 构件是单一 ESM bundle、顶层 import 连带 React，非 React 消费者无法复用（ESM 静态 import 必然求值，tree-shaking 绕不开）。所以 `frames` 自带引擎——**副本就是我们的代码，我们负责它的正确性**，上游修复不会自动流入。

出处与同步约定见台账 T12。三条硬约束：不得从 `vendor/**` 导入 React；不得依赖第三方工程的包解析；副本的任何改动都要在提交信息里说明原因。

除 `vendor/` 外，`src/model/`、`src/geometry/`、`src/project/` 全部是本工作区的原创代码。

---

## 已实现

| 文件 | 内容 |
|---|---|
| `src/model/platform.ts` | 能力契约 `FrameCapabilities` / `FramePlatform`，以及 `REACT_CAPABILITIES` 与 `TUI_CAPABILITIES` 两个预设 |
| `src/model/types.ts` | `FrameTypeDefinition`、策略、不可变注册表与其错误 |
| `src/model/state.ts` | `FrameState`、`createFrameState`（无配置时一个 frame 占满）、三个派生函数 |
| `src/geometry/rect.ts` | 归一化矩形与分裂/分隔条/单位换算 |
| `src/project/project.ts` | `project(state)`：压平分裂树、解析每个 pane 的矩形、给出 `canSplit` 判定与降级记录 |

---

## 一个必须记录的设计修正

设计文档说浮窗矩形归一化会"牵动 `engine/geometry.ts` 的 `movedRect` / `resizedRect` / `floatRectAt` / `FLOAT_DEFAULT_SIZE`"。

**这与"不得修改现有包"冲突**，因此改为：`frames` 把引擎里 `FloatRect` 的数值**当作归一化值使用**，浮窗的定位与缩放算术由 `frames` 自己承担，不使用那几个带像素语义的引擎辅助函数与常量。这样两件事同时成立——跨端归一化保留，`ui-dockkit` 一行不改。

落地到 T06（浮层与停靠）时按这条执行。

---

## 尚未实现（后续任务）

- 操作层与历史（T03–T05）
- 浮窗投影与宿主切换（T06）
- 治理裁决（T07）
- 预设与序列化（T09）
- React 渲染器 `frames-web`（T02 的后半、T08）——需要仓库环境，工作区里没有 React
