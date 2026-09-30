import type { GameSystem } from '@/domain/gameSystem';
import type { StatBlock } from '@/domain/statblock';
import type { Line } from '@/ingest/types';

/**
 * Stat-block detection & honest parsing (02-INGESTION.md step 3).
 * A stat block starts when within a 6-line window ≥ 3 of the anchor regexes
 * match; it ends at the next heading of level ≤ 2 or after 80 lines.
 *
 * THE REFUSAL RULE (docs/17 row 290): a span the parser cannot read in FULL is
 * not a stat block. `parseStatBlock` returns `null` unless the source itself
 * stated AC, HP and all six abilities — the numbers the normalized `StatBlock`
 * shape requires — and NEVER substitutes a default for one it did not find.
 */

const ANCHOR_REGEXES: RegExp[] = [
  /\bArmor Class\b|\bAC\b\s*\d+/i,
  /\bHit Points\b|\bHP\b\s*\d+/i,
  /\bSpeed\b\s*\d+\s*(ft|feet)/i,
  /\bSTR\b.*\bDEX\b.*\bCON\b/i,
  /\bChallenge\b|\bCR\b\s*\d+|\bLevel\b\s*\d+/i,
];

export interface StatBlockSpan {
  start: number;
  /** Exclusive end index. */
  end: number;
}

/**
 * Returns the span of a stat block starting at (or after) `startIdx`, or null
 * when none starts there. Requires a run of ≥ 3 *consecutive* lines matching
 * anchor regexes within a 6-line window, so prose pages never trigger and the
 * window cannot reach across a section heading into a later block.
 */
export function detectStatBlock(lines: readonly Line[], startIdx: number): StatBlockSpan | null {
  const window = lines.slice(startIdx, startIdx + 6);
  if (window.length === 0) return null;

  let runStart = -1;
  let runLength = 0;
  for (let w = 0; w < window.length; w += 1) {
    const text = window[w]?.text ?? '';
    if (ANCHOR_REGEXES.some((regex) => regex.test(text))) {
      if (runLength === 0) runStart = w;
      runLength += 1;
      if (runLength >= 3) break;
    } else {
      runLength = 0;
      runStart = -1;
    }
  }
  if (runLength < 3 || runStart < 0) return null;

  const start = startIdx + runStart;
  let end = Math.min(start + 80, lines.length);
  for (let j = start; j < end; j += 1) {
    const level = lines[j]?.headingLevel ?? 0;
    if (j > start && (level === 1 || level === 2)) {
      end = j;
      break;
    }
  }
  return { start, end };
}

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

interface ParsedPieces {
  ac?: number;
  acNote?: string;
  hp?: number;
  hpFormula?: string;
  speed?: string;
  level?: string;
  cr?: string;
  abilities: Partial<Record<(typeof ABILITIES)[number], number>>;
}

function parsePieces(text: string): ParsedPieces {
  const pieces: ParsedPieces = { abilities: {} };

  const ac = /\b(?:Armor Class|AC)\s*(\d{1,3})(?:\s*\(([^)]*)\))?/i.exec(text);
  if (ac?.[1] !== undefined) {
    pieces.ac = Number.parseInt(ac[1], 10);
    if (ac[2] !== undefined) pieces.acNote = ac[2];
  }

  const hp = /\b(?:Hit Points|HP)\s*(\d{1,3})(?:\s*\(([^)]*)\))?/i.exec(text);
  if (hp?.[1] !== undefined) {
    pieces.hp = Number.parseInt(hp[1], 10);
    if (hp[2] !== undefined) pieces.hpFormula = hp[2];
  }

  const speed = /\bSpeed\s*([^\n]+)/i.exec(text);
  if (speed?.[1] !== undefined) pieces.speed = speed[1].trim();

  const level = /\bLevel\s*(\d{1,2})/i.exec(text);
  if (level?.[1] !== undefined) pieces.level = level[1];

  const cr = /\b(?:Challenge(?:\s+Rating)?|CR)\s*(\d{1,2}(?:\s*\/\s*\d)?)/i.exec(text);
  if (cr?.[1] !== undefined) pieces.cr = cr[1];

  ABILITIES.forEach((ability) => {
    const match = new RegExp(`\\b${ability.toUpperCase()}\\b[^0-9]{0,4}(\\d{1,2})`, 'i').exec(text);
    if (match?.[1] !== undefined) pieces.abilities[ability] = Number.parseInt(match[1], 10);
  });

  return pieces;
}

/**
 * Reads a stat block out of extracted PROSE, or `null` when the text did not
 * STATE every number the normalized shape requires.
 *
 * The bar is the SHAPE's own: `StatBlock` requires `ac`, `hp` and all six
 * abilities, so a text that states fewer is prose, not a stat block. Filling in
 * `ac ?? 10`, `hp ?? 1` or an ability `?? 10` would persist an invented combat
 * number on the chunk and let an encounter cite it as a printed one — AGENTS
 * rule 1, and indistinguishable downstream from a real read (docs/17 row 290).
 * Speed, CR and level stay OPTIONAL exactly as the shape carries them: a block
 * may legitimately print none, and those fields are display strings the shape
 * already blanks.
 *
 * The caller (`ingest/chunker.chunkLines`) mints NO statblock chunk for a
 * refused span — the span's text stays in the surrounding prose, where it can
 * still be read and searched.
 */
export function parseStatBlock(text: string, system: GameSystem): StatBlock | null {
  const pieces = parsePieces(text);
  const { str, dex, con, int, wis, cha } = pieces.abilities;
  if (
    pieces.ac === undefined ||
    pieces.hp === undefined ||
    str === undefined ||
    dex === undefined ||
    con === undefined ||
    int === undefined ||
    wis === undefined ||
    cha === undefined
  ) {
    return null;
  }

  const extras: Record<string, string> = {};
  if (pieces.cr !== undefined) extras.CR = pieces.cr;

  return {
    system,
    level: pieces.level ?? '',
    size: '',
    creatureType: '',
    ac: pieces.ac,
    acNote: pieces.acNote ?? '',
    hp: pieces.hp,
    hpFormula: pieces.hpFormula ?? '',
    speed: pieces.speed ?? '',
    abilities: { str, dex, con, int, wis, cha },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras,
  };
}
