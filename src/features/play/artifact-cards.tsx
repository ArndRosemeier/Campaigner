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
import { npcDataIsCastCreature, npcStatsAreAuthored } from '@/domain';
import { useImageUrl } from '@/features/images/use-image-url';
import { WriterModelId } from '@/components/writer-model-id';
import { MonsterStatblocksPanel } from '@/features/campaign/components/monster-source';
import { AuthoredStatBlock, BorrowedStatBlock } from '@/features/campaign/components/borrowed-stats';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';

/**
 * The read-only Session-Mode cards (07-MILESTONE-3 M3-C), extracted so the
 * module reader's peek modal renders exactly the same artifact views
 * (08-MODULE-DESIGNER M4-A: "REUSE the Session-Mode card components").
 *
 * The model-authored PROSE fields these cards own — an npc's `summary`,
 * `appearance` and `personality`, an encounter's `summary` — render through the
 * ONE wiki-aware markdown renderer `features/campaign/components/wiki-markdown`
 * (docs/17 row 217): a `[[Name]]` the model echoed out of the module prose is a
 * kind-coloured clickable chip, an unresolved one is the dashed muted chip, and
 * a bare `<p>{modelText}</p>` is gone. The resolution pool and the open callback
 * are the CALLER's, so this shared card never invents a cross-reference it
 * cannot make — a mount with no campaign context passes none and every token
 * still renders as the honest unresolved chip rather than as raw bytes.
 */

export function NpcCard({
  npc,
  artifacts,
  onOpenArtifact,
  onOpenEditor,
  showWriterModel = false,
}: {
  npc: AnyArtifact & { kind: 'npc'; data: NpcArtifactData };
  /**
   * The rows this card's wiki chips resolve against (docs/17 row 217). Omit →
   * an EMPTY pool: every `[[token]]` in the card's model prose still renders as
   * the dashed unresolved chip carrying its byte-exact tooltip, never as raw
   * bytes. Explicit at every mount, so a surface can never quietly resolve a
   * name against a pool it does not actually hold.
   */
  artifacts?: readonly AnyArtifact[] | undefined;
  /** Resolved wiki-chip click (peek modal breadcrumb push). Omit → inert chip. */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
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
  const pool = artifacts ?? [];
  // M4-C: everything is presented directly (the reader scrolls) — no
  // "More" expander, no "Stats" toggle.
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-npc-card">
      <div className="flex items-start gap-3">
        <Portrait artifact={npc} />
        <div className="min-w-0 flex-1">
          <span className="break-words font-semibold">{npc.name}</span>
          {npc.summary !== '' && (
            <WikiMarkdown
              value={npc.summary}
              artifacts={pool}
              onOpenArtifact={onOpenArtifact}
              className="text-sm break-words text-muted-foreground"
            />
          )}
        </div>
        {onOpenEditor !== undefined && <EditorJump artifact={npc} onOpenEditor={onOpenEditor} />}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        {data.appearance !== '' && (
          <div>
            <span className="font-medium">Appearance: </span>
            <WikiMarkdown value={data.appearance} artifacts={pool} onOpenArtifact={onOpenArtifact} />
          </div>
        )}
        {data.personality !== '' && (
          <div>
            <span className="font-medium">Personality: </span>
            <WikiMarkdown value={data.personality} artifacts={pool} onOpenArtifact={onOpenArtifact} />
          </div>
        )}
        {/* A CAST creature's numbers are the copy the campaign owns (docs/17
            row 255b) — read-only and labelled, the SAME render the editor's
            details panel makes (ledger row 134), so this card never shows a
            named zombie with a portrait and nothing else. A row a direct
            instruction AUTHORED keeps its origin but its numbers are its own, so
            it renders the authored arm rather than the copy one (docs/17 row
            284) — the card may not go on calling the library's what the campaign
            wrote. */}
        {!npcDataIsCastCreature(data) ? (
          data.statBlock !== null ? (
            <div className="text-base">
              <StatsCard statBlock={data.statBlock} name={npc.name} />
            </div>
          ) : null
        ) : npcStatsAreAuthored(data) ? (
          <AuthoredStatBlock
            npcName={npc.name}
            copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}
          />
        ) : (
          <BorrowedStatBlock
            npcName={npc.name}
            copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}
          />
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
  artifacts,
  onOpenArtifact,
  onOpenEditor,
  showWriterModel = false,
}: {
  encounter: AnyArtifact & { kind: 'encounter'; data: EncounterArtifactData };
  /**
   * The rows this surface can cross-reference, handed to the ONE roster panel
   * (docs/17 row 146): an `npc-ref` roster entry prints the formatter's
   * ` — see <name>` only for a row this pool holds. Explicit at every mount, so
   * a surface can never quietly claim a cross-reference it cannot make. The
   * SAME pool resolves the encounter's model prose chips (docs/17 row 217).
   */
  artifacts: readonly AnyArtifact[];
  /** Resolved wiki-chip click (peek modal breadcrumb push). Omit → inert chip. */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
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
        {/* THE OWNER-SET PARTY LEVEL (docs/17 row 291). The deprecated stored
            `levelHint` was a model-written free-text level and is never read
            as a level again — this badge printed it as if it were one. A
            part-derived level needs the owning module row, which this card
            does not hold, so it renders nothing rather than a stale string
            (docs/18 §5 records the residual). */}
        {data.partyLevel !== undefined && (
          <Badge variant="outline" className="h-auto max-w-full whitespace-normal">
            {String(data.partyLevel)}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {onOpenEditor !== undefined && <EditorJump artifact={encounter} onOpenEditor={onOpenEditor} />}
        </div>
      </div>
      {encounter.summary !== '' && (
        <WikiMarkdown
          value={encounter.summary}
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          className="text-sm break-words text-muted-foreground"
        />
      )}
      <MonsterStatblocksPanel
        monsters={data.monsters}
        targets={artifacts}
        onOpenArtifact={onOpenArtifact}
      />
      {showWriterModel && (
        <WriterModelId model={encounter.writerModel} testId="encounter-card-writer-model" />
      )}
    </div>
  );
}

export function CollapsibleRow({
  artifact,
  artifacts,
  onOpenArtifact,
  onOpenEditor,
}: {
  artifact: AnyArtifact;
  /** Wiki-chip pool for the summary (docs/17 row 217). Omit → empty pool. */
  artifacts?: readonly AnyArtifact[] | undefined;
  /** Resolved wiki-chip click. Omit → inert chip. */
  onOpenArtifact?: ((artifact: AnyArtifact) => void) | undefined;
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
      {expanded && artifact.summary !== '' && (
        <WikiMarkdown
          value={artifact.summary}
          artifacts={artifacts ?? []}
          onOpenArtifact={onOpenArtifact}
          className="text-sm"
        />
      )}
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
