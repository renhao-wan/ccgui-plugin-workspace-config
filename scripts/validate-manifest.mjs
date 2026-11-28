#!/usr/bin/env node
// 工作区配置的插件自检。
// 通用规则在 ccgui-plugin-shared/validate-core 里，六插件共用一份。
// 库清单读 plugin.libs.mjs，与 build.mjs 是同一份。
import { runValidateCli } from "ccgui-plugin-shared/validate-core";

runValidateCli(import.meta.url, {
  libSpec: "plugin.libs.mjs",
  required: [
    "src/main.head.js",
    "src/lib/model.mjs",
    "scripts/config-io.mjs",
    "scripts/build.mjs",
    "main.js",
  ],
  extra({ read, fail }) {
    const main = read("main.js");
    if (!main.includes("const SCAN_SOURCE = ")) fail("main.js 缺少内联的 config-io 脚本");
    // 产物必须是自包含 ESM。validate-core 的黑名单只拦 bare import（真正的
    // 外部依赖），相对路径的 import 会漏过——那同样是宿主加载即失败。
    if (/^\s*import\s/m.test(main)) fail("main.js 不能包含 import");
    if (!main.includes("registerPanelTab") || !main.includes("registerCenterTab")) {
      fail("main.js 应同时注册右侧面板与中央页签");
    }
  },
}).then((r) => process.exit(r.code));
