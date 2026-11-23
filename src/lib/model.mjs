/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。
 * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */

export const PROJECT_SETTINGS_REL = ".claude/settings.local.json";
export const SHARED_SETTINGS_REL = ".claude/settings.json";

export const TRI_STATES = ["inherit", "on", "off"];
// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。
export const MCP_STATES = ["inherit", "off"];

const has = (obj, key) =>
  obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

/** settings 是 JSON 文档，深拷贝用 JSON 往返即可；不依赖 structuredClone。 */
export function cloneSettings(settings) {
  return settings && typeof settings === "object" ? JSON.parse(JSON.stringify(settings)) : {};
}

/** 空键不落盘：面板把某栏全部改回「跟随全局」时，文件里不该留下空对象。 */
export function prune(settings) {
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

export function getPluginState(project, id) {
  if (!has(project.enabledPlugins, id)) return "inherit";
  return project.enabledPlugins[id] === false ? "off" : "on";
}

export function setPluginState(project, id, state) {
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

export function getMcpState(project, serverName) {
  const list = project.deniedMcpServers;
  if (!Array.isArray(list)) return "inherit";
  return list.some((entry) => entry && entry.serverName === serverName) ? "off" : "inherit";
}

/** 只增删 serverName 条目；serverCommand / serverUrl 条目原样保留。 */
export function setMcpState(project, serverName, state) {
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

export function getSkillState(project, name) {
  if (!has(project.skillOverrides, name)) return "inherit";
  return project.skillOverrides[name] === "off" ? "off" : "on";
}

export function setSkillState(project, name, state) {
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
export function overrideCount(project) {
  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;
  const mcp = Array.isArray(project.deniedMcpServers)
    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length
    : 0;
  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;
  return plugins + mcp + skills;
}

/** 项目态优先；inherit 时回落到全局态。 */
export function effectiveState(projectState, globalState) {
  if (projectState && projectState !== "inherit") return projectState;
  return globalState || "unknown";
}
