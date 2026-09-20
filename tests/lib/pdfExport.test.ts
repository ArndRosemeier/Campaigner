import 'fake-indexeddb/auto';

import type { TDocumentDefinitions } from 'pdfmake/interfaces';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  newId,
  ruleChunkSchema,
  stampNewEntity,
  type Artifact,
} from '@/domain';
import { createArtifact as persistArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { resolveExportRoster } from '@/lib/pdfExport';
import {
  buildGmNotesDefinition,
  buildPlayerHandoutDefinition,
  exportArtifactPdf,
  exportArtifactPdfFile,
  pdfFileName,
} from '@/lib/pdfExport';
import { EXPORT_PDF_TYPES, openSaveTarget } from '@/lib/filePicker';
import * as toast from '@/lib/toast';
import { markdownToDisplayText, markdownToText } from '@/lib/markdown';

/**
 * PDF export (06-MILESTONES M2): GM notes + player handout templates. The
 * definition builders are asserted as content; one test generates a real PDF
 * blob through pdfmake.
 */

vi.mock('@/lib/filePicker', () => ({
  EXPORT_JSON_TYPES: [
    { description: 'Campaigner export (JSON)', accept: { 'application/json': ['.json'] } },
  ],
  EXPORT_ZIP_TYPES: [
    { description: 'Campaigner export (zip)', accept: { 'application/zip': ['.zip'] } },
  ],
  EXPORT_PDF_TYPES: [
    { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
  ],
  openSaveTarget: vi.fn(),
  supportsFilePickers: vi.fn(() => true),
  pickBackupFile: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastErrorPersistent: vi.fn(),
}));

const NPC = {
  campaignId: newId(),
  kind: 'npc' as const,
  name: 'Grimm',
  tags: ['goblin', 'boss'],
  summary: 'A goblin boss with a temper.',
  body: '# Grimm\n\nHe **grapples** first.\n- line one\n- line two',
  data: {
    appearance: 'Soot-stained',
    personality: 'Cruel',
    statBlock: {
      system: 'dnd5e' as const,
      level: '2',
      size: 'Small',
      creatureType: 'humanoid (goblinoid)',
      ac: 17,
      acNote: 'chain shirt',
      hp: 66,
      hpFormula: '12d6 + 22',
      speed: '30 ft.',
      abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 12 },
      saves: '',
      skills: '',
      senses: '',
      languages: 'Common, Goblin',
      traits: [{ name: 'Nimble Escape', text: 'Disengage or hide as a bonus action.' }],
      actions: [],
      reactions: [],
      legendary: [],
      extras: { CR: '2' },
    },
  },
};

function dump(content: unknown): string {
  return JSON.stringify(content);
}

/** The export builders take campaign-OWNED rows; narrow loudly, never cast. */
function owned(artifact: { campaignId: string | null }): Artifact {
  if (artifact.campaignId === null) throw new Error('expected a campaign-owned row');
  return artifact as Artifact;
}

describe('pdf export definitions', () => {
  it('GM notes include structured data and the stat block', () => {
    const artifact = createArtifact({ ...NPC });
    const doc = buildGmNotesDefinition(artifact);
    const text = dump(doc.content);
    expect(text).toContain('Appearance');
    expect(text).toContain('Soot-stained');
    expect(text).toContain('Nimble Escape');
    expect(text).toContain('AC 17');
    // A d20 block keeps its compact score line, byte-identical (ability
    // semantics are per-system — docs/12 §5, docs/17 row 95).
    expect(text).toContain('STR 14');
    expect(text).not.toContain('STR +2');
  });

  /**
   * The exported document obeys the same per-system display rule as the screen
   * (docs/12 §5, docs/17 row 95): a Pathfinder 2e stat box prints the signed
   * BONUS, because the stored d20 score is a number no PF2e reader uses.
   *
   * Revert-proof: print `abilities.str` verbatim for every system (the pre-row-95
   * builder) and this reads `STR 14` instead of `STR +2`.
   */
  it('prints the BONUS only for a Pathfinder 2e stat block in the exported PDF', () => {
    const artifact = createArtifact({
      ...NPC,
      data: {
        ...NPC.data,
        statBlock: { ...NPC.data.statBlock, system: 'pathfinder2e' as const },
      },
    });
    const doc = buildGmNotesDefinition(artifact);
    const text = dump(doc.content);
    // str 14 / dex 14 are the scores a PF2e +2 modifier is stored as.
    expect(text).toContain('STR +2');
    expect(text).toContain('DEX +2');
    expect(text).not.toContain('STR 14');
    // The rest of the block is untouched.
    expect(text).toContain('AC 17');
  });

  it('player handout strips markdown and omits structured data and the stat block', () => {
    const artifact = createArtifact({ ...NPC });
    const doc = buildPlayerHandoutDefinition(artifact);
    const text = dump(doc.content);
    expect(text).toContain('He grapples first.');
    expect(text).toContain('line one');
    expect(text).not.toContain('NPC details');
    expect(text).not.toContain('Soot-stained');
    expect(text).not.toContain('Nimble Escape');
    expect(text).not.toContain('AC 17');
  });

  it('markdownToText strips headings, emphasis, and links', () => {
    const text = markdownToText('# Title\n**bold** and _em_ and [link](https://x.y)');
    expect(text).toBe('Title\nbold and em and link');
  });

  /**
   * The split behind docs/17 row 105: `markdownToText` is the FAITHFUL-SOURCE
   * stripper (a wiki token survives it — the image-prompt builder depends on
   * that, pinned in `tests/llm/imagePromptDraft.test.ts`), and
   * `markdownToDisplayText` is the one a READER's document uses, because a PDF
   * is a rendering. Both halves are pinned, so neither can drift into the
   * other's job.
   */
  it('the export rendering is wiki-aware while the source stripper is not', () => {
    const source = 'He guards [[Encounter:Ash Gate|the gate]] and [[Kael]].';
    expect(markdownToText(source)).toBe(source);
    expect(markdownToDisplayText(source)).toBe('He guards the gate and Kael.');
    // A non-token stays literal in both.
    expect(markdownToDisplayText('Not a link: [[ not even this one')).toBe(
      'Not a link: [[ not even this one',
    );
  });

  /**
   * The owner read his roster lines in THIS export as `Zombie ×4 — (see
   * Bestiary)` (docs/17 row 144): a name, a constant pointing at a chapter the
   * module book does not have, and no numbers. The GM template now prints the
   * resolved reference and the cited chunk's own numbers, through the SAME
   * `domain/encounterResolve` rule and the SAME `modulePdf.statBoxContent` the
   * module PDF uses.
   *
   * Revert-proof (I3): format no reference here (the pre-142 line) and the
   * `Bestiary p.132` pin goes RED while the module book stays GREEN — measured,
   * see docs/08-TESTING.md.
   */
  it('prints a cited mob’s reference AND its numbers in the GM export', async () => {
    const campaign = await createCampaign({ name: 'Export', system: 'pathfinder2e' });
    const rulebook = await createRulebook({
      title: 'Bestiary',
      system: 'pathfinder2e',
      filename: 'bestiary.pdf',
    });
    const text = 'Cave Fisher';
    const chunk = ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: rulebook.id,
      pageStart: 132,
      pageEnd: 132,
      chunkType: 'statblock',
      headingPath: ['Cave Fisher'],
      text,
      statBlock: {
        system: 'pathfinder2e',
        level: '4',
        size: 'Medium',
        creatureType: 'animal',
        ac: 18,
        acNote: '',
        hp: 44,
        hpFormula: '8d8',
        speed: '30 ft.',
        abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
        saves: '',
        skills: '',
        senses: 'darkvision',
        languages: '',
        traits: [{ name: 'Grasping Antennae', text: 'Reach 10 feet.' }],
        actions: [{ name: 'Mandible', text: 'Melee: +12 to hit.' }],
        reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
        legendary: [{ name: 'Skitter Away', text: 'Stride without provoking reactions.' }],
        extras: { Perception: '+11' },
      },
      contentHash: await sha256Hex(text),
    });
    await putChunks([chunk]);
    const encounterRow = await persistArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Pier Ambush',
      data: {
        difficulty: 'severe',
        levelHint: '4',
        monsters: [
          {
            name: 'Cave Fisher',
            count: 1,
            notes: 'clings to the pilings',
            treasure: '',
            source: { type: 'none' as const },
          },
        ],
        terrain: 'wet planks',
        tactics: 'drag them under',
        treasure: 'a silver bell',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const encounter = owned(encounterRow);

    const roster = await resolveExportRoster(encounter);
    const definition = buildGmNotesDefinition(encounter, null, roster);
    const content = dump(definition.content);
    // The reference NAMES the source — never the dead constant. The separator
    // is what makes this the REFERENCE and not the box's attribution line.
    expect(content).toContain(' — Bestiary p.132');
    expect(content).not.toContain('see Bestiary');
    // And the numbers are in the book, reactions and legendary included.
    expect(content).toContain('Reactive Snap');
    expect(content).toContain('Skitter Away');
    expect(content).toContain('44 (8d8)');
    expect(content).toContain('Numbers from Bestiary p.132');

    // The ASYNC PRE-PASS reaches the definition the PUBLIC export builds: the
    // generator seam (the same one `buildModulePdf` takes) is the only place a
    // finished definition is visible, so driving the REAL entry point with an
    // observer proves the one code path a GM's click takes.
    let passed: TDocumentDefinitions | undefined;
    await exportArtifactPdf(encounter, 'gm', (definition) => {
      passed = definition;
      return Promise.resolve(new Blob(['%PDF-']));
    });
    if (passed === undefined) throw new Error('the export never generated a document');
    expect(dump(passed.content)).toContain(' — Bestiary p.132');
    expect(dump(passed.content)).toContain('Reactive Snap');
    expect(dump(passed.content)).toContain('Numbers from Bestiary p.132');
  }, 30000);

  it('generates a real PDF blob for both templates', async () => {
    const artifact = createArtifact({ ...NPC });
    expect(pdfFileName(artifact, 'gm')).toBe('grimm-gm-notes.pdf');

    for (const template of ['gm', 'player'] as const) {
      const blob = await exportArtifactPdf(artifact, template);
      expect(blob.size).toBeGreaterThan(500);
      const head = await blob.slice(0, 5).text();
      expect(head).toBe('%PDF-');
    }
  }, 30000);
});

