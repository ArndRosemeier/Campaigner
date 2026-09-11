import 'fake-indexeddb/auto';

import { render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpineCheckpoint } from '@/features/modules/spine-checkpoint';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';
import { expectBlockedReason, expectSelfEvidentElement } from '../helpers/blocked-reason';
import type { Campaign, ModuleEntityKind, ModuleSpine } from '@/domain';

/**
 * Spine approval checkpoint (08-MODULE-DESIGNER M4-B) with the fix-01
 * entities line: the normalized glossary is displayed read-only, with
 * absorbed variants shown next to their canonical entity.
 */

const SPINE: ModuleSpine = {
  premise: 'A harbor town raised its bell to warn of the drownings.',
  themes: ['duty', 'decay'],
  writerModel: '',
  partPlan: [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives with the low tide.',
      levelUpTrigger: 'The bell is found.',
    },
  ],
};

let campaign: Campaign;

beforeEach(async () => {
  await clearDatabase();
  campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
});

afterEach(() => {
  // No chat is called here — the checkpoint is display + delegation only.
});

describe('SpineCheckpoint entities line (fix-01)', () => {
  it('lists canonical entities with their kinds and absorbed variants', () => {
    const entityKinds: ModuleEntityKind[] = [
      { name: 'Halmund', kind: 'npc', absorbed: ['Guard Halmund', 'Halmunds'] },
      { name: 'The Undercroft', kind: 'location', absorbed: [] },
    ];
    render(
      <SpineCheckpoint
        moduleId={campaign.id}
        campaign={campaign}
        spine={SPINE}
        busy={false}
        entityKinds={entityKinds}
      />,
    );
    const line = screen.getByTestId('spine-entities');
    expect(line).toHaveTextContent('Halmund (npc; also: Guard Halmund, Halmunds)');
    expect(line).toHaveTextContent('The Undercroft (location)');
  });

  it('shows no entities line for a glossary-less spine', () => {
    render(
      <SpineCheckpoint
        moduleId={campaign.id}
        campaign={campaign}
        spine={SPINE}
        busy={false}
        entityKinds={[]}
      />,
    );
    expect(screen.queryByTestId('spine-entities')).not.toBeInTheDocument();
  });
});

/**
 * The checkpoint's four `busy` controls state WHY they cannot act (docs/18 §2.3,
 * docs/05 §Why a control cannot act; docs/17 row 99) — and the two move buttons
 * that are merely at an end are pinned as carrying NO reason, so the self-evident
 * judgement is a decision rather than an omission.
 */
describe('SpineCheckpoint blocked-control reasons', () => {
  const GENERATING = 'The module is generating right now — wait for it (or press Stop).';

  function checkpoint(busy: boolean): JSX.Element {
    return (
      <SpineCheckpoint
        moduleId={campaign.id}
        campaign={campaign}
        spine={SPINE}
        busy={busy}
        entityKinds={[]}
      />
    );
  }

  it('all four busy-gated controls state the generating reason while the module generates', async () => {
    const user = userEvent.setup();
    const { rerender } = render(checkpoint(false));
    // The retry panel has to be OPEN before the flag flips (its toggle is one of
    // the gated controls), so open it live and then raise `busy`.
    await user.click(screen.getByTestId('spine-retry-toggle'));
    await screen.findByTestId('spine-retry-run');
    rerender(checkpoint(true));

    for (const testId of [
      'generate-parts',
      'spine-retry-toggle',
      'spine-discard',
      'spine-retry-run',
    ]) {
      await expectBlockedReason(user, testId, GENERATING);
    }
  }, 30_000);

  it('SELF-EVIDENT: the first part cannot move up and the only part cannot move down — no reason on either', () => {
    render(checkpoint(false));
    // The one-part plan is both ends at once: disabled, and bare.
    expectSelfEvidentElement(screen.getByLabelText('Move part 1 up'));
    expectSelfEvidentElement(screen.getByLabelText('Move part 1 down'));
  });
});
