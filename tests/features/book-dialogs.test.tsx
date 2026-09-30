import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PackMeta, Rulebook } from '@/domain/rulebook';
import { BookDialogs } from '@/features/rules/book-dialogs';

/**
 * License-dialog provenance display (12-BESTIARY-PACKS §2, F3): fetched packs
 * show their fetch provenance — source ref, source URL, fetched-at — in the
 * existing license dialog; pre-provenance (manual) books keep the dialog
 * unchanged.
 */

function bookWith(packMeta: PackMeta | null): Rulebook {
  return {
    id: '01890a5d-ac96-774b-bcce-b302099a8057',
    createdAt: 1,
    updatedAt: 1,
    title: 'NPC Gallery',
    system: 'pathfinder2e',
    filename: 'pack.json',
    pageCount: 0,
    status: 'ready',
    errorMessage: '',
    origin: 'pack',
    packMeta,
  };
}

const SOURCE_URL = 'https://github.com/foundryvtt/pf2e/tree/v14-dev/packs/pf2e/npc-gallery';
const FETCHED_AT = 1757000000000;

const FETCHED_META: PackMeta = {
  sourceId: 'foundry-pf2e',
  license: 'Paizo Community Use Policy; mechanics OGL',
  entriesImported: 6,
  entriesSkipped: 1,
  entriesFailed: 0,
  sourceRef: 'v14-dev',
  sourceUrl: SOURCE_URL,
  fetchedAt: FETCHED_AT,
};

const MANUAL_META: PackMeta = {
  sourceId: 'foundry-pf2e',
  license: 'Paizo Community Use Policy; mechanics OGL',
  entriesImported: 6,
  entriesSkipped: 1,
  entriesFailed: 0,
};

/** The dialog is controlled; these tests never close it. */
function keepOpen(): void {
  // Opening state is fixed by the `action` prop in each test.
}

describe('LicenseDialog provenance (F3)', () => {
  afterEach(cleanup);

  it('shows the ref, source URL and fetched-at lines for a fetched book', () => {
    render(<BookDialogs book={bookWith(FETCHED_META)} action="license" onOpenChange={keepOpen} />);

    const provenance = screen.getByTestId('pack-provenance');
    expect(within(provenance).getByText('Source ref: v14-dev')).toBeInTheDocument();
    const link = within(provenance).getByRole('link', { name: SOURCE_URL });
    expect(link).toHaveAttribute('href', SOURCE_URL);
    expect(
      within(provenance).getByText(`Fetched at: ${new Date(FETCHED_AT).toISOString()}`),
    ).toBeInTheDocument();
    // The license line itself is unchanged.
    expect(screen.getByTestId('pack-license')).toHaveTextContent(/Community Use Policy/);
  });

  it('keeps the dialog unchanged for a pre-provenance (manual) book', () => {
    render(<BookDialogs book={bookWith(MANUAL_META)} action="license" onOpenChange={keepOpen} />);

    expect(screen.getByTestId('pack-license')).toHaveTextContent(/Community Use Policy/);
    expect(screen.queryByTestId('pack-provenance')).not.toBeInTheDocument();
  });
});
