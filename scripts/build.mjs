#!/usr/bin/env node
/* 把 src/main.head.js、src/lib/model.mjs、scripts/config-io.mjs 拼成单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件：
 *   - model 纯逻辑内联进 main.js（UI 用），也内联进落盘子进程脚本（读写用）
 *   - config-io.mjs 作为字符串常量 SCAN_SOURCE 内联，运行时落盘后 exec:node 执行
 * 两条内联都用函数形式替换，避免 $& 之类的替换模式破坏内容。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MODEL = path.join(ROOT, "src", "lib", "model.mjs");
const IO = path.join(ROOT, "scripts", "config-io.mjs");
const HEAD = path.join(ROOT, "src", "main.head.js");
const OUT = path.join(ROOT, "main.js");

const LIB_MARK = "/*__LIB_SOURCE__*/";
const SCAN_MARK = "/*__SCAN_SOURCE__*/";

const stripExports = (src) =>
  src.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");

const model = stripExports(fs.readFileSync(MODEL, "utf8"));

let io = fs.readFileSync(IO, "utf8");
io = io.replace(/^#!.*\r?\n/, "");
io = io.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\.\/src\/lib\/model\.mjs["'];?[ \t]*\r?\n/m, "");
if (/from\s*["']\.\.\/src\/lib\/model\.mjs["']/.test(io)) {
  throw new Error("config-io.mjs 里 model 的 import 没剥干净");
}

const scanSource = model + "\n" + io;
if (!/function main\s*\(/.test(scanSource)) throw new Error("config-io 主体缺失");

let head = fs.readFileSync(HEAD, "utf8");
if (!head.includes(LIB_MARK)) throw new Error("main.head.js 缺少 " + LIB_MARK);
if (!head.includes(SCAN_MARK)) throw new Error("main.head.js 缺少 " + SCAN_MARK);

head = head.replace(LIB_MARK, () => model);
head = head.replace(SCAN_MARK, () => "const SCAN_SOURCE = " + JSON.stringify(scanSource) + ";");

// 产物必须是自包含 ESM：行首 import 一条都不允许。
const bad = head.split(/\r?\n/).find((line) => /^\s*import\s/.test(line));
if (bad) throw new Error("main.js 里出现了 import：" + bad.trim());

fs.writeFileSync(OUT, head, "utf8");
const size = fs.statSync(OUT).size;
console.log("main.js " + size + " bytes");
if (size > 16 * 1024 * 1024) throw new Error("main.js 超过 16MB 上限");
