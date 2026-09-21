import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { LinkIcon, UserPlusIcon, UsersIcon, Wand2Icon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BlockedControl } from '@/components/blocked-control';
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
import { moduleCreationPool, aliasCollisionSentence, sameAliasName } from '@/domain';
import { artifactRepo } from '@/db';
import { classifyEntityName } from '@/llm/moduleGen';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { promoteArtifactForModuleUseLoud } from '@/db/artifactAutoPromote';
import { generateSingleEntity } from '@/features/modules/entity-detail';
import { STUB_KINDS, type StubKind } from '@/features/modules/persona-request';
import { toastError, toastSuccess } from '@/lib/toast';

const STUB_KIND_LABELS: Readonly<Record<StubKind, string>> = {
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
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

/** The one sentence the popover's `busy` gates state (above `StubPopover`). */
const POPOVER_SAVE_REASON = 'A save from this popover is still running — wait for it to finish.';

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
  // The kind is the MODEL's record when it exists; a hand-typed name gets the
  // one-shot normalization call below (fix-01) and NOTHING ELSE decides it. The
  // state starts UNSELECTED for a hand-typed name, so the select shows
  // "Classifying…" while the call is in flight — the pre-293 English keyword
  // regex (`guessKindFromSentence`) presented a guess as the default and is
  // DELETED (docs/17 row 293, AGENTS rule 5: free text is read by the model,
  // never by a pattern). No kind is ever invented, and a failed call leaves the
  // choice to the owner with the failure named on this surface.
  const [kind, setKind] = useState<StubKind | null>(recordedKind ?? null);
  const [name, setName] = useState(state.name);
  const [busy, setBusy] = useState(false);
  /** fix-01: the normalization verdict — which canonical entity this name
   * refers to, and its kind. Null while the call is in flight/failed. */
  const [verdict, setVerdict] = useState<{ kind: StubKind; canonical: string } | null>(null);
  /** The classification call failed: the kind stays UNSELECTED and the failure
   * is visible here (AGENTS rule 2) — never a silent fall-through to a default
   * kind. Reset when a new name/context asks again. */
  const [classifyFailed, setClassifyFailed] = useState(false);
  const [canonicalArtifactName, setCanonicalArtifactName] = useState<string | null>(null);
  /** True once the user picked a kind by hand — the async classification
   * must never clobber a manual choice. */
  const userPickedRef = useRef(false);
  /** fix-01: the two-step confirm state for overriding the model's verdict —
   * "create/generate as a separate entity" must be a deliberate act. */
  const [armedCreate, setArmedCreate] = useState(false);
  const [armedGenerate, setArmedGenerate] = useState(false);
  /**
   * WHY the three gated controls below cannot act (docs/18 §2.3, docs/05 §Why a
   * control cannot act): `busy` is this popover's own save flag — `linkToCanonical`
   * and `createStub` both raise it — and the sentence is computed from that SAME
   * flag, so a reason can never disagree with the state it explains. It names the
   * way out honestly: both are local database writes with no cancel seam, so the
   * way out is to wait.
   *
   * First true condition wins, per control:
   * - the verdict link and "Create stub" gate on `busy` first (the empty-name
   *   and unselected-kind halves of their gates are self-evident — the empty
   *   field, the select's own "Classifying…"/"Choose a kind…" placeholder — and
   *   get no reason; an unselected kind is additionally NAMED by
   *   `stub-kind-failed` when the classification failed, docs/17 row 293);
   * - "Generate" gates on `generating` FIRST, and in that state its OWN label
   *   reads "Generating…" — self-evident, so no reason is attached then.
   */
  function popoverBlockedReason(isBusy: boolean, generatingInPlace: boolean): string | null {
    if (generatingInPlace) return null;
    return isBusy ? POPOVER_SAVE_REASON : null;
  }

  useEffect(() => {
    if (recordedKind !== undefined) return;
    let alive = true;
    // A new name/context asks the model again: the kind is unselected until the
    // verdict answers (or the owner picks), and a previous failure is cleared.
    setClassifyFailed(false);
    listArtifactsByCampaign(campaign.id)
      .then(async (rows) => {
        // Hand-typed-name classification is module creation: the candidate set
        // is the module-creation pool (docs/17 row 69) — the Party is
        // invisible, so a name equal to a player character's becomes a NEW
        // module-owned entity. Deliberately linking a PC stays available
        // through "Use existing entity…", which is an explicit user choice.
        const artifacts = moduleCreationPool(rows);
        const classified = await classifyEntityName(
          state.name,
          contextParagraphs,
          premise,
          artifacts.map((artifact) => artifact.name),
        );
        if (!alive) return;
        const canonical = artifacts.find(
          (artifact) => sameAliasName(artifact.name, classified.canonical),
        );
        setCanonicalArtifactName(canonical?.name ?? null);
        if (!userPickedRef.current) setKind(classified.kind);
        setVerdict({ kind: classified.kind, canonical: classified.canonical });
      })
      .catch((error: unknown) => {
        // Loud per AGENTS rules 1-2: the kind stays UNSELECTED (no invented
        // default) and the failure is named BOTH on this surface and in the
        // toast — Create/Generate cannot act until a kind exists.
        if (!alive) return;
        setClassifyFailed(true);
        toastError('Could not auto-detect the entity kind — pick one below', error);
      });
    return () => {
      alive = false;
    };
  }, [recordedKind, state.name, contextParagraphs, premise, campaign.id]);

  /**
   * fix-01: default action when the verdict resolves to an existing artifact —
   * alias-add the name onto that artifact (same as "Use existing entity…"), never a
   * second stub. Only a variant needs the alias; a name equal to the
   * artifact's own spelling already resolves.
   */
  async function linkToCanonical(): Promise<void> {
    if (canonicalArtifactName === null) return;
    setBusy(true);
    try {
      const artifacts = moduleCreationPool(await listArtifactsByCampaign(campaign.id));
      const artifact = artifacts.find(
        (candidate) => sameAliasName(candidate.name, canonicalArtifactName),
      );
      if (artifact === undefined) throw new Error(`the artifact "${canonicalArtifactName}" vanished`);
      const alias = name.trim();
      // The ONE alias write path (`artifactRepo.addArtifactAliases` — the merge
      // rule of `domain/artifactAlias`: trimmed, case-insensitive, never a
      // duplicate, never the artifact's own name, and NO write at all when the
      // pool already answers, which is the "needsAlias" guard this call
      // replaces). Since docs/17 row 226 a name ANOTHER artifact answers is
      // refused instead of stored, and the refusal is spoken here — the alias
      // would otherwise resolve the link to the wrong row (AGENTS rule 1).
      const { refused } = await artifactRepo.addArtifactAliases(artifact.id, [alias]);
      if (refused.length > 0) {
        for (const collision of refused) {
          toastError(
            'A name belongs to another artifact — not attached as an alias',
            new Error(aliasCollisionSentence(collision)),
          );
        }
        return;
      }
      // LINKS hook: this module just referenced another scope's artifact by
      // alias-linking — a second-module use promotes it to shared campaign
      // ownership (no-op when already shared or own-module).
      await promoteArtifactForModuleUseLoud(artifact.id, moduleId);
      toastSuccess(`“${alias}” now resolves to ${artifact.name}`);
      onClose();
    } catch (error) {
      toastError(`Could not use "${canonicalArtifactName}" for "${name.trim()}"`, error);
    } finally {
      setBusy(false);
    }
  }

  async function createStub(): Promise<void> {
    // The control is DISABLED while the kind is unselected, so this is
    // unreachable from the UI — the guard is what makes "a stub is never
    // written with an invented kind" a property of the code, not of the
    // button's disabled attribute (docs/17 row 293).
    if (kind === null) return;
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
    // Same guard as `createStub`: an unselected kind can never reach a
    // generation (docs/17 row 293).
    if (kind === null) return;
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
              {!sameAliasName(verdict.canonical, state.name)
                ? ' — using the existing entity keeps the story consistent'
                : ''}
              .
            </p>
          )}
          {canonicalArtifactName !== null && (
            <BlockedControl
              testId="stub-link-verdict"
              reason={popoverBlockedReason(busy, false)}
            >
              <Button
                size="sm"
                disabled={busy}
                data-testid="stub-link-verdict"
                onClick={() => void linkToCanonical()}
              >
                <LinkIcon aria-hidden data-icon="inline-start" />
                Use “{canonicalArtifactName}”
              </Button>
            </BlockedControl>
          )}
          <div className="flex items-center gap-2">
            <Label htmlFor="stub-name" className="shrink-0 text-xs">
              Name
            </Label>
            <Input
              id="stub-name"
              value={name}
              className="h-7 text-xs"
              autoCapitalize="words"
              autoCorrect="off"
              enterKeyHint="done"
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
              <SelectTrigger
                id="stub-kind"
                size="sm"
                className="flex-1 pointer-coarse:text-base"
                data-testid="stub-kind"
              >
                {/* No kind is selected until the MODEL's verdict (or the
                    owner's pick) supplies one: the empty start is honest where
                    the deleted English-keyword guess was not (docs/17 row 293,
                    AGENTS rule 5). */}
                <SelectValue placeholder={classifyFailed ? 'Choose a kind…' : 'Classifying…'} />
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
          {classifyFailed && kind === null && (
            <p className="text-xs text-destructive" data-testid="stub-kind-failed">
              The model could not classify this name — pick a kind above.
            </p>
          )}

          <BlockedControl testId="stub-create" reason={popoverBlockedReason(busy, false)}>
            <Button
              size="sm"
              variant={armedCreate ? 'destructive' : 'default'}
              disabled={busy || kind === null || name.trim() === ''}
              data-testid="stub-create"
              data-armed={armedCreate || undefined}
              onClick={() => void createStub()}
            >
              <UserPlusIcon aria-hidden data-icon="inline-start" />
              {armedCreate ? 'Create as a separate entity — confirm?' : 'Create stub'}
            </Button>
          </BlockedControl>
          <BlockedControl testId="stub-generate" reason={popoverBlockedReason(busy, generating)}>
            <Button
              size="sm"
              variant="outline"
              disabled={generating || busy || kind === null || name.trim() === ''}
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
          </BlockedControl>
          <Button
            size="sm"
            variant="outline"
            disabled={name.trim() === ''}
            onClick={() => {
              onLinkExisting(name.trim());
            }}
          >
            <UsersIcon aria-hidden data-icon="inline-start" />
            Use existing entity…
          </Button>
        </div>

        {sentence !== '' && (
          <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{sentence}</p>
        )}
      </div>
    </div>
  );
}
