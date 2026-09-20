# `@deepseek-ai/dsh-client-frames` 设计

> **本包是三个仓库里的核心。** 它不认识 React、DOM、`ui-layout`，也不认识任何 legacy 概念。
> 总体的三仓关系、共享契约与跨包不变量见工作区根目录的 [`frame-manager-design.md`](../../../frame-manager-design.md)。
> 任务与进度见 [`frame-manager-tasks.md`](../../../frame-manager-tasks.md)。

---

## 1. 职责边界

| | 知道什么 | **绝不知道** |
|---|---|---|
| 本包 | frame 树、内容注册表、类型注册表、操作与历史、几何、能力降级、投影、预设 | React / DOM / `ui-layout` / `ctx.layout` / `usePanelInfo` / `main` / conversation / "sidebar" |
| 谁挂载它 | 宿主（渲染端）提供 `reflect.provide`；本包**不自己挂载** | 谁来画、画在什么上 |

**它只发布两样东西**：一个 `FramesService`（`ctx.frames`），和一个纯函数 `project()` 的产物 `FrameViewProjection`。

---

## 2. 框架图

### 2.1 内部分层

```mermaid
flowchart TB
    subgraph edge["出口"]
        SVC["service/service.ts<br/>FramesService · createFramesService · provideFramesService"]
        IDX["index.ts<br/>唯一的公开面"]
    end

    subgraph ops["操作层 —— 唯一能改模型的地方"]
        INT["ops/intents.ts<br/>splitFrame · closeFrame · dropFrame · openContent …"]
        HIS["ops/history.ts<br/>一次意图 = 一条历史"]
        RES["ops/result.ts<br/>FrameResult · 拒绝码"]
    end

    subgraph model["模型层 —— 纯数据，按引用比较"]
        ST["model/state.ts<br/>FrameState"]
        CT["model/content.ts<br/>内容注册表"]
        TY["model/types.ts<br/>类型注册表"]
        PF["model/platform.ts<br/>平台能力"]
    end

    subgraph pure["纯派生"]
        PRJ["project/project.ts<br/>FrameViewProjection（已按能力降级）"]
        GEO["geometry/rect.ts · rects.ts<br/>归一化矩形与遍历"]
        PST["preset/preset.ts<br/>Preset · PresetPort"]
    end

    subgraph vnd["vendor/ —— 自持副本，见 vendor/README.md"]
        V["ui-dockkit 的 contract + engine（10 个文件）"]
    end

    IDX --> SVC
    SVC --> INT
    SVC --> PRJ
    SVC --> PST
    INT --> HIS --> RES
    INT --> ST
    INT --> CT
    INT --> TY
    INT --> GEO
    PRJ --> ST
    PRJ --> GEO
    PST --> ST
    PST --> CT
    INT --> V
    ST --> V
    GEO --> V
    PF --> ST

    classDef edgeC fill:#1f3a5f,stroke:#6ea8fe,color:#e6e9ef
    classDef opsC fill:#3a2f1f,stroke:#e0a458,color:#e6e9ef
    classDef pureC fill:#1f3a2f,stroke:#5fbf7f,color:#e6e9ef
    classDef vndC fill:#2a2a2a,stroke:#888,color:#ccc
    class SVC,IDX edgeC
    class INT,HIS,RES opsC
    class PRJ,GEO,PST pureC
    class V vndC
```

**三条方向规则**：

1. **只有 `ops/intents.ts` 改模型。** 它调 `applyOp`（vendor）拿到新状态与逆操作，再写历史。除此之外没有第二条路径。
2. **`project/` 只读。** 它把状态摊平并**就能力降级**，从不回写——同一份预设因此在两个目标上投影不同、存的却是同一份。
3. **`service/` 不决策。** 它只做三件事：把当前状态交给意图、比较新旧引用决定要不要发布、把名字发布到宿主。

### 2.2 一次操作的路径

```mermaid
flowchart LR
    C["调用方<br/>渲染端 · 兼容层 · 终端"] --> I["意图函数"]
    I --> G{"治理裁决<br/>策略 · 预算 · 尺寸"}
    G -- 拒绝 --> F["FrameResult.ok=false<br/>不改状态 · 不写历史"]
    G -- 通过 --> P["planner（vendor，纯函数）"]
    P --> A["applyOps（vendor）<br/>新状态 + 逆操作"]
    A --> H["pushIntent<br/>恰好一条历史"]
    H --> M["materialise<br/>把新坐下视图的内容收进注册表"]
    M --> S["FrameState"]
    S --> PJ["project()"]
    PJ --> R["FrameViewProjection"]
    R --> C
```

