/**
 * THE app version — docs/17 row 404. ONE seam, ONE stored counter.
 *
 * The version is stored in exactly one place, the tracked file `version.json`
 * (`{ "major": 1, "build": 0 }`), and shown as `<major>.<build, 3 digits>`
 * (1.000, 1.001, …). A BUILD is a PUBLISHED build, not a commit: only
 * `scripts/publish.mjs` increments the counter, and only after the live site
 * was verified by content. The OWNER changes `major` by hand for a major
 * build and sets `build` back to 0 in the same edit.
 *
 * Three digits: the increment past build 999 FAILS LOUDLY (no silent 1.1000,
 * no wrap) and tells the owner to raise the major.
 *
 * Consumers: `vite.config.ts` (the `__APP_VERSION__` define, injected from the
 * publish script's `CAMPAIGNER_VERSION`), `scripts/publish.mjs` (next version)
 * and `scripts/buildStatus.mjs` (payload `version`). None re-spells the format.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION_FILE = 'version.json';
export const MAX_BUILD = 999;
/** The define's value in dev and test: a clearly non-release marker. */
export const DEV_VERSION = 'dev';

export interface VersionCounter {
  readonly major: number;
  readonly build: number;
}

export function formatVersion(counter: VersionCounter): string {
  return `${String(counter.major)}.${String(counter.build).padStart(3, '0')}`;
}

/** Validate an unknown parsed JSON value as a counter; loud on any deviation. */
export function parseCounter(value: unknown): VersionCounter {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${VERSION_FILE} must be an object { "major": n, "build": n }`);
  }
  const { major, build, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error(`${VERSION_FILE} has unexpected keys: ${Object.keys(rest).join(', ')}`);
  }
  if (typeof major !== 'number' || !Number.isInteger(major) || major < 1) {
    throw new Error(`${VERSION_FILE}: "major" must be an integer >= 1`);
  }
  if (typeof build !== 'number' || !Number.isInteger(build) || build < 0 || build > MAX_BUILD) {
    throw new Error(`${VERSION_FILE}: "build" must be an integer 0..${String(MAX_BUILD)}`);
  }
  return { major, build };
}

export function readCounter(root: string): VersionCounter {
  const text = readFileSync(resolve(root, VERSION_FILE), 'utf8');
  return parseCounter(JSON.parse(text));
}

/** The counter after one more published build. Throws at build 999. */
export function nextCounter(counter: VersionCounter): VersionCounter {
  if (counter.build >= MAX_BUILD) {
    throw new Error(
      `version ${formatVersion(counter)} is the last of major ${String(counter.major)} (three digits): ` +
        `raise "major" in ${VERSION_FILE} by hand and set "build" back to 0, then publish again`,
    );
  }
  return { major: counter.major, build: counter.build + 1 };
}

/** The file text the counter is stored as. */
export function serializeCounter(counter: VersionCounter): string {
  return `{ "major": ${String(counter.major)}, "build": ${String(counter.build)} }\n`;
}
