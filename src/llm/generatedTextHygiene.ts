import {
  collectTextLeaves,
  debrisIssuesForFields,
  type DebrisScanField,
} from '@/lib/encodingHygiene';
import { findScaffoldingEcho } from '@/llm/promptScaffolding';

/**
 * THE boundary scan for model-generated text that is about to be persisted as
 * reader-visible content (docs/17 row 142).
 *
 * TWO MECHANICAL DEFECT CLASSES, ONE CALL. Both are decidable facts about
 * strings we can name, never judgements about prose:
 *
 * 1. **Escape debris** (`lib/encodingHygiene.findEscapeDebris`) — half-formed
 *    unicode escapes in already-decoded text (`Flussmündung` → `Flussm?fcndung`);
 * 2. **Prompt-scaffolding echo** (`llm/promptScaffolding`) — a model echoing
 *    OUR OWN brief sentence back into the document it was asked to write,
 *    which is how the owner's report reached a generated artifact ("The
 *    artifact \"name\" field must be exactly …" printed in his module).
 *
 * Every boundary that persists generated text calls THIS function, so a third
 * class added later cannot be wired into three of four call sites: the scan is
 * one seam and the literals have one source (`promptScaffolding`).
 *
 * `fields` is the whole leaf set the boundary hands the debris half (its
 * historic scope). `documentFields` — the READER-VISIBLE text only, see
 * `documentTextFields` — defaults to `fields`, which is right for the boundaries
 * that scan ONE named string (a part's markdown, a refine's replacement, a chat
 * command's replacement): a caller that passes nothing cannot lose the
 * scaffolding half, because the default is the same text, never an empty list.
 * `runEngine`'s finalize passes both explicitly: debris keeps the effective
 * draft AND the statblock strings, while the scaffolding half reads the
 * document text only.
 */
export function generatedTextIssuesForFields(
  fields: readonly DebrisScanField[],
  documentFields: readonly DebrisScanField[] = fields,
): string[] {
  return [...debrisIssuesForFields(fields), ...scaffoldingEchoIssues(documentFields)];
}

/**
 * One LOUD issue per scaffolding echo, naming the field and the marker that was
 * echoed — the shape the rejected-step review card and the failed-part error
 * card render verbatim. No repair, no placeholder, no stripping.
 */
export function scaffoldingEchoIssues(fields: readonly DebrisScanField[]): string[] {
  const issues: string[] = [];
  for (const { field, text } of fields) {
    for (const hit of findScaffoldingEcho(text)) {
      issues.push(
        `${field} contains our own prompt scaffolding ${hit.label} — the text sent to the model was echoed back as content ("${hit.match}"); refusing to persist it`,
      );
    }
  }
  return issues;
}

/**
 * The string leaves of `value` that end up as text a HUMAN READS in the
 * document (the artifact's body and prose fields, the module's spine/part
 * text), with the identity keys excluded.
 *
 * WHY THE EXCLUSION, and what it is NOT. A scaffolding echo is a PROSE defect:
 * the sentence we sent was written out as content. Identity keys are not prose
 * and are not this seam's business — `name` is a wiki-link TARGET that resolves
 * by exact string and is governed by the verbatim-name rule itself (a name is
 * never a sentence), `aliases` are additional link targets, and
 * `tags`/`suggestedTags`/`id` are filter and reference metadata that no reader
 * ever sees as text. Scanning them would only ever produce issues nobody can
 * act on, and would put this detector's failure next to a field whose contract
 * is a completely different one.
 *
 * Everything else is checked: `body`, `summary`, `appearance`, `personality`,
 * `concept`, `notes`, `inhabitants`, `pointsOfInterest`, `hooks`, `goals`,
 * `methods`, `resources`, `ranks`, `difficulty`, `levelHint`, `terrain`,
 * `tactics`, `treasure`, `monsters[].notes`/`treasure`, stat-block prose leaves,
 * the spine's `premise`/`themes`/`partPlan[]` text, a part's whole markdown.
 */
export function documentTextFields(value: unknown, base: string): DebrisScanField[] {
  return collectTextLeaves(value, base).filter(
    (field) => !IDENTITY_KEYS.has(lastPathSegment(field.field)),
  );
}

/** Keys whose text is identity/metadata, never reader-visible prose. */
const IDENTITY_KEYS = new Set(['name', 'aliases', 'tags', 'suggestedTags', 'id']);

/** The last dotted segment of a leaf path, with any `[n]` array index removed
 * (`draft.monsters[2].name` → `name`). */
function lastPathSegment(path: string): string {
  const segment = path.slice(path.lastIndexOf('.') + 1);
  return segment.replace(/\[\d+\]$/, '');
}
