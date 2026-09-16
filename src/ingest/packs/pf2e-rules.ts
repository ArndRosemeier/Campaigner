import { z } from 'zod';

import {
  spellAreaSchema,
  spellDamageMapSchema,
  spellTraditionSchema,
  type SpellData,
  type SpellHeighteningEntry,
} from '@/domain/spellData';
import { errorMessage } from '@/lib/errors';

import {
  htmlToText,
  isDocumentRecord,
  parseJsonDocs,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} from './text';
import type { PackAdapter, PackFileParse, PackSectionEntry } from './types';

/**
 * `foundry-pf2e-rules` pack adapter (rules-text packs arc, docs/12 §15): the
 * opt-in curated rules corpus from the Foundry VTT PF2e system content
 * ([foundryvtt/pf2e](https://github.com/foundryvtt/pf2e) @ `v14-dev`) —
 * `feats/` (6,284 documents in 7 category folders), `spells/` (1,994 in
 * focus/impossible-spells/rituals/rank folders), `actions/` (574 in 20
 * category folders) and `class-features/` (874, flat or per-class folders).
 * Counts verified 2026-09-07 via a sparse clone of the pinned ref.
 *
 * All four packs share the entity shape (`type: 'feat' | 'spell' | 'action'`
 * — class-feature documents are `type: 'feat'` with
 * `system.category: 'classfeature'`), so ONE adapter parses all of them and
 * the fetch source scopes its listing with `packDirs`. Documents come from
 * NESTED folder layouts (e.g. `feats/skill/level-1/cat-fall.json`,
 * `spells/spells/cantrip/acid-splash.json`): the FOLDER PATH maps into the
 * heading path — the first folder labels the lane's category
 * (`'Feats — Skill'`, `'Spells — Cantrip'`, `'Actions — Basic'`,
 * `'Class Features — Magus'`), deeper folders keep their titled segments,
 * and the document name is always the last element.
 *
 * Field mapping verified against live `v14-dev` documents (Cat Fall, Armor
 * Proficiency, Acid Splash, Aid; fixture tests pin the consumed subset):
 *
 * - `system.description.value` HTML → stripped plain text (@-notation
 *   resolves label-first).
 * - `system.level.value` → the summary line's rank/level; `system.actionType`
 *   renders Action/Reaction/Free Action (a `passive` feat renders no action
 *   word); `system.traits.value` (+ spell `traditions`) → the trait line.
 * - `system.prerequisites.value[].value` → the Prerequisites line.
 * - Spell cast facts (`time`/`range`/`target`/`duration`) → the Cast line.
 * - `system.publication` `{license, remaster, title}` → the trailing
 *   `Source: …` line — per-entry licensing (ORC or OGL) is PRESERVED, not
 *   dropped.
 *
 * Since the spells arc (docs/12 §15, row 181) a `spell` document ALSO emits
 * its structured `spellData` (rank, cantrip, traditions, traits, cast facts,
 * the source's own heightening plus the parsed heightening notes, and
 * publication) on the SAME entry, and the runner persists a `chunkType:
 * 'spell'` RuleChunk. The text above is byte-identical to the pre-arc bytes —
 * it IS the `contentHash`, so changing it would invalidate stored citations.
 */

export const FOUNDRY_PF2E_RULES_ADAPTER_ID = 'foundry-pf2e-rules';

export const FOUNDRY_PF2E_RULES_LICENSE =
  'Pathfinder Second Edition rules text (feats, spells, actions, class ' +
  'features) from the Foundry VTT PF2e system packs (Paizo Inc. via the ' +
  'Foundry Gaming LLC partnership; per-entry licensing ORC or OGL, preserved ' +
  'on each entry\'s Source line). User-imported for personal use under ' +
  'Paizo\'s Community Use Policy — not for redistribution.';

// --- Source schemas (consumed subset of the Foundry document; unknown keys
// are ignored — the document is never re-serialized). ------------------------

