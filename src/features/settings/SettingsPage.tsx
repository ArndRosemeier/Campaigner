import type { JSX } from 'react';

import { PlaceholderPage } from '@/components/PlaceholderPage';

/**
 * Placeholder for the settings screen (05-UI.md §Settings): OpenRouter API
 * key, default models, embeddings toggle, personas, danger zone. Implemented
 * in T6 (key/models) and T7 (personas).
 */
export function SettingsPage(): JSX.Element {
  return (
    <PlaceholderPage
      title="Settings"
      description="OpenRouter API key, default chat and embedding models, the embeddings toggle and persona management will live here."
      milestone="T6–T7"
    />
  );
}
