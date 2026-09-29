import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangleIcon } from 'lucide-react';

import { campaignIdFromPath, modulePath } from '@/app/routes';
import { useModules } from '@/features/modules/hooks';

/**
 * THE legacy multi-module notice (docs/23 §10 phase 2, docs/17 row 389).
 *
 * A campaign owns ONE document, but a database written before this rule (or an
 * imported/restored bundle) can still carry SEVERAL module rows. Those extra
 * rows are NEVER hidden and NEVER purged: AGENTS rules 1/2 forbid a silent
 * disappearance, and the spec's phase-2 column takes no schema change, so no
 * `version` bump removes them. This bar NAMES every extra row and LINKS to it
 * (its reader, where the ordinary delete control lives), so nothing becomes
 * unreachable and the owner can dispose of it deliberately.
 *
 * It is mounted ONCE, in the campaign bar, so it is visible on every
 * campaign-scoped route (document, reader, canvas, board, workspace, battle) —
 * one mount instead of one banner per surface. The ONE document is the first
 * row in arc order (`hooks.useModules`), exactly the row the landing reaches.
 */
export function LegacyModulesNotice(): JSX.Element | null {
  const { pathname } = useLocation();
  const campaignId = campaignIdFromPath(pathname);
  const modules = useModules(campaignId);

  // `undefined` = still loading; 0/1 rows = the ratified shape, nothing to say.
  if (modules === undefined || modules.length < 2) return null;

  const [document, ...extras] = modules;
  if (document === undefined) return null;

  return (
    <div
      className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-200"
      role="status"
      data-testid="legacy-extra-modules"
    >
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangleIcon aria-hidden className="size-3.5 shrink-0" />
        <span>
          This campaign has {modules.length} module rows, but exactly ONE document is supported. You
          are reading <strong>“{document.title}”</strong>. Extra:{' '}
          {extras.map((module, index) => (
            <span key={module.id}>
              {index > 0 ? ', ' : ''}
              <Link
                className="font-medium underline underline-offset-2"
                to={modulePath(campaignId ?? '', module.id)}
                data-testid={`legacy-extra-module-${module.id}`}
              >
                “{module.title}”
              </Link>
            </span>
          ))}
          .
        </span>
      </span>
    </div>
  );
}
