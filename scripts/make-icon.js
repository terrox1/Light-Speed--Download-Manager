// Generates build/icon.ico — 256x256 green download-arrow on dark rounded square.
// Writes a valid PNG and wraps it in a PNG-embedded ICO (Vista+).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const bg = [30, 41, 59]; // dark slate blue
const fg = [34, 197, 94]; // green

function putPx(rgba, x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function mix(dst, x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  const da = dst[i + 3] / 255,
    na = a / 255;
  const outA = na + da * (1 - na);
  if (outA <= 0) return;
  dst[i] = Math.round((r * na + dst[i] * da * (1 - na)) / outA);
  dst[i + 1] = Math.round((g * na + dst[i + 1] * da * (1 - na)) / outA);
  dst[i + 2] = Math.round((b * na + dst[i + 2] * da * (1 - na)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

const rgba = new Uint8Array(SIZE * SIZE * 4);
for (let i = 0; i < rgba.length; i += 4) {
  rgba[i] = bg[0];
  rgba[i + 1] = bg[1];
  rgba[i + 2] = bg[2];
  rgba[i + 3] = 255;
}

// rounded-square mask (superellipse)
const cx = SIZE / 2,
  R = SIZE * 0.46,
  k = 4.0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const nx = (x - cx) / R,
      ny = (y - cx) / R;
    const d = Math.pow(Math.abs(nx), k) + Math.pow(Math.abs(ny), k);
    if (d > 1.02) putPx(rgba, x, y, 0, 0, 0, 0);
  }
}

// downward arrow: vertical shaft + triangular head
function inArrow(px, py) {
  const cxx = cx,
    cy = cx;
  const shaftX = 0.2 * SIZE;
  const shaftTop = cy - 0.16 * SIZE,
    shaftBot = cy + 0.06 * SIZE;
  const headTop = cy + 0.02 * SIZE,
    headBot = cy + 0.3 * SIZE,
    headHalf = 0.26 * SIZE;
  if (
    px >= cxx - shaftX &&
    px <= cxx + shaftX &&
    py >= shaftTop &&
    py <= shaftBot
  )
    return true;
  const t = (py - headTop) / (headBot - headTop);
  if (t >= 0 && t <= 1) {
    const halfW = headHalf * t;
    if (px >= cxx - halfW && px <= cxx + halfW) return true;
  }
  return false;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (x < 0.18 * SIZE || x > 0.82 * SIZE) continue;
    let cov = 0;
    for (let sy = 0; sy < 3; sy++)
      for (let sx = 0; sx < 3; sx++)
        if (inArrow(x + (sx - 1) * 0.4, y + (sy - 1) * 0.4)) cov++;
    mix(rgba, x, y, fg[0], fg[1], fg[2], Math.round((cov / 9) * 255));
  }
}

// ---- PNG encoding ---------------------------------------------------
function crc32(buf) {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let kk = 0; kk < 8; kk++) c = c & 1 ? 0xedb88320 ^ (c >> 1) : c >> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const step = SIZE * 4 + 1;
const raw = Buffer.alloc(SIZE * step);
for (let y = 0; y < SIZE; y++) {
  raw[y * step] = 0;
  raw.set(
    Buffer.from(rgba.slice(y * SIZE * 4, (y + 1) * SIZE * 4)),
    y * step + 1,
  );
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const idat = zlib.deflateSync(raw, 9);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

// ICO container with the single 256px PNG entry
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico[8] = 0;
ico[9] = 0;
ico[10] = 0;
ico[11] = 0;
ico[12] = 0;
ico[13] = 0;
ico.writeUInt16LE(1, 14);
ico.writeUInt16LE(32, 16);
ico.writeUInt32LE(png.length, 18);
ico.writeUInt32LE(22, 22);
Buffer.from(png).copy(ico, 22);

const out = path.join(__dirname, "..", "build", "icon.ico");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log("Wrote", out, fs.statSync(out).size, "bytes");
