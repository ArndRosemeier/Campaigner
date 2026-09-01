import { useState } from 'react';
import type { JSX } from 'react';
import { SmartphoneIcon, XIcon } from 'lucide-react';

import { dismissInstallHint, shouldShowInstallHint } from '@/lib/deviceCapabilities';

/**
 * One-time install nudge (05-UI.md §Tablet): iOS offers no programmatic
 * install prompt, so on touch devices running as a plain browser tab the app
 * explains how to add itself to the home screen (standalone window, no Safari
 * eviction of IndexedDB). Hidden once dismissed (localStorage) or installed.
 */
export function InstallHint(): JSX.Element | null {
  const [visible, setVisible] = useState(() => shouldShowInstallHint());
  if (!visible) return null;

  return (
    <div
      className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm"
      data-testid="install-hint"
    >
      <SmartphoneIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        For the full experience, add Campaigner to your home screen: Share → Add to Home Screen.
        That keeps your data safe from browser cleanup.
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss install hint"
        data-testid="install-hint-dismiss"
        onClick={() => {
          dismissInstallHint();
          setVisible(false);
        }}
      >
        <XIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
