import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

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
 *    cover) and reachable by mouse — asserted ABSENT before the hover, so a
 *    wrapper that never receives it fails the pin instead of passing vacuously
 *    on the always-rendered hidden text.
 *
 * HONEST LIMIT, the same one ledger row 98 records: jsdom has no layout and no
 * hit-testing, so that the reason POPUP paints over the control in a real
 * browser is not measured here. What is pinned is the DOM contract above.
 */
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
  expect(screen.queryByTestId(`${testId}-blocked-reason`)).not.toBeInTheDocument();
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
