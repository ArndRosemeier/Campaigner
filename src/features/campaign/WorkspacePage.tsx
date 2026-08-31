import type { JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDefaultLayout } from 'react-resizable-panels';

import { ROUTES, artifactPath } from '@/app/routes';
import type { Artifact } from '@/domain';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { CampaignTree } from '@/features/campaign/components/campaign-tree';
import { PersonaPanel } from '@/features/campaign/components/persona-panel';
import { WelcomePanel } from '@/features/campaign/components/welcome-panel';
import { useArtifacts, useCampaign } from '@/features/campaign/hooks';
import { readSettings } from '@/db/settingsRepo';
import { useLiveQuery } from 'dexie-react-hooks';

/** Pane ids for layout persistence (must match the rendered Panels). */
const PANEL_IDS = ['tree', 'editor', 'persona'] as const;

/**
 * Three-pane workspace (05-UI §Workspace): campaign tree · artifact editor ·
 * persona panel, as resizable panes with the spec's pixel minimums
 * (220/400/320 px). The layout persists across reloads via localStorage.
 *
 * Rendered for both `/c/:campaignId` and `/c/:campaignId/a/:artifactId`; the
 * open artifact lives in the URL (deep-linkable, back-button friendly).
 */
export function WorkspacePage(): JSX.Element {
  const { campaignId, artifactId } = useParams<{ campaignId: string; artifactId: string }>();
  const campaign = useCampaign(campaignId);
  const artifacts = useArtifacts(campaignId);
  const navigate = useNavigate();
  const layout = useDefaultLayout({
    id: 'campaigner.workspace',
    panelIds: [...PANEL_IDS],
    storage: window.localStorage,
  });

  if (campaignId === undefined) {
    return <MissingPane message="No campaign selected." backLink />;
  }
  if (campaign === null) {
    return (
      <MissingPane message="This campaign does not exist (it may have been deleted)." backLink />
    );
  }
  if (campaign === undefined || artifacts === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  const selected: Artifact | undefined =
    artifactId === undefined ? undefined : artifacts.find((artifact) => artifact.id === artifactId);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="h-full"
    >
      <ResizablePanel id="tree" defaultSize="22%" minSize={220}>
        <CampaignTree
          campaignId={campaignId}
          artifacts={artifacts}
          selectedArtifactId={selected?.id}
          onSelectArtifact={(id) => {
            navigate(artifactPath(campaignId, id));
          }}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="editor" defaultSize="48%" minSize={400}>
        {selected !== undefined ? (
          <ArtifactEditor
            key={selected.id}
            artifact={selected}
            campaignArtifacts={artifacts}
            campaignSystem={campaign.system}
          />
        ) : (
          <WelcomePanel campaignId={campaignId} />
        )}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="persona" defaultSize="30%" minSize={320}>
        <PersonaPanelWithKey campaign={campaign} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/** Persona panel with the API-key presence from settings. */
function PersonaPanelWithKey({
  campaign,
}: {
  campaign: NonNullable<ReturnType<typeof useCampaign>>;
}): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);
  const hasApiKey = (settings?.openRouterApiKey ?? '') !== '';
  return <PersonaPanel campaign={campaign} hasApiKey={hasApiKey} />;
}

function MissingPane({ message, backLink }: { message: string; backLink?: boolean }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {backLink === true && (
        <Button
          variant="outline"
          size="sm"
          render={<Link to={ROUTES.campaignPicker} />}
          nativeButton={false}
        >
          Back to campaigns
        </Button>
      )}
    </div>
  );
}
