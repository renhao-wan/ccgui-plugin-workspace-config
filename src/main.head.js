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

/*__LIB_SOURCE__*/

/*__SCAN_SOURCE__*/

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
