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

// 反馈渠道。endpoint 必须与 manifest 的 network:<host> 逐字一致。
const FEEDBACK_ENDPOINT = "https://ccgui-feedback.2653990378.workers.dev";
const FEEDBACK_REPO = "renhao-wan/ccgui-plugin-workspace-config";
const FEEDBACK_PLUGIN_NAME = "工作区配置";
const FEEDBACK_TIMEOUT_MS = 15000;

/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。
 * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */

const PROJECT_SETTINGS_REL = ".claude/settings.local.json";
const SHARED_SETTINGS_REL = ".claude/settings.json";

const TRI_STATES = ["inherit", "on", "off"];
// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。
const MCP_STATES = ["inherit", "off"];
// 技能官方是四态（code.claude.com/docs/en/skills）：
//   on                  名称和描述都给 Claude
//   name-only           只给名称，省掉描述
//   user-invocable-only 对 Claude 隐藏，只留 / 菜单手动调用
//   off                 两边都隐藏
// 后两者不是「禁用」，早先按 on 处理会在用户点「启用」时把原值改写掉。
const SKILL_VALUES = ["on", "name-only", "user-invocable-only", "off"];
const SKILL_STATES = ["inherit"].concat(SKILL_VALUES);

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
  const value = project.skillOverrides[name];
  // 未知取值原样返回，交给界面显示成「其它」并只读；猜成 on 会误导，
  // 而且后续任何一次写入都会把它覆盖掉。
  return SKILL_VALUES.includes(value) ? value : "unknown";
}

