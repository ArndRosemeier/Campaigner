import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, newId } from '@/domain';
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
