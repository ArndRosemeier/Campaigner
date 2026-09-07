import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Battle } from '@/domain';
import { battleSchema, newId } from '@/domain';
import {
  InitiativeSidebar,
  moveInitiativeOrder,
} from '@/features/play/battle/initiative-sidebar';

/**
 * iPad batch A: the HTML5-DnD initiative reorder is dead on iOS Safari, so
 * each row carries GM up/down move buttons (44px targets) that commit one
 * reorder per press through the same `onReorder` path the drop handler used.
 */

function seedBattle(): { battle: Battle; ids: [string, string, string] } {
  const ids = [newId(), newId(), newId()] as [string, string, string];
  const labels = ['Serren', 'Troll', 'Mira'];
  const battle = battleSchema.parse({
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    campaignId: newId(),
    moduleId: newId(),
    encounterArtifactId: null,
    board: {
      live: true,
      everLive: true,
      tokens: ids.map((id, index) => ({
        id,
        artifactId: null,
        label: labels[index],
        x: 0.1 * (index + 1),
        y: 0.2,
        visible: true,
        scale: 1,
        shape: 'circle',
        color: '#fff',
        currentHp: 10,
        initiativeRoll: 15 - index * 2,
        initiativeBonus: 2,
        treasure: '',
        conditions: [],
      })),
      initiativeEnabled: true,
      initiativeOrder: [...ids],
      activeIndex: 0,
    },
  });
  return { battle, ids };
}

function renderSidebar(battle: Battle, overrides?: Partial<Parameters<typeof InitiativeSidebar>[0]>) {
  const onReorder = vi.fn();
  const onNextTurn = vi.fn();
  const onClose = vi.fn();
  render(<InitiativeSidebar battle={battle} onReorder={onReorder} onNextTurn={onNextTurn} onClose={onClose} {...overrides} />);
  return { onReorder, onNextTurn, onClose };
}

describe('moveInitiativeOrder', () => {
  it('moves one step and reports null at the edges or for unknown ids', () => {
    expect(moveInitiativeOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInitiativeOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveInitiativeOrder(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(moveInitiativeOrder(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(moveInitiativeOrder(['a', 'b', 'c'], 'zzz', 1)).toBeNull();
    expect(moveInitiativeOrder(['solo'], 'solo', 1)).toBeNull();
  });
});

describe('InitiativeSidebar move buttons', () => {
  it('renders one up/down pair per row with move aria-labels and no draggable rows', () => {
    const { battle } = seedBattle();
    renderSidebar(battle);
    expect(screen.getAllByTestId('initiative-entry')).toHaveLength(3);
    expect(screen.getByLabelText('Move Serren up in initiative')).toBeInTheDocument();
    expect(screen.getByLabelText('Move Troll down in initiative')).toBeInTheDocument();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    // Frozen totals, active-turn marker, next/close keep working.
    expect(screen.getAllByTestId('initiative-total').map((el) => el.textContent)).toEqual(['17', '15', '13']);
    expect(screen.getByLabelText('Active turn')).toBeInTheDocument();
    expect(screen.getByTestId('next-turn')).toBeInTheDocument();
    expect(screen.getByLabelText('Close initiative')).toBeInTheDocument();
  });

  it('commits exactly one reorder per press through onReorder', async () => {
    const { battle } = seedBattle();
    const { onReorder } = renderSidebar(battle);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Move Troll up in initiative'));
    expect(onReorder).toHaveBeenCalledTimes(1);
    const [serren, troll, mira] = battle.board.initiativeOrder;
    expect(onReorder).toHaveBeenCalledWith([troll, serren, mira]);

    await user.click(screen.getByLabelText('Move Serren down in initiative'));
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenNthCalledWith(2, [troll, serren, mira]);
  });

  it('disables up on the first row and down on the last row', () => {
    const { battle } = seedBattle();
    renderSidebar(battle);
    expect(screen.getByLabelText('Move Serren up in initiative')).toBeDisabled();
    expect(screen.getByLabelText('Move Mira down in initiative')).toBeDisabled();
    expect(screen.getByLabelText('Move Troll up in initiative')).not.toBeDisabled();
    expect(screen.getByLabelText('Move Troll down in initiative')).not.toBeDisabled();
  });

  it('gives every move button a 44px minimum touch target', () => {
    const { battle } = seedBattle();
    renderSidebar(battle);
    const ups = screen.getAllByTestId('initiative-move-up');
    const downs = screen.getAllByTestId('initiative-move-down');
    expect([...ups, ...downs]).toHaveLength(6);
    for (const button of [...ups, ...downs]) {
      expect(button.className).toContain('min-h-[44px]');
      expect(button.className).toContain('min-w-[44px]');
    }
  });

  it('keeps next-turn and close working', async () => {
    const { battle } = seedBattle();
    const { onNextTurn, onClose } = renderSidebar(battle);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('next-turn'));
    await user.click(screen.getByLabelText('Close initiative'));
    expect(onNextTurn).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns null when initiative is off or the order is empty', () => {
    const { battle } = seedBattle();
    const { container } = render(
      <InitiativeSidebar
        battle={battleSchema.parse({ ...battle, board: { ...battle.board, initiativeEnabled: false } })}
        onReorder={vi.fn()}
        onNextTurn={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    const { container: empty } = render(
      <InitiativeSidebar
        battle={battleSchema.parse({ ...battle, board: { ...battle.board, initiativeOrder: [] } })}
        onReorder={vi.fn()}
        onNextTurn={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(empty).toBeEmptyDOMElement();
  });

  it('skips order ids with no matching token', () => {
    const { battle, ids } = seedBattle();
    renderSidebar(battleSchema.parse({
      ...battle,
      board: {
        ...battle.board,
        tokens: battle.board.tokens.slice(0, 2),
        initiativeOrder: [...ids],
      },
    }));
    const entries = screen.getAllByTestId('initiative-entry');
    expect(entries).toHaveLength(2);
    const first = entries[0];
    if (first === undefined) throw new Error('first initiative entry missing');
    expect(within(first).getByText('Serren')).toBeInTheDocument();
  });
});
