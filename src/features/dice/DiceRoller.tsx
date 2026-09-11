import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { Button } from '@/components/ui/button';
import { BlockedControl } from '@/components/blocked-control';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toastError } from '@/lib/toast';

import { buildNotation, countPercentileDice, dieDisplayName, formatTraySummary, parseStoredTray, sumRollTotal } from './math';
import { useDiceEngine } from './useDiceEngine';
import {
  EMPTY_TRAY,
  LAST_TRAY_STORAGE_KEY,
  MODIFIER_STEPS,
  STANDARD_DICE,
  type DiceRollResult,
  type DiceTray,
  type DieSides,
  type ModifierStep,
  type RollIntent,
} from './types';

/**
 * The reusable dice roller (09-MILESTONE-5 M5-D amendment): a tray picker
 * (all standard dice + ± modifier steppers) over a lazy 3D engine, with a
 * full-screen settled result. Controlled via `open`; the caller decides what
 * a result means through `onResult` — damage, heal, or any future roll — so
 * this component never touches HP or battle state itself. The 3D engine is
 * dynamic-imported on first open (zero bundle cost until then) and every
 * engine failure is loud: inline status + toast, dice rolls blocked, flat
 * modifier rolls unaffected (AGENTS.md: no silent fallbacks).
 */

const LOG_LIMIT = 3;

/**
 * WHY the tray picker's Roll button cannot act (docs/18 §2.3, docs/05 §Why a
 * control cannot act). The gate is `!canRoll || diceBlocked`, and the reasons
 * read those SAME flags in that order:
 *
 * - `!canRoll` (an empty tray) is SELF-EVIDENT and gets no reason at all —
 *   there is nothing to roll (pinned in tests/features/dice-roller.test.tsx);
 * - `diceBlocked` is the tray HOLDING dice while the 3D engine cannot run them.
 *   Its two sub-states have two different ways out, so the reason distinguishes
 *   them: a failure names the Retry button rendered beside the status line, and
 *   loading (or the single render before the open effect starts the engine)
 *   names waiting — never a Stop, because the engine start has no cancel seam.
 *   A flat modifier-only tray is deliberately NOT blocked (`diceBlocked`
 *   requires dice), which is why this reason never fires for one.
 */
const DICE_ENGINE_LOADING_REASON =
  'The 3D dice engine is not ready yet — wait for it, then press Roll.';
const DICE_ENGINE_ERROR_REASON =
  'The 3D dice engine could not start — press Retry (above) to try again.';

/** The FIRST true condition of the Roll gate that is not self-evident. */
function rollBlockedReason(
  canRoll: boolean,
  diceBlocked: boolean,
  engineError: string | null,
): string | null {
  if (!canRoll) return null;
  if (!diceBlocked) return null;
  return engineError === null ? DICE_ENGINE_LOADING_REASON : DICE_ENGINE_ERROR_REASON;
}

interface ActiveRoll {
  total: number;
  summary: string;
  /** True only for engine throws — flat modifier values settle engine-free
   * and must never raise the 3D stage (an empty physics table behind the
   * number would read as a broken throw, not a clean flat result). */
  dice: boolean;
}

interface LogEntry {
  id: string;
  total: number;
  summary: string;
}

export interface DiceRollerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent?: RollIntent | undefined;
  onResult?: ((result: DiceRollResult) => void) | undefined;
}

