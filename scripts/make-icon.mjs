#!/usr/bin/env node
// 生成 docs/icon.png：256×256、超采样抗锯齿、零依赖。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "icon.png");

const W = 256;
const H = 256;
const S = 3; // 超采样
const CW = W * S;
const CH = H * S;

const BG = [0, 0, 0, 0];
const INK = [52, 62, 82, 255];
const ACCENT = [79, 140, 255, 255];

const canvas = new Float32Array(CW * CH * 4);

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function blend(x, y, color) {
  if (x < 0 || y < 0 || x >= CW || y >= CH) return;
  const i = (y * CW + x) * 4;
  const a = color[3] / 255;
  canvas[i] = canvas[i] * (1 - a) + color[0] * a;
  canvas[i + 1] = canvas[i + 1] * (1 - a) + color[1] * a;
  canvas[i + 2] = canvas[i + 2] * (1 - a) + color[2] * a;
  canvas[i + 3] = Math.max(canvas[i + 3], color[3]);
}

// 坐标按 256 设计，绘制时乘 S
function roundRect(x0, y0, x1, y1, r, color) {
  const sx0 = x0 * S;
  const sy0 = y0 * S;
  const sx1 = x1 * S;
  const sy1 = y1 * S;
  const sr = r * S;
  for (let y = Math.floor(sy0); y <= Math.ceil(sy1); y++) {
    for (let x = Math.floor(sx0); x <= Math.ceil(sx1); x++) {
      if (insideRoundRect(x, y, sx0, sy0, sx1, sy1, sr)) blend(x, y, color);
    }
  }
}

function rect(x0, y0, x1, y1, color) {
  roundRect(x0, y0, x1, y1, 0, color);
}

function segment(x0, y0, x1, y1, width, color) {
  const ax = x0 * S;
  const ay = y0 * S;
  const bx = x1 * S;
  const by = y1 * S;
  const half = (width * S) / 2;
  const minX = Math.floor(Math.min(ax, bx) - half - 1);
  const maxX = Math.ceil(Math.max(ax, bx) + half + 1);
  const minY = Math.floor(Math.min(ay, by) - half - 1);
  const maxY = Math.ceil(Math.max(ay, by) + half + 1);
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
      const dx = x - (ax + t * vx);
      const dy = y - (ay + t * vy);
      if (dx * dx + dy * dy <= half * half) blend(x, y, color);
    }
  }
}

// 三条滑杆：线用深灰，滑块用蓝色点缀；背景透明，跟随宿主/市场底色
segment(56, 84, 200, 84, 13, INK);
segment(56, 128, 200, 128, 13, INK);
segment(56, 172, 200, 172, 13, INK);
roundRect(104, 62, 148, 106, 22, ACCENT);
roundRect(150, 106, 194, 150, 22, ACCENT);
roundRect(76, 150, 120, 194, 22, ACCENT);

// 降采样
const out = Buffer.alloc(W * H * 4);
const n = S * S;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < S; dy++) {
      for (let dx = 0; dx < S; dx++) {
        const i = ((y * S + dy) * CW + (x * S + dx)) * 4;
        r += canvas[i];
        g += canvas[i + 1];
        b += canvas[i + 2];
        a += canvas[i + 3];
      }
    }
    const o = (y * W + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

/* ---------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  const rowStart = y * (W * 4 + 1);
  raw[rowStart] = 0;
  out.copy(raw, rowStart + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
process.stdout.write("icon.png " + png.length + " bytes\n");