---

## 3. 静态类图

### 3.1 状态与注册表

```mermaid
classDiagram
    class FrameState {
        +LayoutState layout
        +ContentRegistry contents
        +FrameTypeRegistry types
        +FramePlatform platform
        +FrameMeasurements measurements
        +string activePresetId
        +FrameHistory history
        +number revision
        +IdMinter minter
    }

    class LayoutState {
        <<vendor>>
        +Record~NodeId,LayoutNode~ nodes
        +Record~TabId,TabRecord~ tabs
        +NodeId rootId
        +PaneId[] floats
        +PaneId activePaneId
        +boolean expanded
        +DockMode mode
    }

    class ContentRegistry {
        <<type alias>>
        ReadonlyMap~ContentId,FrameContent~
    }
    class FrameContent {
        +ContentId id
        +string kind
        +string title
    }
    class FrameTypeRegistry {
        <<type alias>>
        ReadonlyMap~string,FrameTypeDefinition~
    }
    class FrameTypeDefinition {
        +string id
        +title() string
        +FrameTypePolicy policy
        +PaneHost[] hosts
    }
    class FramePlatform {
        +string id
        +FrameCapabilities capabilities
    }
    class FrameCapabilities {
        +FloatPresentation floats
        +boolean freeRect
        +boolean drag
        +number maxDockPanes
        +number minPaneSize
        +boolean detachable
        +string[] reservedChords
    }
    class FrameHistory {
        +HistoryEntry[] past
        +HistoryEntry[] future
    }

    FrameState *-- LayoutState : 视图
    FrameState *-- ContentRegistry : 内容
    FrameState *-- FrameTypeRegistry
    FrameState *-- FramePlatform
    FrameState *-- FrameHistory
    ContentRegistry o-- FrameContent
    FrameTypeRegistry o-- FrameTypeDefinition
    FramePlatform *-- FrameCapabilities
    LayoutState ..> TabRecord : 引擎的视图记录（一格恒一条）
    FrameContent ..> TabRecord : contentId 相连
```

> **一格显示一个内容；tab 不是核心的词汇。** 引擎的 `LayoutState.tabs` 仍在（那是 vendored 模型，浮层本来就是"capacity 1 tab, drawn without a tab strip"），但本层把它**恒定为每格一条**：`PaneNode.tabs` 永远是长度 1 或 0，`moveTab`/`reorderTab` 这些 op 不再被任何意图产生。上面这一层只说 **content**：一格显示哪个内容、哪个内容被换下但还活着。
>
> **一个 content 内部有没有 tab，是它自己的插件的事**（editor 的文件页、右栏面板的页签都是这样画的）。核心既不画、也不知道，所以"同一格的 tab 混用"这种事在模型里根本不存在。

### 3.2 操作层

```mermaid
classDiagram
    class Intents {
        <<module>>
        +splitFrame(state, paneId?, seed?, axis) FrameResult
        +closeFrame(state, paneId?) FrameResult
        +floatFrame(state, paneId?) FrameResult
        +dockFrame(state, paneId?) FrameResult
        +focusFrame(state, paneId) FrameResult
        +moveFocus(state, direction) FrameResult
        +dropFrame(state, tabId, target, seed?) FrameResult（已退场：拒绝）
        +placeTab(state, tabId, toPaneId, index) FrameResult（已退场：拒绝）
        +resizeSplit(state, splitId, sizes) FrameResult
        +resizePane(state, paneId, fraction, minimum?) FrameResult
        +placeFloat(state, paneId, rect) FrameResult
        +registerFrame(state, content) FrameResult
        +openContent(state, contentId, options?) FrameResult
        +forgetFrame(state, id) FrameResult
        +undo(state) FrameResult
        +redo(state) FrameResult
    }
    class FrameResult~T~ {
        <<union>>
        ok: true, value: T
        ok: false, code, message
    }
    class FrameErrorCode {
        <<enumeration>>
        frames/unknown-type
        frames/unknown-target
        frames/unknown-content
        frames/unsupported-on-platform
        frames/pane-budget-exhausted
        frames/too-narrow
        frames/policy-refused
        frames/unknown-preset
        frames/not-measured
        frames/nothing-to-undo
        frames/nothing-to-redo
    }
    class DropTarget {
        <<union>>
        dock: paneId + zone
        float: rect?
    }
    class OpenOptions {
        +Placement place
        +PaneId beside
    }
    class Placement {
        <<enumeration>>
        left
        right
        above
        below
    }

    Intents ..> FrameResult
    FrameResult ..> FrameErrorCode
    Intents ..> DropTarget
    Intents ..> OpenOptions
    OpenOptions ..> Placement
```

