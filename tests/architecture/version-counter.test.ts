import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isolatedGitEnv } from '../helpers/isolatedGit';

import { publish, type Runner } from '../../scripts/publish.mjs';
import {
  formatVersion,
  nextCounter,
  parseCounter,
  serializeCounter,
} from '../../scripts/version.ts';

/**
 * THE APP VERSION (docs/17 row 404): `version.json` is the one counter,
 * `scripts/version.ts` the one format, `scripts/publish.mjs` the only writer
 * (and only after the served bytes were verified by content).
 */
const ROOT = process.cwd();
const GOOD_HTML = '<script src="/Campaigner/assets/index-AAA.js"></script>';

function fixtureRoot(counter = '{ "major": 1, "build": 3 }'): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-test-'));
  writeFileSync(join(dir, 'version.json'), counter);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), GOOD_HTML);
  return dir;
}

interface Harness {
  readonly calls: string[];
  readonly run: Runner;
}

function harness(overrides: { failing?: string; branch?: string; dirty?: string } = {}): Harness {
  const calls: string[] = [];
  const run: Runner = (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    if (overrides.failing !== undefined && line.includes(overrides.failing)) {
      return { status: 1, stdout: '' };
    }
    if (line.startsWith('git status')) return { status: 0, stdout: overrides.dirty ?? '' };
    if (line.startsWith('git rev-parse')) return { status: 0, stdout: `${overrides.branch ?? 'main'}\n` };
    return { status: 0, stdout: '' };
  };
  return { calls, run };
}

function served(html: string, version: string): (url: string) => Promise<string> {
  return (url) =>
    Promise.resolve(url.endsWith('index.html') ? html : JSON.stringify({ state: 'wip', detail: 'x', version }));
}