const pf2eRulesDocSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  system: z.object({
    description: z.object({ value: z.string().default('') }).default({ value: '' }),
    traits: z
      .object({
        value: z.array(z.string()).default([]),
        rarity: z.string().default('common'),
        traditions: z.array(z.string()).default([]),
      })
      .default({ value: [], rarity: 'common', traditions: [] }),
    level: z.object({ value: z.number() }).nullish(),
    actionType: z.object({ value: z.string() }).nullish(),
    category: z.string().nullish(),
    time: z.object({ value: z.string() }).nullish(),
    range: z.object({ value: z.string() }).nullish(),
    target: z.object({ value: z.string() }).nullish(),
    duration: z.object({ value: z.string() }).nullish(),
    // The source's own damage/area, the numbers the heightening rule adds an
    // interval delta to (ledger 183). Consumed verbatim; unknown keys inside
    // each damage entry (`applyMod`, `kinds`) are dropped by the shared schema,
    // which is the ONE damage-entry shape the payload and the heightening rule
    // both read.
    damage: spellDamageMapSchema.nullish(),
    area: spellAreaSchema.nullish(),
    // The source's own heightening structure — consumed VERBATIM (never
    // normalized) by the spell payload; unknown keys inside it pass through
    // whole, which is the point.
    heightening: z.record(z.string(), z.unknown()).nullish(),
    prerequisites: z
      .object({ value: z.array(z.object({ value: z.string() })).default([]) })
      .nullish(),
    publication: z
      .object({
        title: z.string().default(''),
        license: z.string().default(''),
      })
      .nullish(),
  }),
});

type ParsedRulesDoc = z.infer<typeof pf2eRulesDocSchema>;

// --- Helpers (the journal/conditions adapters' exact text rules; adapters
// stay self-contained per 12-BESTIARY-PACKS §5's precedent) -------------------

/** The per-entry source line — verbatim `publication`, never dropped. */
function publicationSourceLine(
  publication: { title: string; license: string } | null | undefined,
): string | null {
  if (publication === undefined || publication === null) return null;
  const title = publication.title.trim();
  const license = publication.license.trim();
  if (title === '' && license === '') return null;
  if (title === '') return `Source: ${license}`;
  return `Source: ${title}${license === '' ? '' : ` (${license})`}`;
}

