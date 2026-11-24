# 工作区配置 workspace-config

CC GUI 插件。把「当前工作区」的 Claude Code 配置收进一个面板：MCP、插件、技能各一个开关。

## 为什么需要它

CC GUI 和 CC Switch 管理的是**全局**配置——写 `~/.claude/settings.json` 和 `~/.claude.json`。Claude Code 本身支持项目级覆盖，但散落在几个不同的键里，没有统一入口：

| 资源 | 项目级键 | 默认 | 项目级能做什么 |
|---|---|---|---|
| 插件 | `enabledPlugins` | 跟随全局 | 在本项目启用 / 禁用 |
| MCP | `deniedMcpServers` | 跟随全局 | 在本项目屏蔽（不能解除全局的禁用） |
| 技能 | `skillOverrides` | 跟随全局 | 五档：跟随 / 启用 / 仅名称 / 仅手动 / 禁用；插件提供的技能除外 |
| 项目 `.mcp.json` 审批 | `enableAllProjectMcpServers`、`enabledMcpjsonServers`、`disabledMcpjsonServers` | 待审批 | 批准或拒绝本项目的 server |

这个插件只做这些开关，不新增、不删除资源。

## 边界

- **只写** `<workspace>/.claude/settings.local.json`，从不修改全局文件
- 新工作区不写任何键，自然继承全局（也就是 CC Switch 配的那套）
- 插件提供的技能由插件控制，面板只显示来源，请到插件栏关闭整个插件
- 记忆文件**只读**：自动记忆的索引与正文由 Claude 维护，插件不提供增删改
- 项目配置不是合法 JSON 时**拒绝写入**并报错——那份文件里还有你手写的 `permissions`、`hooks`，覆盖掉就是事故
- 设了 `CLAUDE_CONFIG_DIR` 时，全局配置与自动记忆都跟着去该目录读
- 工作区信任（`~/.claude.json` 的 `hasTrustDialogAccepted`）与 `/mcp` 开关（`disabledMcpServers`）**只读**：面板会告诉你它们挡住了什么，但不会替你改全局文件

## 使用

1. 安装后在右侧面板打开「工作区配置」，它会跟随当前会话的工作区
2. 每项三态：跟随全局 / 启用 / 禁用；技能是五档（跟随 / 启用 / 仅名称 / 仅手动 / 禁用），面板不认识的取值只显示、不写入
3. 中央页签可打开更大的同款视图：左侧导航选类别、右侧看当前类别的完整列表，搜索与「只看本地覆盖」只作用于当前类别
4. 左侧导航最后一项「记忆」可以只读浏览当前工作区的记忆文件：自动记忆（`~/.claude/projects/<slug>/memory/`）、项目 `CLAUDE.md`、个人全局 `CLAUDE.md`。正文按 Markdown 渲染，路径可直接复制去编辑器里改
5. 插件改动点 `/reload-plugins` 生效；MCP 与技能下次会话生效
6. 中央视图里点任意一行，展开「全局 → 团队配置 → 本地 →（审批）→ 最终」的生效链路
7. 中央视图顶部的诊断区会列出残留覆盖、全局启用但未安装、团队层锁死、未批准的 `.mcp.json` server 等问题；残留项可一键清理
8. MCP 行右侧的「检测」按钮会让 Claude Code 真的连一次这个 server，告诉你它到底连不连得上。**这会启动该 server 的进程**，所以只在手动点击时发生，不会随刷新自动跑

## 技能的四态

Claude Code 的 `skillOverrides` 不只有开和关：

| 值 | 对 Claude | 在 `/` 菜单 |
|---|---|---|
| `on`（缺省） | 名称 + 描述 | 可见 |
| `name-only` | 只有名称 | 可见 |
| `user-invocable-only` | 隐藏 | 可见，只能手动调用 |
| `off` | 隐藏 | 隐藏 |

后两档不是「禁用」。面板按原值显示，点「启用」也不会把 `name-only` 改写成 `on`。

技能名以 `SKILL.md` 里 frontmatter 的 `name` 为准，目录名只是回落；两者不一致时面板会在行内标出目录名，避免按名字找不到目录。

## 项目 `.mcp.json` 的审批

`.mcp.json` 里定义的 server 需要批准后才会连接，结果由 Claude Code 写在 `.claude/settings.local.json`（和本插件同一个文件）：

- `enableAllProjectMcpServers: true`：全部批准
- `enabledMcpjsonServers` / `disabledMcpjsonServers`：逐个批准 / 拒绝，拒绝优先

