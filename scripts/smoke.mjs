// 冒烟测试：从构建产物 main.js 里取出内联的 config-io 脚本，落盘后真实执行。
// 用临时 HOME 造一套 ~/.claude fixture，验证 scan / set，并确认全局文件没被改动。
import nodeAssert from "node:assert/strict";

// 计数包装：原来的 checks 是手写死的数字，加断言时总会忘记同步，
// 报出来的数就不代表实际覆盖了。这里按调用次数统计。
let checks = 0;
const assert = new Proxy(nodeAssert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value !== "function") return value;
    return (...args) => {
      checks += 1;
      return value.apply(target, args);
    };
  },
});
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
// 目录名与 frontmatter 的 name 故意不一致：技能名以 frontmatter 为准，
// 目录名只是回落。用目录名当键写 skillOverrides，Claude Code 不会认。
fs.mkdirSync(path.join(ws, ".claude", "skills", "dir-name-mismatch"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, "skills", "alpha-skill"), { recursive: true });
fs.mkdirSync(path.join(claude, "plugins"), { recursive: true });

fs.writeFileSync(path.join(claude, "skills", "personal-skill", "SKILL.md"), "---\nname: personal-skill\n---\n");
fs.writeFileSync(path.join(ws, ".claude", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\n---\n");
fs.writeFileSync(
  path.join(ws, ".claude", "skills", "dir-name-mismatch", "SKILL.md"),
  "---\nname: real-skill-name\ndescription: 目录名与 name 不一致\n---\n",
);
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
      // 主 fixture 测的是审批流程本身，工作区按已信任处理；
      // 未信任那条线在下面「信任层与 /mcp 开关」单独造。
      projects: { [ws]: { mcpServers: { "local-one": { type: "stdio" } }, hasTrustDialogAccepted: true } },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(claude, "plugins", "installed_plugins.json"),
  JSON.stringify({ plugins: { "alpha@market": [{ scope: "user", installPath: pluginDir }] } }, null, 2),
);
fs.writeFileSync(
  path.join(ws, ".mcp.json"),
  JSON.stringify({ mcpServers: { "proj-one": { type: "stdio" } } }, null, 2),
);

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

// 冒烟全程只碰临时 HOME。如果外层 shell 设了 CLAUDE_CONFIG_DIR，
// 脚本会去读真实配置目录——这里必须清掉，后面单独造一个 fixture 测它。
const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
delete env.CLAUDE_CONFIG_DIR;
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
// 技能名取 frontmatter 的 name，目录名只作展示与回落。
assert.ok(skills.some((s) => s.name === "real-skill-name"), "技能名应取 frontmatter 的 name");
assert.equal(skills.some((s) => s.name === "dir-name-mismatch"), false, "目录名不该当技能名");
assert.equal(skillByName("real-skill-name").dirName, "dir-name-mismatch", "行里要带上目录名以便定位");

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

/* ------------------------------------------------------------ 技能四态 & .mcp.json 审批 */

// 技能官方是四态：只把值原样读出，不能把 name-only 折成 on。
run(["set", ws, "skill", "project-skill", "name-only"]);
let s4 = run(["scan", ws]).skills.find((s) => s.name === "project-skill");
assert.equal(s4.localState, "name-only", "name-only 不能被读成 on");
assert.equal(s4.effectiveState, "name-only");

run(["set", ws, "skill", "project-skill", "user-invocable-only"]);
s4 = run(["scan", ws]).skills.find((s) => s.name === "project-skill");
assert.equal(s4.localState, "user-invocable-only");
assert.equal(s4.effectiveState, "user-invocable-only");
run(["set", ws, "skill", "project-skill", "inherit"]);

// 项目 .mcp.json 里的 server 默认是「待批准」：没连上，不能显示成生效。
const appr0 = byId(run(["scan", ws]).mcp)["proj-one"];
assert.equal(appr0.projectDefined, true);
assert.equal(appr0.approval, "pending");
assert.equal(appr0.effectiveState, "off", "待审批的 server 不该显示成生效");
assert.equal(mcp.tavily.approval, null, "user 来源的 server 不参与 .mcp.json 审批");
const pendingDiag = run(["scan", ws]).diagnostics.find((d) => d.kind === "mcp" && d.id === "proj-one");
assert.equal(pendingDiag.level, "warn");
assert.equal(pendingDiag.fixable, false);

// 逐个批准 → 连接
const approvedRes = run(["set", ws, "mcpApproval", "proj-one", "approved"]);
assert.equal(approvedRes.effective, "approved");
assert.deepEqual(JSON.parse(fs.readFileSync(localPath, "utf8")).enabledMcpjsonServers, ["proj-one"]);
let apprRow = byId(run(["scan", ws]).mcp)["proj-one"];
assert.equal(apprRow.approval, "approved");
assert.equal(apprRow.effectiveState, "on");

// 拒绝优先于「全部批准」，且写进 disabled 名单
run(["set", ws, "mcpApproval", "proj-one", "rejected"]);
apprRow = byId(run(["scan", ws]).mcp)["proj-one"];
assert.equal(apprRow.approval, "rejected");
assert.equal(apprRow.effectiveState, "off");
assert.deepEqual(JSON.parse(fs.readFileSync(localPath, "utf8")).disabledMcpjsonServers, ["proj-one"]);

// 回到待批准：两个名单都清掉，空数组不落盘
run(["set", ws, "mcpApproval", "proj-one", "pending"]);
assert.deepEqual(JSON.parse(fs.readFileSync(localPath, "utf8")), {}, "审批名单清空后不该留下空数组");
assert.equal(byId(run(["scan", ws]).mcp)["proj-one"].approval, "pending");

// 总开关开着时单个「待批准」做不到，写入要如实回报生效值
fs.writeFileSync(localPath, JSON.stringify({ enableAllProjectMcpServers: true }, null, 2));
apprRow = byId(run(["scan", ws]).mcp)["proj-one"];
assert.equal(apprRow.approval, "approved");
assert.equal(apprRow.allApproved, true);
assert.equal(run(["set", ws, "mcpApproval", "proj-one", "pending"]).effective, "approved");
assert.equal(
  JSON.parse(fs.readFileSync(localPath, "utf8")).enableAllProjectMcpServers,
  true,
  "单个审批不能顺带改总开关",
);
fs.writeFileSync(localPath, "{}");

/* ------------------------------------------------------------ 坏文件与审批残留 */

// 项目的 settings.local.json 里住着用户手写的 permissions / hooks / env。
// 解析失败时绝不能当成空对象写回，否则点一下开关就把整份配置清空。
{
  const brokenPath = path.join(tmp, "broken-ws");
  fs.mkdirSync(path.join(brokenPath, ".claude"), { recursive: true });
  const brokenBody = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n}\n';
  fs.writeFileSync(path.join(brokenPath, ".claude", "settings.local.json"), brokenBody);

  const brokenScan = run(["scan", brokenPath]);
  const fileDiag = brokenScan.diagnostics.find((d) => d.kind === "file");
  assert.equal(fileDiag.level, "error", "坏掉的配置文件必须报 error");
  assert.equal(fileDiag.fixable, false, "坏文件不能靠一键清理解决");
  assert.match(fileDiag.message, /JSON/);

  const brokenSet = runSoft(["set", brokenPath, "skill", "x", "off"]);
  assert.equal(brokenSet.ok, false, "配置不是合法 JSON 时必须拒绝写入");
  assert.match(String(brokenSet.error), /避免覆盖/);
  assert.equal(
    fs.readFileSync(path.join(brokenPath, ".claude", "settings.local.json"), "utf8"),
    brokenBody,
    "拒绝写入后原文件必须一字不改",
  );

  // 空文件视作「还没配置」：可以正常写，不算坏文件。
  const emptyWs = path.join(tmp, "empty-ws");
  fs.mkdirSync(path.join(emptyWs, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(emptyWs, ".claude", "settings.local.json"), "  \n");
  assert.equal(run(["scan", emptyWs]).diagnostics.some((d) => d.kind === "file"), false, "空文件不该算坏文件");
  assert.equal(run(["set", emptyWs, "skill", "x", "off"]).ok, true, "空文件应能正常写入");
}

// CLAUDE_CONFIG_DIR 一旦设置，Claude Code 会把 settings.json / .claude.json /
// plugins / projects 全搬过去。插件必须跟着走，否则会读成「什么都没配」。
{
  const cfgDir = path.join(tmp, "custom-config");
  const cfgHome = path.join(tmp, "custom-home");
  fs.mkdirSync(path.join(cfgDir, "plugins", "cache", "m", "p", "1.0.0"), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, "skills", "cfg-skill"), { recursive: true });
  fs.mkdirSync(cfgHome, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "cfg@m": true }, skillOverrides: { "cfg-skill": "name-only" } }),
  );
  fs.writeFileSync(
    path.join(cfgDir, ".claude.json"),
    JSON.stringify({ mcpServers: { "cfg-mcp": { command: "x" } } }),
  );
  fs.writeFileSync(path.join(cfgDir, "skills", "cfg-skill", "SKILL.md"), "---\nname: cfg-skill\n---\n");
  const cfgWs = path.join(tmp, "cfg-ws");
  fs.mkdirSync(cfgWs, { recursive: true });

  const cfgEnv = Object.assign({}, env, { CLAUDE_CONFIG_DIR: cfgDir });
  const cfgScan = JSON.parse(execFileSync(process.execPath, [script, "scan", cfgWs], {
    env: cfgEnv, encoding: "utf8",
  }));
  assert.ok(cfgScan.mcp.some((r) => r.id === "cfg-mcp"), "CLAUDE_CONFIG_DIR 下的 MCP 应该被读到");
  assert.ok(cfgScan.plugins.some((r) => r.id === "cfg@m"), "CLAUDE_CONFIG_DIR 下的插件应该被读到");
  const cfgSkill = cfgScan.skills.find((r) => r.name === "cfg-skill");
  assert.equal(cfgSkill.globalState, "name-only", "CLAUDE_CONFIG_DIR 下的 skillOverrides 应该按四态读出");

  // 记忆浏览同样要跟着走：全局 CLAUDE.md 与自动记忆目录都在 CONFIG_DIR 里。
  fs.writeFileSync(path.join(cfgDir, "CLAUDE.md"), "# 自定义目录的全局说明\n");
  const cfgMem = JSON.parse(execFileSync(process.execPath, [script, "memory", cfgWs], {
    env: cfgEnv, encoding: "utf8",
  }));
  assert.ok(cfgMem.files.some((f) => f.source === "user"), "CLAUDE_CONFIG_DIR 下的全局 CLAUDE.md 应被列出");
  assert.equal(cfgMem.slug, cfgWs.replace(/[^a-zA-Z0-9]/g, "-"));
}

