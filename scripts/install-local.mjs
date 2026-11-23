#!/usr/bin/env node
/**
 * 把当前构建装进本机 CC GUI 的插件目录。
 *
 *   node scripts/install-local.mjs           只复制文件并打印需要手动合并的条目
 *   node scripts/install-local.mjs --register 同时写入 plugins.json（会先备份）
 *
 * CC GUI 运行时会持有 plugins.json.lock。安全起见，请先退出应用再运行本脚本。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const CCGUI_HOME = process.env.CCGUI_HOME || path.join(os.homedir(), ".ccgui-next");
const PLUGINS_DIR = path.join(CCGUI_HOME, "plugins");
const TARGET = path.join(PLUGINS_DIR, MANIFEST.id);
const REGISTRY = path.join(CCGUI_HOME, "plugins.json");

const register = process.argv.includes("--register");

function copy(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(TARGET, rel);
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

const copied = ["manifest.json", "main.js", "docs/icon.png"].filter(copy);
fs.writeFileSync(path.join(TARGET, "README.md"), fs.readFileSync(path.join(ROOT, "README.md")));
fs.writeFileSync(path.join(TARGET, "LICENSE"), fs.readFileSync(path.join(ROOT, "LICENSE")));

console.log("已复制到 " + TARGET);
console.log(copied.join(", ") + ", README.md, LICENSE");

const entry = {
  version: MANIFEST.version,
  enabled: true,
  source: "local",
  permissions: MANIFEST.permissions,
  quarantined: false,
  lastError: null,
  installedAt: Math.floor(Date.now() / 1000),
};

if (!register) {
  console.log("\n未写入 plugins.json。手动合并以下条目到 " + REGISTRY + " 的 plugins 下：\n");
  console.log(JSON.stringify({ [MANIFEST.id]: entry }, null, 2));
  console.log("\n或在退出 CC GUI 后运行：node scripts/install-local.mjs --register");
  process.exit(0);
}

if (fs.existsSync(REGISTRY + ".lock")) {
  console.error("\n检测到 " + REGISTRY + ".lock：CC GUI 可能仍在运行，请先退出再试。");
  process.exit(1);
}

let registry = { plugins: {}, kvTombstones: {}, documentStorage: {}, assetDirectories: {} };
if (fs.existsSync(REGISTRY)) {
  registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  fs.copyFileSync(REGISTRY, REGISTRY + ".worklog-backup-" + Date.now());
}
registry.plugins = registry.plugins || {};
registry.plugins[MANIFEST.id] = entry;
fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
console.log("\n已登记到 " + REGISTRY + "。重启 CC GUI 后生效。");
