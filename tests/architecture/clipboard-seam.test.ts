import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('keeps clipboard writes in exactly one shared capability boundary', () => {
  const sites: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file) && readFileSync(file, 'utf8').includes('.writeText(')) sites.push(file);
    }
  }
  walk('src');
  expect(sites).toEqual(['src/lib/clipboard.ts']);
  const panel = readFileSync('src/features/campaign/components/persona-panel.tsx', 'utf8');
  expect(panel.match(/await copyText\(/g)).toHaveLength(2);
});
