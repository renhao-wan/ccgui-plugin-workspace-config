#!/usr/bin/env node
/* 把 src/main.head.js、plugin.libs.mjs 声明的库、scripts/config-io.mjs
 * 拼成单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件：
 *   - 库内联进 main.js（UI 用），model 还内联进落盘子进程脚本
 *   - config-io.mjs 作为字符串常量 SCAN_SOURCE 内联，运行时落盘后 exec:node 执行
 *
 * 库清单与 validate-manifest.mjs 共用 plugin.libs.mjs，不会漂开。
 * 骨架在 ccgui-plugin-shared/build-lib 里，六插件共用一份。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "ccgui-plugin-shared/build-lib";
import spec from "../plugin.libs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!spec.includes("model")) {
  throw new Error("config-io 落盘脚本要拼 model 的源码，plugin.libs.mjs 里必须有 model");
}

const { bytes } = buildPlugin({
  root: ROOT,
  libs: spec,
  scripts: [
    {
      marker: "/*__SCAN_SOURCE__*/",
      file: "scripts/config-io.mjs",
      constName: "SCAN_SOURCE",
      // 子进程脚本是「落盘后 exec:node 执行」的独立文件，拿不到主文件的库定义，
      // 所以要把 model 的源码拼在它前面。
      prepend: ["model"],
      // 这段源码是被拼进一个完整脚本里执行的，不是原样落盘，shebang 留着会变成
      // 第二行里的乱码注释。
      stripShebang: true,
    },
  ],
  banned: [[/\blocalStorage\b/, "localStorage"]],
  extra(written) {
    if (!/function main\s*\(/.test(written)) throw new Error("config-io 主体缺失");
  },
});
process.stdout.write("main.js " + bytes + " bytes\n");
