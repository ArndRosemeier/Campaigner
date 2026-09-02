import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { LinkIcon, UserPlusIcon, UsersIcon, Wand2Icon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Campaign, EntityKind, Id } from '@/domain';
import { artifactRepo } from '@/db';
import { classifyEntityName } from '@/llm/moduleGen';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { generateSingleEntity } from '@/features/modules/entity-detail';
import {
  guessKindFromSentence,
  STUB_KINDS,
  type StubKind,
} from '@/features/modules/persona-request';
import { toastError, toastSuccess } from '@/lib/toast';

const STUB_KIND_LABELS: Readonly<Record<StubKind, string>> = {
  npc: 'NPC',
  location: 'Location',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
};

/**
 * Stub popover (08-MODULE-DESIGNER M4-C; verdict flow amended by fix-01): the
 * actions behind an unresolved chip — create a minimal artifact (name,
 * first-occurrence sentence as summary, `module:<title>` tag), send it to a
 * persona (workspace, prefilled), or link it to an existing artifact (adds
 * the link name as alias). For hand-typed names the one-shot normalization
 * verdict may resolve the name onto an existing artifact: the popover then
 * DEFAULTS to alias-linking (never a second stub), and creating/generating a
 * standalone entity requires the inline two-step confirm. Rendered as a
 * small anchored card; dismiss via Esc or the backdrop.
 */

export interface StubPopoverState {
  name: string;
  /** Click position (client coordinates) for anchoring. */
  x: number;
  y: number;
}

export interface StubPopoverProps {
  state: StubPopoverState;
  sentence: string;
  contextParagraphs: string;
  premise: string;
  moduleTag: string;
  /** The creating module — the stub is OWNED by it (10-MILESTONE-6 M6-B). */
  moduleId: Id;
  campaign: Campaign;
  /** The kind the generator recorded for this name, when it knows one. */
  recordedKind?: EntityKind | undefined;
  onClose: () => void;
  /** Opens the link-existing picker for this name (parent-driven). */
  onLinkExisting: (name: string) => void;
}