describe('exportArtifactPdfFile save-picker flow', () => {
  const savePicker = vi.mocked(openSaveTarget);
  const toastError = vi.mocked(toast.toastError);
  const toastSuccess = vi.mocked(toast.toastSuccess);

  afterEach(() => {
    savePicker.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it('acquires the PDF target first, then writes the generated blob', async () => {
    const artifact = createArtifact({ ...NPC });
    const written: Blob[] = [];
    savePicker.mockImplementation(() =>
      Promise.resolve({
        cancelled: false,
        write: (blob: Blob) => {
          written.push(blob);
          return Promise.resolve();
        },
      }),
    );

    await exportArtifactPdfFile(artifact, 'gm');

    expect(savePicker).toHaveBeenCalledWith({
      suggestedName: 'grimm-gm-notes.pdf',
      types: EXPORT_PDF_TYPES,
    });
    expect(written).toHaveLength(1);
    const blob = written[0];
    if (blob === undefined) throw new Error('no PDF blob written');
    expect(await blob.slice(0, 5).text()).toBe('%PDF-');
    expect(toastSuccess).toHaveBeenCalledWith('PDF exported');
    expect(toastError).not.toHaveBeenCalled();
  }, 30000);

  it('picker cancel generates nothing and toasts nothing', async () => {
    const artifact = createArtifact({ ...NPC });
    const write = vi.fn(() => Promise.resolve());
    savePicker.mockImplementation(() => Promise.resolve({ cancelled: true, write }));

    await exportArtifactPdfFile(artifact, 'player');

    expect(savePicker).toHaveBeenCalledWith({
      suggestedName: 'grimm-handout.pdf',
      types: EXPORT_PDF_TYPES,
    });
    expect(write).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('picker failure toasts loudly without generating', async () => {
    const artifact = createArtifact({ ...NPC });
    const failure = new TypeError('SecurityError-ish');
    savePicker.mockImplementation(() => Promise.reject(failure));

    await exportArtifactPdfFile(artifact, 'gm');

    expect(toastError).toHaveBeenCalledWith('PDF export failed', failure);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
