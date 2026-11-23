// 冒烟测试：从构建产物 main.js 里取出内联的 config-io 脚本，落盘后真实执行。
// 用临时 HOME 造一套 ~/.claude fixture，验证 scan / set，并确认全局文件没被改动。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MAIN = path.join(ROOT, "main.js");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wc-smoke-"));
const home = path.join(tmp, "home");
const ws = path.join(tmp, "workspace");
const claude = path.join(home, ".claude");
const pluginDir = path.join(claude, "plugins", "cache", "market", "alpha", "1.0.0");

fs.mkdirSync(path.join(claude, "skills", "personal-skill"), { recursive: true });
fs.mkdirSync(path.join(ws, ".claude", "skills", "project-skill"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, "skills", "alpha-skill"), { recursive: true });
fs.mkdirSync(path.join(claude, "plugins"), { recursive: true });

fs.writeFileSync(path.join(claude, "skills", "personal-skill", "SKILL.md"), "---\nname: personal-skill\n---\n");
fs.writeFileSync(path.join(ws, ".claude", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\n---\n");
fs.writeFileSync(path.join(pluginDir, "skills", "alpha-skill", "SKILL.md"), "---\nname: alpha-skill\n---\n");

const globalSettings = {
  enabledPlugins: { "alpha@market": true, "beta@market": false },
  skillOverrides: { "global-off": "off" },
  deniedMcpServers: [{ serverName: "blocked" }],
};
fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify(globalSettings, null, 2));
fs.writeFileSync(
  path.join(home, ".claude.json"),
  JSON.stringify(
    {
      mcpServers: { tavily: { type: "stdio", command: "tavily" }, blocked: { type: "stdio" } },
      projects: { [ws]: { mcpServers: { "local-one": { type: "stdio" } } } },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(claude, "plugins", "installed_plugins.json"),
  JSON.stringify({ plugins: { "alpha@market": [{ scope: "user", installPath: pluginDir }] } }, null, 2),
);
fs.writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { "proj-one": { type: "stdio" } } }, null, 2));

// 从构建产物里取出 SCAN_SOURCE（build.mjs 用 JSON.stringify 生成，单行字面量）。
const mainText = fs.readFileSync(MAIN, "utf8");
const marker = "const SCAN_SOURCE = ";
const start = mainText.indexOf(marker);
assert.ok(start >= 0, "main.js 里没有 SCAN_SOURCE");
const rest = mainText.slice(start + marker.length);
const end = rest.indexOf(";\n");
assert.ok(end > 0, "SCAN_SOURCE 字面量没有结束");
const scanSource = JSON.parse(rest.slice(0, end));

const script = path.join(tmp, "config-io.mjs");
fs.writeFileSync(script, scanSource);

const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
const run = (args) => {
  const out = execFileSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  return JSON.parse(out);
};

/** 失败路径会以非 0 退出，但仍要能读到那条 JSON。 */
const runSoft = (args) => {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    return JSON.parse(String(err.stdout || "{}"));
  }
};

/* ------------------------------------------------------------ scan */

const first = run(["scan", ws]);
assert.equal(first.ok, true);
assert.equal(first.workspace, ws);

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));

const plugins = byId(first.plugins);
assert.equal(plugins["alpha@market"].installed, true);
assert.equal(plugins["alpha@market"].globalState, "on");
assert.equal(plugins["alpha@market"].projectState, "inherit");
assert.equal(plugins["beta@market"].globalState, "off");
assert.equal(plugins["beta@market"].installed, false);

const mcp = byId(first.mcp);
assert.equal(mcp.tavily.scope, "user");
assert.equal(mcp.tavily.globalState, "on");
assert.equal(mcp["local-one"].scope, "local");
assert.equal(mcp["proj-one"].scope, "project");
assert.equal(mcp.blocked.globalState, "off");
assert.equal(mcp.blocked.canEnable, false);

const skills = first.skills;
const skillByName = (name) => skills.find((s) => s.name === name);
assert.equal(skillByName("personal-skill").source, "personal");
assert.equal(skillByName("personal-skill").controllable, true);
assert.equal(skillByName("project-skill").source, "project");
assert.equal(skillByName("alpha-skill").source, "plugin");
assert.equal(skillByName("alpha-skill").controllable, false);
assert.equal(skillByName("alpha-skill").plugin, "alpha");

/* ------------------------------------------------------------ set */

run(["set", ws, "plugin", "alpha@market", "off"]);
run(["set", ws, "mcp", "tavily", "off"]);
run(["set", ws, "skill", "project-skill", "off"]);

const localPath = path.join(ws, ".claude", "settings.local.json");
const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
assert.equal(local.enabledPlugins["alpha@market"], false);
assert.deepEqual(local.deniedMcpServers, [{ serverName: "tavily" }]);
assert.equal(local.skillOverrides["project-skill"], "off");

// 全局文件必须原样不动
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")), globalSettings);
const globalJson = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
assert.ok(globalJson.mcpServers.tavily, "全局 MCP 配置不能被改");

