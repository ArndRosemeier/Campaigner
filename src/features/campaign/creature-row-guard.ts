import { artifactRepo } from '@/db';
import { isMobArtifact } from '@/db/mobArtifacts';
import type { AnyArtifact, ArtifactPatch, Id } from '@/domain';
import type { RevisionMeta } from '@/db/artifactRepo';

/**
 * Bestiary creature rows may not be authored — and the ONE place that decides
 * it, plus the ONE repair for the rows an unguarded run already polluted.
 *
 * A bestiary creature row is a real `npc` artifact carrying the additive
 * `data.monsterChunkId` marker (`db/mobArtifacts.isMobArtifact`, docs/11 D5):
 * ONE shared row per campaign per cited rulebook chunk, pointed at by every
 * encounter that cites the creature, with battle seeding resolving the
 * creature's stats THROUGH it, and its portrait cached globally. Its name is a
 * wiki-link/roster identity, never an authoring slot.
 *
 * Owner-reported bug this module closes: the artifact editor's
 * "Generate with AI" handed the creature row to a smith persona as an in-place
 * refill target (`runEngine`'s refill branch writes summary + body + the
 * draft's `appearance`/`personality` onto it), and the produced prose
 * described a DIFFERENT character — saved onto the row every encounter shares.
 * The write was silent because nothing distinguished "the row a wiki-link
 * resolves to" from "the row authored detail belongs in". That write is refused
 * now, in the run's finalize and in the refill picker (the last two readers
 * below).
 *
 * THE HAND DOOR (the same defect without a persona): the artifact editor's own
 * autosave persisted whatever the owner typed into the summary, the body or the
 * `npc` fields, so the row could be polluted by hand just as it was by a run.
 * It is shut at the ONE write boundary the editor has —
 * `updateArtifactRefusingCreatureRowAuthored` below — and the authored inputs
 * are read-only on such a row with the reason in place (see the readers list).
 *
 * Every seam that must classify a creature row reads THIS module, and nothing
 * else classifies one (the list is not a count — a new reader is added here, so
 * a number in this comment can never go stale):
 * - the artifact editor disables its AI action for such a row, with the reason
 *   in `title` (never a silently dead control) and the remedy in the copy;
 * - the entity paths refuse to rename, re-scope or write onto one
 *   (`features/modules/entity-batch`), failing loudly with the reason;
 * - the artifact editor reports authored text already sitting on one and
 *   offers the explicit repair below, which clears ONLY that text;
 * - the artifact editor renders the authored inputs (name, aliases, summary,
 *   body, appearance, personality) READ-ONLY on such a row with the honest
 *   reason in place, refuses any write that would change them through the
 *   guarded write boundary, and offers the explicit action that creates this
 *   module's own NPC of that name instead — images and the portrait stay
 *   editable, because a shared bestiary portrait is what the row is for;
 * - the refill destination refuses one at DESTINATION RESOLUTION in
 *   `llm/runEngine`'s finalize — before any branch below can write, so the row
 *   stays byte-identical and the run fails loudly — and the persona panel's
 *   refill picker never offers one (`creatureRowAiRefusal` is the ONE copy both
 *   read; the Illustrator's and the Continuity Editor's pickers keep the full
 *   list);
 * - the module entity view's detailed-entity verdict
 *   (`features/modules/detailed-entity`) reads `creatureLabel` for the message
 *   that names a creature row as not-an-authored-entity.
 *
 * `isMobArtifact` is the whole classification: a kind `npc` WITHOUT the marker
 * (an authored NPC, a module-owned NPC, an on-demand invented creature) is a
 * legitimate entity and stays fully editable and regenerable.
 */

/** Where authored text can land on an artifact: `summary`/`body` on the row,
 * `appearance`/`personality` in an `npc` row's data. Exactly the fields a
 * smith refill writes (runEngine's refill branch) — and the only fields this
 * module ever reports or clears. */
export type CreatureRowAuthoredField = 'summary' | 'body' | 'appearance' | 'personality';

/** Field → the noun the owner reads in the report and the toast. */
export const CREATURE_ROW_FIELD_LABELS: Record<CreatureRowAuthoredField, string> = {
  summary: 'summary',
  body: 'body',
  appearance: 'appearance',
  personality: 'personality',
};

/**
 * Every field of a creature row a HAND write may not author: the four authored
 * text fields above plus the row's IDENTITY — the name and the aliases every
 * wiki-link, roster entry and battle seed resolves through. Same list the
 * editor renders read-only, so the surface and the write boundary can never
 * disagree about what is locked.
 */
