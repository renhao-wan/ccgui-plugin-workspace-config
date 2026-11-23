#!/usr/bin/env node
/* 子进程：读写项目级 Claude Code 配置。
 *
 * 插件本体拿不到文件系统，只能把这份脚本落盘后经 exec:node 执行。
 * 构建时 scripts/build.mjs 会把 src/lib/model.mjs 的源码内联进来，
 * 所以这里唯一允许的兄弟 import 是 model；其余只能用 node 内置模块。
 *
 * 用法：
 *   node config-io.mjs scan <workspace>
 *   node config-io.mjs set  <workspace> <plugin|mcp|skill> <id> <inherit|on|off>
 * 输出：单行 JSON，ok=false 时附带 error。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_SETTINGS_REL,
  SHARED_SETTINGS_REL,
  getPluginState,
  setPluginState,
  getMcpState,
  setMcpState,
  getSkillState,
  setSkillState,
  effectiveState,
} from "../src/lib/model.mjs";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const CLAUDE_JSON = path.join(HOME, ".claude.json");

function readJson(file) {
  try {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  const body = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function findProjectEntry(config, ws) {
  const projects = (config && config.projects) || {};
  const target = norm(ws);
  const key = Object.keys(projects).find((k) => norm(k) === target);
  return key ? projects[key] : null;
}

function listSkillDirs(root, source, plugin) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const md = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    out.push({ name: entry.name, source, plugin: plugin || null, path: md, description: readSkillDescription(md) });
  }
  return out;
}

function installedPlugins() {
  const raw = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"));
  const map = {};
  const plugins = (raw && raw.plugins) || {};
  for (const [id, list] of Object.entries(plugins)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const pick = list.find((e) => e && e.scope === "user") || list[0];
    map[id] = {
      installPath: pick && pick.installPath ? pick.installPath : "",
      scopes: list.map((e) => e && e.scope).filter(Boolean),
    };
  }
  return map;
}

/** 插件 .mcp.json 有两种写法：{ mcpServers: { name: cfg } } 和扁平的 { name: cfg }。 */
function pluginServers(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  const wrapped = cfg.mcpServers || cfg.servers;
  if (wrapped && typeof wrapped === "object") return wrapped;
  const out = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value && typeof value === "object"
      && ("command" in value || "url" in value || "type" in value)) {
      out[key] = value;
    }
  }
  return out;
}

/** 插件描述：优先 .claude-plugin/plugin.json，其次根目录的 plugin.json / manifest.json。 */
function pluginDescription(dir) {
  if (!dir) return "";
  for (const rel of [".claude-plugin/plugin.json", "plugin.json", "manifest.json"]) {
    const cfg = readJson(path.join(dir, rel));
    if (cfg && typeof cfg.description === "string" && cfg.description.trim()) {
      return cfg.description.trim();
    }
  }
  return "";
}

/** SKILL.md frontmatter 里的 description；只读前 50 行。 */
function readSkillDescription(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 50);
    if (!lines.length || lines[0].trim() !== "---") return "";
    let collecting = false;
    const block = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") break;
      const match = /^description:\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1].trim();
        if (/^[|>][-+]?$/.test(value)) { collecting = true; continue; }
        return value.replace(/^["']|["']$/g, "").trim();
      }
      if (collecting) {
        if (/^\s+\S/.test(line)) block.push(line.trim());
        else break;
      }
    }
    return block.join(" ").trim();
  } catch {
    return "";
  }
}

function mcpDescription(cfg) {
  if (!cfg || typeof cfg !== "object") return "";
  if (typeof cfg.url === "string") return cfg.url;
  if (typeof cfg.command === "string") {
    const args = Array.isArray(cfg.args) ? " " + cfg.args.join(" ") : "";
    return (cfg.command + args).trim();
  }
  return "";
}

