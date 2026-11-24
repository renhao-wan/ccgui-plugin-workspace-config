# 工作区配置 workspace-config — 设计方案

日期：2026-11-24
状态：v0.1.0 已实现核心链路

## 1. 目标

CC GUI 和 CC Switch 都只能管理全局配置（`~/.claude/settings.json`、`~/.claude.json`）。
Claude Code 本身有项目级覆盖机制，但散落在三个键、三套语义里，没有统一入口。

本插件提供一个面板，按**当前工作区**管理三类资源，只做开关，不增删：

- 插件（plugin）
- MCP server
- 技能（skill）

硬约束：

1. 只写 `<workspace>/.claude/settings.local.json`
2. 不修改任何全局文件，CC Switch 的配置不受影响
3. 新工作区不写任何键，自然继承全局
4. 不新增、不删除资源，只切换启用状态

## 2. 三类资源的项目级语义

### 2.1 插件

- 键：`enabledPlugins`（scope 为 `Any file`）
- 三态：`inherit`（不写）/ `on`（写 `true`）/ `off`（写 `false`）
- 项目 `settings.local.json` 的键压过 user 层同键
- `on` 只对本机已安装的插件可用；未安装的灰显

### 2.2 MCP

- 键：`deniedMcpServers`（scope 为 `Any file`，跨所有 scope 合并成一个 denylist）
- 三态：`inherit`（移除该 `serverName` 条目）/ `off`（加入条目）
- **没有 `on`**：denylist 不可被覆盖，全局已 deny 的 server 项目级无法解除
- 只增删 `serverName` 条目；`serverCommand`、`serverUrl` 条目原样保留

同一 server 的定义优先级：`local > project > user > plugin > claude.ai connectors`。
本插件只读这些来源用于展示，写入只针对项目级 denylist。

### 2.3 技能

- 键：`skillOverrides`（scope 为 `Any file`），官方是**四态**：

| 值 | 对 Claude | 在 `/` 菜单 | 界面文案 |
|---|---|---|---|
| `on`（缺省） | 名称 + 描述 | 可见 | 启用 |
| `name-only` | 只有名称 | 可见 | 仅名称 |
| `user-invocable-only` | 隐藏 | 可见（标记 `user-only`） | 仅手动 |
| `off` | 隐藏 | 隐藏（Remote Control、Agent SDK 的命令列表也一起隐藏） | 禁用 |

- personal / project 技能：`inherit` + 四态共五档
- **plugin 提供的技能不受 `skillOverrides` 控制**（官方文档明确），只能关闭整个插件
- 同名技能：`enterprise > personal > project`，个人版压过项目版；`skillOverrides` 按名字生效，不区分来源
- 读不认识的取值时返回 `unknown`，界面只显示「其它取值」、不渲染按钮——把它猜成 `on` 会误导，而任何一次写入都会覆盖掉用户原值

因此技能栏按来源分流：

| 来源 | 面板行为 |
|---|---|
| personal | 五档开关（侧栏因宽度改下拉） |
| project | 五档开关 |
| plugin | 只读，显示「由插件控制」 |

### 2.4 项目 `.mcp.json` 的审批

`<ws>/.mcp.json` 里定义的 server 还要单独走一道审批，Claude Code 把结果写在 **`.claude/settings.local.json`**（正是本插件独占的文件），三个键：

| 键 | 含义 |
|---|---|
| `enableAllProjectMcpServers` | 布尔总开关，全部批准、不再弹窗 |
| `enabledMcpjsonServers` | 逐个批准 |
| `disabledMcpjsonServers` | 逐个拒绝，**优先级高于前两者** |

三者都没覆盖时是「待审批」：不连接，也不出现在会话里。审批与「禁用」是**两根轴**——禁用写 `deniedMcpServers`，审批写这三个键；两者都通过才真正连上，所以界面在同一行里并排显示，`effectiveState` 同时考虑两者。

`enableAllProjectMcpServers` 为 `true` 时，单个 server 无法回到「待审批」（Claude Code 的语义，不是本插件能改的）；`setMcpApproval` 因此返回 `effective`，界面据此提示「实际仍是批准的」。

审批只对 `project` 来源有定义；`local` / `user` / `plugin` 来源的 server 不弹这个窗，界面也不显示审批控件。

## 3. 架构

```
main.js（单文件 ESM）
├── src/lib/model.mjs       纯函数：三态读写、空键清理、生效态计算
├── UI 组件                 panel tab + center tab，共享一个内存 store
└── SCAN_SOURCE             内联的 config-io 源码字符串

运行时：
  documentStorage.writeTextAtomic("runtime/config-io.mjs", SCAN_SOURCE)
  bridge.invoke("plugin_exec_run", { bin: "node", args: [脚本, "scan"|"set", ...] })
  脚本读改写 .claude/settings.local.json，stdout 输出单行 JSON
```