> **每条意图**都走同一条路：治理裁决 → planner → `applyOps` → **恰好一条历史**。被拒绝的既不改状态也不写历史，并且**不产生历史**这件事本身有测试断言。
>
> **`closeFrame` 是"删掉这一格"**：格子里显示的东西被关掉，格子本身也随之消失（非根的停靠格合并回它的兄弟）。**根格是外壳**——关它只带走它显示的东西，外壳留着（清空的那一格画选择列表）。所以"空格子关不掉"从来不是不变式，它只是 `closeFrame` 里一个写于"空 pane 只可能是外壳"年代的早退分支。
>
> **`undo` / `redo` 是布局历史**。`forgetFrame` **不记历史**——历史是布局操作的序列，销毁内容不是布局操作，撤销一次布局变更救不回一个内容。

### 3.3 投影

```mermaid
classDiagram
    class FrameViewProjection {
        +number revision
        +string platform
        +Extent viewport
        +ProjectedPane[] docked
        +ProjectedFloat[] floats
        +ProjectedDivider[] dividers
        +PaneId active
        +boolean expanded
        +DockMode mode
        +Degradation[] degradations
        +boolean empty
    }
    class ProjectedPane {
        +PaneId id
        +NormalizedRect rect
        +ProjectedContentRef content
        +boolean canSplit
        +SplitBlock splitBlockedBy
    }
    class ProjectedFloat {
        +PaneId id
        +NormalizedRect rect
        +FloatPresentation presentation
        +ProjectedContentRef content
        +boolean rectHonoured
    }
    class ProjectedContentRef {
        +string contentId
        +string typeId
        +string title
    }
    class ProjectedDivider {
        +SplitId splitId
        +SplitAxis axis
        +number index
        +number at
        +number[] sizes
        +NormalizedRect parent
        +NormalizedRect rect
        +boolean movable
    }
    class Degradation {
        +string kind
        +string target
        +string message
    }
    class FrameBodyProps {
        +NormalizedRect rect
        +Extent viewport
        +boolean focused
    }

    FrameViewProjection *-- ProjectedPane
    FrameViewProjection *-- ProjectedFloat
    FrameViewProjection *-- ProjectedDivider
    FrameViewProjection *-- Degradation
    ProjectedPane *-- ProjectedContentRef
    ProjectedFloat *-- ProjectedContentRef
```

> `project()` 是**纯函数**，且**引用只在布局真的变了时才换**（`revision` 随之递增）。渲染端因此可以用引用比较决定要不要重画。
>
> `FrameBodyProps` 是"渲染端必须交给 body 什么"的契约：面积保持归一化，viewport 一起传，body 自己换算。终端渲染端要照做。
>
> **投影还列两本账**：`types`（注册了哪些类型、哪些**能造**、哪些**能被 frame 画**）与 `contents`（外壳握着哪些内容，同样带 `placeable`）。选择器读这两本账，所以核心不必为某个 UI 添概念；而"谁能被画"是**类型拥有者的声明**（`policy.placeable`）——一个内容的拥有者可能把它画在别处（compat 的右栏面板挂在 overlay 座位上，占位那一格画的是空盒子），把它列进选择器就是递给用户一个**空的 frame**（T25）。

### 3.4 预设

```mermaid
classDiagram
    class Preset {
        +number version
        +string name
        +LayoutState layout
        +number mint
    }
    class PresetPort {
        <<interface>>
        +list() Promise~string[]~
        +read(name) Promise~unknown~
        +write(name, preset) Promise~void~
        +remove(name) Promise~void~
    }
    class Presets {
        <<module>>
        +PRESET_FORMAT_VERSION number
        +toPreset(state, name) Preset
        +parsePreset(raw) FrameResult~Preset~
        +withPreset(state, preset) FrameState
        +canonicalLayout(layout) LayoutState
        +mintedThrough(layout) number
    }

    Presets ..> Preset
    Presets ..> PresetPort : 只定义口子
    Preset *-- LayoutState
```

