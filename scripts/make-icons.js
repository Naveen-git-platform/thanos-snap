// Draws the extension icons (a gold disc crumbling into dust on purple) and
// writes them as PNGs. No dependencies: node scripts/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hash = (x, y) => {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

const PARTICLES = [
  [0.68, 0.42, 0.07, 1],
  [0.78, 0.31, 0.06, 0.9],
  [0.87, 0.2, 0.05, 0.75],
  [0.72, 0.21, 0.04, 0.7],
  [0.86, 0.37, 0.04, 0.65],
  [0.63, 0.27, 0.035, 0.6],
];

// Colour (premultiplied-free RGBA, 0-1) of the icon at point (x, y) in [0,1].
function sample(x, y) {
  // Rounded-square background.
  const r = 0.22;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (qx * qx + qy * qy > r * r) return [0, 0, 0, 0];
  let c = mix([0.49, 0.23, 0.93], [0.16, 0.05, 0.37], (x + y) / 2);

  const gold = (k) => mix([1, 0.85, 0.42], [0.86, 0.5, 0.1], k);
  // Disc, crumbling away on its right side.
  const cx = 0.42;
  const cy = 0.58;
  const R = 0.25;
  const dx = (x - cx) / R;
  const dy = (y - cy) / R;
  if (dx * dx + dy * dy < 1) {
    const erosion = Math.min(1, Math.max(0, (dx + 0.15) / 1.0));
    const cell = hash(Math.floor(x / 0.07), Math.floor(y / 0.07));
    if (cell > erosion * 0.95) c = gold((dy + 1) / 2);
  }
  for (const [px, py, s, a] of PARTICLES) {
    if (Math.abs(x - px) < s / 2 && Math.abs(y - py) < s / 2) c = mix(c, gold(0.3), a);
  }
  return [...c, 1];
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          acc[0] += c[0] * c[3];
          acc[1] += c[1] * c[3];
          acc[2] += c[2] * c[3];
          acc[3] += c[3];
        }
      const o = (y * size + x) * 4;
      const a = acc[3] / (SS * SS);
      buf[o] = a ? Math.round((acc[0] / acc[3]) * 255) : 0;
      buf[o + 1] = a ? Math.round((acc[1] / acc[3]) * 255) : 0;
      buf[o + 2] = a ? Math.round((acc[2] / acc[3]) * 255) : 0;
      buf[o + 3] = Math.round(a * 255);
    }
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png(size, buf));
  console.log(`icons/icon${size}.png`);
}
