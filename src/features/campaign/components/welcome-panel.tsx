import { useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SparklesIcon } from 'lucide-react';

import { ROUTES } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { useCampaign } from '@/features/campaign/hooks';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { readSettings } from '@/db/settingsRepo';

export interface WelcomePanelProps {
  campaignId: string;
}

/**
 * Default center-pane content when no artifact is open (05-UI §Workspace).
 * While the first-run wizard is unfinished it offers the "Set up Campaigner"
 * re-open affordance next to "Open settings" (05-UI.md §Onboarding).
 */
export function WelcomePanel({ campaignId }: WelcomePanelProps): JSX.Element {
  const campaign = useCampaign(campaignId);
  const navigate = useNavigate();
  const settings = useLiveQuery(() => readSettings(), []);
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const wizardUnfinished = settings !== undefined && settings.onboarding.status !== 'complete';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">
        {campaign === undefined || campaign === null ? 'Welcome' : `Welcome to ${campaign.name}`}
      </h1>
      <p className="max-w-[40ch] text-sm text-muted-foreground">
        Select an artifact from the tree on the left, or create one with the + buttons.
      </p>
      {wizardUnfinished && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            openWizard();
          }}
          data-testid="welcome-set-up"
        >
          <SparklesIcon aria-hidden data-icon="inline-start" />
          Set up Campaigner
        </Button>
      )}
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
