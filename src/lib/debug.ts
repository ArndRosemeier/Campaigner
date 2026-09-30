/**
 * Opt-in diagnostics (00-OVERVIEW: console output must never replace a user
 * surface, so these lines are OFF by default). Turn on in the browser:
 *
 *   localStorage.setItem('campaigner:debug', '1')
 *
 * …then reload. Every slow path (retrieval, draft, statblock, stream) logs
 * how far it got under the `[campaigner:*]` prefix; turn off with
 * `localStorage.removeItem('campaigner:debug')`.
 */

const FLAG_KEY = 'campaigner:debug';

export function debugEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false; // storage unavailable — stay silent
  }
}

export function debugLog(scope: string, message: string, data?: unknown): void {
  if (!debugEnabled()) return;
  const line = `[campaigner:${scope}] ${message}`;
  if (data === undefined) console.info(line);
  else console.info(line, data);
}
