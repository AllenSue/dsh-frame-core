# 引擎副本的出处

本目录是**我们自己的代码**，不是临时占位。它复制自第三方开源工程，但复制之后由**我们**负责它的正确性——上游的修复不会自动流入。

## 复制自哪里

| 项 | 值 |
|---|---|
| 包 | `@deepseek-ai/dsh-client-ui-dockkit` |
| 版本 | `0.1.5-rc.2` |
| 品牌类型包 | `@deepseek-ai/dsh-brand` `0.1.5-rc.2`（只用了 `Branded` 一个类型） |
| 来源工程 | `E:\dsh\deepseek-harness`（**只读**） |
| 复制时的提交 | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| 复制时的日期 | 2026-09-10T22:17:09+08:00 |
| 源路径 | `packages/client/ui-dockkit/src/**`、`packages/util/brand/src/index.ts` |

## 复制了哪些文件

`ui-dockkit` 的 `contract/` 与 `engine/` 下的**全部** `.ts` 都在这里，一个没漏：

```
ui-dockkit/contract/types.ts
ui-dockkit/engine/constraints.ts
ui-dockkit/engine/controller.ts
ui-dockkit/engine/geometry.ts
ui-dockkit/engine/initial.ts
ui-dockkit/engine/operations.ts
ui-dockkit/engine/planner.ts
ui-dockkit/engine/sequence.ts
ui-dockkit/engine/tree.ts
brand/index.ts
```

## 为什么不直接依赖它

**`ui-dockkit` 的构件是单一 ESM bundle，顶层 import 连带 React。** ESM 的静态 import **必然求值**，所以 tree-shaking 绕不开——只要碰它一下，React 就进了依赖图。

而核心 `frames` 必须能在一个**没有 React 的宿主**里跑：终端渲染端就是这样一个宿主，未来任何非 React 的消费者也是。所以非 React 消费者只能自带引擎。

（早先的计划是"给 `ui-dockkit` 加一个 React-free 的子路径导出"。那个计划已经作废——**那是第三方工程，我们不写它**。于是改成自带副本。）

## 与上游的差异

逐文件与上游比对过，**只有两处**，都列在这里。除此之外逐字节相同。

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `contract/types.ts` | `Branded` 的 import 从 `@deepseek-ai/dsh-brand` 改成 `../../brand/index.ts` | 机械改动，无法避免：副本不能依赖那个包，所以品牌类型也一并复制 |
| `engine/planner.ts` | `planSplitPane` 增加 `axis: SplitAxis = 'row'` | T08：上游把轴向写死为 `row`，而设计要 `C-x down` 是真的纵向分屏 |
| `engine/planner.ts` | `planSplitPane` 增加 `direction: SplitDirection = 'after'` | T16：上游把方向写死为 `after`，而侧栏必须开在**左边** |

两处函数改动都是**加法且默认值等于上游行为**：不传新参数的调用与上游逐字节同义。

> **这条很重要**：正因为有这两处，"我们负责它的正确性"才不是一句空话。上游若在 `planSplitPane` 上修 bug，**不会**自动进到这里，合并时要手工判断。

## 同步约定

上游更新时：

1. 逐文件重新比对，**不要整目录覆盖**——那会抹掉上面三处差异。
2. 差异表要跟着更新。新加一处差异就必须在这里加一行，否则这份文件就在说谎。
3. 本目录的测试与 `frames` 的测试一起跑（`node tools/run-tests.ts`）。

`frames/tests/vendor.test.ts` 守着两条机械可查的性质：**副本里没有 React**，以及**副本不引用自己之外的任何东西**（后者才是"自带引擎"真正成立的意思）。
