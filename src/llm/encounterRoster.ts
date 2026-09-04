import type { GameSystem } from '@/domain/gameSystem';
import type { Id, Rulebook, RuleChunk } from '@/domain';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';

/**
 * Encounter roster index (12-BESTIARY-PACKS §7): a compact, level-ordered
 * "name (level, traits)" listing of every imported pack creature for the
 * campaign's system, injected into the Encounter Smith's prompt so it picks
 * real bestiary entries (cited by exact `sourceName`) instead of inventing
 * names. Pure selection/formatting here; the run-engine wiring is M-B.
 */

export const ROSTER_LIMIT = 300;

export interface PackRosterEntry {
  name: string;
  level: string;
  traits: string;
  chunkId: Id;
  levelSort: number;
}

export interface PackRoster {
  lines: string[];
  total: number;
  truncated: number;
}

/** Numeric ordering key for printed d20 levels: "3", "-1", "1/2", "1/4". */
export function parseLevelSort(level: string): number {
  const trimmed = level.trim();
  const fraction = /^(-?\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (fraction !== null) {
    const numerator = fraction[1];
    const denominator = fraction[2];
    if (numerator !== undefined && denominator !== undefined && Number(denominator) !== 0) {
      return Number(numerator) / Number(denominator);
    }
  }
  const value = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(value)) return value;
  throw new Error(`cannot order creatures by level "${level}"`);
}

function rosterLine(entry: PackRosterEntry): string {
  return `${entry.name} (${entry.level}${entry.traits === '' ? '' : `, ${entry.traits}`})`;
}

export function buildPackRoster(entries: readonly PackRosterEntry[]): PackRoster {
  const sorted = [...entries].sort(
    (a, b) => a.levelSort - b.levelSort || a.name.localeCompare(b.name),
  );
  return {
    lines: sorted.slice(0, ROSTER_LIMIT).map(rosterLine),
    total: sorted.length,
    truncated: Math.max(0, sorted.length - ROSTER_LIMIT),
  };
}

export interface PackRosterDeps {
  listBooks: () => Promise<Rulebook[]>;
  listChunks: (bookIds: Id[]) => Promise<RuleChunk[]>;
}

const defaultDeps: PackRosterDeps = {
  listBooks: () => listRulebooks(),
  listChunks: (bookIds) => listChunksByBooks(bookIds),
};

/**
 * Collects the roster for a campaign system over every ready pack book.
 * Chunks without a validated stat block must not exist in pack books (the
 * importer enforces it), so encountering one is a loud data error, not a skip.
 */
export async function collectPackRoster(
  system: GameSystem,
  deps: PackRosterDeps = defaultDeps,
): Promise<PackRoster & { entries: PackRosterEntry[] }> {
  const books = (await deps.listBooks()).filter(
    (book) => book.system === system && book.origin === 'pack' && book.status === 'ready',
  );
  const chunks = await deps.listChunks(books.map((book) => book.id));
  const entries: PackRosterEntry[] = [];
  for (const chunk of chunks) {
    if (chunk.chunkType !== 'statblock' || chunk.statBlock === null) {
      throw new Error(`pack chunk ${chunk.id} has no validated stat block — re-import the pack`);
    }
    const name = chunk.headingPath[0];
    if (name === undefined || name.trim() === '') {
      throw new Error(`pack chunk ${chunk.id} has no creature name in its heading`);
    }
    entries.push({
      name,
      level: chunk.statBlock.level,
      traits: chunk.statBlock.extras.Traits ?? '',
      chunkId: chunk.id,
      levelSort: parseLevelSort(chunk.statBlock.level),
    });
  }
  return { entries, ...buildPackRoster(entries) };
}
