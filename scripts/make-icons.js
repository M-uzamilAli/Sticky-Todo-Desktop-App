'use strict';

/*
 * Renders the Sticky Todo brand icon (see build/icon.svg) to PNGs with no
 * external dependencies:
 *   build/icon.png  256x256  (app + installer; electron-builder makes the .ico)
 *   build/tray.png   32x32   (system tray)
 *
 * Drawn procedurally at 4x then box-downsampled for smooth, anti-aliased edges.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SS = 4; // supersampling factor

/* ---------- minimal PNG writer (8-bit RGBA) ---------- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writePng(file, w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  fs.writeFileSync(file, Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]));
}

/* ---------- geometry helpers (unit space 0..1) ---------- */
const M = 0.10, R = 0.145, F = 0.235;              // margin, corner radius, fold size
const L = M, T = M, RT = 1 - M, BT = 1 - M;        // left/top/right/bottom
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Distance from point to segment AB.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

function inBody(x, y) {
  if (x < L || x > RT || y < T || y > BT) return false;
  // folded (cut) bottom-right corner
  if (x > RT - F && y > BT - F) return (x + y) <= (RT + BT - F);
  // rounded TL / TR / BL
  if (x < L + R && y < T + R) return dist(x, y, L + R, T + R) <= R;
  if (x > RT - R && y < T + R) return dist(x, y, RT - R, T + R) <= R;
  if (x < L + R && y > BT - R) return dist(x, y, L + R, BT - R) <= R;
  return true;
}
// the darker fold flap: BR region that's still inside the body
function inFlap(x, y) {
  return x > RT - F && y > BT - F && (x + y) <= (RT + BT - F);
}

// Glance check mark as a stroked polyline.
const CHK = [[0.33, 0.515], [0.45, 0.635], [0.70, 0.40]];
const CHK_W = 0.052; // half-width
function inCheck(x, y) {
  for (let i = 0; i < CHK.length - 1; i++) {
    if (segDist(x, y, CHK[i][0], CHK[i][1], CHK[i + 1][0], CHK[i + 1][1]) <= CHK_W) return true;
  }
  return false;
}

const YELLOW_TOP = [255, 226, 122];
const YELLOW_BOT = [243, 201, 72];
const FOLD = [227, 180, 58];
const INK = [58, 51, 32];

// Returns [r,g,b,a] for a point in unit space.
function colorAt(x, y) {
  if (!inBody(x, y)) return [0, 0, 0, 0];
  if (inCheck(x, y)) return [INK[0], INK[1], INK[2], 255];
  if (inFlap(x, y)) return [FOLD[0], FOLD[1], FOLD[2], 255];
  const t = (y - T) / (BT - T);
  return [
    Math.round(lerp(YELLOW_TOP[0], YELLOW_BOT[0], t)),
    Math.round(lerp(YELLOW_TOP[1], YELLOW_BOT[1], t)),
    Math.round(lerp(YELLOW_TOP[2], YELLOW_BOT[2], t)),
    255
  ];
}

/* ---------- render + downsample ---------- */
function render(size) {
  const hi = size * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x * SS + sx + 0.5) / hi;
          const uy = (y * SS + sy + 0.5) / hi;
          const c = colorAt(ux, uy);
          // premultiply for correct edge blending
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; }
      else {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
  writePng(path.join(BUILD_DIR, 'icon.png'), 256, 256, render(256));
  writePng(path.join(BUILD_DIR, 'tray.png'), 32, 32, render(32));
  console.log('Icons written: build/icon.png (256), build/tray.png (32)');
}

main();
