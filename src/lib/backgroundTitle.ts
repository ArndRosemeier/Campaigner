/**
 * Background completion surface (docs/17 row 110, docs/18 §2.2/§4).
 *
 * The owner's report has two halves: "the browser stalls the app while I am in
 * another app" and the honest question behind the second half — "I cannot tell
 * whether it finished" (module generation takes minutes and normal user
 * behaviour is to switch away). A `document.title` (and, where the browser
 * allows it, the favicon) is the ONLY surface a backgrounded tab has: the tab
 * strip is what the owner is looking at while he is elsewhere. Updating it
 * while backgrounded is also one of Chromium's listed freeze opt-out criteria
 * — a page that keeps producing observable output is not the page the freeze
 * heuristics pick.
 *
 * The rules, deliberately literal so the title never lies:
 * - the title is a BACKGROUND surface: while the page is visible the app's own
 *   title is restored, so nothing the owner reads on screen changes;
 * - a RUNNING activity reads as what is running, never as progress it cannot
 *   know ("Writing part 2 of 5" is a caller's label, not this module's guess);
 * - a FINISHED activity reads `✓`, a FAILED one `⚠` — and only from a row that
 *   actually reached that verdict: a user stop reaches no verdict and clears
 *   the entry instead of inventing "finished";
 * - failed outranks finished outranks running (the thing the owner must act on
 *   wins the single line), and further entries of the same rank are counted
 *   (`(+2 more)`) rather than dropped silently.
 *
 * No DOM is required: in node the module keeps its state and writes nothing.
 */

/** The app's own title (the shell restores exactly this). */
export const APP_BASE_TITLE = 'Campaigner';

export type BackgroundActivityState = 'running' | 'completed' | 'failed';

export interface BackgroundActivity {
  /** What is running, in the owner's terms (module title, persona name…). */
  label: string;
  state: BackgroundActivityState;
}

interface Entry extends BackgroundActivity {
  /** Monotonic per-write order: the most recently touched entry wins its rank
   * (deterministic in tests — never a clock comparison). */
  seq: number;
}

const entries = new Map<string, Entry>();
let seq = 0;

function doc(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/** True while the tab is backgrounded (the only state in which we write). */
function isBackgrounded(): boolean {
  return doc()?.hidden === true;
}

/** The rank order of the states (the owner must act on the highest first). */
const STATE_RANK: Record<BackgroundActivityState, number> = {
  failed: 3,
  completed: 2,
  running: 1,
};

/**
 * Registers or updates one activity. Callers own the id (one per run, one per
 * module) so a later write replaces the earlier one instead of stacking.
 */
export function setBackgroundActivity(id: string, activity: BackgroundActivity): void {
  seq += 1;
  entries.set(id, { ...activity, seq });
  applyBackgroundTitle();
}

/** Removes one activity (a stop, a surface that is gone, an unmount). */
export function clearBackgroundActivity(id: string): void {
  if (entries.delete(id)) applyBackgroundTitle();
}

/** How many activities are currently tracked (tests + callers). */
export function backgroundActivityCount(): number {
  return entries.size;
}

/**
 * The label recorded for an id, or `undefined` when nothing is tracked. Lets a
 * caller that only knows the VERDICT (a late failure handler) keep the label a
 * later site registered instead of inventing or blanking one.
 */
export function backgroundActivityLabel(id: string): string | undefined {
  return entries.get(id)?.label;
}

/**
 * Clears the FINISHED entries (a `✓`/`⚠` is news for the trip away, not for
 * the next one) and restores the app title. Called on the way back IN.
 */
export function clearFinishedBackgroundActivities(): void {
  for (const [id, entry] of entries) {
    if (entry.state !== 'running') entries.delete(id);
  }
  applyBackgroundTitle();
}

/** Test seam: forgets every activity. */
export function resetBackgroundTitle(): void {
  entries.clear();
  seq = 0;
}

/**
 * The title for the current state — the ONE place the copy is decided. Pure:
 * callers (and tests) can render it without touching the DOM.
 */
export function backgroundTitle(): string {
  if (entries.size === 0) return APP_BASE_TITLE;
  let winnerId: string | null = null;
  let winner: Entry | null = null;
  let rank = 0;
  for (const [id, entry] of entries) {
    const entryRank = STATE_RANK[entry.state];
    if (winner === null || entryRank > rank || (entryRank === rank && entry.seq > winner.seq)) {
      winnerId = id;
      winner = entry;
      rank = entryRank;
    }
  }
  if (winner === null) return APP_BASE_TITLE;
  const sameRank = [...entries.entries()].filter(
    ([id, entry]) => STATE_RANK[entry.state] === rank && id !== winnerId,
  ).length;
  const more = sameRank === 0 ? '' : ` (+${String(sameRank)} more)`;
  if (winner.state === 'failed') return `⚠ Failed: ${winner.label}${more} — ${APP_BASE_TITLE}`;
  if (winner.state === 'completed') {
    return `✓ Finished: ${winner.label}${more} — ${APP_BASE_TITLE}`;
  }
  // The RUNNING line is a status verb, not a guess: it says the app is working
  // on that label right now (the label is the caller's, never a progress claim).
  return `Working: ${winner.label}${more} — ${APP_BASE_TITLE}`;
}

/**
 * Writes the title for the CURRENT state: the background line while the tab is
 * hidden, the app's own title while it is visible. Safe with no document (node
 * tests, workers) — the state is still tracked, nothing is written.
 */
export function applyBackgroundTitle(): void {
  const document_ = doc();
  if (document_ === null) return;
  document_.title = isBackgrounded() ? backgroundTitle() : APP_BASE_TITLE;
}
