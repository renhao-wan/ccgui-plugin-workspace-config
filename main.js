/* =========================================================================
 * 工作区配置 workspace-config — CC GUI 插件
 *
 * 把「当前工作区」的 Claude Code 配置收进一个面板：MCP / 插件 / 技能
 * 各自一个三态开关（跟随全局 / 启用 / 禁用）。
 *
 * 边界：
 *   - 只写 <workspace>/.claude/settings.local.json
 *   - 从不写 ~/.claude/settings.json 或 ~/.claude.json，CC Switch 的全局配置不受影响
 *   - 新工作区不写任何键，自然继承全局
 *
 * 宿主不提供文件系统 API，读写靠落盘的 config-io.mjs 经 exec:node 执行。
 * ========================================================================= */

const PLUGIN_ID = "workspace-config";
const TAB_KEY = "workspace-config";
const SCRIPT_REL = "runtime/config-io.mjs";
const SETTINGS_KEY = "workspace-config.settings.v1";
const IO_TIMEOUT_MS = 20000;
const SCAN_TIMEOUT_MS = 30000;

/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。
 * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */

const PROJECT_SETTINGS_REL = ".claude/settings.local.json";
const SHARED_SETTINGS_REL = ".claude/settings.json";

const TRI_STATES = ["inherit", "on", "off"];
// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。
const MCP_STATES = ["inherit", "off"];

const has = (obj, key) =>
  obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

/** settings 是 JSON 文档，深拷贝用 JSON 往返即可；不依赖 structuredClone。 */
function cloneSettings(settings) {
  return settings && typeof settings === "object" ? JSON.parse(JSON.stringify(settings)) : {};
}

/** 空键不落盘：面板把某栏全部改回「跟随全局」时，文件里不该留下空对象。 */
function prune(settings) {
  const next = cloneSettings(settings);
  if (next.enabledPlugins && Object.keys(next.enabledPlugins).length === 0) delete next.enabledPlugins;
  if (Array.isArray(next.deniedMcpServers) && next.deniedMcpServers.length === 0) delete next.deniedMcpServers;
  if (next.skillOverrides && Object.keys(next.skillOverrides).length === 0) delete next.skillOverrides;
  return next;
}

function assertState(state, allowed, kind) {
  if (!allowed.includes(state)) {
    throw new Error(`${kind} 不支持的状态：${state}（允许 ${allowed.join(" / ")}）`);
  }
}

/* ------------------------------------------------------------ plugin */

function getPluginState(project, id) {
  if (!has(project.enabledPlugins, id)) return "inherit";
  return project.enabledPlugins[id] === false ? "off" : "on";
}

function setPluginState(project, id, state) {
  assertState(state, TRI_STATES, "plugin");
  const next = cloneSettings(project);
  if (state === "inherit") {
    if (has(next.enabledPlugins, id)) delete next.enabledPlugins[id];
  } else {
    next.enabledPlugins = { ...(next.enabledPlugins || {}), [id]: state === "on" };
  }
  return prune(next);
}

/* ------------------------------------------------------------ mcp */

function getMcpState(project, serverName) {
  const list = project.deniedMcpServers;
  if (!Array.isArray(list)) return "inherit";
  return list.some((entry) => entry && entry.serverName === serverName) ? "off" : "inherit";
}

/** 只增删 serverName 条目；serverCommand / serverUrl 条目原样保留。 */
function setMcpState(project, serverName, state) {
  if (state === "on") {
    throw new Error("MCP 项目级无法显式启用：全局已禁用时不受项目控制，请改用 inherit");
  }
  assertState(state, MCP_STATES, "mcp");
  const next = cloneSettings(project);
  const list = Array.isArray(next.deniedMcpServers) ? next.deniedMcpServers.slice() : [];
  const filtered = list.filter((entry) => !(entry && entry.serverName === serverName));
  if (state === "off") filtered.push({ serverName });
  next.deniedMcpServers = filtered;
  return prune(next);
}

/* ------------------------------------------------------------ skill */

function getSkillState(project, name) {
  if (!has(project.skillOverrides, name)) return "inherit";
  return project.skillOverrides[name] === "off" ? "off" : "on";
}

function setSkillState(project, name, state) {
  assertState(state, TRI_STATES, "skill");
  const next = cloneSettings(project);
  if (state === "inherit") {
    if (has(next.skillOverrides, name)) delete next.skillOverrides[name];
  } else {
    next.skillOverrides = { ...(next.skillOverrides || {}), [name]: state };
  }
  return prune(next);
}

/* ------------------------------------------------------------ 展示用 */

/** 项目覆盖了多少项；panel tab 的徽标数字。 */
function overrideCount(project) {
  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;
  const mcp = Array.isArray(project.deniedMcpServers)
    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length
    : 0;
  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;
  return plugins + mcp + skills;
}

/** 项目态优先；inherit 时回落到全局态。 */
function effectiveState(projectState, globalState) {
  if (projectState && projectState !== "inherit") return projectState;
  return globalState || "unknown";
}


