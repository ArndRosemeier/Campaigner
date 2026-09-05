import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { saveModule } from '@/db/moduleRepo';
import { createModule, type Artifact, type Id, type Module } from '@/domain';
import { battlePath } from '@/app/routes';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The editor's run-battle affordance (owner-ratified: own-module anchor +
 * picker fallback): module-scoped encounters run through the module view's
 * own RunBattleButton anchored to their own module; campaign-scoped ones
 * pick a module; both paths keep the two-step replace confirm; zero modules
 * is a named empty state; non-encounter kinds stay untouched. A successful
 * seed navigates straight to the seeded module's battle table.
 */

/** Renders the current router location so tests can assert the navigation. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="route-location">{location.pathname}</span>;
}

async function seedWorld(moduleTitles: string[]): Promise<{
  campaignId: Id;
  encounter: Artifact;
  modules: Module[];
}> {
  const campaign = await createCampaign({ name: 'Run editor', system: 'dnd5e' });
  const modules: Module[] = [];
  for (const title of moduleTitles) {
    modules.push(
      await saveModule(
        createModule({
          campaignId: campaign.id,
          title,
          concept: `Module ${title}.`,
          levelMin: 1,
          levelMax: 4,
          sizeDial: 'standard',
        }),
      ),
    );
  }
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Bridge Ambush',
  });
  return { campaignId: campaign.id, encounter, modules };
}

function requireModule(modules: Module[], index: number): Module {
  const module = modules[index];
  if (module === undefined) throw new Error(`Module ${index} missing`);
  return module;
}

function renderEditor(
  artifact: Artifact,
  campaignId: Id,
  campaignArtifacts: readonly Artifact[],
): void {
  render(
    <MemoryRouter>
      <ArtifactEditor
        artifact={artifact}
        campaignId={campaignId}
        campaignArtifacts={campaignArtifacts}
        campaignSystem="dnd5e"
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('artifact editor run battle', () => {
  it('shows Run battle for a module-owned encounter and seeds its own module', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
    const crypt = requireModule(modules, 0);
    const owned = await createArtifact({
      campaignId,
      moduleId: crypt.id,
      kind: 'encounter',
      name: 'Crypt Gate',
    });
    renderEditor(owned, campaignId, [encounter, owned]);

    const button = screen.getByTestId('run-battle');
    expect(button).toHaveTextContent('Run battle');
    await user.click(button);
    await waitFor(async () => {
      const battle = await db.battles.where('moduleId').equals(crypt.id).first();
      expect(battle?.encounterArtifactId).toBe(owned.id);
    });
    expect(await db.battles.count()).toBe(1);
    // The seed lands the user on the module's battle table — no toast-estimated
    // detour telling them to open it themselves.
    await waitFor(() => {
      expect(screen.getByTestId('route-location')).toHaveTextContent(
        battlePath(campaignId, crypt.id),
      );
    });
    await flushAsyncUpdates();
  });

  it('keeps the two-step replace confirm for the direct module-anchored path', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
    const crypt = requireModule(modules, 0);
    const owned = await createArtifact({
      campaignId,
      moduleId: crypt.id,
      kind: 'encounter',
      name: 'Crypt Gate',
    });
    await seedBattleFromEncounter(campaignId, crypt.id, encounter.id);
    renderEditor(owned, campaignId, [encounter, owned]);
    await flushAsyncUpdates();

    await waitFor(() =>
      expect(screen.getByTestId('run-battle')).toHaveTextContent('Re-run battle'),
    );
    await user.click(screen.getByTestId('run-battle'));
    // Armed only — the running board is not replaced yet.
    expect(screen.getByTestId('run-battle')).toHaveTextContent('Replace running battle?');
    const before = await db.battles.where('moduleId').equals(crypt.id).first();
    expect(before?.encounterArtifactId).toBe(encounter.id);

    await user.click(screen.getByTestId('run-battle'));
    await waitFor(async () => {
      const battle = await db.battles.where('moduleId').equals(crypt.id).first();
      expect(battle?.encounterArtifactId).toBe(owned.id);
    });
    await flushAsyncUpdates();
  });

  it('campaign-scoped encounter opens the module picker and seeds the picked module', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt', 'Tide Bell']);
    const tide = requireModule(modules, 1);
    renderEditor(encounter, campaignId, [encounter]);

    await user.click(screen.getByTestId('run-battle-picker'));
    expect(await screen.findByTestId('run-battle-module-picker')).toBeInTheDocument();
    expect(screen.getByText('Ember Crypt')).toBeInTheDocument();
    expect(screen.getByText('Tide Bell')).toBeInTheDocument();

    const tideRow = screen.getByTestId(`run-battle-module-${tide.id}`);
    expect(tideRow).toHaveTextContent('0 artifacts');
    await user.click(within(tideRow).getByRole('button', { name: 'Run battle' }));
    await waitFor(async () => {
      const battle = await db.battles.where('moduleId').equals(tide.id).first();
      expect(battle?.encounterArtifactId).toBe(encounter.id);
    });
    // The dialog closes once the seed landed.
    await waitFor(() => {
      expect(screen.queryByTestId('run-battle-module-picker')).toBeNull();
    });
    // And the picked module's battle table is where the user ends up.
    await waitFor(() => {
      expect(screen.getByTestId('route-location')).toHaveTextContent(
        battlePath(campaignId, tide.id),
      );
    });
    await flushAsyncUpdates();
  });

  it('picker path asks before replacing a picked module’s running battle', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt', 'Tide Bell']);
    const tide = requireModule(modules, 1);
    const other = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Crypt Gate',
    });
    await seedBattleFromEncounter(campaignId, tide.id, other.id);
    renderEditor(encounter, campaignId, [encounter, other]);

    await user.click(screen.getByTestId('run-battle-picker'));
    const tideRow = () => screen.getByTestId(`run-battle-module-${tide.id}`);
    await user.click(within(await screen.findByTestId(`run-battle-module-${tide.id}`)).getByRole('button', { name: 'Re-run battle' }));
    // Armed only — the running board is not replaced yet.
    expect(within(tideRow()).getByRole('button', { name: 'Replace running battle?' })).toBeInTheDocument();
    const before = await db.battles.where('moduleId').equals(tide.id).first();
    expect(before?.encounterArtifactId).toBe(other.id);

    await user.click(
      within(tideRow()).getByRole('button', { name: 'Replace running battle?' }),
    );
    await waitFor(async () => {
      const battle = await db.battles.where('moduleId').equals(tide.id).first();
      expect(battle?.encounterArtifactId).toBe(encounter.id);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('run-battle-module-picker')).toBeNull();
    });
    await flushAsyncUpdates();
  });

  it('picker rows are arrow-key navigable', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter } = await seedWorld(['Ember Crypt', 'Tide Bell']);
    renderEditor(encounter, campaignId, [encounter]);

    await user.click(screen.getByTestId('run-battle-picker'));
    const list = await screen.findByTestId('run-battle-module-list');
    // Row order is the live query's (updatedAt desc) — derive it from the DOM.
    const rowTestIds = Array.from(
      list.querySelectorAll<HTMLElement>('[data-testid^="run-battle-module-"]'),
    ).map((row) => row.getAttribute('data-testid'));
    const firstRowId = rowTestIds[0];
    const secondRowId = rowTestIds[1];
    if (
      firstRowId === undefined ||
      firstRowId === null ||
      secondRowId === undefined ||
      secondRowId === null
    ) {
      throw new Error('rows missing');
    }

    const focusRowButton = (rowTestId: string): void => {
      within(screen.getByTestId(rowTestId)).getByRole('button', { name: 'Run battle' }).focus();
    };
    const focusedRowId = (): string | null | undefined =>
      (document.activeElement as HTMLElement)
        .closest('[data-testid^="run-battle-module-"]')
        ?.getAttribute('data-testid');

    focusRowButton(firstRowId);
    await user.keyboard('{ArrowDown}');
    expect(focusedRowId()).toBe(secondRowId);
    await user.keyboard('{ArrowUp}');
    expect(focusedRowId()).toBe(firstRowId);
    await flushAsyncUpdates();
  });

  it('picker shows a named empty state when the campaign has no modules', async () => {
    const user = userEvent.setup();
    const { campaignId, encounter } = await seedWorld([]);
    renderEditor(encounter, campaignId, [encounter]);

    await user.click(screen.getByTestId('run-battle-picker'));
    const empty = await screen.findByTestId('run-battle-picker-empty');
    expect(empty).toHaveTextContent('No modules in this campaign yet.');
    expect(empty).toHaveTextContent('Battles anchor to modules');
    expect(screen.queryByTestId('run-battle-module-list')).toBeNull();
    await flushAsyncUpdates();
  });

  it('non-encounter kinds show no run affordance', async () => {
    const { campaignId, encounter } = await seedWorld(['Ember Crypt']);
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Mira' });
    renderEditor(npc, campaignId, [encounter, npc]);

    expect(screen.queryByTestId('run-battle')).toBeNull();
    expect(screen.queryByTestId('run-battle-picker')).toBeNull();
    await flushAsyncUpdates();
  });
});
