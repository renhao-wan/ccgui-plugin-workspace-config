import test from "node:test";
import assert from "node:assert/strict";
import {
  getPluginState,
  setPluginState,
  getMcpState,
  setMcpState,
  getSkillState,
  setSkillState,
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

test("skill 的 name-only / user-invocable-only 视为非禁用", () => {
  const project = { skillOverrides: { a: "name-only", b: "user-invocable-only" } };
  assert.equal(getSkillState(project, "a"), "on");
  assert.equal(getSkillState(project, "b"), "on");
});

test("未管理的键原样保留", () => {
  const project = { permissions: { allow: ["Bash(ls)"] }, env: { A: "1" } };
  const next = setPluginState(project, "a@m", "off");
  assert.deepEqual(next.permissions, project.permissions);
  assert.deepEqual(next.env, project.env);
});

test("overrideCount 只数启用的三类键", () => {
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