export type CreatureRowAuthoredWriteField = CreatureRowAuthoredField | 'name' | 'aliases';

const CREATURE_ROW_WRITE_FIELD_LABELS: Record<CreatureRowAuthoredWriteField, string> = {
  name: 'name',
  aliases: 'aliases',
  summary: 'summary',
  body: 'body',
  appearance: 'appearance',
  personality: 'personality',
};

/** «Name» — the house quoting convention for a named row in user-facing copy. */
export function creatureLabel(name: string): string {
  return `«${name}»`;
}

/** "summary, body and appearance" — an honest field list for the report. */
export function creatureRowFieldList(fields: readonly CreatureRowAuthoredWriteField[]): string {
  const labels = fields.map((field) => CREATURE_ROW_WRITE_FIELD_LABELS[field]);
  if (labels.length === 0) return 'no fields';
  if (labels.length === 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

/**
 * The honest reason the campaign AI actions refuse a bestiary creature row —
 * rendered as the artifact editor section's copy AND its disabled button's
 * `title` (the house convention: a disabled control always says why), and the
 * wording the entity paths' loud refusals reuse.
 *
 * ONE WORDING, ONE SOURCE: `creatureRowIdentityClause` (what the row IS) and
 * `creatureRowRemedyClause` (what to do instead) are the shared sentences every
 * refusal in this module is composed from — the AI refusal, the hand-write
 * refusal, the read-only notice and the entity paths' rename refusal — so a
 * second `creature-row-guard` copy can never say the rule differently.
 */
export function creatureRowIdentityClause(name: string): string {
  return `${creatureLabel(name)} is a bestiary creature, not an authored NPC: ONE shared row per rulebook creature, cited by every encounter that uses it, and its content comes from the rulebook stat block and its portrait.`;
}

/** The remedy half of every refusal — the artifact authored detail belongs on. */
export function creatureRowRemedyClause(): string {
  return `Generate the module's own NPC of this name from the entity panel instead — that artifact is where authored detail belongs.`;
}

export function creatureRowAiRefusal(name: string): string {
  return `${creatureRowIdentityClause(name)} A smith persona writing summary, body and details here would describe some other character in text every citing encounter shares. ${creatureRowRemedyClause()}`;
}

/** The refusal a rename/re-scope of a creature row fails with (entity paths). */
export function creatureRowWriteRefusal(name: string, entityName: string): string {
  return `Refusing to write onto ${creatureLabel(name)}: it is the campaign's shared bestiary creature (an npc artifact carrying the rulebook chunk marker), so it is not the artifact a generation may rename, re-scope or detail. Generate the module's own "${entityName}" entity instead — that row is the one a smith persona may fill.`;
}

/**
 * The authored-text fields a row carries, in report order. PURE and total:
 * a non-creature row has none by definition (a hand-authored NPC's summary and
 * body are the point of that row).
 */
export function creatureRowAuthoredFields(artifact: AnyArtifact): CreatureRowAuthoredField[] {
  if (!isMobArtifact(artifact)) return [];
  const fields: CreatureRowAuthoredField[] = [];
  if (artifact.summary.trim() !== '') fields.push('summary');
  if (artifact.body.trim() !== '') fields.push('body');
  if (artifact.data.appearance.trim() !== '') fields.push('appearance');
  if (artifact.data.personality.trim() !== '') fields.push('personality');
  return fields;
}

/** True when a bestiary creature row carries authored text (corrupt data: the
 * row is shared, so every citing encounter reads it). */
export function isPollutedCreatureRow(artifact: AnyArtifact): boolean {
  return creatureRowAuthoredFields(artifact).length > 0;
}

/**
 * The reason a HAND write is refused — the toast and the read-only notice's
 * copy, composed from the same two clauses as `creatureRowAiRefusal`.
 */
export function creatureRowAuthoredWriteRefusal(
  name: string,
  fields: readonly CreatureRowAuthoredWriteField[],
): string {
  return `${creatureRowIdentityClause(name)} A hand-typed change to the ${creatureRowFieldList(fields)} would put authored content on that row, so this save is refused and the row is left exactly as it was. Its portrait and gallery images stay editable — a shared bestiary portrait is what the row is for. ${creatureRowRemedyClause()}`;
}

/** The honest reason rendered IN PLACE beside the read-only authored inputs, so
 * the fields say what is locked and what is still possible. */
export function creatureRowAuthoredReadOnlyNotice(name: string): string {
  return `${creatureRowIdentityClause(name)} Its name, aliases, summary, body, appearance and personality are read-only here, and a write that changed them would be refused rather than saved. Its portrait and gallery images stay editable, and so do its tags, relations and scope — a shared bestiary portrait is what this row is for. ${creatureRowRemedyClause()}`;
}

/** The honest reason rendered beside ONE read-only input, so every locked
 * field says why it is locked in its own `title` (the house convention: a
 * control that refuses input always says why). */
export function creatureRowAuthoredInputReason(
  name: string,
  field: CreatureRowAuthoredWriteField,
): string {
  return `Read-only ${CREATURE_ROW_WRITE_FIELD_LABELS[field]} — ${creatureRowIdentityClause(name)} ${creatureRowRemedyClause()}`;
}

/** The constructive action's label when the row has module context. */
export function creatureRowOwnNpcActionLabel(name: string): string {
  return `Create this module's own NPC ${creatureLabel(name)}`;
}

/** What that action does (and what it leaves alone), rendered beside it. */
export function creatureRowOwnNpcActionHint(name: string): string {
  return `Details ${creatureLabel(name)} as this module's own npc artifact — the row authored text belongs on — and opens it. The shared creature row keeps its rulebook source and its portrait, unchanged.`;
}

/** The honest remedy where NO module context exists: the editor cannot create a
 * module-owned NPC from here, and it says exactly where that happens. */
export function creatureRowNoModuleContextNotice(name: string): string {
  return `This creature row belongs to no module, so there is nothing here to create an NPC in. Open the module whose text names ${creatureLabel(name)} (Modules → the module → its entity panel) and generate that name there: the per-name Generate creates the module's own NPC of this name, which is the artifact authored detail belongs on.`;
}

/**
 * A creature-row authored write, refused. Loud by construction (AGENTS rules
 * 1/2): the write boundary THROWS — it never returns a "skipped" result a
 * caller could ignore — and it carries the untouched row so the surface that
 * attempted the write can show the truth immediately without a second read.
 */
export class CreatureRowAuthoredWriteError extends Error {
  /** The row as it stands (byte-identical to before the attempt). */
  readonly row: AnyArtifact;
  /** The fields the attempted write would have changed. */
  readonly fields: readonly CreatureRowAuthoredWriteField[];

  constructor(
    message: string,
    row: AnyArtifact,
    fields: readonly CreatureRowAuthoredWriteField[],
  ) {
    super(message);
    this.name = 'CreatureRowAuthoredWriteError';
    this.row = row;
    this.fields = fields;
  }
}

/** A blank string is the row's BIRTH state (`getOrCreateMobArtifact` creates
 * `appearance: ''`/`personality: ''` and no summary), so reducing an authored
 * field to blank is a restore; writing anything else into it is authoring. */
function authoredTextChanged(current: string, next: string | undefined): boolean {
  if (next === undefined || next === current) return false;
  return next.trim() !== '';
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The two authored text fields an `npc` patch's `data` carries, or null when
 * the patch brings no `npc` data (a stat-block- or image-only write). */
function authoredTextPair(
  data: ArtifactPatch['data'],
): { appearance: string; personality: string } | null {
  if (data === undefined) return null;
  if (!('appearance' in data) || !('personality' in data)) return null;
  return { appearance: data.appearance, personality: data.personality };
}

/**
 * The authored fields `patch` would CHANGE on `row`, in report order — the ONE
 * change detector behind the write boundary, PURE and total (`[]` for a
 * non-creature row, which is fully writable by definition).
 *
 * The repair and authoring are distinguished INTRINSICALLY, never by a caller
 * flag: reducing summary/body/appearance/personality to blank is the row's
 * birth state and is allowed (that is exactly what
 * `clearCreatureRowAuthoredContent` does), while writing content into one is
 * refused. Name and aliases are the row's IDENTITY — every wiki-link, roster
 * entry and battle seed resolves through them — so any change to them is
 * refused, and the repair never touches them.
 */
export function creatureRowAuthoredWriteFields(
  row: AnyArtifact,
  patch: ArtifactPatch,
): CreatureRowAuthoredWriteField[] {
  if (!isMobArtifact(row)) return [];
  const fields: CreatureRowAuthoredWriteField[] = [];
  if (patch.name !== undefined && patch.name !== row.name) fields.push('name');
  if (patch.aliases !== undefined && !sameStrings(patch.aliases, row.aliases)) fields.push('aliases');
  if (authoredTextChanged(row.summary, patch.summary)) fields.push('summary');
  if (authoredTextChanged(row.body, patch.body)) fields.push('body');
  const pair = authoredTextPair(patch.data);
  if (pair !== null && authoredTextChanged(row.data.appearance, pair.appearance)) {
    fields.push('appearance');
  }
  if (pair !== null && authoredTextChanged(row.data.personality, pair.personality)) {
    fields.push('personality');
  }
  return fields;
}

/**
 * THE write boundary for an artifact patch — the ONE path the artifact editor's
 * save funnel takes, so autosave, the form inputs, the blur flush and the
 * unmount flush are all covered by construction rather than by remembering to
 * check at each of them.
 *
 * Why HERE and not inside `db/artifactRepo.updateArtifact`: the classification
 * is `isMobArtifact` (the ONLY predicate — never a second reading of the
 * `monsterChunkId` marker) and the copy is this module's, so a DB-layer check
 * would need `db/**` → `features/**` AND a duplicated marker test, both of
 * which the repo forbids (docs/18 §5's upward-import list; ledger 81's
 * one-classification rule). Everything that must not write authored text on a
 * creature row therefore fails here, in one place, loudly.
 *
 * A non-creature row is delegated untouched — this is a passthrough for every
 * other artifact in the app.
 */
export async function updateArtifactRefusingCreatureRowAuthored(
  artifactId: Id,
  patch: ArtifactPatch,
  meta: RevisionMeta = { source: 'user' },
): Promise<AnyArtifact> {
  // `getAnyArtifact`, never `getArtifact`: the editor also opens LIBRARY
  // (global) rows, and a scope check must not refuse a legitimate save there.
  const row = await artifactRepo.getAnyArtifact(artifactId);
  if (row === undefined) {
    throw new Error(`Cannot save the artifact: artifact ${artifactId} no longer exists`);
  }
  const fields = creatureRowAuthoredWriteFields(row, patch);
  if (fields.length > 0) {
    throw new CreatureRowAuthoredWriteError(
      creatureRowAuthoredWriteRefusal(row.name, fields),
      row,
      fields,
    );
  }
  return artifactRepo.updateArtifact(artifactId, patch, meta);
}

export interface CreatureRowRepairResult {
  /** The repaired row (still the same identity — see the pins in the tests). */
  artifact: AnyArtifact;
  /** The fields actually cleared ([] when there was nothing to clear). */
  cleared: CreatureRowAuthoredField[];
}

/**
 * The repair: clears ONLY the authored text (`summary`, `body`,
 * `data.appearance`, `data.personality`) and leaves the creature's identity
 * alone — name, aliases, tags, links, scope fields, `monsterChunkId` (the stat
 * source), `statBlock`, `coverImageId`, `imageIds` and every other field are
 * carried through verbatim. Empty strings are the row's BIRTH state
 * (`getOrCreateMobArtifact` creates `appearance: ''`, `personality: ''`, no
 * summary), so this restores the creature row rather than inventing a new one.
 *
 * Loud at both ends (AGENTS rules 1/2): a vanished row, a non-creature row and
 * an impossible repair all throw with the reason, and the caller toasts the
 * cleared fields — clearing is never silent. `updateArtifact` writes a
 * revision first, so the cleared text stays restorable in the revision dialog.
 *
 * It writes through the SAME guarded boundary as every other caller
 * (`updateArtifactRefusingCreatureRowAuthored`): the reduction to blank is not
 * an authored change, so the one rule serves the repair and the refusal without
 * a repair-only bypass flag any writer could pass.
 */
export async function clearCreatureRowAuthoredContent(
  artifactId: Id,
): Promise<CreatureRowRepairResult> {
  const row = await artifactRepo.getArtifact(artifactId);
  if (row === undefined) {
    throw new Error(`Cannot clear the authored text: artifact ${artifactId} no longer exists`);
  }
  if (!isMobArtifact(row)) {
    throw new Error(
      `Refusing to clear the authored text on ${creatureLabel(row.name)}: it is not a bestiary creature row (an npc artifact carrying the rulebook chunk marker), so its text is authored content — this repair only ever touches creature rows.`,
    );
  }
  const cleared = creatureRowAuthoredFields(row);
  if (cleared.length === 0) return { artifact: row, cleared: [] };
  const next = await updateArtifactRefusingCreatureRowAuthored(
    artifactId,
    {
      summary: '',
      body: '',
      data: { ...row.data, appearance: '', personality: '' },
    },
    { source: 'user' },
  );
  return { artifact: next, cleared };
}