// 审批名单同样会留残留：.mcp.json 里删掉的 server 还占着名单，
// 重装同名 server 时会突然被自动批准/拒绝。这类项必须能被诊断出来并清掉。
{
  const staleWs = path.join(tmp, "stale-approval-ws");
  fs.mkdirSync(path.join(staleWs, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(staleWs, ".mcp.json"), JSON.stringify({
    mcpServers: { present: { command: "x" } },
  }));
  const stalePath = path.join(staleWs, ".claude", "settings.local.json");
  fs.writeFileSync(stalePath, JSON.stringify({
    enabledMcpjsonServers: ["ghost-a", "present"],
    disabledMcpjsonServers: ["ghost-b"],
  }));

  const staleScan = run(["scan", staleWs]);
  const staleRows = staleScan.diagnostics.filter((d) => d.kind === "mcpApproval");
  assert.equal(staleRows.length, 2, "两个残留的审批记录都要被识别");
  assert.ok(staleRows.every((d) => d.level === "stale" && d.fixable), "审批残留应可清理");
  assert.deepEqual(staleRows.map((d) => d.id).sort(), ["ghost-a", "ghost-b"]);
  assert.equal(
    staleScan.diagnostics.some((d) => d.kind === "mcpApproval" && d.id === "present"),
    false,
    "仍存在的 server 不该被当成残留",
  );

  // 清理走的是诊断区统一的 inherit → 对审批等价于「回到待审批」。
  run(["setMany", staleWs, JSON.stringify(
    staleRows.map((d) => ({ kind: d.kind, id: d.id, state: "inherit" })),
  )]);
  const afterStale = JSON.parse(fs.readFileSync(stalePath, "utf8"));
  assert.deepEqual(afterStale.enabledMcpjsonServers, ["present"], "只清残留，保留仍有效的批准");
  assert.equal("disabledMcpjsonServers" in afterStale, false, "清空后不留空数组");
  assert.equal(run(["scan", staleWs]).diagnostics.filter((d) => d.kind === "mcpApproval").length, 0);
}

/* ------------------------------------------------------------ 信任层与 /mcp 开关 */

// 2026-11-24 用 claude 2.1.319 实测：工作区没被信任时，「批准」一律不生效
// （仍是 Pending），而「拒绝」照旧生效；/mcp 里关掉的 server 记在
// ~/.claude.json 的项目条目 disabledMcpServers 里，同样需要信任才生效。
// 面板若只看审批名单，就会在这些情况下显示假绿点。
{
  const claudeJsonPath = path.join(home, ".claude.json");
  const trustWs = path.join(tmp, "trust-ws");
  fs.mkdirSync(path.join(trustWs, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(trustWs, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "approved-untrusted": { command: "x" },
      "approved-trusted": { command: "x" },
      "rejected-untrusted": { command: "x" },
      "pending-any": { command: "x" },
      "runtime-off": { command: "x" },
    },
  }));
  fs.writeFileSync(path.join(trustWs, ".claude", "settings.local.json"), JSON.stringify({
    enabledMcpjsonServers: ["approved-untrusted", "approved-trusted", "runtime-off"],
    disabledMcpjsonServers: ["rejected-untrusted"],
  }));

  const writeGlobalJson = (projectPatch) => {
    const doc = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    doc.projects = doc.projects || {};
    doc.projects[trustWs] = Object.assign({ mcpServers: {} }, doc.projects[trustWs], projectPatch);
    fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2));
  };

  // 未信任：已批准仍算卡在 untrusted，已拒绝不受影响。
  writeGlobalJson({ hasTrustDialogAccepted: false });
  const untrusted = byId(run(["scan", trustWs]).mcp);
  assert.equal(untrusted["approved-untrusted"].approval, "approved");
  assert.equal(untrusted["approved-untrusted"].blocked, "untrusted", "未信任时批准不生效");
  assert.equal(untrusted["approved-untrusted"].effectiveState, "off", "卡住的 server 不能显示成生效");
  assert.equal(untrusted["rejected-untrusted"].blocked, "rejected", "拒绝不需要信任");
  assert.equal(untrusted["pending-any"].blocked, "pending");
  assert.equal(run(["scan", trustWs]).workspaceTrusted, false);
  assert.ok(
    run(["scan", trustWs]).diagnostics.some((d) => d.kind === "mcp" && d.id === "approved-untrusted"
      && /信任/.test(d.message)),
    "已批准但未信任要有一条 warn 诊断",
  );
  // 多条 projectDefined 时只汇总一条工作区级 info，不逐条刷屏。
  const wsTrustDiag = run(["scan", trustWs]).diagnostics.filter(
    (d) => d.kind === "workspace" && /尚未被信任/.test(d.message),
  );
  assert.equal(wsTrustDiag.length, 1);

  // 已信任：批准生效；/mcp 关掉的接上第三根轴。
  writeGlobalJson({ hasTrustDialogAccepted: true, disabledMcpServers: ["runtime-off"] });
  const trustedScan = run(["scan", trustWs]);
  const trusted = byId(trustedScan.mcp);
  assert.equal(trustedScan.workspaceTrusted, true);
  assert.equal(trusted["approved-trusted"].blocked, null, "已信任 + 已批准应连上");
  assert.equal(trusted["approved-trusted"].effectiveState, "on");
  assert.equal(trusted["runtime-off"].blocked, "runtime-disabled", "/mcp 手动关闭要被识别");
  assert.equal(trusted["runtime-off"].effectiveState, "off");
  assert.ok(
    trustedScan.diagnostics.some((d) => d.kind === "mcp" && d.id === "runtime-off" && /mcp/i.test(d.message)),
    "/mcp 关闭要有一条 warn 诊断",
  );
  assert.equal(
    trustedScan.diagnostics.some((d) => d.kind === "workspace" && /尚未被信任/.test(d.message)),
    false,
    "已信任时不该再有未信任汇总诊断",
  );

  // 全局禁用优先于一切：未信任 + 已拒绝也还是全局禁用。
  const deniedScan = byId(run(["scan", ws]).mcp);
  assert.equal(deniedScan.blocked.blocked, "global-denied");
  assert.equal(deniedScan.blocked.effectiveState, "off");
}

