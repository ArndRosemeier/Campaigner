import { z } from 'zod';

/** Supported game systems, system-agnostic with first-class d20 support (00-OVERVIEW). */
export const GAME_SYSTEMS = ['dnd5e', 'pathfinder2e', 'cosmere', 'generic-d20', 'other'] as const;

export const gameSystemSchema = z.enum(GAME_SYSTEMS);

export type GameSystem = z.infer<typeof gameSystemSchema>;

/** Human-readable labels, used by system badges and selects (05-UI). */
export const GAME_SYSTEM_LABELS: Readonly<Record<GameSystem, string>> = {
  dnd5e: 'D&D 5e',
  pathfinder2e: 'Pathfinder 2e',
  cosmere: 'Cosmere RPG',
  'generic-d20': 'Generic d20',
  other: 'Other',
};
