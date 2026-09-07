import type { JSX } from 'react';
import { ChevronDownIcon, ChevronUpIcon, FastForwardIcon, XIcon } from 'lucide-react';

import type { Battle, BattleTokenId } from '@/domain';
import { activeInitiativeTokenId, initiativeTotal } from '@/domain/battle/initiative';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Initiative sidebar (09-MILESTONE-5 M5-D): turn order with frozen totals,
 * the floating-turn arrow, touch-friendly up/down reorder (one `onReorder`
 * commit per move — HTML5 DnD is dead on iOS Safari), and >>> next turn.
 * Player-safe by contract: it renders ONLY labels, totals, and the turn
 * arrow — no stats, no GM-only material.
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
}

/**
 * One-step reorder: the SAME splice-and-commit path the old drop handler
 * used (remove at `from`, insert at the clamped neighbor). Returns the new
 * order, or null when the token is not in the order (no commit then).
 */
export function moveInitiativeOrder(
  order: BattleTokenId[],
  tokenId: BattleTokenId,
  delta: -1 | 1,
): BattleTokenId[] | null {
  const from = order.indexOf(tokenId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  if (to === from) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, tokenId);
  return next;
}

export function InitiativeSidebar({
  battle,
  onReorder,
  onNextTurn,
  onClose,
  canReorder = true,
}: InitiativeSidebarProps): JSX.Element | null {
  const board = battle.board;
  if (!board.initiativeEnabled || board.initiativeOrder.length === 0) {
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
      </div>
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
      <p className="text-[10px] text-white/40">bonuses frozen at roll time</p>
    </aside>
  );
}
