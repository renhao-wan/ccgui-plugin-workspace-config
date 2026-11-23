#!/usr/bin/env node
// 工作区配置的插件自检。通用规则（manifest 形状、权限白名单、产物、
// 权限↔用法一致性）在 ccgui-plugin-shared/validate-core，这里只补本插件特有的。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "ccgui-plugin-shared/validate-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  "src/main.head.js",
  "src/lib/model.mjs",
  "scripts/config-io.mjs",
  "scripts/build.mjs",
  "main.js",
];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(ROOT, rel))) fail("缺少 " + rel);
    }

    const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
    if (!main.includes("const SCAN_SOURCE = ")) fail("main.js 缺少内联的 config-io 脚本");
    if (/^\s*import\s/m.test(main)) fail("main.js 不能包含 import");
    if (!main.includes("registerPanelTab") || !main.includes("registerCenterTab")) {
      fail("main.js 应同时注册右侧面板与中央页签");
    }
  },
});

process.exit(result.code);
