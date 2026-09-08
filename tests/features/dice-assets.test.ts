import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The `@3d-dice/dice-box` static manifest (M5-D): the engine fetches its
 * physics + theme payloads from `assetPath` at INIT time, so a missing file
 * here is a guaranteed loud init failure in production (and a permanently
 * blocked roller) — never something the picker can paper over. The set below
 * mirrors the package's canonical `dist/assets` tree; the engine test pins
 * the matching `assetPath` (`/assets/dice-box/`) on the constructed config.
 */

const root = resolve(import.meta.dirname, '..', '..');
const diceBox = resolve(root, 'public/assets/dice-box');

function diceFile(...segments: string[]): Buffer {
  const path = resolve(diceBox, ...segments);
  expect(existsSync(path), `missing dice asset: public/assets/dice-box/${segments.join('/')}`).toBe(true);
  const bytes = readFileSync(path);
  expect(bytes.length).toBeGreaterThan(0);
  return bytes;
}

describe('dice-box assets', () => {
  it('ships the Ammo physics payload as a real wasm module', () => {
    const bytes = diceFile('ammo', 'ammo.wasm.wasm');
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('\0asm');
  });

  it('ships the default theme: configs parse, textures are real images', () => {
    for (const config of ['theme.config.json', 'default.json']) {
      const bytes = diceFile('themes', 'default', config);
      expect((): void => {
        JSON.parse(bytes.toString('utf8'));
      }).not.toThrow();
    }
    for (const texture of ['diffuse-dark.png', 'diffuse-light.png', 'normal.png']) {
      const bytes = diceFile('themes', 'default', texture);
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    }
    const specular = diceFile('themes', 'default', 'specular.jpg');
    expect(specular.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
