import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { UserPlusIcon, UsersIcon, Wand2Icon, XIcon } from 'lucide-react';

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
import type { Campaign, EntityKind } from '@/domain';
import { artifactRepo } from '@/db';
import { classifyEntityKind } from '@/llm/moduleGen';
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
};

/**
 * Stub popover (08-MODULE-DESIGNER M4-C): the actions behind an unresolved
 * chip — create a minimal artifact (name, first-occurrence sentence as
 * summary, `module:<title>` tag), send it to a persona (workspace, prefilled),
 * or link it to an existing artifact (adds the link name as alias).
 * Rendered as a small anchored card; dismiss via Esc or the backdrop.
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
  campaign,
  recordedKind,
  onClose,
  onLinkExisting,
}: StubPopoverProps): JSX.Element {
  // The kind is the MODEL's record when it exists; hand-typed names get a
  // one-shot classification call (regex below is only the instant
  // placeholder while that call is in flight — 08 §M4-C).
  const [kind, setKind] = useState<StubKind>(recordedKind ?? guessKindFromSentence(sentence));
  const [name, setName] = useState(state.name);
  const [busy, setBusy] = useState(false);
  /** True once the user picked a kind by hand — the async classification
   * must never clobber a manual choice. */
  const userPickedRef = useRef(false);

  useEffect(() => {
    if (recordedKind !== undefined) return;
    let alive = true;
    classifyEntityKind(state.name, contextParagraphs, premise)
      .then((classified) => {
        if (alive && !userPickedRef.current) setKind(classified);
      })
      .catch((error: unknown) => {
        // Loud per AGENTS rule 2; the fallback guess stays selectable.
        toastError('Could not auto-detect the entity kind — pick one below', error);
      });
    return () => {
      alive = false;
    };
  }, [recordedKind, state.name, contextParagraphs, premise]);
  async function createStub(): Promise<void> {
    setBusy(true);
    try {
      await artifactRepo.createArtifact({
        campaignId: campaign.id,
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
    setGenerating(true);
    try {
      const result = await generateSingleEntity({
        campaign,
        kind,
        name: name.trim(),
        contextParagraphs,
        premise,
        moduleTag,
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
            disabled={busy || name.trim() === ''}
            data-testid="stub-create"
            onClick={() => void createStub()}
          >
            <UserPlusIcon aria-hidden data-icon="inline-start" />
            Create stub
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={generating || busy || name.trim() === ''}
            data-testid="stub-generate"
            onClick={() => void generateInPlace()}
          >
            <Wand2Icon aria-hidden data-icon="inline-start" />
            {generating ? 'Generating…' : 'Generate'}
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
