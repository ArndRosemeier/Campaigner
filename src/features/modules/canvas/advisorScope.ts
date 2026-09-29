import type { AdvisorScope, AdvisorScopeTarget } from '@/domain/advisors';
import { moduleDocumentSections } from '@/domain/moduleDocument';

/**
 * WHAT AN ADVISOR IS ASKED TO CONCENTRATE ON (docs/17 row 400). CONTEXT is
 * always the whole document; this module only turns the owner's caret /
 * selection into the `AdvisorScopeTarget` that adds ONE line to the prompt.
 *
 * NEVER WIDENS SILENTLY (AGENTS rule 1): `selection` with nothing selected and
 * `section` with no caret are UNAVAILABLE with a reason the sidebar shows, and
 * asking anyway dispatches nothing.
 */
export interface AdvisorScopeSource {
  /** The document the offsets index into. */
  doc: string;
  /** Caret offset in `doc` (editor head, or the rendered selection start); null = no position known. */
  caret: number | null;
  /** The selected range in `doc`, or null when nothing is selected. */
  selection: { from: number; to: number } | null;
}

export const SELECTION_SCOPE_REASON =
  'Select some text in the document first - a selection advisor never widens to the whole document.';
export const SECTION_SCOPE_REASON =
  'Click into the text (or select a passage) so the advisor knows which section you mean.';

/** Why `scope` cannot be asked right now (null = it can). Pure, no parse. */
export function advisorScopeUnavailableReason(
  scope: AdvisorScope,
  source: Pick<AdvisorScopeSource, 'caret' | 'selection'>,
): string | null {
  if (scope === 'selection') return source.selection === null ? SELECTION_SCOPE_REASON : null;
  if (scope === 'section') {
    return source.caret === null && source.selection === null ? SECTION_SCOPE_REASON : null;
  }
  return null;
}

/** Resolves the target against the parsed document; throws (loud) when unavailable. */
export function resolveAdvisorTarget(
  scope: AdvisorScope,
  source: AdvisorScopeSource,
  planTitles: readonly { title: string }[],
): AdvisorScopeTarget {
  const reason = advisorScopeUnavailableReason(scope, source);
  if (reason !== null) throw new Error(reason);
  if (scope === 'global') return { scope: 'global' };
  const offset = source.selection?.from ?? source.caret ?? 0;
  const sections = moduleDocumentSections(source.doc, planTitles);
  // The level whose text ends at or after the offset; a separator line sits in
  // the gap AFTER the previous level's text, so it belongs to the level it
  // introduces. The premise (level 0) starts at offset 0.
  const section =
    sections.find((entry) => offset <= entry.textTo) ?? sections[sections.length - 1];
  if (section === undefined) throw new Error('the document has no sections');
  if (scope === 'section') {
    return { scope: 'section', level: section.number, title: section.title };
  }
  const range = source.selection;
  if (range === null) throw new Error(SELECTION_SCOPE_REASON);
  return {
    scope: 'selection',
    level: section.number,
    title: section.title,
    text: source.doc.slice(range.from, range.to),
  };
}
