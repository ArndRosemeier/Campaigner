import type { GameSystem } from '@/domain/gameSystem';
import type { StatBlock } from '@/domain/statblock';
import type { Line } from '@/ingest/types';

/**
 * Stat-block detection & best-effort parsing (02-INGESTION.md step 3).
 * A stat block starts when within a 6-line window ≥ 3 of the anchor regexes
 * match; it ends at the next heading of level ≤ 2 or after 80 lines.
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
 * Best-effort stat-block parser filling the normalized `StatBlock`; null when
 * the text doesn't look enough like a stat block (fewer than 3 of the core
 * pieces AC/HP/speed/abilities were found). Unmatched fields keep defaults;
 * unmatched content (traits etc.) simply stays in the chunk text.
 */
export function parseStatBlock(text: string, system: GameSystem): StatBlock | null {
  const pieces = parsePieces(text);
  // Under exactOptionalPropertyTypes, Object.values(Partial<Record<…>>) is
  // already number[] (absent keys are skipped at runtime).
  const parsedAbilities = Object.values(pieces.abilities);
  const coreFounds =
    [pieces.ac, pieces.hp, pieces.speed].filter((value) => value !== undefined).length +
    (parsedAbilities.length >= 3 ? 1 : 0);
  if (coreFounds < 3) return null;

  const extras: Record<string, string> = {};
  if (pieces.cr !== undefined) extras.CR = pieces.cr;

  return {
    system,
    level: pieces.level ?? '',
    size: '',
    creatureType: '',
    ac: pieces.ac ?? 10,
    acNote: pieces.acNote ?? '',
    hp: pieces.hp ?? 1,
    hpFormula: pieces.hpFormula ?? '',
    speed: pieces.speed ?? '',
    abilities: {
      str: pieces.abilities.str ?? 10,
      dex: pieces.abilities.dex ?? 10,
      con: pieces.abilities.con ?? 10,
      int: pieces.abilities.int ?? 10,
      wis: pieces.abilities.wis ?? 10,
      cha: pieces.abilities.cha ?? 10,
    },
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