function scan(ws) {
  const globalSettings = readJson(path.join(CLAUDE_DIR, "settings.json")) || {};
  const globalConfig = readJson(CLAUDE_JSON) || {};
  const localPath = path.join(ws, PROJECT_SETTINGS_REL);
  const sharedPath = path.join(ws, SHARED_SETTINGS_REL);
  const local = readJson(localPath) || {};
  const shared = readJson(sharedPath) || {};

  // 项目层：local 压过 shared；面板只写 local。
  const projectLayer = Object.assign({}, shared, local);
  for (const key of ["enabledPlugins", "skillOverrides"]) {
    if (shared[key] || local[key]) {
      projectLayer[key] = Object.assign({}, shared[key] || {}, local[key] || {});
    }
  }
  if (Array.isArray(shared.deniedMcpServers) || Array.isArray(local.deniedMcpServers)) {
    projectLayer.deniedMcpServers = [
      ...(Array.isArray(shared.deniedMcpServers) ? shared.deniedMcpServers : []),
      ...(Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []),
    ];
  }

  /* ---------------- plugins ---------------- */

  const installed = installedPlugins();
  const pluginIds = new Set(Object.keys(globalSettings.enabledPlugins || {}));
  for (const id of Object.keys(installed)) pluginIds.add(id);

  const plugins = [];
  for (const id of [...pluginIds].sort()) {
    const at = id.lastIndexOf("@");
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : "";
    const enabled = globalSettings.enabledPlugins && globalSettings.enabledPlugins[id];
    const globalState = enabled === false ? "off" : enabled === true ? "on" : "unknown";
    const projectState = getPluginState(projectLayer, id);
    plugins.push({
      kind: "plugin",
      id,
      name,
      marketplace,
      installed: Boolean(installed[id]),
      installPath: installed[id] ? installed[id].installPath : "",
      description: installed[id] ? pluginDescription(installed[id].installPath) : "",
      globalState,
      projectState,
      // 面板只能写 local；shared 是被仓库共享的团队配置，单独列出以便界面说明「跟随」会落到哪一层。
      localState: getPluginState(local, id),
      sharedState: getPluginState(shared, id),
      effectiveState: effectiveState(projectState, globalState),
    });
  }

  /* ---------------- mcp ---------------- */

  const userMcp = globalConfig.mcpServers || {};
  const localMcp = (findProjectEntry(globalConfig, ws) || {}).mcpServers || {};
  const projectMcp = (readJson(path.join(ws, ".mcp.json")) || {}).mcpServers || {};

  // 插件自带的 MCP：plugin 包里的 .mcp.json，同样能被 deniedMcpServers 拦住。
  const pluginMcp = {};
  for (const [id, info] of Object.entries(installed)) {
    if (!info.installPath) continue;
    const cfg = readJson(path.join(info.installPath, ".mcp.json"));
    const at = id.lastIndexOf("@");
    const pluginName = at > 0 ? id.slice(0, at) : id;
    for (const [name, value] of Object.entries(pluginServers(cfg))) {
      if (!(name in pluginMcp)) pluginMcp[name] = { plugin: pluginName, config: value };
    }
  }

  const mcpNames = new Set([
    ...Object.keys(userMcp),
    ...Object.keys(localMcp),
    ...Object.keys(projectMcp),
    ...Object.keys(pluginMcp),
  ]);

  const globalDenied = Array.isArray(globalSettings.deniedMcpServers)
    ? globalSettings.deniedMcpServers
    : [];

  const mcp = [...mcpNames].sort().map((name) => {
    const scopes = [];
    if (localMcp[name]) scopes.push("local");
    if (projectMcp[name]) scopes.push("project");
    if (userMcp[name]) scopes.push("user");
    if (pluginMcp[name]) scopes.push("plugin");
    const deniedGlobally = globalDenied.some((e) => e && e.serverName === name);
    // local > project > user > plugin 是 Claude Code 的生效顺序
    const scope = scopes[0] || "user";
    const pluginEntry = pluginMcp[name];
    const config = localMcp[name] || projectMcp[name] || userMcp[name]
      || (pluginEntry && pluginEntry.config) || null;
    const projectState = getMcpState(projectLayer, name);
    const globalState = deniedGlobally ? "off" : "on";
    return {
      kind: "mcp",
      id: name,
      name,
      scope,
      scopes,
      plugin: pluginEntry ? pluginEntry.plugin : null,
      description: mcpDescription(config),
      globalState,
      projectState,
      localState: getMcpState(local, name),
      sharedState: getMcpState(shared, name),
      canEnable: !deniedGlobally,
      effectiveState: deniedGlobally ? "off" : effectiveState(projectState, "on"),
    };
  });

  /* ---------------- skills ---------------- */

  const skills = [];
  skills.push(...listSkillDirs(path.join(CLAUDE_DIR, "skills"), "personal"));
  skills.push(...listSkillDirs(path.join(ws, ".claude", "skills"), "project"));

  for (const [id, info] of Object.entries(installed)) {
    if (!info.installPath) continue;
    const at = id.lastIndexOf("@");
    const pluginName = at > 0 ? id.slice(0, at) : id;
    skills.push(...listSkillDirs(path.join(info.installPath, "skills"), "plugin", pluginName));
  }

  const globalOverrides = globalSettings.skillOverrides || {};
  const seen = new Map();
  const skillRows = skills.map((s) => {
    const globalRaw = globalOverrides[s.name];
    const globalState = globalRaw === "off" ? "off" : "on";
    const projectState = getSkillState(projectLayer, s.name);
    const row = {
      kind: "skill",
      id: s.name,
      name: s.name,
      source: s.source,
      plugin: s.plugin,
      description: s.description || "",
      globalState,
      projectState,
      localState: getSkillState(local, s.name),
      sharedState: getSkillState(shared, s.name),
      effectiveState: effectiveState(projectState, globalState),
      controllable: s.source !== "plugin",
    };
    const key = s.name;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(s.source);
    return row;
  });

  for (const row of skillRows) {
    const sources = seen.get(row.name) || [];
    row.shadowed = row.source === "personal" && sources.includes("project");
    if (row.controllable && sources.length > 1) {
      row.effectiveSource = sources.includes("personal") ? "personal" : "project";
    } else if (!row.controllable) {
      row.effectiveSource = "plugin";
    } else {
      row.effectiveSource = row.source;
    }
  }

  return {
    ok: true,
    workspace: ws,
    files: { local: localPath, shared: sharedPath },
    pluginCount: plugins.length,
    plugins,
    mcp,
    skills: skillRows,
  };
}

