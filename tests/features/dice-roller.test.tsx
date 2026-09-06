import 'fake-indexeddb/auto';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { JSX } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DiceRoller, type DiceRollerProps } from '@/features/dice/DiceRoller';

/**
 * The dice roller UI against a mocked `@3d-dice/dice-box` (jsdom has no
 * WebGL): tray building, ± modifier steppers, engine-free flat rolls, the
 * 3D roll flow with result reporting, loud roll-failure handling, and the
 * last-used-tray preference.
 */

const h = vi.hoisted(() => {
  const state = {
    initImpl: undefined as undefined | (() => Promise<unknown>),
    rollImpl: undefined as undefined | (() => Promise<unknown>),
    instances: [] as { cleared: number }[],
  };
  return state;
});

vi.mock('@3d-dice/dice-box', () => ({
  default: class FakeDiceBox {
    config: Record<string, unknown>;
    cleared = 0;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      h.instances.push(this);
    }
    init(): Promise<unknown> {
      return h.initImpl === undefined ? Promise.resolve(this) : h.initImpl();
    }
    roll(): Promise<unknown> {
      return h.rollImpl === undefined
        ? Promise.resolve([
            { value: 4, sides: 6 },
            { value: 4, sides: 6 },
          ])
        : h.rollImpl();
    }
    clear(): void {
      this.cleared += 1;
    }
  },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toastError }));

