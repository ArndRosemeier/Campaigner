import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, newId, type AnyArtifact } from '@/domain';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';

/**
 * Alias support in quick-find (the gap queued by 15-GRAPH-RETRIEVAL §6):
 * `aliases` is one more searchable MiniSearch field next to name/tags/summary.
 * Quickfind is a SEARCH surface, not a grounding one — no span consumption and
 * no longest-match exclusivity — so two artifacts sharing an alias BOTH appear
 * and nothing is deduplicated; phantom/unresolved names have no artifact and
 * never surface. The module reader's "Use existing entity" picker reuses this
 * dialog (ModuleReaderPage LinkExistingPicker), so it inherits the behavior.
 */

function renderQuickFind(artifacts: readonly AnyArtifact[]): void {
  render(<QuickFindDialog open onOpenChange={vi.fn()} artifacts={artifacts} mode="picker" />);
}

describe('QuickFindDialog alias search', () => {
  afterEach(cleanup);

  it('surfaces an artifact by a lowercase alias query and hints the verbatim alias', async () => {
    const user = userEvent.setup();
    const artifact = createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Ember Council',
      summary: 'The ruling circle of the burned city.',
      aliases: ['Ashen Council'],
    });
    renderQuickFind([artifact]);

    await user.type(screen.getByTestId('quickfind-input'), 'ashen council');
    const item = await screen.findByTestId('quickfind-artifact');
    expect(item).toHaveTextContent('Ember Council');
    expect(item).toHaveTextContent('aka: Ashen Council');
  });

  it('keeps name, tags and summary matching unchanged when aliases exist', async () => {
    const user = userEvent.setup();
    const artifact = createArtifact({
      campaignId: newId(),
      kind: 'faction',
      name: 'Ember Council',
      tags: ['ruling-body'],
      summary: 'Rulers of the burned city.',
      aliases: ['Ashen Council'],
    });
    renderQuickFind([artifact]);
    const input = screen.getByTestId('quickfind-input');

    await user.type(input, 'Ember');
    expect(await screen.findByTestId('quickfind-artifact')).toHaveTextContent('Ember Council');

    await user.clear(input);
    await user.type(input, 'ruling');
    expect(await screen.findByTestId('quickfind-artifact')).toHaveTextContent('Ember Council');

    await user.clear(input);
    await user.type(input, 'rulers');
    expect(await screen.findByTestId('quickfind-artifact')).toHaveTextContent('Ember Council');
  });

  it('shows BOTH artifacts sharing the same alias as separate rows (search, not detection)', async () => {
    const user = userEvent.setup();
    const campaignId = newId();
    const npc = createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Ember Council',
      aliases: ['The Council'],
    });
    const faction = createArtifact({
      campaignId,
      kind: 'faction',
      name: 'Council of Ash',
      aliases: ['The Council'],
    });
    renderQuickFind([npc, faction]);

    await user.type(screen.getByTestId('quickfind-input'), 'the council');
    const items = await screen.findAllByTestId('quickfind-artifact');
    expect(items).toHaveLength(2);
    const names = items.map((item) => item.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Ember Council'),
        expect.stringContaining('Council of Ash'),
      ]),
    );
  });

  it('never surfaces a phantom/unresolved name (body text is not the artifact index)', async () => {
    const user = userEvent.setup();
    const artifact = createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Ember Council',
      body: 'Zarathanis fell long before the council rose.',
    });
    renderQuickFind([artifact]);

    await user.type(screen.getByTestId('quickfind-input'), 'Zarathanis');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
    expect(screen.queryByTestId('quickfind-artifact')).not.toBeInTheDocument();
  });
});
