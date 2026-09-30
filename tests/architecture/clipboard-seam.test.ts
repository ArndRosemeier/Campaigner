import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { repoFiles } from '../helpers/sourceCode';

it('keeps clipboard writes in exactly one shared capability boundary', () => {
  const sites = repoFiles('src', ['.ts', '.tsx']).filter((file) =>
    readFileSync(file, 'utf8').includes('.writeText('),
  );
  expect(sites).toEqual(['src/lib/clipboard.ts']);
  const panel = readFileSync('src/features/campaign/components/persona-panel.tsx', 'utf8');
  expect(panel.match(/await copyText\(/g)).toHaveLength(2);
});
