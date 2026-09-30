import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE DOCUMENT PER CAMPAIGN — the module LIST is dead, the ROW survives
 * (docs/23 §10 phase 2, docs/17 row 389, AGENTS rule 4 centralization
 * obligation 2).
 *
 * The owner's words: *"Basically i want to have just one module, covering all
 * levels. The old module concept can go."* So the campaign LEADS to its one
 * document: there is no module list page, no `ROUTES.modules`, no
 * `modulesPath()`, and no New Module entry point anywhere except the campaign
 * landing's create state. The module ROW survives untouched — artifact
 * ownership by `moduleId`, the chat thread, the versions — so nothing here
 * renames `moduleId`.
 *
 * The behaviour pins live beside this file
 * (`tests/features/module-ui-toast.test.tsx` → the
 * `campaign-document-landing.test.tsx` describe for the landing, the moved
 * delete dialog and the legacy notice; `tests/db/campaign-document.test.ts`
 * for the loud refusal at the creation seam). THIS file is the source-level
 * declaration of the "exactly one" claim, the half a behavioural pin cannot
 * see: a second creation door, a second list page, or a landing that mounts
 * the dialog from somewhere else would all still render.
 */
describe('ONE document per campaign — the list is deleted, the row survives (SOURCE SCAN, docs/17 row 389)', () => {
  it('the deleted list vocabulary appears NOWHERE', () => {
    // Non-vacuity: the glob must see the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    expect(filesWith('ModulesListPage')).toEqual([]);
    expect(filesWith('ROUTES.modules')).toEqual([]);
    expect(filesWith('modulesPath')).toEqual([]);
    // The route builder that replaced it is defined exactly once, in routes.ts.
    expect(filesWith('export function documentPath')).toEqual(['src/app/routes.ts']);
  });

  it('the campaign route renders the ONE document page; creation has no form and ONE entry module', () => {
    expect(filesWith("<CampaignDocumentPage />")).toEqual(['src/app/router.tsx']);
    // MIGRATED (docs/17 row 395): the creation dialog (and its one mount) is
    // DELETED. Both creation doors — New campaign and the no-document redirect —
    // go through `start-campaign-chat.ts`, and no other file calls the seam.
    expect(filesWith('startCampaignDocument(')).toEqual([
      'src/features/campaign/start-campaign-chat.ts',
      'src/llm/moduleGen.ts',
    ]);
  });

  it('the creation seam is ONE and the app creation path goes through it, never `saveModule`', () => {
    expect(filesWith('export async function createCampaignDocument')).toEqual([
      'src/db/moduleRepo.ts',
    ]);
    // `llm/moduleGen.startCampaignDocument` is the APP's ONLY creation path
    // (docs/17 rows 390/392 — the chat authors the premise, and the generator's
    // own pass-0 entry is DELETED) and it writes through the refusing seam — a
    // second row can never be minted. The general upsert
    // (`saveModule`/`createModule`) stays for updates and for tests/imports
    // reproducing a LEGACY multi-module campaign.
    const gen = CODE['src/llm/moduleGen.ts'] ?? '';
    expect(gen.includes('return createCampaignDocument(created)')).toBe(true);
    expect(gen.includes('saveModule(created)')).toBe(false);
    // …and the app's creation entry calls it with NO owner-supplied input.
    const entry = CODE['src/features/campaign/start-campaign-chat.ts'] ?? '';
    expect(entry.includes('startCampaignDocument(campaign)')).toBe(true);
  });

  it('the legacy multi-module notice is mounted ONCE — in the campaign bar, on every campaign route', () => {
    expect(filesWith('<LegacyModulesNotice />')).toEqual(['src/app/layout/CampaignBar.tsx']);
    // …and it LINKS every extra row rather than only counting them: an extra
    // row must stay reachable, never silently hidden.
    const notice = CODE['src/features/modules/legacy-modules-notice.tsx'] ?? '';
    expect(notice.includes('modulePath(')).toBe(true);
    expect(notice.includes('legacy-extra-module-')).toBe(true);
  });

  it('the module ROW survives — `moduleId` is not renamed away', () => {
    // The row is artifact ownership, the chat thread and the versions; the
    // plural CONCEPT dies, not the binding. A sweep that renamed `moduleId`
    // would red here by naming the files that still own it.
    expect(filesWith('moduleId')).not.toEqual([]);
    expect(CODE['src/domain/module.ts']?.includes('moduleId')).toBe(true);
  });
});
