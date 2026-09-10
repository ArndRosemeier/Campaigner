import { artifactRepo } from '@/db';
import { isMobArtifact } from '@/db/mobArtifacts';
import type { AnyArtifact, Id } from '@/domain';

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
 * Every seam that must classify a creature row reads THIS module, and nothing
 * else classifies one (the list is not a count — a new reader is added here, so
 * a number in this comment can never go stale):
 * - the artifact editor disables its AI action for such a row, with the reason
 *   in `title` (never a silently dead control) and the remedy in the copy;
 * - the entity paths refuse to rename, re-scope or write onto one
 *   (`features/modules/entity-batch`), failing loudly with the reason;
 * - the artifact editor reports authored text already sitting on one and
 *   offers the explicit repair below, which clears ONLY that text;
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

/** «Name» — the house quoting convention for a named row in user-facing copy. */
export function creatureLabel(name: string): string {
  return `«${name}»`;
}

/** "summary, body and appearance" — an honest field list for the report. */
export function creatureRowFieldList(fields: readonly CreatureRowAuthoredField[]): string {
  const labels = fields.map((field) => CREATURE_ROW_FIELD_LABELS[field]);
  if (labels.length === 0) return 'no fields';
  if (labels.length === 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

/**
 * The honest reason the campaign AI actions refuse a bestiary creature row —
 * rendered as the artifact editor section's copy AND its disabled button's
 * `title` (the house convention: a disabled control always says why), and the
 * wording the entity paths' loud refusals reuse.
 */
export function creatureRowAiRefusal(name: string): string {
  return `${creatureLabel(name)} is a bestiary creature, not an authored NPC: ONE shared row per rulebook creature, cited by every encounter that uses it, and its content comes from the rulebook stat block and its portrait. A smith persona writing summary, body and details here would describe some other character in text every citing encounter shares. Generate the module's own NPC of this name from the entity panel instead — that artifact is where authored detail belongs.`;
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
  const next = await artifactRepo.updateArtifact(
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
