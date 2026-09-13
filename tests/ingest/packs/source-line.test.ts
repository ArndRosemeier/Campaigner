/**
 * THE `Source:`-line convention, pinned as a DIFFERENTIAL over all four sites.
 *
 * ## Why a differential and not a fold
 *
 * The per-entry `Source:` line exists in four places:
 *
 * | # | site | form |
 * |---|---|---|
 * | 1 | `packs/pf2e-conditions.ts` — exported `publicationSourceLine` | `Source: Title (LICENSE)` |
 * | 2 | `packs/pf2e-rules.ts` — private `publicationSourceLine` (byte-identical to 1, no `export`) | `Source: Title (LICENSE)` |
 * | 3 | `domain/itemData.ts` — inline inside `formatItemText` | `Source: Title (LICENSE)` |
 * | 4 | `packs/pf2e-foundry.ts` — inline, as `extras['Source']` on the StatBlock | `Title (LICENSE)` — the RAW form, no prefix |
 *
 * Three of them feed the chunk `text`, which is what `contentHash = sha256Hex(text)`
 * signs; `resolveMonsterEntry` resolves a citation by uuid and then by EXACT
 * hash, and a bundle export treats an unresolvable citation as BLOCKING. There
 * is **no heal path** — no contentHash re-stamp migration exists (docs/11's L1
 * "same creature, new hash" is deferred). So a fold here is only legitimate
 * with a byte-preservation proof, and docs/12 §15.5 still describes the two
 * copies as carried. docs/17 row 147 therefore landed THIS PIN and left the
 * fold as the owner's call; read that row before folding.
 *
 * ## What the differential is, precisely
 *
 * Sites 1–3 claim the SAME rule, so they must produce the same bytes for every
 * input, and site 4 declares the one LEGITIMATE difference: the same rule with
 * the `Source: ` prefix removed. Both halves are asserted, as data.
 *
 * Sites 1 and 2 are read from the REAL implementations. Sites 3 and 4 are
 * TRANSCRIBED here, because one is inline inside `formatItemText` and the other
 * inline inside `mapNpc` — there is no exported symbol to import. That
 * transcription is the point of the pins that follow it: the real-data pins
 * drive the REAL `formatItemText` through the equipment lane and the REAL
 * `foundry-pf2e` adapter through the creature lane, so a change to either
 * inline copy fails a pin over the bytes it actually produces.
 *
 * ## What this file CANNOT prove
 *
 * A textual/differential pin cannot show that a fifth spelling will not be
 * written: a new adapter that writes `doc.system.publication?.title` into a
 * string of its own is a NEW site, and only a source scan over a shape list can
 * see it. And the raw `extras['Source']` form (site 4) has NO fixture carrying
 * a `publication` block for the creature lane (`tests/fixtures/packs/pf2e/
 * wolf.json` stores none), so site 4's real-data path is proven only through
 * the transcription and the declared prefix relation — not through a pf2e
 * creature fixture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatItemText, type ItemData } from '@/domain/itemData';
import { PACK_ADAPTERS } from '@/ingest/packs/registry';
import {
  foundryPf2eConditionsAdapter,
  publicationSourceLine,
} from '@/ingest/packs/pf2e-conditions';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';

const PACKS = join(process.cwd(), 'tests', 'fixtures', 'packs');

type Publication = { readonly title: string; readonly license: string } | null | undefined;

const encoder = new TextEncoder();

function adapter(id: string) {
  const found = PACK_ADAPTERS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no adapter ${id}`);
  return found;
}

/** Every `Source: …` line of a chunk text, verbatim (the prefix INCLUDED). */
function sourceLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('Source: '));
}

// --- The four sites, as callables ------------------------------------------

/** SITE 1 — the exported rule (`pf2e-conditions.ts`), read from the real module. */
const siteConditionsExported = (publication: Publication): string | null =>
  publicationSourceLine(publication);

/**
 * SITE 2 — the private rule (`pf2e-rules.ts`): returned by the REAL adapter
 * below, never transcribed, so this half is measured end to end.
 */