const SCAN_SOURCE = "/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。\n * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */\n\nconst PROJECT_SETTINGS_REL = \".claude/settings.local.json\";\nconst SHARED_SETTINGS_REL = \".claude/settings.json\";\n\nconst TRI_STATES = [\"inherit\", \"on\", \"off\"];\n// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。\nconst MCP_STATES = [\"inherit\", \"off\"];\n\nconst has = (obj, key) =>\n  obj !== null && typeof obj === \"object\" && Object.prototype.hasOwnProperty.call(obj, key);\n\n/** settings 是 JSON 文档，深拷贝用 JSON 往返即可；不依赖 structuredClone。 */\nfunction cloneSettings(settings) {\n  return settings && typeof settings === \"object\" ? JSON.parse(JSON.stringify(settings)) : {};\n}\n\n/** 空键不落盘：面板把某栏全部改回「跟随全局」时，文件里不该留下空对象。 */\nfunction prune(settings) {\n  const next = cloneSettings(settings);\n  if (next.enabledPlugins && Object.keys(next.enabledPlugins).length === 0) delete next.enabledPlugins;\n  if (Array.isArray(next.deniedMcpServers) && next.deniedMcpServers.length === 0) delete next.deniedMcpServers;\n  if (next.skillOverrides && Object.keys(next.skillOverrides).length === 0) delete next.skillOverrides;\n  return next;\n}\n\nfunction assertState(state, allowed, kind) {\n  if (!allowed.includes(state)) {\n    throw new Error(`${kind} 不支持的状态：${state}（允许 ${allowed.join(\" / \")}）`);\n  }\n}\n\n/* ------------------------------------------------------------ plugin */\n\nfunction getPluginState(project, id) {\n  if (!has(project.enabledPlugins, id)) return \"inherit\";\n  return project.enabledPlugins[id] === false ? \"off\" : \"on\";\n}\n\nfunction setPluginState(project, id, state) {\n  assertState(state, TRI_STATES, \"plugin\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.enabledPlugins, id)) delete next.enabledPlugins[id];\n  } else {\n    next.enabledPlugins = { ...(next.enabledPlugins || {}), [id]: state === \"on\" };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ mcp */\n\nfunction getMcpState(project, serverName) {\n  const list = project.deniedMcpServers;\n  if (!Array.isArray(list)) return \"inherit\";\n  return list.some((entry) => entry && entry.serverName === serverName) ? \"off\" : \"inherit\";\n}\n\n/** 只增删 serverName 条目；serverCommand / serverUrl 条目原样保留。 */\nfunction setMcpState(project, serverName, state) {\n  if (state === \"on\") {\n    throw new Error(\"MCP 项目级无法显式启用：全局已禁用时不受项目控制，请改用 inherit\");\n  }\n  assertState(state, MCP_STATES, \"mcp\");\n  const next = cloneSettings(project);\n  const list = Array.isArray(next.deniedMcpServers) ? next.deniedMcpServers.slice() : [];\n  const filtered = list.filter((entry) => !(entry && entry.serverName === serverName));\n  if (state === \"off\") filtered.push({ serverName });\n  next.deniedMcpServers = filtered;\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ skill */\n\nfunction getSkillState(project, name) {\n  if (!has(project.skillOverrides, name)) return \"inherit\";\n  return project.skillOverrides[name] === \"off\" ? \"off\" : \"on\";\n}\n\nfunction setSkillState(project, name, state) {\n  assertState(state, TRI_STATES, \"skill\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.skillOverrides, name)) delete next.skillOverrides[name];\n  } else {\n    next.skillOverrides = { ...(next.skillOverrides || {}), [name]: state };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ 展示用 */\n\n/** 项目覆盖了多少项；panel tab 的徽标数字。 */\nfunction overrideCount(project) {\n  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;\n  const mcp = Array.isArray(project.deniedMcpServers)\n    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length\n    : 0;\n  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;\n  return plugins + mcp + skills;\n}\n\n/** 项目态优先；inherit 时回落到全局态。 */\nfunction effectiveState(projectState, globalState) {\n  if (projectState && projectState !== \"inherit\") return projectState;\n  return globalState || \"unknown\";\n}\n\n/* 子进程：读写项目级 Claude Code 配置。\n *\n * 插件本体拿不到文件系统，只能把这份脚本落盘后经 exec:node 执行。\n * 构建时 scripts/build.mjs 会把 src/lib/model.mjs 的源码内联进来，\n * 所以这里唯一允许的兄弟 import 是 model；其余只能用 node 内置模块。\n *\n * 用法：\n *   node config-io.mjs scan <workspace>\n *   node config-io.mjs set  <workspace> <plugin|mcp|skill> <id> <inherit|on|off>\n * 输出：单行 JSON，ok=false 时附带 error。\n */\n\nimport fs from \"node:fs\";\nimport os from \"node:os\";\nimport path from \"node:path\";\n\nconst HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();\nconst CLAUDE_DIR = path.join(HOME, \".claude\");\nconst CLAUDE_JSON = path.join(HOME, \".claude.json\");\n\nfunction readJson(file) {\n  try {\n    let text = fs.readFileSync(file, \"utf8\");\n    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);\n    return JSON.parse(text);\n  } catch {\n    return null;\n  }\n}\n\nfunction writeJsonAtomic(file, data) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  const tmp = file + \".tmp-\" + process.pid;\n  const body = JSON.stringify(data, null, 2) + \"\\n\";\n  fs.writeFileSync(tmp, body, \"utf8\");\n  fs.renameSync(tmp, file);\n}\n\nconst norm = (p) => String(p || \"\").replace(/\\\\/g, \"/\").replace(/\\/+$/, \"\").toLowerCase();\n\nfunction findProjectEntry(config, ws) {\n  const projects = (config && config.projects) || {};\n  const target = norm(ws);\n  const key = Object.keys(projects).find((k) => norm(k) === target);\n  return key ? projects[key] : null;\n}\n\nfunction listSkillDirs(root, source, plugin) {\n  const out = [];\n  let entries = [];\n  try {\n    entries = fs.readdirSync(root, { withFileTypes: true });\n  } catch {\n    return out;\n  }\n  for (const entry of entries) {\n    if (!entry.isDirectory()) continue;\n    const md = path.join(root, entry.name, \"SKILL.md\");\n    if (!fs.existsSync(md)) continue;\n    out.push({ name: entry.name, source, plugin: plugin || null, path: md, description: readSkillDescription(md) });\n  }\n  return out;\n}\n\nfunction installedPlugins() {\n  const raw = readJson(path.join(CLAUDE_DIR, \"plugins\", \"installed_plugins.json\"));\n  const map = {};\n  const plugins = (raw && raw.plugins) || {};\n  for (const [id, list] of Object.entries(plugins)) {\n    if (!Array.isArray(list) || list.length === 0) continue;\n    const pick = list.find((e) => e && e.scope === \"user\") || list[0];\n    map[id] = {\n      installPath: pick && pick.installPath ? pick.installPath : \"\",\n      scopes: list.map((e) => e && e.scope).filter(Boolean),\n    };\n  }\n  return map;\n}\n\n/** 插件 .mcp.json 有两种写法：{ mcpServers: { name: cfg } } 和扁平的 { name: cfg }。 */\nfunction pluginServers(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return {};\n  const wrapped = cfg.mcpServers || cfg.servers;\n  if (wrapped && typeof wrapped === \"object\") return wrapped;\n  const out = {};\n  for (const [key, value] of Object.entries(cfg)) {\n    if (value && typeof value === \"object\"\n      && (\"command\" in value || \"url\" in value || \"type\" in value)) {\n      out[key] = value;\n    }\n  }\n  return out;\n}\n\n/** 插件描述：优先 .claude-plugin/plugin.json，其次根目录的 plugin.json / manifest.json。 */\nfunction pluginDescription(dir) {\n  if (!dir) return \"\";\n  for (const rel of [\".claude-plugin/plugin.json\", \"plugin.json\", \"manifest.json\"]) {\n    const cfg = readJson(path.join(dir, rel));\n    if (cfg && typeof cfg.description === \"string\" && cfg.description.trim()) {\n      return cfg.description.trim();\n    }\n  }\n  return \"\";\n}\n\n/** SKILL.md frontmatter 里的 description；只读前 50 行。 */\nfunction readSkillDescription(file) {\n  try {\n    const lines = fs.readFileSync(file, \"utf8\").split(/\\r?\\n/).slice(0, 50);\n    if (!lines.length || lines[0].trim() !== \"---\") return \"\";\n    let collecting = false;\n    const block = [];\n    for (let i = 1; i < lines.length; i++) {\n      const line = lines[i];\n      if (line.trim() === \"---\") break;\n      const match = /^description:\\s*(.*)$/.exec(line);\n      if (match) {\n        const value = match[1].trim();\n        if (/^[|>][-+]?$/.test(value)) { collecting = true; continue; }\n        return value.replace(/^[\"']|[\"']$/g, \"\").trim();\n      }\n      if (collecting) {\n        if (/^\\s+\\S/.test(line)) block.push(line.trim());\n        else break;\n      }\n    }\n    return block.join(\" \").trim();\n  } catch {\n    return \"\";\n  }\n}\n\nfunction mcpDescription(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return \"\";\n  if (typeof cfg.url === \"string\") return cfg.url;\n  if (typeof cfg.command === \"string\") {\n    const args = Array.isArray(cfg.args) ? \" \" + cfg.args.join(\" \") : \"\";\n    return (cfg.command + args).trim();\n  }\n  return \"\";\n}\n\nfunction scan(ws) {\n  const globalSettings = readJson(path.join(CLAUDE_DIR, \"settings.json\")) || {};\n  const globalConfig = readJson(CLAUDE_JSON) || {};\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const sharedPath = path.join(ws, SHARED_SETTINGS_REL);\n  const local = readJson(localPath) || {};\n  const shared = readJson(sharedPath) || {};\n\n  // 项目层：local 压过 shared；面板只写 local。\n  const projectLayer = Object.assign({}, shared, local);\n  for (const key of [\"enabledPlugins\", \"skillOverrides\"]) {\n    if (shared[key] || local[key]) {\n      projectLayer[key] = Object.assign({}, shared[key] || {}, local[key] || {});\n    }\n  }\n  if (Array.isArray(shared.deniedMcpServers) || Array.isArray(local.deniedMcpServers)) {\n    projectLayer.deniedMcpServers = [\n      ...(Array.isArray(shared.deniedMcpServers) ? shared.deniedMcpServers : []),\n      ...(Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []),\n    ];\n  }\n\n  /* ---------------- plugins ---------------- */\n\n  const installed = installedPlugins();\n  const pluginIds = new Set(Object.keys(globalSettings.enabledPlugins || {}));\n  for (const id of Object.keys(installed)) pluginIds.add(id);\n\n  const plugins = [];\n  for (const id of [...pluginIds].sort()) {\n    const at = id.lastIndexOf(\"@\");\n    const name = at > 0 ? id.slice(0, at) : id;\n    const marketplace = at > 0 ? id.slice(at + 1) : \"\";\n    const enabled = globalSettings.enabledPlugins && globalSettings.enabledPlugins[id];\n    const globalState = enabled === false ? \"off\" : enabled === true ? \"on\" : \"unknown\";\n    const projectState = getPluginState(projectLayer, id);\n    plugins.push({\n      kind: \"plugin\",\n      id,\n      name,\n      marketplace,\n      installed: Boolean(installed[id]),\n      installPath: installed[id] ? installed[id].installPath : \"\",\n      description: installed[id] ? pluginDescription(installed[id].installPath) : \"\",\n      globalState,\n      projectState,\n      effectiveState: effectiveState(projectState, globalState),\n    });\n  }\n\n  /* ---------------- mcp ---------------- */\n\n  const userMcp = globalConfig.mcpServers || {};\n  const localMcp = (findProjectEntry(globalConfig, ws) || {}).mcpServers || {};\n  const projectMcp = (readJson(path.join(ws, \".mcp.json\")) || {}).mcpServers || {};\n\n  // 插件自带的 MCP：plugin 包里的 .mcp.json，同样能被 deniedMcpServers 拦住。\n  const pluginMcp = {};\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const cfg = readJson(path.join(info.installPath, \".mcp.json\"));\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    for (const [name, value] of Object.entries(pluginServers(cfg))) {\n      if (!(name in pluginMcp)) pluginMcp[name] = { plugin: pluginName, config: value };\n    }\n  }\n\n  const mcpNames = new Set([\n    ...Object.keys(userMcp),\n    ...Object.keys(localMcp),\n    ...Object.keys(projectMcp),\n    ...Object.keys(pluginMcp),\n  ]);\n\n  const globalDenied = Array.isArray(globalSettings.deniedMcpServers)\n    ? globalSettings.deniedMcpServers\n    : [];\n\n  const mcp = [...mcpNames].sort().map((name) => {\n    const scopes = [];\n    if (localMcp[name]) scopes.push(\"local\");\n    if (projectMcp[name]) scopes.push(\"project\");\n    if (userMcp[name]) scopes.push(\"user\");\n    if (pluginMcp[name]) scopes.push(\"plugin\");\n    const deniedGlobally = globalDenied.some((e) => e && e.serverName === name);\n    // local > project > user > plugin 是 Claude Code 的生效顺序\n    const scope = scopes[0] || \"user\";\n    const pluginEntry = pluginMcp[name];\n    const config = localMcp[name] || projectMcp[name] || userMcp[name]\n      || (pluginEntry && pluginEntry.config) || null;\n    const projectState = getMcpState(projectLayer, name);\n    const globalState = deniedGlobally ? \"off\" : \"on\";\n    return {\n      kind: \"mcp\",\n      id: name,\n      name,\n      scope,\n      scopes,\n      plugin: pluginEntry ? pluginEntry.plugin : null,\n      description: mcpDescription(config),\n      globalState,\n      projectState,\n      canEnable: !deniedGlobally,\n      effectiveState: deniedGlobally ? \"off\" : effectiveState(projectState, \"on\"),\n    };\n  });\n\n  /* ---------------- skills ---------------- */\n\n  const skills = [];\n  skills.push(...listSkillDirs(path.join(CLAUDE_DIR, \"skills\"), \"personal\"));\n  skills.push(...listSkillDirs(path.join(ws, \".claude\", \"skills\"), \"project\"));\n\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    skills.push(...listSkillDirs(path.join(info.installPath, \"skills\"), \"plugin\", pluginName));\n  }\n\n  const globalOverrides = globalSettings.skillOverrides || {};\n  const seen = new Map();\n  const skillRows = skills.map((s) => {\n    const globalRaw = globalOverrides[s.name];\n    const globalState = globalRaw === \"off\" ? \"off\" : \"on\";\n    const projectState = getSkillState(projectLayer, s.name);\n    const row = {\n      kind: \"skill\",\n      id: s.name,\n      name: s.name,\n      source: s.source,\n      plugin: s.plugin,\n      description: s.description || \"\",\n      globalState,\n      projectState,\n      effectiveState: effectiveState(projectState, globalState),\n      controllable: s.source !== \"plugin\",\n    };\n    const key = s.name;\n    if (!seen.has(key)) seen.set(key, []);\n    seen.get(key).push(s.source);\n    return row;\n  });\n\n  for (const row of skillRows) {\n    const sources = seen.get(row.name) || [];\n    row.shadowed = row.source === \"personal\" && sources.includes(\"project\");\n    if (row.controllable && sources.length > 1) {\n      row.effectiveSource = sources.includes(\"personal\") ? \"personal\" : \"project\";\n    } else if (!row.controllable) {\n      row.effectiveSource = \"plugin\";\n    } else {\n      row.effectiveSource = row.source;\n    }\n  }\n\n  return {\n    ok: true,\n    workspace: ws,\n    files: { local: localPath, shared: sharedPath },\n    pluginCount: plugins.length,\n    plugins,\n    mcp,\n    skills: skillRows,\n  };\n}\n\nfunction set(ws, kind, id, state) {\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const current = readJson(localPath) || {};\n  let next;\n  if (kind === \"plugin\") next = setPluginState(current, id, state);\n  else if (kind === \"mcp\") next = setMcpState(current, id, state);\n  else if (kind === \"skill\") next = setSkillState(current, id, state);\n  else throw new Error(\"未知类型：\" + kind);\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, settings: next };\n}\n\n/** 一次写完多条：同类型共用一个文件，避免每行起一次子进程。 */\nfunction setMany(ws, opsJson) {\n  let ops;\n  try {\n    ops = JSON.parse(opsJson);\n  } catch {\n    throw new Error(\"批量操作的参数不是合法 JSON\");\n  }\n  if (!Array.isArray(ops) || ops.length === 0) throw new Error(\"批量操作为空\");\n  if (ops.length > 500) throw new Error(\"单次批量操作不能超过 500 项\");\n\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  let next = readJson(localPath) || {};\n  let applied = 0;\n  for (const op of ops) {\n    if (!op || typeof op !== \"object\") continue;\n    const { kind, id, state } = op;\n    if (kind === \"plugin\") next = setPluginState(next, id, state);\n    else if (kind === \"mcp\") next = setMcpState(next, id, state);\n    else if (kind === \"skill\") next = setSkillState(next, id, state);\n    else throw new Error(\"未知类型：\" + kind);\n    applied += 1;\n  }\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, applied, settings: next };\n}\n\nfunction main() {\n  const argv = process.argv.slice(2);\n  const action = argv[0];\n  const ws = argv[1];\n  if (action === \"setMany\") {\n    if (!ws) throw new Error(\"用法：config-io.mjs setMany <workspace> <json>\");\n    if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n    process.stdout.write(JSON.stringify(setMany(ws, argv[2] || \"[]\")));\n    return;\n  }\n  const [, , kind, id, state] = argv;\n  if (!action || !ws) throw new Error(\"用法：config-io.mjs scan <workspace> | set <workspace> <kind> <id> <state>\");\n  if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n  const result = action === \"scan\" ? scan(ws) : action === \"set\" ? set(ws, kind, id, state) : null;\n  if (!result) throw new Error(\"未知动作：\" + action);\n  process.stdout.write(JSON.stringify(result));\n}\n\ntry {\n  main();\n} catch (err) {\n  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));\n  process.exitCode = 1;\n}\n";

