import { useState } from 'react';
import type { JSX } from 'react';
import { ChevronDownIcon, ChevronUpIcon, FastForwardIcon, XIcon } from 'lucide-react';

import type { Battle, BattleTokenId } from '@/domain';
import { activeInitiativeTokenId, initiativeTotal } from '@/domain/battle/initiative';
import {
  beginInitiativeDrag,
  endInitiativeDrag,
} from '@/domain/battle/gestureGate';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Initiative sidebar (09-MILESTONE-5 M5-D): turn order with frozen totals,
 * the floating-turn arrow, drag-to-reorder (gated so the reconcile effect
 * never fights the drag), and >>> next turn. Player-safe by contract: it
 * renders ONLY labels, totals, and the turn arrow — no stats, no secrets.
 */

export interface InitiativeSidebarProps {
  battle: Battle;
  /** The surface commits the new order/activeIndex through this. */
  onReorder: (order: BattleTokenId[]) => void;
  onNextTurn: () => void;
  onClose: () => void;
}

interface DragState {
  tokenId: BattleTokenId;
  overIndex: number;
}

export function InitiativeSidebar({
  battle,
  onReorder,
  onNextTurn,
  onClose,
}: InitiativeSidebarProps): JSX.Element | null {
  const [drag, setDrag] = useState<DragState | null>(null);
  const board = battle.board;
  if (!board.initiativeEnabled || board.initiativeOrder.length === 0) {
    return null;
  }
  const activeId = activeInitiativeTokenId(board);
  const byId = new Map(board.tokens.map((token) => [token.id, token]));

  function startDrag(tokenId: BattleTokenId, index: number): void {
    beginInitiativeDrag();
    setDrag({ tokenId, overIndex: index });
  }

  function hover(index: number): void {
    if (drag === null) return;
    setDrag({ ...drag, overIndex: index });
  }

  function finish(): void {
    if (drag === null) {
      endInitiativeDrag();
      return;
    }
    const order = [...board.initiativeOrder];
    const from = order.indexOf(drag.tokenId);
    if (from >= 0) {
      order.splice(from, 1);
      // The hover index counts the pre-removal list: adjust after the splice.
      const to = Math.max(0, Math.min(order.length, drag.overIndex > from ? drag.overIndex - 1 : drag.overIndex));
      order.splice(to, 0, drag.tokenId);
      onReorder(order);
    }
    setDrag(null);
    endInitiativeDrag();
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
          const isDragging = drag?.tokenId === tokenId;
          return (
            <li
              key={tokenId}
              draggable
              onDragStart={() => {
                startDrag(tokenId, index);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                hover(index);
              }}
              onDragEnd={finish}
              onDrop={finish}
              className={cn(
                'flex items-center gap-2 rounded px-1.5 py-1',
                isActive ? 'bg-emerald-600/40' : 'bg-white/5',
                isDragging && 'opacity-50',
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
            </li>
          );
        })}
      </ol>
      <p className="flex items-center gap-1 text-[10px] text-white/40">
        <ChevronUpIcon aria-hidden className="size-3" />
        <ChevronDownIcon aria-hidden className="size-3" />
        drag to reorder · bonuses frozen at roll time
      </p>
    </aside>
  );
}
