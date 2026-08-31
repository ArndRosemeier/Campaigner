import { useLiveQuery } from 'dexie-react-hooks';

import type { JSX } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listPersonas } from '@/db/personaRepo';
import { HelpButton } from '@/help/HelpButton';
import { LanguageSelect } from '@/features/settings/language-select';
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
      <h1 className="flex items-center gap-1 text-base font-semibold">
        Settings
        <HelpButton topic="settings" label="settings" />
      </h1>
      <SettingsSection />
      <Card>
        <CardHeader>
          <CardTitle>Generation language</CardTitle>
          <CardDescription>
            Language for all generated content (default English). Enforced in every
            generation prompt; also selectable in the top bar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSelect ariaLabel="Generation language" />
        </CardContent>
      </Card>
      <PersonaSection personas={personas ?? []} />
      <DangerZone />
    </div>
  );
}