export function DiceRoller({ open, onOpenChange, intent, onResult }: DiceRollerProps): JSX.Element {
  const engine = useDiceEngine();
  const [tray, setTray] = useState<DiceTray>(EMPTY_TRAY);
  const [roll, setRoll] = useState<ActiveRoll | null>(null);
  // True while the 3D engine owns the board: the stage fades in for the
  // whole physics throw, not just the settled result — binding the stage to
  // the result alone played the animation behind an `opacity-0` div (the
  // roll promise resolves only after the dice settle), so the user never
  // saw a single frame and got the flat overlay number instead.
  const [rolling, setRolling] = useState(false);
  const [rollError, setRollError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const pendingTrayRef = useRef<{ tray: DiceTray } | null>(null);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  // Open side: warm the 3D engine (idempotent) and restore the last-used
  // tray — a genuine user preference; a corrupt storage entry is discarded
  // in favor of the sanctioned fresh-tray default, never surfaced as data.
  // A roll failure set `rollError` right before reopening — it must survive
  // this effect, so it clears only on tray edits, a successful roll, or
  // Retry, never on open.
  useEffect(() => {
    if (!open) {
      return;
    }
    engine.ensureStarted();
    const readStored = (): string | null => {
      try {
        return window.localStorage.getItem(LAST_TRAY_STORAGE_KEY);
      } catch {
        return null;
      }
    };
    const raw = readStored();
    if (raw !== null) {
      try {
        const parsed = parseStoredTray(JSON.parse(raw) as unknown);
        if (parsed !== null) {
          setTray(parsed);
        }
      } catch {
        // Not JSON — stale foreign entry; the fresh-tray default applies.
      }
    }
    // engine.ensureStarted is stable (useCallback on stable deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const clearRollError = useCallback((): void => {
    setRollError(null);
  }, []);

  const addDie = useCallback(
    (sides: DieSides): void => {
      clearRollError();
      setTray((current) => ({ ...current, dice: [...current.dice, { id: crypto.randomUUID(), sides }] }));
    },
    [clearRollError],
  );

  const removeDie = useCallback(
    (id: string): void => {
      clearRollError();
      setTray((current) => ({ ...current, dice: current.dice.filter((die) => die.id !== id) }));
    },
    [clearRollError],
  );

  const addModifier = useCallback(
    (amount: ModifierStep, sign: -1 | 1): void => {
      clearRollError();
      setTray((current) => ({ ...current, modifier: current.modifier + sign * amount }));
    },
    [clearRollError],
  );

  const clearModifier = useCallback((): void => {
    clearRollError();
    setTray((current) => ({ ...current, modifier: 0 }));
  }, [clearRollError]);

  const clearTray = useCallback((): void => {
    clearRollError();
    setTray(EMPTY_TRAY);
  }, [clearRollError]);

  const retryEngine = useCallback((): void => {
    clearRollError();
    engine.retry();
  }, [clearRollError, engine]);

  const persistRolledTray = useCallback((rolled: DiceTray): void => {
    try {
      window.localStorage.setItem(LAST_TRAY_STORAGE_KEY, JSON.stringify(rolled));
    } catch (storageError: unknown) {
      // Preference write failed (private mode/quota) — the roll still stands.
      toastError('Could not remember the last dice tray', storageError);
    }
  }, []);

  // Function boundary: TS narrows ref properties across awaits, so the
  // nullable read must happen inside a fresh scope.
  const takePendingTray = useCallback((): DiceTray => {
    const pending = pendingTrayRef.current;
    pendingTrayRef.current = null;
    return pending === null ? EMPTY_TRAY : pending.tray;
  }, []);

  const finishRoll = useCallback(
    (total: number, summary: string, perDie: number[], rolled: DiceTray, dice: boolean): void => {
      setRoll({ total, summary, dice });
      setRollError(null);
      setLog((current) => [{ id: crypto.randomUUID(), total, summary }, ...current].slice(0, LOG_LIMIT));
      persistRolledTray(rolled);
      onResultRef.current?.({ total, summary, perDie });
    },
    [persistRolledTray],
  );

  const startRoll = useCallback(async (): Promise<void> => {
    if (tray.dice.length === 0 && tray.modifier === 0) {
      return; // Roll is disabled in this state; defensive no-op.
    }
    const summary = formatTraySummary(tray);
    // Both paths hand over to the result overlay, so the picker closes now —
    // base-ui keeps the page behind an open dialog inert, which would trap
    // the overlay otherwise.
    onOpenChange(false);
    if (tray.dice.length === 0) {
      // Flat value: engine-free, settles instantly.
      finishRoll(tray.modifier, summary, [], tray, false);
      setTray(EMPTY_TRAY);
      return;
    }
    if (engine.status !== 'ready') {
      setRollError(engine.error ?? '3D dice are not ready yet');
      onOpenChange(true);
      return;
    }
    pendingTrayRef.current = { tray };
    const notation = buildNotation(tray.dice);
    const percentileCount = countPercentileDice(tray.dice);
    const modifier = tray.modifier;
    setRolling(true);
    try {
      const dieResults = await engine.rollDice(notation);
      const total = sumRollTotal(dieResults, modifier, percentileCount);
      const rolled = takePendingTray();
      finishRoll(total, summary, dieResults.map((die) => die.value), rolled, true);
    } catch (error) {
      // Loud: the picker reopens with the tray intact and the failure shown.
      pendingTrayRef.current = null;
      setTray(tray);
      setRollError(error instanceof Error ? error.message : 'Dice roll failed');
      toastError('Dice roll failed', error);
      onOpenChange(true);
    } finally {
      setRolling(false);
    }
  }, [engine, finishRoll, onOpenChange, takePendingTray, tray]);

  const dismissRoll = useCallback((): void => {
    engine.clearDice();
    setRoll(null);
  }, [engine]);

  const canRoll = tray.dice.length > 0 || tray.modifier !== 0;
  const diceBlocked = tray.dice.length > 0 && (engine.status !== 'ready' || engine.error !== null);
  // The 3D throw must be on screen WHILE it happens: `rollDice` resolves
  // after the dice settle, so gating on the result alone hid the animation.
  // Settled dice stay up behind the result number; flat values never raise
  // the stage (engine-free by contract).
  const stageVisible = rolling || (roll?.dice === true);

  return (
    <>
      <div
        ref={engine.stageRef}
        aria-hidden
        data-testid="dice-stage"
        data-visible={stageVisible ? 'true' : 'false'}
        className={cn(
          'dice-stage pointer-events-none fixed inset-0 z-40 overflow-hidden transition-opacity duration-300',
          stageVisible ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{intentTitle(intent)}</DialogTitle>
            <DialogDescription>Tap dice and numbers to build a roll.</DialogDescription>
          </DialogHeader>

          <DiceTrayPicker
            tray={tray}
            log={log}
            canRoll={canRoll}
            diceBlocked={diceBlocked}
            engineStatus={engine.status}
            engineError={engine.error}
            rollError={rollError}
            onAddDie={addDie}
            onRemoveDie={removeDie}
            onAddModifier={addModifier}
            onClearModifier={clearModifier}
            onClearTray={clearTray}
            onRetryEngine={retryEngine}
            onRoll={() => {
              void startRoll();
            }}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        </DialogContent>
      </Dialog>
      {roll !== null ? (
        <button
          type="button"
          className="fixed inset-0 z-50 grid cursor-pointer place-items-center gap-2 bg-black/30"
          aria-label={`Roll result ${String(roll.total)}. Tap to dismiss.`}
          onClick={dismissRoll}
        >
          <span className="pointer-events-none text-center font-heading text-8xl font-bold text-zinc-50 [text-shadow:0_4px_24px_rgb(0_0_0/0.65)]">
            {String(roll.total)}
          </span>
          <span className="pointer-events-none text-base font-semibold text-zinc-100 [text-shadow:0_2px_8px_rgb(0_0_0/0.65)]">
            {roll.summary}
          </span>
          <span className="pointer-events-none text-sm text-zinc-400">Tap to dismiss</span>
        </button>
      ) : null}
    </>
  );
}

function intentTitle(intent?: RollIntent): string {
  if (intent === undefined) {
    return 'Dice';
  }
  const label = intent.kind === 'damage' ? 'Damage' : intent.kind === 'heal' ? 'Heal' : 'Dice';
  return intent.subject === undefined ? label : `${label} — ${intent.subject}`;
}

interface DiceTrayPickerProps {
  tray: DiceTray;
  log: LogEntry[];
  canRoll: boolean;
  diceBlocked: boolean;
  engineStatus: ReturnType<typeof useDiceEngine>['status'];
  engineError: string | null;
  rollError: string | null;
  onAddDie: (sides: DieSides) => void;
  onRemoveDie: (id: string) => void;
  onAddModifier: (amount: ModifierStep, sign: -1 | 1) => void;
  onClearModifier: () => void;
  onClearTray: () => void;
  onRetryEngine: () => void;
  onRoll: () => void;
  onClose: () => void;
}

function DiceTrayPicker({
  tray,
  log,
  canRoll,
  diceBlocked,
  engineStatus,
  engineError,
  rollError,
  onAddDie,
  onRemoveDie,
  onAddModifier,
  onClearModifier,
  onClearTray,
  onRetryEngine,
  onRoll,
  onClose,
}: DiceTrayPickerProps): JSX.Element {
  const statusLine =
    rollError ??
    engineError ??
    (tray.dice.length > 0 && engineStatus === 'loading' ? 'Loading 3D dice…' : null);
  const isError = rollError !== null || engineError !== null;
  /** Why Roll is held right now (docs/18 §2.3 — see `rollBlockedReason`). */
  const rollReason = rollBlockedReason(canRoll, diceBlocked, engineError);

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Dice">
        <div className="grid grid-cols-4 gap-2">
          {STANDARD_DICE.map((sides) => (
            <button
              key={sides}
              type="button"
              className="flex min-h-18 flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-zinc-800/60 px-2 py-2 hover:bg-zinc-700/60"
              aria-label={`Add ${dieDisplayName(sides)}`}
              onClick={() => {
                onAddDie(sides);
              }}
            >
              <DieGlyph sides={sides} className="size-9" />
              <span className="text-sm font-bold">{dieDisplayName(sides)}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Modifier">
        <div className="grid grid-cols-5 gap-2">
          {MODIFIER_STEPS.map((amount) => (
            <Button
              key={`minus-${String(amount)}`}
              type="button"
              variant="outline"
              aria-label={`Subtract ${String(amount)}`}
              className="min-h-11 text-base font-bold"
              onClick={() => {
                onAddModifier(amount, -1);
              }}
            >
              −{String(amount)}
            </Button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-5 gap-2">
          {MODIFIER_STEPS.map((amount) => (
            <Button
              key={`plus-${String(amount)}`}
              type="button"
              variant="outline"
              aria-label={`Add ${String(amount)}`}
              className="min-h-11 text-base font-bold"
              onClick={() => {
                onAddModifier(amount, 1);
              }}
            >
              +{String(amount)}
            </Button>
          ))}
        </div>
      </section>

      <section aria-label="Tray">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Tray</p>
          {tray.dice.length > 0 || tray.modifier !== 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={onClearTray}>
              Clear
            </Button>
          ) : null}
        </div>
        <div
          className="flex min-h-14 flex-wrap items-center gap-2 rounded-lg border border-dashed border-white/15 bg-black/30 p-2"
          aria-live="polite"
        >
          {tray.dice.length === 0 && tray.modifier === 0 ? (
            <p className="text-sm text-zinc-500">Empty — tap dice above.</p>
          ) : (
            <>
              {tray.dice.map((die) => (
                <button
                  key={die.id}
                  type="button"
                  className="inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-full border border-white/10 bg-zinc-800/80 px-3 hover:bg-zinc-700/80"
                  aria-label={`Remove ${dieDisplayName(die.sides)}`}
                  onClick={() => {
                    onRemoveDie(die.id);
                  }}
                >
                  <DieGlyph sides={die.sides} className="size-5" />
                  <span className="text-xs font-bold">{dieDisplayName(die.sides)}</span>
                </button>
              ))}
              {tray.modifier !== 0 ? (
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-11 items-center rounded-full border border-amber-400/40 bg-zinc-800/80 px-3 text-sm font-bold text-amber-400 hover:bg-zinc-700/80"
                  aria-label={`Clear modifier ${formatModifier(tray.modifier)}`}
                  onClick={onClearModifier}
                >
                  {formatModifier(tray.modifier)}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      {statusLine !== null ? (
        <div className="flex items-center justify-between gap-2">
          <p className={cn('text-sm', isError ? 'text-destructive' : 'text-zinc-400')} role="status">
            {statusLine}
          </p>
          {isError ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetryEngine}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {log.length > 0 ? (
        <section aria-label="Recent rolls">
          <ol className="flex flex-col gap-1">
            {log.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between rounded-md bg-black/30 px-2 py-1 text-sm">
                <span className="text-zinc-400">{entry.summary}</span>
                <span className="font-bold text-amber-400">{String(entry.total)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <BlockedControl testId="dice-roll" reason={rollReason}>
          <Button
            type="button"
            data-testid="dice-roll"
            disabled={!canRoll || diceBlocked}
            onClick={onRoll}
          >
            Roll
          </Button>
        </BlockedControl>
      </DialogFooter>
    </div>
  );
}

function formatModifier(modifier: number): string {
  return modifier < 0 ? `−${String(Math.abs(modifier))}` : `+${String(modifier)}`;
}

/** Shading band of a facet: hi = lit, mid = side, low = shadowed. */
type FacetTone = 'hi' | 'mid' | 'low';

interface DieFacet {
  points: string;
  tone: FacetTone;
}

interface DieShape {
  facets: DieFacet[];
  label: { x: number; y: number; size: number };
}

const FACET_CLASS: Record<FacetTone, string> = {
  hi: 'fill-[#f2dfad]',
  mid: 'fill-[#d4a45a]',
  low: 'fill-[#9a6f2e]',
};

const DIE_SHAPES: Record<DieSides, DieShape> = {
  4: {
    facets: [
      { points: '50,8 10,88 50,58', tone: 'mid' },
      { points: '50,8 50,58 90,88', tone: 'hi' },
      { points: '10,88 90,88 50,58', tone: 'low' },
    ],
    label: { x: 50, y: 78, size: 19 },
  },
  6: {
    facets: [
      { points: '10,31 50,54 50,92 10,69', tone: 'low' },
      { points: '90,31 50,54 50,92 90,69', tone: 'mid' },
      { points: '50,8 90,31 50,54 10,31', tone: 'hi' },
    ],
    label: { x: 50, y: 31, size: 21 },
  },
  8: {
    facets: [
      { points: '12,44 50,62 50,94', tone: 'low' },
      { points: '88,44 50,62 50,94', tone: 'mid' },
      { points: '50,8 12,44 50,62', tone: 'mid' },
      { points: '50,8 50,62 88,44', tone: 'hi' },
    ],
    label: { x: 62, y: 39, size: 15 },
  },
  10: {
    facets: [
      { points: '6,46 28,62 50,94', tone: 'low' },
      { points: '94,46 72,62 50,94', tone: 'mid' },
      { points: '28,62 50,46 72,62 50,94', tone: 'low' },
      { points: '50,6 6,46 28,62 50,46', tone: 'mid' },
      { points: '50,6 50,46 72,62 94,46', tone: 'hi' },
    ],
    label: { x: 66, y: 41, size: 14 },
  },
  100: {
    facets: [
      { points: '6,46 28,62 50,94', tone: 'low' },
      { points: '94,46 72,62 50,94', tone: 'mid' },
      { points: '28,62 50,46 72,62 50,94', tone: 'low' },
      { points: '50,6 6,46 28,62 50,46', tone: 'mid' },
      { points: '50,6 50,46 72,62 94,46', tone: 'hi' },
    ],
    label: { x: 66, y: 41, size: 18 },
  },
  12: {
    facets: [
      { points: '50,22 72.8,38.6 91.8,65.6 75.9,16.4', tone: 'mid' },
      { points: '72.8,38.6 64.1,65.4 50,96 91.8,65.6', tone: 'low' },
      { points: '64.1,65.4 35.9,65.4 8.2,65.6 50,96', tone: 'low' },
      { points: '35.9,65.4 27.2,38.6 24.1,16.4 8.2,65.6', tone: 'mid' },
      { points: '27.2,38.6 50,22 75.9,16.4 24.1,16.4', tone: 'mid' },
      { points: '50,22 72.8,38.6 64.1,65.4 35.9,65.4 27.2,38.6', tone: 'hi' },
    ],
    label: { x: 50, y: 45, size: 18 },
  },
  20: {
    facets: [
      { points: '50,26 50,4 90,27', tone: 'mid' },
      { points: '50,26 10,27 50,4', tone: 'low' },
      { points: '50,26 76,70 90,27', tone: 'mid' },
      { points: '76,70 90,27 90,73', tone: 'low' },
      { points: '76,70 90,73 50,96', tone: 'low' },
      { points: '76,70 24,70 50,96', tone: 'mid' },
      { points: '24,70 50,96 10,73', tone: 'mid' },
      { points: '24,70 10,73 10,27', tone: 'low' },
      { points: '50,26 24,70 10,27', tone: 'mid' },
      { points: '50,26 76,70 24,70', tone: 'hi' },
    ],
    label: { x: 50, y: 57, size: 17 },
  },
};

function DieGlyph({ sides, className }: { sides: DieSides; className?: string }): JSX.Element {
  const shape = DIE_SHAPES[sides];
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={cn(
        'block [filter:drop-shadow(0_2px_3px_rgb(0_0_0/0.5))] [transform:perspective(420px)_rotateY(-14deg)_rotateX(5deg)]',
        className,
      )}
    >
      {shape.facets.map((facet, index) => (
        <polygon
          key={`${facet.tone}-${String(index)}`}
          className={FACET_CLASS[facet.tone]}
          points={facet.points}
          stroke="#24190c"
          strokeWidth={1.1}
          strokeLinejoin="round"
        />
      ))}
      <text
        x={shape.label.x}
        y={shape.label.y}
        fontSize={shape.label.size}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[#2b1f0e] font-heading font-bold"
      >
        {sides === 100 ? '%' : String(sides)}
      </text>
    </svg>
  );
}
