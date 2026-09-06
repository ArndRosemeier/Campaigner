import { foundryDnd5eEquipmentAdapter } from './dnd5e-equipment';
import { foundryDnd5eSrdAdapter } from './dnd5e-foundry';
import { foundryPf2eAdapter } from './pf2e-foundry';
import { foundryPf2eEquipmentAdapter } from './pf2e-equipment';
import type { PackAdapter } from './types';

/**
 * Registered pack adapters (12-BESTIARY-PACKS §5/§12). Adding a source is one
 * adapter file plus one entry here. Creature and equipment adapters are
 * parallel per-system parsers — the pf2e pair shares a repo but different
 * document types (npc vs item), each with its own fetch source.
 */
export const PACK_ADAPTERS: readonly PackAdapter[] = [
  foundryPf2eAdapter,
  foundryDnd5eSrdAdapter,
  foundryPf2eEquipmentAdapter,
  foundryDnd5eEquipmentAdapter,
];

export function getPackAdapter(id: string): PackAdapter {
  const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter === undefined) {
    throw new Error(
      `unknown pack adapter "${id}" (available: ${PACK_ADAPTERS.map((entry) => entry.id).join(', ')})`,
    );
  }
  return adapter;
}
