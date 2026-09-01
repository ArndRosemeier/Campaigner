/**
 * Generates the iPad startup (splash) images for the installed PWA
 * (05-UI.md §Tablet): solid `background_color` fills at every modern iPad
 * class, portrait and landscape, so a launch shows the app's own background
 * instead of a white flash. WebKit only accepts `apple-touch-startup-image`
 * links whose media query matches the device exactly, so one file per
 * (device class × orientation × pixel ratio) is required.
 *
 * Pure Node (zlib deflate + hand-rolled PNG chunks) — no image dependency.
 * Run: node scripts/generate-splash.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public', 'splash');

/** manifest background_color #1c1917 → rgb(28, 25, 23). */
const BACKGROUND = [28, 25, 23];

/** iPad classes in CSS px (portrait device-width × device-height) and dpr. */
const DEVICES = [
  { css: [768, 1024], dpr: 1 }, // 9.7" iPad, non-retina
  { css: [768, 1024], dpr: 2 }, // 9.7" iPad / iPad Air 1-2, retina
  { css: [744, 1133], dpr: 2 }, // iPad mini 6/7 (8.3")
  { css: [820, 1180], dpr: 2 }, // iPad (10th gen, 10.9")
  { css: [834, 1112], dpr: 2 }, // iPad Air 3 / Pro 10.5"
  { css: [834, 1194], dpr: 2 }, // iPad Air 4-5 / Pro 11"
  { css: [1024, 1366], dpr: 2 }, // iPad Pro 12.9"
];

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Minimal truecolor PNG: every row is filter byte 0 + one solid RGB line. */
function solidPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let i = 0; i < width; i++) {
    row[1 + i * 3] = BACKGROUND[0];
    row[2 + i * 3] = BACKGROUND[1];
    row[3 + i * 3] = BACKGROUND[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });

/** Media query + link line pairs, printed for pasting into index.html. */
const links = [];

for (const { css, dpr } of DEVICES) {
  for (const orientation of ['portrait', 'landscape']) {
    const [cssW, cssH] = orientation === 'portrait' ? css : [css[1], css[0]];
    const width = cssW * dpr;
    const height = cssH * dpr;
    const file = `splash-${String(width)}x${String(height)}.png`;
    writeFileSync(resolve(outDir, file), solidPng(width, height));

    const media =
      `(orientation: ${orientation}) and (device-width: ${String(cssW)}px) ` +
      `and (device-height: ${String(cssH)}px) and (-webkit-device-pixel-ratio: ${String(dpr)})`;
    links.push({ file, media });
    console.log(`<link rel="apple-touch-startup-image" href="/splash/${file}" media="${media}" />`);
  }
}

console.error(`Wrote ${String(links.length)} splash images to public/splash/`);