未被三者覆盖时是「待审批」——看起来配了，实际没连。面板把审批和禁用分开显示，待审批的 server 不会显示成生效，诊断区也会提示。开了「全部批准」时单个 server 无法回到待审批，面板会如实说明。

### 批准了也可能连不上：还有两道闸

「文件里写着批准」不等于「真的连上」。另外两层住在 `~/.claude.json` 的项目条目里，本插件**只读不写**（写它就越过了「只碰项目级配置」的边界），但会把它们照实反映到界面上，免得绿点是假的：

- **工作区信任**：`hasTrustDialogAccepted` 不为 `true` 时，Claude Code 一律把 `approved` 当作待审批处理。在终端里跑一次 `claude` 接受信任对话框即可。**拒绝不受影响**——拒绝任何情况都生效。
- **`/mcp` 的手动开关**：`disabledMcpServers`（注意没有 `Mcpjson`，与 `deniedMcpServers` 是两个键）。在 `/mcp` 里关掉的 server 只有信任后才生效，要恢复也得回 `/mcp`。

这两种情况下，行上的圆点会变灰，`title` 写成「生效：关（工作区未信任）」，行尾再挂一个说明徽标；诊断区同时给出对应提示（未信任时还有一条工作区级汇总，避免逐条刷屏）。

### 推演不等于实测：「检测」按钮

上面这些判断都是照着配置文件推出来的，推不出「命令写错了」「启动就崩了」「网络不通」这类问题。MCP 行右侧的「检测」按钮会调 `claude mcp get <name>`，让 Claude Code 真的握一次手，把结果标在行上：`已连上` / `连不上` / `未批准` / `/mcp 已关闭` / `超时` / `无 CLI`。失败原因（比如 `CONNECTION_CLOSED`）会原样保留在悬停提示里。

两点需要注意：

- **它会启动 server 进程**，所以只能手动触发，不参与「刷新」。一次检测通常零点几秒到十几秒，超时上限 70 秒。
- 检测结论只对检测那一刻的配置成立。改动审批或开关后请重新检测；重新扫描会清空所有旧结果。

自检结论和推演结论可能不一致——比如配置里写着已批准、也信任了，但 server 启动就崩——这本身就是要显示出来的信息。

## 诊断

`settings.local.json` 里可能残留指向已卸载插件、已删除技能、已移除 MCP 的键。这些键在列表里看不到（列表只列现存资源），却仍然生效——重新安装同名资源时会突然变成禁用状态。诊断区把它们找出来，并可一键清除。`.mcp.json` 里删掉的 server 若仍占着审批名单，同样按残留列出。

其他诊断项只提示原因、不提供操作：

- 全局启用但本机未安装
- 团队配置已禁用，MCP 本地无法解除
- 项目技能被同名个人技能遮蔽
- 插件提供的技能不受本地开关控制
- 项目 `.mcp.json` 里定义了、但还没批准（本次会话不会连接）
- 已批准、但当前工作区尚未被信任（批准不生效，仍按待审批处理）
- 在 `/mcp` 里被手动关闭（本面板无法恢复，需回 `/mcp`）
- `settings.local.json` 不是合法 JSON（此时面板一律拒绝写入）

## 反馈

设置页底部有反馈区，两种方式任选：直接发送（走 CC GUI 的反馈中转），或在浏览器里打开预填好的 GitHub Issue。发送的内容只有正文、插件版本与 CC GUI 版本，不含会话、代码或本机路径。

## 实现

宿主不提供文件系统 API。读写由 `scripts/config-io.mjs` 落盘后经 `exec:node` 执行：

```
main.js 内联 config-io 源码
  → documentStorage.writeTextAtomic("runtime/config-io.mjs", ...)
  → bridge.invoke("plugin_exec_run", { bin: "node", args: [脚本, "scan"|"set"|"probe"|"memory"|"memoryRead", ...] })
  → 脚本读改写 .claude/settings.local.json（或只读地跑一次 claude mcp get），输出 JSON
```

`src/lib/model.mjs` 是纯函数层（状态读写、空键清理、生效态计算），单元测试直接 import。

## 开发

```bash
npm install
npm run build   # 拼单文件 main.js
npm test        # 纯逻辑单测
npm run smoke   # 临时 HOME + 真实落盘脚本，验证读/写/全局不变
npm run validate
npm run check   # 以上全部
```