async function siteRulesAdapter(publication: Publication): Promise<string | null> {
  const doc = {
    name: 'Probe',
    type: 'feat',
    system: {
      description: { value: '' },
      ...(publication === undefined ? {} : { publication }),
    },
  };
  const parsed = await foundryPf2eRulesAdapter.parseFile(
    'packs/pf2e/feats/probe.json',
    encoder.encode(JSON.stringify(doc)),
  );
  return sourceLines(parsed.sections?.[0]?.text ?? '')[0] ?? null;
}

/** SITE 3 — the inline rule in `domain/itemData.formatItemText`, end to end. */
function siteItemDataInline(publication: Publication): string | null {
  const item: ItemData = {
    system: 'pathfinder2e',
    category: 'consumable',
    level: null,
    priceDisplay: '—',
    priceCp: null,
    rarity: '',
    traits: [],
    rulesEdition: null,
    ...(publication === undefined ? {} : { publication }),
  };
  return sourceLines(formatItemText(item, ''))[0] ?? null;
}

/**
 * SITE 4 — the inline RAW form in `pf2e-foundry.mapNpc`, transcribed because it
 * is not exported (see the header). Its relation to the prefixed form is
 * asserted below, and its real-data path is the StatBlock's `extras.Source`.
 */
function siteFoundryRaw(publication: Publication): string | null {
  const pubTitle = publication?.title.trim() ?? '';
  const pubLicense = publication?.license.trim() ?? '';
  if (pubTitle !== '' || pubLicense !== '') {
    return pubTitle === '' ? pubLicense : `${pubTitle}${pubLicense === '' ? '' : ` (${pubLicense})`}`;
  }
  return null;
}

/** The ONE rule, stated as the differential's reference point. */
function expected(publication: Publication): string | null {
  if (publication === undefined || publication === null) return null;
  const title = publication.title.trim();
  const license = publication.license.trim();
  if (title === '' && license === '') return null;
  if (title === '') return `Source: ${license}`;
  return `Source: ${title}${license === '' ? '' : ` (${license})`}`;
}

/**
 * The six edge shapes the audit named: title-only / license-only / both /
 * neither, with and without a publication object at all.
 */
const EDGES: readonly { readonly label: string; readonly publication: Publication }[] = [
  { label: 'title-only', publication: { title: 'GM Core', license: '' } },
  { label: 'license-only', publication: { title: '', license: 'ORC' } },
  { label: 'both', publication: { title: 'Pathfinder Player Core', license: 'ORC' } },
  { label: 'neither (empty strings)', publication: { title: '', license: '' } },
  { label: 'null publication', publication: null },
  { label: 'publication absent (undefined)', publication: undefined },
];

// --- The differential ------------------------------------------------------

describe('the Source: line: one rule, four sites, declared differences as data', () => {
  it('the three PREFIXED sites agree with each other on all six edge shapes', async () => {
    for (const { label, publication } of EDGES) {
      const exported = siteConditionsExported(publication);
      const rules = await siteRulesAdapter(publication);
      const itemData = siteItemDataInline(publication);
      expect(exported, `${label}: conditions vs the rule`).toBe(expected(publication));
      expect(rules, `${label}: rules (real adapter) vs the rule`).toBe(expected(publication));
      expect(itemData, `${label}: itemData inline vs the rule`).toBe(expected(publication));
    }
  });

  it('the two publicationSourceLine copies are byte-identical for EVERY input tested', async () => {
    // Site 2 is driven through its real adapter, so this is not a body diff.
    for (const { label, publication } of EDGES) {
      expect(await siteRulesAdapter(publication), label).toBe(
        siteConditionsExported(publication),
      );
    }
  });

  it('the raw extras form is the SAME rule with the `Source: ` prefix removed — the one declared difference', () => {
    for (const { label, publication } of EDGES) {
      const prefixed = expected(publication);
      const raw = siteFoundryRaw(publication);
      if (prefixed === null) {
        // "Neither" and "absent" render NOTHING on both sides: no `Source: `
        // placeholder, which is the AGENTS rule 1 half of the rule.
        expect(raw, label).toBeNull();
        continue;
      }
      expect(raw, label).toBe(prefixed.replace(/^Source: /, ''));
      // And the prefix is the ONLY difference — never a different separator or
      // a dropped license.
      expect(`Source: ${raw ?? ''}`, label).toBe(prefixed);
    }
  });

  it('renders nothing at all when the publication is empty or absent', async () => {
    for (const publication of [null, undefined, { title: '', license: '' }]) {
      expect(siteConditionsExported(publication)).toBeNull();
      expect(await siteRulesAdapter(publication)).toBeNull();
      expect(siteItemDataInline(publication)).toBeNull();
      expect(siteFoundryRaw(publication)).toBeNull();
    }
  });
});

