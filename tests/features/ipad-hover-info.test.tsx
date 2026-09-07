import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { CampaignBar } from '@/app/layout/CampaignBar';
import { createArtifact as saveArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import {
  blankStatBlock,
  createArtifact as buildArtifact,
  createModule,
  moduleSchema,
  newId,
  type Id,
  type Module,
} from '@/domain';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { CampaignTree } from '@/features/campaign/components/campaign-tree';
import { EncounterLayoutPreview } from '@/features/campaign/components/encounter-layout-preview';
import { MarkdownBody } from '@/features/campaign/components/markdown-body';
import { TagEditor } from '@/features/campaign/components/tag-editor';
import { StatBlockForm } from '@/features/campaign/components/stat-block';
import { MonsterSourceControls } from '@/features/campaign/components/monster-source';
import { EntityPanel } from '@/features/modules/entity-panel';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import type { EncounterLayout } from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * iPad batch E — hover-only info, tree rows, pane minima, leftover inputs.
 *
 * Half 1 (hover-only reveals): the sweep found exactly two
 * `group-hover:opacity-100` reveals in campaign/module UI (tree-row delete,
 * run delete) and BOTH already carry `pointer-coarse:opacity-100` plus
 * `focus-visible:opacity-100` — pinned here so no future edit drops the
 * coarse/focus fallback.
 *
 * Half 2 (title-only essential info): every `title=` that carried info with
 * no touch/AT path now has an aria mirror (encounter-preview room names as
 * role=img labels, adopt consequences + disabled-reason + ambiguity warning
 * in the entity panel, disabled-tab reason in the campaign bar). Verified
 * no-change: persona-panel inspect/copy/close (aria-labels + visible
 * affordances already), RulesPage error + entity normalize/batch-gate
 * reasons (full text already visible beside the title), ModuleReader
 * StatusBadge (module-failed-banner role=alert carries the text), TopBar
 * last-module shortcut + campaign crumb (full name is the accessible name
 * and one tap reaches the titled page).
 *
 * Half 3: tree rows hit 44px on coarse pointers; workspace minima drop to
 * 200/360/280 (840 total — the default 22/48/30 layout clears every floor
 * at 1024px iPad landscape; the orientation gate blocks <~960px) and the
 * persona pane is collapsible. Only WorkspacePage consumes the minima
 * (generic ResizablePanel, no other caller) — the numbers are pinned in
 * docs/05-UI.md, not assertable in jsdom (no layout), so the test pins the
 * row floor plus the three panes co-mounting.
 *
 * Half 4: the batch-D out-of-scope leftovers get the same
 * `pointer-coarse:text-base` floor. Search fields keep OS autocorrect (batch-D
 * convention: only proper-name fields hint the keyboard, and none of these
 * are names).
 */

const COARSE_TEXT = 'pointer-coarse:text-base';

beforeEach(clearDatabase);
afterEach(cleanup);

describe('iPad batch E half 1: hover reveals keep coarse + focus fallbacks', () => {
  it('tree-row delete stays visible on coarse pointers and on focus', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gorim = buildArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gorim',
    });
    render(
      <MemoryRouter>
        <CampaignTree
          campaignId={campaign.id}
          artifacts={[gorim]}
          globals={[]}
          selectedArtifactId={undefined}
          onSelectArtifact={vi.fn()}
        />
      </MemoryRouter>,
    );

    const deleteButton = await screen.findByRole('button', { name: 'Delete Gorim' });
    expect(deleteButton).toHaveClass('group-hover/row:opacity-100');
    expect(deleteButton).toHaveClass('pointer-coarse:opacity-100');
    expect(deleteButton).toHaveClass('focus-visible:opacity-100');
  });

  it('tree rows reach the 44px touch floor on coarse pointers', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gorim = buildArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gorim',
    });
    render(
      <MemoryRouter>
        <CampaignTree
          campaignId={campaign.id}
          artifacts={[gorim]}
          globals={[]}
          selectedArtifactId={undefined}
          onSelectArtifact={vi.fn()}
        />
      </MemoryRouter>,
    );

    const row = (await screen.findByText('Gorim')).parentElement;
    expect(row).toHaveClass('pointer-coarse:min-h-11');
    // Desktop row sizing is untouched.
    expect(row).toHaveClass('px-2', 'py-1');
  });
});

const PREVIEW_ROOM: EncounterLayout['rooms'][number] = {
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Entry',
  rects: [{ x: 1, y: 1, w: 6, h: 6 }],
  mobsRect: { x: 2, y: 2, w: 4, h: 4 },
  description: '',
  monsterIndexes: [],
  spawn: true,
  key: '',
  keyTreasure: '',
  entrance: { x: 1, y: 1, side: 'north' },
};

const PREVIEW_LAYOUT: EncounterLayout = {
  gridW: 12,
  gridH: 12,
  theme: 'test',
  rooms: [PREVIEW_ROOM],
  corridors: [],
};

