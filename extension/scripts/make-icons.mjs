// Generates icons/icon{16,32,48,128}.png without any dependency (PNG encoder + 4x4 supersampling).
// Design: rounded blue square with three "tab group" pills (blue, orange, green).
// Usage: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

// Shapes in a 0..1 coordinate space, painted in order.
const SHAPES = [
  { x: 0.02, y: 0.02, w: 0.96, h: 0.96, r: 0.22, color: [26, 115, 232] }, // background
  { x: 0.18, y: 0.2, w: 0.64, h: 0.16, r: 0.08, color: [174, 203, 250] }, // pill 1
  { x: 0.18, y: 0.42, w: 0.48, h: 0.16, r: 0.08, color: [252, 173, 112] }, // pill 2
  { x: 0.18, y: 0.64, w: 0.56, h: 0.16, r: 0.08, color: [129, 201, 149] }, // pill 3
];

function insideRoundedRect(px, py, { x, y, w, h, r }) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let [red, green, blue, alpha] = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (col + (sx + 0.5) / SAMPLES) / size;
          const py = (row + (sy + 0.5) / SAMPLES) / size;
          let color = null;
          for (const shape of SHAPES) if (insideRoundedRect(px, py, shape)) color = shape.color;
          if (color) {
            red += color[0];
            green += color[1];
            blue += color[2];
            alpha += 1;
          }
        }
      }
      const offset = (row * size + col) * 4;
      if (alpha) {
        pixels[offset] = Math.round(red / alpha);
        pixels[offset + 1] = Math.round(green / alpha);
        pixels[offset + 2] = Math.round(blue / alpha);
        pixels[offset + 3] = Math.round((alpha / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
