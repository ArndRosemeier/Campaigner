import { useState } from 'react';
import type { JSX } from 'react';
import { UsersIcon } from 'lucide-react';

import { artifactRepo } from '@/db';
import {
  blankArtifactData,
  pcDataSchema,
  type Id,
  type PcArtifactData,
} from '@/domain';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * THE party wizard (owner-directed, docs/17 row 334, verbatim: *"i would like
 * to have a party wizard to quickly add a party to a campaign. It should ask 2
 * questions per character. Name and initiative bonus, with a done button that
 * stops adding more characters, to quickly onboard a party. Give every
 * character 20 hp and no stat block."*).
 *
 * It is mounted by the campaign tree's **Party** (`pc`) region header and owns
 * BOTH halves of the affordance — the always-visible control and its dialog —
 * so a caller mounts ONE component and there is no second place where "the
 * party wizard is open" lives (AGENTS rule 4).
 *
 * TWO QUESTIONS, ONE WRITE EACH. "Add character" creates the row IMMEDIATELY
 * through the tree's own creation seam (`db/artifactRepo.createArtifact`), so a
 * failure is loud where it happens, the new player shows up in the tree as
 * feedback, and nothing is lost if the dialog is closed — there is no batch and
 * no draft. Then both fields clear and focus returns to Name for the next
 * character. **Done** ends the loop and closes; it creates nothing itself.
 *
 * THE DATA IS THE BLANK PC, WITH ONE FIELD REPLACED. `wizardPcData` starts from
 * `domain/create.blankArtifactData('pc')` — the ONE blank-data seam, which
 * carries the owner's row-308 rule (`currentHp: 20`, `statBlock: null`) — and
 * overrides ONLY `initiativeOverride`, THE statless-PC initiative field
 * (`domain/battle.ts`: a statless PC's bonus is exactly
 * `initiativeOverride ?? 0`). HP and the stat block are never typed here, so
 * this surface cannot become a second way to create a 0-HP or statful player.
 *
 * REFUSALS ARE LOUD AND CREATE NOTHING (AGENTS rule 1; the brief): a blank or
 * whitespace-only name refuses with a named sentence and no row — never a
 * "New Player"-class placeholder — and a bonus that is not a whole number
 * (blank included) refuses the same way. Negative bonuses are LEGAL: a slow
 * character is real. Duplicate names are ALLOWED (this project has no
 * uniqueness rule for names) and nothing else is asked or set.
 */
export function PartyWizard({ campaignId }: { campaignId: Id }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [initiative, setInitiative] = useState('');
  /** One submit at a time: a second press while the write is in flight is ignored. */
  const [busy, setBusy] = useState(false);
  /**
   * Bumped after every successful add. The `components/ui/input` wrapper is a
   * plain function component (its props are spread onto base-ui's Input, but a
   * React 18 `ref` never reaches a function component's props), so the Name
   * field is remounted with the same `autoFocus` it opens with instead of being
   * focused through a ref — one mechanism, not a second focus path.
   */
  const [nameFieldNonce, setNameFieldNonce] = useState(0);

  /**
   * Closing — by Done, the close button, Escape or the overlay — resets the two
   * answers, so reopening starts a clean character and a stale half-typed name
   * is never carried into the next party.
   */
  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      setName('');
      setInitiative('');
    }
  }

  async function handleAdd(): Promise<void> {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      toastError('A character needs a name — nothing was created.');
      return;
    }
    const bonusText = initiative.trim();
    const bonus = Number(bonusText);
    if (bonusText === '' || !Number.isInteger(bonus)) {
      toastError(
        'The initiative bonus must be a whole number (a negative one is fine) — nothing was created.',
      );
      return;
    }
    setBusy(true);
    try {
      await artifactRepo.createArtifact({
        campaignId,
        kind: 'pc',
        name: trimmed,
        data: wizardPcData(bonus),
      });
      toastSuccess(`${trimmed} joined the party`);
      setName('');
      setInitiative('');
      // Remount the Name field so its `autoFocus` puts the caret back for the
      // next character (see `nameFieldNonce`).
      setNameFieldNonce((nonce) => nonce + 1);
    } catch (error) {
      toastError('Could not add the character', error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        data-testid="party-wizard-open"
        aria-label="Add a party"
        onClick={() => {
          setOpen(true);
        }}
      >
        <UsersIcon aria-hidden data-icon="inline-start" />
        Add party…
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {open && (
          <DialogContent data-testid="party-wizard-dialog">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleAdd();
              }}
            >
              <DialogHeader>
                <DialogTitle>Add a party</DialogTitle>
                <DialogDescription>
                  Two questions per character: name and initiative bonus. Each “Add character”
                  creates that player right away; press Done when the party is complete.
                </DialogDescription>
              </DialogHeader>
              <div className="my-2 flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Name
                  <Input
                    key={nameFieldNonce}
                    value={name}
                    autoFocus
                    aria-label="Character name"
                    autoCapitalize="words"
                    autoCorrect="off"
                    enterKeyHint="next"
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Initiative bonus
                  <Input
                    type="number"
                    value={initiative}
                    step={1}
                    aria-label="Initiative bonus"
                    enterKeyHint="done"
                    onChange={(event) => {
                      setInitiative(event.target.value);
                    }}
                  />
                </label>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="party-wizard-done"
                  onClick={() => {
                    handleOpenChange(false);
                  }}
                >
                  Done
                </Button>
                <Button type="submit" data-testid="party-wizard-add" disabled={busy}>
                  Add character
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/**
 * The wizard's ONE data build: the blank PC — `blankArtifactData('pc')`, the
 * creator that owns the owner's row-308 defaults (HP 20 and no stat block) —
 * parsed to its `pc` arm and with ONLY the second question's answer
 * (`initiativeOverride`) replaced. Re-typing HP or a stat block here is exactly
 * the drift the brief forbids, so they are read from the seam, never written.
 */
function wizardPcData(initiativeBonus: number): PcArtifactData {
  return {
    ...pcDataSchema.parse(blankArtifactData('pc')),
    initiativeOverride: initiativeBonus,
  };
}
