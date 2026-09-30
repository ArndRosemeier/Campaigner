import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * The ONE blocked-control device (docs/18 §2.3, docs/05-UI §"Why a control
 * cannot act").
 *
 * The defect this pins shut: a natively `disabled` control gives the owner no
 * perceivable reason. `title` on such a control never renders in Chrome (a
 * disabled form control fires no pointer events, and every shadcn Button also
 * carries `disabled:pointer-events-none`, so it is not even hit-tested) and is
 * unreachable by keyboard (disabled controls cannot be focused) — so the three
 * canvas header controls the owner reported as "doing nothing" were implemented,
 * pinned and correct, and still said nothing about WHY they could not act.
 *
 * What this file pins, per the device's contract:
 * 1. the control keeps its NATIVE disabled attribute (no `aria-disabled`
 *    conversion — the blocking condition is not re-litigated here),
 * 2. the reason is associated statically via `aria-describedby` → the
 *    visually-hidden node holding the same sentence,
 * 3. the wrapper is the hover target (the tooltip appears on hover — which is
 *    exactly what a `title` on the disabled control could not do), and
 * 4. the wrapper is focusable while blocked, so the same reason reaches a
 *    keyboard/screen-reader user (the tooltip opens on focus).
 *
 * Non-vacuity: the popup is asserted ABSENT before the interaction and present
 * after it, so a wrapper that never received hover/focus fails here rather than
 * passing on the presence of the (always-rendered) hidden text. The reason text
 * is deliberately distinct from the hidden node's, scoped assertions included —
 * `docs/08-TESTING` note: Base UI's tooltip popup carries no `role="tooltip"`.
 */

function renderBlocked(reason: string | null): void {
  render(
    <TooltipProvider delay={0}>
      <BlockedControl testId="probe-control" reason={reason}>
        <Button data-testid="probe-control" disabled={reason !== null}>
          Probe
        </Button>
      </BlockedControl>
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('BlockedControl — the one device that makes a blocked reason perceivable', () => {
  it('a blocked control keeps its native disabled attribute and states its reason for mouse, keyboard and AT', async () => {
    const user = userEvent.setup();
    const REASON = 'Preview is open — switch to Edit to use it.';
    renderBlocked(REASON);

    // 1. The blocking condition is untouched: the control is natively disabled.
    const control = screen.getByTestId('probe-control');
    expect(control).toBeDisabled();

    // 2. The reason is associated in the STATIC DOM (no dependence on an open
    //    popup): the trigger points at the hidden node carrying the sentence.
    const trigger = screen.getByTestId('probe-control-blocked');
    const described = screen.getByTestId('probe-control-reason');
    expect(described).toHaveTextContent(REASON);
    expect(described).toHaveClass('sr-only');
    expect(trigger).toHaveAttribute('aria-describedby', described.id);
    expect(trigger.id).not.toBe(described.id);

    // 4a. Keyboard: the blocked control is REACHABLE (a disabled control is
    //     not) — the wrapper carries the tab stop.
    expect(trigger).toHaveAttribute('tabindex', '0');
    expect(screen.queryByTestId('probe-control-blocked-reason')).not.toBeInTheDocument();

    // 3. Mouse: hovering the wrapper (the only hit-testable box — the disabled
    //    button is skipped by the browser) opens the reason popup. ABSENT
    //    before, PRESENT after: a wrapper that never receives hover fails here.
    await user.hover(trigger);
    const popup = await screen.findByTestId('probe-control-blocked-reason', {}, { timeout: 5_000 });
    expect(popup).toHaveTextContent(REASON);

    await user.unhover(trigger);
    await user.hover(control); // the disabled button's own area is the wrapper's
    expect(await screen.findByTestId('probe-control-blocked-reason')).toBeInTheDocument();
  }, 20_000);

  it('keyboard focus on the wrapper opens the same reason (a disabled control cannot be focused)', async () => {
    renderBlocked('The module is generating right now — wait for it (or press Stop).');
    const trigger = screen.getByTestId('probe-control-blocked');

    expect(screen.queryByTestId('probe-control-blocked-reason')).not.toBeInTheDocument();
    // Focus is an interaction: the tooltip's own state update rides Base UI's
    // focus handlers, so it is dispatched inside act (docs/08-TESTING §console
    // guard).
    act(() => {
      trigger.focus();
    });
    expect(trigger).toHaveFocus();
    const popup = await screen.findByTestId('probe-control-blocked-reason', {}, { timeout: 5_000 });
    expect(within(popup).getByText(/wait for it \(or press Stop\)/)).toBeInTheDocument();
  }, 20_000);

  it('a live control gets no wrapper state at all: no tab stop, no tooltip, no described-by', async () => {
    const user = userEvent.setup();
    renderBlocked(null);

    const control = screen.getByTestId('probe-control');
    expect(control).toBeEnabled();
    // Same DOM shape (the outer wrapper is unconditional, so a state flip never
    // remounts the control), but nothing explanatory is attached to it.
    const wrapper = control.parentElement;
    expect(wrapper).toHaveAttribute('data-blocked-control', 'probe-control');
    expect(wrapper).toHaveClass('inline-flex');
    expect(wrapper).not.toHaveAttribute('tabindex');
    expect(wrapper).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('probe-control-blocked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('probe-control-reason')).not.toBeInTheDocument();

    await user.hover(control);
    expect(screen.queryByTestId('probe-control-blocked-reason')).not.toBeInTheDocument();
  }, 20_000);
});
