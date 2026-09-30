import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

import { flushAsyncUpdates } from './flush';

/**
 * The pin helpers for a blocked-control reason (docs/18 §2.3, docs/05 §Why a
 * control cannot act; ledger rows 98/99) — one home, so every sweep pin asserts
 * the SAME contract instead of a per-file paraphrase of it.
 *
 * Every reason pin asserts both halves and neither alone is enough:
 *  - the control is held exactly as its own gate says (no gate was
 *    re-litigated — the assertion is the gate's own semantics, below);
 *  - the reason is present, associated via `aria-describedby`, reachable by
 *    keyboard (`tabindex=0` on the wrapper — the half a `title` could never
 *    cover) and reachable by mouse: the reason POPUP is settled OUT of the
 *    document first (`dismissOpenPopup`, which is also the non-vacuity half —
 *    a popup that is always rendered cannot be dismissed and fails loudly)
 *    and then looked up again after the hover.
 *
 * HONEST LIMIT, the same one ledger row 98 records: jsdom has no layout and no
 * hit-testing, so that the reason POPUP paints over the control in a real
 * browser is not measured here. What is pinned is the DOM contract above.
 */

/**
 * Settles the reason popup OUT of the document, deterministically, before the
 * pin hovers — because the popup is TRANSIENT DOM and BOTH of its edges are the
 * framework's own asynchronous transitions: Base UI mounts it while the tooltip
 * is open and removes it once the exit animation completes
 * (`useAnimationsFinished`: one `requestAnimationFrame` + a microtask, then a
 * `flushSync` unmount — `Element.getAnimations` is stubbed empty in
 * `tests/setup.ts`, so jsdom always takes that path).
 *
 * A synchronous `expect(...).not.toBeInTheDocument()` on that element is
 * therefore a race against the APP, not a pin (MEASURED, ledger 124): a full
 * gate failed 1 run in 2 with `not.toBeInTheDocument()` on a
 * `div[data-slot="tooltip-content"][data-open]` — and the element was the popup
 * of the very control under assertion, opened with no hover from the test.
 * The app opens it wherever the UI puts FOCUS on a held control, because
 * `BlockedControl` opens the reason on focus BY DESIGN (docs/05 §Why a control
 * cannot act): a Base UI menu places focus on the held item's wrapper as it
 * opens (`document.activeElement` measured as `SPAN[retry-book-…-blocked]`, the
 * wrapper itself — the disabled item is not natively focusable, the wrapper's
 * `tabIndex=0` is the tab stop, docs/18 §2.3), so one extra async turn is the
 * whole difference between the old assertion passing and failing.
 *
 * So the pin settles the state it is about to assert instead of assuming it:
 *  1. DRAIN what the app has already scheduled (the suite's own drain seam,
 *     `flushAsyncUpdates`) — the app's focus placement has landed afterwards,
 *     and a state that cannot change under the assertion is what makes the
 *     remaining steps deterministic;
 *  2. hand back the two triggers the app can have used — pointer to the body
 *     (`unhover`) and focus away (`blur`), the same thing a user does by moving
 *     off the control;
 *  3. AWAIT the removal. This is an await of a real transition, never a sleep
 *     and never a retry: it is the framework's OWN exit, and step 3 is where
 *     the pin keeps its teeth — a popup that cannot leave (the always-rendered
 *     node this guard exists to catch) times out LOUDLY here instead of passing
 *     vacuously.
 *
 * A re-open after step 2 is impossible: the focus the menu places is one-shot
 * per open and step 1 has already let it land.
 */
async function dismissOpenPopup(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  trigger: HTMLElement,
): Promise<void> {
  await flushAsyncUpdates();
  await user.unhover(trigger);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await waitFor(() => {
    expect(screen.queryByTestId(`${testId}-blocked-reason`)).not.toBeInTheDocument();
  });
}

async function assertReason(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  reason: string,
  assertHeld: (control: HTMLElement) => void,
): Promise<void> {
  assertHeld(screen.getByTestId(testId));
  const node = screen.getByTestId(`${testId}-reason`);
  expect(node).toHaveTextContent(reason);
  expect(node).toHaveClass('sr-only');
  const trigger = screen.getByTestId(`${testId}-blocked`);
  expect(trigger).toHaveAttribute('aria-describedby', node.id);
  expect(trigger).toHaveAttribute('tabindex', '0');
  await dismissOpenPopup(user, testId, trigger);
  await user.hover(trigger);
  expect(
    await screen.findByTestId(`${testId}-blocked-reason`, {}, { timeout: 5_000 }),
  ).toHaveTextContent(reason);
  await user.unhover(trigger);
}

/** For a control that is held the native way (a button, an input, a select trigger). */
export async function expectBlockedReason(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  reason: string,
): Promise<void> {
  await assertReason(user, testId, reason, (control) => {
    expect(control).toBeDisabled();
  });
}

/**
 * For a Base UI MENU ITEM, whose held state is `aria-disabled="true"` on a
 * `div[role="menuitem"]` — NOT the native `disabled` attribute (measured in
 * `@base-ui/react/menu/item`: a non-native-button item gets `aria-disabled`,
 * and the item's click handler never runs while it is set). `toBeDisabled()`
 * only reads the native attribute off form tags, so it is the wrong question
 * here; the semantics that matter are the same and unchanged.
 */
export async function expectBlockedReasonMenuItem(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
  reason: string,
): Promise<void> {
  await assertReason(user, testId, reason, (control) => {
    expect(control).toHaveAttribute('aria-disabled', 'true');
  });
}

/**
 * The other half of the rule: a control whose block is SELF-EVIDENT (its own
 * label states the state, the input is empty, there is nothing to act on, or it
 * is at an end) is held with NO wrapper at all — no tab stop, no tooltip, no
 * hidden node. Pinned as an explicit decision rather than left to a missing
 * assertion.
 */
export function expectSelfEvidentBlock(
  testId: string,
  held: 'native' | 'aria-disabled' = 'native',
): void {
  const control = screen.getByTestId(testId);
  // A shadcn/Base UI Switch expresses its held state as `aria-disabled` on a
  // `span[role="switch"]`, NOT the native attribute (measured: Base UI
  // `useFocusableWhenDisabled` gives a focusable control `aria-disabled`), so
  // the caller says which form this control's gate uses.
  if (held === 'native') expect(control).toBeDisabled();
  else expect(control).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByTestId(`${testId}-blocked`)).not.toBeInTheDocument();
  expect(screen.queryByTestId(`${testId}-reason`)).not.toBeInTheDocument();
}

/**
 * The same judgement for a control that carries no `data-testid` of its own (and
 * is out of the sweep's scope): held, and no blocked-control wrapper in its
 * ancestry — found by its accessible name.
 */
export function expectSelfEvidentElement(control: HTMLElement): void {
  expect(control).toBeDisabled();
  expect(control.closest('[data-blocked-control]')).toBeNull();
}
