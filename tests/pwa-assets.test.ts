import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SERVICE_WORKER_VERSION, serviceWorkerUrl } from '@/lib/serviceWorker';

import { readServiceWorkerVersion, serviceWorkerVersion } from '../scripts/swVersion.ts';

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
    // Installed-app compat on pre-manifest iPadOS and full-bleed status bar.
    expect(indexHtml).toContain('name="apple-mobile-web-app-capable"');
    expect(indexHtml).toContain('name="mobile-web-app-capable"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-title"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-status-bar-style"');
    // The viewport stays zoomable (no maximum-scale / user-scalable=no):
    // PWA fullscreen must not cost accessibility zoom.
    expect(indexHtml).not.toContain('maximum-scale');
    expect(indexHtml).not.toContain('user-scalable=no');
  });

  it('startup image links reference real PNGs sized to their media query', () => {
    // WebKit picks the splash by exact media match; a link whose PNG is the
    // wrong size silently regresses to the white flash.
    const startupLinks = [...indexHtml.matchAll(/<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)" \/>/g)];
    expect(startupLinks.length).toBeGreaterThanOrEqual(14); // 7 device classes × 2 orientations
    expect(new Set(startupLinks.map((link) => link[1])).size).toBe(startupLinks.length);

    for (const link of startupLinks) {
      const href = link[1];
      const media = link[2];
      if (href === undefined || media === undefined) {
        throw new Error('Malformed apple-touch-startup-image link in index.html');
      }
      expect(href).toMatch(/^\/splash\//);
      const bytes = readFileSync(resolve(root, 'public', href.replace(/^\//, '')));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      // PNG IHDR: width and height are big-endian uint32s at offsets 16/20.
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);

      const orientation = /orientation: (\w+)/.exec(media)?.[1];
      const deviceWidth = Number(/device-width: (\d+)px/.exec(media)?.[1]);
      const deviceHeight = Number(/device-height: (\d+)px/.exec(media)?.[1]);
      const dpr = Number(/device-pixel-ratio: (\d+)/.exec(media)?.[1]);
      expect(orientation).toBeDefined();
      expect(deviceWidth).toBeGreaterThan(0);
      expect(deviceHeight).toBeGreaterThan(0);
      expect(dpr).toBeGreaterThan(0);

      // device-width/height are already stated in the link's orientation, so
      // the image is always deviceWidth×dpr by deviceHeight×dpr.
      expect([width, height]).toEqual([deviceWidth * dpr, deviceHeight * dpr]);
    }
  });

  it('service worker only handles same-origin GETs and defers everything else', () => {
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).toContain('url.origin !== globalThis.location.origin');
    expect(sw).toMatch(/registration\.scope/);
    // Fetch calls to the LLM API must never pass through the SW.
    expect(sw).not.toContain('openrouter');
  });
});

/**
 * THE SERVICE WORKER'S URL IS CONTENT-ADDRESSED (docs/17 row 379).
 *
 * `sw.js` is a FIXED-NAME asset and this host's CDN caches it for four hours
 * while IGNORING a client `Cache-Control: no-cache` (measured; the table is in
 * docs/08-TESTING.md §The service worker's URL is content-addressed). So a
 * shipped worker change reaches a browser ONLY through a url whose NAME
 * changes, and the name must change EXACTLY when the worker's bytes change —
 * a timestamp or a build id would make every deploy a new worker url and force
 * every client to re-fetch and re-install an unchanged worker.
 *
 * The version is computed by the ONE seam `scripts/swVersion.ts`, injected by
 * `vite.config.ts` (`define`) and read here as `SERVICE_WORKER_VERSION`. These
 * pins are what make "the version follows the content" load-bearing rather
 * than aspirational: (a) is the property, (c) is the arm that stops (a)
 * passing with a constant.
 */
describe('the service worker url is content-addressed (docs/17 row 379)', () => {
  it('(a) the INJECTED version is the hash of the REAL public/sw.js', () => {
    // Injected by vite.config.ts from the seam; a hard-coded or stale value
    // (or a config that stopped reading the file) reds here.
    expect(SERVICE_WORKER_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(SERVICE_WORKER_VERSION).toBe(readServiceWorkerVersion(root));
  });

  it('(b) registration composes the url from the Vite base AND the version', () => {
    expect(serviceWorkerUrl('/Campaigner/', SERVICE_WORKER_VERSION)).toBe(
      `/Campaigner/sw.js?v=${SERVICE_WORKER_VERSION}`,
    );
    expect(serviceWorkerUrl('/', SERVICE_WORKER_VERSION)).toBe(
      `/sw.js?v=${SERVICE_WORKER_VERSION}`,
    );
    // The bare fixed-name url is the defect this row fixes; the versioned url
    // must never collapse back to it.
    expect(serviceWorkerUrl('/Campaigner/', SERVICE_WORKER_VERSION)).not.toBe('/Campaigner/sw.js');
  });

  it('(c) DIFFERENTIAL — the version FOLLOWS THE CONTENT', () => {
    const source = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
    const real = serviceWorkerVersion(source);
    const modified = serviceWorkerVersion(`${source}\n// row-379 differential probe\n`);
    // The seam the config injected through really is this content's version…
    expect(real).toBe(SERVICE_WORKER_VERSION);
    // …and the arm that a constant version cannot pass: different bytes, a
    // different version (so a changed worker really is a new url).
    expect(modified).not.toBe(real);
  });

  it('(d) the registration site USES the helper — SHAPE pin, deliberately', () => {
    const main = readFileSync(resolve(root, 'src/main.tsx'), 'utf8');
    expect(main).toContain(
      'serviceWorkerUrl(import.meta.env.BASE_URL, SERVICE_WORKER_VERSION)',
    );
    // The pre-379 spelling, which must never come back.
    expect(main).not.toContain('${import.meta.env.BASE_URL}sw.js');
    // WHY A SHAPE PIN AND NOT A BEHAVIOURAL ONE: the registration runs only in
    // a real browser under `import.meta.env.PROD`, and jsdom has no service
    // worker container, so no test here can observe the registered url. The
    // helper's COMPOSITION is pinned behaviourally by (b); this pin only holds
    // the one call site to that helper.
  });
});
