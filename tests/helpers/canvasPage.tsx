import { render, screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { expect } from 'vitest';

import { createAppRouter } from '@/app/router';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * THE shared canvas-page test harness (docs/17 row 408): the route-level render
 * and the campaign chat's two sidebar drivers, which had been pasted into every
 * canvas suite — the duplication tripwire's own inventory named this fold
 * ("ONE `tests/helpers/renderApp.ts` is the obvious seam"; "foldable onto a
 * shared canvas-chat test helper"), so the copies live here ONCE and a suite
 * that needs them imports them instead of pasting a third variant.
 *
 * These are TEST drivers only: they carry no product behaviour, and every one
 * of them drives the app exactly as the owner does (type, click, drain).
 */

/** Renders the app router at one route. */
export function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

/**
 * Opens the canvas chat sidebar and makes sure the EDITOR is the mounted view
 * (the canvas opens in preview): the chat flows drive the editor.
 */
export async function openSidebar(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // Front door: the sidebar is OPEN by default — only toggle when closed.
  if (screen.queryByTestId('canvas-chat') === null) {
    await user.click(await screen.findByTestId('canvas-chat-toggle'));
  }
  expect(await screen.findByTestId('canvas-chat')).toBeInTheDocument();
  // The canvas opens in preview by default — these flows drive the editor.
  if (screen.queryByTestId('canvas-preview') !== null) {
    await user.click(screen.getByTestId('canvas-preview-toggle'));
  }
  await screen.findByTestId('canvas-editor');
}

/** Types an instruction and sends it; drains the detached chat chain. */
export async function sendChat(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const input = screen.getByTestId('canvas-chat-input');
  await user.type(input, text);
  await user.click(screen.getByTestId('canvas-chat-send'));
  await flushAsyncUpdates();
}
