import { useMemo } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { TriangleAlertIcon } from 'lucide-react';

import { SpellChip } from '@/components/spell-chip';
import { loadSpellChunksFor } from '@/db/spellRepo';
import {
  mobCasterLevel,
  mobSpellChips,
  mobSpellChipDetail,
  mobSpellIndex,
  mobSpellIssues,
  spellCorpusEntries,
  type GameSystem,
  type MobSpellAssignment,
} from '@/domain';

/**
 * A mob's spells as chips (docs/17 row 184, docs/18 §2.3) — the stat-block
 * counterpart of the spell list, rendered by the SAME `SpellChip` and resolved
 * by the SAME `domain/mobSpells.mobSpellChips` the run boundary validates
 * with.
 *
 * A name that does not resolve in the campaign's library renders the chip in
 * the UNRESOLVED state with the name still visible (never hidden, never blank),
 * and every rule issue — an invented name, a cantrip on a level-less mob, a
 * corrupt spell row — is printed LOUDLY under the chips, because a mob whose
 * spells cannot be read must not look like a mob with no spells.
 *
 * The library is read through `db/spellRepo.loadSpellChunksFor` — the ONE
 * corpus read — for the stat block's OWN system, so a dnd5e mob never resolves
 * a Pathfinder 2e spell.
 */
export function MobSpellChips({
  spells,
  level,
  system,
  mobName,
}: {
  spells: readonly MobSpellAssignment[];
  /** The stat block's printed level — the caster level for the cantrip rule. */
  level: string;
  system: GameSystem;
  /** The mob's name, so a loud issue names both halves. */
  mobName: string;
}): JSX.Element {
  const corpus = useLiveQuery(async () => spellCorpusEntries(await loadSpellChunksFor(system)), [system]);
  const index = useMemo(
    () =>
      mobSpellIndex(
        (corpus ?? []).map((entry) => ({ name: entry.name, spellData: entry.data })),
      ),
    [corpus],
  );
  const chips = useMemo(
    () => mobSpellChips(spells, mobCasterLevel(level), index),
    [spells, level, index],
  );
  const issues = useMemo(() => mobSpellIssues(chips, mobName), [chips, mobName]);

  return (
    <div className="mt-2" data-testid="mob-spells">
      <h4 className="border-b text-xs font-bold tracking-wide uppercase">Spells</h4>
      <p className="mt-1 flex flex-wrap items-center gap-0.5">
        {chips.map((chip, position) => (
          <SpellChip
            key={`${chip.name}-${String(position)}`}
            name={chip.libraryName ?? chip.name}
            resolved={chip.resolved}
            detail={mobSpellChipDetail(chip)}
            data-spell-name={chip.name}
          />
        ))}
      </p>
      {issues.length > 0 && (
        <div
          className="mt-1 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive"
          data-testid="mob-spell-issues"
        >
          {issues.map((issue, position) => (
            <p key={position} className="flex items-start gap-1">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{issue}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
