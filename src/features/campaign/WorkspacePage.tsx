import type { JSX } from 'react';
import { useParams } from 'react-router-dom';

import { PlaceholderPage } from '@/components/PlaceholderPage';
import type { RouteParams } from '@/app/routes';

/**
 * Placeholder for the three-pane workspace (05-UI.md §Workspace): campaign
 * tree · artifact editor · persona panel. Implemented in T3. Rendered for
 * both `/c/:campaignId` and `/c/:campaignId/a/:artifactId`.
 */
export function WorkspacePage(): JSX.Element {
  const { campaignId, artifactId } = useParams<RouteParams['artifact']>();

  const routeSummary = campaignId
    ? artifactId
      ? `campaign “${campaignId}”, artifact “${artifactId}”`
      : `campaign “${campaignId}”`
    : 'no campaign selected';

  return (
    <PlaceholderPage
      title="Campaign workspace"
      description={`The three-pane workspace (campaign tree · artifact editor · persona panel) will live here. Route resolves to: ${routeSummary}.`}
      milestone="T3"
    />
  );
}
