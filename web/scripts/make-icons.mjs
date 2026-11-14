// Generate the PWA icons (icon-192.png, icon-512.png) into site/.
// Icons are build artifacts — the repository stays text-only, like the
// CI fixtures. A minimal PNG writer (zlib is built into Node) draws a
// QR-like mark: dark field, three finder squares, seeded modules, and
// a red voice dot in the center.
import { deflateSync } from 'node:zlib';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  const DARK = [26, 26, 26], WHITE = [255, 255, 255], RED = [198, 40, 40];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, DARK);
  const m = Math.floor(size / 12);
  const block = (gx, gy, color) => {
    for (let y = gy * m; y < (gy + 1) * m - 1; y++)
      for (let x = gx * m; x < (gx + 1) * m - 1; x++) set(x, y, color);
  };
  const finder = (ox, oy) => {
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) block(ox + gx, oy + gy, WHITE);
    for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 2; gx++) block(ox + gx + 0.5, oy + gy + 0.5, DARK);
    block(ox + 1, oy + 1, WHITE);
  };
  finder(1, 1); finder(8, 1); finder(1, 8);
  // Seeded pseudo-random modules (mulberry32) outside the finders.
  let seed = 42;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  for (let gy = 2; gy < 10; gy++) {
    for (let gx = 2; gx < 10; gx++) {
      if ((gx < 5 && gy < 5) || (gx > 6 && gy < 5) || (gx < 5 && gy > 6)) continue;
      if (rand() < 0.42) block(gx, gy, WHITE);
    }
  }
  // Red voice dot at the center.
  const c = size / 2, r = m / 2;
  for (let y = Math.floor(c - r); y < c + r; y++)
    for (let x = Math.floor(c - r); x < c + r; x++)
      if ((x - c) ** 2 + (y - c) ** 2 <= r * r) set(x, y, RED);
  return png(size, px);
}

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
if (!existsSync(site)) {
  console.error('site/ is missing — vite build must run first.');
  process.exit(1);
}
for (const size of [192, 512]) {
  writeFileSync(join(site, `icon-${size}.png`), drawIcon(size));
  console.log(`icon: site/icon-${size}.png`);
}