/* ------------------------------------------------------------ 再 scan */

const second = run(["scan", ws]);
const plugins2 = byId(second.plugins);
assert.equal(plugins2["alpha@market"].projectState, "off");
assert.equal(plugins2["alpha@market"].effectiveState, "off");
const mcp2 = byId(second.mcp);
assert.equal(mcp2.tavily.projectState, "off");
assert.equal(mcp2.tavily.effectiveState, "off");

const skill2 = second.skills.find((s) => s.name === "project-skill");
assert.equal(skill2.projectState, "off");
assert.equal(skill2.effectiveState, "off");

/* ------------------------------------------------------------ 批量 */

run(["setMany", ws, JSON.stringify([
  { kind: "plugin", id: "alpha@market", state: "off" },
  { kind: "plugin", id: "beta@market", state: "off" },
  { kind: "mcp", id: "tavily", state: "off" },
  { kind: "skill", id: "personal-skill", state: "off" },
])]);
const bulk = JSON.parse(fs.readFileSync(localPath, "utf8"));
assert.equal(bulk.enabledPlugins["alpha@market"], false);
assert.equal(bulk.enabledPlugins["beta@market"], false);
assert.deepEqual(bulk.deniedMcpServers, [{ serverName: "tavily" }]);
assert.equal(bulk.skillOverrides["personal-skill"], "off");

// 批量恢复：一条 ops 里混三种类型也要落干净（前面 set 留下的 project-skill 不参与本批）
run(["setMany", ws, JSON.stringify([
  { kind: "plugin", id: "alpha@market", state: "inherit" },
  { kind: "plugin", id: "beta@market", state: "inherit" },
  { kind: "mcp", id: "tavily", state: "inherit" },
  { kind: "skill", id: "personal-skill", state: "inherit" },
])]);
const afterBulk = JSON.parse(fs.readFileSync(localPath, "utf8"));
assert.deepEqual(afterBulk.skillOverrides, { "project-skill": "off" });
assert.equal("enabledPlugins" in afterBulk, false);
assert.equal("deniedMcpServers" in afterBulk, false);

// 批量里的非法项不能静默通过
const bad = runSoft(["setMany", ws, JSON.stringify([{ kind: "mcp", id: "tavily", state: "on" }])]);
assert.equal(bad.ok, false);
assert.match(String(bad.error), /无法显式启用/);

/* ------------------------------------------------------------ 还原 */

run(["set", ws, "plugin", "alpha@market", "inherit"]);
run(["set", ws, "mcp", "tavily", "inherit"]);
run(["set", ws, "skill", "project-skill", "inherit"]);
const restored = JSON.parse(fs.readFileSync(localPath, "utf8"));
assert.deepEqual(restored, {}, "全部改回跟随全局后不应留下空键");

/* ------------------------------------------------------------ 团队层 */

// 仓库里的 .claude/settings.json（团队层）：面板只读，写入永远只落 local。
fs.writeFileSync(
  path.join(ws, ".claude", "settings.json"),
  JSON.stringify({
    enabledPlugins: { "alpha@market": false },
    skillOverrides: { "project-skill": "off" },
    deniedMcpServers: [{ serverName: "proj-one" }],
  }, null, 2),
);

const teamScan = run(["scan", ws]);
const tp = byId(teamScan.plugins);
assert.equal(tp["alpha@market"].localState, "inherit", "localState 不能混进团队层");
assert.equal(tp["alpha@market"].sharedState, "off", "sharedState 要单独反映团队层");
assert.equal(tp["alpha@market"].projectState, "off", "projectState 仍是合并结果");
assert.equal(tp["alpha@market"].effectiveState, "off");
assert.equal(tp["alpha@market"].globalState, "on");

const tm = byId(teamScan.mcp);
assert.equal(tm["proj-one"].localState, "inherit");
assert.equal(tm["proj-one"].sharedState, "off");

const ts = teamScan.skills.find((s) => s.name === "project-skill");
assert.equal(ts.localState, "inherit");
assert.equal(ts.sharedState, "off");

// 插件与技能：local 能压过团队层
run(["set", ws, "plugin", "alpha@market", "on"]);
const overridden2 = byId(run(["scan", ws]).plugins);
assert.equal(overridden2["alpha@market"].localState, "on");
assert.equal(overridden2["alpha@market"].projectState, "on");
assert.equal(overridden2["alpha@market"].effectiveState, "on");

// 清掉 local 覆盖后，团队层重新生效——这正是「跟随」需要显式说明的场景
run(["set", ws, "plugin", "alpha@market", "inherit"]);
const backToTeam = byId(run(["scan", ws]).plugins);
assert.equal(backToTeam["alpha@market"].localState, "inherit");
assert.equal(backToTeam["alpha@market"].effectiveState, "off");

/* ------------------------------------------------------------ UI 渲染 */

