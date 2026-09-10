import { useMemo } from 'react';

import type { AnyArtifact, Module } from '@/domain';
import { moduleCreationPool } from '@/domain';
import {
  countOccurrences,
  extractWikiLinks,
  resolveWikiLink,
  sentenceAround,
} from '@/lib/wikilinks';

/** One entity row of the module reader's entity panel (`entity-panel.tsx`). */
export interface EntityEntry {
  name: string;
  resolved: boolean;
  ambiguous: boolean;
  artifact: AnyArtifact | undefined;
  occurrences: { where: string; count: number }[];
  total: number;
  sentence: string;
}

/**
 * The entity panel's data derivation (08-MODULE-DESIGNER M4-C; fix-01 state
 * surfaces): every wikilink name in the module's generated text, resolved,
 * counted and quoted — the array the panel's buckets, progress line and rows
 * render from. Lives beside the panel (which owns the UI) and is exported for
 * its tests.
 */
export function useModuleEntities(
  module: Module,
  artifacts: readonly AnyArtifact[],
): { entries: EntityEntry[]; documents: { where: string; markdown: string }[] } {
  return useMemo(() => {
    // The panel is a MODULE-CREATION surface (its unresolved rows are the
    // batch work queue and its observation feeds the classification run), so
    // it resolves against the module-creation pool: the Party is invisible
    // here (docs/17 row 69). A separate-named PC mention therefore reads as
    // unresolved — the module gets its own entity instead of silently binding
    // to a player character. Reading surfaces (reader chips, chat) still
    // resolve against the full pool.
    const pool = moduleCreationPool(artifacts);
    const documents = [
      { where: 'premise', markdown: module.spine?.premise ?? '' },
      ...module.parts
        .slice()
        .sort((a, b) => a.planIndex - b.planIndex)
        .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
    ];
    const names = extractWikiLinks(documents.map((document) => document.markdown).join('\n\n')).map(
      (link) => link.name,
    );
    const entries = names.map((name) => {
      const resolution = resolveWikiLink(name, pool, { moduleId: module.id });
      const occurrences = countOccurrences(name, documents);
      const firstDoc = documents.find((document) =>
        countOccurrences(name, [document]).length > 0,
      );
      return {
        name,
        resolved: resolution.artifact !== undefined,
        ambiguous: resolution.status === 'ambiguous',
        artifact: resolution.artifact,
        occurrences,
        total: occurrences.reduce((sum, occurrence) => sum + occurrence.count, 0),
        sentence: sentenceAround(firstDoc?.markdown ?? '', name),
      };
    });
    // First-mention order (premise first, then parts by plan index) — the
    // 'mention' sort mode; the panel re-sorts per `module.entitySort`.
    return { entries, documents };
  }, [module, artifacts]);
}
