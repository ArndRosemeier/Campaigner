'use client';

import * as React from 'react';
import type { JSX } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * THE one way to state why a control cannot act (docs/18 §2.3, docs/05-UI
 * §"Why a control cannot act"). A control that is natively `disabled` fires no
 * pointer events (any shadcn Button also carries `disabled:pointer-events-none`,
 * so it is skipped by hit-testing altogether), which means a `title` on it is
 * never shown in Chrome and, being unfocusable, is unreachable by keyboard and
 * unannounced by a screen reader — a promise the UI could not keep (docs/18 §4).
 *
 * This wrapper is the fix, and it is ONE device for every surface:
 *
 * - the wrapper is the tooltip TRIGGER, so hover has somewhere to land even
 *   though the control inside cannot receive it (its own box is the target —
 *   the disabled child's hit area is part of it);
 * - the wrapper is FOCUSABLE (`tabIndex={0}`) while blocked, so a keyboard user
 *   tabs onto the blocked control and the tooltip opens on focus;
 * - the same sentence is rendered ONCE into a visually hidden node that the
 *   wrapper points at with `aria-describedby`, so the reason is associated for
 *   assistive tech with no dependence on the tooltip being open.
 *
 * The blocking condition itself stays where it always was: the child keeps its
 * native `disabled` attribute and the caller keeps deciding WHEN it is blocked.
 * This component only makes the reason perceivable.
 *
 * Callers pass `reason: null` whenever the control CAN act — then the wrapper is
 * an inert `inline-flex` span (same DOM shape, so a state flip never remounts
 * or re-focuses the control) and no tab stop, no tooltip and no `aria-describedby`
 * exist. A reason and a live control must never be passed together: the reason
 * would be a lie.
 */
export interface BlockedControlProps {
  /**
   * The control's OWN `data-testid`. The wrapper derives
   * `${testId}-blocked` (the hover/focus trigger) and `${testId}-reason` (the
   * associated text) from it, so a pin can name both without a second id.
   */
  testId: string;
  /**
   * Why the control cannot act right now, in the user's terms — or `null` when
   * it can. A reason must name the way out whenever one exists ("switch to
   * Edit", "wait for it (or press Stop)").
   */
  reason: string | null;
  /** Where the reason popup sits relative to the control. Default 'bottom'. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Extra classes for the outer wrapper (layout only). */
  className?: string;
  children: React.ReactNode;
}

export function BlockedControl({
  testId,
  reason,
  side = 'bottom',
  className,
  children,
}: BlockedControlProps): JSX.Element {
  // One stable id per instance: `aria-describedby` must resolve in the static
  // DOM, not only while a popup happens to be open.
  const reasonId = `blocked-reason-${React.useId()}`;

  return (
    <span className={cn('inline-flex', className)} data-blocked-control={testId}>
      {reason === null ? (
        children
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex"
                tabIndex={0}
                aria-describedby={reasonId}
                data-testid={`${testId}-blocked`}
              />
            }
          >
            {children}
          </TooltipTrigger>
          <TooltipContent side={side} data-testid={`${testId}-blocked-reason`}>
            {reason}
          </TooltipContent>
        </Tooltip>
      )}
      {reason !== null && (
        <span id={reasonId} className="sr-only" data-testid={`${testId}-reason`}>
          {reason}
        </span>
      )}
    </span>
  );
}
