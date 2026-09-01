import { createBrowserRouter } from 'react-router-dom';

import { NotFoundPage } from '@/components/NotFoundPage';
import { AppShell } from '@/app/layout/AppShell';
import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { GraphPage } from '@/features/campaign/GraphPage';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { PlayPage } from '@/features/play/PlayPage';
import { DeliverablesPage } from '@/features/deliverables/DeliverablesPage';
import { ModuleReaderPage } from '@/features/modules/ModuleReaderPage';
import { ModulesListPage } from '@/features/modules/ModulesListPage';
import { RulesPage } from '@/features/rules/RulesPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

/**
 * Builds the app's route table, per 05-UI.md §Routes. All pages render inside
 * `AppShell` so the top bar is present on every route.
 *
 * Exported as a factory so tests can mount a fresh router bound to the current
 * URL; the app itself uses the singleton below.
 */
export type AppRouter = ReturnType<typeof createBrowserRouter>;

/** Vite `BASE_URL` always ends with `/`; React Router wants no trailing slash. */
function appBasename(): string {
  const base = import.meta.env.BASE_URL;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function createAppRouter(): AppRouter {
  return createBrowserRouter(
    [
      {
        path: ROUTES.campaignPicker,
        element: <AppShell />,
        children: [
          { index: true, element: <CampaignPickerPage /> },
          { path: ROUTES.workspace, element: <WorkspacePage /> },
          { path: ROUTES.artifact, element: <WorkspacePage /> },
          { path: ROUTES.graph, element: <GraphPage /> },
          { path: ROUTES.play, element: <PlayPage /> },
          { path: ROUTES.deliverables, element: <DeliverablesPage /> },
          { path: ROUTES.modules, element: <ModulesListPage /> },
          { path: ROUTES.module, element: <ModuleReaderPage /> },
          { path: ROUTES.rules, element: <RulesPage /> },
          { path: ROUTES.settings, element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
    { basename: appBasename() },
  );
}

/** The router instance used by the running app. */
export const router: AppRouter = createAppRouter();
