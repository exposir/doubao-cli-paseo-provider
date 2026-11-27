// Regenerates icon.png (256x256 RGBA, rounded blue tile + chat bubble).
// Usage: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 256;
const SS = 4;
const W = SIZE * SS;

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const BLUE = [31, 111, 235, 255];
const WHITE = [255, 255, 255, 255];

const big = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const px = x / SS;
    const py = y / SS;
    let color = [0, 0, 0, 0];

    if (insideRoundRect(px, py, 16, 16, 240, 240, 56)) {
      color = BLUE;
      // chat bubble
      if (insideRoundRect(px, py, 64, 72, 192, 164, 24)) color = WHITE;
      // tail
      if (px >= 88 && px <= 120 && py >= 164 && py <= 198) {
        const t = (py - 164) / 34;
        if (px <= 88 + (120 - 88) * (1 - t)) color = WHITE;
      }
      // dots
      if (insideCircle(px, py, 104, 118, 9)) color = BLUE;
      if (insideCircle(px, py, 128, 118, 9)) color = BLUE;
      if (insideCircle(px, py, 152, 118, 9)) color = BLUE;
    }

    const at = (y * W + x) * 4;
    big[at] = color[0];
    big[at + 1] = color[1];
    big[at + 2] = color[2];
    big[at + 3] = color[3];
  }
}

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const at = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += big[at];
        g += big[at + 1];
        b += big[at + 2];
        a += big[at + 3];
      }
    }
    const n = SS * SS;
    const at = (y * SIZE + x) * 4;
    out[at] = Math.round(r / n);
    out[at + 1] = Math.round(g / n);
    out[at + 2] = Math.round(b / n);
    out[at + 3] = Math.round(a / n);
  }
}

// PNG scanlines with filter byte 0.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync("/root/doubao-cli-paseo-provider/icon.png", png);
console.log("wrote icon.png", png.length, "bytes");