function set(ws, kind, id, state) {
  const localPath = path.join(ws, PROJECT_SETTINGS_REL);
  const current = readJson(localPath) || {};
  let next;
  if (kind === "plugin") next = setPluginState(current, id, state);
  else if (kind === "mcp") next = setMcpState(current, id, state);
  else if (kind === "skill") next = setSkillState(current, id, state);
  else throw new Error("未知类型：" + kind);
  writeJsonAtomic(localPath, next);
  return { ok: true, file: localPath, settings: next };
}

/** 一次写完多条：同类型共用一个文件，避免每行起一次子进程。 */
function setMany(ws, opsJson) {
  let ops;
  try {
    ops = JSON.parse(opsJson);
  } catch {
    throw new Error("批量操作的参数不是合法 JSON");
  }
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("批量操作为空");
  if (ops.length > 500) throw new Error("单次批量操作不能超过 500 项");

  const localPath = path.join(ws, PROJECT_SETTINGS_REL);
  let next = readJson(localPath) || {};
  let applied = 0;
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const { kind, id, state } = op;
    if (kind === "plugin") next = setPluginState(next, id, state);
    else if (kind === "mcp") next = setMcpState(next, id, state);
    else if (kind === "skill") next = setSkillState(next, id, state);
    else throw new Error("未知类型：" + kind);
    applied += 1;
  }
  writeJsonAtomic(localPath, next);
  return { ok: true, file: localPath, applied, settings: next };
}

function main() {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const ws = argv[1];
  if (action === "setMany") {
    if (!ws) throw new Error("用法：config-io.mjs setMany <workspace> <json>");
    if (!fs.existsSync(ws)) throw new Error("工作区不存在：" + ws);
    process.stdout.write(JSON.stringify(setMany(ws, argv[2] || "[]")));
    return;
  }
  const [, , kind, id, state] = argv;
  if (!action || !ws) throw new Error("用法：config-io.mjs scan <workspace> | set <workspace> <kind> <id> <state>");
  if (!fs.existsSync(ws)) throw new Error("工作区不存在：" + ws);
  const result = action === "scan" ? scan(ws) : action === "set" ? set(ws, kind, id, state) : null;
  if (!result) throw new Error("未知动作：" + action);
  process.stdout.write(JSON.stringify(result));
}

try {
  main();
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
}
