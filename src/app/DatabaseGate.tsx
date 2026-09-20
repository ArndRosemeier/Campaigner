import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { BLOCKED_UPGRADE_MESSAGE, openCampaignerDatabase } from '@/db/dbBoot';

/**
 * THE boot gate (docs/17 row 278, inventory §f.6): opens the database ONCE,
 * before the app renders, and gives the clean-cut upgrade the one surface it is
 * allowed to fail on.
 *
 * - While the open is pending (including a BLOCKED upgrade, another tab holding
 *   the database) a named line renders; nothing is deleted and the app proceeds
 *   the moment the upgrade completes.
 * - A REJECTED open (the versionchange transaction aborted atomically: the
 *   stored version is unchanged and every row survives) renders a NAMED recovery
 *   card — "nothing was removed", the error's own text, and Reload, which IS the
 *   correct retry — instead of the generic error boundary.
 * - A NEWER stored database renders the app with a NON-BLOCKING notice naming
 *   both versions, and performs no delete.
 */
export function DatabaseGate({ children }: { children: ReactNode }): JSX.Element {
  const [opening, setOpening] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [newer, setNewer] = useState<{ stored: number; declared: number } | null>(null);

  useEffect(() => {
    let active = true;
    void openCampaignerDatabase({
      onBlocked: () => {
        if (active) setBlocked(true);
      },
    }).then((result) => {
      if (!active) return;
      setOpening(false);
      if (result.status === 'failed') {
        setError(result.error ?? new Error('The database could not be opened.'));
        return;
      }
      if (result.newerVersion !== undefined) setNewer(result.newerVersion);
    });
    return () => {
      active = false;
    };
  }, []);

  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center"
        data-testid="clean-cut-recovery"
      >
        <h1 className="text-lg font-semibold">Campaigner could not prepare this browser’s data</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Nothing was removed. The update did not finish, so this browser’s data is exactly as it
          was — reloading tries the same update again from scratch.
        </p>
        <pre
          data-testid="clean-cut-recovery-message"
          className="max-w-xl overflow-auto rounded-md border bg-muted/40 p-3 text-left text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {error.message}
        </pre>
        <Button
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload Campaigner
        </Button>
      </div>
    );
  }

  if (opening) {
    return (
      <div
        className="flex h-dvh flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="clean-cut-opening"
      >
        <p className="text-sm text-muted-foreground">Preparing Campaigner…</p>
        {blocked && (
          <p className="max-w-xl text-sm" data-testid="clean-cut-blocked">
            {BLOCKED_UPGRADE_MESSAGE}
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {newer !== null && (
        <p
          className="border-b bg-muted/40 px-4 py-1 text-center text-xs text-muted-foreground"
          data-testid="clean-cut-newer"
        >
          This browser’s Campaigner data was written by a newer version (database{' '}
          {String(newer.stored)}; this build understands {String(newer.declared)}). Nothing was
          changed — update Campaigner to use it.
        </p>
      )}
      {children}
    </>
  );
}
