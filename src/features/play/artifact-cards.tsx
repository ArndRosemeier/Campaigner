import { useState } from 'react';
import type { JSX } from 'react';
import { EyeIcon, PencilIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  Artifact,
  EncounterArtifactData,
  NpcArtifactData,
  StatBlock,
} from '@/domain';
import { useImageUrl } from '@/features/images/use-image-url';
import { MonsterStatblocksPanel } from '@/features/campaign/components/monster-source';
import { StatBlockCard } from '@/features/campaign/components/stat-block';

/**
 * The read-only Session-Mode cards (07-MILESTONE-3 M3-C), extracted so the
 * module reader's peek modal renders exactly the same artifact views
 * (08-MODULE-DESIGNER M4-A: "REUSE the Session-Mode card components").
 */

export function NpcCard({
  npc,
  onOpenEditor,
}: {
  npc: Artifact & { kind: 'npc'; data: NpcArtifactData };
  /** Optional pencil jump into the workspace editor. */
  onOpenEditor?: ((artifact: Artifact) => void) | undefined;
}): JSX.Element {
  const data = npc.data;
  // M4-C: everything is presented directly (the reader scrolls) — no
  // "More" expander, no "Stats" toggle.
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-npc-card">
      <div className="flex items-start gap-3">
        <Portrait artifact={npc} />
        <div className="min-w-0 flex-1">
          {/* flex-wrap so a long role pill drops below the name instead of
              squeezing it (the badge is shrink-0 + nowrap: it caused both the
              horizontal stripe and the vertically-spelled name). */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-words font-semibold">{npc.name}</span>
            {data.role !== '' && (
              <Badge variant="secondary" className="h-auto max-w-full whitespace-normal">
                {data.role}
              </Badge>
            )}
          </div>
          {npc.summary !== '' && (
            <p className="text-sm break-words text-muted-foreground">{npc.summary}</p>
          )}
        </div>
        {onOpenEditor !== undefined && <EditorJump artifact={npc} onOpenEditor={onOpenEditor} />}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        {data.personality !== '' && (
          <p>
            <span className="font-medium">Personality: </span>
            {data.personality}
          </p>
        )}
        {data.motivation !== '' && (
          <p>
            <span className="font-medium">Motivation: </span>
            {data.motivation}
          </p>
        )}
        {data.voiceNotes !== '' && (
          <p>
            <span className="font-medium">Voice: </span>
            {data.voiceNotes}
          </p>
        )}
        {data.secrets !== '' && <SecretBlock secret={data.secrets} />}
        {data.statBlock !== null && (
          <div className="text-base">
            <StatsCard statBlock={data.statBlock} name={npc.name} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Portrait({ artifact }: { artifact: Artifact }): JSX.Element | null {
  const url = useImageUrl(artifact.coverImageId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt={`Portrait of ${artifact.name}`}
      className="size-12 rounded-md object-cover"
    />
  );
}

export function SecretBlock({ secret }: { secret: string }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      className={`relative flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left ${
        revealed ? '' : 'select-none blur-sm'
      }`}
      aria-label={revealed ? 'Secret (click to hide)' : 'Secret (click to reveal)'}
      onClick={() => {
        setRevealed((value) => !value);
      }}
      data-testid="play-secret"
    >
      <EyeIcon aria-hidden className="size-4 shrink-0 blur-0" />
      <span className={revealed ? '' : 'blur-sm'}>{secret}</span>
    </button>
  );
}

function StatsCard({ statBlock, name }: { statBlock: StatBlock; name: string }): JSX.Element {
  return <StatBlockCard statBlock={statBlock} name={name} />;
}

export function EncounterCard({
  encounter,
  onOpenEditor,
}: {
  encounter: Artifact & { kind: 'encounter'; data: EncounterArtifactData };
  onOpenEditor?: ((artifact: Artifact) => void) | undefined;
}): JSX.Element {
  const data = encounter.data;
  // M4-C: the resolved stat blocks render directly — no "More" expander.
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-encounter-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="break-words font-semibold">{encounter.name}</span>
        {data.difficulty !== '' && (
          <Badge variant="destructive" className="h-auto max-w-full whitespace-normal">
            {data.difficulty}
          </Badge>
        )}
        {data.levelHint !== '' && (
          <Badge variant="outline" className="h-auto max-w-full whitespace-normal">
            {data.levelHint}
          </Badge>
        )}
        {onOpenEditor !== undefined && (
          <div className="ml-auto">
            <EditorJump artifact={encounter} onOpenEditor={onOpenEditor} />
          </div>
        )}
      </div>
      {encounter.summary !== '' && (
        <p className="text-sm break-words text-muted-foreground">{encounter.summary}</p>
      )}
      <MonsterStatblocksPanel monsters={data.monsters} />
    </div>
  );
}

export function CollapsibleRow({
  artifact,
  onOpenEditor,
}: {
  artifact: Artifact;
  onOpenEditor?: ((artifact: Artifact) => void) | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-label={`Expand ${artifact.name}`}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          <span className="font-semibold">{artifact.name}</span>
          <span className="ml-2 text-xs text-muted-foreground">{artifact.kind}</span>
        </button>
        {onOpenEditor !== undefined && (
          <EditorJump artifact={artifact} onOpenEditor={onOpenEditor} />
        )}
      </div>
      {expanded && artifact.summary !== '' && <p className="text-sm">{artifact.summary}</p>}
    </div>
  );
}

function EditorJump({
  artifact,
  onOpenEditor,
}: {
  artifact: Artifact;
  onOpenEditor: (artifact: Artifact) => void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Open ${artifact.name} in workspace`}
      onClick={() => {
        onOpenEditor(artifact);
      }}
    >
      <PencilIcon aria-hidden className="size-3.5" />
    </Button>
  );
}
