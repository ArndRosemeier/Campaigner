import type { JSX } from 'react';
import { MonitorXIcon, RotateCwIcon } from 'lucide-react';

/**
 * Hard orientation gate (05-UI.md §Tablet): Campaigner is a dense,
 * landscape-first workspace — the three-pane layouts need ~1000px of width,
 * so portrait and narrow-landscape viewports are blocked outright rather
 * than degraded into unusable slivers.
 *
 * Pure CSS (media-query variants), so the gate costs no JS and applies
 * identically in a browser tab and as an installed home-screen app (iPadOS
 * ignores the manifest's orientation member and offers no lock() — WebKit
 * supports neither, so the overlay is the only real enforcement).
 *
 * Two cases:
 * - portrait → rotate the device;
 * - landscape but narrower than ~960px (iPhone, Split View, old iPad) → a
 *   wider screen is needed; rotating cannot help there.
 * The app content beneath is pointer-blocked by the overlays; keyboard focus
 * can still technically reach it behind the gate (accepted, documented).
 */
export function OrientationGate(): JSX.Element {
  return (
    <>
      <div
        className="fixed inset-0 z-[100] hidden flex-col items-center justify-center gap-3 bg-background p-8 text-center portrait:flex portrait:pointer-events-auto"
        data-testid="orientation-gate-rotate"
      >
        <RotateCwIcon aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-base font-semibold">Campaigner is built for landscape.</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Rotate your device — the workspace needs the full width for its panes.
        </p>
      </div>
      <div
        className="fixed inset-0 z-[100] hidden flex-col items-center justify-center gap-3 bg-background p-8 text-center landscape:pointer-events-auto landscape:max-[959px]:flex"
        data-testid="orientation-gate-narrow"
      >
        <MonitorXIcon aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-base font-semibold">This screen is too narrow.</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Campaigner needs at least ~960px of width — open it on a tablet or desktop, without a
          split view.
        </p>
      </div>
    </>
  );
}