const STYLE = `
.wc-root { height: 100%; min-height: 0; position: relative; display: flex; flex-direction: column; color: inherit; background: transparent; font-size: 13px; line-height: 1.5; overflow: hidden; }
.wc-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.16); }
.wc-title { font-size: 13px; font-weight: 600; }
.wc-center .wc-title { font-size: 16px; }
.wc-refresh { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 7px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; cursor: pointer; }
.wc-refresh:disabled { opacity: .55; cursor: default; }
.wc-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 12px 20px; box-sizing: border-box; }
.wc-center .wc-scroll { width: 100%; max-width: none; padding: 0 32px 36px; box-sizing: border-box; }
.wc-page-fixed { flex: none; padding: 0 32px; }
.wc-page-head { display: flex; align-items: center; justify-content: space-between; padding: 22px 0 16px; }
.wc-page-title { font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.wc-page-sub { margin: 0 0 18px; font-size: 12px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-toolbar { display: flex; gap: 10px; margin: 0 0 18px; }
.wc-detail-bar { display: flex; gap: 10px; }
.wc-search { flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 7px 11px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; background: rgba(127,127,127,.04); color: inherit; outline: none; }
.wc-search:focus { border-color: rgba(79,140,255,.5); }
.wc-filter { flex: none; font: inherit; font-size: 12px; padding: 7px 12px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.wc-filter.wc-on { background: rgba(79,140,255,.14); border-color: rgba(79,140,255,.4); font-weight: 600; }
.wc-center .wc-row { padding: 12px 0; }
.wc-center .wc-name { font-size: 14px; }
.wc-center .wc-meta { font-size: 11.5px; }
.wc-center .wc-sec h3 { font-size: 13px; }
.wc-center .wc-card { padding: 0 14px; }
.wc-center .wc-stat-num { font-size: 26px; }
.wc-center-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
.wc-nav { display: flex; flex-direction: column; gap: 2px; }
.wc-nav-item { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font: inherit; font-size: 13px; text-align: left; padding: 9px 12px; border: 0; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.wc-nav-item:hover { background: rgba(127,127,127,.06); }
.wc-nav-item.wc-on { background: rgba(79,140,255,.12); font-weight: 600; }
.wc-nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-nav-count { flex: none; font-size: 11px; opacity: .55; font-weight: 400; }
.wc-detail { min-width: 0; }
@media (max-width: 880px) { .wc-center-layout { grid-template-columns: 1fr; } .wc-nav { position: static; flex-direction: row; overflow-x: auto; } }
.wc-path { margin: 0 0 12px; font-size: 11px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-sec { margin: 14px 0; }
.wc-sec h3 { margin: 0 0 6px 2px; font-size: 12px; font-weight: 600; opacity: .7; }
.wc-tabs { display: flex; gap: 4px; margin: 0 0 10px; padding: 3px; background: rgba(127,127,127,.06); border-radius: 9px; }
.wc-tab { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 6px 4px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wc-tab.wc-on { background: rgba(127,127,127,.16); font-weight: 600; }
.wc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: start; }
@media (max-width: 880px) { .wc-grid { grid-template-columns: 1fr; } }
.wc-card { background: rgba(127,127,127,.055); border: 1px solid rgba(127,127,127,.14); border-radius: 10px; padding: 0 12px; }
.wc-compact .wc-card { padding: 0 10px; }
.wc-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,.12); }
.wc-row:last-child { border-bottom: 0; }
.wc-main { flex: 1; min-width: 0; }
.wc-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-meta { margin-top: 1px; font-size: 11px; opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-desc { margin-top: 2px; font-size: 11.5px; opacity: .68; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.wc-seg { display: flex; flex: none; border: 1px solid rgba(127,127,127,.26); border-radius: 7px; overflow: hidden; background: rgba(127,127,127,.05); }
.wc-btn { font: inherit; font-size: 12px; padding: 5px 10px; border: 0; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.wc-btn + .wc-btn { border-left: 1px solid rgba(127,127,127,.22); }
.wc-btn.wc-on { background: rgba(79,140,255,.16); font-weight: 600; }
.wc-btn:disabled { opacity: .38; cursor: default; }
.wc-badge { flex: none; font-size: 11px; padding: 4px 9px; border-radius: 10px; background: rgba(127,127,127,.14); opacity: .8; }
.wc-empty { margin: 10px 0; font-size: 12px; opacity: .5; }
.wc-err { margin: 8px 0; color: #d9534f; white-space: pre-wrap; }
.wc-note { margin: 8px 0; color: #2f9e44; }
.wc-tip { margin: 18px 0 0; padding-top: 10px; border-top: 1px solid rgba(127,127,127,.14); font-size: 11px; opacity: .65; }
.wc-glyph { display: inline-flex; align-items: center; gap: 4px; width: auto; height: auto; color: inherit; }
.wc-glyph-text { font-size: 11px; font-weight: 500; }
.wc-fold { margin-top: 8px; }
.wc-fold-head { font: inherit; font-size: 12px; width: 100%; text-align: left; padding: 7px 10px; border: 1px solid rgba(127,127,127,.14); border-radius: 9px; background: rgba(127,127,127,.04); color: inherit; cursor: pointer; opacity: .7; }
.wc-fold-head:hover { opacity: 1; }
.wc-pick { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; text-align: left; font: inherit; padding: 9px 0; border: 0; border-bottom: 1px solid rgba(127,127,127,.12); background: transparent; color: inherit; cursor: pointer; }
.wc-pick:last-child { border-bottom: 0; }
.wc-pick:hover { opacity: .8; }
.wc-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; vertical-align: middle; background: rgba(127,127,127,.4); }
.wc-dot.on { background: #37b24d; }
.wc-dot.off { background: rgba(127,127,127,.45); }
.wc-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 18px; }
.wc-stat { padding: 12px 14px; border: 1px solid rgba(127,127,127,.14); border-radius: 10px; background: rgba(127,127,127,.04); }
.wc-stat-num { font-size: 22px; font-weight: 600; line-height: 1.2; }
.wc-stat-label { margin-top: 2px; font-size: 12px; opacity: .6; }
.wc-toast { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 10; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.wc-toast-line { padding: 9px 12px 9px 14px; border-radius: 9px; font-size: 12px; line-height: 1.45; box-shadow: 0 8px 24px rgba(0,0,0,.24); background: rgba(28,28,30,.94); color: #fff; border-left: 3px solid transparent; }
.wc-toast-ok { border-left-color: #37b24d; }
.wc-toast-err { border-left-color: #ff6b6b; }
.wc-settings { padding: 4px 0; font-size: 13px; }
.wc-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.wc-check input { width: 15px; height: 15px; }
.wc-settings-note { margin: 8px 0 0; font-size: 12px; opacity: .6; }
.wc-bulk { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; flex-wrap: wrap; }
.wc-bulk-btn { font: inherit; font-size: 12px; padding: 6px 11px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.wc-bulk-btn:hover:not(:disabled) { background: rgba(127,127,127,.06); }
.wc-bulk-btn:disabled { opacity: .4; cursor: default; }
.wc-bulk-btn.wc-danger { border-color: rgba(217,83,79,.5); color: #c92a2a; }
.wc-bulk-confirm { padding: 8px 11px; border: 1px solid rgba(217,83,79,.35); border-radius: 9px; background: rgba(217,83,79,.06); }
.wc-bulk-text { flex: 1; min-width: 0; font-size: 12px; }
`;

