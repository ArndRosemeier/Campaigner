'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';

/**
 * THE TWO CLASS STRINGS A DIALOG NEEDS WHEN ITS BODY IS THE SCROLLER (docs/17
 * row 343) — ONE definition each, imported by every such dialog. `Rule 4` of
 * AGENTS.md applies to the pair: three dialogs carried the shape with a private
 * spelling (`SpawnPicker`, `SetupWizardDialog`, `peek-modal`), so the FIRST
 * examination was whether ONE seam can carry it, not three patches. The answer is
 * these two constants plus `tests/architecture/one-dialog-viewport-box.test.ts`,
 * which requires a fourth dialog adopting `DIALOG_SCROLL_BODY` to take
 * `DIALOG_VIEWPORT_BOX` with it and refuses the row-340 shape outright.
 *
 * WHY THE BOX IS A *DEFINITE* HEIGHT AND NOT ONLY A `max-h` CAP — THE WORKING
 * DIAGNOSIS, WITH AN IN-REPO CONTROL AS ITS EVIDENCE AND THE DEVICE CHECK STILL
 * OWED. The control is `src/help/HelpDialog.tsx`: it ships this EXACT structure —
 * a `min-h-0 flex-1 overflow-y-auto` body inside a flex-column `DialogContent`
 * with `overflow-hidden` — and it carries a DEFINITE `h-[80vh]`. The picker was
 * byte-for-byte the same pattern except its dialog said `max-h-[85vh]`, and the
 * height TYPE is the only difference. Supporting evidence: the owner reports BOTH
 * no scrolling AND no scrollbar with many screens of core mobs, so the body never
 * overflows even though its content certainly exceeds any cap; `vh` cannot explain
 * that (`85vh` fits an iPad in both orientations — Safari's bars are ~90px and 15%
 * of 1024 is ~150px); and before docs/17 row 336 the DIALOG ITSELF was the
 * scroller (a definite box) and it scrolled, with the regression arriving exactly
 * when an inner `flex-1 min-h-0` child became the scroller. The inference: such a
 * child, under an ancestor whose height is `auto` PLUS a `max-height`, does not
 * reliably get a bounded height on WebKit — it grows to its content height and the
 * ancestor's `overflow-hidden` clips it, so the scroller never overflows and
 * nothing responds to a drag. Desktop Chrome resolves the same CSS correctly,
 * which is why no jsdom pin and no static check can see it (jsdom computes no
 * layout at all). **This is the WORKING DIAGNOSIS, not a device measurement: the
 * iPad check is OWED and confirms (or falsifies) both the control and the
 * mechanism.**
 *
 * WHY THE VALUE MATCHES THE CONTROL RATHER THAN SOMETHING CLEVERER. `h-fit` was
 * considered for the empty space a fixed box leaves under a short list and
 * REJECTED: `fit-content` is an INTRINSIC size, and the spec defines a definite
 * size as one "determined without performing layout" while stating that intrinsic
 * sizing keywords are indefinite (css-sizing-3 §2, "definite size" and its note;
 * `fit-content` resolves to a clamp over min-content/max-content). It therefore
 * does not make the ancestor definite and bounds the flex child no better — it
 * re-spells the `max-height`-only shape. A LENGTH is definite, and `85vh` is the
 * value the picker already carried, so the shipped configuration is the one we can
 * point at working code for. THE COST IS RECORDED RATHER THAN LEFT TO BE
 * DISCOVERED: the box is `85vh`-tall even when the list is short; `h-fit` stays a
 * FUTURE OPTION once the device confirms the mechanism (docs/05 §Battle rail).
 *
 * WHY THE PLAIN VALUE SURVIVES AN OLD iPAD. A browser that knows neither `svh` nor
 * `dvh` (iOS/iPadOS < 16.4) drops the `@supports` declaration WHOLE and keeps only
 * the plain one — and on iOS `vh` is the LARGE viewport (the browser bars are
 * excluded from it), so the plain value must fit WITH the bars showing: `85vh`
 * leaves 15% of the large viewport as headroom against Safari's ~9% of bars on an
 * iPad. The `svh`-bounded `min(85svh,85dvh)` is the REFINEMENT where the units are
 * known: `svh` is the viewport with the bars SHOWING, so it cannot exceed what the
 * user can see, and the `dvh` term still follows a dynamic shrink (the on-screen
 * keyboard). The shared base cap in `DialogContent` stays a `max-h` BELT — a
 * definite height on the base would make all ~40 dialogs full-height — and the
 * plain belt value is the conservative `calc(85vh-2rem)` so the belt is safe on an
 * iOS that drops `@supports` too.
 *
 * Keep each string ONE definition: `tests/architecture/one-dialog-viewport-box.test.ts`
 * reds, naming the site, when either spelling appears anywhere else, and refuses
 * the row-340 shape (`overflow-hidden` + `flex-col` + a `max-h-[…vh]` dialog box).
 */
export const DIALOG_VIEWPORT_BOX = 'h-[85vh] supports-[height:100svh]:h-[min(85svh,85dvh)]';

/**
 * THE BODY OF SUCH A DIALOG — the ONE scroll container inside it (docs/17 rows
 * 336, 340 and 343). `min-h-0` is what lets the flex item shrink below its content
 * height at all; `flex-1` is what makes it take the space the definite height
 * leaves; `overflow-y-auto` is the scroller. Callers add their own layout classes
 * (`gap-3`, `p-4`, `overscroll-contain`) through `cn` — this constant is only the
 * part every one of them must share, and it must not be re-spelled at a call site
 * (`tests/architecture/one-dialog-viewport-box.test.ts`).
 */
export const DIALOG_SCROLL_BODY = 'min-h-0 flex-1 overflow-y-auto';

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // THE PLAIN FALLBACK IS THE *SAFE* VALUE AND THE `@supports` VALUE IS THE
          // REFINEMENT — never the other way round (docs/17 rows 339, 340 and 343).
          // A browser that knows neither `svh` nor `dvh` (iOS/iPadOS < 16.4) drops
          // an `@supports`-gated declaration WHOLE, so the value that survives is
          // the PLAIN one — and on iOS `vh` is the LARGE viewport (the browser bars
          // are excluded from it). A plain `calc(100vh-2rem)` therefore caps a
          // centred dialog against a viewport the user cannot actually see, and a
          // document that never scrolls cannot pan the overflow back into reach.
          // The plain value is consequently `85vh` minus the 2rem gutter: 15% of
          // the large viewport is more headroom than iOS Safari's bars take
          // (measured worst realistic case ~15% total, ~5% on an iPad), so the box
          // fits at ANY percentage the bars show. `svh` — the viewport with the
          // bars SHOWING, the smallest one the user can be looking at — is the
          // refinement behind `@supports`, and `min(svh, dvh)` keeps that floor
          // while still following a DYNAMIC shrink (the on-screen keyboard) when
          // `dvh` reports it. Tailwind emits the `@supports` rule AFTER the plain
          // utilities, so a browser that knows the units gets the bounded value.
          //
          // THIS CAP IS THE *BELT*, NOT A BOUNDED BOX: under the working diagnosis
          // above a `max-height` alone does not reliably bound a `flex-1 min-h-0`
          // child on WebKit, so a dialog whose BODY is the scroller must also carry
          // `DIALOG_VIEWPORT_BOX`'s definite height (docs/17 row 343, and the
          // constant's own doc for the reasoning and the owed iPad check).
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(85vh-2rem)] supports-[height:100svh]:max-h-[min(calc(100svh_-_2rem),calc(100dvh_-_2rem))] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
