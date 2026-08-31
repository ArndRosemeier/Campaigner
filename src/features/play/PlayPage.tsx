import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckIcon, EyeIcon, PencilIcon, PinIcon } from 'lucide-react';

import { artifactPath } from '@/app/routes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  Artifact,
  EncounterArtifactData,
  NpcArtifactData,
  SessionArtifactData,
  StatBlock,
} from '@/domain';
import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { useImageUrl } from '@/features/images/use-image-url';
import { MonsterStatblocksPanel } from '@/features/campaign/components/monster-source';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { usePlayStore } from '@/features/play/playStore';
import { useQuickFindStore } from '@/features/quickfind/quickfindStore';

/**
 * Session Mode (07-MILESTONE-3 M3-C): read-first, link-driven play view at
 * `/c/:campaignId/play`. Zero forms — the only writes are scene check-offs
 * and the quick log. Focus header + one-link-hop context grid + session rail.
 */

export function PlayPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const artifacts = useLiveQuery(
    () => listArtifactsByCampaign(campaignId),
    [campaignId],
  );
  const play = usePlayStore((state) => state.stateOf(campaignId));
  const setFocus = usePlayStore((state) => state.setFocus);
  const backTo = usePlayStore((state) => state.backTo);
  const openQuickFind = useQuickFindStore((state) => state.openQuickFind);

  const byId = useMemo(
    () => new Map((artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );

  const focus =
    (play.focusArtifactId !== null ? byId.get(play.focusArtifactId) : undefined) ??
    // Default focus: the first location (the doc's "normally a Location").
    (artifacts ?? []).find((artifact) => artifact.kind === 'location') ??
    (artifacts ?? [])[0];

  return (
    <div className="flex h-full min-h-0 bg-background text-lg" data-testid="play-page">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {focus === undefined ? (
          <div className="p-8 text-muted-foreground">
            No artifacts yet — create content in the workspace.
          </div>
        ) : (
          <>
            <FocusHeader
              focus={focus}
              history={play.focusHistory
                .map((id) => byId.get(id))
                .filter((artifact): artifact is Artifact => artifact !== undefined)}
              onBackTo={(artifact) => {
                backTo(campaignId, artifact.id);
              }}
              onSetFocus={() => {
                openQuickFind();
              }}
            />
            <ContextGrid
              focus={focus}
              artifacts={artifacts ?? []}
              campaignId={campaignId}
              onSetFocus={(artifact) => {
                setFocus(campaignId, artifact.id);
              }}
              onOpenEditor={(artifact) => {
                navigate(artifactPath(campaignId, artifact.id));
              }}
            />
          </>
        )}
      </div>
      <SessionRail campaignId={campaignId} artifacts={artifacts ?? []} />
    </div>
  );
}

function FocusHeader({
  focus,
  history,
  onBackTo,
  onSetFocus,
}: {
  focus: Artifact;
  history: Artifact[];
  onBackTo: (artifact: Artifact) => void;
  onSetFocus: () => void;
}): JSX.Element {
  return (
    <header className="border-b px-6 py-4">
      <nav aria-label="Recent foci" className="mb-2 flex flex-wrap items-center gap-1">
        {history.slice(0, 5).map((artifact) => (
          <Button
            key={artifact.id}
            variant="ghost"
            size="sm"
            onClick={() => {
              onBackTo(artifact);
            }}
          >
            {artifact.name}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={onSetFocus} data-testid="set-focus">
          Set focus…
        </Button>
      </nav>
      <div className="flex items-start gap-4">
        <CoverImage artifactId={focus.coverImageId} name={focus.name} />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{focus.name}</h1>
          {focus.summary !== '' && (
            <p className="mt-1 text-muted-foreground">{focus.summary}</p>
          )}
        </div>
      </div>
      {focus.body !== '' && (
        <div className="prose-sm mt-3 max-w-3xl [&_blockquote]:border-l-4 [&_blockquote]:border-accent [&_blockquote]:bg-accent/20 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:italic">
          <Markdown>{focus.body}</Markdown>
        </div>
      )}
    </header>
  );
}

function CoverImage({ artifactId, name }: { artifactId: string | null; name: string }): JSX.Element | null {
  const url = useImageUrl(artifactId);
  if (url === null) return null;
  return (
    <img
      src={url}
      alt={`Cover of ${name}`}
      className="size-20 shrink-0 rounded-md object-cover"
    />
  );
}

function ContextGrid({
  focus,
  artifacts,
  campaignId,
  onSetFocus,
  onOpenEditor,
}: {
  focus: Artifact;
  artifacts: readonly Artifact[];
  campaignId: string;
  onSetFocus: (artifact: Artifact) => void;
  onOpenEditor: (artifact: Artifact) => void;
}): JSX.Element {
  const outIds = new Set(focus.links.map((link) => link.targetId));
  const neighbors = artifacts.filter(
    (artifact) => artifact.id !== focus.id && (outIds.has(artifact.id) || artifact.links.some((link) => link.targetId === focus.id)),
  );
  const npcs = neighbors.filter((artifact) => artifact.kind === 'npc');
  const encounters = neighbors.filter((artifact) => artifact.kind === 'encounter');
  const locations = neighbors.filter((artifact) => artifact.kind === 'location');
  const others = neighbors.filter(
    (artifact) => artifact.kind !== 'npc' && artifact.kind !== 'encounter' && artifact.kind !== 'location',
  );

  return (
    <main className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-2">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">NPCs here</h2>
        {npcs.length === 0 && <p className="text-sm text-muted-foreground">None linked.</p>}
        {npcs.map((npc) => (
          <NpcCard key={npc.id} npc={npc} campaignId={campaignId} onOpenEditor={onOpenEditor} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Encounters</h2>
        {encounters.length === 0 && <p className="text-sm text-muted-foreground">None linked.</p>}
        {encounters.map((encounter) => (
          <EncounterCard
            key={encounter.id}
            encounter={encounter}
            campaignId={campaignId}
            onOpenEditor={onOpenEditor}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Connected locations</h2>
        {locations.length === 0 && <p className="text-sm text-muted-foreground">None linked.</p>}
        {locations.map((location) => (
          <button
            key={location.id}
            type="button"
            className="flex items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-accent"
            onClick={() => {
              onSetFocus(location);
            }}
            data-testid={`focus-jump-${location.id}`}
          >
            <span className="font-semibold">{location.name}</span>
            <PinIcon aria-hidden className="size-4 text-muted-foreground" />
          </button>
        ))}
      </section>

      {others.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">More</h2>
          {others.map((artifact) => (
            <CollapsibleRow key={artifact.id} artifact={artifact} onOpenEditor={onOpenEditor} />
          ))}
        </section>
      )}
    </main>
  );
}

function EditorJump({ artifact, onOpenEditor }: { artifact: Artifact; onOpenEditor: (artifact: Artifact) => void }): JSX.Element {
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

function NpcCard({
  npc,
  campaignId,
  onOpenEditor,
}: {
  npc: Artifact;
  campaignId: string;
  onOpenEditor: (artifact: Artifact) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const data = npc.data as NpcArtifactData;
  void campaignId;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-npc-card">
      <div className="flex items-start gap-3">
        <Portrait artifact={npc} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{npc.name}</span>
            {data.role !== '' && <Badge variant="secondary">{data.role}</Badge>}
          </div>
          {npc.summary !== '' && <p className="text-sm text-muted-foreground">{npc.summary}</p>}
        </div>
        <EditorJump artifact={npc} onOpenEditor={onOpenEditor} />
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 text-sm">
          {data.personality !== '' && <p><span className="font-medium">Personality: </span>{data.personality}</p>}
          {data.motivation !== '' && <p><span className="font-medium">Motivation: </span>{data.motivation}</p>}
          {data.voiceNotes !== '' && <p><span className="font-medium">Voice: </span>{data.voiceNotes}</p>}
          {data.secrets !== '' && <SecretBlock secret={data.secrets} />}
          {data.statBlock !== null && (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="xs"
                className="self-start"
                aria-label="Stats"
                onClick={() => {
                  setShowStats((value) => !value);
                }}
              >
                {showStats ? 'Hide stats' : 'Stats'}
              </Button>
              {showStats && (
                <div className="text-base">
                  <StatsCard statBlock={data.statBlock} name={npc.name} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        aria-label={expanded ? `Collapse ${npc.name}` : `Expand ${npc.name}`}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        {expanded ? 'Less' : 'More'}
      </Button>
    </div>
  );
}

function Portrait({ artifact }: { artifact: Artifact }): JSX.Element | null {
  const url = useImageUrl(artifact.coverImageId);
  if (url === null) return null;
  return <img src={url} alt={`Portrait of ${artifact.name}`} className="size-12 rounded-md object-cover" />;
}

function SecretBlock({ secret }: { secret: string }): JSX.Element {
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

function EncounterCard({
  encounter,
  campaignId,
  onOpenEditor,
}: {
  encounter: Artifact;
  campaignId: string;
  onOpenEditor: (artifact: Artifact) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const data = encounter.data as EncounterArtifactData;
  void campaignId;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="play-encounter-card">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{encounter.name}</span>
        {data.difficulty !== '' && <Badge variant="destructive">{data.difficulty}</Badge>}
        {data.levelHint !== '' && <Badge variant="outline">{data.levelHint}</Badge>}
        <div className="ml-auto">
          <EditorJump artifact={encounter} onOpenEditor={onOpenEditor} />
        </div>
      </div>
      {encounter.summary !== '' && <p className="text-sm text-muted-foreground">{encounter.summary}</p>}
      {expanded && <MonsterStatblocksPanel monsters={data.monsters} />}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        aria-label={expanded ? `Collapse ${encounter.name}` : `Expand ${encounter.name}`}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        {expanded ? 'Less' : 'More'}
      </Button>
    </div>
  );
}

function CollapsibleRow({
  artifact,
  onOpenEditor,
}: {
  artifact: Artifact;
  onOpenEditor: (artifact: Artifact) => void;
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
        <EditorJump artifact={artifact} onOpenEditor={onOpenEditor} />
      </div>
      {expanded && artifact.summary !== '' && <p className="text-sm">{artifact.summary}</p>}
    </div>
  );
}

function SessionRail({ campaignId, artifacts }: { campaignId: string; artifacts: readonly Artifact[] }): JSX.Element {
  const sessions = useMemo(
    () =>
      artifacts
        .filter((artifact) => artifact.kind === 'session')
        .sort((a, b) => b.createdAt - a.createdAt),
    [artifacts],
  );
  const play = usePlayStore((state) => state.stateOf(campaignId));
  const setActiveSession = usePlayStore((state) => state.setActiveSession);
  const toggleRail = usePlayStore((state) => state.toggleRail);
  const setFocus = usePlayStore((state) => state.setFocus);
  const active = sessions.find((session) => session.id === play.activeSessionId) ?? sessions[0];
  const [logText, setLogText] = useState('');

  async function newSession(): Promise<void> {
    const created = await createArtifact({
      campaignId,
      kind: 'session',
      name: `Session ${sessions.length + 1}`,
    });
    setActiveSession(campaignId, created.id);
  }

  async function patchSession(next: SessionArtifactData): Promise<void> {
    if (active === undefined) return;
    await updateArtifact(active.id, { data: next });
  }

  return (
    <aside
      className={`flex min-h-0 shrink-0 flex-col gap-3 border-l p-4 ${play.railCollapsed ? 'w-14' : 'w-80'}`}
      data-testid="session-rail"
    >
      <div className="flex items-center gap-2">
        {play.railCollapsed ? (
          <Button variant="ghost" size="sm" aria-label="Expand session rail" onClick={() => { toggleRail(campaignId); }}>
            ◀
          </Button>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-muted-foreground">Session</h2>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Collapse session rail" onClick={() => { toggleRail(campaignId); }}>
              ▶
            </Button>
          </>
        )}
      </div>

      {!play.railCollapsed && (
        <>
          <div className="flex items-center gap-2">
            <Select
              value={active?.id ?? ''}
              items={Object.fromEntries(sessions.map((session) => [session.id, session.name]))}
              onValueChange={(value) => {
                if (value !== null) setActiveSession(campaignId, value);
              }}
            >
              <SelectTrigger className="flex-1" aria-label="Active session">
                <SelectValue placeholder={sessions.length === 0 ? 'No sessions' : 'Choose session'} />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" aria-label="New session" onClick={() => { void newSession(); }}>
              New session
            </Button>
          </div>

          {active !== undefined && (
            <SessionChecklist session={active} onJump={(artifactId) => { const target = artifacts.find((artifact) => artifact.id === artifactId); if (target !== undefined) setFocus(campaignId, target.id); }} onPatch={(next) => { void patchSession(next); }} />
          )}

          {active !== undefined && (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <label htmlFor="quick-log" className="text-sm font-semibold text-muted-foreground">
                Quick log
              </label>
              <Input
                id="quick-log"
                value={logText}
                placeholder="What just happened? (Enter)"
                onChange={(event) => {
                  setLogText(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || logText.trim() === '') return;
                  const data = active.data;
                  const time = new Date().toTimeString().slice(0, 5);
                  void patchSession({ ...data, log: `${data.log}- ${time} ${logText.trim()}\n` });
                  setLogText('');
                }}
              />
              <div className="min-h-0 flex-1 overflow-y-auto text-sm">
                <Markdown>{active.data.log}</Markdown>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function SessionChecklist({
  session,
  onJump,
  onPatch,
}: {
  session: Artifact;
  onJump: (artifactId: string) => void;
  onPatch: (next: SessionArtifactData) => void;
}): JSX.Element {
  const data = session.data as SessionArtifactData;
  return (
    <div className="flex flex-col gap-1" data-testid="scene-checklist">
      <h3 className="text-sm font-semibold text-muted-foreground">Scenes</h3>
      {data.scenes.length === 0 && (
        <p className="text-sm text-muted-foreground">No scenes planned.</p>
      )}
      {data.scenes.map((scene, index) => (
        <div key={index} className="flex items-center gap-2">
          <Button
            variant={scene.done ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={`Scene: ${scene.title}${scene.done ? ' (done)' : ''}`}
            onClick={() => {
              const next = data.scenes.map((s, i) => (i === index ? { ...s, done: !s.done } : s));
              onPatch({ ...data, scenes: next });
            }}
          >
            {scene.done && <CheckIcon aria-hidden className="size-4" />}
          </Button>
          <span className={scene.done ? 'text-muted-foreground line-through' : ''}>{scene.title}</span>
          {scene.artifactId !== null && (
            <Button variant="ghost" size="icon-sm" aria-label={`Focus scene ${scene.title}`} onClick={() => { onJump(scene.artifactId ?? ''); }}>
              <PinIcon aria-hidden className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
