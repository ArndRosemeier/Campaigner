import { describe, expect, it } from 'vitest';

import {
  anyArtifactSchema,
  createArtifact,
  createModule,
  moduleSchema,
  newId,
  type AnyArtifact,
  type Id,
  type Module,
} from '@/domain';
import { resolveWikiLink } from '@/lib/wikilinks';
import {
  computeCampaignGrounding,
  detectCampaignEntities,
  GROUNDING_EXCERPT_CAP,
  GROUNDING_SECTION_BUDGET,
  GROUNDING_SECTION_HEADER,
  GROUNDING_SUMMARY_SOURCE,
  renderCampaignGroundingSection,
  renderExpansionBlock,
  validateExpansionSources,
  type ExpansionExcerpt,
} from '@/llm/campaignGrounding';

/**
 * Campaign grounding (15-GRAPH-RETRIEVAL): mechanical entity detection in the
 * run brief against the reader pool, top-1 co-mention expansion through the
 * derived wiki-link graph, bounded deterministic excerpt blocks (ratified
 * moderate budget) and the byte-stable section rendering the draft re-renders
 * from the stored retrieve output.
 */

const campaignId = newId();

function moduleWith(input: {
  title?: string;
  premise?: string;
  parts?: { planIndex: number; markdown: string }[];
}): Module {
  const draft = createModule({
    campaignId,
    title: input.title ?? 'Ashen Vault',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...draft,
    title: input.title ?? draft.title,
    spine: {
      premise: input.premise ?? '',
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: (input.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
  });
}

function artifact(input: {
  name: string;
  aliases?: string[];
  summary?: string;
  moduleId?: Id | undefined;
  global?: boolean;
  updatedAt?: number;
}): AnyArtifact {
  const created = createArtifact({
    campaignId,
    ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
    kind: 'npc',
    name: input.name,
    aliases: input.aliases ?? [],
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
  if (input.updatedAt !== undefined) created.updatedAt = input.updatedAt;
  return anyArtifactSchema.parse(
    input.global === true ? { ...created, campaignId: null, moduleId: null } : created,
  );
}

describe('detection (15 §3.1)', () => {
  it('resolves literal wiki-link tokens first, in brief order, to the canonical artifact', () => {
    const alchemist = artifact({ name: 'The Alchemist', aliases: ['Grix'], summary: 'brews.' });
    const vault = artifact({ name: 'Ashen Vault' });
    const brief = 'Set the scene at [[Ashen Vault]], then [[Grix]] arrives.';

    const detected = detectCampaignEntities(brief, [alchemist, vault]);

    expect(detected.map((entry) => entry.name)).toEqual(['Ashen Vault', 'The Alchemist']);
  });

  it('matches bare aliases at word boundaries (case-insensitive)', () => {
    const alchemist = artifact({ name: 'The Alchemist', aliases: ['Grix'], summary: 'brews.' });
    const grixstone = artifact({ name: 'Grixstone' });

    // The alias "grix" matches as its own word…
    expect(detectCampaignEntities('A scene where grix brews.', [alchemist, grixstone]).map((entry) => entry.name)).toEqual([
      'The Alchemist',
    ]);
    // …but never inside another name: "grixstone" alone must not detect the
    // alias-bearing artifact.
    expect(detectCampaignEntities('The grixstone quarry hums.', [alchemist, grixstone]).map((entry) => entry.name)).toEqual([
      'Grixstone',
    ]);
  });

  it('consumes the longest match\'s span: a shorter spelling inside it detects nothing', () => {
    const short = artifact({ name: 'Ember', summary: 'a spark.' });
    const long = artifact({ name: 'Ember Council', summary: 'the council.' });

    // One occurrence, two candidate artifacts: the longest match wins the
    // rank AND claims its span — 'Ember' inside "Ember Council" is consumed,
    // so exactly ONE artifact detects (span exclusivity, 15 §3.1).
    const detected = detectCampaignEntities('The Ember Council convenes tonight.', [short, long]);

    expect(detected.map((entry) => entry.name)).toEqual(['Ember Council']);
  });

  it('still detects a shorter spelling at an occurrence outside the consumed span', () => {
    const short = artifact({ name: 'Ember', summary: 'a spark.' });
    const long = artifact({ name: 'Ember Council', summary: 'the council.' });

    // Span exclusivity is per occurrence, not per brief: the standalone
    // "Ember" after the consumed "Ember Council" span is a real mention.
    const detected = detectCampaignEntities(
      'The Ember Council convenes tonight; Ember departs.',
      [short, long],
    );

    expect(detected.map((entry) => entry.name)).toEqual(['Ember Council', 'Ember']);
  });

  it('breaks an alias-of-A == name-of-B spelling tie deterministically by artifact id, never by pool order', () => {
    const viaAlias = artifact({ name: 'Pyre Wraith', aliases: ['Ember'], summary: 'a wraith.' });
    const viaName = artifact({ name: 'Ember', summary: 'a spark.' });
    // The two spellings are the same string: equal length, equal
    // localeCompare — the artifact-id tie-break (the spellings sort) decides
    // which one claims the shared span; the loser's only occurrence is
    // consumed, so exactly ONE of the two detects.
    const expected = viaAlias.id.localeCompare(viaName.id) <= 0 ? viaAlias : viaName;

    const first = detectCampaignEntities('Ember rises.', [viaAlias, viaName]);
    const second = detectCampaignEntities('Ember rises.', [viaName, viaAlias]); // pool order flipped

    expect(first.map((entry) => entry.id)).toEqual([expected.id]);
    expect(second.map((entry) => entry.id)).toEqual([expected.id]);
  });

  it('caps detection at 3 entities (token hits first, then word matches longest-first)', () => {
    const zora = artifact({ name: 'Zora' });
    const long = artifact({ name: 'Very Long Named Entity' });
    const alia = artifact({ name: 'Alia' });
    const bex = artifact({ name: 'Bex' });

    const detected = detectCampaignEntities(
      '[[Alia]] then Bex, Zora and the Very Long Named Entity appear.',
      [zora, long, alia, bex],
    );

    expect(detected).toHaveLength(3);
    expect(detected.map((entry) => entry.name)).toEqual(['Alia', 'Very Long Named Entity', 'Zora']);
  });

  it('detects each artifact at most once and skips phantoms', () => {
    const grix = artifact({ name: 'Grix' });

    const detected = detectCampaignEntities(
      '[[Grix]] and Grix again; [[Unrecorded Name]] stays a phantom.',
      [grix],
    );

    expect(detected).toHaveLength(1);
    expect(detected[0]?.name).toBe('Grix');
  });

  it('resolves without a moduleId: module-tier shadowing must not redirect detection', () => {
    const moduleId = newId();
    const moduleOwned = artifact({
      name: 'Bell',
      moduleId,
      updatedAt: 1000, // older — would win only with the module context (tier 0)
    });
    const campaignOwned = artifact({ name: 'Bell', updatedAt: 2000 });
    const brief = 'It tolls for [[Bell]].';

    // Contrast: WITH the module context the module-owned row would win (tier 0).
    expect(
      resolveWikiLink('Bell', [moduleOwned, campaignOwned], { moduleId }).artifact?.id,
    ).toBe(moduleOwned.id);

    const detected = detectCampaignEntities(brief, [moduleOwned, campaignOwned]);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.id).toBe(campaignOwned.id);
    expect(detected[0]?.moduleId).toBeNull();
  });
});

describe('expansion (15 §3.2 — co-mention only)', () => {
  it('expands the detected entity with its top-1 co-mention from the shared module hub', () => {
    const grix = artifact({ name: 'Grix' });
    const cult = artifact({ name: 'Ashen Cult' });
    const wren = artifact({ name: 'Wren' });
    const module = moduleWith({
      premise:
        '[[Grix]] guards the door. [[Wren]] scouts ahead. The [[Ashen Cult]] sings, the [[Ashen Cult]] chants.',
    });

    const result = computeCampaignGrounding({
      brief: 'A scene with [[Grix]] and the cult.',
      modules: [module],
      pool: [grix, cult, wren],
    });

    expect(result.map((block) => block.entityName)).toEqual(['Grix', 'Ashen Cult']);
    expect(result[0]?.source).toBe('Ashen Vault — Premise');
    // Wiki tokens stay intact in the excerpt (surroundingParagraphs).
    expect(result[0]?.text).toContain('[[Grix]] guards the door');
    // Weight-ranked: the Cult (×2 in the shared document) beats Wren (×1).
    expect(result[1]?.entityName).toBe('Ashen Cult');
    expect(result[1]?.text).toContain('chants');
  });

  it('expands to a phantom co-mention: an unresolved name grounds its real module prose', () => {
    const grix = artifact({ name: 'Grix' });
    // Vaelthorne resolves to nothing (absent from the pool) — a phantom node
    // — but the derived graph still records its mentions, and co-mention
    // expansion consumes them through the same module-excerpt path.
    const module = moduleWith({
      premise: '[[Grix]] guards the door. [[Vaelthorne]] watches. [[Vaelthorne]] waits.',
    });

    const result = computeCampaignGrounding({
      brief: 'A scene with [[Grix]].',
      modules: [module],
      pool: [grix],
    });

    // Grix's top-1 co-mention is the phantom (weight 2, self excluded); the
    // block carries the phantom's first-seen spelling and its real prose.
    expect(result.map((block) => block.entityName)).toEqual(['Grix', 'Vaelthorne']);
    expect(result[1]?.source).toBe('Ashen Vault — Premise');
    expect(result[1]?.moduleId).toBe(module.id);
    expect(result[1]?.text).toContain('[[Vaelthorne]] watches');
  });

  it('breaks weight ties deterministically by label, then key', () => {
    const hub = artifact({ name: 'Hub' });
    const amy = artifact({ name: 'Amy' });
    const zed = artifact({ name: 'Zed' });
    const module = moduleWith({ premise: '[[Hub]] leads [[Amy]] and [[Zed]].' });
    const input = {
      brief: 'Everything revolves around Hub.',
      modules: [module],
      pool: [hub, amy, zed],
    };

    const result = computeCampaignGrounding(input);

    expect(result.map((block) => block.entityName)).toEqual(['Hub', 'Amy']);
    // Deterministic: same inputs → same section.
    expect(computeCampaignGrounding(input)).toEqual(result);
  });

  it('sums shared-edge weight across the documents the entities share', () => {
    const grix = artifact({ name: 'Grix' });
    const cult = artifact({ name: 'Ashen Cult' });
    const wren = artifact({ name: 'Wren' });
    // The Cult is co-mentioned with Grix in part-0 (×2), Wren with Grix in the
    // premise (×1) — the higher shared weight ranks the Cult first.
    const module = moduleWith({
      premise: '[[Grix]] and [[Wren]] meet.',
      parts: [
        { planIndex: 0, markdown: 'The [[Ashen Cult]] gathers. The [[Ashen Cult]] waits near [[Grix]].' },
      ],
    });

    const result = computeCampaignGrounding({
      brief: 'A scene with Grix.',
      modules: [module],
      pool: [grix, cult, wren],
    });

    expect(result[0]?.entityName).toBe('Grix');
    expect(result[1]?.entityName).toBe('Ashen Cult');
    expect(result[1]?.source).toBe('Ashen Vault — Part 1');
  });

  it('renders part provenance with the reader numbering (planIndex + 1)', () => {
    const grix = artifact({ name: 'Grix' });
    const module = moduleWith({
      premise: 'Intro prose.',
      parts: [{ planIndex: 0, markdown: '[[Grix]] brews by the forge.' }],
    });

    const result = computeCampaignGrounding({
      brief: 'A scene with [[Grix]].',
      modules: [module],
      pool: [grix],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('Ashen Vault — Part 1');
    expect(result[0]?.moduleId).toBe(module.id);
    expect(result[0]?.where).toBe('part-0');
    expect(result[0]?.text).toContain('brews by the forge');
  });

  it('grounds an entity mentioned nowhere in prose from its artifact summary', () => {
    const merchant = artifact({ name: 'Salt Merchant', summary: 'Sells salt by the docks.' });
    const module = moduleWith({ premise: 'Nothing mentions the merchant.' });

    const result = computeCampaignGrounding({
      brief: 'A scene with the Salt Merchant.',
      modules: [module],
      pool: [merchant],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe(GROUNDING_SUMMARY_SOURCE);
    expect(result[0]?.text).toBe('Sells salt by the docks.');
    expect(result[0]?.moduleId).toBeUndefined();
  });

  it('produces no block for an entity with neither mentions nor summary, and no section for zero detections or no modules', () => {
    const silent = artifact({ name: 'Silent Stranger', summary: '' });
    const module = moduleWith({ premise: 'Quiet prose.' });
    expect(
      computeCampaignGrounding({ brief: 'The Silent Stranger waits.', modules: [module], pool: [silent] }),
    ).toEqual([]);
    expect(
      computeCampaignGrounding({ brief: 'Nothing detectable here.', modules: [module], pool: [silent] }),
    ).toEqual([]);
    expect(computeCampaignGrounding({ brief: '[[Grix]] anywhere.', modules: [], pool: [silent] })).toEqual([]);
  });
});

describe('budget and rendering (15 §3.3/§3.4)', () => {
  /** 3 detected entities × (self + top-1 co-mention) = 6 long blocks whose
   * untruncated rendering provably exceeds the 4000-char section budget. */
  function longBlockSetup(): { modules: Module[]; pool: AnyArtifact[]; brief: string } {
    const name = (label: string): string => `${label} ${'uncommonlylongname'.repeat(4)}`;
    const entities = ['Entity A', 'Entity B', 'Entity C'].map((label) =>
      artifact({ name: name(label), summary: 'short summary' }),
    );
    const companions = ['Companion A', 'Companion B', 'Companion C'].map((label) =>
      artifact({ name: name(label), summary: 'short summary' }),
    );
    const prose = (a: string, b: string): string =>
      `[[${a}]] paces the vault. [[${b}]] watches from the gallery. ${'Extra module prose pushing the excerpt past the per-block cap. '.repeat(12)}`;
    // One module per (entity, companion) pair: each detected entity's only
    // co-mention is its companion, so the six blocks are distinct.
    const modules = entities.map((entity, index) => {
      const companion = companions[index];
      if (companion === undefined) throw new Error('test setup bug');
      return moduleWith({
        title: 'A Module Title Long Enough To Stretch Provenance',
        premise: prose(entity.name, companion.name),
      });
    });
    return {
      modules,
      pool: [...entities, ...companions],
      brief: `A scene with ${entities.map((entity) => entity.name).join(', ')}.`,
    };
  }

  it('renders at most 6 blocks, each capped, within the 4000-char section budget', () => {
    const result = computeCampaignGrounding(longBlockSetup());

    expect(result).toHaveLength(6);
    for (const block of result) {
      expect(block.text.length).toBeLessThanOrEqual(GROUNDING_EXCERPT_CAP + 1); // cap + ellipsis
    }
    const section = renderCampaignGroundingSection(result);
    expect(section.length).toBeLessThanOrEqual(GROUNDING_SECTION_BUDGET);
    expect(section.startsWith(GROUNDING_SECTION_HEADER)).toBe(true);
  });

  it('truncates deterministically: overflow cuts the last block into the remaining room and stops', () => {
    // Same inputs (this exact setup object) → same blocks.
    const setup = longBlockSetup();
    const first = computeCampaignGrounding(setup);
    const second = computeCampaignGrounding(setup);
    expect(first).toEqual(second);

    const section = renderCampaignGroundingSection(first);
    expect(section.length).toBeLessThanOrEqual(GROUNDING_SECTION_BUDGET);
    // The first five blocks are per-block-capped excerpts rendered verbatim…
    const kept = first.slice(0, -1);
    expect(kept).toHaveLength(5);
    for (const block of kept) {
      expect(block.text.length).toBe(GROUNDING_EXCERPT_CAP + 1);
      expect(section).toContain(`- ${block.entityName} (${block.source}):\n${block.text}`);
    }
    // …and the LAST block was cut by the SECTION budget (shorter than a
    // per-block-capped excerpt, ending with the truncation ellipsis).
    const last = first[first.length - 1];
    expect(last?.text.length).toBeLessThan(GROUNDING_EXCERPT_CAP);
    expect(last?.text.endsWith('…')).toBe(true);
  });

  it('drops a block whose rendering alone exceeds the whole budget (maxText <= 0 breaks, no partial block)', () => {
    // The block prefix "- <name> (artifact summary):\n" alone is longer than
    // the 4000-char section budget: the overflow branch computes maxText <= 0
    // and breaks — the block is dropped WHOLE, never truncated into negative
    // space and never rendered as a placeholder.
    const colossus = artifact({
      name: `Colossus ${'of the Endless Name'.repeat(300)}`, // far beyond the budget
      summary: 'Too large to ground.',
    });

    const result = computeCampaignGrounding({
      brief: `The ${colossus.name} appears.`,
      modules: [moduleWith({ premise: 'Quiet prose.' })],
      pool: [colossus],
    });

    expect(result).toEqual([]);
  });

  it('keeps a section that accounts to exactly the 4000-char budget whole; one more char truncates the last block', () => {
    // Three summary-backed self blocks (no co-mentions). Names are 700 chars,
    // summaries 600/600/580: header(45) + (1323+2) + (1323+2) + (1303+2) =
    // 4000 — the third block fills the remaining room EXACTLY.
    const name = (label: string): string => `${label}${'x'.repeat(698)}`; // 700 chars
    const alpha = artifact({ name: name('A1'), summary: 'a'.repeat(600) });
    const beta = artifact({ name: name('B2'), summary: 'b'.repeat(600) });
    const gamma = artifact({ name: name('C3'), summary: 'c'.repeat(580) });
    const setup = {
      brief: `${alpha.name}, ${beta.name} and ${gamma.name} convene.`,
      modules: [moduleWith({ premise: 'Quiet prose.' })],
      pool: [alpha, beta, gamma],
    };
    const accounted = (blocks: readonly ExpansionExcerpt[]): number =>
      GROUNDING_SECTION_HEADER.length +
      blocks.reduce((sum, block) => sum + renderExpansionBlock(block).length + 2, 0);

    const exact = computeCampaignGrounding(setup);
    expect(exact.map((block) => block.entityName)).toEqual([alpha.name, beta.name, gamma.name]);
    // Every block kept verbatim at the boundary — no ellipsis anywhere.
    expect(exact.map((block) => block.text)).toEqual([alpha.summary, beta.summary, gamma.summary]);
    expect(accounted(exact)).toBe(GROUNDING_SECTION_BUDGET);

    // One more char in the last block's summary: it overflows the room by
    // exactly 1 char and is truncated into it (ellipsis) — earlier blocks
    // untouched, the accounted total back at exactly the budget.
    const gammaPlusOne = artifact({ name: gamma.name, summary: 'c'.repeat(581) });
    const overflow = computeCampaignGrounding({ ...setup, pool: [alpha, beta, gammaPlusOne] });
    expect(overflow.slice(0, 2)).toEqual(exact.slice(0, 2));
    expect(overflow[2]?.text.length).toBe(580);
    expect(overflow[2]?.text.endsWith('…')).toBe(true);
    expect(accounted(overflow)).toBe(GROUNDING_SECTION_BUDGET);
  });

  it('renders the block shape "- entity (provenance):" with the excerpt text', () => {
    const grix = artifact({ name: 'Grix', summary: 'Brews volatile stuff.' });
    const module = moduleWith({ premise: '[[Grix]] guards the vault door.' });

    const result = computeCampaignGrounding({
      brief: 'A scene with [[Grix]].',
      modules: [module],
      pool: [grix],
    });

    expect(renderCampaignGroundingSection(result)).toBe(
      [GROUNDING_SECTION_HEADER, `- Grix (Ashen Vault — Premise):\n${result[0]?.text}`].join('\n\n'),
    );
  });

  it('caps a long summary excerpt at the per-block budget', () => {
    const merchant = artifact({ name: 'Salt Merchant', summary: 'Salt. '.repeat(300) });

    const result = computeCampaignGrounding({
      brief: 'A scene with the Salt Merchant.',
      modules: [moduleWith({ premise: 'Quiet prose.' })],
      pool: [merchant],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.text.startsWith('Salt.')).toBe(true);
    expect(result[0]?.text.endsWith('…')).toBe(true);
  });
});

describe('read-time source validation (15 §3.7)', () => {
  it('accepts stored module-backed excerpts whose source document still exists', () => {
    const grix = artifact({ name: 'Grix' });
    const module = moduleWith({ premise: '[[Grix]] guards the vault door.' });
    const result = computeCampaignGrounding({
      brief: 'A scene with [[Grix]].',
      modules: [module],
      pool: [grix],
    });

    expect(() => {
      validateExpansionSources(result, [module]);
    }).not.toThrow();
  });

  it('throws a named error when the referenced module or document vanished', () => {
    const excerpt: ExpansionExcerpt = {
      entityName: 'Grix',
      source: 'Ashen Vault — Premise',
      text: 'Grix guards the vault door.',
      moduleId: '00000000-0000-0000-0000-000000000000',
      where: 'premise',
    };
    expect(() => {
      validateExpansionSources([excerpt], []);
    }).toThrow(/no longer exists/);

    const partExcerpt: ExpansionExcerpt = {
      entityName: 'Grix',
      source: 'Ashen Vault — Part 1',
      text: 'Grix brews.',
      moduleId: newId(),
      where: 'part-0',
    };
    const moduleWithoutParts = moduleWith({ premise: 'Prose without parts.' });
    expect(() => {
      validateExpansionSources([partExcerpt], [moduleWithoutParts]);
    }).toThrow(/no longer exists/);
  });
});
