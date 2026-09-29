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

  it('the campaign route renders the ONE document page, and the landing is the only New Module door', () => {
    expect(filesWith("<CampaignDocumentPage />")).toEqual(['src/app/router.tsx']);
    // The creation dialog has exactly ONE mount in the app: the landing's
    // create state. (Its own module declares it; tests mount it directly.)
    expect(filesWith('<NewModuleDialog campaign=')).toEqual([
      'src/features/modules/CampaignDocumentPage.tsx',
    ]);
  });

  it('the creation seam is ONE and the app creation path goes through it, never `saveModule`', () => {
    expect(filesWith('export async function createCampaignDocument')).toEqual([
      'src/db/moduleRepo.ts',
    ]);
    // `llm/moduleGen.startCampaignDocument` is the APP's only creation path
    // (docs/17 row 390 — the chat authors the premise, so the app entry no
    // longer runs pass 0) and it writes through the refusing seam — a second
    // row can never be minted by the dialogs. The generator's own entry
    // (`createModuleAndRun`) shares the SAME private row-creation body, so
    // there is still exactly ONE place a document row is created. The general
    // upsert (`saveModule`/`createModule`) stays for updates and for
    // tests/imports reproducing a LEGACY multi-module campaign.
    const gen = CODE['src/llm/moduleGen.ts'] ?? '';
    expect(gen.includes('return createCampaignDocument(created)')).toBe(true);
    expect(gen.includes('saveModule(created)')).toBe(false);
    // …and the app's create dialog uses the chat-first entry, never the
    // generator's.
    const dialog = CODE['src/features/modules/new-module-dialog.tsx'] ?? '';
    expect(dialog.includes('startCampaignDocument(campaign, input)')).toBe(true);
    expect(dialog.includes('createModuleAndRun')).toBe(false);
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