> **核心不碰介质。** `PresetPort` 是口子，介质由宿主给（web 端给的是 `localStorage`）。判断"这到底是不是一份合法预设"是核心的事，所以 `read()` 原样交回、`parsePreset()` 负责裁决。
>
> **预设不带 `contents`。** 载入时从布局里把内容重新收上来（`adoptContents`），所以格式版本仍是 v1、迁移链仍为空——用户的原话是内容"存在于**内存**中"，一次刷新是新会话。

### 3.5 服务面

```mermaid
classDiagram
    class FramesService {
        <<interface>>
        +registerType(definition) void
        +attachRenderer(platform) void
        +reportMeasurements(measurements) void
        +project() FrameViewProjection
        +subscribe(listener) Function
        +split(paneId?, seed?, axis?) FrameResult
        +close(paneId?) FrameResult
        +float(paneId?) FrameResult
        +dock(paneId?) FrameResult
        +focus(paneId) FrameResult
        +moveFocus(direction) FrameResult
        +open(typeId) FrameResult
        +drop(tabId, target, seed?) FrameResult（拒绝：没有 chip 可拖）
        +placeTab(tabId, toPaneId, index) FrameResult（拒绝：没有 strip 可排）
        +resizeSplit(splitId, sizes) FrameResult
        +resizePane(paneId, fraction, minimum?) FrameResult
        +placeFloat(paneId, rect) FrameResult
        +activeTypeId() string
        +isOpen(typeId) boolean
        +hasType(typeId) boolean
        +contents() FrameContent[]
        +content(id) FrameContent
        +registerContent(content) FrameResult
        +openContent(id, options?) FrameResult
        +forgetContent(id) FrameResult
        +activePresetId() string
        +presetNames() string[]
        +refreshPresets() Promise~void~
        +savePreset(name) Promise~FrameResult~
        +applyPreset(name) Promise~FrameResult~
    }
    class FramesHost {
        <<interface>>
        +reflect.provide(name, value) Function
    }
    class createFramesService {
        <<factory>>
    }
    class provideFramesService {
        <<factory>>
    }

    createFramesService ..> FramesService : 构造
    provideFramesService ..> FramesService : 构造并发布
    provideFramesService ..> FramesHost : 只要一个 provide
    FramesService ..> FrameViewProjection : 唯一的输出
```

> **服务不自己挂载。** `provideFramesService` 只要求宿主有一个 `reflect.provide`——这就是核心唯一的宿主依赖，也正是终端能在自己的组合里挂同一份服务的原因。

---

## 4. 不变量

1. **降级只发生在投影层，绝不回写模型。** 否则跨端预设共享立刻失效。
2. **`applyOp` 之外没有第二条修改路径**；一次语义操作 = 一条历史记录。
3. **被拒绝的操作既不写历史也不改状态**。
4. **内容的生死与帧无关**：关掉最后一个视图，内容仍在；唯一出口是 `forgetFrame`。
5. **`project()` 纯**，且引用只在布局变化时改变。

---

## 5. 测试

```sh
node tools/run-tests.ts        # 在工作区根目录
```

| 套件 | 守什么 |
|---|---|
| `vendor.test.ts` | 副本无 React、不引用自己之外的东西、出处文件列全了每个文件 |
| `registry.test.ts` | 类型注册表不可变、重复 id 是编程错误 |
| `project.test.ts` | 投影快照与降级 |
| `intents.test.ts` | 三类拒绝、撤销/重做、一次意图一条历史 |
| `float.test.ts` · `drop.test.ts` | 宿主切换、落点语义 |
| `content.test.ts` | 内容不随视图消亡 |
| `placement.test.ts` | 四个方位真的落在那一侧（断言几何，不是断言参数） |
| `resize-pane.test.ts` | 改比例的分摊与两个下限 |
| `preset.test.ts` | 逐字段往返、版本拒绝、只保存才写 |
| `capabilities.test.ts` | 24 种能力组合的投影 |
| `service.test.ts` | 服务面的发布、订阅、引用语义 |
