import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { getModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';
import {
  moduleDocumentSections,
  moduleLevelSeparator,
  splitModuleDocument,
} from '@/domain/moduleDocument';
import { isLevelEditCommand, parseCanvasChatReply } from '@/llm/canvasChat';
import { startCampaignDocument } from '@/llm/moduleGen';
import { applyChatCommandsToSnapshot } from '@/features/modules/canvas/chatApply';
import { saveWholeModuleDocument } from '@/features/modules/canvas/saveDoc';

/**
 * THE CHAT FROM NOTHING (docs/23 §10 phase 3, docs/17 row 390) — the owner's
 * request, verbatim: *"One canvas chat that starts with nothing and ends with
 * the campaign premise and produces module levels inside the canvas, as one big
 * document."*
 *
 * These pins drive the REAL seams end to end and claim four things:
 *
 * 1. THE APP'S CREATION ENTRY STARTS AN EMPTY DOCUMENT (`startCampaignDocument`):
 *    the row exists, its `document` is `''` and it carries no spine — the
 *    "starts with nothing" state. Nothing is generated: the premise's author is
 *    the chat now.
 * 2. AN EMPTY DOCUMENT IS AUTHORABLE: a chat reply carrying `replace_level
 *    level="0"` + `append_level level="1"` turns `''` into the premise plus a
 *    level section, and THE APP writes the canonical `=====Level 1=====`
 *    separator — the model never emits the scaffold.
 * 3. IT PERSISTS through the ONE document write and comes back through the ONE
 *    row read: premise = level 0, section 1's text = the level's text.
 * 4. THE PLAN METADATA A CHAT-CREATED LEVEL GETS IS NONE, AND THAT IS NOT A
 *    FAILURE: the stored `levelPlans` entry is the empty plan record, the
 *    derived display title is the `Level N` LABEL (never read from the prose's
 *    caption line), and the level's `levelBand` is its own number.
 */

async function emptyCampaignDocument(): Promise<{ campaignId: string; moduleId: string }> {
  const campaign = await createCampaign({ name: 'From Nothing', system: 'dnd5e' });
  const moduleId = await startCampaignDocument(campaign, {
    campaignId: campaign.id,
    title: 'The campaign document',
    concept: 'A campaign authored entirely in the canvas chat.',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  return { campaignId: campaign.id, moduleId };
}

/** One chat reply: the premise as level 0, then level 1 created by the app. */
const AUTHORING_REPLY = [
  'Here is the campaign’s spine.',
  '<replace_level level="0"><replace>The kingdom of Vess is drowning, and nobody will say why.</replace></replace_level>',
  '<append_level level="1"><replace>## The drowned gate\nThe party reaches the flooded gate and learns the water is rising.</replace></append_level>',
].join('\n');

describe('the canvas chat authors a campaign document from NOTHING (docs/17 row 390)', () => {
  beforeEach(clearDatabase);

  it('startCampaignDocument starts an EMPTY document and runs NO generation', async () => {
    const { moduleId } = await emptyCampaignDocument();
    const module = await getModule(moduleId);
    expect(module).toBeDefined();
    // The row exists and is EMPTY — the state the chat authors.
    expect(module?.status).toBe('draft');
    expect(module?.spine).toBeNull();
    expect(module?.parts).toEqual([]);
    const row = await db.modules.get(moduleId);
    expect(row?.document).toBe('');
    expect(row?.levelPlans).toEqual([]);
    expect(row?.levelStates).toEqual([]);
    // ZERO separators is simply "level 0 only": an empty document parses.
    const parsed = splitModuleDocument(row?.document ?? 'missing');
    expect(parsed.levels.map((level) => level.number)).toEqual([0]);
    expect(parsed.levels[0]?.text).toBe('');
  });

  it('the chat writes the premise as level 0 and the APP writes the level separator', async () => {
    const { moduleId } = await emptyCampaignDocument();
    const { commands } = parseCanvasChatReply(AUTHORING_REPLY);
    // Both are the LEVEL-ADDRESSED family (the search half of the union has no
    // `kind`); the applier performs them through the domain seam.
    expect(commands.map((command) => (isLevelEditCommand(command) ? command.kind : 'edit'))).toEqual([
      'replace_level',
      'append_level',
    ]);

    const applied = applyChatCommandsToSnapshot({ commands, partPlan: [], doc: '' });
    expect(applied.docChanged).toBe(true);
    // THE APP'S FORMAT: the separator line and its number were written by the
    // seam, never by the model.
    expect(applied.doc).toContain(moduleLevelSeparator(1));
    expect(applied.doc).toBe(
      'The kingdom of Vess is drowning, and nobody will say why.' +
        '\n\n' +
        moduleLevelSeparator(1) +
        '\n' +
        '## The drowned gate\nThe party reaches the flooded gate and learns the water is rising.',
    );
    // Two levels: the premise (0) and the created section (1).
    expect(splitModuleDocument(applied.doc).levels.map((level) => level.number)).toEqual([0, 1]);

    // …and it PERSISTS through the ONE document write, read back through the
    // ONE row read: the premise is level 0 and section 1 carries its text.
    const before = await getModule(moduleId);
    if (before === undefined) throw new Error('the started document vanished');
    await saveWholeModuleDocument({
      moduleId,
      doc: applied.doc,
      module: before,
      origin: 'ai',
      label: 'Chat: author the campaign',
      version: { source: 'chat', label: 'Chat: author the campaign' },
      writerModel: 'test-model',
    });
    const reloaded = await getModule(moduleId);
    expect(reloaded?.spine?.premise).toBe(
      'The kingdom of Vess is drowning, and nobody will say why.',
    );
    expect(reloaded?.parts.map((part) => part.planIndex)).toEqual([0]);
    expect(reloaded?.parts[0]?.markdown).toBe(
      '## The drowned gate\nThe party reaches the flooded gate and learns the water is rising.',
    );
    // The stored document is the SAME bytes the applier produced.
    expect((await db.modules.get(moduleId))?.document).toBe(applied.doc);
  });

  it('a chat-created level gets NO stored plan title — the label is `Level N`, and a missing title is not a failure', async () => {
    const { moduleId } = await emptyCampaignDocument();
    const { commands } = parseCanvasChatReply(AUTHORING_REPLY);
    const applied = applyChatCommandsToSnapshot({ commands, partPlan: [], doc: '' });
    const before = await getModule(moduleId);
    if (before === undefined) throw new Error('the started document vanished');
    await saveWholeModuleDocument({
      moduleId,
      doc: applied.doc,
      module: before,
      origin: 'ai',
      label: 'Chat: author the campaign',
      version: { source: 'chat', label: 'Chat: author the campaign' },
      writerModel: 'test-model',
    });

    // DIRECTION 1 — WHAT IT HOLDS: the stored plan entry is EMPTY. The chat
    // supplies no title, no synopsis and no level-up trigger: the caption line
    // under the separator (`## The drowned gate`) is PROSE and is never read
    // into a plan field (docs/23 §2, AGENTS rule 5).
    const row = await db.modules.get(moduleId);
    expect(row?.levelPlans).toEqual([{ title: '', synopsis: '', levelUpTrigger: '' }]);
    expect(row?.levelStates).toEqual([
      { status: 'ready', errorMessage: '', edited: true, writerModel: 'test-model', origin: 'model' },
    ]);

    // DIRECTION 2 — A MISSING TITLE IS NOT A FAILURE: the derived view labels
    // the section `Level 1` (its own number), NOT the prose's heading, and the
    // level's band IS its own number.
    const reloaded = await getModule(moduleId);
    const sections = moduleDocumentSections(
      (await db.modules.get(moduleId))?.document ?? '',
      reloaded?.spine?.partPlan ?? [],
    );
    expect(sections.map((section) => section.number)).toEqual([0, 1]);
    expect(sections[0]?.title).toBe('Premise');
    expect(sections[1]?.title).toBe('Level 1');
    expect(reloaded?.spine?.partPlan[0]?.title).toBe('Level 1');
    expect(reloaded?.spine?.partPlan[0]?.levelBand).toBe('1');
    expect(reloaded?.spine?.partPlan[0]?.synopsis).toBe('');
    expect(reloaded?.spine?.partPlan[0]?.levelUpTrigger).toBe('');
  });
});