describe('version format and counter (docs/17 row 404)', () => {
  it('formats major.build with three digits and a major bump resets', () => {
    expect(formatVersion({ major: 1, build: 0 })).toBe('1.000');
    expect(formatVersion({ major: 1, build: 7 })).toBe('1.007');
    expect(formatVersion({ major: 1, build: 42 })).toBe('1.042');
    expect(formatVersion(nextCounter({ major: 1, build: 41 }))).toBe('1.042');
    expect(formatVersion({ major: 2, build: 0 })).toBe('2.000');
  });

  it('fails LOUDLY past build 999 - no 1.1000, no wrap', () => {
    expect(formatVersion(nextCounter({ major: 1, build: 998 }))).toBe('1.999');
    expect(() => nextCounter({ major: 1, build: 999 })).toThrow(/raise "major"/);
    expect(() => parseCounter({ major: 1, build: 1000 })).toThrow();
    expect(() => parseCounter({ major: 1, build: 1, extra: 1 })).toThrow(/unexpected/);
  });

  it('keeps the tracked counter at a valid value', () => {
    const counter = parseCounter(JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8')));
    expect(serializeCounter(counter)).toBe(readFileSync(join(ROOT, 'version.json'), 'utf8'));
  });
});

describe('scripts/publish.mjs (injected runner, no network, no live dir)', () => {
  it('publishes in order and writes the counter ONLY after verification', async () => {
    const root = fixtureRoot();
    const h = harness();
    const result = await publish({
      root,
      run: h.run,
      fetchText: served(GOOD_HTML, '1.004'),
      log: () => undefined,
    });
    expect(result).toMatchObject({ ok: true, version: '1.004' });
    expect(readFileSync(join(root, 'version.json'), 'utf8')).toContain('"build": 4');
    const order = ['tsc', 'vite build', 'buildStatus', 'rsync', 'commit', 'push'].map((needle) =>
      h.calls.findIndex((call) => call.includes(needle)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.calls.find((call) => call.includes('commit'))).toContain('chore(version): 1.004');
  });

  it('leaves the counter untouched when the served asset hash differs', async () => {
    const root = fixtureRoot();
    const before = readFileSync(join(root, 'version.json'), 'utf8');
    const h = harness();
    const result = await publish({
      root,
      run: h.run,
      fetchText: served('<script src="/Campaigner/assets/index-OLD.js"></script>', '1.004'),
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, 'version.json'), 'utf8')).toBe(before);
    expect(h.calls.some((call) => call.includes('commit'))).toBe(false);
  });

  it('leaves the counter untouched when the served status names another version', async () => {
    const root = fixtureRoot();
    const before = readFileSync(join(root, 'version.json'), 'utf8');
    const result = await publish({
      root,
      run: harness().run,
      fetchText: served(GOOD_HTML, '1.003'),
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, 'version.json'), 'utf8')).toBe(before);
  });

  it.each(['tsc', 'vite build', 'buildStatus', 'rsync'])(
    'consumes no number when %s fails',
    async (failing) => {
      const root = fixtureRoot();
      const before = readFileSync(join(root, 'version.json'), 'utf8');
      const h = harness({ failing });
      const result = await publish({
        root,
        run: h.run,
        fetchText: served(GOOD_HTML, '1.004'),
        log: () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(join(root, 'version.json'), 'utf8')).toBe(before);
    },
  );

  it('refuses a dirty tree and a branch other than main', async () => {
    for (const overrides of [{ dirty: ' M src/a.ts\n' }, { branch: 'feature' }]) {
      const root = fixtureRoot();
      const h = harness(overrides);
      const result = await publish({
        root,
        run: h.run,
        fetchText: served(GOOD_HTML, '1.004'),
        log: () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('REFUSED');
      expect(h.calls.some((call) => call.includes('tsc'))).toBe(false);
    }
  });

  it('fails loudly at build 999 before building anything', async () => {
    const root = fixtureRoot('{ "major": 1, "build": 999 }');
    const h = harness();
    const result = await publish({ root, run: h.run, fetchText: served(GOOD_HTML, ''), log: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('raise "major"');
    expect(h.calls).toEqual([]);
  });

  it('--dry-run builds into a temp dir and touches nothing tracked', async () => {
    const root = fixtureRoot();
    const before = readFileSync(join(root, 'version.json'), 'utf8');
    const h = harness();
    const outDir = join(root, 'tmp-out');
    const result = await publish({
      root,
      run: h.run,
      fetchText: () => Promise.reject(new Error('network must not be used')),
      dryRun: true,
      makeTempDir: () => outDir,
      log: () => undefined,
    });
    expect(result).toMatchObject({ ok: true, version: '1.004' });
    expect(readFileSync(join(root, 'version.json'), 'utf8')).toBe(before);
    expect(h.calls.some((c) => /rsync|commit|push/.test(c))).toBe(false);
    expect(h.calls.find((c) => c.includes('vite build'))).toContain(`--outDir ${outDir}`);
  });
});

describe('version.json is NOT code for the classifiers (docs/17 row 404)', () => {
  it('the shared predicate calls a version-only diff docs-only, and a code diff not', () => {
    const run = (input: string): string =>
      execFileSync('node', [join(ROOT, 'scripts/docsOnly.mjs')], { input, encoding: 'utf8' }).trim();
    expect(run('version.json\n')).toBe('docs-only');
    expect(run('version.json\nsrc/a.ts\n')).toBe('not-docs-only');
    expect(run('sub/version.json\n')).toBe('not-docs-only');
  });

  it('the gate plan for a version-only diff is docs-only (no chunks)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gate-plan-'));
    mkdirSync(join(repo, 'scripts'));
    for (const file of ['gate.sh', 'docsOnly.mjs']) {
      copyFileSync(join(ROOT, 'scripts', file), join(repo, 'scripts', file));
    }
    const git = (...args: string[]): string =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { cwd: repo, encoding: 'utf8', env: isolatedGitEnv() },
      );
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.gate-logs/\n.campaigner-lock\n');
    writeFileSync(join(repo, 'version.json'), '{ "major": 1, "build": 0 }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'version.json'), '{ "major": 1, "build": 1 }\n');
    git('commit', '-q', '-am', 'chore(version): 1.001');
    const plan = execFileSync('bash', [join(repo, 'scripts/gate.sh')], {
      cwd: repo,
      encoding: 'utf8',
      env: isolatedGitEnv({ GATE_PLAN_ONLY: '1', GATE_DIFF_BASE: base }),
    });
    expect(plan).toMatch(/docs-only/);
  });
});
