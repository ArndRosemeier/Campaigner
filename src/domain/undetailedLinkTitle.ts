import { ARTIFACT_KIND_SINGULAR } from '@/domain/artifact';
import { entityRecordFor, type ModuleEntityKind } from '@/domain/module';

/**
 * THE hover text of a wiki-link that has no artifact yet (docs/17 row 417) —
 * the canvas editor's mark and the rendered chip both show this, so the two
 * can never say different things about one name.
 *
 * It states only what the module ALREADY records for the name (its
 * `entityKinds` record, read through the ONE `entityRecordFor`): the kind, the
 * level hint, the author's intent, the library creature it is cast from and the
 * variant spellings folded into it. Nothing is inferred.
 *
 * `entityKinds` is `undefined` on a surface that does not know the module's
 * records — the tooltip then says only that the name is not detailed, and never
 * claims it is unclassified. `[]`/no match on a surface that DOES know them is
 * the honest "no kind recorded yet".
 */
export function undetailedLinkTitle(
  name: string,
  entityKinds: readonly ModuleEntityKind[] | undefined,
): string {
  const head = `${name} — not detailed yet`;
  if (entityKinds === undefined) return head;
  const record = entityRecordFor(entityKinds, name);
  if (record === undefined) {
    return `${head}\nKind: not recorded yet — Generate details classifies it`;
  }
  const lines = [head, `Kind: ${ARTIFACT_KIND_SINGULAR[record.kind]}`];
  if (record.levelHint !== undefined) lines.push(`Level: ${String(record.levelHint)}`);
  const intent = record.intent?.trim();
  if (intent !== undefined && intent !== '') lines.push(`Intent: ${intent}`);
  if (record.bestiary !== undefined) {
    const book = record.bestiary.book === undefined ? '' : ` (${record.bestiary.book})`;
    lines.push(`Stats from: ${record.bestiary.creature}${book}`);
  }
  const others = record.absorbed.filter((variant) => variant.trim() !== '');
  if (others.length > 0) lines.push(`Also written as: ${others.join(', ')}`);
  return lines.join('\n');
}
