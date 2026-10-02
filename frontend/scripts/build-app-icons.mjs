// Draws the Head2Head mark into the PNG icons a phone needs for "Add to Home Screen". No dependencies:
// a tiny polygon rasteriser and PNG writer. Run `node scripts/build-app-icons.mjs` after changing the mark.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const BG = [16, 19, 17];
const ORANGE = [245, 112, 31];
const LIGHT = [232, 236, 232];
// The two slanted bars of the logo, in a 32x32 box (same shapes as the in-app logo).
const SHAPES = [
  { c: ORANGE, p: [[6, 26], [13, 6], [18, 6], [11, 26]] },
  { c: LIGHT, p: [[15, 26], [22, 6], [27, 6], [20, 26]] },
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** scale: share of the icon the 32-unit mark may fill (smaller leaves room for a phone's circular crop). */
function render(size, scale, rounded) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3;
  const box = 32 * (1 / scale);
  const off = (box - 32) / 2;
  const radius = rounded ? size * 0.22 : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS; const fy = y + (sy + 0.5) / SS;
          // rounded corners for the "any" icon
          if (radius) {
            const cx = Math.min(Math.max(fx, radius), size - radius); const cy = Math.min(Math.max(fy, radius), size - radius);
            if ((fx - cx) ** 2 + (fy - cy) ** 2 > radius ** 2) continue;
          }
          let col = BG;
          const ux = (fx / size) * box - off; const uy = (fy / size) * box - off;
          for (const s of SHAPES) if (inside(s.p, ux, uy)) { col = s.c; break; }
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = SS * SS; const i = (y * size + x) * 4;
      px[i] = a ? r / (a / 255) : 0; px[i + 1] = a ? g / (a / 255) : 0; px[i + 2] = a ? b / (a / 255) : 0; px[i + 3] = a / n;
    }
  }
  return px;
}

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const files = [
  ['icon-192.png', 192, 0.62, true],
  ['icon-512.png', 512, 0.62, true],
  ['icon-maskable-512.png', 512, 0.46, false], // full-bleed, mark kept inside the safe zone
  ['apple-touch-icon.png', 180, 0.62, false],   // iOS rounds it itself
  ['badge-96.png', 96, 0.8, false],
];
for (const [name, size, scale, rounded] of files) {
  writeFileSync(join(out, name), png(size, render(size, scale, rounded)));
  console.log('wrote', name);
}