function setSkillState(project, name, state) {
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
//
// 还有一层别处管不到：工作区没被信任时（~/.claude.json 的 projects[ws]
// .hasTrustDialogAccepted 不为 true），**批准一律不生效**，仍然停在待审批；
// 拒绝不受影响。这条是 2026-11-24 用 claude 2.1.319 实测确认的。

function getMcpApproval(project, serverName) {
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
function setMcpApproval(project, serverName, state) {
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

/**
 * server 到底连没连上，以及卡在哪一层。返回 null 表示确实会连接。
 *
 * 五道闸按 Claude Code 的判定顺序排列（2026-11-24 用 2.1.319 实测）：
 *   global-denied   ~/.claude/settings.json 的 deniedMcpServers（对象格式才生效）
 *   project-denied  本项目 deniedMcpServers
 *   rejected        项目 .mcp.json 的拒绝，任何情况下都生效
 *   pending         还没批准
 *   untrusted       批准了，但工作区没被信任 —— 批准不生效，仍停在待审批
 *   runtime-disabled /mcp 里手动关掉的（~/.claude.json 项目条目的 disabledMcpServers）
 */
function mcpBlockReason({ globalDenied, projectDenied, approval, trusted, runtimeDisabled }) {
  if (globalDenied) return "global-denied";
  if (projectDenied) return "project-denied";
  if (approval === "rejected") return "rejected";
  if (approval === "pending") return "pending";
  // 未信任时 Claude Code 连「已批准」都不认，这是最容易漏的一层：
  // 面板写批准、文件里也确实写着批准，实际却还是待审批。
  // 只挡批准这一侧——没有审批可挡的 server（user/local/plugin 来源）不受影响，
  // 否则 !undefined 会把它们全部误判成未信任。
  if (approval === "approved" && !trusted) return "untrusted";
  // /mcp 的手动开关（disabledMcpServers）同样录在 ~/.claude.json 的项目条目里，
  // 未信任时 Claude Code 根本不看它，这里也就不能据此说「被关了」。
  if (runtimeDisabled && trusted) return "runtime-disabled";
  return null;
}

/* ------------------------------------------------------------ 展示用 */

/** 项目覆盖了多少项；panel tab 的徽标数字。 */
function overrideCount(project) {
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
function effectiveState(projectState, globalState) {
  if (projectState && projectState !== "inherit") return projectState;
  return globalState || "unknown";
}

// ---- ccgui-plugin-shared/feedback.mjs ----
/**
 * 反馈渠道的纯函数层：正文归一化、Issue 链接拼装、请求体收敛、响应文案。
 *
 * 全部离线可测。网络与 UI 在 main.head.js 里，这一层只回答「发什么」和
 * 「回什么」，方便把隐私边界钉死在测试里：请求体只允许五个字段。
 */

/** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
const TEXT_LIMIT = 1000;

/**
 * 收敛用户输入：去控制字符、统一换行、折叠连续空行与行尾空白、限长。
 * 保留大小写、中文、emoji 与**换行**——用户最常贴的就是报错日志，
 * 压成一行后堆栈就没法看了。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normaliseFeedbackText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    // 先统一换行，再剥控制字符（保留 \n）。制表符换成空格——堆栈缩进有用。
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f�]/g, "")
    // 只去行尾空白与整段的首尾空白。**正文内行首缩进要留着**：
    // 报错堆栈靠它对齐，去掉后 `at fetchTrending` 就和日志正文混在一起了。
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/, "")
    // 三个以上连续换行压成两个（一段空行），既保留分段又不留大片空白。
    .replace(/\n{3,}/g, "\n\n")
    // 首尾空行去掉。
    .replace(/^\n+|\n+$/g, "")
    .slice(0, TEXT_LIMIT)
    .replace(/[ \t\n]+$/, "");
}

/**
 * GitHub 新建 Issue 的预填链接。
 *
 * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
 * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
 *
 * @param {{repo: string, pluginName: string, text: string, pluginVersion: string, hostVersion: string}} o
 * @returns {string}
 */
function buildIssueUrl(o) {
  const text = normaliseFeedbackText(o.text);
  const body = [
    text || "_（请在这里描述问题或建议）_",
    "",
    "---",
    "插件：" + String(o.pluginName || "") + " " + String(o.pluginVersion || ""),
    "CC GUI：" + String(o.hostVersion || ""),
  ].join("\n");
  const q = new URLSearchParams({
    title: "[反馈] " + String(o.pluginName || ""),
    body,
  });
  return "https://github.com/" + String(o.repo || "") + "/issues/new?" + q.toString();
}

/** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
const PAYLOAD_FIELDS = ["text", "pluginId", "pluginVersion", "hostVersion", "ts"];

/**
 * 组装发往中转的请求体，只保留白名单字段。
 *
 * @param {object} o
 * @returns {{text: string, pluginId: string, pluginVersion: string, hostVersion: string, ts: number}}
 */
function buildFeedbackPayload(o) {
  const src = {
    text: normaliseFeedbackText(o.text),
    pluginId: String(o.pluginId || ""),
    pluginVersion: String(o.pluginVersion || ""),
    hostVersion: String(o.hostVersion || ""),
    ts: Number(o.now) || Date.now(),
  };
  const out = {};
  for (const k of PAYLOAD_FIELDS) out[k] = src[k];
  return out;
}

function parseJson(body) {
  if (typeof body !== "string" || !body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把服务端给的额度字段收敛成 `number | null`。
 *
 * **别用 `Number.isFinite(Number(v))`**：`Number(null)` 与 `Number("")` 都是 0，
 * 于是「中转没带这个字段」会被读成「今天 0 条额度」，界面就对刚发送成功的
 * 用户说「今天的额度已用完」。这里只认真正的数字与非空数字字符串。
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function quotaCount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 发送成功后更新界面上的剩余额度。
 *
 * 服务端回传的额度优先（顺手纠正「暂时连不上」）；没给就按本地旧值自减
 * 一条，旧值也没有就原样保留。纯函数，单测钉住「别把 null 读成 0」。
 *
 * @param {{remaining?: number, dailyLimit?: number, offline?: boolean}|null} prev
 * @param {unknown} fromServer 服务端回传的 remaining
 * @returns {object|null}
 */
function nextQuota(prev, fromServer) {
  const n = quotaCount(fromServer);
  const fallback = normalizeFallback(prev);
  if (n !== null) {
    return { remaining: n, dailyLimit: (prev && prev.dailyLimit) || 1, fallbackRemaining: fallback };
  }
  const prevRemaining = prev && typeof prev.remaining === "number" ? prev.remaining : null;
  if (prevRemaining === null) return prev;
  return {
    remaining: Math.max(0, prevRemaining - 1),
    dailyLimit: prev.dailyLimit || 1,
    fallbackRemaining: fallback,
  };
}

/** 兜底额度字段的收敛：不是数字就当未知（null），避免 NaN 漏到界面。 */
function normalizeFallback(prev) {
  const v = quotaCount(prev && prev.fallbackRemaining);
  return v === null ? null : Math.max(0, v);
}

/**
 * 把一次中转响应翻译成界面文案。
 *
 * 一条原则：**永远给出「你还能做什么」**。反馈发不出去不是用户的错，
 * 所以每条失败文案都要么说清原因，要么指向还能走的路（GitHub Issue）。
 * 泛泛一句「发送失败」等于让用户卡死在这里。
 *
 * @param {{status?: number, body?: string, error?: Error}} r
 * @returns {{ok: boolean, kind: string, message: string, remaining: number|null}}
 */
function describeFeedbackResult(r) {
  if (r && r.error) {
    const raw = String(r.error.message || r.error);
    if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) {
      return {
        ok: false,
        kind: "timeout",
        message: "发送超时。中转可能被网络挡住，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    if (/network:|permission|授权/i.test(raw)) {
      return { ok: false, kind: "denied", message: "网络权限未生效，请重新安装插件", remaining: null };
    }
    // DNS 污染、代理没开、防火墙——国内最常见的三种，用户能分不清，
    // 但「检查网络或代理」这句对他们是有用的动作。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  const status = Number(r && r.status) || 0;
  const data = parseJson(r && r.body);
  const remaining = data ? quotaCount(data.remaining) : null;
  const code = data && typeof data.error === "string" ? data.error : "";

  if (status >= 200 && status < 300) {
    // 成功响应必须带 ok:true。只看状态码会把运营商劫持页、登录门户、
    // 代理错误页（都会返回 200）当成「已发送」——用户以为发出去了，
    // 实际什么都没有。
    if (!data || data.ok !== true) {
      return {
        ok: false,
        kind: "garbled",
        message: "反馈服务返回了无法识别的内容，可能被网络拦截，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    return { ok: true, kind: "sent", message: "反馈已发送，谢谢", remaining };
  }

  if (status === 429) {
    // kind 由 Worker 给出：
    //   burst    = 兜底池的 10 分钟窗口撞了（本插件仍在 48h 冷却里）
    //   cooldown = 本插件 48h 冷却中，且兜底池也空了
    // 分不清按 cooldown 说——让人等十分钟比让人白等一天更糟。
    const burst = data && data.kind === "burst";
    return {
      ok: false,
      kind: "rate_limited",
      message: burst
        ? "发得太快了，稍等几分钟再试，或改用 GitHub Issue 反馈"
        : "这个插件每 48 小时只能提交 1 条反馈，可稍后再来，或改用 GitHub Issue 反馈",
      // burst 时兜底池其实还有剩；剩余额度由服务端回传，没给才写 0。
      remaining: burst ? remaining : 0,
    };
  }

  if (status === 413) {
    return { ok: false, kind: "invalid", message: "反馈内容太长了，请缩短后重试", remaining };
  }

  if (status === 400) {
    // 400 的几种原因要分开说：empty_text 是用户没写，unknown_plugin 是
    // 版本错位，叫用户去「缩短内容」是把他引到错的方向。
    if (code === "unknown_plugin") {
      return {
        ok: false,
        kind: "invalid",
        message: "中转不认识这个插件版本，请更新插件，或改用 GitHub Issue 反馈",
        remaining,
      };
    }
    if (code === "empty_text") {
      return { ok: false, kind: "invalid", message: "反馈内容是空的，写点内容再发", remaining };
    }
    return { ok: false, kind: "invalid", message: "反馈内容不合要求，请缩短后重试", remaining };
  }

  if (status === 502 || status === 503 || status === 500) {
    return {
      ok: false,
      kind: "http",
      // 502 = 发不出邮件、503 = KV 不可用、500 = 中转内部错误。
      // 三种都是中转那边的事，用户唯一能做的是稍后再试或换 Issue。
      message: "中转暂时不可用，稍后再试，或改用 GitHub Issue 反馈",
      remaining,
    };
  }

  if (status === 0) {
    // 请求根本没拿到响应：和网络错误一样处理，别把 "HTTP 0" 甩给用户。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  return {
    ok: false,
    kind: "http",
    message: "发送失败（HTTP " + status + "），可改用 GitHub Issue 反馈",
    remaining,
  };
}

/**
 * 额度提示文案。查不到额度时也要给一句话，不能空着。
 *
 * 额度口径是「本插件每 48 小时 1 条 + 每 IP 每天共享兜底 3 条」，所以
 * 要区分三种状态：
 *   - `{offline: true}`：请求失败（网络/代理/中转挂了）。说「额度有限」
 *     会把网络故障说成用户在刷屏，把他引到错误的方向。
 *   - remaining=1：本插件现在能发。
 *   - remaining=0：本插件在 48 小时冷却里；若 fallbackRemaining>0，仍可
 *     借共享兜底发出去，文案要说清，别让用户以为彻底没戏。
 *
 * @param {{remaining?: number, dailyLimit?: number, fallbackRemaining?: number, offline?: boolean}|null} quota
 * @returns {{remaining: number|null, message: string, canRetry?: boolean}}
 */
function describeQuota(quota) {
  if (quota && quota.offline) {
    return { remaining: null, message: "暂时连不上反馈服务，发送时再试", canRetry: true };
  }
  // Number(null) === 0、Number("") === 0：不显式挡掉，脏数据会被读成「0 条」，
  // 界面就说「今天的额度已用完」。先用「是不是数字」把它挡在这一层。
  const raw = quota ? quota.remaining : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { remaining: null, message: "额度有限，请勿刷屏", canRetry: true };
  }
  const remaining = Math.max(0, raw);
  const fallback = quotaCount(quota ? quota.fallbackRemaining : undefined);
  if (remaining > 0) {
    return { remaining, message: "每个插件每两天可提交 1 条反馈", canRetry: false };
  }
  if (fallback !== null && fallback > 0) {
    return {
      remaining: 0,
      message: "本插件额度已用，仍可借共享额度再发 " + fallback + " 条",
      canRetry: false,
    };
  }
  return { remaining: 0, message: "本插件的反馈额度已用完，48 小时后再来", canRetry: true };
}

// ---- ccgui-plugin-shared/feedback-net.mjs ----
/**
 * 反馈渠道的网络层：`send` 发一条反馈，`quota` 查今天还剩几条。
 *
 * 用工厂而不是两个裸函数，是为了让「插件身份」只能从一处来：`pluginId`
 * 同时决定请求体里的 pluginId 和 User-Agent 前缀，不可能出现「体里是 A、
 * UA 里是 B」的错位。宿主版本也只在这里读一次。
 *
 * 这一层只做「发什么、怎么发、回什么」的搬运；文案全部交给
 * describeFeedbackResult / describeQuota，隐私边界由 buildFeedbackPayload
 * 的白名单钉住。
 */

/**
 * 给 promise 加超时。超时抛 `Error("<label> timeout")`，
 * describeFeedbackResult 靠这个字符串识别超时。
 *
 * 名字带 `fbNet` 前缀：库文件会和 main.head.js 拼进同一作用域，
 * 那边已经有一个给工作区登记与解读用的顶层 withTimeout，重名不是覆盖
 * 而是整个模块语法错误（build.mjs 的顶层重名自检会直接拦住）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function fbNetTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 宿主版本。老版本宿主可能没有这一项，取不到就留空——不能因此发不出反馈。
 *
 * @param {object} ctx
 * @returns {string}
 */
function fbNetHostVersion(ctx) {
  try {
    return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
  } catch {
    return "";
  }
}

/**
 * 建一整套反馈网络调用。
 *
 * @param {object} ctx 插件上下文（要用 ctx.bridge / ctx.version / ctx.host）
 * @param {{endpoint: string, pluginId: string, timeoutMs?: number}} opts
 *   endpoint 必须与 manifest 的 `network:<host>` 一致，否则宿主会拒。
 * @returns {{send: (text: string) => Promise<object>, quota: () => Promise<object|null>}}
 */
function createFeedbackNet(ctx, opts) {
  const endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
  const pluginId = String(opts.pluginId || "");
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const userAgent = () => "ccgui-" + pluginId + "/" + ctx.version;

  /**
   * 发一条反馈。返回值就是 describeFeedbackResult 的结果，界面直接渲染。
   *
   * 不做连接层重试：反馈是 POST，重试会把同一条内容发两遍——用户看到
   * 「发送失败」再点一次，比静默重复更可控。
   *
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function send(text) {
    const payload = buildFeedbackPayload({
      text,
      pluginId,
      pluginVersion: ctx.version,
      hostVersion: fbNetHostVersion(ctx),
    });
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "POST",
          url: endpoint + "/feedback",
          headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
          body: JSON.stringify(payload),
        }),
        timeoutMs,
        "feedback",
      );
      return describeFeedbackResult({ status: Number(res && res.status) || 0, body: res && res.body });
    } catch (error) {
      return describeFeedbackResult({ error });
    }
  }

  /**
   * 查本插件当前的额度。失败时返回 `{offline: true}`——额度查不到不能挡住
   * 发反馈，但要让界面知道「是连不上」而不是「额度紧张」，两句话说给用户
   * 听的意思完全不同。
   *
   * 必须带 `?pluginId=`：冷却按插件区分，不带的话服务端只能回乐观值。
   *
   * @returns {Promise<{remaining: number, dailyLimit: number, fallbackRemaining?: number}|{offline: true}|null>}
   */
  async function quota() {
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "GET",
          url: endpoint + "/quota?pluginId=" + encodeURIComponent(pluginId),
          headers: { "User-Agent": userAgent() },
          body: null,
        }),
        timeoutMs,
        "quota",
      );
      const status = Number(res && res.status) || 0;
      if (!(status >= 200 && status < 300)) return { offline: true };
      const body = res && typeof res.body === "string" ? res.body : "";
      // 劫持页、登录门户都返回 200 + HTML：JSON.parse 会抛，被外层 catch 接住，
      // 与「请求失败」同样按连不上处理——不需要单独再判一次。
      const data = body ? JSON.parse(body) : null;
      // 用 quotaCount 而不是 Number.isFinite(Number(...))：后者把 null/"" 读成 0，
      // 界面会说「额度已用完」。
      const remaining = data ? quotaCount(data.remaining) : null;
      if (remaining === null) return null;
      const fallback = data ? quotaCount(data.fallbackRemaining) : null;
      const out = { remaining, dailyLimit: Number(data.dailyLimit) || 1 };
      if (fallback !== null) out.fallbackRemaining = Math.max(0, fallback);
      return out;
    } catch {
      return { offline: true };
    }
  }

  return { send, quota };
}

// ---- ccgui-plugin-shared/feedback-ui.mjs ----
/**
 * 反馈区的行为层：状态、提交、额度、Issue 链接全在这里，四个插件共用。
 *
 * 为什么分成「行为 + 渲染」两步而不是一个组件：
 * - 每日热点 / 工作志 / 斜杠面板有 CSS 文件，类名各有前缀（gt- / wl- / sp-）；
 * - CLI 安装检测整套 UI 用内联 style，根本没有 CSS 文件。
 *
 * 所以这里只输出「长得一样」的元素树，类名与样式类由调用方传进来；
 * 内联 style 的那个插件可以只用 useFeedbackForm、自己写渲染。
 *
 * 逻辑部分原本在四个插件里各抄一份，而重复的恰好是最容易写错的那几段：
 * sendingRef 挡双击、成功后只清「这次发出去的那段」、额度不能被 null 读成 0。
 * 这些行为现在由 test/feedback-ui.test.mjs 逐个钉住。
 *
 * 依赖 feedback.mjs 的纯函数。内联进 main.js 后两者在同一作用域；
 * 单测里通过这条 import 直接解析。build.mjs 会剥掉这行 import。
 */


/**
 * 反馈区的状态与动作。
 *
 * @param {{useState: Function, useRef: Function, useEffect: Function}} R React 子系统
 *   （插件里是 ctx.react，测试里是假 React 的 api）。
 * @param {object} opts
 * @param {string} opts.repo           Issue 落到哪个仓库（owner/name）。
 * @param {string} opts.pluginName     Issue 标题里的插件中文名。
 * @param {string} opts.pluginVersion  写进请求体与 Issue 的插件版本。
 * @param {string} [opts.hostVersion]  CC GUI 版本，取不到就留空。
 * @param {(text: string) => Promise<object>} opts.send
 * @param {() => Promise<object|null>} opts.quota
 * @returns {object} 状态 + 动作 + `render(h, styleOpts)`
 */
function useFeedbackForm(R, opts) {
  const textState = R.useState("");
  const text = textState[0];
  const setText = textState[1];
  // "" -> "sending" -> "sent"/"error"
  const sendState = R.useState("");
  const sendStatus = sendState[0];
  const setSendStatus = sendState[1];
  const resultState = R.useState(null);
  const result = resultState[0];
  const setResult = resultState[1];
  const quotaState = R.useState(null);
  const quota = quotaState[0];
  const setQuota = quotaState[1];
  // 「只在挂载时查一次额度」的标志。用 ref 而不是 state：它只在 effect
  // 里读写，不该触发重渲染。
  const quotaTried = R.useRef(false);
  // 同步的在途标志。canSend 是渲染时的闭包值，同一 tick 内两次触发都会
  // 读到旧的 sendStatus=""，只在状态里防不住双击。
  const sendingRef = R.useRef(false);

  // 查不到就保持 {canRetry:true}，UI 说明是「连不上」而不是「额度紧张」
  // ——两句话对用户的意思完全不同。
  async function loadQuota() {
    const q = await opts.quota();
    setQuota(q);
    return q;
  }

  R.useEffect(() => {
    if (quotaTried.current) return;
    quotaTried.current = true;
    void loadQuota();
    // 只在挂载时查一次；之后由「重试」按钮或发送结果更新。
  }, []);

  const trimmed = normaliseFeedbackText(text);
  const canSend = trimmed.length > 0 && sendStatus !== "sending";

  const issueUrl = buildIssueUrl({
    repo: opts.repo,
    pluginName: opts.pluginName,
    text: trimmed,
    pluginVersion: opts.pluginVersion,
    hostVersion: opts.hostVersion || "",
  });

  async function submit() {
    // sendingRef 是同步的：同一 tick 内两次触发都会读到 true，挡住双击。
    // sendStatus 要等重渲染才更新，靠它挡不住。
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    const submitted = trimmed;
    setSendStatus("sending");
    setResult(null);

    let r;
    try {
      r = await opts.send(submitted);
    } finally {
      sendingRef.current = false;
    }

    setSendStatus(r.ok ? "sent" : "error");
    setResult(r);
    // 失败时正文原样留着：用户重打一遍比什么都糟。
    if (!r.ok) return;

    // 只清掉「这次发出去的那段」。发送期间用户可能又敲了内容（那几个请求
    // 往返里 textarea 没禁用），直接清空会把他新写的也抹掉。
    setText((cur) => (cur === submitted ? "" : cur));

    // 额度优先用服务端回传的真实值。查额度时失败了也不要紧——成功响应里
    // 带了 remaining，正好顺手把「暂时连不上」纠正过来。没有回传就自减一格。
    setQuota((prev) => nextQuota(prev, r.remaining));
  }

  /** 正文变化。重新输入等于开了一条新反馈，上一条的回执（成功或失败）都该撤掉。 */
  function changeText(value) {
    setText(value);
    if (sendStatus !== "sending") {
      setSendStatus("");
      setResult(null);
    }
  }

  const quotaText = describeQuota(quota);
  const statusText =
    sendStatus === "sending" ? "发送中…" : result ? result.message : "";
  // 成功时正文被清空，按钮会变成不可点的死按钮。若文案还停在「发送反馈」，
  // 用户看到的就是「点了没反应」——回执必须落在按钮自己身上。
  const sendLabel =
    sendStatus === "sending" ? "发送中…" : sendStatus === "sent" ? "已发送" : "发送反馈";

  /**
   * 渲染成元素树。
   *
   * @param {Function} h createElement
   * @param {object} [style]
   * @param {string} [style.prefix]      类名前缀，如 "gt"；产出 `${prefix}-feedback-*`
   * @param {number} [style.rows]        正文框行数
   * @param {string} [style.variant]     "section"（带 section 外壳）或 "bare"
   * @param {object} [style.classes]     各插件的样式类：input / primaryBtn /
   *   secondaryBtn / hint / note / linkBtn。缺省为空。
   */
  function render(h, style) {
    const s = style || {};
    const prefix = s.prefix || "fb";
    const rows = s.rows || 5;
    const c = s.classes || {};
    // 统一样式钩子（行为稳定、可被任何插件套）与各插件自己的样式类
    // （决定长什么样）拼在一起。两者都要，缺了哪一半都不行。
    const cls = (name, extra) => {
      const own = prefix + "-feedback-" + name;
      return extra ? own + " " + extra : own;
    };
    const join = (a, b) => (a && b ? a + " " + b : a || b || "");

    const head =
      s.variant === "section"
        ? h(
            "div",
            { className: prefix + "-section-label" },
            h("h2", null, "反馈"),
            h("p", null, "遇到问题或想提建议，两种方式任选其一。"),
          )
        : null;

    const body = [
      h("textarea", {
        className: cls("text", c.input),
        value: text,
        rows: rows,
        maxLength: TEXT_LIMIT,
        placeholder: "描述问题或建议…（最多 " + TEXT_LIMIT + " 字）",
        spellCheck: false,
        "aria-label": "反馈正文",
        onChange: (e) => changeText(e.target.value),
      }),
      h(
        "div",
        { className: cls("row") },
        h("span", { className: cls("count", c.hint) }, text.length + " / " + TEXT_LIMIT),
        h(
          "span",
          { className: cls("quota", c.hint) },
          quotaText.message,
          // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
          quotaText.canRetry
            ? h(
                "button",
                {
                  type: "button",
                  className: cls("quota-retry", c.linkBtn),
                  disabled: sendStatus === "sending",
                  onClick: () => void loadQuota(),
                },
                "重试",
              )
            : null,
        ),
      ),
      h(
        "div",
        { className: cls("actions") },
        h(
          "a",
          {
            className: join(
              cls("issue", c.secondaryBtn),
              // 正文为空时 Issue 链接仍可点，但看起来不该和「能发」时一样重。
              // 判断口径必须与 canSend 一致，所以这里用同一个 trimmed，
              // 不能让调用方自己再算一遍（那样两边迟早漂开）。
              trimmed ? "" : c.muted || "",
            ),
            href: issueUrl,
            target: "_blank",
            rel: "noreferrer noopener",
            title: "在浏览器里打开预填好的 Issue 页面",
          },
          "通过 GitHub 提 Issue",
        ),
        h(
          "button",
          {
            type: "button",
            className: cls("send", c.primaryBtn) + (sendStatus === "sent" ? " " + cls("sent") : ""),
            disabled: !canSend,
            onClick: () => void submit(),
          },
          sendLabel,
        ),
      ),
      statusText
        ? h(
            "p",
            {
              className:
                cls("status", c.note) +
                (sendStatus === "sent" ? " is-ok" : "") +
                (sendStatus === "error" ? " is-bad" : ""),
              role: "status",
              "aria-live": "polite",
            },
            statusText,
          )
        : null,
      h(
        "p",
        { className: c.hint || "" },
        "发送的内容只有这段文字、插件版本与 CC GUI 版本。不含会话、代码或本机路径。",
      ),
    ].filter(Boolean);

    if (s.variant === "section") {
      return h(
        "section",
        { className: prefix + "-section" },
        head,
        h("div", { className: prefix + "-section-panel" }, body),
      );
    }
    return h("div", { className: prefix + "-feedback" }, body);
  }

  return {
    text,
    setText: changeText,
    sendStatus,
    result,
    quota,
    quotaText,
    canSend,
    submit,
    retryQuota: loadQuota,
    issueUrl,
    statusText,
    sendLabel,
    render,
  };
}

// ---- ccgui-plugin-shared/markdown.mjs ----
/**
 * 解读正文用的 Markdown 子集解析。纯函数，输出的是「节点描述」而不是
 * HTML —— 渲染端自己把它们变成元素，避免把模型的输出当 HTML 执行。
 *
 * 覆盖模型最常写的那几种：标题、段落、有序/无序列表（含缩进层级）、
 * GFM 表格、代码块、行内代码、粗体、斜体、删除线、链接、引用、分隔线。
 *
 * 流式输入的容错是硬要求：解读是一个字一个字推过来的，任何时刻都可能停在
 * `**粗`、`| a | b`（分隔行还没来）、``` 未闭合这种半截状态。所以：
 * - 未闭合的行内标记按原文输出，不吞字符；
 * - 未闭合的代码块一直吃到末尾；
 * - 没有分隔行的表格行当普通段落。
 */

/** 行内标记。顺序即优先级：`**` 必须先于 `*`，否则粗体会被切成两个斜体。
 * 这里存的是不带 g 的「模板」：带 g 的正则 lastIndex 是实例状态，而 parseInline
 * 会递归，内层一重置就会把外层循环卡在原地。每次调用自己造实例。 */
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/;

/** 链接只放行 http(s)。其他协议（javascript:、file:）一律降级成文字。
 * 名字带 md 前缀：这个文件会被内联进 main.js 顶层作用域，和插件里的
 * safeHref（给仓库链接用）重名就会直接语法错误。 */
function safeMdHref(href) {
  return /^https?:\/\//i.test(href) ? href : "";
}

/**
 * 把一行切成行内节点。
 *
 * 强调类标记（strong/em/del）的内容会递归解析：模型很爱写
 * `**\`owner/repo\`**` 这种「粗体包代码」，不递归的话反引号会原样显示出来。
 * 强调标记本身不嵌套（`*a **b** c*` 会先命中内层的 `**b**`），这是有意的
 * 简化：解读正文里几乎不会出现，换来的是流式输入下不会卡死。递归只往
 * 「非强调」的行内标记里走，层数限死 2 层。
 *
 * 正则每次调用都要新造实例：带 g 的正则 lastIndex 是实例状态，递归共用一个
 * 就会被内层重置，外层 exec 原地打转。
 *
 * @param {string} text
 * @param {number} [depth]
 * @returns {Array<{t: string, v: string, href?: string, children?: Array<object>}>}
 */
function parseInline(text, depth = 0) {
  const src = String(text == null ? "" : text);
  const out = [];
  let last = 0;
  let m;
  // 递归解析强调内容时不能和外层共用同一个带 g 的正则实例。
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    const tok = m[0];
    const wrap = (t) => {
      const inner = tok.slice(t === "em" ? 1 : 2, t === "em" ? -1 : -2);
      const node = { t: t, v: inner };
      if (depth < 2) node.children = parseInline(inner, depth + 1);
      return node;
    };
    if (tok.startsWith("**")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("__")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("`")) {
      out.push({ t: "code", v: tok.slice(1, -1) });
    } else if (tok.startsWith("~~")) {
      out.push(wrap("del"));
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = link ? safeMdHref(link[2]) : "";
      if (link && href) out.push({ t: "link", v: link[1], href: href });
      else out.push({ t: "text", v: tok });
    } else {
      out.push(wrap("em"));
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

/* ---- 表格与列表的识别 ---- */

const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_DIV_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function hasPipe(line) {
  return String(line || "").indexOf("|") >= 0;
}

/** 表头行 + `|---|` 分隔行；只有表头行时不算表格。 */
function isTableStart(lines, i) {
  return i + 1 < lines.length && hasPipe(lines[i]) && hasPipe(lines[i + 1]) && TABLE_DIV_RE.test(lines[i + 1]);
}

function splitRow(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // 手写扫描而不是 split(/(?<!\\)\|/)：lookbehind 在老版本 Chromium 上不支持，
  // 宿主的内置内核版本不在我们控制范围内。`\|` 是单元格内的转义竖线。
  const cells = [];
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function cellAlign(spec) {
  const s = String(spec || "").trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

/** 缩进换算成层级：两个空格或一个 Tab 算一级，最多 4 级（再深也没人看）。 */
function depthOf(indent) {
  const expanded = String(indent || "").replace(/\t/g, "  ").length;
  return Math.min(4, Math.floor(expanded / 2));
}

/** 块级元素是否从这里开始；段落收集到这些行就停。 */
function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, i)
  );
}

/**
 * @param {string} text 模型输出的 Markdown
 * @returns {Array<object>} 块节点数组，结构见文件头注释
 */
function parseMarkdown(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let list = null;

  const flushList = () => {
    if (!list) return;
    out.push(list);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushList();
      const marker = fence[1];
      const lang = fence[2] || "";
      const buf = [];
      i += 1;
      // 闭合行只要以同样的围栏开头即可（```js 和 ``` 都算）
      while (i < lines.length && lines[i].trim().indexOf(marker) !== 0) {
        buf.push(lines[i]);
        i += 1;
      }
      // 未闭合时（流式中途）i 会停在末尾，代码原样输出，不丢内容
      if (i < lines.length) i += 1;
      out.push({ type: "code", lang: lang, text: buf.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      flushList();
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && hasPipe(lines[i]) && !startsBlock(lines, i)) {
        const cells = splitRow(lines[i]);
        // 列数按表头补齐/截断：模型偶尔少写一格，不能让整行错位
        const row = [];
        for (let c = 0; c < head.length; c += 1) row.push(parseInline(cells[c] == null ? "" : cells[c]));
        rows.push(row);
        i += 1;
      }
      out.push({ type: "table", align: align, head: head, rows: rows });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushList();
      out.push({ type: "heading", level: Math.min(6, heading[1].length), inlines: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flushList();
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushList();
      const buf = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        buf.push(q[1]);
        i += 1;
      }
      out.push({ type: "quote", inlines: parseInline(buf.join(" ")) });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      // 有序/无序切换或缩进回退都要重开一个列表：混在一个 <ul> 里会全变成圆点
      if (!list || list.type !== type || list.depth !== depthOf((ul || ol)[1])) {
        flushList();
        list = { type: type, depth: depthOf((ul || ol)[1]), items: [] };
      }
      list.items.push({ inlines: parseInline((ul || ol)[2]), depth: depthOf((ul || ol)[1]) });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }

    flushList();
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ type: "paragraph", inlines: parseInline(buf.join(" ")) });
  }

  flushList();
  return out;
}

// ---- ccgui-plugin-shared/markdown-view.mjs ----
/**
 * 把 markdown.mjs 的块节点渲染成元素。
 *
 * 解析与渲染分开的理由：worklog 与 github-trending 共用解析器，但渲染出来
 * 的类名与可交互节点不同——worklog 要把会话短 ID 变成可点的按钮，trending
 * 不需要。所以解析层是纯函数，渲染层接一个 `extraInline` 钩子。
 *
 * 全程不拼 HTML 字符串：模型输出属于不可信内容，只当文本处理。
 */


/**
 * 解析结果缓存。流式输出时每个 delta 都会重渲染整棵报告树，而解析要扫全文；
 * 内容没变（别处 set 触发的重渲染）就不该再解析一遍。
 */
const mdCache = new Map();
const MD_CACHE_LIMIT = 4;

/**
 * @param {string} text
 * @returns {Array<object>} 块节点；相同输入返回同一个数组引用
 */
function markdownBlocks(text) {
  const src = String(text || "");
  const hit = mdCache.get(src);
  if (hit) {
    // 命中后挪到队尾：Map 保持插入序，删第一个就是删最久没用的。
    mdCache.delete(src);
    mdCache.set(src, hit);
    return hit;
  }
  const blocks = parseMarkdown(src);
  mdCache.set(src, blocks);
  while (mdCache.size > MD_CACHE_LIMIT) mdCache.delete(mdCache.keys().next().value);
  return blocks;
}

/**
 * 行内节点 → 元素。
 *
 * @param {Function} h createElement
 * @param {Array<object>} inlines parseMarkdown 产出的行内节点
 * @param {string} keyBase
 * @param {string} codeClass 行内代码的类名（各插件前缀不同）
 * @param {(text: string, keyBase: string, h: Function) => Array|null} [textHook]
 *   纯文本节点的改写机会。返回数组就用它（可以拆成多个节点），返回 null
 *   就按普通文字输出。worklog 用它把会话短 ID 变成可点按钮。
 */
function inlineNodes(h, inlines, keyBase, codeClass, textHook) {
  return (inlines || []).map((n, i) => {
    const key = keyBase + "i" + i;
    if (n.children) {
      return h(n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del", { key },
        inlineNodes(h, n.children, key + "_", codeClass, textHook));
    }
    if (n.t === "text" && typeof textHook === "function") {
      const got = textHook(n.v, key, h);
      if (got) return got;
    }
    if (n.t === "strong") return h("strong", { key }, n.v);
    if (n.t === "em") return h("em", { key }, n.v);
    if (n.t === "del") return h("del", { key }, n.v);
    if (n.t === "code") return h("code", { key, className: codeClass || "" }, n.v);
    if (n.t === "link") {
      return h("a", { key, href: n.href, target: "_blank", rel: "noreferrer noopener" }, n.v);
    }
    return n.v;
  });
}

/**
 * 渲染整份 Markdown。
 *
 * @param {Function} h createElement
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.prefix] 类名前缀，如 "wl"；产出 `${prefix}-md-*`
 * @param {(text: string, keyBase: string, h: Function) => Array|null} [opts.extraInline]
 *   纯文本节点的改写钩子。返回数组就用它（可以拆成多个节点），返回 null
 *   就走默认输出。worklog 用它把会话短 ID 变成可点按钮。
 * @returns {Array|null} 元素数组
 */
function renderMarkdown(h, text, opts) {
  const o = opts || {};
  const prefix = o.prefix || "md";
  const codeClass = prefix + "-md-code";
  const blocks = markdownBlocks(text);
  const inline = (inlines, keyBase) =>
    inlineNodes(h, inlines, keyBase, codeClass, o.extraInline);

  return blocks.map((b, i) => {
    const key = prefix + "md" + i;
    if (b.type === "heading") {
      return h("h" + b.level, { key, className: prefix + "-md-h" + b.level }, inline(b.inlines, key));
    }
    if (b.type === "paragraph") {
      return h("p", { key, className: prefix + "-md-p" }, inline(b.inlines, key));
    }
    if (b.type === "hr") return h("hr", { key, className: prefix + "-md-hr" });
    if (b.type === "quote") {
      return h("blockquote", { key, className: prefix + "-md-quote" }, inline(b.inlines, key));
    }
    if (b.type === "code") {
      return h(
        "pre",
        { key, className: prefix + "-md-pre" },
        h("code", { className: b.lang ? "language-" + b.lang : "" }, b.text),
      );
    }
    if (b.type === "ul" || b.type === "ol") {
      return h(
        b.type,
        {
          key,
          className: prefix + "-md-list",
          // 解析器在缩进变化时重开一个列表（混在一个 <ul> 里会全变圆点），
          // 所以层级信息落在块本身的 depth 上，渲染时按它缩进。
          style: b.depth ? { marginLeft: b.depth * 14 } : undefined,
        },
        b.items.map((item, j) =>
          h(
            "li",
            { key: key + "li" + j },
            inline(item.inlines, key + "li" + j),
          ),
        ),
      );
    }
    if (b.type === "table") {
      const cellStyle = (ci) => (b.align[ci] ? { textAlign: b.align[ci] } : undefined);
      return h(
        "div",
        { key, className: prefix + "-md-table-wrap" },
        h(
          "table",
          { className: prefix + "-md-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              b.head.map((cell, ci) =>
                h("th", { key: key + "th" + ci, style: cellStyle(ci) }, inline(cell, key + "th" + ci)),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            b.rows.map((row, ri) =>
              h(
                "tr",
                { key: key + "tr" + ri },
                row.map((cell, ci) =>
                  h(
                    "td",
                    { key: key + "td" + ci, style: cellStyle(ci) },
                    inline(cell, key + "td" + ri + "_" + ci),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
    return null;
  });
}


const SCAN_SOURCE = "/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。\n * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */\n\nconst PROJECT_SETTINGS_REL = \".claude/settings.local.json\";\nconst SHARED_SETTINGS_REL = \".claude/settings.json\";\n\nconst TRI_STATES = [\"inherit\", \"on\", \"off\"];\n// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。\nconst MCP_STATES = [\"inherit\", \"off\"];\n// 技能官方是四态（code.claude.com/docs/en/skills）：\n//   on                  名称和描述都给 Claude\n//   name-only           只给名称，省掉描述\n//   user-invocable-only 对 Claude 隐藏，只留 / 菜单手动调用\n//   off                 两边都隐藏\n// 后两者不是「禁用」，早先按 on 处理会在用户点「启用」时把原值改写掉。\nconst SKILL_VALUES = [\"on\", \"name-only\", \"user-invocable-only\", \"off\"];\nconst SKILL_STATES = [\"inherit\"].concat(SKILL_VALUES);\n\nconst has = (obj, key) =>\n  obj !== null && typeof obj === \"object\" && Object.prototype.hasOwnProperty.call(obj, key);\n\n/** settings 是 JSON 文档，深拷贝用 JSON 往返即可；不依赖 structuredClone。 */\nfunction cloneSettings(settings) {\n  return settings && typeof settings === \"object\" ? JSON.parse(JSON.stringify(settings)) : {};\n}\n\n/** 空键不落盘：面板把某栏全部改回「跟随全局」时，文件里不该留下空对象。 */\nfunction prune(settings) {\n  const next = cloneSettings(settings);\n  if (next.enabledPlugins && Object.keys(next.enabledPlugins).length === 0) delete next.enabledPlugins;\n  if (Array.isArray(next.deniedMcpServers) && next.deniedMcpServers.length === 0) delete next.deniedMcpServers;\n  if (next.skillOverrides && Object.keys(next.skillOverrides).length === 0) delete next.skillOverrides;\n  // 项目 .mcp.json 的逐个审批名单，Claude Code 也写在这份文件里。\n  if (Array.isArray(next.enabledMcpjsonServers) && next.enabledMcpjsonServers.length === 0) delete next.enabledMcpjsonServers;\n  if (Array.isArray(next.disabledMcpjsonServers) && next.disabledMcpjsonServers.length === 0) delete next.disabledMcpjsonServers;\n  return next;\n}\n\nfunction assertState(state, allowed, kind) {\n  if (!allowed.includes(state)) {\n    throw new Error(`${kind} 不支持的状态：${state}（允许 ${allowed.join(\" / \")}）`);\n  }\n}\n\n/* ------------------------------------------------------------ plugin */\n\nfunction getPluginState(project, id) {\n  if (!has(project.enabledPlugins, id)) return \"inherit\";\n  return project.enabledPlugins[id] === false ? \"off\" : \"on\";\n}\n\nfunction setPluginState(project, id, state) {\n  assertState(state, TRI_STATES, \"plugin\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.enabledPlugins, id)) delete next.enabledPlugins[id];\n  } else {\n    next.enabledPlugins = { ...(next.enabledPlugins || {}), [id]: state === \"on\" };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ mcp */\n\nfunction getMcpState(project, serverName) {\n  const list = project.deniedMcpServers;\n  if (!Array.isArray(list)) return \"inherit\";\n  return list.some((entry) => entry && entry.serverName === serverName) ? \"off\" : \"inherit\";\n}\n\n/** 只增删 serverName 条目；serverCommand / serverUrl 条目原样保留。 */\nfunction setMcpState(project, serverName, state) {\n  if (state === \"on\") {\n    throw new Error(\"MCP 项目级无法显式启用：全局已禁用时不受项目控制，请改用 inherit\");\n  }\n  assertState(state, MCP_STATES, \"mcp\");\n  const next = cloneSettings(project);\n  const list = Array.isArray(next.deniedMcpServers) ? next.deniedMcpServers.slice() : [];\n  const filtered = list.filter((entry) => !(entry && entry.serverName === serverName));\n  if (state === \"off\") filtered.push({ serverName });\n  next.deniedMcpServers = filtered;\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ skill */\n\nfunction getSkillState(project, name) {\n  if (!has(project.skillOverrides, name)) return \"inherit\";\n  const value = project.skillOverrides[name];\n  // 未知取值原样返回，交给界面显示成「其它」并只读；猜成 on 会误导，\n  // 而且后续任何一次写入都会把它覆盖掉。\n  return SKILL_VALUES.includes(value) ? value : \"unknown\";\n}\n\nfunction setSkillState(project, name, state) {\n  // 只拒绝面板自己不认识的值；unknown 是读取态，不是可写状态。\n  assertState(state, SKILL_STATES, \"skill\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.skillOverrides, name)) delete next.skillOverrides[name];\n  } else {\n    next.skillOverrides = { ...(next.skillOverrides || {}), [name]: state };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ 项目 .mcp.json 审批 */\n\n// Claude Code 把项目 .mcp.json 里 server 的审批结果写在 .claude/settings.local.json\n// （和本插件同一个文件），三个键：\n//   enableAllProjectMcpServers: true   全部批准，不再弹窗\n//   enabledMcpjsonServers: [name…]     逐个批准\n//   disabledMcpjsonServers: [name…]    逐个拒绝；优先级高于前两者\n// 未出现在任何名单里且没开「全部批准」时，server 是待审批状态：不连、界面上不该显示成生效。\n//\n// 还有一层别处管不到：工作区没被信任时（~/.claude.json 的 projects[ws]\n// .hasTrustDialogAccepted 不为 true），**批准一律不生效**，仍然停在待审批；\n// 拒绝不受影响。这条是 2026-11-24 用 claude 2.1.319 实测确认的。\n\nfunction getMcpApproval(project, serverName) {\n  const disabled = Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers : [];\n  if (disabled.includes(serverName)) return \"rejected\";\n  const enabled = Array.isArray(project.enabledMcpjsonServers) ? project.enabledMcpjsonServers : [];\n  if (enabled.includes(serverName)) return \"approved\";\n  if (project.enableAllProjectMcpServers === true) return \"approved\";\n  return \"pending\";\n}\n\n/**\n * 只改这一个 server 的审批结果，不动「全部批准」这个总开关。\n *\n * 传 \"pending\" 表示从两个名单里都移除。注意：如果 enableAllProjectMcpServers\n * 已是 true，移除后仍然是 approved——这是 Claude Code 的语义，不是这里能改的，\n * 所以界面要据此提示。返回里带上生效结果，调用方可直接显示。\n */\nfunction setMcpApproval(project, serverName, state) {\n  assertState(state, [\"approved\", \"rejected\", \"pending\"], \"mcp 审批\");\n  const next = cloneSettings(project);\n  const pick = (list) => (Array.isArray(list) ? list.filter((n) => n !== serverName) : []);\n  const enabled = pick(next.enabledMcpjsonServers);\n  const disabled = pick(next.disabledMcpjsonServers);\n  if (state === \"approved\") enabled.push(serverName);\n  else if (state === \"rejected\") disabled.push(serverName);\n  if (enabled.length) next.enabledMcpjsonServers = enabled;\n  else delete next.enabledMcpjsonServers;\n  if (disabled.length) next.disabledMcpjsonServers = disabled;\n  else delete next.disabledMcpjsonServers;\n  // 总开关开着时「待审批」无法靠单个名单实现，如实回报，让界面说明原因。\n  const blockedByAll = state === \"pending\" && next.enableAllProjectMcpServers === true;\n  return { settings: prune(next), effective: blockedByAll ? \"approved\" : state };\n}\n\n/**\n * server 到底连没连上，以及卡在哪一层。返回 null 表示确实会连接。\n *\n * 五道闸按 Claude Code 的判定顺序排列（2026-11-24 用 2.1.319 实测）：\n *   global-denied   ~/.claude/settings.json 的 deniedMcpServers（对象格式才生效）\n *   project-denied  本项目 deniedMcpServers\n *   rejected        项目 .mcp.json 的拒绝，任何情况下都生效\n *   pending         还没批准\n *   untrusted       批准了，但工作区没被信任 —— 批准不生效，仍停在待审批\n *   runtime-disabled /mcp 里手动关掉的（~/.claude.json 项目条目的 disabledMcpServers）\n */\nfunction mcpBlockReason({ globalDenied, projectDenied, approval, trusted, runtimeDisabled }) {\n  if (globalDenied) return \"global-denied\";\n  if (projectDenied) return \"project-denied\";\n  if (approval === \"rejected\") return \"rejected\";\n  if (approval === \"pending\") return \"pending\";\n  // 未信任时 Claude Code 连「已批准」都不认，这是最容易漏的一层：\n  // 面板写批准、文件里也确实写着批准，实际却还是待审批。\n  // 只挡批准这一侧——没有审批可挡的 server（user/local/plugin 来源）不受影响，\n  // 否则 !undefined 会把它们全部误判成未信任。\n  if (approval === \"approved\" && !trusted) return \"untrusted\";\n  // /mcp 的手动开关（disabledMcpServers）同样录在 ~/.claude.json 的项目条目里，\n  // 未信任时 Claude Code 根本不看它，这里也就不能据此说「被关了」。\n  if (runtimeDisabled && trusted) return \"runtime-disabled\";\n  return null;\n}\n\n/* ------------------------------------------------------------ 展示用 */\n\n/** 项目覆盖了多少项；panel tab 的徽标数字。 */\nfunction overrideCount(project) {\n  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;\n  const mcp = Array.isArray(project.deniedMcpServers)\n    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length\n    : 0;\n  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;\n  const approvals = (Array.isArray(project.enabledMcpjsonServers) ? project.enabledMcpjsonServers.length : 0)\n    + (Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers.length : 0)\n    + (project.enableAllProjectMcpServers === true ? 1 : 0);\n  return plugins + mcp + skills + approvals;\n}\n\n/** 项目态优先；inherit 时回落到全局态。 */\nfunction effectiveState(projectState, globalState) {\n  if (projectState && projectState !== \"inherit\") return projectState;\n  return globalState || \"unknown\";\n}\n\n/* 子进程：读写项目级 Claude Code 配置。\n *\n * 插件本体拿不到文件系统，只能把这份脚本落盘后经 exec:node 执行。\n * 构建时 scripts/build.mjs 会把 src/lib/model.mjs 的源码内联进来，\n * 所以这里唯一允许的兄弟 import 是 model；其余只能用 node 内置模块。\n *\n * 用法：\n *   node config-io.mjs scan <workspace>\n *   node config-io.mjs set  <workspace> <plugin|mcp|skill> <id> <inherit|on|off>\n * 输出：单行 JSON，ok=false 时附带 error。\n */\n\nimport fs from \"node:fs\";\nimport os from \"node:os\";\nimport path from \"node:path\";\n\nconst HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();\n// 设了 CLAUDE_CONFIG_DIR 时，Claude Code 会把 settings.json、.claude.json、\n// plugins/、projects/ 全部搬进这个目录（官方文档：该页所有 ~/.claude 路径都改到这里）。\n// 硬编码 ~/.claude 会读到一片空，面板显示成「什么都没配」。实测 2.1.319 确实如此。\n// 注意 .claude.json 只在设了这个变量时才跟着走，默认仍在 HOME 根上。\nconst CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR\n  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)\n  : path.join(HOME, \".claude\");\nconst CLAUDE_DIR = CONFIG_DIR;\nconst CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR\n  ? path.join(CONFIG_DIR, \".claude.json\")\n  : path.join(HOME, \".claude.json\");\n\nfunction readJson(file) {\n  try {\n    let text = fs.readFileSync(file, \"utf8\");\n    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);\n    return JSON.parse(text);\n  } catch {\n    return null;\n  }\n}\n\n/**\n * 严格读取：把「文件不存在」和「存在但解析失败」分开。\n *\n * 写入前必须用这个。settings.local.json 里可能同时住着用户手写的 permissions、\n * hooks、env 等键；一旦解析失败就被当成空对象写回，等于整份配置被清空。\n * 这种情况要么报错停止，要么提示用户自己修，绝不能静默覆盖。\n */\nfunction readJsonStrict(file) {\n  let text;\n  try {\n    text = fs.readFileSync(file, \"utf8\");\n  } catch (err) {\n    if (err && err.code === \"ENOENT\") return { value: null, error: null };\n    return { value: null, error: \"读取失败：\" + ((err && err.message) || err) };\n  }\n  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);\n  // 空文件按「还没配置」处理，写回时自然变成一份新配置。\n  if (!text.trim()) return { value: null, error: null };\n  try {\n    const value = JSON.parse(text);\n    if (value === null || typeof value !== \"object\" || Array.isArray(value)) {\n      return { value: null, error: \"顶层不是 JSON 对象\" };\n    }\n    return { value, error: null };\n  } catch (err) {\n    return { value: null, error: String((err && err.message) || err) };\n  }\n}\n\n/** 写之前读；文件坏了就抛错，宁可这次操作失败也不吞掉用户的其它配置。 */\nfunction readForWrite(file) {\n  const { value, error } = readJsonStrict(file);\n  if (error) {\n    throw new Error(\"项目配置不是合法 JSON，为避免覆盖已停止写入：\" + file + \"（\" + error + \"）\");\n  }\n  return value || {};\n}\n\nfunction writeJsonAtomic(file, data) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  const tmp = file + \".tmp-\" + process.pid;\n  const body = JSON.stringify(data, null, 2) + \"\\n\";\n  fs.writeFileSync(tmp, body, \"utf8\");\n  fs.renameSync(tmp, file);\n}\n\nconst norm = (p) => String(p || \"\").replace(/\\\\/g, \"/\").replace(/\\/+$/, \"\").toLowerCase();\n\nfunction findProjectEntry(config, ws) {\n  const projects = (config && config.projects) || {};\n  const target = norm(ws);\n  const key = Object.keys(projects).find((k) => norm(k) === target);\n  return key ? projects[key] : null;\n}\n\nfunction listSkillDirs(root, source, plugin) {\n  const out = [];\n  let entries = [];\n  try {\n    entries = fs.readdirSync(root, { withFileTypes: true });\n  } catch {\n    return out;\n  }\n  for (const entry of entries) {\n    if (!entry.isDirectory()) continue;\n    const md = path.join(root, entry.name, \"SKILL.md\");\n    if (!fs.existsSync(md)) continue;\n    const meta = readSkillMeta(md);\n    // 技能名优先取 frontmatter 的 name，目录名只是回落（官方文档明确）。\n    // 用目录名当键时，一旦两者不一致，写进 skillOverrides 的键就对不上\n    // Claude Code 认的那个名字，开关看起来生效、实际什么也没改。\n    out.push({\n      name: meta.name || entry.name,\n      dirName: entry.name,\n      source,\n      plugin: plugin || null,\n      path: md,\n      description: meta.description,\n    });\n  }\n  return out;\n}\n\nfunction installedPlugins() {\n  const raw = readJson(path.join(CLAUDE_DIR, \"plugins\", \"installed_plugins.json\"));\n  const map = {};\n  const plugins = (raw && raw.plugins) || {};\n  for (const [id, list] of Object.entries(plugins)) {\n    if (!Array.isArray(list) || list.length === 0) continue;\n    const pick = list.find((e) => e && e.scope === \"user\") || list[0];\n    map[id] = {\n      installPath: pick && pick.installPath ? pick.installPath : \"\",\n      scopes: list.map((e) => e && e.scope).filter(Boolean),\n    };\n  }\n  return map;\n}\n\n/** 插件 .mcp.json 有两种写法：{ mcpServers: { name: cfg } } 和扁平的 { name: cfg }。 */\nfunction pluginServers(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return {};\n  const wrapped = cfg.mcpServers || cfg.servers;\n  if (wrapped && typeof wrapped === \"object\") return wrapped;\n  const out = {};\n  for (const [key, value] of Object.entries(cfg)) {\n    if (value && typeof value === \"object\"\n      && (\"command\" in value || \"url\" in value || \"type\" in value)) {\n      out[key] = value;\n    }\n  }\n  return out;\n}\n\n/** 插件描述：优先 .claude-plugin/plugin.json，其次根目录的 plugin.json / manifest.json。 */\nfunction pluginDescription(dir) {\n  if (!dir) return \"\";\n  for (const rel of [\".claude-plugin/plugin.json\", \"plugin.json\", \"manifest.json\"]) {\n    const cfg = readJson(path.join(dir, rel));\n    if (cfg && typeof cfg.description === \"string\" && cfg.description.trim()) {\n      return cfg.description.trim();\n    }\n  }\n  return \"\";\n}\n\n/** SKILL.md frontmatter 里的 name 与 description；只读前 50 行。 */\nfunction readSkillMeta(file) {\n  const meta = { name: \"\", description: \"\" };\n  try {\n    const lines = fs.readFileSync(file, \"utf8\").split(/\\r?\\n/).slice(0, 50);\n    if (!lines.length || lines[0].trim() !== \"---\") return meta;\n    let collecting = false;\n    const block = [];\n    for (let i = 1; i < lines.length; i++) {\n      const line = lines[i];\n      if (line.trim() === \"---\") break;\n      if (collecting) {\n        if (/^\\s+\\S/.test(line)) { block.push(line.trim()); continue; }\n        collecting = false;\n      }\n      const nameMatch = /^name:\\s*(.*)$/.exec(line);\n      if (nameMatch && !meta.name) {\n        meta.name = nameMatch[1].replace(/^[\"']|[\"']$/g, \"\").trim();\n        continue;\n      }\n      const match = /^description:\\s*(.*)$/.exec(line);\n      if (match) {\n        const value = match[1].trim();\n        if (/^[|>][-+]?$/.test(value)) { collecting = true; continue; }\n        meta.description = value.replace(/^[\"']|[\"']$/g, \"\").trim();\n      }\n    }\n    if (collecting || block.length) meta.description = meta.description || block.join(\" \").trim();\n    return meta;\n  } catch {\n    return meta;\n  }\n}\n\nfunction mcpDescription(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return \"\";\n  if (typeof cfg.url === \"string\") return cfg.url;\n  if (typeof cfg.command === \"string\") {\n    const args = Array.isArray(cfg.args) ? \" \" + cfg.args.join(\" \") : \"\";\n    return (cfg.command + args).trim();\n  }\n  return \"\";\n}\n\nfunction scan(ws) {\n  const globalSettings = readJson(path.join(CLAUDE_DIR, \"settings.json\")) || {};\n  const globalConfig = readJson(CLAUDE_JSON) || {};\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const sharedPath = path.join(ws, SHARED_SETTINGS_REL);\n  // 坏掉的文件不能被当成「没有配置」：那样界面会显示成全部跟随全局，\n  // 用户再点一下就覆盖掉了。这里如实读，坏的单独报出来。\n  const localRead = readJsonStrict(localPath);\n  const local = localRead.value || {};\n  const shared = readJson(sharedPath) || {};\n\n  // 项目层：local 压过 shared；面板只写 local。\n  const projectLayer = Object.assign({}, shared, local);\n  for (const key of [\"enabledPlugins\", \"skillOverrides\"]) {\n    if (shared[key] || local[key]) {\n      projectLayer[key] = Object.assign({}, shared[key] || {}, local[key] || {});\n    }\n  }\n  if (Array.isArray(shared.deniedMcpServers) || Array.isArray(local.deniedMcpServers)) {\n    projectLayer.deniedMcpServers = [\n      ...(Array.isArray(shared.deniedMcpServers) ? shared.deniedMcpServers : []),\n      ...(Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []),\n    ];\n  }\n\n  /* ---------------- plugins ---------------- */\n\n  const installed = installedPlugins();\n  const pluginIds = new Set(Object.keys(globalSettings.enabledPlugins || {}));\n  for (const id of Object.keys(installed)) pluginIds.add(id);\n\n  const plugins = [];\n  for (const id of [...pluginIds].sort()) {\n    const at = id.lastIndexOf(\"@\");\n    const name = at > 0 ? id.slice(0, at) : id;\n    const marketplace = at > 0 ? id.slice(at + 1) : \"\";\n    const enabled = globalSettings.enabledPlugins && globalSettings.enabledPlugins[id];\n    const globalState = enabled === false ? \"off\" : enabled === true ? \"on\" : \"unknown\";\n    const projectState = getPluginState(projectLayer, id);\n    plugins.push({\n      kind: \"plugin\",\n      id,\n      name,\n      marketplace,\n      installed: Boolean(installed[id]),\n      installPath: installed[id] ? installed[id].installPath : \"\",\n      description: installed[id] ? pluginDescription(installed[id].installPath) : \"\",\n      globalState,\n      projectState,\n      // 面板只能写 local；shared 是被仓库共享的团队配置，单独列出以便界面说明「跟随」会落到哪一层。\n      localState: getPluginState(local, id),\n      sharedState: getPluginState(shared, id),\n      effectiveState: effectiveState(projectState, globalState),\n    });\n  }\n\n  /* ---------------- mcp ---------------- */\n\n  const userMcp = globalConfig.mcpServers || {};\n  const globalConfigProject = findProjectEntry(globalConfig, ws) || {};\n  const localMcp = globalConfigProject.mcpServers || {};\n  const projectMcp = (readJson(path.join(ws, \".mcp.json\")) || {}).mcpServers || {};\n\n  // 插件自带的 MCP：plugin 包里的 .mcp.json，同样能被 deniedMcpServers 拦住。\n  const pluginMcp = {};\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const cfg = readJson(path.join(info.installPath, \".mcp.json\"));\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    for (const [name, value] of Object.entries(pluginServers(cfg))) {\n      if (!(name in pluginMcp)) pluginMcp[name] = { plugin: pluginName, config: value };\n    }\n  }\n\n  const mcpNames = new Set([\n    ...Object.keys(userMcp),\n    ...Object.keys(localMcp),\n    ...Object.keys(projectMcp),\n    ...Object.keys(pluginMcp),\n  ]);\n\n  const globalDenied = Array.isArray(globalSettings.deniedMcpServers)\n    ? globalSettings.deniedMcpServers\n    : [];\n\n  // 项目 .mcp.json 的审批结果同样写在 settings.local.json；团队层与全局层也可能\n  // 设过。布尔开关按 local > shared > 全局 取值，两个名单取并集——拒绝优先，\n  // 所以并集不会把某一层的拒绝「合并掉」。\n  const approvalLayer = (() => {\n    const out = {};\n    for (const layer of [globalSettings, shared, local]) {\n      if (layer.enableAllProjectMcpServers !== undefined) {\n        out.enableAllProjectMcpServers = layer.enableAllProjectMcpServers;\n      }\n      for (const key of [\"enabledMcpjsonServers\", \"disabledMcpjsonServers\"]) {\n        if (Array.isArray(layer[key])) {\n          out[key] = [...new Set([...(out[key] || []), ...layer[key]])];\n        }\n      }\n    }\n    return out;\n  })();\n\n  // 工作区信任与 /mcp 的手动开关都住在 ~/.claude.json 的项目条目里，\n  // 不在任何 settings 文件，所以前面几条读取路径都碰不到。\n  // hasTrustDialogAccepted 只有显式 true 才算信任；未设置、false 都按未信任处理。\n  const workspaceTrusted = globalConfigProject.hasTrustDialogAccepted === true;\n  // /mcp 里关掉的 server，键名是 disabledMcpServers（没有 Mcpjson）。\n  const runtimeDisabledInProject = Array.isArray(globalConfigProject.disabledMcpServers)\n    ? globalConfigProject.disabledMcpServers\n    : [];\n\n  const mcp = [...mcpNames].sort().map((name) => {\n    const scopes = [];\n    if (localMcp[name]) scopes.push(\"local\");\n    if (projectMcp[name]) scopes.push(\"project\");\n    if (userMcp[name]) scopes.push(\"user\");\n    if (pluginMcp[name]) scopes.push(\"plugin\");\n    const deniedGlobally = globalDenied.some((e) => e && e.serverName === name);\n    // local > project > user > plugin 是 Claude Code 的生效顺序\n    const scope = scopes[0] || \"user\";\n    const pluginEntry = pluginMcp[name];\n    const config = localMcp[name] || projectMcp[name] || userMcp[name]\n      || (pluginEntry && pluginEntry.config) || null;\n    const projectState = getMcpState(projectLayer, name);\n    const globalState = deniedGlobally ? \"off\" : \"on\";\n    // 审批只对来自项目 .mcp.json 的定义有意义；user/local/plugin 来源不弹这个窗。\n    const approval = projectMcp[name] ? getMcpApproval(approvalLayer, name) : null;\n    const projectDenied = getMcpState(projectLayer, name) === \"off\";\n    const blocked = projectMcp[name]\n      ? mcpBlockReason({\n          globalDenied: deniedGlobally,\n          projectDenied,\n          approval,\n          trusted: workspaceTrusted,\n          runtimeDisabled: runtimeDisabledInProject.includes(name),\n        })\n      : mcpBlockReason({ globalDenied: deniedGlobally, projectDenied, approval: null });\n    return {\n      kind: \"mcp\",\n      id: name,\n      name,\n      scope,\n      scopes,\n      plugin: pluginEntry ? pluginEntry.plugin : null,\n      description: mcpDescription(config),\n      globalState,\n      projectState,\n      localState: getMcpState(local, name),\n      sharedState: getMcpState(shared, name),\n      canEnable: !deniedGlobally,\n      projectDefined: Boolean(projectMcp[name]),\n      approval,\n      allApproved: approvalLayer.enableAllProjectMcpServers === true,\n      // null = 会连上；其余是卡住的原因，界面要照实说出来。\n      blocked,\n      effectiveState: blocked ? \"off\" : effectiveState(projectState, \"on\"),\n    };\n  });\n\n  /* ---------------- skills ---------------- */\n\n  const skills = [];\n  skills.push(...listSkillDirs(path.join(CLAUDE_DIR, \"skills\"), \"personal\"));\n  skills.push(...listSkillDirs(path.join(ws, \".claude\", \"skills\"), \"project\"));\n\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    skills.push(...listSkillDirs(path.join(info.installPath, \"skills\"), \"plugin\", pluginName));\n  }\n\n  const globalOverrides = globalSettings.skillOverrides || {};\n  const seen = new Map();\n  const skillRows = skills.map((s) => {\n    // 全局层同样是四态，压成 on/off 会让「仅名称」看起来像完整启用。\n    const globalState = Object.prototype.hasOwnProperty.call(globalOverrides, s.name)\n      ? getSkillState(globalSettings, s.name)\n      : \"on\";\n    const projectState = getSkillState(projectLayer, s.name);\n    const row = {\n      kind: \"skill\",\n      id: s.name,\n      name: s.name,\n      // 目录名与 frontmatter 不一致时，界面上要能看出文件在哪。\n      dirName: s.dirName,\n      source: s.source,\n      plugin: s.plugin,\n      description: s.description || \"\",\n      globalState,\n      projectState,\n      localState: getSkillState(local, s.name),\n      sharedState: getSkillState(shared, s.name),\n      effectiveState: effectiveState(projectState, globalState),\n      controllable: s.source !== \"plugin\",\n    };\n    const key = s.name;\n    if (!seen.has(key)) seen.set(key, []);\n    seen.get(key).push(s.source);\n    return row;\n  });\n\n  for (const row of skillRows) {\n    const sources = seen.get(row.name) || [];\n    row.shadowed = row.source === \"personal\" && sources.includes(\"project\");\n    if (row.controllable && sources.length > 1) {\n      row.effectiveSource = sources.includes(\"personal\") ? \"personal\" : \"project\";\n    } else if (!row.controllable) {\n      row.effectiveSource = \"plugin\";\n    } else {\n      row.effectiveSource = row.source;\n    }\n  }\n\n  /* ---------------- diagnostics ---------------- */\n\n  // 面板只列「当前存在的资源」，所以 local 里指向已消失资源的键会完全没有入口。\n  // 这里把它们找出来：stale 项可以一键清掉，其余只提示原因。\n  const diagnostics = [];\n  const seenDiag = new Set();\n  // 同名技能可能被多个来源列出（个人版与项目版、或多个插件共用 installPath），\n  // 诊断只该报一次。\n  const diag = (level, kind, id, name, message, fixable) => {\n    const key = level + \":\" + kind + \":\" + id;\n    if (seenDiag.has(key)) return;\n    seenDiag.add(key);\n    diagnostics.push({ level, kind, id, name, message, fixable: Boolean(fixable) });\n  };\n\n  // 配置文件坏了必须最优先报：这时列表里的一切都是「读不到」而不是「没设置」，\n  // 而且任何一次写入都会被拒绝（见 readForWrite）。\n  if (localRead.error) {\n    diag(\"error\", \"file\", PROJECT_SETTINGS_REL, \"settings.local.json\",\n      \"项目配置不是合法 JSON（\" + localRead.error + \"），面板不会写入，请先手动修复\", false);\n  }\n\n  const knownPlugins = new Set(plugins.map((p) => p.id));\n  for (const id of Object.keys(local.enabledPlugins || {})) {\n    if (!knownPlugins.has(id)) diag(\"stale\", \"plugin\", id, id, \"插件已不存在，本地仍保留开关\", true);\n  }\n  for (const p of plugins) {\n    if (!p.installed && p.globalState === \"on\") {\n      diag(\"warn\", \"plugin\", p.id, p.name, \"全局启用但本机未安装\", false);\n    }\n  }\n\n  const knownSkills = new Set(skillRows.map((r) => r.name));\n  for (const name of Object.keys(local.skillOverrides || {})) {\n    // 旧版本用目录名当键，遇到 frontmatter 改了 name 的技能就会留下一条\n    // Claude Code 根本不认的键；按残留报出来，用户才知道该清掉。\n    if (!knownSkills.has(name)) diag(\"stale\", \"skill\", name, name, \"技能已不存在，本地仍保留开关\", true);\n  }\n  for (const r of skillRows) {\n    const localTouched = Object.prototype.hasOwnProperty.call(local.skillOverrides || {}, r.name);\n    if (r.shadowed) diag(\"info\", \"skill\", r.id, r.name, \"项目版本被同名个人技能遮蔽\", false);\n    if (r.controllable === false && localTouched) {\n      diag(\"warn\", \"skill\", r.id, r.name, \"插件提供的技能不受本地开关控制\", false);\n    }\n  }\n\n  const knownMcp = new Set(mcpNames);\n  for (const entry of Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []) {\n    if (entry && entry.serverName && !knownMcp.has(entry.serverName)) {\n      diag(\"stale\", \"mcp\", entry.serverName, entry.serverName, \"MCP 已不存在，本地仍保留禁用\", true);\n    }\n  }\n  for (const row of mcp) {\n    if (row.sharedState === \"off\") {\n      diag(\"warn\", \"mcp\", row.id, row.name, \"团队配置已禁用，本地无法解除\", false);\n    }\n    // 待审批是「看起来配了、其实没连」，比报错更难发现，必须单独提示。\n    if (row.approval === \"pending\") {\n      diag(\"warn\", \"mcp\", row.id, row.name, \"项目 .mcp.json 里定义但尚未批准，本次会话不会连接\", false);\n    }\n    // 批准了却没被信任，是比待审批更隐蔽的一种「假绿点」：文件里明明写着批准。\n    if (row.blocked === \"untrusted\") {\n      diag(\"warn\", \"mcp\", row.id, row.name,\n        \"已批准，但工作区尚未被信任，Claude Code 仍按待审批处理；在终端里运行一次 claude 并接受信任对话框\", false);\n    }\n    if (row.blocked === \"runtime-disabled\") {\n      diag(\"warn\", \"mcp\", row.id, row.name, \"在 /mcp 里被手动关闭了；要恢复请在 /mcp 里重新启用\", false);\n    }\n  }\n  if (!workspaceTrusted && mcp.some((r) => r.projectDefined)) {\n    // 一个工作区里可能有好几个 .mcp.json server，逐条说会刷屏，这里汇总一条。\n    diag(\"info\", \"workspace\", ws, \"工作区\",\n      \"本项目尚未被信任：.mcp.json 里 server 的批准不会生效（拒绝仍然生效）\", false);\n  }\n  // 审批名单和 deniedMcpServers 一样会留残留：.mcp.json 里删掉的 server\n  // 仍占着批准/拒绝名单，列表里看不到，重装同名 server 时会突然被自动拒绝。\n  const projectMcpNames = new Set(Object.keys(projectMcp));\n  for (const key of [\"enabledMcpjsonServers\", \"disabledMcpjsonServers\"]) {\n    for (const name of Array.isArray(local[key]) ? local[key] : []) {\n      if (!projectMcpNames.has(name)) {\n        diag(\"stale\", \"mcpApproval\", name, name,\n          \"项目 .mcp.json 里已没有这个 server，本地仍保留\" + (key === \"enabledMcpjsonServers\" ? \"批准\" : \"拒绝\") + \"记录\",\n          true);\n      }\n    }\n  }\n\n  return {\n    ok: true,\n    workspace: ws,\n    files: { local: localPath, shared: sharedPath },\n    pluginCount: plugins.length,\n    plugins,\n    mcp,\n    skills: skillRows,\n    diagnostics,\n    // 界面要拿它解释「为什么批准了还没连上」。\n    workspaceTrusted,\n  };\n}\n\n/* ---------------- 记忆文件（只读） ---------------- */\n\n// Claude Code 按工作区路径生成会话目录名：非字母数字一律变 -。\n// D:\\projects\\notes\\cc-wrapped → D--projects-notes-cc-wrapped\nfunction memorySlug(ws) {\n  return path.resolve(ws).replace(/[^a-zA-Z0-9]/g, \"-\");\n}\n\n/** 从 frontmatter / 一级标题里取展示用的标题与描述。只读文件开头。 */\nfunction readMemoryMeta(file) {\n  const base = path.basename(file, \".md\");\n  try {\n    const head = fs.readFileSync(file, \"utf8\").slice(0, 8192);\n    let description = \"\";\n    const fm = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(head);\n    if (fm) {\n      const line = /^description:\\s*(.+)$/m.exec(fm[1]);\n      if (line) description = line[1].trim().replace(/^[\"']|[\"']$/g, \"\");\n    }\n    const h1 = /^#\\s+(.+)$/m.exec(head);\n    return { title: h1 ? h1[1].trim() : base, description };\n  } catch {\n    return { title: base, description: \"\" };\n  }\n}\n\n/**\n * 收集当前工作区相关的全部记忆文件，只读不改。\n *\n * 三类来源：\n *   auto     ~/.claude/projects/<slug>/memory/*.md（Claude 自己维护）\n *   project  <ws>/CLAUDE.md、<ws>/.claude/CLAUDE.md，以及上级目录链上的 CLAUDE.md\n *   user     ~/.claude/CLAUDE.md\n *\n * 返回的 path 是绝对路径，随后 memoryRead 会重新收集一遍并只认这个白名单，\n * 所以外部无法借这个动作读任意文件。\n */\nfunction collectMemory(ws) {\n  const files = [];\n  const seen = new Set();\n\n  const push = (source, root, file) => {\n    const abs = path.resolve(file);\n    if (seen.has(abs)) return;\n    let st;\n    try {\n      st = fs.statSync(abs);\n    } catch {\n      return;\n    }\n    if (!st.isFile()) return;\n    seen.add(abs);\n    const meta = readMemoryMeta(abs);\n    // 展示路径：在 root 之内就相对 root，否则相对 HOME（避免三个同名\n    // CLAUDE.md 排在一起分不清是工作区里的还是全局的）。\n    let rel = path.relative(root, abs).replace(/\\\\/g, \"/\");\n    if (!rel || rel.startsWith(\"..\")) {\n      const fromHome = path.relative(HOME, abs).replace(/\\\\/g, \"/\");\n      // 配了 CLAUDE_CONFIG_DIR 时全局文件不在 HOME 下，相对路径会是一串 ..，\n      // 这时直接给绝对路径，用户复制去编辑器才打得开。\n      rel = fromHome.startsWith(\"..\") ? abs.replace(/\\\\/g, \"/\") : \"~/\" + fromHome;\n    }\n    files.push({\n      source,\n      name: path.basename(abs),\n      rel,\n      path: abs,\n      title: meta.title,\n      description: meta.description,\n      size: st.size,\n      mtime: st.mtimeMs,\n    });\n  };\n\n  // 项目记忆：Claude Code 会从工作区向上逐级读取 CLAUDE.md。\n  // 层级限死，避免磁盘根目录上的杂项被算进来。\n  let dir = path.resolve(ws);\n  for (let depth = 0; depth < 12; depth++) {\n    push(\"project\", dir, path.join(dir, \"CLAUDE.md\"));\n    push(\"project\", dir, path.join(dir, \".claude\", \"CLAUDE.md\"));\n    const parent = path.dirname(dir);\n    if (parent === dir) break;\n    dir = parent;\n  }\n  // 新版 Claude Code 的项目规则目录，存在就一并列出。\n  const rulesDir = path.join(path.resolve(ws), \".claude\", \"rules\");\n  try {\n    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {\n      if (entry.isFile() && entry.name.endsWith(\".md\")) {\n        push(\"project\", path.resolve(ws), path.join(rulesDir, entry.name));\n      }\n    }\n  } catch {\n    // 没有 rules 目录是常态\n  }\n\n  push(\"user\", CLAUDE_DIR, path.join(CLAUDE_DIR, \"CLAUDE.md\"));\n\n  const autoDir = path.join(CLAUDE_DIR, \"projects\", memorySlug(ws), \"memory\");\n  try {\n    for (const entry of fs.readdirSync(autoDir, { withFileTypes: true })) {\n      if (entry.isFile() && entry.name.endsWith(\".md\")) {\n        push(\"auto\", autoDir, path.join(autoDir, entry.name));\n      }\n    }\n  } catch {\n    // 这个工作区还没有自动记忆，目录不存在是正常的\n  }\n\n  // 自动记忆里 MEMORY.md 是索引，排最前；其余按修改时间倒序。\n  const order = { auto: 0, project: 1, user: 2 };\n  files.sort((a, b) => {\n    if (order[a.source] !== order[b.source]) return order[a.source] - order[b.source];\n    if (a.source === \"auto\") {\n      if (a.name === \"MEMORY.md\") return -1;\n      if (b.name === \"MEMORY.md\") return 1;\n      return b.mtime - a.mtime;\n    }\n    return a.rel.localeCompare(b.rel);\n  });\n\n  return {\n    ok: true,\n    workspace: path.resolve(ws),\n    slug: memorySlug(ws),\n    autoDir,\n    autoExists: files.some((f) => f.source === \"auto\"),\n    files,\n  };\n}\n\nconst MEMORY_READ_LIMIT = 512 * 1024;\n\nfunction readMemory(ws, target) {\n  const list = collectMemory(ws);\n  const file = list.files.find((f) => f.path === path.resolve(String(target || \"\")));\n  if (!file) throw new Error(\"记忆文件不存在，或不在可读范围内\");\n  const raw = fs.readFileSync(file.path, \"utf8\");\n  // 字节数与列表里的 size 用同一口径（stat 的 size 就是 UTF-8 字节数）；\n  // 用 raw.length 会按 UTF-16 计数，中文文件在列表和正文里显示成两个数字。\n  const bytes = Buffer.byteLength(raw, \"utf8\");\n  const truncated = bytes > MEMORY_READ_LIMIT;\n  let content = raw;\n  if (truncated) {\n    // 按字符累加字节截断：直接切 Buffer 会把多字节字符拦腰截断，\n    // 末尾变成一个乱码替换符。\n    let used = 0;\n    let cut = 0;\n    for (const ch of raw) {\n      const size = Buffer.byteLength(ch, \"utf8\");\n      if (used + size > MEMORY_READ_LIMIT) break;\n      used += size;\n      cut += ch.length;\n    }\n    content = raw.slice(0, cut);\n  }\n  return {\n    ok: true,\n    file: {\n      source: file.source,\n      name: file.name,\n      rel: file.rel,\n      path: file.path,\n      title: file.title,\n      size: file.size,\n      truncated,\n      content,\n    },\n  };\n}\n\n/**\n * 诊断区的「清理残留」对所有类型都传 state=inherit，审批也一样：\n * inherit 在这里就是「把这两个名单里的这一条删掉」，等价于回到待审批。\n * 统一在这里转一次，清理路径就不用为审批开特例。\n */\nfunction approvalStateForCleanup(state) {\n  return state === \"inherit\" ? \"pending\" : state;\n}\n\nfunction set(ws, kind, id, state) {\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const current = readForWrite(localPath);\n  let next;\n  let effective;\n  if (kind === \"plugin\") next = setPluginState(current, id, state);\n  else if (kind === \"mcp\") next = setMcpState(current, id, state);\n  else if (kind === \"skill\") next = setSkillState(current, id, state);\n  else if (kind === \"mcpApproval\") {\n    const out = setMcpApproval(current, id, approvalStateForCleanup(state));\n    next = out.settings;\n    effective = out.effective;\n  } else throw new Error(\"未知类型：\" + kind);\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, settings: next, effective };\n}\n\n/** 一次写完多条：同类型共用一个文件，避免每行起一次子进程。 */\nfunction setMany(ws, opsJson) {\n  let ops;\n  try {\n    ops = JSON.parse(opsJson);\n  } catch {\n    throw new Error(\"批量操作的参数不是合法 JSON\");\n  }\n  if (!Array.isArray(ops) || ops.length === 0) throw new Error(\"批量操作为空\");\n  if (ops.length > 500) throw new Error(\"单次批量操作不能超过 500 项\");\n\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  let next = readForWrite(localPath);\n  let applied = 0;\n  for (const op of ops) {\n    if (!op || typeof op !== \"object\") continue;\n    const { kind, id, state } = op;\n    if (kind === \"plugin\") next = setPluginState(next, id, state);\n    else if (kind === \"mcp\") next = setMcpState(next, id, state);\n    else if (kind === \"skill\") next = setSkillState(next, id, state);\n    else if (kind === \"mcpApproval\") {\n      next = setMcpApproval(next, id, approvalStateForCleanup(state)).settings;\n    }\n    else throw new Error(\"未知类型：\" + kind);\n    applied += 1;\n  }\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, applied, settings: next };\n}\n\nfunction main() {\n  const argv = process.argv.slice(2);\n  const action = argv[0];\n  const ws = argv[1];\n  if (action === \"setMany\") {\n    if (!ws) throw new Error(\"用法：config-io.mjs setMany <workspace> <json>\");\n    if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n    process.stdout.write(JSON.stringify(setMany(ws, argv[2] || \"[]\")));\n    return;\n  }\n  const [, , kind, id, state] = argv;\n  if (!action || !ws) throw new Error(\"用法：config-io.mjs scan <workspace> | set <workspace> <kind> <id> <state> | memory <workspace> | memoryRead <workspace> <file>\");\n  if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n  let result = null;\n  if (action === \"scan\") result = scan(ws);\n  else if (action === \"set\") result = set(ws, kind, id, state);\n  else if (action === \"memory\") result = collectMemory(ws);\n  else if (action === \"memoryRead\") result = readMemory(ws, argv[2]);\n  if (!result) throw new Error(\"未知动作：\" + action);\n  process.stdout.write(JSON.stringify(result));\n}\n\ntry {\n  main();\n} catch (err) {\n  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));\n  process.exitCode = 1;\n}\n";

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
.wc-page-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 32px 14px; }
.wc-page-head-main { display: flex; align-items: center; gap: 12px; min-width: 0; }
.wc-page-head-actions { flex: none; display: flex; align-items: center; gap: 6px; }
.wc-page-title { font-size: 22px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; }
/* 收起态：整条压扁成一行，标题右边挂概览 chips，把纵向空间还给列表 */
.wc-head-collapsed { padding: 10px 32px; border-bottom: 1px solid rgba(127,127,127,.16); }
/* 分隔线贴着标题走，留白放到线下方——收起后页头只剩一条标题行，
   原本由统计区撑开的呼吸空间要补回来，否则列表直接顶着分隔线。 */
.wc-head-collapsed + .wc-page-fixed + .wc-center-scroll { padding-top: 22px; }
.wc-head-collapsed .wc-page-title { font-size: 15px; }
.wc-head-chips { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.wc-chip { flex: none; padding: 2px 9px; border-radius: 999px; background: rgba(127,127,127,.09); font-size: 11.5px; line-height: 18px; opacity: .85; white-space: nowrap; }
.wc-chip-accent { background: rgba(79,140,255,.15); opacity: 1; }
.wc-chip-warn { background: rgba(217,83,79,.14); color: #c92a2a; opacity: 1; }
.wc-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; opacity: .6; }
.wc-icon-btn:hover { opacity: 1; background: rgba(127,127,127,.09); }
.wc-caret-glyph { display: block; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transition: transform .15s ease; }
.wc-caret-glyph.wc-up { transform: rotate(180deg); }
.wc-page-sub { margin: 0 0 18px; font-size: 12px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-toolbar { display: flex; gap: 10px; margin: 0 0 18px; }
.wc-detail-bar { display: flex; gap: 10px; }
.wc-toolbar-row { margin: 0 0 18px; }
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
.wc-center-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; align-items: start; }
.wc-nav { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; }
.wc-nav-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; font: inherit; font-size: 13px; text-align: left; padding: 9px 12px; border: 0; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.wc-nav-item:hover { background: rgba(127,127,127,.06); }
.wc-nav-item.wc-on { background: rgba(79,140,255,.12); font-weight: 600; }
.wc-nav-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-nav-counts { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 400; }
.wc-nav-num { opacity: .5; }
.wc-nav-badge { padding: 0 5px; border-radius: 999px; background: rgba(79,140,255,.18); color: inherit; font-size: 10.5px; line-height: 16px; }
.wc-nav-item:not(.wc-on) .wc-nav-badge { background: rgba(79,140,255,.12); opacity: .8; }
.wc-detail { min-width: 0; }
.wc-detail .wc-sec { margin: 0; }
/* 记忆属于「看」而不是「改」，和三类开关之间拉一条分隔线，避免误读成一个开关类别 */
.wc-nav-sep { height: 1px; margin: 8px 6px; background: rgba(127,127,127,.16); }
.wc-mem { display: flex; flex-direction: column; gap: 10px; }
.wc-mem-head { display: flex; align-items: center; gap: 10px; }
.wc-mem-count { font-size: 12px; font-weight: 600; }
.wc-mem-dir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: .45; }
.wc-mem-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 18px; align-items: start; }
.wc-mem-list { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wc-mem-item { display: flex; flex-direction: column; gap: 2px; font: inherit; text-align: left; padding: 8px 10px; border: 0; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.wc-mem-item:hover { background: rgba(127,127,127,.06); }
.wc-mem-item.wc-on { background: rgba(79,140,255,.12); }
.wc-mem-line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wc-mem-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.wc-mem-meta { font-size: 10.5px; opacity: .45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-mem-tag { flex: none; padding: 0 6px; border-radius: 999px; font-size: 10.5px; line-height: 16px; background: rgba(127,127,127,.1); opacity: .8; }
.wc-mem-tag-auto { background: rgba(79,140,255,.16); opacity: 1; }
.wc-mem-tag-project { background: rgba(46,160,67,.16); opacity: 1; }
.wc-mem-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.wc-mem-body-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wc-mem-body-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-mem-body-meta { margin-left: auto; flex: none; font-size: 11px; opacity: .45; }
.wc-mem-path { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; opacity: .55; word-break: break-all; user-select: text; }
.wc-mem-warn { margin: 0; font-size: 11px; color: #c92a2a; }
.wc-mem-md { min-width: 0; padding: 14px 16px; border: 1px solid rgba(127,127,127,.14); border-radius: 10px; font-size: 12.5px; line-height: 1.65; user-select: text; }
.wc-mem-md > :first-child { margin-top: 0; }
.wc-mem-md > :last-child { margin-bottom: 0; }
.wc-md-h1 { font-size: 16px; } .wc-md-h2 { font-size: 14px; } .wc-md-h3, .wc-md-h4, .wc-md-h5, .wc-md-h6 { font-size: 13px; }
.wc-md-h1, .wc-md-h2, .wc-md-h3, .wc-md-h4, .wc-md-h5, .wc-md-h6 { margin: 14px 0 6px; font-weight: 600; }
.wc-md-p { margin: 6px 0; }
.wc-md-list { margin: 6px 0; padding-left: 20px; }
.wc-mem-md a { color: #4c8dff; text-decoration: none; }
.wc-mem-md a:hover { text-decoration: underline; }
.wc-md-quote { margin: 8px 0; padding: 2px 10px; border-left: 3px solid rgba(127,127,127,.3); opacity: .85; }
.wc-md-hr { border: 0; border-top: 1px solid rgba(127,127,127,.2); margin: 12px 0; }
.wc-md-code { padding: 1px 4px; border-radius: 4px; background: rgba(127,127,127,.14); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.wc-md-pre { margin: 8px 0; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,.09); overflow-x: auto; }
.wc-md-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.wc-md-table-wrap { margin: 8px 0; overflow-x: auto; }
.wc-md-table { border-collapse: collapse; font-size: 12px; }
.wc-md-table th, .wc-md-table td { padding: 4px 8px; border: 1px solid rgba(127,127,127,.2); }
.wc-md-table th { background: rgba(127,127,127,.07); font-weight: 600; }
@media (max-width: 880px) {
  .wc-mem-grid { grid-template-columns: 1fr; }
}
/* 窄屏：导航翻到顶部做横向滚动条，详情独占一行 */
@media (max-width: 880px) {
  .wc-center-layout { grid-template-columns: 1fr; gap: 14px; }
  .wc-nav { position: static; flex-direction: row; overflow-x: auto; padding-bottom: 2px; }
  .wc-nav-item { flex: none; padding: 6px 10px; font-size: 12px; }
  .wc-nav-sep { align-self: center; width: 1px; height: 16px; margin: 0 4px; }
}
.wc-path { margin: 0 0 12px; font-size: 11px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-sec { margin: 14px 0; }
.wc-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 6px 2px; }
.wc-sec-head h3 { margin: 0; font-size: 12px; font-weight: 600; opacity: .7; }
.wc-tabbar { flex: none; padding: 10px 12px 0; }
.wc-tabbar .wc-tabs { margin: 0; }
.wc-tabs { display: flex; gap: 4px; margin: 0 0 10px; padding: 3px; background: rgba(127,127,127,.06); border-radius: 9px; }
.wc-compact .wc-tabs { margin: 0; }
.wc-tab { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 6px 4px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wc-tab.wc-on { background: rgba(127,127,127,.16); font-weight: 600; }
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
/* 侧栏窄：技能四态改成下拉，省下的宽度全给名字 */
.wc-select { flex: none; max-width: 92px; font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid rgba(127,127,127,.26); border-radius: 7px; background: rgba(127,127,127,.05); color: inherit; cursor: pointer; }
.wc-select:disabled { opacity: .38; cursor: default; }
.wc-seg-unknown { padding: 0; }
/* 项目 .mcp.json 的审批：和「禁用」并排的第二根轴 */
.wc-row-actions { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.wc-approval { display: flex; align-items: center; gap: 5px; }
.wc-appr-dot { font-size: 10.5px; line-height: 16px; padding: 0 7px; border-radius: 999px; background: rgba(127,127,127,.12); opacity: .8; white-space: nowrap; }
.wc-appr-pending { background: rgba(230,150,40,.18); color: #b26a00; opacity: 1; }
.wc-appr-approved { background: rgba(46,160,67,.16); opacity: 1; }
.wc-appr-rejected { background: rgba(217,83,79,.16); color: #c92a2a; opacity: 1; }
.wc-appr-btn { font: inherit; font-size: 10.5px; padding: 1px 6px; border: 1px solid rgba(127,127,127,.24); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; opacity: .6; white-space: nowrap; }
.wc-appr-btn:hover { opacity: 1; }
.wc-appr-btn:disabled { opacity: .3; cursor: default; }
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
.wc-dot.name-only, .wc-dot.user-invocable-only { background: #f59f00; }
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

/* ---------- 诊断 ---------- */
.wc-diag { margin: 0 0 18px; padding: 12px 14px; border: 1px solid rgba(217,83,79,.28); border-radius: 10px; background: rgba(217,83,79,.05); }
.wc-diag-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.wc-diag-title { font-size: 12px; font-weight: 600; }
.wc-diag-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.wc-diag-item { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.wc-diag-name { flex: none; font-weight: 500; }
.wc-diag-msg { opacity: .65; }
.wc-diag-info { opacity: .75; }
.wc-diag-stale .wc-diag-msg { color: #c92a2a; opacity: .85; }
.wc-diag-error .wc-diag-msg { color: #c92a2a; opacity: .9; }
.wc-diag-mini { width: 100%; box-sizing: border-box; text-align: left; font: inherit; font-size: 11.5px; margin: 0 0 10px; padding: 7px 10px; border: 1px solid rgba(217,83,79,.28); border-radius: 8px; background: rgba(217,83,79,.05); color: inherit; cursor: pointer; }
.wc-diag-mini:hover { background: rgba(217,83,79,.09); }

/* ---------- 生效链路 ---------- */
.wc-item { border-bottom: 1px solid rgba(127,127,127,.12); }
.wc-item:last-child { border-bottom: 0; }
.wc-item > .wc-row { border-bottom: 0; }
.wc-main-click { cursor: pointer; }
.wc-main-click:hover { opacity: .85; }
.wc-caret { float: right; margin-left: 8px; font-size: 10px; opacity: .45; }
.wc-flow { padding: 0 0 12px; }
.wc-flow-chain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wc-flow-step { display: inline-flex; flex-direction: column; gap: 1px; padding: 6px 10px; border: 1px solid rgba(127,127,127,.18); border-radius: 8px; background: rgba(127,127,127,.04); }
.wc-flow-label { font-size: 10px; opacity: .55; }
.wc-flow-value { font-size: 12px; font-weight: 500; }
.wc-flow-strong { border-color: rgba(79,140,255,.4); background: rgba(79,140,255,.1); }
.wc-flow-arrow { font-size: 11px; opacity: .4; }
.wc-flow-note { margin: 8px 0 0; font-size: 11.5px; line-height: 1.5; opacity: .62; }

/* ---------- 反馈（共用 feedback-ui 的结构，这里只管外观） ---------- */
.wc-section { margin-top: 22px; padding-top: 16px; border-top: 1px solid rgba(127,127,127,.16); }
.wc-section-label h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.wc-section-label p { margin: 0 0 10px; font-size: 12px; opacity: .6; }
.wc-feedback-text { width: 100%; min-height: 92px; resize: vertical; box-sizing: border-box; font: inherit; font-size: 13px; line-height: 1.6; padding: 8px 11px; border: 1px solid rgba(127,127,127,.22); border-radius: 9px; background: rgba(127,127,127,.04); color: inherit; }
.wc-feedback-text:focus { outline: none; border-color: rgba(79,140,255,.5); }
.wc-feedback-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 11.5px; opacity: .6; }
.wc-feedback-count { font-variant-numeric: tabular-nums; }
.wc-feedback-quota { text-align: right; }
.wc-feedback-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.wc-feedback-issue { display: inline-flex; align-items: center; height: 32px; box-sizing: border-box; padding: 0 13px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; background: transparent; color: inherit; font-size: 12px; line-height: 1; text-decoration: none; }
.wc-feedback-issue:hover { background: rgba(127,127,127,.06); }
.wc-feedback-send { font: inherit; font-size: 12px; height: 32px; padding: 0 14px; border: 1px solid rgba(79,140,255,.45); border-radius: 8px; background: rgba(79,140,255,.14); color: inherit; cursor: pointer; }
.wc-feedback-send:hover:not(:disabled) { background: rgba(79,140,255,.22); }
.wc-feedback-send:disabled { opacity: .45; cursor: default; }
.wc-feedback-sent { border-color: rgba(55,178,77,.55); background: transparent; color: #37b24d; opacity: 1; cursor: default; }
.wc-feedback-status { margin: 10px 0 0; font-size: 12px; }
.wc-feedback-status.is-ok { color: #37b24d; font-weight: 500; }
.wc-feedback-status.is-bad { color: #e03131; }
.wc-fb-hint { font-size: 11.5px; opacity: .55; }
.wc-fb-muted { opacity: .5; }
.wc-fb-link { margin-left: 6px; padding: 0; border: 0; background: none; font: inherit; font-size: 11.5px; color: #4c8dff; text-decoration: underline; cursor: pointer; }
.wc-fb-link:disabled { opacity: .5; cursor: not-allowed; }
`;

export default function activate(ctx) {
  const { createElement: h, useEffect, useState, useRef } = ctx.react;

  const store = { ws: "", data: null, loading: false, error: "", note: "", busy: "", activeKind: "plugin", query: "", onlyOverridden: false, settings: {}, showDesc: false, headCollapsed: true, mem: null, memFile: null, memLoading: false, memFileLoading: false, memError: "" };
  const subs = new Set();

  // 反馈网络层来自共用库：endpoint 与 pluginId 都只从常量来，
  // 请求体里的 pluginId 与 User-Agent 不可能错位。
  let feedbackNet = null;
  function getFeedbackNet() {
    if (!feedbackNet) {
      feedbackNet = createFeedbackNet(ctx, {
        endpoint: FEEDBACK_ENDPOINT,
        pluginId: PLUGIN_ID,
        timeoutMs: FEEDBACK_TIMEOUT_MS,
      });
    }
    return feedbackNet;
  }

  function hostAppVersion() {
    try {
      return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
    } catch {
      return "";
    }
  }

  function set(patch) {
    Object.assign(store, patch);
    for (const fn of subs) fn();
  }

  // 设置可能在用户已经点过开关之后才读回来；以用户那次操作为准。
  let settingsTouched = false;

  async function saveSettings(patch) {
    settingsTouched = true;
    // 默认收起：列表优先。只有用户明确展开过（存了 false）才恢复展开。
    const next = Object.assign({ showDesc: false, headCollapsed: true }, store.settings, patch);
    set({
      settings: next,
      showDesc: Boolean(next.showDesc),
      headCollapsed: Boolean(next.headCollapsed),
    });
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
      set({
        settings: saved,
        showDesc: Boolean(saved.showDesc),
        // 旧版本没存过这个键时按默认值（收起）处理，Boolean(undefined) 会误判成展开。
        headCollapsed: saved.headCollapsed !== false,
      });
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

  /** 项目 .mcp.json 的审批是另一根轴，走单独的写命令，不碰 deniedMcpServers。 */
  async function applyApproval(row, next) {
    if (!store.ws) return;
    const key = "mcpApproval:" + row.id;
    set({ busy: key, error: "", note: "" });
    try {
      const res = await runIo(["set", store.ws, "mcpApproval", row.id, next]);
      await refresh(store.ws);
      // 总开关开着时「待批准」写不进去，如实说明，别让用户以为点成功了。
      if (next === "pending" && res.effective === "approved") {
        set({ note: "已从逐个名单移除，但本项目开着「全部批准 .mcp.json」，实际仍是批准的。" });
      } else {
        set({ note: "审批已改为「" + (APPROVAL_WORD[next] || next) + "」，下次会话生效。" });
      }
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

  /* ------------------------------------------------------------ 记忆（只读） */

  // 记忆文件分三类来源，全部只读：定位与读取都在 config-io 里做，
  // 这里只负责把结果放进 store。写入路径一概没有——自动记忆的增删
  // 归 Claude 自己维护，插件动它只会破坏索引与正文的一致性。
  let memSeq = 0;

  async function loadMemory() {
    const ws = store.ws;
    if (!ws) return;
    const seq = ++memSeq;
    set({ memLoading: true, memError: "" });
    try {
      const res = await runIo(["memory", ws]);
      if (seq !== memSeq) return;
      // 列表变了之后旧的选中项可能已不存在，顺手清掉，避免右侧还挂着已删文件。
      const stillThere = store.memFile
        && (res.files || []).some((f) => f.path === store.memFile.path);
      set({
        mem: res,
        memLoading: false,
        memFile: stillThere ? store.memFile : null,
      });
    } catch (err) {
      if (seq !== memSeq) return;
      set({ memLoading: false, memError: String((err && err.message) || err) });
    }
  }

  async function openMemoryFile(file) {
    const ws = store.ws;
    if (!ws || !file) return;
    set({ memFileLoading: true, memError: "" });
    try {
      const res = await runIo(["memoryRead", ws, file.path]);
      set({ memFile: res.file, memFileLoading: false });
    } catch (err) {
      set({ memFileLoading: false, memError: String((err && err.message) || err) });
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

  // sharedState / localState 由 scan 分别给出：前者是仓库里的 .claude/settings.json（团队层），
  // 后者是面板真正能写的 .claude/settings.local.json。projectState 是二者合并后的结果。
  const teamTouched = (row) => Boolean(row.sharedState && row.sharedState !== "inherit");

  /** 团队层的显式值；侧栏空间有限，只在 compact 时省略括号说明。 */
  function teamNote(row, compact) {
    if (!teamTouched(row)) return "";
    const word = row.sharedState === "off" ? "团队禁用" : "团队启用";
    // MCP 的 deniedMcpServers 跨层 union，团队禁用的条目在本地没有任何办法解除。
    if (row.kind === "mcp" && row.sharedState === "off" && !compact) {
      return word + "（本地不可解除）";
    }
    return word;
  }

  function metaOf(row, compact) {
    const team = teamNote(row, compact);
    if (row.kind === "plugin") {
      const g = row.globalState === "on" ? "全局启用" : row.globalState === "off" ? "全局禁用" : "全局未记录";
      return ["插件", row.marketplace || "未知市场", g, team, row.installed ? "" : "未安装"]
        .filter(Boolean).join(" · ");
    }
    if (row.kind === "mcp") {
      const g = row.globalState === "off" ? "全局已禁用" : "全局可用";
      const src = row.scope === "plugin"
        ? "继承自插件 " + (row.plugin || "内置")
        : "继承 " + row.scope;
      // 审批只对项目 .mcp.json 定义的 server 存在；其余来源没有这一步。
      const appr = row.projectDefined
        ? (row.allApproved && row.approval === "approved" ? "全部批准" : APPROVAL_WORD[row.approval] || "")
        : "";
      // 卡住的层单独标出来：审批说「已批准」而圆点是灰的，不给理由就是矛盾。
      const stuck = row.blocked && !["rejected", "pending"].includes(row.blocked)
        ? BLOCK_WORD[row.blocked] || ""
        : "";
      return ["MCP", src, g, team, appr, stuck].filter(Boolean).join(" · ");
    }
    const src = row.source === "plugin"
      ? "插件 " + (row.plugin || "")
      : row.source === "personal" ? "个人" : "项目";
    const g = row.globalState === "off" ? "全局禁用" : "全局可用";
    // 目录名和技能名不一致时点出来：用户按名字找不到对应目录会以为面板写错了。
    const dir = row.dirName && row.dirName !== row.name ? "目录 " + row.dirName : "";
    return ["技能", src, g, team, dir, row.shadowed ? "同名个人版优先" : ""].filter(Boolean).join(" · ");
  }

  // 技能的取值有四种（on / name-only / user-invocable-only / off），
  // 最后两个不是「禁用」，压成开/关会在用户点「启用」时把原值改掉。
  const SKILL_WORD = {
    on: "启用",
    "name-only": "仅名称",
    "user-invocable-only": "仅手动",
    off: "禁用",
    unknown: "其它",
    inherit: "跟随",
  };
  const SKILL_TIP = {
    on: "名称和描述都给 Claude，也在 / 菜单里",
    "name-only": "只把名称给 Claude，省掉描述；仍在 / 菜单里",
    "user-invocable-only": "对 Claude 隐藏，只能在 / 菜单手动调用",
    off: "对 Claude 和 / 菜单都隐藏",
    unknown: "是本插件不认识的取值；为避免改坏，这里只显示、不写入",
  };

  const APPROVAL_WORD = {
    pending: "待批准",
    approved: "已批准",
    rejected: "已拒绝",
  };
  const APPROVAL_TIP = {
    pending: "项目 .mcp.json 里定义了它，但还没在 Claude Code 里批准；本次会话不会连接。",
    approved: "已批准，Claude Code 会连接它。",
    rejected: "已在项目里拒绝，优先于「全部批准」；改动后新会话生效。",
  };

  /**
   * 卡住的原因。审批只是其中一层：被禁用、/mcp 关掉、工作区没信任
   * 都会让一个「已批准」的 server 实际连不上，绿点必须为这些情况变灰。
   */
  const BLOCK_WORD = {
    "global-denied": "全局禁用",
    "project-denied": "项目禁用",
    rejected: "已拒绝",
    pending: "待批准",
    untrusted: "工作区未信任",
    "runtime-disabled": "/mcp 已关闭",
  };
  const BLOCK_TIP = {
    "global-denied": "全局 settings.json 的 deniedMcpServers 已禁止它，项目级无法解除。",
    "project-denied": "项目配置的 deniedMcpServers 禁用了它；点上面的开关恢复跟随即可。",
    rejected: "项目 .mcp.json 的审批结果是拒绝；改成已批准后才会连接。",
    pending: "还没批准；点旁边的按钮批准后才会连接。",
    untrusted:
      "已批准，但当前工作区尚未被 Claude Code 信任，批准不生效。在终端里运行一次 claude 并接受信任对话框；拒绝不受此限制。",
    "runtime-disabled":
      "在 /mcp 里被手动关了（记在 ~/.claude.json 的项目条目里）。这个开关不在本面板的写入范围内，请到 /mcp 里重新启用。",
  };

  /**
   * 项目 .mcp.json 定义的 server 还要单独走一道审批，和「禁用」是两码事：
   * 禁用写在 deniedMcpServers，审批写在 enabled/disabledMcpjsonServers。
   * 两者都成立才算真的连上，所以分开摆在同一个行里。
   */
  function ApprovalSeg({ row, compact }) {
    if (!row.projectDefined) return null;
    const busyKey = "mcpApproval:" + row.id;
    const busy = store.busy === busyKey;
    const state = row.approval || "pending";
    // 工作区没信任时，「批准」按下去也不会生效，按钮要提前说明，别让人白点。
    const trustBlocked = !(store.data && store.data.workspaceTrusted) && state !== "rejected";
    const cycle = state === "approved" ? "rejected" : "approved";
    // 总开关开着时，单个「待批准」做不到：只能批准或拒绝，界面要说清楚。
    const lockPending = row.allApproved && state === "approved";
    const stuck = row.blocked && row.blocked !== "rejected" && row.blocked !== "pending";
    return h("div", { className: "wc-approval" },
      h("span", {
        className: "wc-appr-dot wc-appr-" + state,
        title: APPROVAL_TIP[state]
          + (lockPending ? "（当前项目开了「全部批准」，无法单独回到待批准）" : "")
          + (trustBlocked ? "（工作区未信任，批准不会生效）" : ""),
      }, APPROVAL_WORD[state] || state),
      stuck
        ? h("span", {
            className: "wc-appr-dot wc-appr-pending",
            title: BLOCK_TIP[row.blocked] || "",
          }, BLOCK_WORD[row.blocked] || row.blocked)
        : null,
      h("button", {
        type: "button",
        className: "wc-appr-btn",
        disabled: busy,
        title: "切成「" + (APPROVAL_WORD[cycle] || cycle) + "」",
        onClick: () => {
          if (busy) return;
          void applyApproval(row, cycle);
        },
      }, busy ? "…" : (compact ? "" : "改为" + (APPROVAL_WORD[cycle] || cycle)))
    );
  }

  function Seg({ row, compact }) {
    const team = teamTouched(row);
    // 选中态必须落在 local：面板只写 settings.local.json，落在合并结果上会让点击「跟随」后按钮弹回。
    const active = row.localState !== undefined ? row.localState : row.projectState;
    const followLabel = compact
      ? (team ? "跟随团队" : "跟随")
      : (team ? "跟随团队配置" : "跟随全局");
    const followTitle = team
      ? (row.kind === "mcp" && row.sharedState === "off"
          ? "团队配置已禁用；MCP 的禁用名单跨层合并，本地无法解除"
          : "清除本地覆盖后，生效值来自团队配置 .claude/settings.json")
      : "不写项目配置，沿用全局";
    // 团队层已禁用 MCP 时，本地写什么都不会生效，「跟随」按钮保持可见但禁用，避免点了没反应。
    const followDead = row.kind === "mcp" && row.sharedState === "off";
    const opts = row.kind === "mcp"
      ? [[followLabel, "inherit"], [compact ? "关闭" : "项目禁用", "off"]]
      : row.kind === "skill"
        ? [
            [followLabel, "inherit"],
            [SKILL_WORD.on, "on"],
            [SKILL_WORD["name-only"], "name-only"],
            [SKILL_WORD["user-invocable-only"], "user-invocable-only"],
            [SKILL_WORD.off, "off"],
          ]
        : [
            [followLabel, "inherit"],
            [compact ? "开" : "启用", "on"],
            [compact ? "关" : "禁用", "off"],
          ];
    // 不认识的取值只展示，不给按钮——任何点击都会覆盖掉原有设置。
    if (row.kind === "skill" && active === "unknown") {
      return h("div", { className: "wc-seg wc-seg-unknown" },
        h("span", { className: "wc-btn wc-on", title: SKILL_TIP.unknown }, "其它取值")
      );
    }
    const disabledFor = (value) =>
      row.busy || (value === "on" && !row.allowOn) || (value === "inherit" && followDead);
    // 侧栏只有一行的宽度：技能有五档，摆成一排按钮会把名字挤没，改用下拉。
    if (compact && opts.length > 3) {
      const current = opts.some(([, value]) => value === active) ? active : "inherit";
      return h("select", {
        className: "wc-select" + (row.busy ? " wc-busy" : ""),
        disabled: row.busy,
        title: "技能可见性：" + (SKILL_TIP[active] || ""),
        value: current,
        onChange: (e) => {
          const value = e.target.value;
          if (row.busy || value === current) return;
          void apply(row, value);
        },
      },
        opts.map(([label, value]) =>
          h("option", { key: value, value, disabled: disabledFor(value) }, label))
      );
    }
    return h("div", { className: "wc-seg" },
      opts.map(([label, value]) =>
        h("button", {
          key: value,
          type: "button",
          className: "wc-btn" + (active === value ? " wc-on" : ""),
          disabled: disabledFor(value),
          title: value === "on" && !row.allowOn
            ? "当前无法启用"
            : value === "inherit" ? followTitle : (SKILL_TIP[value] || undefined),
          onClick: () => {
            if (row.busy || active === value) return;
            void apply(row, value);
          },
        }, label)
      )
    );
  }

  function effectiveLabel(row) {
    if (row.effectiveState === "on") return "生效：开";
    if (row.effectiveState === "name-only") return "生效：仅名称";
    if (row.effectiveState === "user-invocable-only") return "生效：仅手动调用";
    if (row.effectiveState === "off") {
      // 灰点要说得出是哪一层挡住的，否则用户会以为开关坏了。
      if (row.blocked && BLOCK_WORD[row.blocked]) return "生效：关（" + BLOCK_WORD[row.blocked] + "）";
      return "生效：关";
    }
    return "生效：未知";
  }

  /* ------------------------------------------------------------ 生效链路 */

  const LAYER_WORD = {
    team: { inherit: "未设置", on: "启用", "name-only": "仅名称", "user-invocable-only": "仅手动", off: "禁用", unknown: "其它" },
    local: { inherit: "跟随", on: "启用", "name-only": "仅名称", "user-invocable-only": "仅手动", off: "禁用", unknown: "其它" },
    effective: { on: "开", "name-only": "仅名称", "user-invocable-only": "仅手动", off: "关", unknown: "未知" },
  };

  function flowSteps(row) {
    const globalWord = row.kind === "mcp"
      ? (row.globalState === "off" ? "禁用" : "可用")
      : (LAYER_WORD.local[row.globalState] || "未记录");
    const steps = [
      { label: "全局", value: globalWord },
      { label: "团队配置", value: LAYER_WORD.team[row.sharedState || "inherit"] },
      { label: "本地", value: LAYER_WORD.local[row.localState || "inherit"] },
      { label: "最终", value: LAYER_WORD.effective[row.effectiveState] || "未知", strong: true },
    ];
    // 项目 .mcp.json 的 server 还多一道审批，不写进链路用户会以为「本地已启用」就够了。
    if (row.kind === "mcp" && row.projectDefined) {
      steps.splice(3, 0, {
        label: "审批",
        value: (row.allApproved && row.approval === "approved" ? "全部批准" : APPROVAL_WORD[row.approval]) || "未知",
      });
    }
    return steps;
  }

  function flowNote(row) {
    if (row.kind === "mcp" && row.blocked === "untrusted") {
      return "已批准，但当前工作区还没被 Claude Code 信任，批准不生效，仍按待审批处理。"
        + "在终端里运行一次 claude 并接受信任对话框即可；拒绝不受这条限制。";
    }
    if (row.kind === "mcp" && row.blocked === "runtime-disabled") {
      return "在 /mcp 里被手动关闭了，记录在 ~/.claude.json 的项目条目里，不在本面板的写入范围。"
        + "要恢复请到 /mcp 里重新启用。";
    }
    if (row.kind === "mcp" && row.approval === "pending") {
      return "项目 .mcp.json 里定义了它，但还没批准，本次会话不会连接；点上方「待批准」旁的按钮改为已批准后，下次会话生效。";
    }
    if (row.kind === "mcp" && row.approval === "rejected") {
      return "已在项目里拒绝这个 server。拒绝优先于「全部批准」，改成已批准后才会连接。";
    }
    if (row.kind === "mcp" && row.sharedState === "off") {
      return "团队配置里禁用了它。MCP 的禁用名单跨层合并，本地无法解除；要恢复请修改仓库的 .claude/settings.json。";
    }
    if ((row.localState || "inherit") !== "inherit") {
      return row.kind === "mcp"
        ? "本地写入的禁用优先于全局。"
        : "本地覆盖优先于团队配置与全局。";
    }
    if ((row.sharedState || "inherit") !== "inherit") {
      return "本地没有覆盖，沿用团队配置的值。";
    }
    return "本地与团队配置都未设置，沿用全局。";
  }

  function Flow({ row }) {
    const chain = [];
    flowSteps(row).forEach((step, i) => {
      if (i > 0) chain.push(h("span", { key: "a" + i, className: "wc-flow-arrow" }, "→"));
      chain.push(h("span", {
        key: "s" + i,
        className: "wc-flow-step" + (step.strong ? " wc-flow-strong" : ""),
      },
        h("span", { className: "wc-flow-label" }, step.label),
        h("span", { className: "wc-flow-value" }, step.value)
      ));
    });
    return h("div", { className: "wc-flow" },
      h("div", { className: "wc-flow-chain" }, chain),
      h("p", { className: "wc-flow-note" }, flowNote(row))
    );
  }

  function Row({ row, compact, showDesc }) {
    const v = view(row);
    const [open, setOpen] = useState(false);
    const locked = row.kind === "skill" && row.controllable === false;
    // 侧栏要简洁：链路展开只在中央视图提供。
    const expandable = !compact;
    return h("div", { className: "wc-item" },
      h("div", { className: "wc-row" },
        h("div", {
          className: "wc-main" + (expandable ? " wc-main-click" : ""),
          onClick: expandable ? () => setOpen((x) => !x) : undefined,
          role: expandable ? "button" : undefined,
          tabIndex: expandable ? 0 : undefined,
          "aria-expanded": expandable ? open : undefined,
          onKeyDown: expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((x) => !x);
                }
              }
            : undefined,
        },
          h("div", { className: "wc-name" },
            h("span", {
              // 中间两态用黄点：既不是完全开着，也不是关掉，绿/灰都不准确。
              className: "wc-dot " + (row.effectiveState === "on" ? "on" : row.effectiveState === "off" ? "off" : "name-only"),
              title: effectiveLabel(row),
              "aria-label": effectiveLabel(row),
            }),
            row.name,
            expandable ? h("span", { className: "wc-caret" }, open ? "▾" : "▸") : null
          ),
          h("div", { className: "wc-meta" }, metaOf(row, compact)),
          // 非项目来源的 server 被 /mcp 关掉时，这一行没有审批控件，
          // 不额外标一句的话，灰点就完全没解释。
          row.kind === "mcp" && !row.projectDefined && row.blocked === "runtime-disabled"
            ? h("div", { className: "wc-desc", title: BLOCK_TIP["runtime-disabled"] }, "在 /mcp 里被关闭")
            : null,
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
        : row.kind === "mcp" && row.projectDefined
          ? h("div", { className: "wc-row-actions" },
              h(Seg, { row: v, compact }),
              h(ApprovalSeg, { row: v, compact })
            )
          : h(Seg, { row: v, compact })
      ),
      open && expandable ? h(Flow, { row }) : null
    );
  }

  // 批量操作只写 local，所以「已覆盖」也只能按 localState 统计；
  // 团队层的值会在点「跟随」后重新生效，不该算成用户可清除的覆盖。
  const locallyOverridden = (row) => row.localState !== undefined
    ? row.localState !== "inherit"
    : row.projectState !== "inherit";

  function BulkBar({ rows, filtered, busy }) {
    const [confirming, setConfirming] = useState("");
    const overridden = rows.filter(locallyOverridden);

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

  /* ------------------------------------------------------------ 诊断 */

  // 残留键在列表里根本不会出现（scan 只列现存资源），所以清理入口必须放在诊断区。
  function Diagnostics({ data }) {
    const [confirming, setConfirming] = useState(false);
    const list = data.diagnostics || [];
    // 一切正常就整块不渲染：占一行绿色回执只会挤占列表空间。
    if (list.length === 0) return null;
    const fixable = list.filter((d) => d.fixable);
    const clean = () => {
      setConfirming(false);
      void applyMany(
        fixable.map((d) => ({ kind: d.kind, id: d.id, state: "inherit" })),
        "已清理残留",
      );
    };
    return h("div", { className: "wc-diag" },
      h("div", { className: "wc-diag-head" },
        h("span", { className: "wc-diag-title" },
          "诊断 · " + list.length + (fixable.length ? "（" + fixable.length + " 项可清理）" : "")),
        fixable.length === 0
          ? null
          : confirming
            ? h("span", { style: { display: "flex", gap: 8 } },
                h("button", { type: "button", className: "wc-bulk-btn wc-danger", onClick: clean }, "确认清理"),
                h("button", { type: "button", className: "wc-bulk-btn", onClick: () => setConfirming(false) }, "取消"))
            : h("button", { type: "button", className: "wc-bulk-btn", onClick: () => setConfirming(true) },
                "清理残留（" + fixable.length + "）")
      ),
      h("ul", { className: "wc-diag-list" },
        list.slice(0, 8).map((d, i) => h("li", {
          key: i + ":" + d.kind + ":" + d.id,
          className: "wc-diag-item wc-diag-" + d.level,
        },
          h("span", { className: "wc-diag-name" }, d.name),
          h("span", { className: "wc-diag-msg" }, d.message)
        )),
        list.length > 8
          ? h("li", { className: "wc-diag-item wc-diag-info" },
              h("span", { className: "wc-diag-msg" }, "还有 " + (list.length - 8) + " 条…"))
          : null
      )
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
        const covered = g.rows.filter(locallyOverridden).length;
        return h("div", { className: "wc-stat", key: g.label },
          h("div", { className: "wc-stat-num" }, g.rows.length),
          h("div", { className: "wc-stat-label" },
            g.label + (covered ? " · 本地覆盖 " + covered : " · 本地未覆盖"))
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

  function Section({ title, rows, empty, compact, hideTitle, foldLocked, showDesc, action }) {
    const [foldOpen, setFoldOpen] = useState(false);
    const sorted = sortRows(rows);
    const main = foldLocked ? sorted.filter((row) => row.controllable !== false) : sorted;
    const locked = foldLocked ? sorted.filter((row) => row.controllable === false) : [];
    return h("section", { className: "wc-sec" },
      hideTitle && !action
        ? null
        : h("div", { className: "wc-sec-head" },
            hideTitle ? h("span", null) : h("h3", null, title),
            action || null
          ),
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

  // 记忆文件：只读浏览。自动记忆里「CONTEXT.md」这种入口与正文混在一起，
  // 所以列表统一给出来源标签，正文用共用库的 Markdown 渲染（纯节点，不拼 HTML）。
  const MEM_SOURCE_LABEL = { auto: "自动记忆", project: "项目", user: "个人全局" };

  function formatTime(ms) {
    const d = new Date(Number(ms) || 0);
    if (!isFinite(d.getTime())) return "";
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function MemoryView({ s, onPick, onRefresh }) {
    const mem = s.mem;
    const current = s.memFile;

    if (!mem) {
      return h("div", { className: "wc-mem" },
        s.memError
          ? h("p", { className: "wc-err" }, s.memError)
          : h("p", { className: "wc-empty" }, s.memLoading ? "读取记忆文件…" : "还没有读取。"),
        h("button", {
          type: "button",
          className: "wc-refresh",
          disabled: s.memLoading,
          onClick: onRefresh,
        }, s.memLoading ? "读取中…" : "重新读取")
      );
    }

    const files = mem.files || [];
    const fileItem = (f) => h("button", {
      key: f.path,
      type: "button",
      className: "wc-mem-item" + (current && current.path === f.path ? " wc-on" : ""),
      title: f.path,
      onClick: () => onPick(f),
    },
      h("span", { className: "wc-mem-line1" },
        h("span", { className: "wc-mem-name" }, f.title || f.name),
        h("span", { className: "wc-mem-tag wc-mem-tag-" + f.source }, MEM_SOURCE_LABEL[f.source] || f.source)
      ),
      h("span", { className: "wc-mem-meta" },
        f.rel + " · " + formatSize(f.size) + " · " + formatTime(f.mtime))
    );

    const body = !current
      ? h("p", { className: "wc-empty" },
          files.length === 0 ? "这个工作区还没有任何记忆文件。" : "从左侧选择一个文件查看内容。")
      : h("div", { className: "wc-mem-body" },
          h("div", { className: "wc-mem-body-head" },
            h("span", { className: "wc-mem-body-title" }, current.title || current.name),
            h("span", { className: "wc-mem-tag wc-mem-tag-" + current.source },
              MEM_SOURCE_LABEL[current.source] || current.source),
            h("span", { className: "wc-mem-body-meta" }, formatSize(current.size))
          ),
          // 路径要能选中复制：用户经常需要拿它去编辑器里改，插件不提供编辑。
          h("p", { className: "wc-mem-path", title: "只读；修改请用编辑器打开此文件" }, current.path),
          current.truncated
            ? h("p", { className: "wc-mem-warn" }, "文件较大，只显示前 512 KB。")
            : null,
          h("div", { className: "wc-mem-md wc-md" }, renderMarkdown(h, current.content || "", { prefix: "wc" }))
        );

    return h("div", { className: "wc-mem" },
      h("div", { className: "wc-mem-head" },
        h("span", { className: "wc-mem-count" }, files.length + " 个记忆文件 · 只读"),
        h("span", { className: "wc-mem-dir", title: mem.autoDir }, mem.slug),
        h("button", {
          type: "button",
          className: "wc-refresh",
          disabled: s.memLoading,
          onClick: onRefresh,
        }, s.memLoading ? "读取中…" : "重新读取")
      ),
      s.memError ? h("p", { className: "wc-err" }, s.memError) : null,
      h("div", { className: "wc-mem-grid" },
        h("div", { className: "wc-mem-list" },
          files.length === 0
            ? h("p", { className: "wc-empty" }, "没有找到记忆文件")
            : files.map(fileItem)
        ),
        h("div", { className: "wc-mem-detail" },
          s.memFileLoading ? h("p", { className: "wc-empty" }, "读取中…") : body
        )
      ),
      h("p", { className: "wc-tip" },
        "只读。自动记忆由 Claude 自己维护，插件不提供增删改；需要修改请用编辑器打开上面的路径。")
    );
  }

  // 状态与提交逻辑在共用库 feedback-ui（四插件同一套），这里只把它接到
  // 本插件的网络层与 wc-* 样式上。
  function FeedbackSection() {
    const form = useFeedbackForm(ctx.react, {
      repo: FEEDBACK_REPO,
      pluginName: FEEDBACK_PLUGIN_NAME,
      pluginVersion: ctx.version,
      hostVersion: hostAppVersion(),
      send: (text) => getFeedbackNet().send(text),
      quota: () => getFeedbackNet().quota(),
    });
    return form.render(h, {
      prefix: "wc",
      variant: "section",
      rows: 5,
      classes: {
        input: "wc-feedback-text",
        primaryBtn: "wc-feedback-send",
        secondaryBtn: "wc-feedback-issue",
        hint: "wc-fb-hint",
        note: "wc-feedback-status",
        linkBtn: "wc-fb-link",
        muted: "wc-fb-muted",
      },
    });
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
        "描述只在中央「工作区配置」里显示，右侧面板始终简洁。"),
      h(FeedbackSection, null)
    );
  }

  // 顶部区（统计 + 诊断 + 工具栏）可整体收起，把纵向空间还给列表。
  // 收起后仍留一条紧凑条：标题、条数、覆盖数、诊断数都还在，双击或点按钮展开。
  function CenterHeader({ data, s, groups, active }) {
    const collapsed = Boolean(s.headCollapsed);
    const overridden = (data.plugins || []).concat(data.mcp || [], data.skills || [])
      .filter(locallyOverridden).length;
    const diagCount = (data.diagnostics || []).length;
    const toggle = () => { void saveSettings({ headCollapsed: !collapsed }); };

    return h("div", { className: "wc-page-head" + (collapsed ? " wc-head-collapsed" : "") },
      h("div", { className: "wc-page-head-main" },
        h("div", { className: "wc-page-title" }, "工作区配置"),
        collapsed
          ? h("span", { className: "wc-head-chips" },
              h("span", { className: "wc-chip" },
                (data.plugins || []).length + " 插件 · " + (data.mcp || []).length + " MCP · " + (data.skills || []).length + " 技能"),
              // 记忆数只有读过一次才有值，没读过就不显示，免得写个「记忆 0」误导。
              s.mem
                ? h("span", { className: "wc-chip" }, "记忆 " + (s.mem.files || []).length)
                : null,
              overridden > 0
                ? h("span", { className: "wc-chip wc-chip-accent" }, "覆盖 " + overridden)
                : null,
              diagCount > 0
                ? h("span", { className: "wc-chip wc-chip-warn" }, "诊断 " + diagCount)
                : null
            )
          : null
      ),
      h("div", { className: "wc-page-head-actions" },
        h("button", {
          type: "button",
          className: "wc-icon-btn",
          title: collapsed ? "展开统计与筛选" : "收起统计与筛选，给列表更多空间",
          "aria-expanded": collapsed ? "false" : "true",
          onClick: toggle,
        }, h("span", { className: "wc-caret-glyph" + (collapsed ? "" : " wc-up") })),
        h("button", {
          type: "button",
          className: "wc-refresh",
          disabled: s.loading,
          onClick: () => {
            if (!s.ws) return;
            void refresh(s.ws);
            // 记忆已经读过一次的话跟着刷新，省得用户再点一次。
            if (s.mem) void loadMemory();
          },
        }, s.loading ? "读取中…" : "刷新")
      )
    );
  }

  function Body({ mode, part }) {
    const s = useStore();
    if (!s.data) {
      if (part === "list" || part === "tabs") return null;
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

    const active = groups.some((g) => g.key === s.activeKind) ? s.activeKind : "plugin";
    const current = groups.find((g) => g.key === active);
    const memActive = s.activeKind === "memory";

    if (mode === "center") {
      // 头部拆成两段：标题栏（CenterHeader）常驻，统计/诊断/工具栏随「收起」隐藏。
      if (part === "head" && !s.headCollapsed) {
        return h("div", { className: "wc-body" },
          h("p", { className: "wc-page-sub", title: data.workspace },
            "工作区：" + data.workspace + " · 只影响当前工作区，全局配置由 CC Switch 管理。"),
          h(Stats, { data }),
          h(Diagnostics, { data }),
          // 记忆是只读浏览，没有「当前类别」也没有本地覆盖的概念，工具栏整块不出。
          memActive ? null : h("div", { className: "wc-detail-bar wc-toolbar-row" },
            h("input", {
              className: "wc-search",
              type: "search",
              placeholder: "搜索当前类别：" + current.title,
              value: s.query || "",
              onChange: (e) => set({ query: e.target.value }),
            }),
            h("button", {
              type: "button",
              className: "wc-filter" + (s.onlyOverridden ? " wc-on" : ""),
              title: "只显示在 settings.local.json 里被本机改过的项",
              onClick: () => set({ onlyOverridden: !s.onlyOverridden }),
            }, "只看本地覆盖")
          )
        );
      }
      if (part === "head") return null;
      const q = String(s.query || "").trim().toLowerCase();
      const only = Boolean(s.onlyOverridden);
      // 搜索与筛选只作用于当前类别：一次只看一类，不存在「搜了三个列表」的歧义。
      const visible = memActive ? [] : current.rows.filter((row) =>
        (!q || String(row.name).toLowerCase().includes(q)) &&
        (!only || locallyOverridden(row))
      );
      const navItem = (g) => {
        const covered = g.rows.filter(locallyOverridden).length;
        return h("button", {
          key: g.key,
          type: "button",
          className: "wc-nav-item" + (active === g.key && !memActive ? " wc-on" : ""),
          "aria-current": active === g.key && !memActive ? "true" : undefined,
          onClick: () => {
            // 换类别时清掉上一个类别留下的搜索词，避免「切过去一片空白」。
            set({ activeKind: g.key, query: "" });
          },
        },
          h("span", { className: "wc-nav-name" }, g.title),
          h("span", { className: "wc-nav-counts" },
            h("span", { className: "wc-nav-num" }, g.rows.length),
            covered > 0
              ? h("span", { className: "wc-nav-badge", title: "在本项目被改过的项数" }, covered)
              : null
          )
        );
      };
      const memCount = s.mem ? (s.mem.files || []).length : 0;
      const memNav = h("button", {
        key: "memory",
        type: "button",
        className: "wc-nav-item" + (memActive ? " wc-on" : ""),
        "aria-current": memActive ? "true" : undefined,
        onClick: () => {
          set({ activeKind: "memory", query: "" });
          // 进这个类别才读一次：记忆文件与配置无关，不该拖慢每次扫描。
          if (!s.mem && !s.memLoading) void loadMemory();
        },
      },
        h("span", { className: "wc-nav-name" }, "记忆"),
        h("span", { className: "wc-nav-counts" },
          h("span", { className: "wc-nav-num" }, s.mem ? memCount : "—")
        )
      );
      // 左侧导航 + 右侧详情：导航常驻，右侧只渲染当前类别。
      return h("div", { className: "wc-body" },
        h("div", { className: "wc-center-layout" },
          h("nav", { className: "wc-nav", "aria-label": "配置类别" },
            groups.map(navItem),
            h("div", { className: "wc-nav-sep", "aria-hidden": "true" }),
            memNav
          ),
          h("div", { className: "wc-detail" },
            memActive
              ? h(MemoryView, { s, onPick: openMemoryFile, onRefresh: () => { void loadMemory(); } })
              : h(Section, {
                  title: current.title + "（" + current.rows.length + "）",
                  rows: visible,
                  empty: q || only ? "没有匹配的项" : current.empty,
                  compact: false,
                  foldLocked: current.fold,
                  showDesc: s.showDesc,
                  action: h(BulkBar, {
                    rows: current.rows,
                    filtered: visible,
                    busy: s.busy === "many",
                  }),
                })
          )
        ),
        tip
      );
    }

    // 页内页签条固定在滚动区外：列表再长也不会把切换器顶走。
    if (part === "tabs") {
      return h("div", { className: "wc-tabbar" },
        h("div", { className: "wc-tabs" },
          groups.map((g) => h("button", {
            key: g.key,
            type: "button",
            className: "wc-tab" + (active === g.key ? " wc-on" : ""),
            onClick: () => set({ activeKind: g.key }),
          }, g.title + "（" + g.rows.length + "）"))
        )
      );
    }

    return h("div", { className: "wc-body" },
      h("p", { className: "wc-path", title: data.workspace }, "工作区：" + data.workspace),
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
    const scrollRef = useRef(null);
    useEffect(() => {
      const ws = workspacePath || "";
      // 换工作区时记忆列表必须一起作废，否则会显示上一个工作区的文件。
      set({ ws, data: null, error: "", note: "", mem: null, memFile: null, memError: "" });
      if (ws) void refresh(ws);
    }, [workspacePath]);
    // 切页内页签时回到顶部：换了类别还停在上一类的滚动位置，
    // 看上去就像「点了没反应」。
    useEffect(() => {
      const el = scrollRef.current;
      if (el && typeof el.scrollTop === "number") el.scrollTop = 0;
    }, [s.activeKind]);
    return h("div", { className: "wc-root wc-compact" },
      h(Head, { s, onRefresh: () => refresh(workspacePath || s.ws) }),
      // 页内页签放在滚动区之外：列表多长都不影响切换。
      h(Body, { mode: "panel", part: "tabs" }),
      h("div", { className: "wc-scroll", ref: scrollRef },
        s.data && (s.data.diagnostics || []).length > 0
          ? h("button", {
              type: "button",
              className: "wc-diag-mini",
              onClick: () => { ctx.ui.openCenterTab(TAB_KEY); },
            }, "诊断 " + s.data.diagnostics.length + " 项 · 打开中央面板清理")
          : null,
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
                      set({ ws: row.path, data: null, error: "", note: "", mem: null, memFile: null, memError: "" });
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
      s.data
        ? h(CenterHeader, { data: s.data, s })
        : h("div", { className: "wc-page-head" },
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