function titleCase(slug: string): string {
  return slug
    .split(/[\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Spell rank folders spell out `rank-N`; cantrips are their own folder. */
function folderLabel(slug: string): string {
  const rank = /^rank-(\d+)$/.exec(slug);
  if (rank !== null) return `Rank ${rank[1] ?? ''}`.trim();
  return titleCase(slug);
}

/** Lane labels by pack folder (and by document type for loose manual files). */
const LANE_LABELS: Readonly<Record<string, string>> = {
  feats: 'Feats',
  spells: 'Spells',
  actions: 'Actions',
  'class-features': 'Class Features',
};

/** The document subset the heading derivation consumes. */
export interface HeadingDocLike {
  type: string;
  system: { category?: string | null | undefined };
}

/**
 * The category segments of one document's heading path — the fetch-relative
 * file name's folders map into them and the runner appends the document name
 * as the last element. The lane comes from the pack folder in the file name,
 * with the document type/category as the fallback for loose manual imports;
 * the first category folder rides the lane label (`'Feats — Skill'`), deeper
 * folders become their own titled segments (`'Cantrip'`, `'Rank 1'`,
 * `'Level 1'`). The pack folder itself never repeats as a category
 * (`spells/spells/cantrip/…` → `'Spells — Cantrip'`).
 */
export function headingCategoriesFor(doc: HeadingDocLike, fileName: string): string[] {
  const segments = fileName.split('/');
  const packDir = segments.length >= 2 ? (segments[0] ?? '') : '';
  const isClassFeature = doc.type === 'feat' && doc.system.category === 'classfeature';
  const lane: string =
    LANE_LABELS[packDir] ??
    (isClassFeature
      ? (LANE_LABELS['class-features'] ?? 'Rules')
      : (LANE_LABELS[`${doc.type}s`] ?? 'Rules'));
  // Category folders sit between the pack folder and the document; a folder
  // repeating the pack name (`spells/spells/…`) carries no information.
  const folderSegments = segments
    .slice(1, -1)
    .filter((segment) => segment !== '' && segment !== packDir);
  const categories: string[] = [];
  for (const [index, segment] of folderSegments.entries()) {
    const label = folderLabel(segment);
    categories.push(index === 0 ? `${lane} — ${label}` : label);
  }
  if (categories.length === 0) {
    // Flat pack (class-features) or a loose manual import: the lane alone,
    // suffixed by the document's own category when it adds information.
    const category = doc.system.category ?? '';
    if (category !== '' && category !== 'classfeature') {
      categories.push(`${lane} — ${titleCase(category)}`);
    } else {
      categories.push(lane);
    }
  }
  return categories;
}

const ACTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  action: 'Action',
  reaction: 'Reaction',
  free: 'Free Action',
};

// --- Mapping ---------------------------------------------------------------

function summaryLine(doc: ParsedRulesDoc): string | null {
  const parts: string[] = [];
  if (doc.type === 'spell') {
    const cantrip = doc.system.traits.value.includes('cantrip');
    const rank = doc.system.level?.value;
    parts.push(rank === undefined ? (cantrip ? 'Cantrip' : 'Spell') : `${cantrip ? 'Cantrip' : 'Spell'} ${String(rank)}`);
  } else if (doc.type === 'feat') {
    const level = doc.system.level?.value;
    parts.push(level === undefined ? 'Feat' : `Feat ${String(level)}`);
  } else if (doc.type === 'action') {
    const actionType = doc.system.actionType?.value ?? 'action';
    parts.push(ACTION_TYPE_LABELS[actionType] ?? titleCase(actionType));
  }
  const traits = doc.system.traits.value;
  if (traits.length > 0) parts.push(`(${traits.join(', ')})`);
  if (doc.system.traits.rarity !== 'common') parts.push(doc.system.traits.rarity);
  if (doc.type === 'spell' && doc.system.traits.traditions.length > 0) {
    parts.push(doc.system.traits.traditions.join(', '));
  }
  return parts.length === 0 ? null : parts.join(' ');
}

function castLine(doc: ParsedRulesDoc): string | null {
  if (doc.type !== 'spell') return null;
  const parts = [
    doc.system.time?.value.trim() ?? '',
    doc.system.range?.value.trim() ?? '',
    doc.system.target?.value.trim() ?? '',
    doc.system.duration?.value.trim() ?? '',
  ]
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? `Cast ${part}` : part));
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * A `Heightened (Nth)` heading (an exact rank) or `Heightened (+N)` heading
 * (an interval), as the PF2e corpus writes it. Case-insensitive and
 * whitespace-tolerant; ordinals are `st|nd|rd|th`. Anything that mentions
 * Heightened but does not match is captured unparsed, never dropped.
 */
const HEIGHTENING_HEADING =
  /<strong>\s*Heightened\s*\((?:(\d+)(?:st|nd|rd|th)|([+-]\d+))\)\s*<\/strong>/gi;

/** The description mentions heightening at all (case-insensitive). */
const HEIGHTENING_MENTION = /heightened/i;

/**
 * Parse a spell's heightening notes out of the RAW description HTML, BEFORE it
 * is stripped (the tags are the only place the rank/interval lives). Notes are
 * returned in document order; each note's `text` is the prose between its
 * heading and the next one, stripped by the lane's ONE HTML→text seam. A
 * description that mentions Heightened but matches NEITHER shape yields no
 * entries and its offending raw line(s) in `unparsed` — loud data, not a
 * failure and not a silent drop.
 */
function parseHeighteningEntries(html: string): {
  entries: SpellHeighteningEntry[];
  unparsed: string[];
} {
  const matches = [...html.matchAll(HEIGHTENING_HEADING)];
  const entries: SpellHeighteningEntry[] = [];
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    const text = htmlToText(html.slice(start, end), AT_BRACE_LABEL_BLOCK_AND_TABLE).trim();
    const rank = match[1];
    const increment = match[2];
    if (rank !== undefined) {
      entries.push({ kind: 'fixed', rank: Number(rank), text });
    } else if (increment !== undefined) {
      entries.push({ kind: 'increment', increment: Number(increment), text });
    }
  }
  if (entries.length === 0 && HEIGHTENING_MENTION.test(html)) {
    return {
      entries,
      unparsed: html
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && HEIGHTENING_MENTION.test(line)),
    };
  }
  return { entries, unparsed: [] };
}

