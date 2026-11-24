import test from "node:test";
import assert from "node:assert/strict";
import {
  getPluginState,
  setPluginState,
  getMcpState,
  setMcpState,
  getSkillState,
  setSkillState,
  getMcpApproval,
  setMcpApproval,
  overrideCount,
  effectiveState,
  prune,
} from "../src/lib/model.mjs";

test("plugin 三态：inherit 不写键，off/on 写布尔值", () => {
  assert.equal(getPluginState({}, "a@m"), "inherit");

  const off = setPluginState({}, "a@m", "off");
  assert.deepEqual(off.enabledPlugins, { "a@m": false });
  assert.equal(getPluginState(off, "a@m"), "off");

  const on = setPluginState(off, "a@m", "on");
  assert.deepEqual(on.enabledPlugins, { "a@m": true });
  assert.equal(getPluginState(on, "a@m"), "on");
});

test("plugin 改回 inherit 会删除条目并清掉空对象", () => {
  const off = setPluginState({}, "a@m", "off");
  const back = setPluginState(off, "a@m", "inherit");
  assert.deepEqual(back, {});
  assert.equal("enabledPlugins" in back, false);
});

test("plugin 只删目标条目，保留同键下的其它插件", () => {
  const both = setPluginState(setPluginState({}, "a@m", "off"), "b@m", "on");
  const next = setPluginState(both, "a@m", "inherit");
  assert.deepEqual(next.enabledPlugins, { "b@m": true });
});

test("mcp 只有 inherit/off；on 直接拒绝", () => {
  assert.equal(getMcpState({}, "tavily"), "inherit");

  const off = setMcpState({}, "tavily", "off");
  assert.deepEqual(off.deniedMcpServers, [{ serverName: "tavily" }]);
  assert.equal(getMcpState(off, "tavily"), "off");

  assert.throws(() => setMcpState(off, "tavily", "on"), /无法显式启用/);

  const back = setMcpState(off, "tavily", "inherit");
  assert.deepEqual(back, {});
});

test("mcp 只增删 serverName 条目，保留 command/url 条目", () => {
  const project = {
    deniedMcpServers: [{ serverCommand: ["rm", "-rf"] }, { serverName: "tavily" }],
  };
  const next = setMcpState(project, "tavily", "inherit");
  assert.deepEqual(next.deniedMcpServers, [{ serverCommand: ["rm", "-rf"] }]);
});

test("skill 三态：on 写字符串 on，off 写 off，inherit 删除", () => {
  assert.equal(getSkillState({}, "deploy"), "inherit");

  const on = setSkillState({}, "deploy", "on");
  assert.deepEqual(on.skillOverrides, { deploy: "on" });
  assert.equal(getSkillState(on, "deploy"), "on");

  const off = setSkillState(on, "deploy", "off");
  assert.deepEqual(off.skillOverrides, { deploy: "off" });
  assert.equal(getSkillState(off, "deploy"), "off");

  assert.deepEqual(setSkillState(off, "deploy", "inherit"), {});
});

test("skill 四态原样读出，不被折成 on", () => {
  const project = { skillOverrides: { a: "name-only", b: "user-invocable-only" } };
  assert.equal(getSkillState(project, "a"), "name-only");
  assert.equal(getSkillState(project, "b"), "user-invocable-only");
});

test("skill 四态写入往返，互不覆盖", () => {
  let project = {};
  for (const state of ["on", "name-only", "user-invocable-only", "off"]) {
    project = setSkillState(project, "s", state);
    assert.equal(project.skillOverrides.s, state);
    assert.equal(getSkillState(project, "s"), state);
  }
  // 点「启用」不再把 name-only 改写掉——这是此前的真实缺陷。
  const named = setSkillState({}, "s", "name-only");
  assert.equal(getSkillState(setSkillState(named, "s", "on"), "s"), "on");
  assert.deepEqual(setSkillState({ skillOverrides: { s: "name-only" } }, "s", "inherit"), {});
});

