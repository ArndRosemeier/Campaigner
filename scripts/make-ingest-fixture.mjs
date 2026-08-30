/**
 * Generates the committed integration-test fixture
 * `tests/fixtures/sample-rulebook.pdf`: a tiny 2-page text PDF (page 1 = a
 * chapter heading + body prose about grappling, page 2 = a stat block under a
 * level-2 heading). Run `node scripts/make-ingest-fixture.mjs` to regenerate.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'sample-rulebook.pdf',
);

const esc = (text) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function contentStream(lines) {
  const ops = lines
    .map(({ text, x, y, font, size }) => `BT /${font} ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`)
    .join('\n');
  return ops;
}

const page1Lines = [
  { text: 'Chapter 1: The Grappling Rules', font: 'F2', size: 20, x: 72, y: 740 },
  {
    text: 'Grappling is a special melee attack used to seize and hold a creature.',
    font: 'F1',
    size: 10,
    x: 72,
    y: 700,
  },
  {
    text: 'When you grapple a target, both of you use the escape DC of the grappler.',
    font: 'F1',
    size: 10,
    x: 72,
    y: 686,
  },
  {
    text: 'A grappled creature can still attack other targets but cannot move away.',
    font: 'F1',
    size: 10,
    x: 72,
    y: 672,
  },
  {
    text: 'Movement while grappling is halved for both creatures involved.',
    font: 'F1',
    size: 10,
    x: 72,
    y: 658,
  },
  {
    text: 'The grapple ends if the grappler is knocked prone or incapacitated.',
    font: 'F1',
    size: 10,
    x: 72,
    y: 644,
  },
];

const page2Lines = [
  { text: 'Goblin Boss', font: 'F2', size: 16, x: 72, y: 740 },
  { text: 'Medium humanoid, neutral evil', font: 'F1', size: 10, x: 72, y: 720 },
  { text: 'Armor Class 17 (chain shirt)', font: 'F1', size: 10, x: 72, y: 700 },
  { text: 'Hit Points 66 (12d6 + 22)', font: 'F1', size: 10, x: 72, y: 686 },
  { text: 'Speed 30 ft.', font: 'F1', size: 10, x: 72, y: 672 },
  { text: 'STR 14 DEX 14 CON 14 INT 10 WIS 10 CHA 12', font: 'F1', size: 10, x: 72, y: 658 },
  { text: 'Challenge 2 (450 XP)', font: 'F1', size: 10, x: 72, y: 644 },
];

const objects = [];
objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
objects[3] =
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 7 0 R >>';
objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
objects[5] =
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 8 0 R >>';
objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
objects[7] = { stream: contentStream(page1Lines) };
objects[8] = { stream: contentStream(page2Lines) };

let pdf = '%PDF-1.4\n';
const offsets = [];
for (let i = 1; i < objects.length; i += 1) {
  offsets[i] = pdf.length;
  const obj = objects[i];
  const body =
    typeof obj === 'string'
      ? obj
      : `<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream`;
  pdf += `${i} 0 obj\n${body}\nendobj\n`;
}
const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for (let i = 1; i < objects.length; i += 1) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, pdf, 'latin1');
console.log(`Wrote ${outPath} (${pdf.length} bytes)`);
