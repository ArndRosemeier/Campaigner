import { useLiveQuery } from 'dexie-react-hooks';

import type { JSX } from 'react';
import { listPersonas } from '@/db/personaRepo';
import { PersonaSection } from '@/features/settings/persona-section';
import { DangerZone } from '@/features/settings/danger-zone';
import { SettingsSection } from '@/features/settings/settings-section';

/**
 * Settings screen (05-UI.md §Settings): OpenRouter credentials and models,
 * embeddings toggle, personas, danger zone.
 */
export function SettingsPage(): JSX.Element {
  const personas = useLiveQuery(() => listPersonas(), []);

  return (
    // [&>*]:shrink-0 keeps the section cards from compressing inside the flex
    // scroller — without it they clip their own content and nothing ever
    // overflows, so no scrollbar appears (big portions unreachable).
    <div
      className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0"
      data-testid="settings-page"
    >
      <h1 className="text-base font-semibold">Settings</h1>
      <SettingsSection />
      <PersonaSection personas={personas ?? []} />
      <DangerZone />
    </div>
  );
}
