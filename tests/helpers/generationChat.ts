import type { chat } from '@/llm/openrouter';

/**
 * ONE reader for the generation chat's transcript: the user text of the FIRST
 * LEVEL-generation call in a mocked `chat`, found by the prompt's OWN heading
 * rather than by a call index.
 *
 * WHY ONE SEAM (AGENTS §Centralization obligation 4, docs/17 row 391). The
 * search had been written twice — `tests/llm/fixedCast.test.ts` and
 * `tests/llm/module-gen-and-provenance.test.ts` — and the duplication tripwire
 * carried it as blessed debt. The engine's re-key to levels edited both copies,
 * the two hashes diverged from the baseline, and the tripwire named both sites:
 * the copies were FOLDED here instead, and the stale baseline line was DELETED
 * (never replaced — a baseline is debt, not a licence).
 *
 * The heading is `Write level <n>.` (docs/17 row 391): the engine names the
 * LEVEL, so the marker matches the one vocabulary the prompt itself uses. A
 * fixed call index would be fragile — the floor repair and the normalization
 * call that follow a pass shift it.
 */
export function partCallText(calls: readonly Parameters<typeof chat>[]): string {
  const call = calls.find((args) =>
    args[0].some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('Write level'),
    ),
  );
  if (call === undefined) throw new Error('no level call made');
  const user = call[0].find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}
