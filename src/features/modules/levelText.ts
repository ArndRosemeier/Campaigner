import type { Id, Module, ModulePart } from '@/domain';
import { saveModuleLevels } from '@/db/moduleRepo';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';

/**
 * THE one LEVEL-text save path (18-ARCHITECTURE §2.3, docs/23 §4, docs/17 row
 * 391): every human- or model-adopted level-text write — the reader's hand edit,
 * the board rewrite's Apply and Discard — funnels through here, and it writes
 * through THE one LEVEL-ADDRESSED document seam (`db/moduleRepo.saveModuleLevels`
 * → `domain/moduleDocument.moduleRowFromLevelWrites`). There is no per-part row
 * and no `planIndex`-keyed text write left anywhere: a level IS its number, and
 * its text is the document's section text.
 *
 * The write re-reads the module INSIDE its transaction (stale-snapshot
 * lost-update guard) and stamps `status: 'ready'` + `edited: true`; the
 * post-save `promoteSecondModuleUses` scan promotes second-module wikilink uses
 * to campaign level, loudly (10 D12). Never route a level-text write anywhere
 * else and never skip the promote scan.
 *
 * PROVENANCE (docs/17 row 93): `writerModel` is passed ONLY by a model write
 * (the board's Discard restoring bytes a model wrote). A hand edit omits it, and
 * the recorded id is then CARRIED — the owner's edits must not erase which model
 * wrote the text.
 *
 * AUTHORSHIP (docs/17 row 113): `origin` is what records who wrote the text now
 * on the row. A write that names a model defaults to `'model'`; one that cannot
 * is the owner's (`'human'`). `edited` deliberately stays `true` for BOTH — it
 * means "written outside the generator", which is what its readers assume — so
 * the two fields are recorded side by side rather than one being overloaded into
 * a lie. `origin` is stated EXPLICITLY only by a write that does not change who
 * wrote the text: the board's Apply re-lands the text the engine just wrote (so
 * the model's origin must survive it) and its Discard puts the PREVIOUS text
 * back with the authorship that text had (`stagedRewrites` captured it before
 * the rewrite overwrote the document).
 */
export interface LevelTextAuthorship {
  /** The model that wrote this text; omitted = a hand edit that CARRIES the
   * recorded id forward. */
  writerModel?: string | undefined;
  /** Who wrote the text this write lands; omitted = the writer-model rule. */
  origin?: ModulePart['origin'] | undefined;
}

export async function saveModuleLevelText(
  moduleId: Id,
  level: number,
  markdown: string,
  authorship: LevelTextAuthorship = {},
): Promise<Module> {
  const saved = await saveModuleLevels(moduleId, [
    {
      level,
      text: markdown,
      state: {
        status: 'ready',
        errorMessage: '',
        edited: true,
        ...(authorship.writerModel === undefined ? {} : { writerModel: authorship.writerModel }),
        origin:
          authorship.origin ??
          (authorship.writerModel === undefined ? 'human' : 'model'),
      },
    },
  ]);
  await promoteSecondModuleUses(moduleId, [markdown]);
  return saved;
}
