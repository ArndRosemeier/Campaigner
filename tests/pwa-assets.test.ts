import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Static wiring checks for the PWA (05-UI.md §Tablet): the manifest is valid
 * and complete, index.html points at it, and the service worker only ever
 * touches same-origin GETs. Paths inside the manifest are relative on
 * purpose — they must resolve under any Vite base (/, /Campaigner/, …).
 */

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8')) as {
  name?: string;
  display?: string;
  orientation?: string;
  start_url?: string;
  scope?: string;
  id?: string;
  icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
};
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf8');

describe('pwa assets', () => {
  it('manifest declares a standalone landscape app with relative entry points', () => {
    expect(manifest.name).toBe('Campaigner');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('landscape');
    for (const entry of [manifest.start_url, manifest.scope, manifest.id]) {
      expect(entry).toMatch(/^\.{1,2}\/?$/); // './' — never an absolute path
    }
  });

  it('manifest icons reference existing pngs incl. a maskable one', () => {
    expect(manifest.icons).toBeDefined();
    const icons = manifest.icons ?? [];
    expect(icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(icons.some((icon) => icon.sizes === '512x512')).toBe(true);
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of icons) {
      expect(icon.src).not.toMatch(/^\//);
      const bytes = readFileSync(resolve(root, 'public', icon.src ?? ''));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    }
  });

  it('index.html wires viewport-fit, manifest, apple-touch-icon and theme color', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).toContain('rel="manifest"');
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('name="theme-color"');
  });

  it('service worker only handles same-origin GETs and defers everything else', () => {
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).toContain('url.origin !== globalThis.location.origin');
    expect(sw).toMatch(/registration\.scope/);
    // Fetch calls to the LLM API must never pass through the SW.
    expect(sw).not.toContain('openrouter');
  });
});
