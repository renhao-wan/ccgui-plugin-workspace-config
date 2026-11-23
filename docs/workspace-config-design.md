# 工作区配置 workspace-config — 设计方案

日期：2026-11-23
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

- 键：`skillOverrides`（scope 为 `Any file`），值支持 `on` / `name-only` / `user-invocable-only` / `off`
- personal / project 技能：三态完整
- **plugin 提供的技能不受 `skillOverrides` 控制**（官方文档明确），只能关闭整个插件
- 同名技能：`enterprise > personal > project`，个人版压过项目版；`skillOverrides` 按名字生效，不区分来源

因此技能栏按来源分流：

| 来源 | 面板行为 |
|---|---|
| personal | 三态开关 |
| project | 三态开关 |
| plugin | 只读，显示「由插件控制」 |

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

## 4. 三态模型

```js
projectState: "inherit" | "on" | "off"
effectiveState = projectState === "inherit" ? globalState : projectState
```

- `inherit` 表示不写键，改回 `inherit` 会删除对应条目并清理空对象/空数组
- MCP 的 `on` 在写入层直接拒绝
- 全局状态只用于展示，不参与写入决策

## 5. 读取范围

| 文件/目录 | 用途 |
|---|---|
| `~/.claude/settings.json` | 全局 `enabledPlugins`、`skillOverrides`、`deniedMcpServers` |
| `~/.claude.json` | user / local 两层 MCP |
| `~/.claude/plugins/installed_plugins.json` | 已安装插件及其 `installPath` |
| `~/.claude/plugins/cache/**/skills/*/SKILL.md` | plugin 技能 |
| `~/.claude/skills/*/SKILL.md` | personal 技能 |
| `<ws>/.claude/skills/*/SKILL.md` | project 技能 |
| `<ws>/.mcp.json` | project MCP |
| `<ws>/.claude/settings.json` | 团队配置（只读，用于展示冲突） |
| `<ws>/.claude/settings.local.json` | 读写目标 |

## 6. UI

- **右侧 panel tab**：跟随 `workspacePath`，紧凑列表 + 三态分段控件
- **中央 center tab**：同一 store 的宽视图，需先在右侧面板激活一次工作区
- 每行显示：名称、来源元信息（市场 / scope / personal|project|plugin）、三态控件
- plugin 技能行显示「由插件控制」徽标
- 保存后提示生效方式：插件 `/reload-plugins`，MCP 与技能新会话

## 7. 已知限制

1. `skillOverrides` 的跨层合并（项目 `on` 能否压过 user `off`）文档未单独举证，需实测；若不成立，技能 `on` 退化为仅显示
2. MCP 只有 deny 语义，没有反向启用
3. plugin 技能无法单独禁用
4. 共享包 `validate-core` 未覆盖 `registerPanelTab` 的权限检测，产生一条固定 warn
5. 远程工作区（`host:workspace:remote`）下 `exec:node` 的执行位置未验证

## 8. 测试

- 11 条纯逻辑单测：三态读写、空键清理、保留非托管键、生效态
- 25 项冒烟检查：临时 HOME + 真实落盘脚本，覆盖 scan / set / 再 scan / 还原，并断言全局文件未被修改