test("skill 未知取值读成 unknown，且不能被当作可写状态", () => {
  assert.equal(getSkillState({ skillOverrides: { s: "bogus" } }, "s"), "unknown");
  assert.throws(() => setSkillState({}, "s", "unknown"), /不支持的状态/);
  assert.throws(() => setSkillState({}, "s", "bogus"), /不支持的状态/);
});

test("mcp 审批：拒绝 > 逐个批准 > 全部批准 > 待审批", () => {
  assert.equal(getMcpApproval({}, "x"), "pending");
  assert.equal(getMcpApproval({ enableAllProjectMcpServers: true }, "x"), "approved");
  assert.equal(getMcpApproval({ enabledMcpjsonServers: ["x"] }, "x"), "approved");
  assert.equal(getMcpApproval({ disabledMcpjsonServers: ["x"] }, "x"), "rejected");
  // 同一名字同时出现在两个名单里，拒绝优先。
  assert.equal(getMcpApproval({ enabledMcpjsonServers: ["x"], disabledMcpjsonServers: ["x"] }, "x"), "rejected");
  // 名单里没有的名字不受别的名字影响。
  assert.equal(getMcpApproval({ enabledMcpjsonServers: ["y"] }, "x"), "pending");
});

test("mcp 审批写入：互斥且清理空数组", () => {
  let project = {};
  project = setMcpApproval(project, "x", "approved").settings;
  assert.deepEqual(project.enabledMcpjsonServers, ["x"]);

  project = setMcpApproval(project, "x", "rejected").settings;
  assert.deepEqual(project.disabledMcpjsonServers, ["x"]);
  assert.equal("enabledMcpjsonServers" in project, false);

  project = setMcpApproval(project, "x", "pending").settings;
  assert.deepEqual(project, {});

  // 只动目标名字。
  const mixed = setMcpApproval({ enabledMcpjsonServers: ["y"] }, "x", "rejected").settings;
  assert.deepEqual(mixed.enabledMcpjsonServers, ["y"]);
  assert.deepEqual(mixed.disabledMcpjsonServers, ["x"]);
});

test("mcp 审批：总开关开着时 pending 无法实现，如实回报", () => {
  const res = setMcpApproval({ enableAllProjectMcpServers: true }, "x", "pending");
  assert.equal(res.effective, "approved");
  assert.equal(res.settings.enableAllProjectMcpServers, true);
  // 总开关本身不被这条写入改动。
  const ok = setMcpApproval({ enableAllProjectMcpServers: true }, "x", "rejected");
  assert.equal(ok.effective, "rejected");
  assert.equal(ok.settings.enableAllProjectMcpServers, true);
  assert.deepEqual(ok.settings.disabledMcpjsonServers, ["x"]);
  assert.throws(() => setMcpApproval({}, "x", "inherit"), /不支持的状态/);
});

test("overrideCount 计入审批条目与总开关", () => {
  assert.equal(overrideCount({ enabledMcpjsonServers: ["a", "b"] }), 2);
  assert.equal(overrideCount({ disabledMcpjsonServers: ["a"] }), 1);
  assert.equal(overrideCount({ enableAllProjectMcpServers: true }), 1);
});

test("未管理的键原样保留", () => {
  const project = { permissions: { allow: ["Bash(ls)"] }, env: { A: "1" } };
  const next = setPluginState(project, "a@m", "off");
  assert.deepEqual(next.permissions, project.permissions);
  assert.deepEqual(next.env, project.env);
});

test("overrideCount 数插件/禁用 MCP/技能/审批四类键", () => {
  const project = {
    enabledPlugins: { "a@m": false },
    deniedMcpServers: [{ serverName: "tavily" }, { serverUrl: "https://x" }],
    skillOverrides: { deploy: "off" },
    permissions: { allow: [] },
  };
  assert.equal(overrideCount(project), 3);
});

test("effectiveState：项目态优先，inherit 回落全局", () => {
  assert.equal(effectiveState("off", "on"), "off");
  assert.equal(effectiveState("inherit", "off"), "off");
  assert.equal(effectiveState("inherit", undefined), "unknown");
});

test("prune 不修改入参", () => {
  const project = { enabledPlugins: {} };
  const out = prune(project);
  assert.deepEqual(project, { enabledPlugins: {} });
  assert.deepEqual(out, {});
});
