#!/usr/bin/env node
/* 把 src/main.head.js、src/lib/model.mjs、反馈共用库、scripts/config-io.mjs
 * 拼成单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件：
 *   - model 与反馈库内联进 main.js（UI 用），model 还内联进落盘子进程脚本
 *   - config-io.mjs 作为字符串常量 SCAN_SOURCE 内联，运行时落盘后 exec:node 执行
 * 两条内联都用函数形式替换，避免 $& 之类的替换模式破坏内容。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MODEL = path.join(ROOT, "src", "lib", "model.mjs");
const IO = path.join(ROOT, "scripts", "config-io.mjs");
const HEAD = path.join(ROOT, "src", "main.head.js");
const OUT = path.join(ROOT, "main.js");
const require = createRequire(import.meta.url);

const LIB_MARK = "/*__LIB_SOURCE__*/";
const SCAN_MARK = "/*__SCAN_SOURCE__*/";

// 顺序即内联顺序：feedback-ui 依赖 feedback，feedback-net 依赖 feedback；
// markdown-view 依赖 markdown。记忆视图用它渲染只读的 Markdown 正文。
const SHARED_LIBS = ["feedback", "feedback-net", "feedback-ui", "markdown", "markdown-view"];

const stripExports = (src) =>
  src.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");

/** 读共用库。用 require.resolve 走包的 exports 映射，不把目录结构写死在这里。 */
function readShared(name) {
  try {
    return fs.readFileSync(require.resolve("ccgui-plugin-shared/" + name), "utf8");
  } catch (err) {
    throw new Error(
      "读不到共用库 ccgui-plugin-shared/" + name + "（" + err.message + "）。" +
        "先跑 npm install——这个包是 npm 依赖，不在仓库里。",
    );
  }
}

/**
 * 剥掉指向兄弟库的多行 import（feedback-ui 的 import 是换行展开的）。
 * 外部依赖的 import 一律保留，交给后面的「不许有 import」自检拦。
 */
function stripLocalImports(source, name) {
  return source.replace(
    /^import\s[\s\S]*?from\s*["']\.\/([A-Za-z0-9_-]+)\.mjs["'];?[ \t]*\r?\n/gm,
    (_all, dep) => {
      if (!SHARED_LIBS.includes(dep)) {
        throw new Error(name + ".mjs 引用了不在 SHARED_LIBS 里的库：./" + dep + ".mjs");
      }
      return "";
    },
  );
}

const model = stripExports(fs.readFileSync(MODEL, "utf8"));

const sharedChunks = SHARED_LIBS.map((name) => {
  const src = stripLocalImports(readShared(name), name);
  if (/^\s*import\s/m.test(src)) throw new Error(name + ".mjs 含无法内联的 import");
  if (/\beval\s*\(|\bnew\s+Function\s*\(|\blocalStorage\b/.test(src)) {
    throw new Error(name + ".mjs 含禁用写法");
  }
  return "// ---- ccgui-plugin-shared/" + name + ".mjs ----\n" + stripExports(src).trim() + "\n";
});

const libSource = model + "\n" + sharedChunks.join("\n");

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

head = head.replace(LIB_MARK, () => libSource);
head = head.replace(SCAN_MARK, () => "const SCAN_SOURCE = " + JSON.stringify(scanSource) + ";");

// 产物必须是自包含 ESM：行首 import 一条都不允许。
const bad = head.split(/\r?\n/).find((line) => /^\s*import\s/.test(line));
if (bad) throw new Error("main.js 里出现了 import：" + bad.trim());

// 顶层重名不是「后者覆盖前者」而是整个模块语法错误，构建期必须拦住。
const topLevel = /^(?:export\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
const seen = new Map();
let m;
while ((m = topLevel.exec(head))) {
  const name = m[1];
  const line = head.slice(0, m.index).split("\n").length;
  if (seen.has(name)) throw new Error("顶层标识符重名：" + name + "（第 " + seen.get(name) + " 行与第 " + line + " 行）");
  seen.set(name, line);
}

fs.writeFileSync(OUT, head, "utf8");
const size = fs.statSync(OUT).size;
console.log("main.js " + size + " bytes");
if (size > 16 * 1024 * 1024) throw new Error("main.js 超过 16MB 上限");
