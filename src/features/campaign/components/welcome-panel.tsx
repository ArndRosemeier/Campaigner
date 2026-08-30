import { useNavigate } from 'react-router-dom';

import { ROUTES } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { useCampaign } from '@/features/campaign/hooks';

export interface WelcomePanelProps {
  campaignId: string;
}

/** Default center-pane content when no artifact is open (05-UI §Workspace). */
export function WelcomePanel({ campaignId }: WelcomePanelProps) {
  const campaign = useCampaign(campaignId);
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">
        {campaign === undefined || campaign === null ? 'Welcome' : `Welcome to ${campaign.name}`}
      </h1>
      <p className="max-w-[40ch] text-sm text-muted-foreground">
        Select an artifact from the tree on the left, or create one with the + buttons.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          navigate(ROUTES.settings);
        }}
        data-testid="welcome-settings"
      >
        Open settings
      </Button>
    </div>
  );
}
