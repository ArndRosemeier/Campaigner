import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { AliasEditor } from '@/features/campaign/components/alias-editor';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import {
  EncounterForm,
  LocationForm,
  NpcForm,
  PcForm,
  PlotArcForm,
} from '@/features/campaign/components/kind-forms';
import {
  ExtrasEditor,
  PairListEditor,
  StringListEditor,
} from '@/features/campaign/components/list-editors';
import type { EncounterArtifactData } from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * iPad batch D — inputs & iOS keyboard.
 *
 * Sub-16px inputs make mobile Safari auto-zoom on focus; every shrunken
 * input/textarea/select in the batch-D files carries a
 * `pointer-coarse:text-base` override so the EFFECTIVE font is ≥16px on
 * coarse pointers while desktop (fine pointer) visuals are unchanged. Name /
 * title inputs additionally hint the iOS keyboard (`autocapitalize="words"`
 * + `autocorrect="off"` + a sensible `enterkeyhint`); free-prose fields keep
 * autocorrect ON by deliberate omission.
 */

const COARSE_TEXT = 'pointer-coarse:text-base';

function expectCoarseText(element: HTMLElement): void {
  expect(element).toHaveClass(COARSE_TEXT);
}

function expectNameHints(element: HTMLElement, enterKeyHint: 'done' | 'next'): void {
  expect(element).toHaveAttribute('autocapitalize', 'words');
  expect(element).toHaveAttribute('autocorrect', 'off');
  expect(element).toHaveAttribute('enterkeyhint', enterKeyHint);
}

function expectAutocorrectKept(element: HTMLElement): void {
  // Free prose keeps the OS autocorrect — the attribute must be absent, not
  // merely set to a different value.
  expect(element.getAttribute('autocorrect')).toBeNull();
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('iPad batch D: coarse-pointer 16px floor', () => {
  it('alias editor input keeps desktop size but hits 16px on coarse pointers', () => {
    render(<AliasEditor name="Grix" aliases={[]} onChange={vi.fn()} />);
    expectCoarseText(screen.getByPlaceholderText('Add alias…'));
  });

  it('string/pair/extras row editors hit 16px on coarse pointers', () => {
    render(
      <>
        <StringListEditor label="Hooks" items={['A hook']} onChange={vi.fn()} itemPlaceholder="A hook…" />
        <PairListEditor
          label="Beats"
          labelA="Title"
          labelB="Description"
          rows={[{ a: 'T', b: 'D' }]}
          onChange={vi.fn()}
        />
        <ExtrasEditor extras={{ k: 'v' }} onChange={vi.fn()} />
      </>,
    );
    expectCoarseText(screen.getByPlaceholderText('A hook…'));
    expectCoarseText(screen.getByLabelText('Title 1'));
    expectCoarseText(screen.getByLabelText('Description 1'));
    expectCoarseText(screen.getByLabelText('Extra 1 label'));
    expectCoarseText(screen.getByLabelText('Extra 1 value'));
  });

  it('pair-list name/title inputs hint the iOS keyboard; description side keeps autocorrect', () => {
    render(
      <PairListEditor
        label="Beats"
        labelA="Title"
        labelB="Description"
        rows={[{ a: 'T', b: 'D' }]}
        onChange={vi.fn()}
      />,
    );
    expectNameHints(screen.getByLabelText('Title 1'), 'next');
    expectAutocorrectKept(screen.getByLabelText('Description 1'));
  });

  it('PC player name is a name-hinted input; notes prose keeps autocorrect', () => {
    render(
      <PcForm
        data={{ playerName: '', currentHp: 10, initiativeOverride: null, notes: '', statBlock: null }}
        campaignSystem="dnd5e"
        onChange={vi.fn()}
      />,
    );
    const playerName = screen.getByLabelText('Player name');
    expectCoarseText(playerName);
    expectNameHints(playerName, 'next');
    const notes = screen.getByLabelText('Notes');
    expectCoarseText(notes);
    expectAutocorrectKept(notes);
  });

  it('NPC appearance/personality prose hits 16px but keeps autocorrect', () => {
    render(
      <NpcForm
        artifactName="Grix"
        data={{ appearance: '', personality: '', statBlock: null }}
        campaignSystem="dnd5e"
        onChange={vi.fn()}
      />,
    );
    const appearance = screen.getByLabelText('Appearance');
    expectCoarseText(appearance);
    expectAutocorrectKept(appearance);
  });

  it('location + plot-arc forms hit 16px; premise prose keeps autocorrect', () => {
    render(
      <>
        <LocationForm
          data={{ locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] }}
          onChange={vi.fn()}
        />
        <PlotArcForm
          data={{ arcType: '', premise: '', stakes: '', beats: [], hooks: [], climax: '' }}
          onChange={vi.fn()}
        />
      </>,
    );
    expectCoarseText(screen.getByLabelText('Location type'));
    expectCoarseText(screen.getByLabelText('Arc type'));
    const premise = screen.getByLabelText('Premise');
    expectCoarseText(premise);
    expectAutocorrectKept(premise);
  });

  it('encounter monster name is name-hinted; difficulty/terrain hit 16px', () => {
    const data: EncounterArtifactData = {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Bandit', count: 4, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    render(
      <EncounterForm data={data} campaignArtifacts={[]} campaignSystem="dnd5e" onChange={vi.fn()} />,
    );
    const monsterName = screen.getByLabelText('Monster name');
    expectCoarseText(monsterName);
    expectNameHints(monsterName, 'next');
    expectCoarseText(screen.getByLabelText('Difficulty'));
    expectCoarseText(screen.getByLabelText('Terrain'));
    expectAutocorrectKept(screen.getByLabelText('Monster notes'));
  });

  it('edit-campaign dialog: name is name-hinted, description keeps autocorrect', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The dialog navigates after destructive actions (clear-workspace arc),
    // so it renders inside router context.
    render(
      <MemoryRouter initialEntries={['/']}>
        <EditCampaignDialog campaign={campaign} open onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );
    const name = screen.getByLabelText('Campaign name');
    expectCoarseText(name);
    expectNameHints(name, 'next');
    const description = screen.getByLabelText('Campaign description');
    expectCoarseText(description);
    expectAutocorrectKept(description);
  });
});