/* ------------------------------------------------------------ MCP 连接自检 */

// 自检要真的调 `claude mcp get`，那既慢又会启动 server。冒烟用一个假 CLI
// 顶替：真实 PATH 上放一个可执行脚本，按 server 名吐出 Claude Code 的固定输出。
// 这样测的是「解析 + 状态映射」这段逻辑，而不是 Claude Code 本身。
{
  const probeWs = path.join(tmp, "probe-ws");
  const fakeBin = path.join(tmp, "fake-bin");
  fs.mkdirSync(path.join(probeWs, ".claude"), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  // 假 claude：根据最后一个参数决定输出，覆盖四种状态 + 一种无法识别。
  const fakeSrc = [
    "#!/usr/bin/env node",
    "const name = process.argv[process.argv.length - 1];",
    "const table = {",
    '  ok: "  Status: ✔ Connected",',
    '  broken: "  Status: ✘ Failed to connect\\n  Issue: CONNECTION_CLOSED: Connection closed",',
    '  waiting: "  Status: ⏸ Pending approval (run `claude` to approve)",',
    '  off: "  Status: ⊘ Disabled for this project (re-enable via /mcp)",',
    '  weird: "  Status: ⚠ Something new",',
    "};",
    "if (!(name in table)) { process.stderr.write('No MCP server found'); process.exit(1); }",
    "process.stdout.write('Some server:\\n' + table[name] + '\\n');",
  ].join("\n");
  const fakePath = path.join(fakeBin, "claude");
  fs.writeFileSync(fakePath, fakeSrc, { mode: 0o755 });

  // Windows 上 shell 找的是 .cmd；两种都放，跨平台都能跑。
  fs.writeFileSync(path.join(fakeBin, "claude.cmd"), '@echo off\r\nnode "%~dp0claude" %*\r\n');

  const probeEnv = Object.assign({}, env, {
    PATH: fakeBin + path.delimiter + env.PATH,
  });
  const probeRun = (name) => {
    const out = execFileSync(process.execPath, [script, "probe", probeWs, name], {
      env: probeEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  };

  assert.equal(probeRun("ok").status, "connected");
  const broken = probeRun("broken");
  assert.equal(broken.status, "failed");
  assert.match(broken.detail, /CONNECTION_CLOSED/, "失败原因要原样带出来");
  assert.equal(probeRun("waiting").status, "pending");
  assert.equal(probeRun("off").status, "disabled");
  // 认不出的状态不能冒充成功。
  assert.equal(probeRun("weird").status, "unknown");

  // 名字来自 .mcp.json 的键，会被拼进 shell 命令——必须挡住能改写命令的字符。
  for (const bad of ["a b", "x; calc.exe", "$(id)", "a|b", "a>b", "`id`", "a&b", "..", "."]) {
    const res = runSoft(["probe", probeWs, bad]);
    assert.equal(res.ok, false, "危险名字必须被拒绝：" + JSON.stringify(bad));
    assert.match(String(res.error), /无法安全传给命令行|不合法/, "拒绝理由要说清楚：" + JSON.stringify(bad));
  }
  // 正常名字（含 scoped 包常见的 @ / : / . 与路径分隔）不能被误伤。
  for (const good of ["tavily", "@scope/pkg", "a:b", "a.b", "a/b", "a-b_c"]) {
    assert.doesNotThrow(() => probeRun(good), "合法名字被误拒：" + good);
  }
}


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

/* ------------------------------------------------------------ 诊断 */

// local 里指向已消失资源的键：列表只列现存资源，所以它们只能靠诊断区发现。
fs.writeFileSync(localPath, JSON.stringify({
  enabledPlugins: { "ghost@market": false },
  skillOverrides: { "ghost-skill": "off" },
  deniedMcpServers: [{ serverName: "ghost-mcp" }],
}, null, 2));

const diagScan = run(["scan", ws]);
const stale = diagScan.diagnostics.filter((d) => d.level === "stale");
assert.equal(stale.length, 3, "三条残留都要被识别");
assert.ok(stale.every((d) => d.fixable), "残留项必须可清理");
assert.equal(diagScan.plugins.some((x) => x.id === "ghost@market"), false, "残留插件不该出现在列表");
assert.equal(diagScan.skills.some((x) => x.name === "ghost-skill"), false, "残留技能不该出现在列表");
assert.equal(diagScan.mcp.some((x) => x.id === "ghost-mcp"), false, "残留 MCP 不该出现在列表");

// 清理走的是界面「清理残留」同一个入口：setMany + inherit
run(["setMany", ws, JSON.stringify(
  diagScan.diagnostics.filter((d) => d.fixable).map((d) => ({ kind: d.kind, id: d.id, state: "inherit" })),
)]);
const afterClean = JSON.parse(fs.readFileSync(localPath, "utf8"));
assert.deepEqual(afterClean, {}, "清理后不应留下空键");
assert.equal(run(["scan", ws]).diagnostics.filter((d) => d.level === "stale").length, 0);

/* ------------------------------------------------------------ 记忆（只读） */

// 自动记忆目录按 slug 定位：工作区路径里的非字母数字全部变 -。
// 这里造一份与登记路径对应的 fixture，验证列表、正文与「不可读外部文件」。
const slug = ws.replace(/[^a-zA-Z0-9]/g, "-");
const memDir = path.join(claude, "projects", slug, "memory");
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(
  path.join(memDir, "MEMORY.md"),
  "# 索引\n\n- [a](alpha-note.md) — 第一条\n",
);
fs.writeFileSync(
  path.join(memDir, "alpha-note.md"),
  "---\nname: alpha-note\ndescription: 一条测试记忆\n---\n\n## 小标题\n\n正文 **加粗** 与 `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
);
fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# 项目说明\n\n只有一行。\n");
fs.writeFileSync(path.join(claude, "CLAUDE.md"), "# 全局说明\n");

const mem = run(["memory", ws]);
assert.equal(mem.ok, true);
assert.equal(mem.slug, slug, "记忆目录 slug 应由工作区路径逐字派生");
const memSources = mem.files.map((f) => f.source + ":" + f.name);
assert.ok(memSources.includes("auto:MEMORY.md"), "自动记忆的 MEMORY.md 应被列出");
assert.ok(memSources.includes("auto:alpha-note.md"), "自动记忆正文文件应被列出");
assert.ok(memSources.includes("project:CLAUDE.md"), "工作区 CLAUDE.md 应被列为项目记忆");
assert.ok(memSources.includes("user:CLAUDE.md"), "全局 CLAUDE.md 应被列为个人记忆");
assert.equal(mem.files[0].name, "MEMORY.md", "自动记忆的索引文件应排在第一位");
const noteEntry = mem.files.find((f) => f.name === "alpha-note.md");
assert.equal(noteEntry.title, "alpha-note", "标题应取一级标题或 frontmatter 的 name");
assert.equal(noteEntry.description, "一条测试记忆", "描述应取自 frontmatter");
assert.ok(noteEntry.mtime > 0, "记忆文件要带修改时间");

const noteRead = run(["memoryRead", ws, noteEntry.path]);
assert.equal(noteRead.ok, true);
assert.match(noteRead.file.content, /正文/, "读取应返回文件正文");
assert.equal(noteRead.file.truncated, false);
assert.equal(noteRead.file.title, "alpha-note");
assert.equal(noteRead.file.size, noteEntry.size, "正文里的 size 与列表口径必须一致");

// 白名单之外的文件不能被读：这个动作不能变成任意文件读取通道。
const outside = runSoft(["memoryRead", ws, path.join(claude, "settings.json")]);
assert.equal(outside.ok, false, "白名单外的文件必须拒绝读取");

// 没有自动记忆的工作区：列表为空但不报错。
const bareWs = path.join(tmp, "bare-workspace");
fs.mkdirSync(bareWs, { recursive: true });
const bareMem = run(["memory", bareWs]);
assert.equal(bareMem.ok, true);
assert.equal(bareMem.files.some((f) => f.source === "auto"), false, "没有自动记忆时不应编造条目");

/* ------------------------------------------------------------ UI 渲染 */

// UI 段之前留一条有效覆盖：导航的「覆盖数」徽标需要有真实数据才测得出来。
// 放在这里而不是 UI 段内部，是因为 Panel 与 Center 共用同一个 store，
// Center 打开时不会重新扫描，中途改文件不会被看到。
// proj-one 显式批准：否则「待批准」会产出一条诊断，后面验不了「无诊断时整块不渲染」。
// project-skill 用 name-only：验证四态在界面上按原值显示，而不是被折成「启用」。
fs.writeFileSync(localPath, JSON.stringify({
  enabledPlugins: { "alpha@market": false },
  enabledMcpjsonServers: ["proj-one"],
  skillOverrides: { "project-skill": "name-only" },
}, null, 2));

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
  // 宿主当前会话的工作区。初始为空表示「宿主还没准备好」，插件不该据此清空视图。
  const host = { path: "" };
  // 捕获注入的样式，用来断言 Toast 的底色与原生控件的替身。
  let capturedCss = "";
  const ctx = {
    react: R.api,
    pluginId: MANIFEST.id,
    version: MANIFEST.version,
    theme: {
      injectCss(css) { if (typeof css === "string" && css.includes("wc-toast")) capturedCss = css; },
      setTokens: () => {},
    },
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
      async invoke(cmd, args) {
        // 反馈区挂载时会查一次额度；冒烟不联网，给一个固定额度。
        if (cmd === "plugin_http_request") {
          return { status: 200, body: JSON.stringify({ remaining: 1, dailyLimit: 1, fallbackRemaining: 2 }) };
        }
        const out = execFileSync(process.execPath, [script, ...args.args.slice(1)], { env, encoding: "utf8" });
        return { code: 0, stdout: out, stderr: "" };
      },
    },
    workspaces: { async list() { return [{ id: "w1", kind: "workspace", path: ws }]; } },
    // 宿主的工作区元数据：CC GUI 用它表示「当前会话所在目录」。
    workspace: { async getMetadata() { return host.path ? { path: host.path } : null; } },
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

  // 操作后的提示必须有不透明底色：半透明会叠在下面的列表文字上，读不清。
  const toastRule = (capturedCss.match(/\.wc-toast-line\s*\{[^}]*\}/) || [""])[0];
  assert.ok(toastRule, "样式里找不到 .wc-toast-line");
  assert.match(toastRule, /background:\s*var\(--color-background-primary-default/,
    "Toast 必须用宿主主题色做实底，不能是半透明");
  assert.equal(toastRule.includes("rgba(127,127,127,.16)"), false,
    "Toast 不能再用半透明灰底");

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
  assert.match(panelText, /诊断/, "右侧面板没有提示诊断入口");

  // 切页签要回到顶部：停在上一类的滚动位置会让人以为「点了没反应」。
  // 假 React 不绑真实 DOM，只能把 ref.current 换成一个能记 scrollTop 的对象，
  // 再触发一次依赖变化，验证 effect 真的把它归零。
  // 必须放在渲染 Center 之前：Center 的 renderFresh 会换掉整组 refs，
  // Panel 持有的 ref 对象会被作废（这是模拟层限制，不是产品问题）。
  {
    const scrollerNow = byClassAll(tree, "wc-scroll")[0];
    const scrollRefObj = scrollerNow && scrollerNow.props && scrollerNow.props.ref;
    assert.ok(scrollRefObj && typeof scrollRefObj === "object", "滚动容器没有挂 ref，切页签无法归顶");
    scrollRefObj.current = { scrollTop: 999 };
    const tabButtons = byClassAll(tree, "wc-tab");
    assert.ok(tabButtons.length >= 2, "页内页签数量不足，无法验证切换归顶");
    tabButtons[1].props.onClick();
    tree = R.renderKeep(Panel, { workspacePath: ws });
    const refAfter = byClassAll(tree, "wc-scroll")[0].props.ref;
    assert.equal(refAfter.current.scrollTop, 0, "切换页内页签后没有回到顶部");
    assert.ok(byClassAll(tree, "wc-tab").length === 3, "切换页签后页签条不完整");

    // 侧栏宽度不够摆五档：技能要用下拉，且当前值要落在 name-only 上。
    byClassAll(tree, "wc-tab")[2].props.onClick();
    tree = R.renderKeep(Panel, { workspacePath: ws });
    const skillRowPanel = byClassAll(tree, "wc-row").find((n) => textOf(n).includes("project-skill"));
    assert.ok(skillRowPanel, "侧栏技能列表缺少 project-skill");
    // 类名由共用包 ccgui-plugin-shared/dropdown 固定为 wc-dd-*，
    // 本插件只负责配色；这里断言的是库的契约，改名必须同步改这里。
    const selects = byClassAll(skillRowPanel, "wc-dd-trigger");
    assert.equal(selects.length, 1, "侧栏技能应渲染成一个下拉而不是五个按钮");
    assert.equal(byClassAll(skillRowPanel, "wc-seg").length, 0, "侧栏技能不该同时渲染按钮组");
    // 必须是自绘下拉：原生 <select> 在 Windows 上会露出系统控件的外观。
    assert.equal(selects[0].type, "button", "侧栏下拉必须是自绘按钮，不能是原生 select");
    assert.equal(findAll(skillRowPanel, (n) => n && n.type === "select").length, 0,
      "侧栏不允许出现原生 <select> 控件");
    assert.equal(textOf(selects[0]), "仅名称", "侧栏下拉的当前值应与文件里的 name-only 一致");
    // 旧实现只挂鼠标事件，键盘完全不可用。键盘处理必须挂在容器上——
    // 菜单打开后焦点在 option 里，事件靠冒泡上来；挂 trigger 上的话方向键会失灵。
    const ddBox = byClassAll(skillRowPanel, "wc-dd")[0];
    assert.ok(ddBox, "侧栏技能缺少下拉容器");
    assert.equal(typeof ddBox.props.onKeyDown, "function", "下拉容器必须挂键盘处理");
    // 展开后五档都在，当前项要高亮；再点一次收起。
    selects[0].props.onClick();
    tree = R.renderKeep(Panel, { workspacePath: ws });
    const rowOpen = byClassAll(tree, "wc-row").find((n) => textOf(n).includes("project-skill"));
    const menuItems = byClassAll(rowOpen, "wc-dd-item");
    assert.equal(menuItems.length, 5, "自绘下拉展开后应有五档");
    // 菜单必须是浮层：行内展开会撑高这一行，整块列表跟着跳（用户反馈过）。
    const menuRule = (capturedCss.match(/\.wc-dd-menu\s*\{[^}]*\}/) || [""])[0];
    assert.ok(menuRule, "样式里找不到 .wc-dd-menu");
    assert.match(menuRule, /position:\s*absolute/, "下拉菜单必须是浮层，不能占文档流");
    assert.equal(/position:\s*(static|relative)/.test(menuRule), false, "菜单不能参与行内布局");
    // 浮层底色不能来自宿主变量：`var(--color-background-primary-default, #232326)`
    // 的兜底是深色，浅色主题下菜单是一块黑底（leetcode 就是这么黑的）。
    assert.equal(/--color-background/.test(menuRule), false,
      "菜单底色不能依赖宿主 token——它的兜底值是深色，浅色主题下会变成黑块");
    const wrapRule = (capturedCss.match(/\.wc-dd\s*\{[^}]*\}/) || [""])[0];
    assert.match(wrapRule, /position:\s*relative/, "浮层要相对下拉按钮定位");
    assert.match(capturedCss, /\.wc-dd\.is-up \.wc-dd-menu\s*\{[^}]*bottom:[^}]*100%/,
      "缺少向上翻转的规则：最后一行的菜单会被滚动容器裁掉");
    assert.equal(byClassAll(rowOpen, "is-up").length, 0,
      "拿不到按钮坐标时应默认向下展开");
    const currentItem = menuItems.find((n) => n.props["aria-selected"] === true);
    assert.ok(currentItem, "下拉里当前档位没有标记为选中");
    // 选项里还有一个用作选中标记的 .wc-dd-check（内容就是 ✓），看文字要取 label。
    const currentLabel = byClassAll(currentItem, "wc-dd-label")[0];
    assert.equal(textOf(currentLabel), "仅名称", "选中的应是当前值 name-only");
    // 「仅名称 / 仅手动」这两个词不看说明判断不了，菜单项必须带完整解释（title）。
    // 选项的文字里恒有那个 ✓（靠 opacity 显隐），所以按 label 子节点找。
    const itemByLabel = (word) =>
      menuItems.find((n) => {
        const lb = byClassAll(n, "wc-dd-label")[0];
        return lb && textOf(lb) === word;
      });
    const nameOnlyItem = itemByLabel("仅名称");
    assert.match(String(nameOnlyItem && nameOnlyItem.props.title || ""), /描述/,
      "「仅名称」的菜单项要说明省掉描述");
    const manualItem = itemByLabel("仅手动");
    assert.match(String(manualItem && manualItem.props.title || ""), /隐藏/,
      "「仅手动」的菜单项要说明对 Claude 隐藏");
    assert.ok(!textOf(tree).includes("undefined"), "侧栏技能下拉文案里出现了 undefined");
    byClassAll(rowOpen, "wc-dd-trigger")[0].props.onClick();
    tree = R.renderKeep(Panel, { workspacePath: ws });
    assert.equal(byClassAll(tree, "wc-dd-item").length, 0, "再次点击下拉应收起菜单");
    byClassAll(tree, "wc-tab")[1].props.onClick();
    tree = R.renderKeep(Panel, { workspacePath: ws });
  }


  // 中央页签：先在面板里拿到工作区，再渲染大屏。
  // 团队层 settings.json 上面已经验过，这里清掉它——否则 scan 会一直报
  // 「团队配置已禁用」的 warn，「诊断为空时整块不渲染」就没法测。
  fs.rmSync(path.join(ws, ".claude", "settings.json"), { force: true });
  const Center = registered.center.component;
  let centerTree = R.renderFresh(Center, {}, { effects: true });
  // Center 打开时 store 里的还是删文件之前的扫描结果，先点一次刷新。
  const refreshBtn = findAll(centerTree, (n) => {
    const c = n && n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes("wc-refresh");
  })[0];
  if (refreshBtn) refreshBtn.props.onClick();
  for (let i = 0; i < 40; i++) {
    const picks = byClassAll(centerTree, "wc-pick");
    if (picks.length > 0) {
      picks[0].props.onClick();
      centerTree = R.renderKeep(Center, {});
      continue;
    }
    // 顶部区默认收起，诊断块本来就不渲染，所以不能靠 wc-diag 判断扫描是否落地。
    // 收起态的概览 chips 会在有诊断时显示「诊断 N」，用它作为统一判据。
    if (byClassAll(centerTree, "wc-center-layout").length > 0
      && !/诊断/.test(textOf(centerTree))) break;
    await new Promise((r) => setTimeout(r, 50));
    centerTree = R.renderKeep(Center, {});
  }
  const centerText = textOf(centerTree);
  // 左导航 + 右详情：一次只渲染一类，不会三块列表同时出现。
  assert.equal(byClassAll(centerTree, "wc-center-layout").length, 1, "中央页签没有左导航布局");
  assert.equal(byClassAll(centerTree, "wc-nav").length, 1, "中央页签没有左侧导航");
  // 三类开关 + 记忆：记忆是只读浏览，但同样挂在左侧导航上。
  assert.equal(byClassAll(centerTree, "wc-nav-item").length, 4, "左侧导航应有三个类别加记忆");
  assert.equal(byClassAll(centerTree, "wc-detail").length, 1, "中央页签没有右侧详情区");
  assert.equal(byClassAll(centerTree, "wc-col").length, 0, "三列布局应已移除");
  assert.equal(byClassAll(centerTree, "wc-grid").length, 0, "三列网格应已移除");
  // 详情区里只该有当前类别的 Section
  const detail = byClassAll(centerTree, "wc-detail")[0];
  assert.equal(findAll(detail, (n) => {
    const c = n && n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes("wc-sec");
  }).length, 1, "右侧详情区应只渲染当前类别一个分组");
  // 导航项带数量；有本地覆盖时还要带覆盖数徽标
  const navText = textOf(byClassAll(centerTree, "wc-nav")[0]);
  assert.match(navText, /插件/, "导航缺少插件项");
  assert.match(navText, /MCP/, "导航缺少 MCP 项");
  assert.match(navText, /技能/, "导航缺少技能项");
  assert.equal(byClassAll(centerTree, "wc-nav-num").length, 4, "四个导航项都要有数量");
  assert.ok(byClassAll(centerTree, "wc-nav-badge").length >= 1, "有本地覆盖时导航应显示覆盖数徽标");
  assert.ok(!centerText.includes("undefined"), "中央页签文案里出现了 undefined");
  // 诊断为空时，文案里也不该出现「诊断」。
  assert.ok(!/诊断/.test(centerText), "没有诊断项时不该出现诊断字样");
  // 默认收起：列表优先，首屏只有一条带概览 chips 的标题行，
  // 统计卡片与搜索框都不渲染，想筛选再点开。
  assert.equal(byClassAll(centerTree, "wc-stats").length, 0, "默认应处于收起态，不该显示统计卡片");
  assert.equal(byClassAll(centerTree, "wc-search").length, 0, "默认收起时不该有搜索框");
  assert.equal(byClassAll(centerTree, "wc-page-head").length, 1, "收起态仍要保留标题栏");
  assert.ok(
    byClassAll(centerTree, "wc-page-head")[0].props.className.includes("wc-head-collapsed"),
    "默认应带收起态样式",
  );
  const defaultChips = textOf(byClassAll(centerTree, "wc-head-chips")[0] || "");
  assert.match(defaultChips, /插件/, "默认收起态 chips 缺少插件数量");
  assert.match(defaultChips, /覆盖/, "默认收起态 chips 缺少覆盖数");
  // 展开后才做搜索与切类别相关断言
  byClassAll(centerTree, "wc-icon-btn")[0].props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-stats").length, 1, "点开收起按钮后应显示统计卡片");
  // 切类别：右侧详情跟着换，搜索词被清空
  const navItems = byClassAll(centerTree, "wc-nav-item");
  const skillIdx = navItems.findIndex((n) => textOf(n).includes("技能"));
  assert.ok(skillIdx >= 0, "导航里找不到技能项");
  navItems[skillIdx].props.onClick();
  centerTree = R.renderKeep(Center, {});
  const detailAfter = byClassAll(centerTree, "wc-detail")[0];
  assert.match(textOf(detailAfter), /技能/, "切到技能后右侧详情没有换类别");
  assert.ok(
    byClassAll(centerTree, "wc-nav-item")[skillIdx].props.className.includes("wc-on"),
    "切换后导航项没有高亮",
  );
  const searchAfter = findAll(centerTree, (n) => {
    const c = n && n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes("wc-search");
  })[0];
  assert.equal(searchAfter.props.value, "", "切类别后搜索词应清空");
  assert.match(String(searchAfter.props.placeholder), /技能/, "搜索框占位应显示当前类别");
  // 四态按钮：五档都要在，且选中态落在 name-only 上（不能被折成「启用」）。
  {
    const skillRow = byClassAll(detailAfter, "wc-row").find((n) => textOf(n).includes("project-skill"));
    assert.ok(skillRow, "技能列表缺少 project-skill");
    const btns = byClassAll(skillRow, "wc-btn");
    assert.equal(btns.length, 5, "技能应当有五档（跟随 + 四态）");
    assert.match(textOf(skillRow), /仅名称/);
    const onBtn = btns.find((b) => textOf(b) === "仅名称");
    assert.ok(onBtn.props.className.includes("wc-on"), "name-only 应处于选中态");
    const enableBtn = btns.find((b) => textOf(b) === "启用");
    assert.ok(!enableBtn.props.className.includes("wc-on"), "name-only 不该被显示成启用");
    const dot = byClassAll(skillRow, "wc-dot")[0];
    assert.ok(dot.props.title.includes("仅名称"), "圆点说明应反映 name-only");
    // 真实渲染一遍：目录名与技能名不一致时，meta 里要能看到目录名。
    const mismatchRow = byClassAll(detailAfter, "wc-row").find((n) => textOf(n).includes("real-skill-name"));
    assert.ok(mismatchRow, "技能列表缺少 frontmatter 命名的技能");
    assert.match(textOf(mismatchRow), /目录 dir-name-mismatch/, "目录名与技能名不一致时要在行里标出目录名");
    assert.ok(!textOf(detailAfter).includes("undefined"), "技能列表文案里出现了 undefined");
  }
  // .mcp.json 审批：MCP 行要出现审批控件，已批准时显示「已批准」。
  {
    const mcpIdx = byClassAll(centerTree, "wc-nav-item").findIndex((n) => textOf(n).includes("MCP"));
    byClassAll(centerTree, "wc-nav-item")[mcpIdx].props.onClick();
    centerTree = R.renderKeep(Center, {});
    const detailMcp = byClassAll(centerTree, "wc-detail")[0];
    const projRow = byClassAll(detailMcp, "wc-row").find((n) => textOf(n).includes("proj-one"));
    assert.ok(projRow, "MCP 列表缺少 proj-one");
    assert.equal(byClassAll(projRow, "wc-row-actions").length, 1, "项目 .mcp.json 的 server 应多出一个审批控件");
    const apprDot = byClassAll(projRow, "wc-appr-approved")[0];
    assert.ok(apprDot, "已批准的项目 MCP 应显示批准态");
    assert.match(textOf(projRow), /已批准/);
    const btn = byClassAll(projRow, "wc-appr-btn")[0];
    assert.ok(btn && !btn.props.disabled, "审批按钮应可点");
    // user 来源的 server 不受审批约束，不该出现审批控件。
    const tavilyRow = byClassAll(detailMcp, "wc-row").find((n) => textOf(n).includes("tavily"));
    assert.ok(tavilyRow, "MCP 列表缺少 tavily");
    assert.equal(byClassAll(tavilyRow, "wc-appr-dot").length, 0, "user 来源的 MCP 不该有审批控件");

    // 自检控件：中央视图每个 MCP 行都有「检测」按钮，但还没有结果时不该显示状态。
    const projProbeBtn = byClassAll(projRow, "wc-probe-btn")[0];
    assert.ok(projProbeBtn, "MCP 行缺少自检按钮");
    assert.equal(textOf(projProbeBtn), "检测", "未检测过时按钮应写「检测」");
    assert.equal(byClassAll(projRow, "wc-probe-dot").length, 0, "还没检测过就不该显示自检结果");
    // 按钮文案要提前说明会启动进程，不能让人以为只是查状态。
    assert.match(String(projProbeBtn.props.title || ""), /会启动/, "自检按钮必须提示会启动 server 进程");
    // user 来源同样能自检（它不参与审批，但连接状态一样会出问题）。
    assert.ok(byClassAll(tavilyRow, "wc-probe-btn")[0], "user 来源的 MCP 也该能自检");

    // 点自检：UI 段的 exec 打真实子进程，而这里没有 claude 可用，
    // 结果应是 no-cli 而不是崩掉——这正是「找不到 CLI」该有的降级。
    projProbeBtn.props.onClick();
    let probeDot = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      centerTree = R.renderKeep(Center, {});
      const rowNow = byClassAll(byClassAll(centerTree, "wc-detail")[0], "wc-row")
        .find((n) => textOf(n).includes("proj-one"));
      probeDot = rowNow && byClassAll(rowNow, "wc-probe-dot")[0];
      if (probeDot && !textOf(probeDot).includes("检测中")) break;
    }
    assert.ok(probeDot, "自检后行上没有出现结果");
    assert.match(textOf(probeDot), /无 CLI|自检失败/, "没有 claude 可用时应如实降级，而不是报成功");
    // 有结果后按钮改成「重测」。
    const probeBtnAfter = byClassAll(
      byClassAll(byClassAll(centerTree, "wc-detail")[0], "wc-row").find((n) => textOf(n).includes("proj-one")),
      "wc-probe-btn",
    )[0];
    assert.equal(textOf(probeBtnAfter), "重测", "有结果后按钮应改为「重测」");
    // 点审批按钮会真的写盘（这里借 bridge 跑子进程）。
    btn.props.onClick();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      centerTree = R.renderKeep(Center, {});
      if (byClassAll(byClassAll(centerTree, "wc-detail")[0], "wc-appr-rejected").length > 0) break;
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(localPath, "utf8")).disabledMcpjsonServers,
      ["proj-one"],
      "点审批按钮应把拒绝写进项目配置",
    );
    // 写回批准，恢复 UI 段开始时的状态，后面展开链路的断言才不受影响。
    run(["set", ws, "mcpApproval", "proj-one", "approved"]);
    centerTree = R.renderKeep(Center, {});
    byClassAll(centerTree, "wc-nav-item")[skillIdx].props.onClick();
    centerTree = R.renderKeep(Center, {});
  }
  // 点行展开生效链路：全局 → 团队配置 → 本地 → 最终
  const mains = byClassAll(centerTree, "wc-main");
  assert.ok(mains.length > 0, "中央页签没有渲染出资源行");
  mains[0].props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.ok(byClassAll(centerTree, "wc-flow").length > 0, "点击行没有展开生效链路");
  assert.match(textOf(centerTree), /团队配置/, "生效链路里没有团队配置这一层");

  // 诊断一切正常时整块不该出现：占一行只会挤列表。
  // 这一段的 fixture 覆盖都是有效的（alpha@market 仍存在），所以 diagnostics 为空。
  assert.equal(byClassAll(centerTree, "wc-diag").length, 0, "没有诊断项时不该渲染诊断块");

  // 工作区未信任：proj-one 的审批结果确实写着「已批准」，但界面上必须同时
  // 说出「工作区未信任」，否则就是一个骗人的绿点。测完改回已信任。
  {
    const cjPath = path.join(home, ".claude.json");
    const cj = JSON.parse(fs.readFileSync(cjPath, "utf8"));
    cj.projects[ws].hasTrustDialogAccepted = false;
    fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2));
    byClassAll(centerTree, "wc-nav-item").find((n) => textOf(n).includes("MCP")).props.onClick();
    centerTree = R.renderKeep(Center, {});
    byClassAll(centerTree, "wc-refresh")[0].props.onClick();
    let untrustedRow = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      centerTree = R.renderKeep(Center, {});
      const detail = byClassAll(centerTree, "wc-detail")[0];
      if (!detail) continue;
      untrustedRow = byClassAll(detail, "wc-row").find((n) => textOf(n).includes("proj-one"));
      if (untrustedRow && textOf(untrustedRow).includes("工作区未信任")) break;
    }
    assert.ok(untrustedRow, "未信任场景下 MCP 列表缺少 proj-one");
    assert.equal(
      byClassAll(untrustedRow, "wc-appr-approved").length, 1,
      "审批结果本身仍是已批准，不该被改写成别的",
    );
    assert.match(textOf(untrustedRow), /工作区未信任/, "未信任时行上必须标出卡住的原因");
    // 灰点和它的 title 才是「生效状态」本体；徽标只是把原因说出来。
    const unDot = byClassAll(untrustedRow, "wc-dot")[0];
    assert.ok(unDot, "行上没有生效状态圆点");
    assert.ok(
      String(unDot.props.className).includes(" off"),
      "卡住的 server 圆点必须变灰，不能还是绿的",
    );
    assert.equal(unDot.props.title, "生效：关（工作区未信任）", "圆点 title 要说清是哪一层挡住的");
    // 拒绝不受信任影响：rejected 行不该被贴上未信任徽标。
    cj.projects[ws].hasTrustDialogAccepted = true;
    fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2));
    byClassAll(centerTree, "wc-refresh")[0].props.onClick();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      centerTree = R.renderKeep(Center, {});
      const detail = byClassAll(centerTree, "wc-detail")[0];
      if (!detail) continue;
      const row = byClassAll(detail, "wc-row").find((n) => textOf(n).includes("proj-one"));
      if (row && !textOf(row).includes("工作区未信任")) break;
    }
    byClassAll(centerTree, "wc-nav-item")[0].props.onClick();
    centerTree = R.renderKeep(Center, {});
  }

  // 顶部区可收起：收起后统计/搜索/诊断全消失，只剩一条带概览 chips 的紧凑条；
  // 再点一次能展开回来。状态经 saveSettings 落 storage，跨会话保持。
  assert.equal(byClassAll(centerTree, "wc-stats").length, 1, "这之前应处于展开态");
  const headToggle = byClassAll(centerTree, "wc-icon-btn")[0];
  assert.ok(headToggle, "顶部区没有收起按钮");
  headToggle.props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-stats").length, 0, "收起后不该再有统计卡片");
  assert.equal(byClassAll(centerTree, "wc-search").length, 0, "收起后不该再有搜索框");
  assert.equal(byClassAll(centerTree, "wc-page-head").length, 1, "收起后仍要保留标题栏");
  assert.ok(
    byClassAll(centerTree, "wc-page-head")[0].props.className.includes("wc-head-collapsed"),
    "收起后标题栏应带上收起态样式",
  );
  const chips = textOf(byClassAll(centerTree, "wc-head-chips")[0] || "");
  assert.match(chips, /插件/, "收起态概览 chips 缺少插件数量");
  assert.match(chips, /技能/, "收起态概览 chips 缺少技能数量");
  assert.match(chips, /覆盖/, "有本地覆盖时收起态应显示覆盖数");
  assert.equal(ctx.storage._data["workspace-config.settings.v1"]?.headCollapsed, true, "收起状态没有持久化");
  // 收起后列表照常可用
  assert.ok(byClassAll(centerTree, "wc-nav-item").length === 4, "收起后左侧导航应完整保留");
  assert.ok(byClassAll(centerTree, "wc-row").length > 0, "收起后列表应照常渲染");
  byClassAll(centerTree, "wc-icon-btn")[0].props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-stats").length, 1, "再次点击应展开回统计区");

  // 记忆：左侧导航第 4 项，进去才读一次列表；选中文件后用 Markdown 渲染正文。
  const memNav = byClassAll(centerTree, "wc-nav-item").find((n) => textOf(n).includes("记忆"));
  assert.ok(memNav, "左侧导航没有记忆项");
  memNav.props.onClick();
  // 刚进入、还没读完时，界面结构必须和读完以后一致：头部、模式开关都在，
  // 只是内容区换成「读取中…」。用户反馈过前后两套样子很违和。
  centerTree = R.renderKeep(Center, {});
  {
    const headBeforeLoad = byClassAll(centerTree, "wc-mem-head")[0];
    assert.ok(headBeforeLoad, "记忆页首次进入就应有头部，不能等读完才出现");
    assert.equal(byClassAll(centerTree, "wc-mem-modes").length, 1,
      "首次进入就应有「分栏 / 仅列表 / 仅正文」控件");
    const modeLabelsBefore = byClassAll(centerTree, "wc-mem-modes")[0].children
      .map((n) => textOf(n)).join("|");
    assert.match(modeLabelsBefore, /分栏.*仅列表.*仅正文/,
      "首次进入的控件应和读完以后是同一套");
    assert.equal(byClassAll(centerTree, "wc-mem-item").length, 0,
      "还没读完时不应凭空列出文件");
  }
  for (let i = 0; i < 40; i++) {
    if (byClassAll(centerTree, "wc-mem-item").length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
    centerTree = R.renderKeep(Center, {});
  }
  assert.ok(
    byClassAll(centerTree, "wc-nav-item")[3].props.className.includes("wc-on"),
    "切到记忆后导航项没有高亮",
  );
  assert.equal(byClassAll(centerTree, "wc-row").length, 0, "记忆页不该混进开关列表");
  // 记忆没有「当前类别」的概念，搜索与覆盖筛选在展开态也不该出现。
  assert.equal(byClassAll(centerTree, "wc-search").length, 0, "记忆页不该出现类别搜索框");
  const memItems = byClassAll(centerTree, "wc-mem-item");
  assert.ok(memItems.length >= 3, "记忆列表应有自动记忆、项目与个人来源");
  assert.match(textOf(memItems[0]), /MEMORY\.md/, "索引文件应排在最前");
  assert.match(textOf(byClassAll(centerTree, "wc-mem")[0]), /只读/, "记忆页必须标明只读");
  // 两栏各自滚动：外层容器在记忆页必须停止滚动，否则列表和正文还是一起走。
  const memScroller = byClassAll(centerTree, "wc-center-scroll")[0];
  assert.ok(memScroller, "中央视图找不到滚动容器");
  assert.match(String(memScroller.props.className), /wc-scroll-fixed/,
    "记忆页的中央外层应换成不滚动的壳");
  const memScrollRule = (capturedCss.match(/\.wc-center-scroll\.wc-scroll-fixed\s*\{[^}]*\}/) || [""])[0];
  assert.match(memScrollRule, /overflow:\s*hidden/, "记忆页外层容器必须停止滚动，把滚动交给两栏");
  assert.match(capturedCss, /\.wc-scroll-fixed \.wc-mem-list[^{]*\{[^}]*overflow-y:\s*auto/,
    "文件列表要自己滚动，不能和正文一起滚");
  const noteItem = memItems.find((n) => textOf(n).includes("alpha-note"));
  assert.ok(noteItem, "记忆列表缺少 alpha-note");
  noteItem.props.onClick();
  for (let i = 0; i < 40; i++) {
    if (byClassAll(centerTree, "wc-mem-md").length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
    centerTree = R.renderKeep(Center, {});
  }
  const mdBox = byClassAll(centerTree, "wc-mem-md")[0];
  assert.ok(mdBox, "选中记忆文件后没有渲染正文");
  const mdText = textOf(mdBox);
  assert.match(mdText, /正文 加粗 与 code/, "Markdown 正文没有渲染出来");
  assert.ok(byClassAll(centerTree, "wc-md-h2").length > 0, "Markdown 标题应渲染成 h2");
  assert.ok(byClassAll(centerTree, "wc-md-table").length > 0, "Markdown 表格应渲染成 table");
  // strong 没有 className，只能用标签名找。
  assert.ok(findAll(centerTree, (n) => n && n.type === "strong").length > 0,
    "行内加粗应渲染成 strong");
  assert.match(textOf(byClassAll(centerTree, "wc-mem-path")[0] || ""), /alpha-note\.md$/,
    "正文里要给出可直接复制的完整路径");
  // 视图是「分栏 / 仅列表 / 仅正文」三选一，不是一个模式两个来回切的按钮。
  const findBtn = (label) => findAll(centerTree, (n) => n && n.type === "button" && textOf(n) === label)[0];
  assert.ok(findBtn("分栏"), "记忆页缺少「分栏」模式");
  assert.ok(findBtn("仅列表"), "记忆页缺少「仅列表」模式");
  assert.ok(findBtn("仅正文"), "记忆页缺少「仅正文」模式");
  assert.ok(byClassAll(centerTree, "wc-mem-list").length > 0, "默认分栏应显示文件列表");
  assert.ok(byClassAll(centerTree, "wc-mem-md").length > 0, "默认分栏应显示正文");
  assert.match(String(findBtn("分栏").props.className), /wc-on/, "默认高亮的应是分栏");

  findBtn("仅列表").props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.ok(byClassAll(centerTree, "wc-mem-list").length > 0, "仅列表模式下文件列表应还在");
  assert.equal(byClassAll(centerTree, "wc-mem-md").length, 0, "仅列表模式下正文应消失");
  assert.equal(byClassAll(centerTree, "wc-mem-grid-listonly").length, 1, "仅列表模式应换成单列布局");

  findBtn("仅正文").props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-mem-list").length, 0, "仅正文模式下文件列表应消失");
  assert.ok(byClassAll(centerTree, "wc-mem-md").length > 0, "仅正文模式下正文应还在");
  assert.equal(byClassAll(centerTree, "wc-mem-grid-single").length, 1, "仅正文模式应让正文独占");

  // 再点一次同一个模式回到分栏：三选一控件，不存在「两边都收空」。
  findBtn("仅正文").props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.ok(byClassAll(centerTree, "wc-mem-list").length > 0, "再点同一模式应回到分栏（列表）");
  assert.ok(byClassAll(centerTree, "wc-mem-md").length > 0, "再点同一模式应回到分栏（正文）");
  // 回到配置类别：记忆内容必须整块消失，不能和开关列表叠在一起。
  byClassAll(centerTree, "wc-nav-item")[0].props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-mem").length, 0, "切回插件类别后记忆区应卸载");
  assert.equal(
    String((byClassAll(centerTree, "wc-center-scroll")[0] || { props: {} }).props.className || "").includes("wc-scroll-fixed"),
    false,
    "离开记忆页后中央外层应恢复普通滚动",
  );
  assert.ok(byClassAll(centerTree, "wc-row").length > 0, "切回插件类别后列表应恢复");

  // 左侧类别导航可折叠：折成窄栏，详情拿回宽度；状态写进 settings 持久化。
  assert.ok(byClassAll(centerTree, "wc-nav").length === 1, "默认应显示左侧类别导航");
  const navCollapseBtn = findAll(centerTree, (n) =>
    n && n.type === "button"
    && String(n.props.className || "").split(/\s+/).includes("wc-icon-btn")
    && String(n.props.title || "").includes("类别导航"))[0];
  assert.ok(navCollapseBtn, "缺少收起类别导航的按钮");
  navCollapseBtn.props.onClick();
  await new Promise((r) => setTimeout(r, 30));
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-nav").length, 0, "收起后导航应换成窄栏");
  assert.equal(byClassAll(centerTree, "wc-nav-rail").length, 1, "收起后应渲染一条窄栏");
  assert.equal(byClassAll(centerTree, "wc-layout-nav-collapsed").length, 1, "收起后布局要换列宽");
  assert.equal(ctx.storage._data["workspace-config.settings.v1"]?.navCollapsed, true,
    "导航收起状态没有持久化");
  // 窄栏必须仍能切类别：收起后还能点「MCP」直接切过去。
  const railItems = byClassAll(centerTree, "wc-rail-item");
  assert.equal(railItems.length, 4, "窄栏应有三个类别加记忆，收起不等于把导航弄丢");
  const railMcp = railItems.find((n) => textOf(n) === "MCP");
  assert.ok(railMcp, "窄栏缺少 MCP 类别");
  railMcp.props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.match(String(railMcp.props.className), /wc-rail-item/);
  assert.ok(
    String((byClassAll(centerTree, "wc-rail-item").find((n) => textOf(n) === "MCP") || { props: {} }).props.className || "").includes("wc-on"),
    "点窄栏的类目标签应切过去并高亮",
  );
  assert.equal(byClassAll(centerTree, "wc-mem").length, 0, "从窄栏切到 MCP 后记忆区应卸载");
  assert.equal(byClassAll(centerTree, "wc-layout-nav-collapsed").length, 1, "切类别不应把导航展开");
  // 再切回记忆，确认窄栏里的记忆入口也通。
  byClassAll(centerTree, "wc-rail-item").find((n) => textOf(n) === "记忆").props.onClick();
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-mem").length, 1, "窄栏里的记忆入口应能切回记忆");
  byClassAll(centerTree, "wc-rail-toggle")[0].props.onClick();
  await new Promise((r) => setTimeout(r, 30));
  centerTree = R.renderKeep(Center, {});
  assert.equal(byClassAll(centerTree, "wc-nav").length, 1, "点窄栏应展开导航");
  assert.equal(ctx.storage._data["workspace-config.settings.v1"]?.navCollapsed, false,
    "展开导航后状态没有写回");

  // 侧栏：页内页签固定在滚动区外，列表再长也不会把它顶走
  const scroller = byClassAll(tree, "wc-scroll")[0];
  assert.ok(scroller, "右侧面板没有滚动容器");
  const tabsInScroll = findAll(scroller, (n) => {
    const c = n && n.props && n.props.className;
    return typeof c === "string" && c.split(/\s+/).includes("wc-tabs");
  });
  assert.equal(tabsInScroll.length, 0, "页内页签还在滚动容器里，会和列表一起滚走");
  assert.ok(byClassAll(tree, "wc-tab").length === 3, "右侧面板没有渲染出三个页内页签");

  // 设置页：勾选后应写入 storage；下方还要渲染出反馈区。
  const Settings = registered.settings.component;
  let settingsTree = R.renderFresh(Settings, {}, { effects: true });
  const box = findAll(settingsTree, (n) => n && n.type === "input")[0];
  assert.ok(box, "设置页没有渲染出开关");
  box.props.onChange({ target: { checked: true } });
  settingsTree = R.renderKeep(Settings, {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.storage._data["workspace-config.settings.v1"]?.showDesc, true, "设置没有写入 storage");
  assert.match(textOf(settingsTree), /反馈/, "设置页没有渲染出反馈区");

  // 宿主换工作区（切会话标签）：中央视图没有 workspacePath prop，
  // 只能靠轮询 ctx.workspace.getMetadata() 跟上。
  const ws2 = path.join(tmp, "workspace-2");
  fs.mkdirSync(path.join(ws2, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(ws2, ".claude", "settings.local.json"),
    JSON.stringify({ enabledPlugins: { "beta@market": false } }, null, 2),
  );
  // 先确保统计区展开：折叠态不显示工作区路径，断言会一直等不到。
  const headBefore = byClassAll(centerTree, "wc-page-head")[0];
  if (headBefore && String(headBefore.props.className || "").includes("wc-head-collapsed")) {
    byClassAll(centerTree, "wc-icon-btn")[0].props.onClick();
    centerTree = R.renderKeep(Center, {});
  }
  host.path = ws2;
  let switchedWs = false;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    centerTree = R.renderKeep(Center, {});
    if (textOf(centerTree).includes("workspace-2")) { switchedWs = true; break; }
  }
  assert.ok(switchedWs, "宿主换工作区后中央视图没有跟上（轮询没生效）");

  dispose();
  console.log("UI_OK panel/center/settings 渲染通过");
}

console.log("SMOKE_OK checks=" + checks);
console.log("main.js", fs.statSync(MAIN).size, "bytes; manifest", MANIFEST.id);
