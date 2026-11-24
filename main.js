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


const SCAN_SOURCE = "/* 三态模型：项目级配置只表达「跟随全局 / 启用 / 禁用」，不碰全局文件。\n * 纯函数，浏览器与 node 都能跑；写操作一律返回新对象。 */\n\nconst PROJECT_SETTINGS_REL = \".claude/settings.local.json\";\nconst SHARED_SETTINGS_REL = \".claude/settings.json\";\n\nconst TRI_STATES = [\"inherit\", \"on\", \"off\"];\n// MCP 只有 denylist 可写：项目级能禁用，不能解除全局的禁用。\nconst MCP_STATES = [\"inherit\", \"off\"];\n\nconst has = (obj, key) =>\n  obj !== null && typeof obj === \"object\" && Object.prototype.hasOwnProperty.call(obj, key);\n\n/** settings 是 JSON 文档，深拷贝用 JSON 往返即可；不依赖 structuredClone。 */\nfunction cloneSettings(settings) {\n  return settings && typeof settings === \"object\" ? JSON.parse(JSON.stringify(settings)) : {};\n}\n\n/** 空键不落盘：面板把某栏全部改回「跟随全局」时，文件里不该留下空对象。 */\nfunction prune(settings) {\n  const next = cloneSettings(settings);\n  if (next.enabledPlugins && Object.keys(next.enabledPlugins).length === 0) delete next.enabledPlugins;\n  if (Array.isArray(next.deniedMcpServers) && next.deniedMcpServers.length === 0) delete next.deniedMcpServers;\n  if (next.skillOverrides && Object.keys(next.skillOverrides).length === 0) delete next.skillOverrides;\n  return next;\n}\n\nfunction assertState(state, allowed, kind) {\n  if (!allowed.includes(state)) {\n    throw new Error(`${kind} 不支持的状态：${state}（允许 ${allowed.join(\" / \")}）`);\n  }\n}\n\n/* ------------------------------------------------------------ plugin */\n\nfunction getPluginState(project, id) {\n  if (!has(project.enabledPlugins, id)) return \"inherit\";\n  return project.enabledPlugins[id] === false ? \"off\" : \"on\";\n}\n\nfunction setPluginState(project, id, state) {\n  assertState(state, TRI_STATES, \"plugin\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.enabledPlugins, id)) delete next.enabledPlugins[id];\n  } else {\n    next.enabledPlugins = { ...(next.enabledPlugins || {}), [id]: state === \"on\" };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ mcp */\n\nfunction getMcpState(project, serverName) {\n  const list = project.deniedMcpServers;\n  if (!Array.isArray(list)) return \"inherit\";\n  return list.some((entry) => entry && entry.serverName === serverName) ? \"off\" : \"inherit\";\n}\n\n/** 只增删 serverName 条目；serverCommand / serverUrl 条目原样保留。 */\nfunction setMcpState(project, serverName, state) {\n  if (state === \"on\") {\n    throw new Error(\"MCP 项目级无法显式启用：全局已禁用时不受项目控制，请改用 inherit\");\n  }\n  assertState(state, MCP_STATES, \"mcp\");\n  const next = cloneSettings(project);\n  const list = Array.isArray(next.deniedMcpServers) ? next.deniedMcpServers.slice() : [];\n  const filtered = list.filter((entry) => !(entry && entry.serverName === serverName));\n  if (state === \"off\") filtered.push({ serverName });\n  next.deniedMcpServers = filtered;\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ skill */\n\nfunction getSkillState(project, name) {\n  if (!has(project.skillOverrides, name)) return \"inherit\";\n  return project.skillOverrides[name] === \"off\" ? \"off\" : \"on\";\n}\n\nfunction setSkillState(project, name, state) {\n  assertState(state, TRI_STATES, \"skill\");\n  const next = cloneSettings(project);\n  if (state === \"inherit\") {\n    if (has(next.skillOverrides, name)) delete next.skillOverrides[name];\n  } else {\n    next.skillOverrides = { ...(next.skillOverrides || {}), [name]: state };\n  }\n  return prune(next);\n}\n\n/* ------------------------------------------------------------ 展示用 */\n\n/** 项目覆盖了多少项；panel tab 的徽标数字。 */\nfunction overrideCount(project) {\n  const plugins = project.enabledPlugins ? Object.keys(project.enabledPlugins).length : 0;\n  const mcp = Array.isArray(project.deniedMcpServers)\n    ? project.deniedMcpServers.filter((entry) => entry && entry.serverName).length\n    : 0;\n  const skills = project.skillOverrides ? Object.keys(project.skillOverrides).length : 0;\n  return plugins + mcp + skills;\n}\n\n/** 项目态优先；inherit 时回落到全局态。 */\nfunction effectiveState(projectState, globalState) {\n  if (projectState && projectState !== \"inherit\") return projectState;\n  return globalState || \"unknown\";\n}\n\n/* 子进程：读写项目级 Claude Code 配置。\n *\n * 插件本体拿不到文件系统，只能把这份脚本落盘后经 exec:node 执行。\n * 构建时 scripts/build.mjs 会把 src/lib/model.mjs 的源码内联进来，\n * 所以这里唯一允许的兄弟 import 是 model；其余只能用 node 内置模块。\n *\n * 用法：\n *   node config-io.mjs scan <workspace>\n *   node config-io.mjs set  <workspace> <plugin|mcp|skill> <id> <inherit|on|off>\n * 输出：单行 JSON，ok=false 时附带 error。\n */\n\nimport fs from \"node:fs\";\nimport os from \"node:os\";\nimport path from \"node:path\";\n\nconst HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();\nconst CLAUDE_DIR = path.join(HOME, \".claude\");\nconst CLAUDE_JSON = path.join(HOME, \".claude.json\");\n\nfunction readJson(file) {\n  try {\n    let text = fs.readFileSync(file, \"utf8\");\n    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);\n    return JSON.parse(text);\n  } catch {\n    return null;\n  }\n}\n\nfunction writeJsonAtomic(file, data) {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  const tmp = file + \".tmp-\" + process.pid;\n  const body = JSON.stringify(data, null, 2) + \"\\n\";\n  fs.writeFileSync(tmp, body, \"utf8\");\n  fs.renameSync(tmp, file);\n}\n\nconst norm = (p) => String(p || \"\").replace(/\\\\/g, \"/\").replace(/\\/+$/, \"\").toLowerCase();\n\nfunction findProjectEntry(config, ws) {\n  const projects = (config && config.projects) || {};\n  const target = norm(ws);\n  const key = Object.keys(projects).find((k) => norm(k) === target);\n  return key ? projects[key] : null;\n}\n\nfunction listSkillDirs(root, source, plugin) {\n  const out = [];\n  let entries = [];\n  try {\n    entries = fs.readdirSync(root, { withFileTypes: true });\n  } catch {\n    return out;\n  }\n  for (const entry of entries) {\n    if (!entry.isDirectory()) continue;\n    const md = path.join(root, entry.name, \"SKILL.md\");\n    if (!fs.existsSync(md)) continue;\n    out.push({ name: entry.name, source, plugin: plugin || null, path: md, description: readSkillDescription(md) });\n  }\n  return out;\n}\n\nfunction installedPlugins() {\n  const raw = readJson(path.join(CLAUDE_DIR, \"plugins\", \"installed_plugins.json\"));\n  const map = {};\n  const plugins = (raw && raw.plugins) || {};\n  for (const [id, list] of Object.entries(plugins)) {\n    if (!Array.isArray(list) || list.length === 0) continue;\n    const pick = list.find((e) => e && e.scope === \"user\") || list[0];\n    map[id] = {\n      installPath: pick && pick.installPath ? pick.installPath : \"\",\n      scopes: list.map((e) => e && e.scope).filter(Boolean),\n    };\n  }\n  return map;\n}\n\n/** 插件 .mcp.json 有两种写法：{ mcpServers: { name: cfg } } 和扁平的 { name: cfg }。 */\nfunction pluginServers(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return {};\n  const wrapped = cfg.mcpServers || cfg.servers;\n  if (wrapped && typeof wrapped === \"object\") return wrapped;\n  const out = {};\n  for (const [key, value] of Object.entries(cfg)) {\n    if (value && typeof value === \"object\"\n      && (\"command\" in value || \"url\" in value || \"type\" in value)) {\n      out[key] = value;\n    }\n  }\n  return out;\n}\n\n/** 插件描述：优先 .claude-plugin/plugin.json，其次根目录的 plugin.json / manifest.json。 */\nfunction pluginDescription(dir) {\n  if (!dir) return \"\";\n  for (const rel of [\".claude-plugin/plugin.json\", \"plugin.json\", \"manifest.json\"]) {\n    const cfg = readJson(path.join(dir, rel));\n    if (cfg && typeof cfg.description === \"string\" && cfg.description.trim()) {\n      return cfg.description.trim();\n    }\n  }\n  return \"\";\n}\n\n/** SKILL.md frontmatter 里的 description；只读前 50 行。 */\nfunction readSkillDescription(file) {\n  try {\n    const lines = fs.readFileSync(file, \"utf8\").split(/\\r?\\n/).slice(0, 50);\n    if (!lines.length || lines[0].trim() !== \"---\") return \"\";\n    let collecting = false;\n    const block = [];\n    for (let i = 1; i < lines.length; i++) {\n      const line = lines[i];\n      if (line.trim() === \"---\") break;\n      const match = /^description:\\s*(.*)$/.exec(line);\n      if (match) {\n        const value = match[1].trim();\n        if (/^[|>][-+]?$/.test(value)) { collecting = true; continue; }\n        return value.replace(/^[\"']|[\"']$/g, \"\").trim();\n      }\n      if (collecting) {\n        if (/^\\s+\\S/.test(line)) block.push(line.trim());\n        else break;\n      }\n    }\n    return block.join(\" \").trim();\n  } catch {\n    return \"\";\n  }\n}\n\nfunction mcpDescription(cfg) {\n  if (!cfg || typeof cfg !== \"object\") return \"\";\n  if (typeof cfg.url === \"string\") return cfg.url;\n  if (typeof cfg.command === \"string\") {\n    const args = Array.isArray(cfg.args) ? \" \" + cfg.args.join(\" \") : \"\";\n    return (cfg.command + args).trim();\n  }\n  return \"\";\n}\n\nfunction scan(ws) {\n  const globalSettings = readJson(path.join(CLAUDE_DIR, \"settings.json\")) || {};\n  const globalConfig = readJson(CLAUDE_JSON) || {};\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const sharedPath = path.join(ws, SHARED_SETTINGS_REL);\n  const local = readJson(localPath) || {};\n  const shared = readJson(sharedPath) || {};\n\n  // 项目层：local 压过 shared；面板只写 local。\n  const projectLayer = Object.assign({}, shared, local);\n  for (const key of [\"enabledPlugins\", \"skillOverrides\"]) {\n    if (shared[key] || local[key]) {\n      projectLayer[key] = Object.assign({}, shared[key] || {}, local[key] || {});\n    }\n  }\n  if (Array.isArray(shared.deniedMcpServers) || Array.isArray(local.deniedMcpServers)) {\n    projectLayer.deniedMcpServers = [\n      ...(Array.isArray(shared.deniedMcpServers) ? shared.deniedMcpServers : []),\n      ...(Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []),\n    ];\n  }\n\n  /* ---------------- plugins ---------------- */\n\n  const installed = installedPlugins();\n  const pluginIds = new Set(Object.keys(globalSettings.enabledPlugins || {}));\n  for (const id of Object.keys(installed)) pluginIds.add(id);\n\n  const plugins = [];\n  for (const id of [...pluginIds].sort()) {\n    const at = id.lastIndexOf(\"@\");\n    const name = at > 0 ? id.slice(0, at) : id;\n    const marketplace = at > 0 ? id.slice(at + 1) : \"\";\n    const enabled = globalSettings.enabledPlugins && globalSettings.enabledPlugins[id];\n    const globalState = enabled === false ? \"off\" : enabled === true ? \"on\" : \"unknown\";\n    const projectState = getPluginState(projectLayer, id);\n    plugins.push({\n      kind: \"plugin\",\n      id,\n      name,\n      marketplace,\n      installed: Boolean(installed[id]),\n      installPath: installed[id] ? installed[id].installPath : \"\",\n      description: installed[id] ? pluginDescription(installed[id].installPath) : \"\",\n      globalState,\n      projectState,\n      // 面板只能写 local；shared 是被仓库共享的团队配置，单独列出以便界面说明「跟随」会落到哪一层。\n      localState: getPluginState(local, id),\n      sharedState: getPluginState(shared, id),\n      effectiveState: effectiveState(projectState, globalState),\n    });\n  }\n\n  /* ---------------- mcp ---------------- */\n\n  const userMcp = globalConfig.mcpServers || {};\n  const localMcp = (findProjectEntry(globalConfig, ws) || {}).mcpServers || {};\n  const projectMcp = (readJson(path.join(ws, \".mcp.json\")) || {}).mcpServers || {};\n\n  // 插件自带的 MCP：plugin 包里的 .mcp.json，同样能被 deniedMcpServers 拦住。\n  const pluginMcp = {};\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const cfg = readJson(path.join(info.installPath, \".mcp.json\"));\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    for (const [name, value] of Object.entries(pluginServers(cfg))) {\n      if (!(name in pluginMcp)) pluginMcp[name] = { plugin: pluginName, config: value };\n    }\n  }\n\n  const mcpNames = new Set([\n    ...Object.keys(userMcp),\n    ...Object.keys(localMcp),\n    ...Object.keys(projectMcp),\n    ...Object.keys(pluginMcp),\n  ]);\n\n  const globalDenied = Array.isArray(globalSettings.deniedMcpServers)\n    ? globalSettings.deniedMcpServers\n    : [];\n\n  const mcp = [...mcpNames].sort().map((name) => {\n    const scopes = [];\n    if (localMcp[name]) scopes.push(\"local\");\n    if (projectMcp[name]) scopes.push(\"project\");\n    if (userMcp[name]) scopes.push(\"user\");\n    if (pluginMcp[name]) scopes.push(\"plugin\");\n    const deniedGlobally = globalDenied.some((e) => e && e.serverName === name);\n    // local > project > user > plugin 是 Claude Code 的生效顺序\n    const scope = scopes[0] || \"user\";\n    const pluginEntry = pluginMcp[name];\n    const config = localMcp[name] || projectMcp[name] || userMcp[name]\n      || (pluginEntry && pluginEntry.config) || null;\n    const projectState = getMcpState(projectLayer, name);\n    const globalState = deniedGlobally ? \"off\" : \"on\";\n    return {\n      kind: \"mcp\",\n      id: name,\n      name,\n      scope,\n      scopes,\n      plugin: pluginEntry ? pluginEntry.plugin : null,\n      description: mcpDescription(config),\n      globalState,\n      projectState,\n      localState: getMcpState(local, name),\n      sharedState: getMcpState(shared, name),\n      canEnable: !deniedGlobally,\n      effectiveState: deniedGlobally ? \"off\" : effectiveState(projectState, \"on\"),\n    };\n  });\n\n  /* ---------------- skills ---------------- */\n\n  const skills = [];\n  skills.push(...listSkillDirs(path.join(CLAUDE_DIR, \"skills\"), \"personal\"));\n  skills.push(...listSkillDirs(path.join(ws, \".claude\", \"skills\"), \"project\"));\n\n  for (const [id, info] of Object.entries(installed)) {\n    if (!info.installPath) continue;\n    const at = id.lastIndexOf(\"@\");\n    const pluginName = at > 0 ? id.slice(0, at) : id;\n    skills.push(...listSkillDirs(path.join(info.installPath, \"skills\"), \"plugin\", pluginName));\n  }\n\n  const globalOverrides = globalSettings.skillOverrides || {};\n  const seen = new Map();\n  const skillRows = skills.map((s) => {\n    const globalRaw = globalOverrides[s.name];\n    const globalState = globalRaw === \"off\" ? \"off\" : \"on\";\n    const projectState = getSkillState(projectLayer, s.name);\n    const row = {\n      kind: \"skill\",\n      id: s.name,\n      name: s.name,\n      source: s.source,\n      plugin: s.plugin,\n      description: s.description || \"\",\n      globalState,\n      projectState,\n      localState: getSkillState(local, s.name),\n      sharedState: getSkillState(shared, s.name),\n      effectiveState: effectiveState(projectState, globalState),\n      controllable: s.source !== \"plugin\",\n    };\n    const key = s.name;\n    if (!seen.has(key)) seen.set(key, []);\n    seen.get(key).push(s.source);\n    return row;\n  });\n\n  for (const row of skillRows) {\n    const sources = seen.get(row.name) || [];\n    row.shadowed = row.source === \"personal\" && sources.includes(\"project\");\n    if (row.controllable && sources.length > 1) {\n      row.effectiveSource = sources.includes(\"personal\") ? \"personal\" : \"project\";\n    } else if (!row.controllable) {\n      row.effectiveSource = \"plugin\";\n    } else {\n      row.effectiveSource = row.source;\n    }\n  }\n\n  /* ---------------- diagnostics ---------------- */\n\n  // 面板只列「当前存在的资源」，所以 local 里指向已消失资源的键会完全没有入口。\n  // 这里把它们找出来：stale 项可以一键清掉，其余只提示原因。\n  const diagnostics = [];\n  const seenDiag = new Set();\n  // 同名技能可能被多个来源列出（个人版与项目版、或多个插件共用 installPath），\n  // 诊断只该报一次。\n  const diag = (level, kind, id, name, message, fixable) => {\n    const key = level + \":\" + kind + \":\" + id;\n    if (seenDiag.has(key)) return;\n    seenDiag.add(key);\n    diagnostics.push({ level, kind, id, name, message, fixable: Boolean(fixable) });\n  };\n\n  const knownPlugins = new Set(plugins.map((p) => p.id));\n  for (const id of Object.keys(local.enabledPlugins || {})) {\n    if (!knownPlugins.has(id)) diag(\"stale\", \"plugin\", id, id, \"插件已不存在，本地仍保留开关\", true);\n  }\n  for (const p of plugins) {\n    if (!p.installed && p.globalState === \"on\") {\n      diag(\"warn\", \"plugin\", p.id, p.name, \"全局启用但本机未安装\", false);\n    }\n  }\n\n  const knownSkills = new Set(skillRows.map((r) => r.name));\n  for (const name of Object.keys(local.skillOverrides || {})) {\n    if (!knownSkills.has(name)) diag(\"stale\", \"skill\", name, name, \"技能已不存在，本地仍保留开关\", true);\n  }\n  for (const r of skillRows) {\n    const localTouched = Object.prototype.hasOwnProperty.call(local.skillOverrides || {}, r.name);\n    if (r.shadowed) diag(\"info\", \"skill\", r.id, r.name, \"项目版本被同名个人技能遮蔽\", false);\n    if (r.controllable === false && localTouched) {\n      diag(\"warn\", \"skill\", r.id, r.name, \"插件提供的技能不受本地开关控制\", false);\n    }\n  }\n\n  const knownMcp = new Set(mcpNames);\n  for (const entry of Array.isArray(local.deniedMcpServers) ? local.deniedMcpServers : []) {\n    if (entry && entry.serverName && !knownMcp.has(entry.serverName)) {\n      diag(\"stale\", \"mcp\", entry.serverName, entry.serverName, \"MCP 已不存在，本地仍保留禁用\", true);\n    }\n  }\n  for (const row of mcp) {\n    if (row.sharedState === \"off\") {\n      diag(\"warn\", \"mcp\", row.id, row.name, \"团队配置已禁用，本地无法解除\", false);\n    }\n  }\n\n  return {\n    ok: true,\n    workspace: ws,\n    files: { local: localPath, shared: sharedPath },\n    pluginCount: plugins.length,\n    plugins,\n    mcp,\n    skills: skillRows,\n    diagnostics,\n  };\n}\n\nfunction set(ws, kind, id, state) {\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  const current = readJson(localPath) || {};\n  let next;\n  if (kind === \"plugin\") next = setPluginState(current, id, state);\n  else if (kind === \"mcp\") next = setMcpState(current, id, state);\n  else if (kind === \"skill\") next = setSkillState(current, id, state);\n  else throw new Error(\"未知类型：\" + kind);\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, settings: next };\n}\n\n/** 一次写完多条：同类型共用一个文件，避免每行起一次子进程。 */\nfunction setMany(ws, opsJson) {\n  let ops;\n  try {\n    ops = JSON.parse(opsJson);\n  } catch {\n    throw new Error(\"批量操作的参数不是合法 JSON\");\n  }\n  if (!Array.isArray(ops) || ops.length === 0) throw new Error(\"批量操作为空\");\n  if (ops.length > 500) throw new Error(\"单次批量操作不能超过 500 项\");\n\n  const localPath = path.join(ws, PROJECT_SETTINGS_REL);\n  let next = readJson(localPath) || {};\n  let applied = 0;\n  for (const op of ops) {\n    if (!op || typeof op !== \"object\") continue;\n    const { kind, id, state } = op;\n    if (kind === \"plugin\") next = setPluginState(next, id, state);\n    else if (kind === \"mcp\") next = setMcpState(next, id, state);\n    else if (kind === \"skill\") next = setSkillState(next, id, state);\n    else throw new Error(\"未知类型：\" + kind);\n    applied += 1;\n  }\n  writeJsonAtomic(localPath, next);\n  return { ok: true, file: localPath, applied, settings: next };\n}\n\nfunction main() {\n  const argv = process.argv.slice(2);\n  const action = argv[0];\n  const ws = argv[1];\n  if (action === \"setMany\") {\n    if (!ws) throw new Error(\"用法：config-io.mjs setMany <workspace> <json>\");\n    if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n    process.stdout.write(JSON.stringify(setMany(ws, argv[2] || \"[]\")));\n    return;\n  }\n  const [, , kind, id, state] = argv;\n  if (!action || !ws) throw new Error(\"用法：config-io.mjs scan <workspace> | set <workspace> <kind> <id> <state>\");\n  if (!fs.existsSync(ws)) throw new Error(\"工作区不存在：\" + ws);\n  const result = action === \"scan\" ? scan(ws) : action === \"set\" ? set(ws, kind, id, state) : null;\n  if (!result) throw new Error(\"未知动作：\" + action);\n  process.stdout.write(JSON.stringify(result));\n}\n\ntry {\n  main();\n} catch (err) {\n  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));\n  process.exitCode = 1;\n}\n";

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
  const { createElement: h, useEffect, useState } = ctx.react;

  const store = { ws: "", data: null, loading: false, error: "", note: "", busy: "", activeKind: "plugin", query: "", onlyOverridden: false, settings: {}, showDesc: false };
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
      return ["MCP", src, g, team].filter(Boolean).join(" · ");
    }
    const src = row.source === "plugin"
      ? "插件 " + (row.plugin || "")
      : row.source === "personal" ? "个人" : "项目";
    const g = row.globalState === "off" ? "全局禁用" : "全局可用";
    return ["技能", src, g, team, row.shadowed ? "同名个人版优先" : ""].filter(Boolean).join(" · ");
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
      : [
          [followLabel, "inherit"],
          [compact ? "开" : "启用", "on"],
          [compact ? "关" : "禁用", "off"],
        ];
    return h("div", { className: "wc-seg" },
      opts.map(([label, value]) =>
        h("button", {
          key: value,
          type: "button",
          className: "wc-btn" + (active === value ? " wc-on" : ""),
          disabled: row.busy || (value === "on" && !row.allowOn) || (value === "inherit" && followDead),
          title: value === "on" && !row.allowOn
            ? "当前无法启用"
            : value === "inherit" ? followTitle : undefined,
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
    if (row.effectiveState === "off") return "生效：关";
    return "生效：未知";
  }

  /* ------------------------------------------------------------ 生效链路 */

  const LAYER_WORD = {
    team: { inherit: "未设置", on: "启用", off: "禁用" },
    local: { inherit: "跟随", on: "启用", off: "禁用" },
    effective: { on: "开", off: "关", unknown: "未知" },
  };

  function flowSteps(row) {
    const globalWord = row.kind === "mcp"
      ? (row.globalState === "off" ? "禁用" : "可用")
      : (row.globalState === "on" ? "启用" : row.globalState === "off" ? "禁用" : "未记录");
    return [
      { label: "全局", value: globalWord },
      { label: "团队配置", value: LAYER_WORD.team[row.sharedState || "inherit"] },
      { label: "本地", value: LAYER_WORD.local[row.localState || "inherit"] },
      { label: "最终", value: LAYER_WORD.effective[row.effectiveState] || "未知", strong: true },
    ];
  }

  function flowNote(row) {
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
              className: "wc-dot " + (row.effectiveState === "on" ? "on" : "off"),
              title: effectiveLabel(row),
              "aria-label": effectiveLabel(row),
            }),
            row.name,
            expandable ? h("span", { className: "wc-caret" }, open ? "▾" : "▸") : null
          ),
          h("div", { className: "wc-meta" }, metaOf(row, compact)),
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
      h(Diagnostics, { data }),
      h("div", { className: "wc-center-layout" },
        h("nav", { className: "wc-nav" },
          groups.map((g) => {
            const covered = g.rows.filter(locallyOverridden).length;
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
            title: "只显示在 settings.local.json 里被本机改过的项",
            onClick: () => set({ onlyOverridden: !s.onlyOverridden }),
          }, "只看本地覆盖")
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
        (!only || locallyOverridden(row))
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