function Harness(props: Omit<DiceRollerProps, 'open' | 'onOpenChange'>): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => {
        setOpen((current) => !current);
      }}>
        {open ? 'close-roller' : 'open-roller'}
      </button>
      <DiceRoller {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

async function renderRoller(props: Omit<DiceRollerProps, 'open' | 'onOpenChange'> = {}): Promise<void> {
  await act(async () => {
    render(<Harness {...props} />);
    await Promise.resolve();
  });
}

function lastInstance(): { cleared: number } {
  const instance = h.instances.at(-1);
  if (instance === undefined) throw new Error('engine was never constructed');
  return instance;
}

async function addDice(labels: string[]): Promise<void> {
  const user = userEvent.setup();
  for (const label of labels) {
    await user.click(screen.getByRole('button', { name: `Add ${label}` }));
  }
}

beforeEach(() => {
  h.initImpl = undefined;
  h.rollImpl = undefined;
  h.instances.length = 0;
  toastError.mockClear();
});

describe('DiceRoller', () => {
  it('renders all seven dice, ± modifier steppers, and disables Roll while empty', async () => {
    await renderRoller();
    for (const label of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd%']) {
      expect(screen.getByRole('button', { name: `Add ${label}` })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Subtract 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 20' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roll' })).toBeDisabled();
    expect(screen.getByText('Empty — tap dice above.')).toBeInTheDocument();
  });

  it('builds a tray: dice chips are tap-removable, modifiers accumulate', async () => {
    const user = userEvent.setup();
    await renderRoller();
    await addDice(['d6', 'd6', 'd%']);
    expect(screen.getAllByRole('button', { name: 'Remove d6' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove d%' })).toBeInTheDocument();
    const d6Chips = screen.getAllByRole('button', { name: 'Remove d6' });
    const firstChip = d6Chips.at(0);
    if (firstChip === undefined) throw new Error('d6 chip missing');
    await user.click(firstChip);
    expect(screen.getAllByRole('button', { name: 'Remove d6' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add 2' }));
    await user.click(screen.getByRole('button', { name: 'Add 2' }));
    await user.click(screen.getByRole('button', { name: 'Subtract 1' }));
    expect(screen.getByRole('button', { name: 'Clear modifier +3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear modifier +3' }));
    expect(screen.queryByRole('button', { name: /Clear modifier/ })).toBeNull();
  });

  it('rolls a flat value engine-free and reports it through onResult', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    await renderRoller({ onResult });
    await user.click(screen.getByRole('button', { name: 'Add 5' }));
    await user.click(screen.getByRole('button', { name: 'Add 2' }));
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({ total: 7, summary: '+7', perDie: [] });
    });
    // Result overlay shows the settled total; dismissing clears the engine.
    const overlay = screen.getByRole('button', { name: /Roll result 7/ });
    await user.click(overlay);
    expect(screen.queryByRole('button', { name: /Roll result 7/ })).toBeNull();
    expect(lastInstance().cleared).toBe(1);
  });

  it('rolls dice through the 3D engine, closes the picker, and reports dice + total', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    await renderRoller({ onResult });
    await addDice(['d6', 'd6']);
    await user.click(screen.getByRole('button', { name: 'Add 2' }));
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    await waitFor(() => {
      expect(rollButton).toBeEnabled();
    });
    await user.click(rollButton);
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({ total: 10, summary: '2d6+2', perDie: [4, 4] });
    });
    const overlay = screen.getByRole('button', { name: /Roll result 10/ });
    expect(overlay).toHaveTextContent('2d6+2');
  });

  it('fixes percentile zeros up to 100 in the reported total', async () => {
    h.rollImpl = () => Promise.resolve([{ value: 0, sides: 100 }]);
    const onResult = vi.fn();
    const user = userEvent.setup();
    await renderRoller({ onResult });
    await addDice(['d%']);
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    await waitFor(() => {
      expect(rollButton).toBeEnabled();
    });
    await user.click(rollButton);
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({ total: 100, summary: '1d%', perDie: [0] });
    });
  });

  it('fails loudly on a roll error: picker reopens with the tray intact and the toast fires', async () => {
    h.rollImpl = () => Promise.reject(new Error('physics worker crashed'));
    const onResult = vi.fn();
    const user = userEvent.setup();
    await renderRoller({ onResult });
    await addDice(['d20']);
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    await waitFor(() => {
      expect(rollButton).toBeEnabled();
    });
    await user.click(rollButton);
    // The picker is back with the d20 still trayed and the error on screen.
    await waitFor(() => {
      expect(screen.getByText('physics worker crashed')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Remove d20' })).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(
      'Dice roll failed',
      expect.objectContaining({ message: 'physics worker crashed' }),
    );
    expect(onResult).not.toHaveBeenCalled();
  });

  it('keeps flat rolls working when the 3D engine fails to load — and blocks dice rolls loudly', async () => {
    h.initImpl = () => Promise.reject(new Error('no WebGL context'));
    const onResult = vi.fn();
    const user = userEvent.setup();
    await renderRoller({ onResult });
    await waitFor(() => {
      expect(screen.getByText('no WebGL context')).toBeInTheDocument();
    });
    expect(toastError).toHaveBeenCalledWith(
      '3D dice failed to load',
      expect.objectContaining({ message: 'no WebGL context' }),
    );
    // Flat modifier-only → rolls engine-free even though the engine is down.
    await user.click(screen.getByRole('button', { name: 'Subtract 1' }));
    await user.click(screen.getByRole('button', { name: 'Add 5' }));
    expect(screen.getByRole('button', { name: 'Clear modifier +4' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({ total: 4, summary: '+4', perDie: [] });
    });
    // Dismiss the result, reopen the roller: with a die in the tray, Roll
    // stays blocked while the engine is down.
    await user.click(screen.getByRole('button', { name: /Roll result 4/ }));
    await user.click(screen.getByRole('button', { name: 'open-roller' }));
    await user.click(screen.getByRole('button', { name: 'Add d6' }));
    expect(screen.getByRole('button', { name: 'Roll' })).toBeDisabled();
  });

  it('remembers the last rolled tray for the next open (user preference)', async () => {
    const user = userEvent.setup();
    await renderRoller({ intent: { kind: 'damage', subject: 'Goblin 2' } });
    expect(screen.getByText('Damage — Goblin 2')).toBeInTheDocument();
    await addDice(['d6', 'd6']);
    await user.click(screen.getByRole('button', { name: 'Add 2' }));
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    await waitFor(() => {
      expect(rollButton).toBeEnabled();
    });
    await user.click(rollButton);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Roll result 10/ })).toBeInTheDocument();
    });
    // Dismiss, close fully, reopen — the tray is restored.
    await user.click(screen.getByRole('button', { name: /Roll result 10/ }));
    // Reopen by remounting (open starts true again).
    act(() => {
      render(<Harness intent={{ kind: 'damage', subject: 'Goblin 2' }} />);
    });
    expect(screen.getAllByRole('button', { name: 'Remove d6' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Clear modifier +2' })).toBeInTheDocument();
  });

  it('titles generic intent plainly and shows recent rolls in the picker', async () => {
    h.rollImpl = () =>
      Promise.resolve([
        { value: 3, sides: 6 },
        { value: 4, sides: 6 },
      ]);
    const user = userEvent.setup();
    await renderRoller();
    expect(screen.getByText('Dice')).toBeInTheDocument();
    await addDice(['d6', 'd6']);
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    await waitFor(() => {
      expect(rollButton).toBeEnabled();
    });
    await user.click(rollButton);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Roll result 7/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Roll result 7/ }));
    // Reopen the picker: the settled roll is in the recent-rolls log.
    await user.click(screen.getByRole('button', { name: 'open-roller' }));
    expect(screen.getByText('2d6')).toBeInTheDocument();
    expect(screen.getByText(String(7))).toBeInTheDocument();
  });
});
