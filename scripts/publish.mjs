#!/usr/bin/env node
/**
 * THE publish script — docs/17 row 404, docs/18 §2. It replaces the hand-run
 * sequence (tsc -> vite build -> buildStatus -> rsync -> verify) and is the ONLY
 * writer of the version counter `version.json` (`scripts/version.ts` owns the
 * format; the owner raises `major` by hand for a major build, build back to 0).
 *
 * A "build" is a PUBLISHED build, not a commit. Order, each step printed with
 * its exit status, nothing piped:
 *   1 preflight  clean tree + branch main (refused loudly otherwise)
 *   2 tsc -b
 *   3 vite build --mode domainfactory   (CAMPAIGNER_VERSION = the NEXT version)
 *   4 node scripts/buildStatus.mjs --version <next>
 *   5 rsync -a --delete dist/ <target>
 *   6 VERIFY BY CONTENT: the served index-*.js name equals dist's, and the served
 *     build-status.json names the next version
 *   7 ONLY THEN write version.json, commit it, push.
 * Any failing step stops the script with a non-zero exit and leaves version.json
 * untouched, so a failed publish consumes NO number.
 *
 * `--dry-run`: build + status into a temp directory; no rsync, no counter write,
 * no commit. It skips the clean/main preflight because it changes nothing
 * tracked (it only warns). The runner and fetcher are injected (`publish`), so
 * tests never touch the network or the live directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatVersion, nextCounter, readCounter, serializeCounter } from './version.ts';

export const LIVE_TARGET = '/home/administrator/projects/Migration/apps/Campaigner/';
export const LIVE_URL = 'https://apps.futuremagic.de/Campaigner/';
const IDENTITY = ['-c', 'user.name=Campaigner Dev', '-c', 'user.email=dev@campaigner.local'];

/** The real command runner. `capture` returns stdout; otherwise output streams. */
export function realRunner(cwd) {
  return (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? '' };
  };
}

/** The real fetcher: cache-busted (the CDN caches a fixed URL for hours). */
export async function realFetchText(url) {
  const busted = `${url}${url.includes('?') ? '&' : '?'}cb=${String(Date.now())}`;
  const response = await fetch(busted, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`);
  return response.text();
}

/** `assets/index-<hash>.js` as the build itself wrote it into index.html. */
export function entryAsset(html) {
  const match = /assets\/index-[^"']+\.js/.exec(html);
  if (match === null) throw new Error('no assets/index-*.js script tag in index.html');
  return match[0];
}

class StepFailed extends Error {}

/**
 * Run the publish. Returns `{ ok, version, log }`; never throws for a failed
 * step (the failure is the return value and `ok` is false).
 */
export async function publish({
  root,
  run,
  fetchText,
  dryRun = false,
  target = LIVE_TARGET,
  liveUrl = LIVE_URL,
  log = (line) => process.stdout.write(`${line}\n`),
  readFile = (path) => readFileSync(path, 'utf8'),
  writeFile = (path, text) => writeFileSync(path, text),
  makeTempDir = () => mkdtempSync(join(tmpdir(), 'campaigner-publish-')),
}) {
  const step = (label, command, args, options) => {
    log(`== ${label}: ${command} ${args.join(' ')}`);
    const result = run(command, args, options);
    log(`== ${label}: exit status ${String(result.status)}`);
    if (result.status !== 0) throw new StepFailed(`${label} failed (exit ${String(result.status)})`);
    return result.stdout;
  };
  let version = null;
  try {
    const counter = readCounter(root);
    const next = nextCounter(counter); // throws loudly at build 999
    version = formatVersion(next);
    log(`== version: ${formatVersion(counter)} -> ${version}${dryRun ? ' (DRY RUN)' : ''}`);

    const dirty = step('preflight status', 'git', ['status', '--porcelain'], { capture: true });
    const branch = step('preflight branch', 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      capture: true,
    }).trim();
    if (dryRun) {
      if (dirty.trim() !== '' || branch !== 'main') {
        log(`!! dry run: tree ${dirty.trim() === '' ? 'clean' : 'DIRTY'}, branch ${branch} (a real publish refuses this)`);
      }
    } else {
      if (branch !== 'main') throw new StepFailed(`REFUSED: branch is '${branch}', publish runs only from main`);
      if (dirty.trim() !== '') throw new StepFailed(`REFUSED: the working tree is dirty:\n${dirty}`);
    }

    const outDir = dryRun ? makeTempDir() : join(root, 'dist');
    step('typecheck', 'node_modules/.bin/tsc', ['-b']);
    step(
      'build',
      'node_modules/.bin/vite',
      ['build', '--mode', 'domainfactory', ...(dryRun ? ['--outDir', outDir, '--emptyOutDir'] : [])],
      { env: { CAMPAIGNER_VERSION: version } },
    );
    step('build status', 'node', [
      'scripts/buildStatus.mjs',
      '--out',
      join(outDir, 'build-status.json'),
      '--version',
      version,
    ]);
    if (dryRun) {
      log(`== dry run complete: ${version} built into ${outDir}; nothing uploaded, counter untouched`);
      return { ok: true, version, log: null, outDir };
    }

    step('upload', 'rsync', ['-a', '--delete', `${outDir}/`, target]);

    log('== verify: served content vs dist');
    const built = entryAsset(readFile(join(outDir, 'index.html')));
    const served = entryAsset(await fetchText(`${liveUrl}index.html`));
    if (built !== served) {
      throw new StepFailed(`VERIFY FAILED: served entry is ${served} but dist has ${built}`);
    }
    const status = JSON.parse(await fetchText(`${liveUrl}build-status.json`));
    if (status.version !== version) {
      throw new StepFailed(
        `VERIFY FAILED: served build-status.json version is ${String(status.version)}, expected ${version}`,
      );
    }
    log(`== verify: OK (${built}, version ${version})`);

    // Only now is the number consumed.
    writeFile(join(root, 'version.json'), serializeCounter(next));
    step('commit', 'git', [...IDENTITY, 'commit', '-m', `chore(version): ${version}`, '--', 'version.json']);
    step('rebase', 'git', ['pull', '--rebase', 'origin', 'main']);
    step('push', 'git', ['push', 'origin', 'HEAD:main']);
    log(`== PUBLISHED ${version}`);
    return { ok: true, version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`!! PUBLISH FAILED${version === null ? '' : ` (would have been ${version})`}: ${message}`);
    log('!! version.json is untouched unless the failure is at the commit/push step (see above)');
    return { ok: false, version, error: message };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${unknown.join(' ')} (only --dry-run)\n`);
    process.exit(1);
  }
  const root = resolve(process.cwd());
  const result = await publish({ root, run: realRunner(root), fetchText: realFetchText, dryRun });
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
