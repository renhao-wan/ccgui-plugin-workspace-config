/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。
 * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */

export const PROJECT_SETTINGS_REL = ".claude/settings.local.json";
export const SHARED_SETTINGS_REL = ".claude/settings.json";

export const TRI_STATES = ["inherit", "on", "off"];
// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。
export const MCP_STATES = ["inherit", "off"];
// 技能官方是四态（code.claude.com/docs/en/skills）：
//   on                  名称和描述都给 Claude
//   name-only           只给名称，省掉描述
//   user-invocable-only 对 Claude 隐藏，只留 / 菜单手动调用
//   off                 两边都隐藏
// 后两者不是「禁用」，早先按 on 处理会在用户点「启用」时把原值改写掉。
export const SKILL_VALUES = ["on", "name-only", "user-invocable-only", "off"];
export const SKILL_STATES = ["inherit"].concat(SKILL_VALUES);

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
  // 项目 .mcp.json 的逐个审批名单，Claude Code 也写在这份文件里。
  if (Array.isArray(next.enabledMcpjsonServers) && next.enabledMcpjsonServers.length === 0) delete next.enabledMcpjsonServers;
  if (Array.isArray(next.disabledMcpjsonServers) && next.disabledMcpjsonServers.length === 0) delete next.disabledMcpjsonServers;
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
  const value = project.skillOverrides[name];
  // 未知取值原样返回，交给界面显示成「其它」并只读；猜成 on 会误导，
  // 而且后续任何一次写入都会把它覆盖掉。
  return SKILL_VALUES.includes(value) ? value : "unknown";
}

export function setSkillState(project, name, state) {
  // 只拒绝面板自己不认识的值；unknown 是读取态，不是可写状态。
  assertState(state, SKILL_STATES, "skill");
  const next = cloneSettings(project);
  if (state === "inherit") {
    if (has(next.skillOverrides, name)) delete next.skillOverrides[name];
  } else {
    next.skillOverrides = { ...(next.skillOverrides || {}), [name]: state };
  }
  return prune(next);
}

/* ------------------------------------------------------------ 项目 .mcp.json 审批 */

// Claude Code 把项目 .mcp.json 里 server 的审批结果写在 .claude/settings.local.json
// （和本插件同一个文件），三个键：
//   enableAllProjectMcpServers: true   全部批准，不再弹窗
//   enabledMcpjsonServers: [name…]     逐个批准
//   disabledMcpjsonServers: [name…]    逐个拒绝；优先级高于前两者
// 未出现在任何名单里且没开「全部批准」时，server 是待审批状态：不连、界面上不该显示成生效。

export function getMcpApproval(project, serverName) {
  const disabled = Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers : [];
  if (disabled.includes(serverName)) return "rejected";
  const enabled = Array.isArray(project.enabledMcpjsonServers) ? project.enabledMcpjsonServers : [];
  if (enabled.includes(serverName)) return "approved";
  if (project.enableAllProjectMcpServers === true) return "approved";
  return "pending";
}

/**
 * 只改这一个 server 的审批结果，不动「全部批准」这个总开关。
 *
 * 传 "pending" 表示从两个名单里都移除。注意：如果 enableAllProjectMcpServers
 * 已是 true，移除后仍然是 approved——这是 Claude Code 的语义，不是这里能改的，
 * 所以界面要据此提示。返回里带上生效结果，调用方可直接显示。
 */
export function setMcpApproval(project, serverName, state) {
  assertState(state, ["approved", "rejected", "pending"], "mcp 审批");
  const next = cloneSettings(project);
  const pick = (list) => (Array.isArray(list) ? list.filter((n) => n !== serverName) : []);
  const enabled = pick(next.enabledMcpjsonServers);
  const disabled = pick(next.disabledMcpjsonServers);
  if (state === "approved") enabled.push(serverName);
  else if (state === "rejected") disabled.push(serverName);
  if (enabled.length) next.enabledMcpjsonServers = enabled;
  else delete next.enabledMcpjsonServers;
  if (disabled.length) next.disabledMcpjsonServers = disabled;
  else delete next.disabledMcpjsonServers;
  // 总开关开着时「待审批」无法靠单个名单实现，如实回报，让界面说明原因。
  const blockedByAll = state === "pending" && next.enableAllProjectMcpServers === true;
  return { settings: prune(next), effective: blockedByAll ? "approved" : state };
}

/* ------------------------------------------------------------ 展示用 */

/** 项目覆盖了多少项；panel tab 的徽标数字。 */
export function overrideCount(project) {
  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;
  const mcp = Array.isArray(project.deniedMcpServers)
    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length
    : 0;
  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;
  const approvals = (Array.isArray(project.enabledMcpjsonServers) ? project.enabledMcpjsonServers.length : 0)
    + (Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers.length : 0)
    + (project.enableAllProjectMcpServers === true ? 1 : 0);
  return plugins + mcp + skills + approvals;
}

/** 项目态优先；inherit 时回落到全局态。 */
export function effectiveState(projectState, globalState) {
  if (projectState && projectState !== "inherit") return projectState;
  return globalState || "unknown";
}
