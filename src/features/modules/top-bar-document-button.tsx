import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import { BookOpenIcon } from 'lucide-react';

import { documentPath } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Top-bar entry to the campaign's ONE document (docs/17 row 389).
 *
 * It was `TopBarNewModuleButton`, a second "New Module" door that opened the
 * creation dialog from every route. With one document per campaign there is no
 * second module to create, so the door became a LINK: `documentPath` resolves
 * the campaign's single row and lands on its document, or offers the create
 * state when the campaign has none yet. Creation therefore happens in exactly
 * ONE place (the campaign landing's create state), and the top bar keeps the
 * same one-click route into the campaign's document that it always had.
 */
export function TopBarDocumentButton({ campaignId }: { campaignId: string }): JSX.Element | null {
  if (campaignId === '') return null;

  return (
    <NavLink
      to={documentPath(campaignId)}
      aria-label="Document"
      data-testid="topbar-document"
      className={({ isActive }) =>
        cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          isActive && 'bg-accent text-accent-foreground',
        )
      }
    >
      <BookOpenIcon aria-hidden data-icon="inline-start" />
      Document
    </NavLink>
  );
}
