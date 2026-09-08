import type { CanvasPartParam } from '@/app/routes';

/**
 * Canvas scope resolution (08-MODULE-DESIGNER §Module canvas): the canvas
 * edits ONE module part at a time (the premise is a read-only scope), and a
 * deep link opens a chosen part via `?part=<planIndex|premise>` — with the
 * reader's `#part-<n>` hash honored on load. Pure: exported from here (not
 * the page component file) so tests and the page share one parse site.
 */

export type CanvasScope = { kind: 'premise' } | { kind: 'part'; planIndex: number };

export interface PlannedPart {
  planIndex: number;
  title: string;
  levelBand: string;
}

/** Resolves the scope from `?part=` / `#part-<n>`, falling forward to the
 * first planned part (else the premise). Unknown targets are NOT errors —
 * a stale deep link just opens the default scope. */
export function resolveCanvasScope(
  search: string,
  hash: string,
  plans: readonly PlannedPart[],
): CanvasScope {
  const param = new URLSearchParams(search).get('part');
  const fromParam = scopeFromParam(param, plans);
  if (fromParam !== null) return fromParam;
  const hashMatch = /^#part-(\d+)$/.exec(hash);
  if (hashMatch !== null) {
    const fromHash = scopeFromParam(hashMatch[1] ?? null, plans);
    if (fromHash !== null) return fromHash;
  }
  const first = plans[0]?.planIndex;
  return first === undefined ? { kind: 'premise' } : { kind: 'part', planIndex: first };
}

function scopeFromParam(
  param: string | null,
  plans: readonly PlannedPart[],
): CanvasScope | null {
  if (param === 'premise') return { kind: 'premise' };
  if (param !== null && /^\d+$/.test(param)) {
    const planIndex = Number(param);
    if (plans.some((plan) => plan.planIndex === planIndex)) {
      return { kind: 'part', planIndex };
    }
  }
  return null;
}

export function scopeParam(scope: CanvasScope): CanvasPartParam {
  return scope.kind === 'premise' ? 'premise' : scope.planIndex;
}

export function scopeKey(scope: CanvasScope): string {
  return scope.kind === 'premise' ? 'premise' : `part-${String(scope.planIndex)}`;
}