// 真实渲染面板与中央页签：未定义变量、组件调用写错这类问题只有渲染时才暴露。
// exec 仍然打真实子进程，所以这一段的断言同时覆盖「扫描结果 → 界面」这条链路。
{
  const { createFakeReact, textOf, findAll } = await import(
    "ccgui-plugin-shared/fake-react"
  );
  const byClassAll = (node, cls) => findAll(node, (n) => {
    const c = n && n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes(cls);
  });
  const R = createFakeReact({ componentName: "WorkspaceConfig" });

  const registered = {};
  const disposers = [];
  const ctx = {
    react: R.api,
    pluginId: MANIFEST.id,
    version: MANIFEST.version,
    theme: { injectCss: () => {}, setTokens: () => {} },
    storage: {
      _data: {},
      async get(k) { return this._data[k]; },
      async set(k, v) { this._data[k] = v; },
      async delete(k) { delete this._data[k]; },
    },
    documentStorage: {
      async readText() { return null; },
      async writeTextAtomic() { return { version: "1" }; },
      async getLocation() { return { kind: "data", path: path.dirname(script) }; },
    },
    bridge: {
      async invoke(_cmd, args) {
        const out = execFileSync(process.execPath, [script, ...args.args.slice(1)], { env, encoding: "utf8" });
        return { code: 0, stdout: out, stderr: "" };
      },
    },
    workspaces: { async list() { return [{ id: "w1", kind: "workspace", path: ws }]; } },
    ui: {
      registerPanelTab(def) { registered.panel = def; return () => {}; },
      registerCenterTab(def) { registered.center = def; return () => {}; },
      registerSidebarNav(def) { registered.sidebar = def; return () => {}; },
      registerCommand(def) { registered.command = def; return () => {}; },
      registerSettingsSection(def) { registered.settings = def; return () => {}; },
      openCenterTab() {},
    },
  };

  const mod = await import(pathToFileURL(MAIN).href);
  const dispose = mod.default(ctx);
  disposers.push(dispose);

  assert.ok(registered.panel, "没有注册右侧面板");
  assert.ok(registered.center, "没有注册中央页签");
  assert.ok(registered.sidebar, "没有注册侧栏入口");
  assert.ok(registered.command, "没有注册命令面板入口");
  assert.ok(registered.settings, "没有注册设置页");

  // 右侧面板：跟随 workspacePath，应当渲染出当前工作区的三类资源。
  const Panel = registered.panel.component;
  let tree = R.renderFresh(Panel, { workspacePath: ws }, { effects: true });
  for (let i = 0; i < 40; i++) {
    if (byClassAll(tree, "wc-empty").length === 0 && byClassAll(tree, "wc-row").length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
    tree = R.renderKeep(Panel, { workspacePath: ws });
  }
  const panelText = textOf(tree);
  assert.ok(byClassAll(tree, "wc-row").length > 0, "右侧面板没有渲染出任何资源行");
  assert.ok(!panelText.includes("undefined"), "右侧面板文案里出现了 undefined");
  assert.match(panelText, /插件/);
  assert.match(panelText, /MCP/);
  assert.match(panelText, /技能/);
  // 团队层有显式值时：meta 要标出来源，按钮要改口「跟随团队」，不能装作在跟随全局。
  assert.match(panelText, /团队禁用/, "团队层禁用没有在面板上标出");
  assert.match(panelText, /跟随团队/, "团队层有值时「跟随」按钮文案应变成跟随团队");
  assert.ok(!/跟随全局/.test(panelText), "团队层有值时仍显示「跟随全局」会误导");

  // 中央页签：先在面板里拿到工作区，再渲染大屏。
  const Center = registered.center.component;
  let centerTree = R.renderFresh(Center, {}, { effects: true });
  for (let i = 0; i < 40; i++) {
    const picks = byClassAll(centerTree, "wc-pick");
    if (picks.length > 0) {
      picks[0].props.onClick();
      centerTree = R.renderKeep(Center, {});
      continue;
    }
    if (byClassAll(centerTree, "wc-nav-item").length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
    centerTree = R.renderKeep(Center, {});
  }
  const centerText = textOf(centerTree);
  assert.ok(byClassAll(centerTree, "wc-nav-item").length === 3, "中央页签没有渲染出三个类别导航");
  assert.ok(!centerText.includes("undefined"), "中央页签文案里出现了 undefined");

  // 设置页：勾选后应写入 storage。
  const Settings = registered.settings.component;
  let settingsTree = R.renderFresh(Settings, {}, { effects: true });
  const box = findAll(settingsTree, (n) => n && n.type === "input")[0];
  assert.ok(box, "设置页没有渲染出开关");
  box.props.onChange({ target: { checked: true } });
  settingsTree = R.renderKeep(Settings, {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.storage._data["workspace-config.settings.v1"]?.showDesc, true, "设置没有写入 storage");

  dispose();
  console.log("UI_OK panel/center/settings 渲染通过");
}

console.log("SMOKE_OK checks=59");
console.log("main.js", fs.statSync(MAIN).size, "bytes; manifest", MANIFEST.id);
