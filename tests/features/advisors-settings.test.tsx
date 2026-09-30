import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readSettings } from '@/db/settingsRepo';
import { ADVISOR_LENSES } from '@/domain/advisors';
import { AdvisorsSection } from '@/features/settings/advisors-section';
import { clearDatabase } from '../db/helpers';
import { actDrained } from '../helpers/flush';

const toastErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toastError: toastErrorMock, toastSuccess: vi.fn(), toastInfo: vi.fn() }));

/** Settings > Advisors (docs/17 row 400): hide / duplicate built-ins, add custom, refuse empty. */
describe('advisors settings section', () => {
  beforeEach(async () => {
    await clearDatabase();
    toastErrorMock.mockClear();
  });

  it('hide and duplicate persist without touching the built-ins; a custom advisor is added and removed', async () => {
    const user = userEvent.setup();
    const before = JSON.stringify(ADVISOR_LENSES);
    render(<AdvisorsSection />);
    await screen.findByTestId('advisor-hide-critique');
    await user.click(screen.getByTestId('advisor-hide-critique'));
    await waitFor(async () => {
      expect((await actDrained(() => readSettings())).hiddenAdvisors).toEqual(['critique']);
    });
    await user.click(screen.getByTestId('advisor-duplicate-continuity'));
    await waitFor(async () => {
      expect((await actDrained(() => readSettings())).customAdvisors).toHaveLength(1);
    });
    const copy = (await actDrained(() => readSettings())).customAdvisors[0];
    if (copy === undefined) throw new Error('duplicate was not stored');
    expect(copy.name).toBe('Continuity & consistency (copy)');
    expect(copy.instruction).toContain('continuity and consistency');
    expect(JSON.stringify(ADVISOR_LENSES)).toBe(before);
    await user.click(await screen.findByTestId(`advisor-remove-${copy.id}`));
    await waitFor(async () => {
      expect((await actDrained(() => readSettings())).customAdvisors).toEqual([]);
    });
  });

  it('an empty instruction is refused loudly and nothing is stored', async () => {
    const user = userEvent.setup();
    render(<AdvisorsSection />);
    await user.type(await screen.findByTestId('advisor-new-name'), 'Mood');
    await user.click(screen.getByTestId('advisor-add'));
    expect(toastErrorMock).toHaveBeenCalled();
    expect((await actDrained(() => readSettings())).customAdvisors).toEqual([]);
    await user.type(screen.getByTestId('advisor-new-instruction'), 'Judge the mood.');
    await user.click(screen.getByTestId('advisor-add'));
    await waitFor(async () => {
      expect((await actDrained(() => readSettings())).customAdvisors.map((a) => a.name)).toEqual(['Mood']);
    });
  });
});
