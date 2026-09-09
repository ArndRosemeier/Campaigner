/**
 * Canvas deep-link resolution (canvas v3, 08-MODULE-DESIGNER §Module
 * canvas): the canvas edits the WHOLE module in ONE document — there is no
 * part selector and no scope to resolve. A deep link (`?part=<planIndex|premise>`
 * via `canvasPath`, or the reader's `#part-<n>` hash) is a SCROLL target:
 * the editor scrolls to that part's section; `premise` scrolls to the top
 * (the premise itself lives on the Board/reader, not in the editor doc).
 * Pure: exported from here (not the page component file) so tests and the
 * page share one parse site. Unknown targets are NOT errors — a stale deep
 * link just means no scroll.
 */

export type CanvasScrollTarget = { kind: 'premise' } | { kind: 'part'; planIndex: number };

export interface PlannedPart {
  planIndex: number;
  title: string;
  levelBand: string;
}

/** Resolves the scroll target from `?part=` / `#part-<n>` (null = no
 * scroll; the page stays at the top). */
export function resolveCanvasScrollTarget(
  search: string,
  hash: string,
  plans: readonly PlannedPart[],
): CanvasScrollTarget | null {
  const param = new URLSearchParams(search).get('part');
  const fromParam = targetFromParam(param, plans);
  if (fromParam !== null) return fromParam;
  const hashMatch = /^#part-(\d+)$/.exec(hash);
  if (hashMatch !== null) {
    const fromHash = targetFromParam(hashMatch[1] ?? null, plans);
    if (fromHash !== null) return fromHash;
  }
  return null;
}

function targetFromParam(
  param: string | null,
  plans: readonly PlannedPart[],
): CanvasScrollTarget | null {
  if (param === 'premise') return { kind: 'premise' };
  if (param !== null && /^\d+$/.test(param)) {
    const planIndex = Number(param);
    if (plans.some((plan) => plan.planIndex === planIndex)) {
      return { kind: 'part', planIndex };
    }
  }
  return null;
}
