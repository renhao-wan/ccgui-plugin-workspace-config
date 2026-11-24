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
  getMcpApproval,
  setMcpApproval,
  getSkillState,
  setSkillState,
  effectiveState,
} from "../src/lib/model.mjs";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
// 设了 CLAUDE_CONFIG_DIR 时，Claude Code 会把 settings.json、.claude.json、
// plugins/、projects/ 全部搬进这个目录（官方文档：该页所有 ~/.claude 路径都改到这里）。
// 硬编码 ~/.claude 会读到一片空，面板显示成「什么都没配」。实测 2.1.319 确实如此。
// 注意 .claude.json 只在设了这个变量时才跟着走，默认仍在 HOME 根上。
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, ".claude");
const CLAUDE_DIR = CONFIG_DIR;
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR
  ? path.join(CONFIG_DIR, ".claude.json")
  : path.join(HOME, ".claude.json");

function readJson(file) {
  try {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 严格读取：把「文件不存在」和「存在但解析失败」分开。
 *
 * 写入前必须用这个。settings.local.json 里可能同时住着用户手写的 permissions、
 * hooks、env 等键；一旦解析失败就被当成空对象写回，等于整份配置被清空。
 * 这种情况要么报错停止，要么提示用户自己修，绝不能静默覆盖。
 */
function readJsonStrict(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { value: null, error: null };
    return { value: null, error: "读取失败：" + ((err && err.message) || err) };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 空文件按「还没配置」处理，写回时自然变成一份新配置。
  if (!text.trim()) return { value: null, error: null };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, error: "顶层不是 JSON 对象" };
    }
    return { value, error: null };
  } catch (err) {
    return { value: null, error: String((err && err.message) || err) };
  }
}