// --- The REAL fixtures, through the REAL adapters --------------------------

describe('the Source: line on the real corpus — the bytes a citation hashes', () => {
  it('conditions, rules and equipment carry the SAME rendered line for one publication', async () => {
    const publication = { title: 'Pathfinder Player Core', license: 'ORC' };
    expect(publicationSourceLine(publication)).toBe('Source: Pathfinder Player Core (ORC)');

    // The real conditions fixtures: the line is the section's OWN last line.
    for (const name of ['blinded.json', 'frightened.json']) {
      const parsed = await foundryPf2eConditionsAdapter.parseFile(
        name,
        new Uint8Array(readFileSync(join(PACKS, 'pf2e-conditions', name))),
      );
      expect(parsed.failures, name).toEqual([]);
      const text = parsed.sections?.[0]?.text ?? '';
      expect(text.endsWith('\nSource: Pathfinder Player Core (ORC)'), name).toBe(true);
      expect(sourceLines(text), name).toHaveLength(1);
    }

    // The real rules fixtures, through the rules lane (site 2's real body).
    for (const name of ['acid-splash.json', 'aid.json', 'armor-proficiency.json', 'cat-fall.json']) {
      const parsed = await foundryPf2eRulesAdapter.parseFile(
        `packs/pf2e/${name}`,
        new Uint8Array(readFileSync(join(PACKS, 'pf2e-rules', name))),
      );
      expect(parsed.failures, name).toEqual([]);
      const text = parsed.sections?.[0]?.text ?? '';
      expect(sourceLines(text), name).toHaveLength(1);
      expect(sourceLines(text)[0], name).toBe(publicationSourceLine(
        name === 'acid-splash.json'
          ? { title: 'Pathfinder Core Rulebook', license: 'OGL' }
          : { title: 'Pathfinder Player Core', license: 'ORC' },
      ));
    }

    // The item lane, through `formatItemText` (site 3's real body).
    const parsed = await adapter('foundry-pf2e-equipment').parseFile(
      'longsword.json',
      new Uint8Array(readFileSync(join(PACKS, 'pf2e-equipment', 'longsword.json'))),
    );
    expect(parsed.failures).toEqual([]);
    expect(sourceLines(parsed.items?.[0]?.text ?? '')).toEqual([
      'Source: Pathfinder Player Core (ORC)',
    ]);
  });

  it('a second real publication (the Lost Omens title) travels the same path', async () => {
    const parsed = await adapter('foundry-pf2e-equipment').parseFile(
      'anointing-oil.json',
      new Uint8Array(readFileSync(join(PACKS, 'pf2e-equipment', 'anointing-oil.json'))),
    );
    expect(parsed.failures).toEqual([]);
    expect(sourceLines(parsed.items?.[0]?.text ?? '')).toEqual([
      'Source: Pathfinder Lost Omens Knights of Lastwall (OGL)',
    ]);
  });

  it('the creature lane stores the RAW form on the StatBlock, and the pf2e fixtures carry no publication', async () => {
    // NON-VACUITY, stated: the creature lane's site 4 has no fixture with a
    // publication block, so this asserts what IS true of the real fixture —
    // no `Source` extra at all — rather than pretending the raw path is
    // exercised by data. The declared prefix relation above is what carries
    // that half.
    const parsed = await adapter('foundry-pf2e').parseFile(
      'wolf.json',
      new Uint8Array(readFileSync(join(PACKS, 'pf2e', 'wolf.json'))),
    );
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.extras.Source).toBeUndefined();
  });
});
