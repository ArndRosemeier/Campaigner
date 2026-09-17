import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { TriangleAlertIcon } from 'lucide-react';

import { SpellChip } from '@/components/spell-chip';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { loadSpellChunksFor } from '@/db/spellRepo';
import {
  mobCasterLevel,
  mobSpellChips,
  mobSpellChipDetail,
  mobSpellIndex,
  mobSpellIssues,
  mobSpellWarnings,
  spellCorpusEntries,
  type GameSystem,
  type MobSpellAssignment,
  type SpellData,
} from '@/domain';
import { SpellCard } from '@/features/spells/spell-card';

/**
 * A resolved chip's destination (docs/17 row 216): the library entry the name
 * resolved to, carrying the chunk's OWN stored description. Both halves come
 * from the ONE corpus read below — the payload `SpellCard` renders and the
 * bytes its description section prints.
 */
interface MobSpellDescription {
  /** The library's OWN spelling — the name the chip shows, the dialog titles with. */
  name: string;
  spellData: SpellData;
  /** The chunk's stored `text`, verbatim (the ingest mapping's own bytes). */
  description: string;
}

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
 * THE WARNING CHANNEL IS SEPARATE (docs/17 row 205). A stored assignment can
 * carry a field that belongs to the other system (a `casterLevel` on a PF2e
 * spell — the owner's eight loud errors). That field is IGNORED, the rule's own
 * values still answer, and the note below says so QUIETLY: it is not an issue,
 * does not spend a repair turn and must not read as "a spell it cannot use".
 *
 * The library is read through `db/spellRepo.loadSpellChunksFor` — the ONE
 * corpus read — for the stat block's OWN system, so a dnd5e mob never resolves
 * a Pathfinder 2e spell.
 *
 * A RESOLVED CHIP OPENS THAT SPELL'S DESCRIPTION, IN A DIALOG (docs/17 row
 * 216). The owner's report — *"the spell chips are not clickable, they do not
 * open the spell description"* — is answered with the app's OWN destination:
 * `features/spells/spell-card.SpellCard`, the ONE spell-detail renderer the
 * Spells page's pane already shows, mounted here inside the shared
 * `components/ui/dialog`. Nothing navigates away from the stat block, no second
 * detail renderer exists, and the description is the chunk's stored `text` from
 * the SAME read above (joined by the resolved library name, never a second
 * query). The dialog lives HERE rather than at a call site because
 * `StatBlockCard` is the ONE card every stat-block surface mounts (the NPC
 * card, the module reader, the artifact editor, the bestiary roster and the
 * battle table) — one host, every surface.
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
  const chunks = useLiveQuery(async () => loadSpellChunksFor(system), [system]);
  const corpus = useMemo(
    () => (chunks === undefined ? undefined : spellCorpusEntries(chunks)),
    [chunks],
  );
  const index = useMemo(
    () =>
      mobSpellIndex(
        (corpus ?? []).map((entry) => ({ name: entry.name, spellData: entry.data })),
      ),
    [corpus],
  );
  /**
   * What a resolved chip opens: the chunk's stored `text`, joined to the corpus
   * entry by `chunkId` from the SAME read above — no second query and no second
   * corpus load. It is keyed by the library's OWN name because that is what the
   * resolver reports (`MobSpellChip.libraryName`), so a stored name that
   * resolves to a differently-spelled library name (`fireball` → `Fireball`)
   * shows the LIBRARY entry the chip displays, never the raw stored spelling.
   * First-wins is the resolver's own rule (`mobSpellIndex`), so two books
   * carrying one spelling cannot show a different chunk than the chip resolved
   * against.
   */
  const descriptions = useMemo(() => {
    const textByChunkId = new Map((chunks ?? []).map((chunk) => [chunk.id, chunk.text]));
    const byName = new Map<string, MobSpellDescription>();
    for (const entry of corpus ?? []) {
      const description = textByChunkId.get(entry.chunkId);
      // `spellCorpusEntries` projected THIS very array, so the id always
      // resolves: a miss is a broken join and it is LOUD, never a blank card.
      if (description === undefined) {
        throw new Error(`the spell corpus entry ${entry.chunkId} has no chunk text to show`);
      }
      if (!byName.has(entry.name)) {
        byName.set(entry.name, { name: entry.name, spellData: entry.data, description });
      }
    }
    return byName;
  }, [chunks, corpus]);

  const chips = useMemo(
    () => mobSpellChips(spells, mobCasterLevel(level), index),
    [spells, level, index],
  );
  const issues = useMemo(() => mobSpellIssues(chips, mobName), [chips, mobName]);
  const warnings = useMemo(() => mobSpellWarnings(chips, mobName), [chips, mobName]);
  const [shown, setShown] = useState<MobSpellDescription | null>(null);

  return (
    <div className="mt-2" data-testid="mob-spells">
      <h4 className="border-b text-xs font-bold tracking-wide uppercase">Spells</h4>
      <p className="mt-1 flex flex-wrap items-center gap-0.5">
        {chips.map((chip, position) => {
          // A RESOLVED chip opens the spell's OWN description in the dialog
          // below: the name resolved to a library entry, so that entry's chunk
          // text is the honest destination — through the SAME `SpellCard` the
          // Spells page renders. An UNRESOLVED chip opens NOTHING: the name
          // resolved to no library entry, so there is no description to show
          // and none is invented (AGENTS rule 1) — it stays the dashed muted
          // chip with its name and its existing tooltip, inert by design.
          const description =
            chip.libraryName === null ? undefined : descriptions.get(chip.libraryName);
          return (
            <SpellChip
              key={`${chip.name}-${String(position)}`}
              name={chip.libraryName ?? chip.name}
              resolved={chip.resolved}
              detail={mobSpellChipDetail(chip)}
              data-spell-name={chip.name}
              {...(description === undefined
                ? {}
                : {
                    onClick: () => {
                      setShown(description);
                    },
                  })}
            />
          );
        })}
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
      {warnings.length > 0 && (
        <div
          className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="mob-spell-warnings"
        >
          {warnings.map((warning, position) => (
            <p key={position}>{warning}</p>
          ))}
        </div>
      )}
      <Dialog
        open={shown !== null}
        onOpenChange={(open) => {
          if (!open) setShown(null);
        }}
      >
        {shown !== null && (
          <DialogContent
            className="max-h-[80vh] overflow-y-auto sm:max-w-lg"
            data-testid="mob-spell-dialog"
          >
            {/* The dialog is LABELLED with the spell's name; the close control
                and Escape are the dialog primitive's own (never hand-rolled). */}
            <DialogTitle>{shown.name}</DialogTitle>
            {/* THE one spell-detail renderer (docs/17 row 182): the SAME
                `SpellCard` the Spells page's pane renders, so a spell looks
                identical from a mob's stat block and from the list. */}
            <SpellCard
              name={shown.name}
              spellData={shown.spellData}
              description={shown.description}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
