import type { JSX } from 'react';
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, FastForwardIcon, XIcon } from 'lucide-react';

import type { Battle, BattleToken, BattleTokenId } from '@/domain';
import { activeInitiativeTokenId, initiativeTotal } from '@/domain/battle/initiative';
import { moveInitiativeOrder } from '@/features/play/battle/initiativeOrder';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Initiative sidebar (09-MILESTONE-5 M5-D): turn order with frozen totals,
 * the floating-turn arrow, touch-friendly up/down reorder (one `onReorder`
 * commit per move — HTML5 DnD is dead on iOS Safari), and >>> next turn.
 * Player-safe by contract: it renders ONLY labels, totals, and the turn
 * arrow — no stats, no GM-only material.
 *
 * The one-step reorder itself (pure splice math) lives in the
 * `initiativeOrder.ts` sibling.
 */

export interface InitiativeSidebarProps {
  battle: Battle;
  /** The surface commits the new order/activeIndex through this. */
  onReorder: (order: BattleTokenId[]) => void;
  onNextTurn: () => void;
  onClose: () => void;
  /**
   * Whether the up/down reorder buttons render. GM-only: the surface passes
   * `!playerSafe` — players see the order and the turn arrow but never move
   * rows. Defaults to true (the pre-gate behavior) so existing callers keep
   * working.
   */
  canReorder?: boolean;
  /**
   * GM-only Hidden group (token-lifecycle arc): hidden tokens
   * (`visible: false`) are pruned from the order AND removed from the board
   * DOM, so without this list there is no unhide path. The surface passes the
   * board's hidden tokens with an `onUnhide` commit ONLY in GM view — in
   * player-safe mode both stay undefined and no Hidden group renders (hidden
   * fighters stay secret). Optional so existing callers keep working.
   */
  hiddenTokens?: readonly BattleToken[] | undefined;
  /** Recommits one hidden token with `visible: true` (the reconcile's
   * newcomer auto-roll re-enters it into initiative). GM-only with
   * `hiddenTokens`. */
  onUnhide?: ((tokenId: BattleTokenId) => void) | undefined;
  /**
   * GM veiled markers (token-lifecycle arc): ids of order members under a
   * veil. Their rows carry a "veiled" badge while their tokens stay
   * board-visible to the GM (GM-sees-everything). The surface passes the
   * covered set ONLY in GM view — player-safe rows never leak veil state.
   */
  veiledTokenIds?: ReadonlySet<BattleTokenId> | undefined;
}

export function InitiativeSidebar({
  battle,
  onReorder,
  onNextTurn,
  onClose,
  canReorder = true,
  hiddenTokens,
  onUnhide,
  veiledTokenIds,
}: InitiativeSidebarProps): JSX.Element | null {
  const board = battle.board;
  const hidden = hiddenTokens ?? [];
  const showHidden = hidden.length > 0 && onUnhide !== undefined;
  // The order block keeps the pre-existing contract (off/empty → no order,
  // no turn controls); the Hidden group rides alone when initiative is off
  // so the unhide path survives without showing stale order rows.
  const showOrder = board.initiativeEnabled && board.initiativeOrder.length > 0;
  if (!showOrder && !showHidden) {
    return null;
  }
  const activeId = activeInitiativeTokenId(board);
  const byId = new Map(board.tokens.map((token) => [token.id, token]));

  function move(tokenId: BattleTokenId, delta: -1 | 1): void {
    const next = moveInitiativeOrder(board.initiativeOrder, tokenId, delta);
    if (next !== null) {
      onReorder(next);
    }
  }

  return (
    <aside
      className="flex w-56 flex-col gap-1 rounded-md border border-white/10 bg-black/70 p-2 text-sm text-white"
      data-testid="initiative-sidebar"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/70">Initiative</h2>
        {showOrder && (
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="secondary"
            aria-label="Next turn"
            data-testid="next-turn"
            onClick={onNextTurn}
          >
            <FastForwardIcon aria-hidden className="size-3.5" />
          </Button>
          <Button size="xs" variant="ghost" aria-label="Close initiative" onClick={onClose}>
            <XIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
        )}
      </div>
      {showOrder && (
      <ol className="flex flex-col gap-0.5">
        {board.initiativeOrder.map((tokenId, index) => {
          const token = byId.get(tokenId);
          if (token === undefined) return null;
          const total = initiativeTotal(token);
          const isActive = tokenId === activeId;
          return (
            <li
              key={tokenId}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-1',
                isActive ? 'bg-emerald-600/40' : 'bg-white/5',
              )}
              data-testid="initiative-entry"
              data-active={isActive ? 'true' : 'false'}
            >
              {isActive && (
                <span aria-label="Active turn" className="text-emerald-300">
                  ▶
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{token.label}</span>
              {veiledTokenIds?.has(tokenId) === true && (
                <span
                  className="shrink-0 rounded border border-violet-400/40 px-1 text-[10px] uppercase tracking-wide text-violet-300"
                  data-testid="veiled-marker"
                >
                  veiled
                </span>
              )}
              <span className="font-mono text-xs text-white/80" data-testid="initiative-total">
                {total === null ? '—' : String(total)}
              </span>
              {canReorder && (
                <span className="flex shrink-0 flex-col" role="group" aria-label={`Reorder ${token.label}`}>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="min-h-[44px] min-w-[44px] px-1"
                    aria-label={`Move ${token.label} up in initiative`}
                    data-testid="initiative-move-up"
                    disabled={index === 0}
                    onClick={() => {
                      move(tokenId, -1);
                    }}
                  >
                    <ChevronUpIcon aria-hidden className="size-4" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="min-h-[44px] min-w-[44px] px-1"
                    aria-label={`Move ${token.label} down in initiative`}
                    data-testid="initiative-move-down"
                    disabled={index === board.initiativeOrder.length - 1}
                    onClick={() => {
                      move(tokenId, 1);
                    }}
                  >
                    <ChevronDownIcon aria-hidden className="size-4" />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      )}
      {showHidden && (
        <div className="mt-1 flex flex-col gap-0.5 border-t border-white/10 pt-1" data-testid="hidden-group">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-white/70">
            Hidden ({String(hidden.length)})
          </h3>
          <ol className="flex flex-col gap-0.5">
            {hidden.map((token) => (
              <li
                key={token.id}
                className="flex items-center gap-1 rounded bg-white/5 px-1.5 py-1"
                data-testid="hidden-entry"
              >
                <span className="min-w-0 flex-1 truncate">{token.label}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Unhide ${token.label}`}
                  data-testid="unhide-token"
                  onClick={() => {
                    onUnhide(token.id);
                  }}
                >
                  <EyeIcon aria-hidden className="size-4" />
                  Unhide
                </Button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {showOrder && <p className="text-[10px] text-white/40">bonuses frozen at roll time</p>}
    </aside>
  );
}
