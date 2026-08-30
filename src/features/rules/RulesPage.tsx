import type { JSX } from 'react';

import { PlaceholderPage } from '@/components/PlaceholderPage';

/**
 * Placeholder for the rules library screen (05-UI.md §Rules): PDF import,
 * ingestion status and the search browser. Implemented in T4–T5.
 */
export function RulesPage(): JSX.Element {
  return (
    <PlaceholderPage
      title="Rules library"
      description="Import rulebook PDFs, follow ingestion progress and search chunks (keyword + semantic). The book list, import flow and search browser arrive with the ingestion and search milestones."
      milestone="T4–T5"
    />
  );
}