/**
 * The structured half of a spell document (docs/12 §15, the spells arc). A
 * cantrip is rank 0 — MEASURED against `v14-dev` (2026-09-16): the corpus
 * stores cantrips at `system.level.value: 1` (the legacy Acid Splash fixture
 * AND the remastered Ignition), so the `cantrip` trait is the only reliable
 * signal and normalizing it gives a list ONE order where cantrips lead. An
 * unknown tradition or a spell with neither signal is a loud per-entry
 * failure, never a silent zero. Heightening is captured as data here (the
 * source's own `system.heightening` verbatim, plus the parsed notes) so a
 * later arc can render a spell at the rank a mob casts it without a second
 * pass over these packs.
 */
function spellDataFor(doc: ParsedRulesDoc): SpellData | null {
  if (doc.type !== 'spell') return null;
  const cantrip = doc.system.traits.value.includes('cantrip');
  const rank = cantrip ? 0 : doc.system.level?.value;
  if (rank === undefined) {
    throw new Error(`spell "${doc.name}" has neither a cantrip trait nor system.level.value`);
  }
  const heightening = parseHeighteningEntries(doc.system.description.value);
  return {
    system: 'pathfinder2e',
    rank,
    cantrip,
    traditions: spellTraditionSchema.array().parse(doc.system.traits.traditions),
    traits: doc.system.traits.value,
    rarity: doc.system.traits.rarity,
    cast: {
      time: doc.system.time?.value.trim() ?? '',
      range: doc.system.range?.value.trim() ?? '',
      target: doc.system.target?.value.trim() ?? '',
      duration: doc.system.duration?.value.trim() ?? '',
    },
    damage: doc.system.damage ?? {},
    area: doc.system.area ?? null,
    heightening: doc.system.heightening ?? null,
    heighteningEntries: heightening.entries,
    heighteningUnparsed: heightening.unparsed,
    publication: doc.system.publication ?? null,
  };
}

function mapRulesDoc(doc: ParsedRulesDoc, fileName: string): PackSectionEntry {
  const lines: string[] = [];
  const summary = summaryLine(doc);
  if (summary !== null) lines.push(summary);
  const cast = castLine(doc);
  if (cast !== null) lines.push(cast);
  const prerequisites = (doc.system.prerequisites?.value ?? [])
    .map((prerequisite) => prerequisite.value.trim())
    .filter((prerequisite) => prerequisite !== '');
  if (prerequisites.length > 0) lines.push(`Prerequisites: ${prerequisites.join('; ')}`);
  const description = htmlToText(doc.system.description.value, AT_BRACE_LABEL_BLOCK_AND_TABLE);
  if (description !== '') lines.push(description);
  const source = publicationSourceLine(doc.system.publication);
  if (source !== null) lines.push(source);
  // The structured half rides the SAME entry; non-spells omit the key so the
  // runner persists the chunk they always got (text byte-identical).
  const spell = spellDataFor(doc);
  return {
    categories: headingCategoriesFor(doc, fileName),
    name: doc.name,
    text: [doc.name, ...lines].join('\n'),
    ...(spell === null ? {} : { spell }),
  };
}

// --- Adapter ---------------------------------------------------------------

const ACCEPTED_TYPES: ReadonlySet<string> = new Set(['feat', 'spell', 'action']);

/** Synchronous parse body — wrapped into a promise by `parseFile`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseJsonDocs(text, fileName);
  const sections: PackSectionEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isDocumentRecord(doc) || typeof doc.type !== 'string' || !ACCEPTED_TYPES.has(doc.type)) {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      sections.push(mapRulesDoc(pf2eRulesDocSchema.parse(doc), fileName));
    } catch (error) {
      failures.push({
        file: fileName,
        name,
        message: `document ${String(index)}: ${errorMessage(error)}`,
      });
    }
  }
  return { entries: [], sections, skipped, failures };
}

function parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse> {
  try {
    return Promise.resolve(parseFileSync(fileName, bytes));
  } catch (error) {
    // Rejections instead of sync throws: the adapter contract is promise-based.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export const foundryPf2eRulesAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_RULES_ADAPTER_ID,
  label: 'PF2e Rules Text — feats 6,284 · spells 1,994 · actions 574 · class features 874 (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_RULES_LICENSE,
  extensions: ['.json', '.db'],
  entryNoun: 'rule',
  parseFile,
};