export function StubPopover({
  state,
  sentence,
  contextParagraphs,
  premise,
  moduleTag,
  moduleId,
  campaign,
  recordedKind,
  onClose,
  onLinkExisting,
}: StubPopoverProps): JSX.Element {
  // The kind is the MODEL's record when it exists; hand-typed names get a
  // one-shot normalization call (regex below is only the instant placeholder
  // while that call is in flight — 08 §M4-C; fix-01 extends the verdict with
  // the canonical entity the name refers to).
  const [kind, setKind] = useState<StubKind>(recordedKind ?? guessKindFromSentence(sentence));
  const [name, setName] = useState(state.name);
  const [busy, setBusy] = useState(false);
  /** fix-01: the normalization verdict — which canonical entity this name
   * refers to, and its kind. Null while the call is in flight/failed. */
  const [verdict, setVerdict] = useState<{ kind: StubKind; canonical: string } | null>(null);
  const [canonicalArtifactName, setCanonicalArtifactName] = useState<string | null>(null);
  /** True once the user picked a kind by hand — the async classification
   * must never clobber a manual choice. */
  const userPickedRef = useRef(false);
  /** fix-01: the two-step confirm state for overriding the model's verdict —
   * "create/generate as a separate entity" must be a deliberate act. */
  const [armedCreate, setArmedCreate] = useState(false);
  const [armedGenerate, setArmedGenerate] = useState(false);

  useEffect(() => {
    if (recordedKind !== undefined) return;
    let alive = true;
    listArtifactsByCampaign(campaign.id)
      .then(async (artifacts) => {
        const classified = await classifyEntityName(
          state.name,
          contextParagraphs,
          premise,
          artifacts.map((artifact) => artifact.name),
        );
        if (!alive) return;
        const canonical = artifacts.find(
          (artifact) => artifact.name.trim().toLowerCase() === classified.canonical.trim().toLowerCase(),
        );
        setCanonicalArtifactName(canonical?.name ?? null);
        if (!userPickedRef.current) setKind(classified.kind);
        setVerdict({ kind: classified.kind, canonical: classified.canonical });
      })
      .catch((error: unknown) => {
        // Loud per AGENTS rule 2; the fallback guess stays selectable.
        toastError('Could not auto-detect the entity kind — pick one below', error);
      });
    return () => {
      alive = false;
    };
  }, [recordedKind, state.name, contextParagraphs, premise, campaign.id]);

  /**
   * fix-01: default action when the verdict resolves to an existing artifact —
   * alias-add the name onto that artifact (same as "Link existing…"), never a
   * second stub. Only a variant needs the alias; a name equal to the
   * artifact's own spelling already resolves.
   */
  async function linkToCanonical(): Promise<void> {
    if (canonicalArtifactName === null) return;
    setBusy(true);
    try {
      const artifacts = await listArtifactsByCampaign(campaign.id);
      const artifact = artifacts.find(
        (candidate) => candidate.name.trim().toLowerCase() === canonicalArtifactName.trim().toLowerCase(),
      );
      if (artifact === undefined) throw new Error(`the artifact "${canonicalArtifactName}" vanished`);
      const alias = name.trim();
      const needsAlias =
        alias.toLowerCase() !== artifact.name.trim().toLowerCase() &&
        !artifact.aliases.some((existing) => existing.trim().toLowerCase() === alias.toLowerCase());
      if (needsAlias) {
        await artifactRepo.updateArtifact(artifact.id, { aliases: [...artifact.aliases, alias] });
      }
      toastSuccess(`“${alias}” now resolves to ${artifact.name}`);
      onClose();
    } catch (error) {
      toastError(`Could not link "${name.trim()}" to "${canonicalArtifactName}"`, error);
    } finally {
      setBusy(false);
    }
  }

  async function createStub(): Promise<void> {
    if (canonicalArtifactName !== null && !armedCreate) {
      // Overriding the model's verdict is a two-step act (fix-01).
      setArmedCreate(true);
      return;
    }
    setBusy(true);
    try {
      await artifactRepo.createArtifact({
        campaignId: campaign.id,
        moduleId,
        kind,
        name: name.trim(),
        summary: sentence,
        tags: [moduleTag],
      });
      toastSuccess(`Stub "${name.trim()}" created`);
      onClose();
    } catch (error) {
      toastError('Could not create the stub', error);
    } finally {
      setBusy(false);
    }
  }

  const [generating, setGenerating] = useState(false);

  /**
   * Generates in place (08-MODULE-DESIGNER M4-C): the reader used to navigate
   * to the workspace with a prefilled persona panel — from the reader it
   * looked like the app closed the view and did nothing. Now the same chain
   * machinery as the batch runs here, visible on the shared progress bar.
   */
  async function generateInPlace(): Promise<void> {
    if (canonicalArtifactName !== null && !armedGenerate) {
      // Overriding the model's verdict is a two-step act (fix-01).
      setArmedGenerate(true);
      return;
    }
    setGenerating(true);
    try {
      const result = await generateSingleEntity({
        campaign,
        kind,
        name: name.trim(),
        contextParagraphs,
        premise,
        moduleTag,
        moduleId,
      });
      if (!result.ok) {
        toastError(`Could not generate "${name.trim()}"`, result.error);
        return; // keep the popover open — the user may retry or create a stub
      }
      toastSuccess(`"${name.trim()}" detailed`);
      onClose();
    } catch (error) {
      toastError(`Could not generate "${name.trim()}"`, error);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onKeyDown={(event) => {
      if (event.key === 'Escape') onClose();
    }}>
      <div
        className="absolute rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        style={{ left: state.x, top: state.y, maxWidth: 320 }}
        data-testid="stub-popover"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">“{state.name}” is not detailed yet</p>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </div>

        <div className="mt-2 flex flex-col gap-2">
          {verdict !== null && canonicalArtifactName !== null && (
            <p
              className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
              data-testid="stub-verdict"
            >
              The model resolved this to the existing entity “{canonicalArtifactName}”
              {verdict.canonical.trim().toLowerCase() !== state.name.trim().toLowerCase()
                ? ' — linking keeps the story consistent'
                : ''}
              .
            </p>
          )}
          {canonicalArtifactName !== null && (
            <Button
              size="sm"
              disabled={busy}
              data-testid="stub-link-verdict"
              onClick={() => void linkToCanonical()}
            >
              <LinkIcon aria-hidden data-icon="inline-start" />
              Link to “{canonicalArtifactName}”
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Label htmlFor="stub-name" className="shrink-0 text-xs">
              Name
            </Label>
            <Input
              id="stub-name"
              value={name}
              className="h-7 text-xs"
              onChange={(event) => {
                setName(event.target.value);
                setArmedCreate(false);
                setArmedGenerate(false);
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="stub-kind" className="shrink-0 text-xs">
              Kind
            </Label>
            <Select
              value={kind}
              onValueChange={(next) => {
                if (next !== null) {
                  userPickedRef.current = true;
                  setKind(next);
                }
              }}
            >
              <SelectTrigger id="stub-kind" size="sm" className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STUB_KINDS.map((stubKind) => (
                  <SelectItem key={stubKind} value={stubKind}>
                    {STUB_KIND_LABELS[stubKind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            size="sm"
            variant={armedCreate ? 'destructive' : 'default'}
            disabled={busy || name.trim() === ''}
            data-testid="stub-create"
            data-armed={armedCreate || undefined}
            onClick={() => void createStub()}
          >
            <UserPlusIcon aria-hidden data-icon="inline-start" />
            {armedCreate ? 'Create as a separate entity — confirm?' : 'Create stub'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={generating || busy || name.trim() === ''}
            data-testid="stub-generate"
            data-armed={armedGenerate || undefined}
            onClick={() => void generateInPlace()}
          >
            <Wand2Icon aria-hidden data-icon="inline-start" />
            {generating
              ? 'Generating…'
              : armedGenerate
                ? 'Generate as a separate entity — confirm?'
                : 'Generate'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={name.trim() === ''}
            onClick={() => {
              onLinkExisting(name.trim());
            }}
          >
            <UsersIcon aria-hidden data-icon="inline-start" />
            Link existing…
          </Button>
        </div>

        {sentence !== '' && (
          <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{sentence}</p>
        )}
      </div>
    </div>
  );
}