宿主不提供文件系统 API（`documentStorage` 是插件私有隔离存储，`assets.grantDirectory` 只给资源 URL），`exec:node` 是唯一能碰项目目录的通路。

### 3.1 模块职责

| 文件 | 职责 | 测试 |
|---|---|---|
| `src/lib/model.mjs` | 三态模型，纯函数，不碰 I/O | `test/model.test.mjs` |
| `scripts/config-io.mjs` | 读全局/项目配置、扫描 skills、原子写回 | `scripts/smoke.mjs`（真实执行） |
| `scripts/build.mjs` | 内联 model 与 config-io，产出单文件 main.js | build 自检 |
| `src/main.head.js` | UI、store、exec 调用 | 由 smoke 间接覆盖 |

## 4. 状态模型

```js
projectState: "inherit" | "on" | "off"                      // 插件、MCP
projectState: "inherit" | "on" | "name-only"
            | "user-invocable-only" | "off"                  // 技能
approval:    "pending" | "approved" | "rejected" | null      // 仅 project 来源的 MCP
effectiveState = projectState === "inherit" ? globalState : projectState
               // MCP 再叠加「是否真的连上」：禁用或被审批挡住都是 off
```

- `inherit` 表示不写键，改回 `inherit` 会删除对应条目并清理空对象/空数组
- MCP 的 `on` 在写入层直接拒绝
- 全局状态只用于展示，不参与写入决策
- 审批与禁用分开存储、分开写入：`mcpApproval` 是一个独立的写操作，不碰 `deniedMcpServers`

## 5. 读取范围

| 文件/目录 | 用途 |
|---|---|
| `~/.claude/settings.json` | 全局 `enabledPlugins`、`skillOverrides`、`deniedMcpServers` |
| `~/.claude.json` | user / local 两层 MCP |
| `~/.claude/plugins/installed_plugins.json` | 已安装插件及其 `installPath` |
| `~/.claude/plugins/cache/**/skills/*/SKILL.md` | plugin 技能 |
| `~/.claude/skills/*/SKILL.md` | personal 技能 |
| `<ws>/.claude/skills/*/SKILL.md` | project 技能 |
| `<ws>/.mcp.json` | project MCP；其审批结果在 `settings.local.json` 的三个 `*McpjsonServers` / `enableAllProjectMcpServers` 键里 |
| `<ws>/.claude/settings.json` | 团队配置（只读，用于展示冲突） |
| `<ws>/.claude/settings.local.json` | 读写目标 |
| `~/.claude/projects/<slug>/memory/*.md` | 自动记忆（只读浏览，见 6.4） |

## 6. UI

- **右侧 panel tab**：跟随 `workspacePath`，紧凑列表 + 三态分段控件；三个类别用页内页签切换，页签条固定在滚动区外（列表再长也不会把切换器顶走）
- **中央 center tab**：同一 store 的宽视图，**左侧导航 + 右侧详情**——一次只看一类（插件 / MCP / 技能 / 记忆），不会再有三块列表同时出现；左导航每项带总数，有本地覆盖时追加覆盖数徽标；搜索与「只看本地覆盖」只作用于当前类别，切类别会清空搜索词；窄屏（<880px）导航翻到顶部变成横向滚动条。需先在右侧面板激活一次工作区
- 每行显示：名称、来源元信息（市场 / scope / personal|project|plugin）、三态控件
- plugin 技能行显示「由插件控制」徽标
- 保存后提示生效方式：插件 `/reload-plugins`，MCP 与技能新会话

### 6.1 分层显示

配置实际有 local / 团队（shared）/ 全局三层，而面板只写 local，因此每行同时给出两套状态：

| 字段 | 含义 | 用途 |
|---|---|---|
| `localState` | 只看 `.claude/settings.local.json` | **控件选中态**、批量统计、覆盖筛选 |
| `sharedState` | 只看 `.claude/settings.json` | 标记团队来源 |
| `projectState` | local 压过 shared 的合并结果 | 排序、生效计算 |
| `effectiveState` | 再叠上全局后的最终值；MCP 还要通过审批 | 圆点提示（开绿、中间态黄、关灰） |

团队层有显式值时，「跟随」按钮改为「跟随团队（配置）」，tooltip 说明清除本地覆盖后会回到团队配置；meta 行追加「团队禁用 / 团队启用」。MCP 因 `deniedMcpServers` 跨层 union，团队层禁用后本地无法解除：meta 标注「本地不可解除」，并把「跟随」按钮置灰。

