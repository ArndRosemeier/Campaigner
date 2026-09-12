import { ZodError } from 'zod';

/**
 * Human-readable ZodError surfaces (05-UI §Error surfaces; 18-ARCHITECTURE
 * toast seam): a ZodError's `.message` IS the raw
 * `[{code,path,message}...]` array, so rendering it verbatim (the old
 * `toastError` behavior) pasted a JSON wall in front of users. Everything
 * below formats AT THE SEAM — validation logic itself is untouched (same
 * throws, readable surfaces).
 *
 * Verified against zod's error shape: an issue carries ONLY `{code, path,
 * message}` — no input values, no record names. Names are therefore never
 * invented here: records are cited by table + index (`artifacts[2]`), and
 * kind breakdowns (encounter vs NPC) are NOT attempted at the seam — a
 * throwing context that HAS the rows names its own records if it can.
 */

/** Issues shown before the remainder folds into an "and N more" count. */
export const ZOD_SUMMARY_MAX_ISSUES = 3;

/** The mitigation every version-skew-shaped validation failure carries. */
export const ZOD_SKEW_MITIGATION =
  'Update this instance (or the exporting one) to the same version and try again.';

/** The minimal issue shape the humanizer reads (real or duck-typed). */
export interface ZodLikeIssue {
  path: readonly (string | number | symbol)[];
  message: string;
}

/**
 * Extracts readable issues from a real ZodError OR a ZodError-shaped
 * aggregate (same `{issues: [{path, message}]}` silhouette, e.g. rethrown
 * across a worker/serialization boundary where `instanceof` no longer
 * holds). Returns null for everything else — the guard is strict (every
 * issue must carry an array path + a string message) so unrelated errors
 * that happen to own an `issues` field never misfire through here.
 */
export function zodIssuesOf(error: unknown): ZodLikeIssue[] | null {
  if (error instanceof ZodError) {
    return error.issues.length > 0 ? [...error.issues] : null;
  }
  if (typeof error !== 'object' || error === null) return null;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const cleaned: ZodLikeIssue[] = [];
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) return null;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== 'string') return null;
    if (!path.every((part) => ['string', 'number', 'symbol'].includes(typeof part))) return null;
    cleaned.push({ path: path as (string | number | symbol)[], message });
  }
  return cleaned;
}

/** Human noun per top-level export/table segment (unknown tables fall back
 *  to the raw segment name — never dropped, never guessed). */
function groupLabel(segment: string): string {
  switch (segment) {
    case 'artifacts':
      return 'campaign records';
    case 'battles':
      return 'battles';
    case 'modules':
      return 'modules';
    case 'runs':
      return 'run history';
    case 'images':
      return 'images';
    case 'campaign':
      return 'campaign row';
    case 'dependencies':
    case 'missingImages':
      return 'import metadata';
    default:
      return segment;
  }
}

function groupOf(issue: ZodLikeIssue): string {
  const first = issue.path[0];
  return typeof first === 'string' ? first : 'file';
}

/** `artifacts.2.data.layout` → `artifacts[2].data.layout` (index-readable). */
function prettyPath(path: readonly (string | number | symbol)[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${String(part)}]`;
    else if (typeof part === 'symbol') out += part.toString();
    else if (out === '') out = part;
    else out += `.${part}`;
  }
  return out === '' ? 'file' : out;
}

/**
 * Counted, grouped, capped, actionable: multi-issue failures read as
 * `N problems in this file (8 campaign records, 3 battles). First
 * problems: … …and K more — full details in the console. <mitigation>`.
 * A single issue stays specific (`<group>: <path> — <message>`) with the
 * same mitigation. The FULL raw error is never pasted here — the seam
 * (`toast.ts`) logs it to the console, one click away in devtools.
 */
export function humanizeZodIssues(issues: readonly ZodLikeIssue[]): string {
  if (issues.length === 0) {
    return `This file couldn't be read, with no further details. ${ZOD_SKEW_MITIGATION}`;
  }
  if (issues.length === 1) {
    const only = issues[0];
    if (only === undefined) {
      return `This file couldn't be read, with no further details. ${ZOD_SKEW_MITIGATION}`;
    }
    return `${groupLabel(groupOf(only))} problem: ${prettyPath(only.path)} — ${only.message}. ${ZOD_SKEW_MITIGATION}`;
  }
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const group = groupOf(issue);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([group, count]) => `${String(count)} ${groupLabel(group)}`)
    .join(', ');
  const shown = issues.slice(0, ZOD_SUMMARY_MAX_ISSUES).map(
    (issue) => `${prettyPath(issue.path)} — ${issue.message}`,
  );
  const rest = issues.length - shown.length;
  const more = rest > 0 ? ` …and ${String(rest)} more — full details in the console.` : '';
  return (
    `${String(issues.length)} problems in this file (${groups}). ` +
    `First problems: ${shown.join('; ')}.${more} ${ZOD_SKEW_MITIGATION}`
  );
}
