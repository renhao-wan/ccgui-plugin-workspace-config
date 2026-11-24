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

## 使用

1. 安装后在右侧面板打开「工作区配置」，它会跟随当前会话的工作区
2. 每项三态：跟随全局 / 启用 / 禁用；技能是五档（跟随 / 启用 / 仅名称 / 仅手动 / 禁用），面板不认识的取值只显示、不写入
3. 中央页签可打开更大的同款视图：左侧导航选类别、右侧看当前类别的完整列表，搜索与「只看本地覆盖」只作用于当前类别
4. 左侧导航最后一项「记忆」可以只读浏览当前工作区的记忆文件：自动记忆（`~/.claude/projects/<slug>/memory/`）、项目 `CLAUDE.md`、个人全局 `CLAUDE.md`。正文按 Markdown 渲染，路径可直接复制去编辑器里改
5. 插件改动点 `/reload-plugins` 生效；MCP 与技能下次会话生效
6. 中央视图里点任意一行，展开「全局 → 团队配置 → 本地 →（审批）→ 最终」的生效链路
7. 中央视图顶部的诊断区会列出残留覆盖、全局启用但未安装、团队层锁死、未批准的 `.mcp.json` server 等问题；残留项可一键清理

## 技能的四态

Claude Code 的 `skillOverrides` 不只有开和关：

| 值 | 对 Claude | 在 `/` 菜单 |
|---|---|---|
| `on`（缺省） | 名称 + 描述 | 可见 |
| `name-only` | 只有名称 | 可见 |
| `user-invocable-only` | 隐藏 | 可见，只能手动调用 |
| `off` | 隐藏 | 隐藏 |

后两档不是「禁用」。面板按原值显示，点「启用」也不会把 `name-only` 改写成 `on`。

## 项目 `.mcp.json` 的审批

`.mcp.json` 里定义的 server 需要批准后才会连接，结果由 Claude Code 写在 `.claude/settings.local.json`（和本插件同一个文件）：

- `enableAllProjectMcpServers: true`：全部批准
- `enabledMcpjsonServers` / `disabledMcpjsonServers`：逐个批准 / 拒绝，拒绝优先

未被三者覆盖时是「待审批」——看起来配了，实际没连。面板把审批和禁用分开显示，待审批的 server 不会显示成生效，诊断区也会提示。开了「全部批准」时单个 server 无法回到待审批，面板会如实说明。

## 诊断

`settings.local.json` 里可能残留指向已卸载插件、已删除技能、已移除 MCP 的键。这些键在列表里看不到（列表只列现存资源），却仍然生效——重新安装同名资源时会突然变成禁用状态。诊断区把它们找出来，并可一键清除。

其他诊断项只提示原因、不提供操作：

- 全局启用但本机未安装
- 团队配置已禁用，MCP 本地无法解除
- 项目技能被同名个人技能遮蔽
- 插件提供的技能不受本地开关控制
- 项目 `.mcp.json` 里定义了、但还没批准（本次会话不会连接）

## 反馈

设置页底部有反馈区，两种方式任选：直接发送（走 CC GUI 的反馈中转），或在浏览器里打开预填好的 GitHub Issue。发送的内容只有正文、插件版本与 CC GUI 版本，不含会话、代码或本机路径。

## 实现

宿主不提供文件系统 API。读写由 `scripts/config-io.mjs` 落盘后经 `exec:node` 执行：

```
main.js 内联 config-io 源码
  → documentStorage.writeTextAtomic("runtime/config-io.mjs", ...)
  → bridge.invoke("plugin_exec_run", { bin: "node", args: [脚本, "scan"|"set", ...] })
  → 脚本读改写 .claude/settings.local.json，输出 JSON
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