### 6.2 诊断

`scan` 额外返回 `diagnostics`，每项 `{ level, kind, id, name, message, fixable }`：

诊断为空时整块不渲染——没有问题时不该占正文一行。

| level | 场景 | 可清理 |
|---|---|---|
| `stale` | local 里有键，但对应插件 / 技能 / MCP 已不存在 | 是 |
| `warn` | 全局启用但未安装；团队层禁用的 MCP；插件技能被本地覆盖；项目 `.mcp.json` 的 server 待审批 | 否 |
| `info` | 项目技能被同名个人技能遮蔽 | 否 |

残留项之所以必须由诊断区处理：列表只列现存资源，这些键不在任何列表里，用户没有其他入口。清理复用 `setMany` 的 `inherit` 操作，不新增写命令。

### 6.3 生效链路

中央视图点击任意一行展开：

```
全局 → 团队配置 → 本地 → [审批] → 最终
```

数据全部来自 `scan` 已有的状态字段，纯展示。`[审批]` 只对项目 `.mcp.json` 定义的 server 出现。侧栏（`compact`）不提供展开，保持简洁。

### 6.4 记忆浏览（只读）

中央页签左侧导航第 4 项，与三个开关类别用分隔线隔开——它是「看」而不是「改」。

| source | 位置 | 说明 |
|---|---|---|
| `auto` | `~/.claude/projects/<slug>/memory/*.md` | Claude 自己维护的自动记忆；`MEMORY.md` 是索引，排最前 |
| `project` | `<ws>/CLAUDE.md`、`<ws>/.claude/CLAUDE.md`、上级目录链、`<ws>/.claude/rules/*.md` | 项目规则，向上最多 12 层 |
| `user` | `~/.claude/CLAUDE.md` | 个人全局 |

`<slug>` 由工作区绝对路径里所有非字母数字字符逐一替换成 `-` 得到（`D--projects-plugins-notes-cc-wrapped`）。

链路仍是 `exec:node`，新增两个只读动作：

```
node config-io.mjs memory    <workspace>        列出全部记忆文件（含标题、描述、大小、mtime）
node config-io.mjs memoryRead <workspace> <path> 读正文
```

`memoryRead` 会**重新收集一遍列表**并只认自己列出来的绝对路径，所以这个动作无法被用来读任意文件（冒烟里断言了 `~/.claude/settings.json` 读不到）。正文用共用库 `markdown` / `markdown-view` 渲染成节点，全程不拼 HTML；超过 512 KB 只显示前 512 KB 并标注。

只读是设计边界，不是暂未实现：自动记忆的索引与正文由 Claude 维护，外部增删会造成「索引有条目、文件已不存在」这类不一致，插件不去碰。需要改就直接用编辑器打开界面上给出的绝对路径。

## 7. 已知限制

1. ~~`skillOverrides` 的跨层合并需实测~~ 已实测（Claude Code 2.1.319）：项目层 `on` 能压过 user 层 `off`，双向成立，团队层同样参与
2. MCP 只有 deny 语义，没有反向启用
3. plugin 技能无法单独禁用
4. 项目 `.mcp.json` 的「待审批」在 `enableAllProjectMcpServers: true` 时不可达，界面只能提示
5. 共享包 `validate-core` 未覆盖 `registerPanelTab` 的权限检测，产生一条固定 warn
6. 远程工作区（`host:workspace:remote`）下 `exec:node` 的执行位置未验证

## 8. 测试

- 17 条纯逻辑单测：三态读写、技能四态往返与 `unknown` 只读、`.mcp.json` 审批（拒绝优先、名单互斥、总开关语义）、空键清理、保留非托管键、生效态
- 206 项冒烟检查：临时 HOME + 真实落盘脚本，覆盖 scan / set / 再 scan / 还原，并断言全局文件未被修改；技能四态与 `.mcp.json` 审批包含「待审批的 server 不显示成生效」「name-only 不被改写」「总开关开着时 pending 如实回报」等回归断言；记忆动作包含 slug 派生、三类来源、索引排序、白名单外拒读、空工作区兜底。另用 fake-react 真实渲染右侧面板、中央页签与设置页，包含团队层 fixture、五档按钮与侧栏下拉、审批控件写盘、诊断识别与清理、生效链路展开、页签固定位置与切换归顶、左导航切换与覆盖数徽标、顶部区收起/展开、记忆列表与 Markdown 正文渲染。检查项数由 `assert` 计数包装统计，不再手写