export default function activate(ctx) {
  const { createElement: h, useEffect, useState } = ctx.react;

  const store = { ws: "", data: null, loading: false, error: "", note: "", busy: "", activeKind: "plugin", query: "", onlyOverridden: false, settings: {}, showDesc: false };
  const subs = new Set();

  function set(patch) {
    Object.assign(store, patch);
    for (const fn of subs) fn();
  }

  // 设置可能在用户已经点过开关之后才读回来；以用户那次操作为准。
  let settingsTouched = false;

  async function saveSettings(patch) {
    settingsTouched = true;
    const next = Object.assign({ showDesc: false }, store.settings, patch);
    set({ settings: next, showDesc: Boolean(next.showDesc) });
    try {
      await ctx.storage.set(SETTINGS_KEY, next);
    } catch {
      // 宿主拒绝持久化时保留本次会话内的状态
    }
  }

  void (async () => {
    try {
      const saved = await ctx.storage.get(SETTINGS_KEY);
      if (settingsTouched || !saved || typeof saved !== "object") return;
      set({ settings: saved, showDesc: Boolean(saved.showDesc) });
    } catch {
      // 没有保存过设置时沿用默认值
    }
  })();

  function useStore() {
    const [, force] = useState(0);
    useEffect(() => {
      const fn = () => force((x) => x + 1);
      subs.add(fn);
      return () => { subs.delete(fn); };
    }, []);
    return store;
  }

  const joinPath = (dir, rel) =>
    String(dir).replace(/\\/g, "/").replace(/\/+$/, "") + "/" + rel;

  // 脚本内容没变时不再重写：每次切状态都写一遍磁盘没有必要，
  // 也会让「插件数据目录被外部同步」这类场景出现无谓冲突。
  let scriptReady = false;

  async function ensureScript() {
    if (scriptReady) return;
    const existing = await ctx.documentStorage.readText(SCRIPT_REL);
    if (existing && existing.content === SCAN_SOURCE) {
      scriptReady = true;
      return;
    }
    await ctx.documentStorage.writeTextAtomic(
      SCRIPT_REL,
      SCAN_SOURCE,
      existing ? existing.version : null,
    );
    scriptReady = true;
  }

  async function runIo(args, timeoutMs) {
    await ensureScript();
    const loc = await ctx.documentStorage.getLocation();
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "node",
      args: [joinPath(loc.path, SCRIPT_REL)].concat(args),
      timeoutMs: timeoutMs || IO_TIMEOUT_MS,
    });
    const stdout = String((res && res.stdout) || "").trim();
    const stderr = String((res && res.stderr) || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { parsed = null; }
    if (!parsed) {
      throw new Error("配置脚本没有返回有效结果" + (stderr ? "：" + stderr.slice(0, 300) : ""));
    }
    if (!parsed.ok) throw new Error(parsed.error || "配置脚本执行失败");
    return parsed;
  }

  // 每次扫描递增；只有最后一次发出的请求才允许写回结果。
  // 否则快速切工作区时，先发的慢请求会把后发的结果盖掉。
  let scanSeq = 0;

  async function refresh(ws) {
    if (!ws) return;
    const seq = ++scanSeq;
    set({ loading: true, error: "" });
    try {
      const data = await runIo(["scan", ws], SCAN_TIMEOUT_MS);
      if (seq !== scanSeq) return;
      set({ data, loading: false });
    } catch (err) {
      if (seq !== scanSeq) return;
      set({ loading: false, data: null, error: String((err && err.message) || err) });
    }
  }

  async function apply(row, next) {
    if (!store.ws) return;
    const key = row.kind + ":" + row.id;
    set({ busy: key, error: "", note: "" });
    try {
      await runIo(["set", store.ws, row.kind, row.id, next]);
      await refresh(store.ws);
      set({ note: "已保存。插件改动点 /reload-plugins 生效，MCP 与技能下次会话生效。" });
    } catch (err) {
      set({ error: String((err && err.message) || err) });
    } finally {
      set({ busy: "" });
    }
  }

  /** 批量写：一次子进程落盘全部改动，再刷新一次。 */
  async function applyMany(ops, label) {
    if (!store.ws || !ops.length) return;
    set({ busy: "many", error: "", note: "" });
    try {
      const res = await runIo(["setMany", store.ws, JSON.stringify(ops)]);
      await refresh(store.ws);
      set({ note: label + "：" + (res.applied || ops.length) + " 项已保存。" });
    } catch (err) {
      set({ error: String((err && err.message) || err) });
    } finally {
      set({ busy: "" });
    }
  }

  /* ------------------------------------------------------------ UI */

  // 保存提示用浮层，不参与布局，避免插入/移除时把列表顶来顶去。
  function useAutoClearNote(note) {
    useEffect(() => {
      if (!note) return;
      const timer = setTimeout(() => set({ note: "" }), 3200);
      return () => clearTimeout(timer);
    }, [note]);
  }

  function Toast({ note, error }) {
    if (!note && !error) return null;
    return h("div", { className: "wc-toast" },
      error ? h("div", { className: "wc-toast-line wc-toast-err" }, error) : null,
      note ? h("div", { className: "wc-toast-line wc-toast-ok" }, note) : null
    );
  }

  // 面板页签条很窄，多个插件并排时只容得下图形；名称交给 svg 的 <title>。
  function Glyph(props) {
    return h("svg", {
      width: 14,
      height: 14,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.9,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: props && props.className,
      "aria-hidden": true,
    },
      props && props.title ? h("title", { key: "t" }, props.title) : null,
      h("path", { key: "lines", d: "M4 8h16M4 16h16" }),
      h("circle", { key: "a", cx: 9, cy: 8, r: 2.4, fill: "currentColor", stroke: "none" }),
      h("circle", { key: "b", cx: 15, cy: 16, r: 2.4, fill: "currentColor", stroke: "none" })
    );
  }

  function PanelGlyph(props) {
    return h("span", {
      className: "wc-glyph" + (props && props.className ? " " + props.className : ""),
      "aria-hidden": true,
    },
      h(Glyph, { title: "工作区配置" }),
      h("span", { className: "wc-glyph-text" }, "配置")
    );
  }

  function GlyphOnly(props) {
    return h(Glyph, {
      className: props && props.className,
      title: "工作区配置",
    });
  }

  function view(row) {
    const busy = store.busy === row.kind + ":" + row.id;
    let allowOn = true;
    if (row.kind === "plugin") allowOn = Boolean(row.installed);
    else if (row.kind === "mcp") allowOn = Boolean(row.canEnable);
    return Object.assign({}, row, { busy, allowOn });
  }

  function metaOf(row) {
    if (row.kind === "plugin") {
      const g = row.globalState === "on" ? "全局启用" : row.globalState === "off" ? "全局禁用" : "全局未记录";
      return ["插件", row.marketplace || "未知市场", g, row.installed ? "" : "未安装"]
        .filter(Boolean).join(" · ");
    }
    if (row.kind === "mcp") {
      const g = row.globalState === "off" ? "全局已禁用" : "全局可用";
      const src = row.scope === "plugin"
        ? "继承自插件 " + (row.plugin || "内置")
        : "继承 " + row.scope;
      return ["MCP", src, g].join(" · ");
    }
    const src = row.source === "plugin"
      ? "插件 " + (row.plugin || "")
      : row.source === "personal" ? "个人" : "项目";
    const g = row.globalState === "off" ? "全局禁用" : "全局可用";
    return ["技能", src, g, row.shadowed ? "同名个人版优先" : ""].filter(Boolean).join(" · ");
  }

  function Seg({ row, compact }) {
    const opts = row.kind === "mcp"
      ? [[compact ? "跟随" : "跟随全局", "inherit"], [compact ? "关闭" : "项目禁用", "off"]]
      : [
          [compact ? "跟随" : "跟随全局", "inherit"],
          [compact ? "开" : "启用", "on"],
          [compact ? "关" : "禁用", "off"],
        ];
    return h("div", { className: "wc-seg" },
      opts.map(([label, value]) =>
        h("button", {
          key: value,
          type: "button",
          className: "wc-btn" + (row.projectState === value ? " wc-on" : ""),
          disabled: row.busy || (value === "on" && !row.allowOn),
          title: value === "on" && !row.allowOn
            ? "当前无法启用"
            : value === "inherit" ? "不写项目配置，沿用全局" : undefined,
          onClick: () => {
            if (row.busy || row.projectState === value) return;
            void apply(row, value);
          },
        }, label)
      )
    );
  }

  function effectiveLabel(row) {
    if (row.effectiveState === "on") return "生效：开";
    if (row.effectiveState === "off") return "生效：关";
    return "生效：未知";
  }

  function Row({ row, compact, showDesc }) {
    const v = view(row);
    const locked = row.kind === "skill" && row.controllable === false;
    return h("div", { className: "wc-row" },
      h("div", { className: "wc-main" },
        h("div", { className: "wc-name" },
          h("span", {
            className: "wc-dot " + (row.effectiveState === "on" ? "on" : "off"),
            title: effectiveLabel(row),
            "aria-label": effectiveLabel(row),
          }),
          row.name
        ),
        h("div", { className: "wc-meta" }, metaOf(row)),
        showDesc && row.description
          ? h("div", { className: "wc-desc", title: row.description }, row.description)
          : null
      ),
      locked
        ? h("span", {
            className: "wc-badge",
            title: "这个技能随插件加载，不能单独关闭；要禁用它，请在「插件」里关闭 "
              + (row.plugin || "所属插件"),
          }, "随插件")
        : h(Seg, { row: v, compact })
    );
  }

  function BulkBar({ rows, filtered, busy }) {
    const [confirming, setConfirming] = useState("");
    const overridden = rows.filter((row) => row.projectState !== "inherit");

    if (!confirming) {
      return h("div", { className: "wc-bulk" },
        h("button", {
          type: "button",
          className: "wc-bulk-btn",
          disabled: busy || filtered.length === 0,
          title: "把当前筛选出的项全部设为项目禁用",
          onClick: () => setConfirming("disable"),
        }, "批量禁用（" + filtered.length + "）"),
        h("button", {
          type: "button",
          className: "wc-bulk-btn",
          disabled: busy || overridden.length === 0,
          title: "清空本类别在当前项目的全部覆盖",
          onClick: () => setConfirming("reset"),
        }, "全部恢复跟随（" + overridden.length + "）")
      );
    }

    const isReset = confirming === "reset";
    const count = isReset ? overridden.length : filtered.filter((r) => r.controllable !== false).length;
    return h("div", { className: "wc-bulk wc-bulk-confirm" },
      h("span", { className: "wc-bulk-text" },
        isReset
          ? "把本类别 " + count + " 项恢复为跟随全局？"
          : "把当前筛选的 " + count + " 项设为项目禁用？"),
      h("button", {
        type: "button",
        className: "wc-bulk-btn wc-danger",
        disabled: busy,
        onClick: () => {
          const ops = isReset
            ? overridden.map((row) => ({ kind: row.kind, id: row.id, state: "inherit" }))
            : filtered
                .filter((r) => r.controllable !== false)
                .map((row) => ({ kind: row.kind, id: row.id, state: "off" }));
          setConfirming("");
          void applyMany(ops, isReset ? "已恢复跟随" : "已批量禁用");
        },
      }, "确认"),
      h("button", {
        type: "button",
        className: "wc-bulk-btn",
        onClick: () => setConfirming(""),
      }, "取消")
    );
  }

  function Stats({ data }) {
    const groups = [
      { label: "插件", rows: data.plugins || [] },
      { label: "MCP", rows: data.mcp || [] },
      { label: "技能", rows: data.skills || [] },
    ];
    return h("div", { className: "wc-stats" },
      groups.map((g) => {
        const covered = g.rows.filter((row) => row.projectState !== "inherit").length;
        return h("div", { className: "wc-stat", key: g.label },
          h("div", { className: "wc-stat-num" }, g.rows.length),
          h("div", { className: "wc-stat-label" },
            g.label + (covered ? " · 项目覆盖 " + covered : " · 全部跟随全局"))
        );
      })
    );
  }

  function rowKey(row) {
    return row.kind + ":" + row.id + ":" + (row.source || "");
  }

  // 开 > 关 > 跟随全局（生效开在前、生效关在后）> 由插件控制 / 继承自插件；同级按名称。
  function sortRows(rows) {
    const rank = (row) => {
      if (row.controllable === false) return 4;
      if (row.projectState === "on") return 0;
      if (row.projectState === "off") return 1;
      // 纯插件来源的 MCP 归到最后一档；若已被项目关闭，仍按「关」排前面。
      if (row.kind === "mcp" && row.scope === "plugin") return 4;
      return row.effectiveState === "on" ? 2 : 3;
    };
    return rows.slice().sort(
      (a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)),
    );
  }

  function Section({ title, rows, empty, compact, hideTitle, foldLocked, showDesc }) {
    const [foldOpen, setFoldOpen] = useState(false);
    const sorted = sortRows(rows);
    const main = foldLocked ? sorted.filter((row) => row.controllable !== false) : sorted;
    const locked = foldLocked ? sorted.filter((row) => row.controllable === false) : [];
    return h("section", { className: "wc-sec" },
      hideTitle ? null : h("h3", null, title),
      h("div", { className: "wc-card" },
        main.length === 0
          ? h("p", { className: "wc-empty" }, empty)
          : main.map((row) => h(Row, { key: rowKey(row), row, compact, showDesc }))
      ),
      locked.length > 0
        ? h("div", { className: "wc-fold" },
            h("button", {
              type: "button",
              className: "wc-fold-head",
              onClick: () => setFoldOpen((v) => !v),
            }, (foldOpen ? "▾ " : "▸ ") + "插件提供的技能（" + locked.length + "）"),
            foldOpen
              ? h("div", { className: "wc-card", style: { marginTop: 6 } },
                  locked.map((row) => h(Row, { key: rowKey(row), row, compact, showDesc })))
              : null
          )
        : null
    );
  }

  function SettingsSection() {
    const s = useStore();
    return h("div", { className: "wc-settings" },
      h("label", { className: "wc-check" },
        h("input", {
          type: "checkbox",
          checked: Boolean(s.showDesc),
          onChange: (e) => { void saveSettings({ showDesc: e.target.checked }); },
        }),
        "在列表中显示描述"
      ),
      h("p", { className: "wc-settings-note" },
        "描述只在中央「工作区配置」里显示，右侧面板始终简洁。")
    );
  }

  function BodyHead({ data, s }) {
    const groups = [
      { key: "plugin", title: "插件", rows: data.plugins || [] },
      { key: "mcp", title: "MCP", rows: data.mcp || [] },
      { key: "skill", title: "技能", rows: data.skills || [] },
    ];
    return h("div", { className: "wc-body" },
      h("p", { className: "wc-page-sub", title: data.workspace },
        "工作区：" + data.workspace + " · 只影响当前工作区，全局配置由 CC Switch 管理。"),
      h(Stats, { data }),
      h("div", { className: "wc-center-layout" },
        h("nav", { className: "wc-nav" },
          groups.map((g) => {
            const covered = g.rows.filter((row) => row.projectState !== "inherit").length;
            return h("button", {
              key: g.key,
              type: "button",
              className: "wc-nav-item" + (s.activeKind === g.key ? " wc-on" : ""),
              onClick: () => set({ activeKind: g.key }),
            },
              h("span", { className: "wc-nav-label" }, g.title),
              h("span", { className: "wc-nav-count" },
                String(g.rows.length) + (covered ? " · " + covered + " 覆盖" : ""))
            );
          })
        ),
        h("div", { className: "wc-detail-bar" },
          h("input", {
            className: "wc-search",
            type: "search",
            placeholder: "搜索当前类别",
            value: s.query || "",
            onChange: (e) => set({ query: e.target.value }),
          }),
          h("button", {
            type: "button",
            className: "wc-filter" + (s.onlyOverridden ? " wc-on" : ""),
            onClick: () => set({ onlyOverridden: !s.onlyOverridden }),
          }, "只看项目覆盖")
        )
      )
    );
  }

  function Body({ mode, part }) {
    const s = useStore();
    if (!s.data) {
      if (part === "list") return null;
      return h("div", { className: "wc-body" },
        s.loading
          ? h("p", { className: "wc-empty" }, "读取中…")
          : h("p", { className: "wc-empty" }, "打开一个工作区后自动读取。")
      );
    }
    const data = s.data;
    const groups = [
      { key: "plugin", title: "插件", rows: data.plugins || [], empty: "没有可管理的插件", fold: false },
      { key: "mcp", title: "MCP", rows: data.mcp || [], empty: "没有继承到 MCP 服务器", fold: false },
      { key: "skill", title: "技能", rows: data.skills || [], empty: "没有发现技能", fold: true },
    ];
    const tip = h("p", { className: "wc-tip" },
      "只写项目级 .claude/settings.local.json；全局配置不受影响。");

    if (mode === "center") {
      if (part === "head") return h(BodyHead, { data, s });
      const q = String(s.query || "").trim().toLowerCase();
      const only = Boolean(s.onlyOverridden);
      const visible = (rows) => rows.filter((row) =>
        (!q || String(row.name).toLowerCase().includes(q)) &&
        (!only || row.projectState !== "inherit")
      );
      const active = groups.some((g) => g.key === s.activeKind) ? s.activeKind : "plugin";
      const current = groups.find((g) => g.key === active);
      return h("div", { className: "wc-body" },
        h("div", { className: "wc-detail" },
          h(BulkBar, {
            rows: current.rows,
            filtered: visible(current.rows),
            busy: s.busy === "many",
          }),
          h(Section, {
            title: current.title + "（" + current.rows.length + "）",
            rows: visible(current.rows),
            empty: q || only ? "没有匹配的项" : current.empty,
            compact: false,
            foldLocked: current.fold,
            showDesc: s.showDesc,
          })
        ),
        tip
      );
    }

    const active = groups.some((g) => g.key === s.activeKind) ? s.activeKind : "plugin";
    const current = groups.find((g) => g.key === active);
    return h("div", { className: "wc-body" },
      h("p", { className: "wc-path", title: data.workspace }, "工作区：" + data.workspace),
      h("div", { className: "wc-tabs" },
        groups.map((g) => h("button", {
          key: g.key,
          type: "button",
          className: "wc-tab" + (active === g.key ? " wc-on" : ""),
          onClick: () => set({ activeKind: g.key }),
        }, g.title + "（" + g.rows.length + "）"))
      ),
      h(Section, {
        title: current.title,
        rows: current.rows,
        empty: current.empty,
        compact: true,
        hideTitle: true,
        foldLocked: current.fold,
        showDesc: false,
      }),
      tip
    );
  }

  function Head({ s, onRefresh }) {
    return h("div", { className: "wc-head" },
      h("div", { className: "wc-title" }, "工作区配置"),
      h("button", {
        type: "button",
        className: "wc-refresh",
        disabled: s.loading,
        onClick: onRefresh,
      }, s.loading ? "读取中…" : "刷新")
    );
  }

  function Panel({ workspacePath }) {
    const s = useStore();
    useAutoClearNote(s.note);
    useEffect(() => {
      const ws = workspacePath || "";
      set({ ws, data: null, error: "", note: "" });
      if (ws) void refresh(ws);
    }, [workspacePath]);
    return h("div", { className: "wc-root wc-compact" },
      h(Head, { s, onRefresh: () => refresh(workspacePath || s.ws) }),
      h("div", { className: "wc-scroll" },
        h(Body, { mode: "panel" })
      ),
      h(Toast, { note: s.note, error: s.error })
    );
  }

  function Center() {
    const s = useStore();
    useAutoClearNote(s.note);
    const [spaces, setSpaces] = useState(null);
    const [pickError, setPickError] = useState("");

    useEffect(() => {
      if (s.ws) return;
      let alive = true;
      (async () => {
        try {
          const rows = ctx.workspaces && typeof ctx.workspaces.list === "function"
            ? await ctx.workspaces.list()
            : [];
          if (alive) setSpaces(Array.isArray(rows) ? rows : []);
        } catch (err) {
          if (alive) setPickError(String((err && err.message) || err));
        }
      })();
      return () => { alive = false; };
    }, [s.ws]);

    if (!s.ws) {
      return h("div", { className: "wc-root wc-center" },
        h(Head, { s, onRefresh: () => {} }),
        h("div", { className: "wc-scroll" },
          h("p", { className: "wc-empty" }, "选择一个工作区："),
          spaces === null
            ? h("p", { className: "wc-empty" }, "读取中…")
            : spaces.length === 0
              ? h("p", { className: "wc-empty" }, "没有已登记的工作区；先在侧栏打开一个目录。")
              : h("div", { className: "wc-card" },
                  spaces.map((row) => h("button", {
                    key: row.id || row.path,
                    type: "button",
                    className: "wc-pick",
                    onClick: () => {
                      if (!row.path) return;
                      set({ ws: row.path, data: null, error: "", note: "" });
                      void refresh(row.path);
                    },
                  },
                    h("span", { className: "wc-name" }, row.path),
                    h("span", { className: "wc-meta" }, row.kind || "")
                  ))),
          pickError ? h("p", { className: "wc-err" }, pickError) : null
        )
      );
    }

    return h("div", { className: "wc-root wc-center" },
      h("div", { className: "wc-page-head" },
        h("div", { className: "wc-page-title" }, "工作区配置"),
        h("button", {
          type: "button",
          className: "wc-refresh",
          disabled: s.loading,
          onClick: () => { if (s.ws) void refresh(s.ws); },
        }, s.loading ? "读取中…" : "刷新")
      ),
      h("div", { className: "wc-page-fixed" },
        h(Body, { mode: "center", part: "head" })
      ),
      h("div", { className: "wc-scroll wc-center-scroll" },
        h(Body, { mode: "center", part: "list" })
      ),
      h(Toast, { note: s.note, error: s.error })
    );
  }

  ctx.theme.injectCss(STYLE);

  const disposers = [
    ctx.ui.registerPanelTab({
      key: TAB_KEY,
      label: () => "工作区配置",
      icon: PanelGlyph,
      component: Panel,
      order: 60,
    }),
    ctx.ui.registerCenterTab({
      key: TAB_KEY,
      title: () => "工作区配置",
      icon: GlyphOnly,
      component: Center,
      order: 60,
    }),
    ctx.ui.registerSidebarNav({
      key: PLUGIN_ID,
      label: () => "工作区配置",
      icon: GlyphOnly,
      order: 60,
      onOpen: () => { ctx.ui.openCenterTab(TAB_KEY); },
    }),
    ctx.ui.registerCommand({
      key: PLUGIN_ID,
      title: () => "工作区配置：打开当前工作区配置",
      keywords: () => ["工作区", "配置", "workspace", "config", "mcp", "plugin", "skill"],
      run: () => { ctx.ui.openCenterTab(TAB_KEY); },
    }),
    ctx.ui.registerSettingsSection({
      key: "settings",
      label: () => "工作区配置",
      icon: GlyphOnly,
      component: SettingsSection,
    }),
  ];

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 宿主可能已回收 */ }
    }
    subs.clear();
  };
}
