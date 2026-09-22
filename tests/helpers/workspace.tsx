import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { Id } from '@/domain';
import { ROUTES, workspacePath } from '@/app/routes';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';

/**
 * Mount the three-pane workspace on a campaign (docs/17 row 322). THE one
 * helper for it: the removal/selection test files both render the real page —
 * the tree pane's selection bar, the shared confirm and the import flow all
 * live INSIDE it — and a second copy of this mount would be the exact
 * duplication AGENTS rule 4 forbids (the tripwire caught the first one).
 *
 * The artifact route is registered too, because the tree's row click navigates
 * to `/c/:campaignId/a/:artifactId` and a missing route would blank the page.
 */
export function renderWorkspace(campaignId: Id): void {
  render(
    <MemoryRouter initialEntries={[workspacePath(campaignId)]}>
      <Routes>
        <Route path={ROUTES.workspace} element={<WorkspacePage />} />
        <Route path={ROUTES.artifact} element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}
