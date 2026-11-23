# 工作区配置 workspace-config

CC GUI 插件。把「当前工作区」的 Claude Code 配置收进一个面板：MCP、插件、技能各一个三态开关。

## 为什么需要它

CC GUI 和 CC Switch 管理的是**全局**配置——写 `~/.claude/settings.json` 和 `~/.claude.json`。Claude Code 本身支持项目级覆盖，但散落在三个不同的键里，没有统一入口：

| 资源 | 项目级键 | 默认 | 项目级能做什么 |
|---|---|---|---|
| 插件 | `enabledPlugins` | 跟随全局 | 在本项目启用 / 禁用 |
| MCP | `deniedMcpServers` | 跟随全局 | 在本项目屏蔽（不能解除全局的禁用） |
| 技能 | `skillOverrides` | 跟随全局 | 在本项目启用 / 禁用；插件提供的技能除外 |

这个插件只做这三件事，不新增、不删除资源。

## 边界

- **只写** `<workspace>/.claude/settings.local.json`，从不修改全局文件
- 新工作区不写任何键，自然继承全局（也就是 CC Switch 配的那套）
- 插件提供的技能由插件控制，面板只显示来源，请到插件栏关闭整个插件

## 使用

1. 安装后在右侧面板打开「工作区配置」，它会跟随当前会话的工作区
2. 每项三态：跟随全局 / 启用 / 禁用
3. 中央页签可打开更大的同款视图
4. 插件改动点 `/reload-plugins` 生效；MCP 与技能下次会话生效

## 实现

宿主不提供文件系统 API。读写由 `scripts/config-io.mjs` 落盘后经 `exec:node` 执行：

```
main.js 内联 config-io 源码
  → documentStorage.writeTextAtomic("runtime/config-io.mjs", ...)
  → bridge.invoke("plugin_exec_run", { bin: "node", args: [脚本, "scan"|"set", ...] })
  → 脚本读改写 .claude/settings.local.json，输出 JSON
```

`src/lib/model.mjs` 是纯函数层（三态读写、空键清理、生效态计算），单元测试直接 import。

## 开发

```bash
npm install
npm run build   # 拼单文件 main.js
npm test        # 纯逻辑单测
npm run smoke   # 临时 HOME + 真实落盘脚本，验证读/写/全局不变
npm run validate
npm run check   # 以上全部
```
