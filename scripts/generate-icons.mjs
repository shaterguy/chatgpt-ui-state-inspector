import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {fileURLToPath} from "node:url";

const SIZES = [16, 32, 48, 128];
const BACKGROUND = [15, 118, 110, 255];
const FOREGROUND = [255, 255, 255, 255];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({length: 256}, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  for (let channel = 0; channel < 4; channel += 1) pixels[offset + channel] = color[channel];
}

function stamp(pixels, size, x, y, width, color) {
  const radius = Math.max(0, Math.floor(width / 2));
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius + 1) setPixel(pixels, size, x + dx, y + dy, color);
    }
  }
}

function drawLine(pixels, size, x0, y0, x1, y1, width, color) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    stamp(pixels, size, x, y, width, color);
    if (x === targetX && y === targetY) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

function drawCircle(pixels, size, cx, cy, radius, width, color) {
  const segments = Math.max(24, Math.round(radius * 5));
  let previous = null;
  for (let index = 0; index <= segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    const point = {x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius};
    if (previous) drawLine(pixels, size, previous.x, previous.y, point.x, point.y, width, color);
    previous = point;
  }
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 4; channel += 1) pixels[offset + channel] = BACKGROUND[channel];
  }

  const width = Math.max(2, Math.round(size * 0.075));
  const cx = size * 0.43;
  const cy = size * 0.42;
  const radius = size * 0.22;
  drawCircle(pixels, size, cx, cy, radius, width, FOREGROUND);
  drawLine(pixels, size, cx + radius * 0.7, cy + radius * 0.7, size * 0.76, size * 0.76, width, FOREGROUND);

  const waveY = size * 0.42;
  drawLine(pixels, size, size * 0.26, waveY, size * 0.34, waveY, Math.max(1, width - 1), FOREGROUND);
  drawLine(pixels, size, size * 0.34, waveY, size * 0.39, size * 0.34, Math.max(1, width - 1), FOREGROUND);
  drawLine(pixels, size, size * 0.39, size * 0.34, size * 0.45, size * 0.50, Math.max(1, width - 1), FOREGROUND);
  drawLine(pixels, size, size * 0.45, size * 0.50, size * 0.51, waveY, Math.max(1, width - 1), FOREGROUND);
  drawLine(pixels, size, size * 0.51, waveY, size * 0.59, waveY, Math.max(1, width - 1), FOREGROUND);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowLength = size * 4;
  const raw = Buffer.alloc((rowLength + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const target = row * (rowLength + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, row * rowLength, (row + 1) * rowLength);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, {level: 9})), pngChunk("IEND")]);
}

const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension/icons");
fs.mkdirSync(outputDirectory, {recursive: true});
for (const size of SIZES) fs.writeFileSync(path.join(outputDirectory, `icon-${size}.png`), renderIcon(size));
console.log(`Generated ${SIZES.length} inspector PNG icons in ${path.relative(process.cwd(), outputDirectory)}.`);