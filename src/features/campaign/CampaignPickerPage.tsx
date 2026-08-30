import type { JSX } from 'react';

import { PlaceholderPage } from '@/components/PlaceholderPage';

/**
 * Placeholder for the campaign picker screen (05-UI.md §Campaign picker):
 * card grid of campaigns + "New Campaign" dialog. Implemented in T3.
 */
export function CampaignPickerPage(): JSX.Element {
  return (
    <PlaceholderPage
      title="Campaign picker"
      description="Create a campaign and pick it to enter the workspace. The campaign card grid, create dialog and cascade delete arrive with the workspace milestone."
      milestone="T3"
    />
  );
}