describe('iPad batch E half 2: title-only info gains a touch/AT mirror', () => {
  it('encounter preview exposes every room title as a labelled image', () => {
    render(<EncounterLayoutPreview layout={PREVIEW_LAYOUT} />);

    expect(screen.getByRole('img', { name: 'Entry' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Entry mob area' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Entry entrance' })).toBeInTheDocument();
  });

  it('entity adopt button names the ownership consequence, not just the action', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = minimalModule(campaign.id, '[[Joren]] keeps the gate.');
    const joren = await saveArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Joren',
    });
    render(
      <MemoryRouter>
        <EntityPanel
          module={module}
          artifacts={[joren]}
          campaign={campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />
      </MemoryRouter>,
    );

    const adopt = await screen.findByRole('button', { name: /Adopt Joren into the campaign/ });
    expect(adopt).toHaveAttribute(
      'aria-label',
      "Adopt Joren into the campaign — moves it out of this module's ownership",
    );
  });

  it('ambiguous rows expose the multi-match warning beyond hover', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = minimalModule(campaign.id, '[[Mira]] guards the seal.');
    const miraA = await saveArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    const miraB = await saveArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Mira' });
    render(
      <MemoryRouter>
        <EntityPanel
          module={module}
          artifacts={[miraA, miraB]}
          campaign={campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />
      </MemoryRouter>,
    );

    const warning = await screen.findByText('Multiple artifacts match this name');
    expect(warning).toHaveClass('sr-only');
  });

  it('disabled image checkbox explains itself instead of relying on hover', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = minimalModule(campaign.id, '[[Kael]] watches the gate.');
    render(
      <MemoryRouter>
        <EntityPanel
          module={module}
          artifacts={[]}
          campaign={campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByTestId('entity-images'));
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Detail Kael first — images attach to its artifact',
    });
    // The mirror, not the hover-only title, is the accessible name now.
    expect(checkbox).toHaveAttribute(
      'title',
      'Detail this entity first — images attach to its artifact',
    );
  });

  it('disabled campaign tabs name their reason for touch + screen readers', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <CampaignBar />
      </MemoryRouter>,
    );

    const modules = screen.getByRole('button', { name: 'Modules — open a campaign first' });
    expect(modules).toBeDisabled();
    expect(modules).toHaveAttribute('title', 'Open a campaign first');
  });
});

describe('iPad batch E halves 3+4: panes co-mount, leftover inputs hit 16px', () => {
  it('workspace mounts tree, editor and persona panes together', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await saveArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Gorim' });
    render(
      <MemoryRouter initialEntries={[workspacePath(campaign.id)]}>
        <Routes>
          <Route path={ROUTES.workspace} element={<WorkspacePage />} />
          <Route path={ROUTES.artifact} element={<WorkspacePage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Gorim')).toBeInTheDocument();
    expect(screen.getByTestId('persona-panel')).toBeInTheDocument();
  });

  it('markdown body textarea hits 16px on coarse pointers', () => {
    render(<MarkdownBody value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Free-text content, written in Markdown…')).toHaveClass(
      COARSE_TEXT,
    );
  });

  it('tag editor input hits 16px on coarse pointers', () => {
    render(<TagEditor tags={[]} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Add tag…')).toHaveClass(COARSE_TEXT);
  });

  it('stat-block text and number fields hit 16px on coarse pointers', () => {
    render(<StatBlockForm statBlock={blankStatBlock('dnd5e')} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Level')).toHaveClass(COARSE_TEXT);
    expect(screen.getByLabelText('AC')).toHaveClass(COARSE_TEXT);
    expect(screen.getByLabelText('HP')).toHaveClass(COARSE_TEXT);
  });

  it('quick-find search input hits 16px on coarse pointers', () => {
    render(<QuickFindDialog open onOpenChange={vi.fn()} artifacts={[]} mode="picker" />);
    expect(screen.getByTestId('quickfind-input')).toHaveClass(COARSE_TEXT);
  });

  it('rulebook stat-block search input hits 16px on coarse pointers', async () => {
    const user = userEvent.setup();
    render(
      <MonsterSourceControls
        entry={{
          name: 'Goblin',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: newId() },
        }}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Change rulebook stat block' }));
    expect(screen.getByPlaceholderText('Search stat blocks…')).toHaveClass(COARSE_TEXT);
  });
});

function minimalModule(campaignId: Id, premise: string): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A crypt guarding an old seal.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({
    ...base,
    spine: {
      premise,
      themes: [],
      partPlan: [
        {
          title: 'The Seal',
          levelBand: '1–2',
          synopsis: 'Reach the seal beneath the crypt.',
          levelUpTrigger: 'The seal breaks.',
        },
      ],
    },
    parts: [],
    entityKinds: [],
    entityNamesNormalized: true,
  });
}
