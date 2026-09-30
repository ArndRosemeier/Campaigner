import type { JSX } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import type { SpellData } from '@/domain';
import { spellRankLabelFor, DND5E_SPELL_SCHOOL_LABELS } from '@/domain/spellData';
import { Badge } from '@/components/ui/badge';
import { spellHeighteningLabel } from '@/features/spells/spell-rows';

/**
 * One spell's details (docs/17 row 182), the read-only right-hand pane's body
 * — the spell-list counterpart of `StatBlockCard` (docs/18 §2.3): PURE over
 * values its caller already holds (`name`, the validated `spellData`, and the
 * chunk's stored `description` text), so it renders identically wherever a
 * spell is shown and a test can mount it without a database.
 *
 * THE FIELDS ARE THE PAYLOAD, printed as themselves: rank/level (a cantrip
 * prints `Cantrip`, never a number), traditions, the verbatim traits and
 * rarity, the four cast facts, then the heightening notes VERBATIM — labelled
 * with the entry's own rank/interval through `spellHeighteningLabel`, which
 * computes NOTHING (choosing the rank a mob casts at is the next arc's policy,
 * so this slice never prints a cast-rank number), or with the bare
 * `Heightened` heading for a notes-only entry (docs/17 row 221). A
 * `heighteningUnparsed` list renders LOUDLY: the ingest lane stored those lines
 * precisely because it could not classify them, and a silent drop here would
 * hide real source data — the lines are the ingest seam's plain prose (no
 * markup, no `@UUID[…]` notation), so this component renders them as stored
 * and re-cleans nothing.
 *
 * THE LICENCE LINE IS THE STORED TEXT'S OWN. The description IS the chunk's
 * stored `text` — the ingest mapping's byte-exact output — and that output ends
 * with `Source: <title> (<license>)` (`ingest/packs/pf2e-rules.ts`). Rendering
 * the description therefore renders the licence, byte for byte, and this
 * component deliberately does NOT re-compose the line: `publicationSourceLine`
 * already exists twice (its duplication is documented as deliberately unfolded
 * in `ingest/packs/text.ts`), and a third spelling here would be the exact
 * drift docs/18 §2 forbids for a display we already have the bytes for.
 */
export function SpellCard({
  name,
  spellData,
  description,
}: {
  name: string;
  spellData: SpellData;
  /** The chunk's stored `text` — the imported rules record, verbatim. */
  description: string;
}): JSX.Element {
  const cast: { label: string; value: string }[] = [
    { label: 'Cast', value: spellData.cast.time },
    { label: 'Range', value: spellData.cast.range },
    { label: 'Target', value: spellData.cast.target },
    { label: 'Duration', value: spellData.cast.duration },
  ];
  const castFacts = cast.filter((fact) => fact.value !== '');

  return (
    <div className="rounded-lg border bg-card p-3 text-sm" data-testid="spell-card">
      <div className="border-b pb-1.5">
        <h3 className="font-serif text-lg font-bold">{name}</h3>
        <p className="text-xs">
          {/* The payload's OWN system's wording (row 194): `Rank N` for PF2e,
              `Level N` for dnd5e — never the other system's noun. */}
          {spellRankLabelFor(spellData.rank, spellData.cantrip, spellData.filterAxis)}
          {spellData.school !== '' && (
            <span className="ml-2 text-muted-foreground" data-testid="spell-school">
              {DND5E_SPELL_SCHOOL_LABELS[spellData.school]}
            </span>
          )}
          {spellData.rarity !== 'common' && (
            <span className="ml-2 text-muted-foreground">{spellData.rarity}</span>
          )}
        </p>
        {/* A payload that names NO axis at all is a row written before the
            axis existed: it is listed and says so, never assigned one. A
            dnd5e spell whose source states no school still names its axis
            (`school`) and shows the per-row "no school" mark instead. */}
        {spellData.filterAxis === null ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="spell-no-filter-axis">
            This spell's payload names no filter axis (it predates the axis), so it is listed
            without a filter category.
          </p>
        ) : null}
        {spellData.traditions.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1" data-testid="spell-traditions">
            <span className="text-xs font-semibold">Traditions</span>
            {spellData.traditions.map((tradition) => (
              <Badge key={tradition} variant="secondary">
                {tradition}
              </Badge>
            ))}
          </p>
        )}
        {spellData.traits.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1" data-testid="spell-traits">
            <span className="text-xs font-semibold">Traits</span>
            {spellData.traits.map((trait) => (
              <Badge key={trait} variant="outline">
                {trait}
              </Badge>
            ))}
          </p>
        )}
        {spellData.properties.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1" data-testid="spell-properties">
            <span className="text-xs font-semibold">Properties</span>
            {spellData.properties.map((property) => (
              <Badge key={property} variant="outline">
                {property}
              </Badge>
            ))}
          </p>
        )}
      </div>

      {castFacts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-b py-1.5 text-xs">
          {castFacts.map((fact) => (
            <div key={fact.label} className="flex gap-1">
              <dt className="shrink-0 font-semibold">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {spellData.heighteningEntries.length > 0 && (
        <div className="mt-2" data-testid="spell-heightening">
          <h4 className="border-b text-xs font-bold tracking-wide uppercase">Heightening</h4>
          <ul className="mt-1 space-y-1 text-xs">
            {spellData.heighteningEntries.map((entry, index) => (
              <li key={index}>
                <span className="font-semibold italic">{spellHeighteningLabel(entry)}</span>{' '}
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The dnd5e source's OWN higher-level sentence, VERBATIM (row 194) —
          a 5e spell carries `upcast`, a PF2e spell `heighteningEntries`; the
          two are different systems' mechanisms and never share a heading. */}
      {spellData.upcast !== null && spellData.upcast !== undefined && spellData.upcast.sentence !== '' && (
        <div className="mt-2" data-testid="spell-upcast">
          <h4 className="border-b text-xs font-bold tracking-wide uppercase">
            {spellData.cantrip ? 'Cantrip scaling' : 'At Higher Levels'}
          </h4>
          <p className="mt-1 text-xs">{spellData.upcast.sentence}</p>
        </div>
      )}

      {spellData.heighteningUnparsed.length > 0 && (
        <div
          className="mt-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive"
          data-testid="spell-heightening-unparsed"
        >
          <p className="flex items-center gap-1 font-semibold">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            {String(spellData.heighteningUnparsed.length)} heightening line
            {spellData.heighteningUnparsed.length === 1 ? '' : 's'} could not be read — shown
            verbatim:
          </p>
          <ul className="mt-1 list-disc pl-4">
            {spellData.heighteningUnparsed.map((line, index) => (
              <li key={index} className="whitespace-pre-wrap">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2" data-testid="spell-description">
        <h4 className="border-b text-xs font-bold tracking-wide uppercase">Description</h4>
        <p className="mt-1 whitespace-pre-wrap text-xs">{description}</p>
      </div>
    </div>
  );
}
