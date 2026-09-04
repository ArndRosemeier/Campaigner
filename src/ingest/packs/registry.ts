import { foundryDnd5eSrdAdapter } from './dnd5e-foundry';
import { foundryPf2eAdapter } from './pf2e-foundry';
import type { PackAdapter } from './types';

/**
 * Registered pack adapters (12-BESTIARY-PACKS §5). Adding a source is one
 * adapter file plus one entry here.
 */
export const PACK_ADAPTERS: readonly PackAdapter[] = [foundryPf2eAdapter, foundryDnd5eSrdAdapter];

export function getPackAdapter(id: string): PackAdapter {
  const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter === undefined) {
    throw new Error(
      `unknown pack adapter "${id}" (available: ${PACK_ADAPTERS.map((entry) => entry.id).join(', ')})`,
    );
  }
  return adapter;
}
