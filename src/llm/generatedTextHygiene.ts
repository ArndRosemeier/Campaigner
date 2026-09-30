import {
  collectTextLeaves,
  debrisIssuesForFields,
  type DebrisScanField,
} from '@/lib/encodingHygiene';
import { findScaffoldingEcho } from '@/llm/promptScaffolding';
import type { RejectionReason } from '@/llm/rejectionReason';

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
 *
 * THE SCAN ALSO NAMES ITS CLASSES (docs/17 row 152). The two halves are TWO
 * rejection classes — `escape-debris` and `scaffolding-echo` — so the scan
 * returns which of them produced the issues it reports, decided by the half
 * that produced them. A boundary that persists the refusal (runEngine's
 * finalize) records them on the rejected step, and the engine's sentence then
 * says what actually happened instead of claiming a JSON defect. This is NOT a
 * second classifier: the class travels with the issues from the detector,
 * never reconstructed from their text.
 */
export interface GeneratedTextScan {
  /** The named issues, debris first then scaffolding echoes (the historic
   * order — unchanged). */
  readonly issues: string[];
  /** Which classes are PRESENT in `issues`, in the same order. */
  readonly reasons: RejectionReason[];
}

export function generatedTextScanForFields(
  fields: readonly DebrisScanField[],
  documentFields: readonly DebrisScanField[] = fields,
): GeneratedTextScan {
  const debris = debrisIssuesForFields(fields);
  const echoes = scaffoldingEchoIssues(documentFields);
  return {
    issues: [...debris, ...echoes],
    reasons: [
      ...(debris.length > 0 ? (['escape-debris'] as const) : []),
      ...(echoes.length > 0 ? (['scaffolding-echo'] as const) : []),
    ],
  };
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
 * text), with the identity-owned leaves excluded.
 *
 * WHY THE EXCLUSION, and what it is NOT. A scaffolding echo is a PROSE defect:
 * the sentence we sent was written out as content. Identity keys are not prose
 * and are not this seam's business — an artifact's or module record's OWN
 * `name` is a wiki-link TARGET that resolves by exact string and is governed by
 * the verbatim-name rule itself (a name is never a sentence), a roster
 * monster's `name` is the creature's identity (it becomes the materialized
 * artifact's name and the library-resolution label) and a spell assignment's
 * `name` is a key into the imported spell library (`domain/mobSpells` refuses
 * an unknown name loudly), while `aliases` are additional link targets and
 * `tags`/`suggestedTags`/`id` are filter and reference metadata that no reader
 * ever sees as text. Scanning them would only ever produce issues nobody can
 * act on, and would put this detector's failure next to a field whose contract
 * is a completely different one.
 *
 * WHY THE EXCLUSION IS BY OWNER, NEVER BY KEY SEGMENT (docs/17 row 218). The
 * same key spelling is identity in one owner and PROSE in another: the
 * stat-block named-text collections (`domain/statblockFields.namedTextSchema` —
 * a `traits`/`actions`/`reactions`/`legendary` entry's `name`) render at
 * `features/campaign/components/stat-block.tsx` as the reader-visible heading of
 * a block of rules text, and a location's `pointsOfInterest[].name` renders as a
 * heading in the app and both PDFs — neither is a link target or a resolution
 * key. A bare-last-segment filter dropped every one of them, so a scaffolding
 * sentence echoed into a trait/action NAME reached the reader with nothing
 * checking it: rendered fields outside the detector's field set. The
 * predicate below therefore asks WHO owns the `name` (`identityLeaf`), so the
 * two name kinds are decided by their owner and a future rendered `name` is
 * scanned by DEFAULT instead of falling into the exclusion by spelling.
 *
 * Everything else is checked: `body`, `summary`, `appearance`, `personality`,
 * `concept`, `notes`, `inhabitants`, `pointsOfInterest[].name`/`.description`,
 * `hooks`, `goals`, `methods`, `resources`, `ranks`, `difficulty`,
 * `terrain`, `tactics`, `treasure`, `monsters[].notes`/`treasure`, stat-block
 * prose leaves, the spine's `premise`/`themes`/`partPlan[]` text, a part's
 * whole markdown.
 */
export function documentTextFields(value: unknown, base: string): DebrisScanField[] {
  return collectTextLeaves(value, base).filter((field) => !identityLeaf(field.field));
}

/** Metadata keys whose text is identity, never reader-visible prose. */
const IDENTITY_KEYS = new Set(['aliases', 'tags', 'suggestedTags', 'id']);

/**
 * The object collections whose `name` is an identity, not prose: a roster
 * entry's name is the creature's own, and a spell assignment's name is a key
 * into the imported spell library. The walked record's OWN name is identity by
 * the root rule in `identityLeaf`. EVERY other `name` leaf is prose — the
 * stat-block named-text entries and a location's points of interest among them —
 * so a new rendered `name` is scanned by DEFAULT and only a genuinely
 * identity-bearing owner is added here, deliberately.
 */
const IDENTITY_NAME_OWNERS = new Set(['monsters', 'spells']);

/**
 * THE leaf-path predicate behind `documentTextFields` (docs/17 row 218): is
 * this leaf an artifact/module identity, or text a reader reads?
 *
 * `aliases`/`tags`/`suggestedTags`/`id` are identity wherever they appear. A
 * `name` is identity only when a record OWNS it: the walked record itself
 * (`<base>.name` — the artifact/module name a wiki-link resolves against) or an
 * entry of `IDENTITY_NAME_OWNERS`. Every other `name` — a trait/action name, a
 * point of interest, an `extras` value keyed `name` — is prose and is scanned.
 */
function identityLeaf(path: string): boolean {
  const segment = lastPathSegment(path);
  if (segment !== 'name') return IDENTITY_KEYS.has(segment);
  const dot = path.lastIndexOf('.');
  const parent = dot === -1 ? '' : path.slice(0, dot);
  // The walker's base is ONE segment (`draft`, `spine`, `statBlock`), so a
  // parent with no further dot is the walked record's own name.
  if (!parent.includes('.')) return true;
  return IDENTITY_NAME_OWNERS.has(lastPathSegment(parent));
}

/** The last dotted segment of a leaf path, with any `[n]` array index removed
 * (`draft.monsters[2].name` → `name`). */
function lastPathSegment(path: string): string {
  const segment = path.slice(path.lastIndexOf('.') + 1);
  return segment.replace(/\[\d+\]$/, '');
}
