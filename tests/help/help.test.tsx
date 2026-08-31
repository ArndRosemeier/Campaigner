import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HELP_CONTENT, HELP_TOPIC_IDS } from '@/help/helpContent';
import { HelpDialog } from '@/help/HelpDialog';
import { HelpButton } from '@/help/HelpButton';
import { useHelpStore } from '@/help/helpStore';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '@/app/layout/AppShell';

/**
 * In-app help system: content registry completeness, the searchable dialog,
 * contextual buttons and the '?' shortcut.
 */

beforeEach(() => {
  useHelpStore.setState({ topic: null });
});
afterEach(cleanup);

describe('help content registry', () => {
  it('has complete entries for every topic', () => {
    expect(HELP_TOPIC_IDS.length).toBeGreaterThanOrEqual(10);
    const seen = new Set<string>();
    for (const id of HELP_TOPIC_IDS) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const entry = HELP_CONTENT[id];
      expect(entry.title.length).toBeGreaterThan(3);
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(entry.tips.length).toBeGreaterThanOrEqual(3);
      for (const tip of entry.tips) {
        expect(tip.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('HelpDialog', () => {
  it('opens on a requested topic via HelpButton and shows its tips', async () => {
    render(
      <>
        <HelpButton topic="tree" label="artifact library" />
        <HelpDialog />
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Help: artifact library' }));

    const dialog = await screen.findByTestId('help-dialog');
    const content = within(dialog).getByTestId('help-content');
    expect(within(content).getByText('Artifact library (left pane)')).toBeDefined();
    expect(within(content).getByText(/hover a row and click the trash icon/i)).toBeDefined();

    // switching topics inside the dialog
    await user.click(within(dialog).getByRole('button', { name: 'Link graph' }));
    expect(
      within(screen.getByTestId('help-content')).getByText(
        'A visual map of the campaign: artifacts as nodes clustered by kind, links as labeled edges.',
      ),
    ).toBeDefined();
  }, 20000);

  it('filters topics by search text', async () => {
    useHelpStore.setState({ topic: 'start' });
    render(<HelpDialog />);
    const user = userEvent.setup();
    const dialog = await screen.findByTestId('help-dialog');

    await user.type(within(dialog).getByTestId('help-search'), 'embedding');
    expect(within(dialog).getByRole('button', { name: 'Embeddings' })).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Link graph' })).toBeNull();

    await user.clear(within(dialog).getByTestId('help-search'));
    await user.type(within(dialog).getByTestId('help-search'), 'zzzz-nothing');
    expect(within(dialog).getByText('No matching topic.')).toBeDefined();
  }, 20000);

  it('closes via the dialog and resets to closed state', async () => {
    useHelpStore.setState({ topic: 'settings' });
    render(<HelpDialog />);
    const user = userEvent.setup();
    await screen.findByTestId('help-dialog');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(useHelpStore.getState().topic).toBeNull();
      expect(screen.queryByTestId('help-dialog')).toBeNull();
    });
  }, 20000);
});

describe('? shortcut', () => {
  it('opens help from the app shell unless typing in a field', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('help-dialog')).toBeNull();

    await userEvent.keyboard('?');
    await waitFor(() => {
      expect(useHelpStore.getState().topic).toBe('start');
    });
    expect(await screen.findByTestId('help-dialog')).toBeDefined();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(useHelpStore.getState().topic).toBeNull();
    });

    // typing '?' into an input must NOT open help
    const input = document.createElement('input');
    input.value = '';
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('?');
    expect(useHelpStore.getState().topic).toBeNull();
    input.remove();
  }, 20000);
});
