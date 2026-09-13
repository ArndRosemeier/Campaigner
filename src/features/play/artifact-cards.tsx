import { useState } from 'react';
import type { JSX } from 'react';
import { PencilIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  AnyArtifact,
  EncounterArtifactData,
  NpcArtifactData,
  StatBlock,
} from '@/domain';
import { useImageUrl } from '@/features/images/use-image-url';
import { WriterModelId } from '@/components/writer-model-id';
import { MonsterStatblocksPanel } from '@/features/campaign/components/monster-source';
import { BorrowedStatBlock } from '@/features/campaign/components/borrowed-stats';
import { StatBlockCard } from '@/features/campaign/components/stat-block';

/**
 * The read-only Session-Mode cards (07-MILESTONE-3 M3-C), extracted so the
 * module reader's peek modal renders exactly the same artifact views
 * (08-MODULE-DESIGNER M4-A: "REUSE the Session-Mode card components").
 */

export function NpcCard({
  npc,
  onOpenEditor,
  showWriterModel = false,
}: {
  npc: AnyArtifact & { kind: 'npc'; data: NpcArtifactData };
  /** Optional pencil jump into the workspace editor. */
  onOpenEditor?: ((artifact: AnyArtifact) => void) | undefined;
  /**
   * PROVENANCE (docs/17 row 93): show the id of the model that wrote this
   * card's text. An EXPLICIT OPT-IN defaulting OFF, because this card is
   * SHARED — the peek modal (the entity card) turns it on, the battle table's
   * GM "Open card" dialog leaves it off. The choice lives at the call site, so
   * a surface that forgets the prop shows nothing rather than leaking an id
   * where the owner did not ask for it.
   */
  showWriterModel?: boolean;
}): JSX.Element {
  const data = npc.data;
  // M4-C: everything is presented directly (the reader scrolls) — no
  // "More" expander, no "Stats" toggle.
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-npc-card">
      <div className="flex items-start gap-3">
        <Portrait artifact={npc} />
        <div className="min-w-0 flex-1">
          <span className="break-words font-semibold">{npc.name}</span>
          {npc.summary !== '' && (
            <p className="text-sm break-words text-muted-foreground">{npc.summary}</p>
          )}
        </div>
        {onOpenEditor !== undefined && <EditorJump artifact={npc} onOpenEditor={onOpenEditor} />}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        {data.appearance !== '' && (
          <p>
            <span className="font-medium">Appearance: </span>
            {data.appearance}
          </p>
        )}
        {data.personality !== '' && (
          <p>
            <span className="font-medium">Personality: </span>
            {data.personality}
          </p>
        )}
        {data.statBlock !== null && (
          <div className="text-base">
            <StatsCard statBlock={data.statBlock} name={npc.name} />
          </div>
        )}
        {/* A CITED row (docs/11 D3): no block of its own, its numbers are the
            library creature's — the SAME read the editor's details panel makes
            (ledger row 134), so this read-only card never shows a named zombie
            with a portrait and nothing else. */}
        {data.statBlock === null && data.creatureRef !== undefined && (
          <BorrowedStatBlock npcName={npc.name} citation={data.creatureRef} />
        )}
      </div>
      {showWriterModel && (
        <WriterModelId model={npc.writerModel} testId="npc-card-writer-model" />
      )}
    </div>
  );
}

export function Portrait({ artifact }: { artifact: AnyArtifact }): JSX.Element | null {
  const url = useImageUrl(artifact.coverImageId);
  if (url === null) return null;
  // PROVENANCE (docs/17 row 93): the cover's model id is NOT captioned here.
  // This is a 48px avatar where the id would truncate to gibberish, and every
  // card that shows it also shows the same image at banner size in the peek
  // modal, where the id renders in full (the owner copies it). One readable
  // caption beats two, one of them unreadable.
  return (
    <img
      src={url}
      alt={`Portrait of ${artifact.name}`}
      className="size-12 shrink-0 rounded-md object-cover"
    />
  );
}

function StatsCard({ statBlock, name }: { statBlock: StatBlock; name: string }): JSX.Element {
  return <StatBlockCard statBlock={statBlock} name={name} />;
}

export function EncounterCard({
  encounter,
  onOpenEditor,
  showWriterModel = false,
}: {
  encounter: AnyArtifact & { kind: 'encounter'; data: EncounterArtifactData };
  onOpenEditor?: ((artifact: AnyArtifact) => void) | undefined;
  /** Show the id of the model that wrote this card's text (see `NpcCard`;
   * default off — the peek modal opts in). */
  showWriterModel?: boolean;
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
        <div className="ml-auto flex items-center gap-1.5">
          {onOpenEditor !== undefined && <EditorJump artifact={encounter} onOpenEditor={onOpenEditor} />}
        </div>
      </div>
      {encounter.summary !== '' && (
        <p className="text-sm break-words text-muted-foreground">{encounter.summary}</p>
      )}
      <MonsterStatblocksPanel monsters={data.monsters} />
      {showWriterModel && (
        <WriterModelId model={encounter.writerModel} testId="encounter-card-writer-model" />
      )}
    </div>
  );
}

export function CollapsibleRow({
  artifact,
  onOpenEditor,
}: {
  artifact: AnyArtifact;
  onOpenEditor?: ((artifact: AnyArtifact) => void) | undefined;
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
  artifact: AnyArtifact;
  onOpenEditor: (artifact: AnyArtifact) => void;
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