/** 写之前读；文件坏了就抛错，宁可这次操作失败也不吞掉用户的其它配置。 */
function readForWrite(file) {
  const { value, error } = readJsonStrict(file);
  if (error) {
    throw new Error("项目配置不是合法 JSON，为避免覆盖已停止写入：" + file + "（" + error + "）");
  }
  return value || {};
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
    const meta = readSkillMeta(md);
    // 技能名优先取 frontmatter 的 name，目录名只是回落（官方文档明确）。
    // 用目录名当键时，一旦两者不一致，写进 skillOverrides 的键就对不上
    // Claude Code 认的那个名字，开关看起来生效、实际什么也没改。
    out.push({
      name: meta.name || entry.name,
      dirName: entry.name,
      source,
      plugin: plugin || null,
      path: md,
      description: meta.description,
    });
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

/** SKILL.md frontmatter 里的 name 与 description；只读前 50 行。 */
function readSkillMeta(file) {
  const meta = { name: "", description: "" };
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 50);
    if (!lines.length || lines[0].trim() !== "---") return meta;
    let collecting = false;
    const block = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") break;
      if (collecting) {
        if (/^\s+\S/.test(line)) { block.push(line.trim()); continue; }
        collecting = false;
      }
      const nameMatch = /^name:\s*(.*)$/.exec(line);
      if (nameMatch && !meta.name) {
        meta.name = nameMatch[1].replace(/^["']|["']$/g, "").trim();
        continue;
      }
      const match = /^description:\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1].trim();
        if (/^[|>][-+]?$/.test(value)) { collecting = true; continue; }
        meta.description = value.replace(/^["']|["']$/g, "").trim();
      }
    }
    if (collecting || block.length) meta.description = meta.description || block.join(" ").trim();
    return meta;
  } catch {
    return meta;
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
  // 坏掉的文件不能被当成「没有配置」：那样界面会显示成全部跟随全局，
  // 用户再点一下就覆盖掉了。这里如实读，坏的单独报出来。
  const localRead = readJsonStrict(localPath);
  const local = localRead.value || {};
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

  // 项目 .mcp.json 的审批结果同样写在 settings.local.json；团队层与全局层也可能
  // 设过。布尔开关按 local > shared > 全局 取值，两个名单取并集——拒绝优先，
  // 所以并集不会把某一层的拒绝「合并掉」。
  const approvalLayer = (() => {
    const out = {};
    for (const layer of [globalSettings, shared, local]) {
      if (layer.enableAllProjectMcpServers !== undefined) {
        out.enableAllProjectMcpServers = layer.enableAllProjectMcpServers;
      }
      for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) {
        if (Array.isArray(layer[key])) {
          out[key] = [...new Set([...(out[key] || []), ...layer[key]])];
        }
      }
    }
    return out;
  })();

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
    // 审批只对来自项目 .mcp.json 的定义有意义；user/local/plugin 来源不弹这个窗。
    const approval = projectMcp[name] ? getMcpApproval(approvalLayer, name) : null;
    const projectDenied = getMcpState(projectLayer, name) === "off";
    // 未批准、已拒绝都等于「没连上」。以前只看 denylist，会把待审批的 server
    // 显示成绿点生效——这正是本项目最容易误导人的地方。
    const connected = !deniedGlobally && !projectDenied && approval !== "pending" && approval !== "rejected";
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
      projectDefined: Boolean(projectMcp[name]),
      approval,
      allApproved: approvalLayer.enableAllProjectMcpServers === true,
      effectiveState: connected ? effectiveState(projectState, "on") : "off",
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
    // 全局层同样是四态，压成 on/off 会让「仅名称」看起来像完整启用。
    const globalState = Object.prototype.hasOwnProperty.call(globalOverrides, s.name)
      ? getSkillState(globalSettings, s.name)
      : "on";
    const projectState = getSkillState(projectLayer, s.name);
    const row = {
      kind: "skill",
      id: s.name,
      name: s.name,
      // 目录名与 frontmatter 不一致时，界面上要能看出文件在哪。
      dirName: s.dirName,
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

  /* ---------------- diagnostics ---------------- */

  // 面板只列「当前存在的资源」，所以 local 里指向已消失资源的键会完全没有入口。
  // 这里把它们找出来：stale 项可以一键清掉，其余只提示原因。
  const diagnostics = [];
  const seenDiag = new Set();
  // 同名技能可能被多个来源列出（个人版与项目版、或多个插件共用 installPath），
  // 诊断只该报一次。
  const diag = (level, kind, id, name, message, fixable) => {
    const key = level + ":" + kind + ":" + id;
    if (seenDiag.has(key)) return;
    seenDiag.add(key);
    diagnostics.push({ level, kind, id, name, message, fixable: Boolean(fixable) });
  };

  // 配置文件坏了必须最优先报：这时列表里的一切都是「读不到」而不是「没设置」，
  // 而且任何一次写入都会被拒绝（见 readForWrite）。
  if (localRead.error) {
    diag("error", "file", PROJECT_SETTINGS_REL, "settings.local.json",
      "项目配置不是合法 JSON（" + localRead.error + "），面板不会写入，请先手动修复", false);
  }

  const knownPlugins = new Set(plugins.map((p) => p.id));
  for (const id of Object.keys(local.enabledPlugins || {})) {
    if (!knownPlugins.has(id)) diag("stale", "plugin", id, id, "插件已不存在，本地仍保留开关", true);
  }
  for (const p of plugins) {
    if (!p.installed && p.globalState === "on") {
      diag("warn", "plugin", p.id, p.name, "全局启用但本机未安装", false);
    }
  }

  const knownSkills = new Set(skillRows.map((r) => r.name));
  for (const name of Object.keys(local.skillOverrides || {})) {
    // 旧版本用目录名当键，遇到 frontmatter 改了 name 的技能就会留下一条
    // Claude Code 根本不认的键；按残留报出来，用户才知道该清掉。
    if (!knownSkills.has(name)) diag("stale", "skill", name, name, "技能已不存在，本地仍保留开关", true);
  }
  for (const r of skillRows) {
    const localTouched = Object.prototype.hasOwnProperty.call(local.skillOverrides || {}, r.name);
    if (r.shadowed) diag("info", "skill", r.id, r.name, "项目版本被同名个人技能遮蔽", false);
    if (r.controllable === false && localTouched) {
      diag("warn", "skill", r.id, r.name, "插件提供的技能不受本地开关控制", false);
    }
  }

  const knownMcp = new Set(mcpNames);
  for (const entry of Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []) {
    if (entry && entry.serverName && !knownMcp.has(entry.serverName)) {
      diag("stale", "mcp", entry.serverName, entry.serverName, "MCP 已不存在，本地仍保留禁用", true);
    }
  }
  for (const row of mcp) {
    if (row.sharedState === "off") {
      diag("warn", "mcp", row.id, row.name, "团队配置已禁用，本地无法解除", false);
    }
    // 待审批是「看起来配了、其实没连」，比报错更难发现，必须单独提示。
    if (row.approval === "pending") {
      diag("warn", "mcp", row.id, row.name, "项目 .mcp.json 里定义但尚未批准，本次会话不会连接", false);
    }
  }
  // 审批名单和 deniedMcpServers 一样会留残留：.mcp.json 里删掉的 server
  // 仍占着批准/拒绝名单，列表里看不到，重装同名 server 时会突然被自动拒绝。
  const projectMcpNames = new Set(Object.keys(projectMcp));
  for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) {
    for (const name of Array.isArray(local[key]) ? local[key] : []) {
      if (!projectMcpNames.has(name)) {
        diag("stale", "mcpApproval", name, name,
          "项目 .mcp.json 里已没有这个 server，本地仍保留" + (key === "enabledMcpjsonServers" ? "批准" : "拒绝") + "记录",
          true);
      }
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
    diagnostics,
  };
}

/* ---------------- 记忆文件（只读） ---------------- */

// Claude Code 按工作区路径生成会话目录名：非字母数字一律变 -。
// D:\projects\notes\cc-wrapped → D--projects-notes-cc-wrapped
function memorySlug(ws) {
  return path.resolve(ws).replace(/[^a-zA-Z0-9]/g, "-");
}

/** 从 frontmatter / 一级标题里取展示用的标题与描述。只读文件开头。 */
function readMemoryMeta(file) {
  const base = path.basename(file, ".md");
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 8192);
    let description = "";
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (fm) {
      const line = /^description:\s*(.+)$/m.exec(fm[1]);
      if (line) description = line[1].trim().replace(/^["']|["']$/g, "");
    }
    const h1 = /^#\s+(.+)$/m.exec(head);
    return { title: h1 ? h1[1].trim() : base, description };
  } catch {
    return { title: base, description: "" };
  }
}

/**
 * 收集当前工作区相关的全部记忆文件，只读不改。
 *
 * 三类来源：
 *   auto     ~/.claude/projects/<slug>/memory/*.md（Claude 自己维护）
 *   project  <ws>/CLAUDE.md、<ws>/.claude/CLAUDE.md，以及上级目录链上的 CLAUDE.md
 *   user     ~/.claude/CLAUDE.md
 *
 * 返回的 path 是绝对路径，随后 memoryRead 会重新收集一遍并只认这个白名单，
 * 所以外部无法借这个动作读任意文件。
 */
function collectMemory(ws) {
  const files = [];
  const seen = new Set();

  const push = (source, root, file) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    seen.add(abs);
    const meta = readMemoryMeta(abs);
    // 展示路径：在 root 之内就相对 root，否则相对 HOME（避免三个同名
    // CLAUDE.md 排在一起分不清是工作区里的还是全局的）。
    let rel = path.relative(root, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) {
      const fromHome = path.relative(HOME, abs).replace(/\\/g, "/");
      // 配了 CLAUDE_CONFIG_DIR 时全局文件不在 HOME 下，相对路径会是一串 ..，
      // 这时直接给绝对路径，用户复制去编辑器才打得开。
      rel = fromHome.startsWith("..") ? abs.replace(/\\/g, "/") : "~/" + fromHome;
    }
    files.push({
      source,
      name: path.basename(abs),
      rel,
      path: abs,
      title: meta.title,
      description: meta.description,
      size: st.size,
      mtime: st.mtimeMs,
    });
  };

  // 项目记忆：Claude Code 会从工作区向上逐级读取 CLAUDE.md。
  // 层级限死，避免磁盘根目录上的杂项被算进来。
  let dir = path.resolve(ws);
  for (let depth = 0; depth < 12; depth++) {
    push("project", dir, path.join(dir, "CLAUDE.md"));
    push("project", dir, path.join(dir, ".claude", "CLAUDE.md"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 新版 Claude Code 的项目规则目录，存在就一并列出。
  const rulesDir = path.join(path.resolve(ws), ".claude", "rules");
  try {
    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        push("project", path.resolve(ws), path.join(rulesDir, entry.name));
      }
    }
  } catch {
    // 没有 rules 目录是常态
  }

  push("user", CLAUDE_DIR, path.join(CLAUDE_DIR, "CLAUDE.md"));

  const autoDir = path.join(CLAUDE_DIR, "projects", memorySlug(ws), "memory");
  try {
    for (const entry of fs.readdirSync(autoDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        push("auto", autoDir, path.join(autoDir, entry.name));
      }
    }
  } catch {
    // 这个工作区还没有自动记忆，目录不存在是正常的
  }

  // 自动记忆里 MEMORY.md 是索引，排最前；其余按修改时间倒序。
  const order = { auto: 0, project: 1, user: 2 };
  files.sort((a, b) => {
    if (order[a.source] !== order[b.source]) return order[a.source] - order[b.source];
    if (a.source === "auto") {
      if (a.name === "MEMORY.md") return -1;
      if (b.name === "MEMORY.md") return 1;
      return b.mtime - a.mtime;
    }
    return a.rel.localeCompare(b.rel);
  });

  return {
    ok: true,
    workspace: path.resolve(ws),
    slug: memorySlug(ws),
    autoDir,
    autoExists: files.some((f) => f.source === "auto"),
    files,
  };
}

const MEMORY_READ_LIMIT = 512 * 1024;

function readMemory(ws, target) {
  const list = collectMemory(ws);
  const file = list.files.find((f) => f.path === path.resolve(String(target || "")));
  if (!file) throw new Error("记忆文件不存在，或不在可读范围内");
  const raw = fs.readFileSync(file.path, "utf8");
  // 字节数与列表里的 size 用同一口径（stat 的 size 就是 UTF-8 字节数）；
  // 用 raw.length 会按 UTF-16 计数，中文文件在列表和正文里显示成两个数字。
  const bytes = Buffer.byteLength(raw, "utf8");
  const truncated = bytes > MEMORY_READ_LIMIT;
  let content = raw;
  if (truncated) {
    // 按字符累加字节截断：直接切 Buffer 会把多字节字符拦腰截断，
    // 末尾变成一个乱码替换符。
    let used = 0;
    let cut = 0;
    for (const ch of raw) {
      const size = Buffer.byteLength(ch, "utf8");
      if (used + size > MEMORY_READ_LIMIT) break;
      used += size;
      cut += ch.length;
    }
    content = raw.slice(0, cut);
  }
  return {
    ok: true,
    file: {
      source: file.source,
      name: file.name,
      rel: file.rel,
      path: file.path,
      title: file.title,
      size: file.size,
      truncated,
      content,
    },
  };
}

/**
 * 诊断区的「清理残留」对所有类型都传 state=inherit，审批也一样：
 * inherit 在这里就是「把这两个名单里的这一条删掉」，等价于回到待审批。
 * 统一在这里转一次，清理路径就不用为审批开特例。
 */
function approvalStateForCleanup(state) {
  return state === "inherit" ? "pending" : state;
}

function set(ws, kind, id, state) {
  const localPath = path.join(ws, PROJECT_SETTINGS_REL);
  const current = readForWrite(localPath);
  let next;
  let effective;
  if (kind === "plugin") next = setPluginState(current, id, state);
  else if (kind === "mcp") next = setMcpState(current, id, state);
  else if (kind === "skill") next = setSkillState(current, id, state);
  else if (kind === "mcpApproval") {
    const out = setMcpApproval(current, id, approvalStateForCleanup(state));
    next = out.settings;
    effective = out.effective;
  } else throw new Error("未知类型：" + kind);
  writeJsonAtomic(localPath, next);
  return { ok: true, file: localPath, settings: next, effective };
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
  let next = readForWrite(localPath);
  let applied = 0;
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const { kind, id, state } = op;
    if (kind === "plugin") next = setPluginState(next, id, state);
    else if (kind === "mcp") next = setMcpState(next, id, state);
    else if (kind === "skill") next = setSkillState(next, id, state);
    else if (kind === "mcpApproval") {
      next = setMcpApproval(next, id, approvalStateForCleanup(state)).settings;
    }
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
  if (!action || !ws) throw new Error("用法：config-io.mjs scan <workspace> | set <workspace> <kind> <id> <state> | memory <workspace> | memoryRead <workspace> <file>");
  if (!fs.existsSync(ws)) throw new Error("工作区不存在：" + ws);
  let result = null;
  if (action === "scan") result = scan(ws);
  else if (action === "set") result = set(ws, kind, id, state);
  else if (action === "memory") result = collectMemory(ws);
  else if (action === "memoryRead") result = readMemory(ws, argv[2]);
  if (!result) throw new Error("未知动作：" + action);
  process.stdout.write(JSON.stringify(result));
}

try {
  main();
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
}
