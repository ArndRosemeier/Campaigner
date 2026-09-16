# 12 — Bestiary Packs (Structured Monster Sources)

Generated encounters routinely resolve to stat-less mobs. The cause is a chain
of best-effort links, not a UI bug:

1. PDF ingestion detects stat blocks with a 5-regex heuristic and a
   **best-effort parser that is allowed to give up** (`statBlock: null`,
   02-INGESTION §Step 3).
2. The Encounter Smith cites a cited chunk via `sourceChunkIndex`, but
   `resolveMonsterEntry` (`/src/domain/encounterResolve.ts`) returns a
   displayable stat block **only when `chunk.statBlock != null`** — otherwise
   the entry resolves to "missing ref" and the mob has no stats.
3. Even when statblock chunks exist, selection grounding is weak: the persona
   sees at most 6 retrieved excerpts and must guess which creatures exist.

Decision: **stop improving per-system PDF stat-block parsing and import
machine-readable bestiary sources instead.** The import *pipeline* is
system-agnostic; each source gets a small per-system adapter that maps its
format onto the existing `StatBlock` schema and lands in the existing
`RuleChunk` pipeline. Nothing downstream changes shape — encounter citations
(`{type:'rulebook', chunkId}`), `encounterResolve`, the stat-block search, the
"Link a rulebook stat block" dialog and quick-find all keep working because
pack chunks are ordinary `statblock` chunks with a **non-null, exact**
`statBlock`.

## 1. Binding decisions

- **Packs land in the existing pipeline.** A pack import creates a `Rulebook`
  and `RuleChunk`s, exactly like a PDF import. No separate bestiary table.
- **`statBlock` is exact, never best-effort.** A pack chunk that fails
  `statBlockSchema` validation is a **failed entry** (reported, counted), not
  a null-statBlock chunk.
- **Per-source adapters.** "System-agnostic" describes the pipeline, not the
  parsers: every source gets its own mapper, selected by a registered adapter.
  There is no generic JSON→StatBlock inference.
- **No bundling; fetching only via 16-BESTIARY-FETCH (amended 2026-09-05).**
  The app never bundles or ships third-party content (§2). The user either
  imports pack files manually (unchanged `/rules` fallback) or triggers the
  **user-triggered pack fetch** (16-BESTIARY-FETCH), which downloads chosen
  packs from the pinned upstream repos into the user's own browser and feeds
  the bytes into this pipeline (since 16 §1.1, 2026-09-06: the fetch tries the
  repo's newest state, `HEAD`, first and falls back to the pinned verified
  ref — **HEAD of the same pinned repos is still a pinned source**). The
  import path itself stays network-free: adapters parse bytes they are handed
  and never fetch (unit-test asserted).
- **Loud failure policy.** Per-entry validation failures are collected and
  shown in an import report (AGENTS rule 1). Zero valid entries → the book is
  marked `error` and the import throws; an empty "ready" book is forbidden.

## 2. Licensing constraints (binding)

**Scope of "never re-serve" (docs/17 row 144).** The binding line below is a
PRODUCT-level constraint — Campaigner never bundles, redistributes or re-serves
library content to anyone. It does not govern what the OWNER does with the
library he ingested into his own local workspace: an export he generates for his
own table renders the cited numbers into the PDF (he decided: *"Print the numbers
for cited mobs too."*), writes nothing back to the database, and ships nothing
anywhere. Nothing in this file's storage model changes: a citation is still a
citation.

Campaigner must **never bundle, redistribute, or re-serve** the content below
(amended 2026-09-05 by 16-BESTIARY-FETCH: *user-triggered fetch from the
pinned sources there is allowed and changes the acquisition channel, not the
licensing model — the fetch downloads to the user's own browser storage from
the upstream repo the user chose; Campaigner never bundles, re-serves, or
redistributes, and the book stores provenance — source ref, URL, fetch time —
plus the license, displayed in the UI*. Amended 2026-09-06 by 16 §1.1: *the
ref chain — newest `HEAD` first, then the pinned verified ref — stays inside
the same pinned repos; HEAD of a pinned source repo is still a pinned source,
and provenance additionally records `attemptedRefs`*.).
The user obtains the files from the source repository (manually or via the
pinned-source fetch) and imports them; the
book row stores the license string and the UI displays it. This local-import
model is what makes the sources usable at all:

| Adapter | Source | Content license situation |
|---|---|---|
| `foundry-pf2e` | [foundryvtt/pf2e](https://github.com/foundryvtt/pf2e) `packs/pf2e/**` | Creature data used by that project under the Paizo–Foundry partnership; mechanics OGL; system code Apache-2.0. Local import by the end user under Paizo's Community Use Policy; Campaigner stores provenance + license on the book and adds nothing to any distribution. |
| `foundry-dnd5e-srd` | [foundryvtt/dnd5e](https://github.com/foundryvtt/dnd5e) `packs/_source/monsters/**` | SRD 5.1 / SRD 5.2, CC-BY-4.0 (stated in that repo's README); system code MIT. Clean to import; attribution string stored. SRD scope only — no Monster Manual Product Identity creatures. |
| Cosmere | — | No machine-readable bestiary source known. No adapter; Cosmere campaigns keep the current inline/LLM path. |

## 3. Verified source formats (re-verified against the full live corpora 2026-09-06; fixture tests pin them)

**pf2e** — repo default branch (`v14-dev`): `packs/pf2e/<pack>/<...>/<creature>.json`,
**one JSON file per creature** (`type: 'npc'`); 98 packs, including the core
bestiaries *and* every Adventure Path bestiary. Older releases ship the same
docs as NDJSON (`.db`) files — the adapter accepts both. **AMENDED (docs/17
row 171):** a file may also wrap its documents in ONE top-level JSON array —
the ingest seam unwraps a top-level array ONE level into N documents, and the
dnd5e YAML family mirrors it for a top-level sequence (a document's own array
FIELDS are untouched; before that row the whole array was ONE document and
every lane skipped it). Relevant shape (all
492 v14-dev documents parsed and mapped — 0 failures, 0 skips):
`system.details.level.value` (object `{value: n}`), `system.traits.value`
(trait strings) + `system.traits.size.value` (`'med'`…),
`system.abilities.<abil>.mod` — **modifiers, not scores**,
`system.attributes.ac.value` (+ `.details`), `system.attributes.hp.max`
(no roll formula), `system.saves`/`system.skills` (mod values),
**`system.perception` (top-level since v13/v14: `{mod, details, senses[]}` —
the old `system.attributes.perception` location is gone from the corpus)**,
`system.attributes.speed.value` (**nullable** — fly-only creatures such as the
Banshee have no land speed; a null yields no speed entry, not `0 feet`) +
`otherSpeeds`, `system.details.languages?.value`, and an `items[]` array with
`melee` (attacks) and `action` entries (name + description + action type).

**dnd5e** — branch `6.0.x`: `packs/_source/monsters/<creatureType>/<slug>.yml`,
**one YAML file per creature** (`type: 'npc'`), **337 SRD monsters**. Shape
notes beyond the obvious (all verified over the full corpus):
`system.abilities.<abil>.value` — **scores, direct mapping**;
`system.attributes.ac` is either `{flat: n}` **or** `{flat: null,
calc: 'default'}` plus equipped `equipment` items (`type.value`
`light|medium|heavy|shield`, `armor.value`, `armor.dex`) — 34 of 337 corpus
creatures are armor wearers; `system.attributes.hp.max` + `.formula`
(`"3d8 + 6"`); `system.details.cr` is a number (`0.5` allowed) **or `null`**
(8 summons-type docs — the system prints `"—"`); `system.traits.size`;
`system.details.type.value`; `system.attributes.movement` per-type values are
**numbers, numeric strings (`walk: "30"`), or `null`** (summons templates),
with `units` nullable (default `'ft'`); senses mirror that (`units` nullable ×9
corpus docs); `system.attributes.spellcasting` is a plain ability-id string
(`"wis"`, `"int"`, …); weapon items carry `proficient` (`0` explicitly
unproficient, `1`, `null` → use the actor's proficiency), and their attack
activity stores `attack.ability` (`''` → the system's own defaulting,
`'none'` = no ability term, `'spellcasting'` → the stored caster ability, or
an ability id), `attack.flat` (the stored `bonus` **is** the complete to-hit),
`attack.bonus` (`''`, an integer, or `@abilities.<abil>.mod`), and damage
`base` as dice (`number`/`denomination`/`bonus`/`types`) **or** a custom
formula (`custom: {enabled, formula}` — e.g. `"1"`, `"1d10 + @mod + 1"`,
`"2d4 + @mod -3"`). YAML parsing needs one pure-JS dependency (`js-yaml`).

## 4. Data model (delta to 01-DATA-MODEL)

`Rulebook` gains two optional fields (defaults keep existing rows, backups and
exports parsing unchanged — the backup zip dumps tables raw; no Dexie index
changes, hence **no schema version bump**):

```ts
export const packMetaSchema = z.object({
  sourceId: z.string(),          // adapter id, e.g. 'foundry-pf2e'
  license: z.string(),           // stored verbatim from the adapter, shown in the UI
  entriesImported: z.number().int().nonnegative(),
  entriesSkipped: z.number().int().nonnegative(), // non-creature docs, by design
  entriesFailed: z.number().int().nonnegative(),  // failed statBlock validation
});
// rulebookSchema additions:
//   origin:   z.enum(['pdf', 'pack']).default('pdf'),
//   packMeta: packMetaSchema.nullable().default(null),
```

`RuleChunk` is **unchanged**. Pack chunks are normal chunks:

- `chunkType: 'statblock'`, `statBlock` non-null (validated at import),
- `pageStart: 1, pageEnd: 1` (packs have no page numbers; the schema requires
  positive ints — origin labels never print pack pages, §8),
- `headingPath: [creatureName]`,
- `text`: a rendered plain-text stat block (keyword search, chunk display,
  `contentHash` — so re-imports share the embedding cache for free).

## 5. Pack adapters (`/src/ingest/packs/`)

```ts
export interface PackEntry {
  name: string;
  statBlock: StatBlock;    // parsed with statBlockSchema by the import runner
  text: string;            // rendered plain-text stat block
}

/** One file's parse result (implemented contract, /src/ingest/packs/types.ts):
 *  per-creature problems are collected, never thrown past the file boundary. */
export interface PackFileParse {
  entries: PackEntry[];
  skipped: number;              // non-creature documents, by design
  failures: PackEntryFailure[]; // { file, name, message } — always surfaced
}

export interface PackAdapter {
  id: string;              // 'foundry-pf2e' | 'foundry-dnd5e-srd'
  label: string;           // UI label
  system: GameSystem;      // the system stamped on book + stat blocks
  license: string;         // stored on the book, shown in the UI
  extensions: readonly string[]; // lowercase file extensions (with dot) the adapter parses
  /** Parses one file's bytes into entries. Throws only for file-level
   *  failures (empty, unparseable); per-creature problems are collected in
   *  `failures`. Never fetches anything. Non-creature documents are skipped
   *  (counted in `skipped`, not failed). */
  parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse>;
}
```

Delta (fix-02): `PackEntry.levelSort` and `PackEntry.traits` are removed —
the import runner consumes only `name`/`statBlock`/`text`, and roster ordering
derives from the **persisted statBlock** (`parseLevelSort` over
`statBlock.level`, which handles pf2e levels and dnd5e CR fractions);
`RuleChunk` is unchanged (§4).

Files enter as a user-selected multi-file set: loose `.json` / `.db` / `.yml`
files, and `.zip` archives (unzipped in-memory via the existing `fflate`
dependency — a pack zip or a repo zip's pack folder both work). **AMENDED
(docs/17 row 171):** a `.json`/`.yml` file may hold ONE document, an NDJSON
stream, or a top-level array/sequence of documents — the seam unwraps the
array ONE level, so all three shapes import. The runner
recurses into zip folder structure so "select the whole bestiary folder zip"
is one action.

**AMENDED (docs/17 row 143) — "self-contained per §5's precedent" is RETIRED
for text stripping; the HTML→text convention is ONE seam.** The historical
decision, kept readable because it is the honest reason seven copies exist:
this section's adapter contract was read as licensing each adapter to carry its
OWN strip/Source-line helpers, and the two later arcs restated that reading —
§13.5's *"are self-contained (shared text-stripping rules copied per §5's
precedent; the dnd5e property-label table is exported and reused verbatim)"*
and §15.5's *"Three adapters, self-contained per §5's precedent (each carries
its own strip/Source-line helpers)"*. **Those two sentences are rewritten in
this commit, by reference to this paragraph, to mark the "own strip helper"
half SUPERSEDED; nothing else in them changed.** **EXTENDED (docs/17 row 147),
by the same reference — the DOCUMENT PARSER half is now spent too, and the
Source-line half is PINNED but still carried.** `parseDocs` was spelled SEVEN
times in THREE bodies (five byte-identical JSON/NDJSON bodies plus two YAML
bodies that DISAGREED about a comment-only file); the seven call sites now take
their documents from `packs/text.parseJsonDocs` / `parseYamlDocs`, so
"self-contained" no longer covers a per-adapter document parser either — what it
still honestly describes is each adapter's own SCHEMA and MAPPER, which is the
part §13.5 and §15.5 are about. **The `publicationSourceLine` half of §15.5's
parenthetical is NOT folded** — row 147 landed the differential pin
(`tests/ingest/packs/source-line.test.ts`) and measured all four sites
byte-identical, but left the fold as the owner's call, because §15.5's own text
still describes the copies as carried and three of the four sites feed the
chunk `text` that `contentHash` signs, with no heal path. Note what the precedent
actually rested on, because it is the lesson: this section never contained the
sentence *"each adapter carries its own helpers"* — it was inferred from §5
presenting adapters as per-adapter parsers, cited by §13.5, and then cited
again by §15.5 as if it had been written down. A precedent that is only ever
quoted is not a decision; it is a rumour with a lineage. The cost, measured:
seven copies, two block conventions, THREE inline-notation dialects, and 17 of
39 description blobs differing across the repo's own fixtures — a divergence
nothing failed on, because no test had ever declared there was one way to do it.

**The rule now.** HTML→text for a pack document goes through ONE seam,
`htmlToText(html, style)` in `src/ingest/packs/text.ts`, which also declares the
styles as data (`BRACKET_LINKS_LINE_BREAKS`, `AT_BRACE_LABEL_BLOCK_AND_TABLE` —
named for what they DO, never for the adapter that uses them today; the third,
`AT_LABEL_LAST_LINE_BREAKS`, was DELETED by docs/17 row 149, which is which row
to read before adding or renaming one). A new adapter PICKS one of those names; it does
not declare a style of its own, and a new STYLE is a behaviour change that
belongs with the re-import story, never a quiet fourth combination. "One
adapter file plus one entry in `registry.ts`" still describes adding a SOURCE;
it no longer describes copying a text convention. The removal of the copies is
held by `tests/ingest/packs/html-to-text.test.ts` (the differential table plus a
source scan that reds on a second stripper in this directory). **A `[[…]]` in a PACK DOCUMENT is not the app's wiki-link token, and must not be
folded onto it** (docs/17 row 145): the dnd5e dialect's two regexes in
`text.ts` (`[[target]]{Label}` → the label, `[[target|label]]` → the LAST label
segment, a label-less `[[target]]` → nothing) are rewritten at IMPORT time and
resolve nothing, while `lib/wikilinks.WIKI_LINK_PATTERN`/`WIKI_LINK_TOKEN` are
the reader's own grammar (a `|display` slot, resolved against the artifact pool).
They are a different grammar with a different job, which is why the row-145
source scan DECLARES these two as its only exception rather than unifying them.

**What a re-import does to stored citations — the pointer a future reader
needs, stated once (docs/17 row 149, landing 2 of this arc).** A citation is
bound to the EXACT text the import stored (`contentHash = sha256Hex(text)`), and
the resolver matches the cited uuid first and that exact hash second
(docs/11 §Content identity at citation birth). Row 149 changed the emitted text
for the two PF2e description lanes and for both dnd5e lanes: a description now
stores its resolved brace label (`Enfeebled 1`, not `Enfeebled{Enfeebled 1}`)
and a PF2e item now stores its table as cells (`Hardness | HP | BT`, not
`HardnessHPBT52010`). So: **after re-importing a pack whose entry text changed,
citations saved against the OLD text read `missing ref (<creature>)` — the
named badge, and no stat box — and the repair is the user's two steps: re-import
the pack, then re-pick the creature in the encounter (or board/roster entry).**
No rebind tool, no migration and no contentHash re-stamp exist, by the owner's
decision recorded in docs/17 row 143. The same instruction is shown in the app
on the pack-import report (`pack-import-rereimport-note`), because that is the
surface where a user meets it.

**Why landing 1 changed no behaviour.** Landing 1 is BYTE-PRESERVING: the
returned text becomes `PackEntry.text` → the chunk's stored `text` →
`contentHash = sha256Hex(text)`, and a changed byte strands stored citations on
the next re-import with no heal path. The groups' divergences on `@`+brace
notation and on tables were therefore DECLARED and left present in landing 1;
landing 2 (docs/17 row 149) fixed them together with the re-import instruction
above and the accepted `missing ref` for a citation that cannot rebind.

### `foundry-pf2e` mapping (all entries with `type !== 'npc'` are skipped)

| pf2e pack field | StatBlock target |
|---|---|
| `name` | identity + `headingPath[0]` |
| `system.details.level.value` | `level` (string) |
| `system.abilities.*.mod` (modifiers!) | **score = 10 + 2·mod** (binding: the exact inverse of `abilityModifier` — `domain/statblock.abilityScoreFromModifier` is the ONE conversion, shared with the stat-block editor; docs/17 row 95); raw mods additionally into `extras['Ability modifiers']` for fidelity |
| `system.traits.size.value` | `size` (`med` → `Medium`, …) |
| type trait (humanoid, undead, beast, …) | `creatureType`; no match → `''` |
| `attributes.ac.value` / `.details` | `ac` / `acNote` |
| `attributes.hp.max` | `hp`; `hpFormula: ''` (pf2e has none) |
| `system.saves` (mods) | `saves` = `"Fort +7, Ref +9, Will +5"` (`formatModifier`) |
| `system.skills` (mods) | `skills` = `"Athletics +9, Stealth +7"` |
| perception (`system.perception`, top level) + senses | `senses` |
| `details.languages?.value` | `languages` |
| `attributes.speed.value` + `otherSpeeds` | `"25 feet, climb 25 feet"`; a **null** land speed (fly-only creatures) yields no speed entry |
| `items[]` of type `melee` | `actions`: rendered `"Sickle +9 (agile, finesse), 1d6+3 slashing"`-style lines |
| `items[]` of type `action` | passive → `traits`, reaction → `reactions`, otherwise `actions` |
| everything else worth keeping (rarity, …) | `extras` |

Spells are **not represented in v1** (a documented scope cut, not a failure
path); attack/action text renders from the item fields pinned by the fixture
test.

**Ability display is per-system, storage is not** (owner decision + owner report,
docs/17 row 95; docs/05 §Artifact editor). Every system stores d20-scale
SCORES — an imported PF2e row and a generated one are the same data — and the
shared stat-block UI prints them per system: for `pathfinder2e` the signed
BONUS only (`STR +2`), for every other system `score (bonus)` (`STR 14 (+2)`).
The two PDF stat boxes (`lib/pdfExport`, `lib/modulePdf`) follow the same rule
in their own compact layout. That is why the mapping above converts at all:
`score = 10 + 2·mod` is the exact inverse of `abilityModifier`, so an imported
creature prints exactly what a generated one prints, and PF2e's own printed
line survives verbatim in `extras['Ability modifiers']`.

### `foundry-dnd5e-srd` mapping (337 SRD creatures)

| dnd5e `_source` field | StatBlock target |
|---|---|
| `name` | identity + `headingPath[0]` |
| `system.details.cr` | `level` (`0.5` → `"1/2"` as printed convention; `null` → `"—"` exactly as the system prints it) |
| `system.abilities.*.value` | scores **directly** (no conversion) |
| `system.attributes.ac.flat` (number) | `ac` |
| `ac.calc === 'default'` + equipped gear | **derived exact AC** (below) |
| `attributes.hp.max` + `.formula` | `hp` + `hpFormula` |
| `system.traits.size` | `size` |
| `system.details.type.value` | `creatureType` |
| `attributes.movement` | `"30 feet, climb 30 feet"`; null scalars → no entry, numeric strings parse, `units: null` → `'ft'` |
| senses / languages | strings; sense scalars as movement (null/numeric-string, `units: null` → `'ft'`) |
| `items[]` `feat` by activation | passive → `traits`, reaction → `reactions`, else `actions` |
| `items[]` `weapon` | `actions`: rendered attack lines (resolution below) |
| saves/skills/proficiencies | rendered strings; exact sub-fields pinned by the fixture test |

**Derived AC (calc `'default'`)** — follows the dnd5e system's published
formula exactly (`prepareArmorClass`, `module/data/actor/templates/
attributes.mjs` @ 6.0.x): exactly one equipped armor piece
(`light|medium|heavy`) + at most one equipped shield, else loud failure;
`ac = armor.value + min(dexMod, armor.dex ?? ∞)` with heavy armor clamping
dex to 0, plus the shield's `armor.value`; unarmored = `10 + dexMod`. The
gear names become `acNote` (`"Leather Armor, Shield"`). All 34 corpus armor
wearers were verified equal to the printed SRD value (goblin 15
`(Leather Armor, Shield)`, satyr 14 `(Leather Armor)`, ogre 11
`(Hide Armor)`, …). Unsupported gear shapes stay loud: >1 armor or >1
shield, unsupported `type.value`, armor without a numeric value.

**Weapon attacks** — the system's `constructParts` semantics over the stored
activity (`module/data/activity/attack-data.mjs` @ 6.0.x):

- to-hit = ability mod + proficiency + resolved stored `bonus`, except
  `attack.flat: true` where the stored `bonus` **is** the to-hit alone
  (animated objects' `Slam +8`); `proficient: 0` drops the proficiency term.
- ability resolution: explicit ability id → that mod; `'none'` → **no ability
  term** (camel `Bite +5` = prof 2 + stored 3, damage `1d4` without a mod);
  `'spellcasting'` → the stored `system.attributes.spellcasting` ability
  (lich `Paralyzing Touch +12, 3d6+5`); `''` → the system's own defaulting:
  ranged weapons → DEX, natural melee → STR (finesse property → better of the
  two).
- damage: dice base + (ability mod unless flat/`'none'`, + stored `bonus`);
  custom formulas resolve term-by-term (`NdM`, integers, `@mod` → the
  attack's ability mod) into a compact `NdM±K` (`"1d10 + @mod + 1"` →
  `1d10+5`; `"2d4 + @mod -3"` → `2d4+2`; flat `"1"` → `1`); a weapon with no
  resolvable damage at all renders damage-less (`Melee Tendril +7` — no
  trailing comma), which is exact, not best-effort.

**Exact-vs-book note (binding stance).** The adapter maps the **stored data
exactly**, applying the system's own derivation rules — it does not correct
data that disagrees with a printed book layout. Where the corpus data
diverges from the printed SRD 5.1 text (e.g. the flying snake's and badger's
empty-ability natural attacks resolve via the system's melee→STR defaulting,
or the barbed devil's stored CHA differs from the printed attack bonus), the
data-derived value is what Campaigner stores, per the same rule that pins
the ape's STR-based `Rock` throw. This keeps every mapped number reproducible
from the document alone.

## 6. Import flow (`/src/ingest/packImport.ts` + `/rules` UI)

`importPack(adapterId: string, files: File[]): Promise<PackImportResult>`
mirrors `ingestPdf` (`/src/ingest/ingestFiles.ts`), on the main thread (JSON/
YAML parsing is fast; no worker):

1. Resolve the adapter from the registry (`PACK_ADAPTERS`); unknown id → throw.
2. `createRulebook({ title from the selection, system: adapter.system,
   filename, pageCount: 0, origin: 'pack', status: 'processing' })`.
3. Unzip `.zip` inputs (fflate), parse every file via `parseFile`, collecting
   `{ imported: PackEntry[], skipped: number, failed: { file, name, message }[] }`.
   A file that throws is one loud failure entry — never `catch`-and-continue
   into silence.
4. Validate every entry with `statBlockSchema`, build `RuleChunkDraft`s
   (`ruleChunkSchema.parse` like the PDF path, `stampNewEntity`), `putChunks`
   in batches of 250, reporting progress via an `onProgress` callback shaped
   like `IngestProgress` (`{ bookId, done, total }` — rendered on the book's
   processing chip exactly like PDF page progress).
5. `updateRulebook(book.id, { status: 'ready', packMeta })` and return
   `{ book, imported, skipped, failed }`.
6. **Zero imported entries** → `updateRulebook({ status: 'error',
   errorMessage })` + throw; the UI toasts the report. No empty ready book.
   The error message **leads with a representative failure** — the first
   entry's `file (name): issue` — before the
   `no valid creature entries … (N skipped, N failed)` summary (added for
   16-BESTIARY-FETCH §6 after the live Monster Core import surfaced 492
   failures with no visible reason). A skipped-only selection (no failure at
   all) keeps the bare summary — no invented reason.

UI (`05-UI.md §Rules` delta): a second **"Import bestiary pack"** button next
to "Import PDFs" opens a dialog — adapter select (registered adapters only),
multi-file input, then the import report (imported / skipped / failed counts;
when entries fail, the report leads with the first failure's `file (name):
issue` line above the expandable failed-entries list). Book cards get a
**Pack** badge and show `packMeta.license` in the book menu. The search
browser, quick-find and the monster-source dialog need **no changes**: pack
chunks are statblock chunks and flow through `searchRules` as-is.

## 7. Encounter pipeline: roster grounding + name citation

Exact stat blocks fix resolution; selection still needs fixing. With a real
bestiary installed, "retrieve 6 statblock chunks" cannot ground the choice of
*which* creatures to field. The encounter retrieve step therefore also builds
a compact **roster index** from the pack books:

- Books: `listRulebooks()` filtered to `origin === 'pack'`,
  `system === campaign.system`, `status === 'ready'`; chunks via
  `listChunksByBooks` (both exist).
- Line format: `Name (level, trait1, trait2)`, one creature per line,
  **capped at 300 lines** with a trailing `"(roster truncated; N more)"` note.
  Not persisted — recomputed at run time (deterministic for an unchanged
  library; noted here as accepted behavior).
- **Prompt-window order — ratified design (owner amendment).** WHICH creatures
  fill the 300-line window is ordered by **level distance to the encounter's
  target level**, so a huge bestiary import surfaces creatures that could
  actually threaten the party instead of the first 300 low-CR entries. This
  changes the prompt window only; the cap, the line format, the truncation
  note and resolution are untouched. Binding points, verbatim:
  1. **Target-level chain**: (a) the encounter's `levelHint`
     (`src/domain/artifact.ts`, a free string like "5" or "4–6") — parse the
     leading integer deterministically; (b) else, when the run is
     module-scoped, the module's `levelMin`/`levelMax` band midpoint
     (`src/domain/module.ts`); (c) else **no target** → current behavior
     (level/name ascending) unchanged.
  2. **Ordering when a target exists**: `|levelSort − target|` ascending; ties
     by `levelSort` ascending, then name (locale-compare) — fully
     deterministic. The "—" CR creatures (`parseLevelSort` → `+Infinity`) sort
     last, exactly as today.
  3. **Scope — prompt window only**: `ROSTER_LIMIT = 300` cap unchanged;
     `formatRosterSection` output format unchanged (same header line +
     `(roster truncated; N more)` note); `rosterNameIndex` stays built over
     ALL entries (resolution works for creatures outside the visible window);
     the encounter dialog's user-facing roster display order is NOT touched.
  4. **Unparseable/missing `levelHint`** (no leading digits) → falls to (b)/(c)
     — this is a graceful preference chain, not a failure; it is NOT a silent
     fallback of erroneous data — `levelHint` is a user preference string, and
     "no parseable target" is a legitimate state.

  Implementation: the target is resolved at the run-engine boundary
  (`rosterTargetLevelFor`: the run's target artifact — `levelHint` first, then
  the artifact's owning module's band midpoint; a module-scoped target whose
  module row is gone is corrupt data and fails the run loudly) and threaded
  into `buildPackRoster` via `collectPackRosterWithRetry`; `parseRosterTargetLevel`
  takes the FIRST digit run of the hint ("4–6" → 4, "CR 5" → 5). Without a
  target the window is byte-identical to the pre-amendment ascending order.
- **The SAME WINDOW, a SECOND consumer: the module creator’s bestiary clause
  (added 2026-09-16, docs/17 row 114).** The paragraph above describes the
  encounter roster; the module creator now gets a listing of the same SHAPE —
  ordered the same way, capped the same way — and the differences are the
  whole point, so they are stated here rather than left to be inferred:
  1. **Source of truth is the CAST’S OWN population, not the pack filter.**
     The creator window (`src/llm/creatorRoster.ts`) is built from
     `db/creatureRepo.listLibraryCreatures()` — every `statblock` chunk of ANY
     book origin (`pdf` or `pack`), because that is exactly what the
     bestiary-slot lookup (`features/modules/entity-batch.libraryCitationForEntity`)
     resolves a requested name against. A window built from the pack-only
     filter above would be EMPTY for a library imported from an ordinary
     rulebook while the slot stayed on offer — i.e. it would re-create the
     defect the window exists to remove. **The rule: the window and the
     resolution share ONE source; where the two would disagree, the window is
     wrong.**
  2. **Level parsing is the SAME parser, over the creature’s own stat block.**
     `listLibraryCreatures` names a creature and not a level, so the window
     derives `levelSort` with `encounterRoster.parseLevelSort` over the chunk’s
     `statBlock.level` (which the pool now carries; a second chunk read was the
     alternative and would have been a second source). A second level grammar
     stays forbidden (docs/18 §2.2).
  3. **Ordering, ties and cap are §7’s, through SHARED code.** The comparator
     lives in `encounterRoster.libraryLevelOrder` (`|levelSort − target|`
     ascending, ties by `levelSort` then locale name, `levelDistanceTo` putting
     `"—"`/unparsable levels last) and `buildPackRoster` itself now reads it, so
     "ordered by level distance" cannot come to mean two orders. The cap is
     `CREATOR_ROSTER_LIMIT = 300` with the same `(roster truncated; N more)`
     note.
  4. **The target-level chain for the spine** is step (b) of the chain above —
     the module’s `levelMin`/`levelMax` band midpoint — there being no
     encounter `levelHint` on a module; with no band the order is the same
     level/name ascending as (c).
  5. **What the line may contain.** The creator window prints the library’s OWN
     spelling of the name, followed by the pack title that library records for
     the creature where it records one — `Name — Pack Title` (added 2026-09-16,
     docs/17 row 163: the slot’s `book` is a disambiguator, and a model cannot
     copy a title it was never shown). Nothing else follows the name: no
     `(level, traits)` decoration (the encounter roster’s richer line format is
     for a prompt that CITES a chunk rather than names one). The NAME is the part
     the lookup compares and the part that must be copied exactly; the title is
     the string the cast compares the slot’s `book` against. A creature whose
     library records no title — a deleted book, a citation outliving its pack —
     prints its NAME ALONE: no separator, no empty dash, no placeholder title.
  6. **Not persisted, recomputed per run** — the same accepted behavior as
     above, and the same determinism for an unchanged library.
- Draft contract (`/src/llm/schemas.ts`): per-monster optional
  `sourceName: z.string().optional()` alongside `sourceChunkIndex` (both the
  encounter draft schema and the roster-regeneration variant).
- Prompt: "cite a stat-block excerpt via `sourceChunkIndex`, or pick a
  creature from the bestiary roster via `sourceName` (exact name), or output
  an inline `statBlock`."
- Resolution precedence in finalize (both encounter paths in
  `/src/llm/runEngine.ts` — draft validation and the encounter-map remap):
  `sourceChunkIndex` → `sourceName` → inline `statBlock` → `none`.
  `sourceName` matches a name→chunkId map built from the same roster
  (case-insensitive, exact). Unknown name → the existing draft validation
  error path (one repair attempt, then `needs_review`/`failed` per autonomy —
  never a silent fallback to name-only). Duplicate names across books resolve
  deterministically (most recently updated pack book first) and are visible
  in the origin badge (§8), which names the book.
  **Amended 2026-09-05 by afa23f4 (mob-artifact arc), then SUPERSEDED by the
  creature tier (docs/17 row 106, 11 §"D5 amendment, SECOND revision").** The
  2026-09-05 text said a resolved citation *"get-or-creates the campaign's mob
  artifact — ONE `npc` artifact per cited chunk (`data.monsterChunkId` marker …
  and stamps its id as the entry's additive `mobArtifactId`)"*. That artifact no
  longer exists and neither does the field, so do not implement from it. What a
  resolved citation does now: it is stored as the roster entry's `source` and
  resolves to the **LIBRARY** creature at read time
  (`db/creatureRepo.resolveCreatureCitation` — chunk id, else the content hash
  recorded at citation birth, and a THROW on an empty ref). Nothing is
  materialized: the chunk stays the single source of truth, battles seed shared
  identity from the creature identity (`libraryCreatureKey(chunkId)`), and
  portraits come from the presentation tier. **A citation's RENDER reads the
  chunk, it never copies it** (docs/17 row 144): the module PDF and the
  single-artifact GM export print the cited creature's reference (`Bestiary
  p.132`) and its own `statBlock` — including a `reactions`/`legendary`/`extras`
  section — composed at export time from this same resolution, through ONE
  domain formatter (`domain/encounterResolve.rosterReferenceFor` /
  `rosterStatBlockFor`). No copy enters the database, the citation keeps its
  `chunkId` + identity, and a re-ingest is reflected by the next export; a
  citation whose chunk has no parseable block prints its named missing-ref line
  and NO box (never a placeholder standing in for numbers). To give a creature an `npc` row of
  its own — the owner's Aunt Agatha path — the MODULE side calls
  `db/creatureRepo.castCreatureAsNpc`; the encounter/bestiary-roster citation
  path deliberately has no cast seam. The bestiary pack's own tier is therefore
  READ-ONLY: a pack publishes statblock chunks, and nothing here writes a
  campaign artifact.
- **Pinned chunks join the citable list.** A chunk the user pinned in the run
  dialog is an explicit instruction to use it, so when it parsed
  (`statBlock !== null` — the same invariant as every ranked citable chunk) it
  joins `statblockChunkIds` in pin order, AHEAD of the ranked hits, and a
  pinned chunk that also ranks is not duplicated: the citation-list order is
  always pinned-first, then rank order (mirroring the excerpt merge's
  pinned-first convention). A pinned chunk whose parse gave up
  (`statBlock: null`) stays excerpt-context-only — decision 3's pool exclusion
  is binding for pins too. The citable SEARCH is unchanged; only the
  post-search list construction extends, and the pinned ids persist inside the
  stored retrieve/brief `statblockChunkIds`, so finalize maps citation indexes
  correctly across pause/resume (additive zod compatibility, no migration).

## 8. Origin labels

`resolveMonsterEntry`'s `rulebook` case prints pages that don't exist for
packs. `MonsterLookups` gains `getRulebook(id)` (replacing the `bookTitle`
lookup); the label becomes:

- `origin === 'pack'` → `"<bookTitle>: <creatureName>"` (creature name =
  `headingPath[0]`),
- otherwise unchanged `"<bookTitle> p.<pageStart>"`.

The return contract (`statBlock | null` + display string) is unchanged, so
all consumers (encounter editor stat-block cards, battle tokens) keep working.

**Amended (docs/17 row 155): the pack title travels FURTHER than the label.**
The `<bookTitle>` an origin label prints is now also STAMPED onto the citation
at birth (`contentIdentityFor`'s optional `bookTitle` — `chunkId`,
`contentHash`, `creatureName`, `bookTitle`), and healed from an export's
manifest on the way in, so a citation whose chunk is NOT in this library can
still name the pack that would satisfy it and the campaign banner can tell the
GM which of his packs to install (`docs/18` §2, the banner's seam row). The
title is a display/report identity, NEVER a resolution key: resolution stays the
chunk uuid, then the exact `contentHash`. The two readings of a book's title are
ONE pair in `domain/encounterResolve`: `rulebookDisplayTitle(book)` (the label's
reading — the `Rulebook` stand-in when there is no row or its title is empty)
and `citationBookTitle(book)` (the stamp's reading — `undefined` when nothing is
known, because a stamp must never carry a placeholder). Because the banner shows
the stamp and a badge shows the label, both are read from the same book row and
are pinned against each other: they cannot name different packs.

## 9. Non-goals

- No fetching from any network **in the import path** (unit-test asserted).
  Amended 2026-09-05 by 16-BESTIARY-FETCH: fetching lives exclusively in
  `src/ingest/packFetch.ts` (user-triggered, pinned sources); the adapters
  and `packImport` still import no `fetch`.
- No Foundry *system code*: no rule elements, roll formulas, or automation —
  packs are read once, mapped to `StatBlock`, and the source JSON is not kept.
- No creature art / token images. Amended 2026-09-05 by afa23f4/64b30f9:
  *ONE generated portrait per rulebook-cited creature kind now exists via
  the mob-artifact arc (11 §"D5 amendment — mob portraits") — creature art
  stays OUT of the pack pipeline itself (adapters still fetch and render
  nothing); the portraits are encounter-side, generated from the chunk's
  stat-block text on an explicit one-click batch.*
- No changes to the PDF stat-block detector (02-INGESTION stays as is).
- No cross-book dedup of re-imports (same policy as PDFs; the `contentHash`
  embedding cache already avoids double embedding cost).
- No spellcasting data in v1. **AMENDED 2026-09-16 by the spells-data arc
  (docs/17 row 181):** the PF2e rules-text lane now carries a structured
  `spellData` payload on `chunkType: 'spell'` RuleChunks (§15.4) — rank,
  traditions, traits, cast facts and per-entry publication — so a spell list
  can be sorted by level and filtered by tradition. This is DATA only: no
  list/filter/chip/detail UI yet (a separate follow-up slice). dnd5e spells
  remain UNIMPORTED (`foundry-dnd5e-srd` still skips them; §5/§13), so that
  follow-up surface must say so PER SYSTEM rather than render a silent empty
  list for a system whose pack carries no spells.

**Derived printed-convention numbers (note).** Two dnd5e mappings are
*derived* values rather than parsed ones, both following the dnd5e system's
own published rules so they are reproducible from the document alone:
calc-`'default'` AC (armor + dex clamp + shield, §5) and custom damage
formulas (term-by-term `@mod`/dice/integer resolution, §5). The pf2e mapping
already reconstructs ability *scores* from stored modifiers the same way
(`10 + 2·mod`, §5 table). Everything else is a direct, exact read of the
document.

## 10. Acceptance criteria

- Importing a pf2e bestiary pack (fixture subset) yields a ready pack book in
  which **every** chunk has a non-null `statBlock`; an encounter entry citing
  one resolves with origin `"<book>: <creature>"` and renders the full block.
- **Corpus sweep (proven 2026-09-06):** all **492/492** pf2e `v14-dev`
  documents parse and map with 0 failures and 0 skips; **336/337** dnd5e
  6.0.x `_source` monsters map exactly, with **one documented exclusion**
  (the Arcane Hand's Clenched Fist stores the summon-level dice-count formula
  `"(4 + 2 * (@flags.dnd5e.summon.level - 5))d8"` whose flag is absent from
  the document — genuinely unresolvable, so it stays a loud per-entry
  failure). All 251 previously-passing dnd5e documents render byte-identical
  after the fix (regression-diffed). The one-error book of the live Monster
  Core import is thereby fixed; re-fetching it yields 492 ready chunks.
- Importing the `ape.yml` fixture yields `abilities.str = 16`, `ac = 12`,
  `hp = 19` with `hpFormula "3d8 + 6"` (score-based dnd5e mapping proven).
  Real-data pins (trimmed verbatim corpus documents, source path in each
  fixture header) cover every fixed failure class: goblin + satyr (derived
  AC), badger + saber-toothed tiger (custom damage), camel (ability `'none'`),
  arcane-eye (null movement/sense scalars), avatar-of-death + tiny-animated-
  object (CR `null` → `"—"`, flat attacks, multi-type damage), roper
  (damage-less), lich (`'spellcasting'` ability) and the pf2e wolf
  (top-level perception, real senses/saves lines).
- An encounter run with a pack book present receives the roster section; a
  valid `sourceName` citation resolves to the correct `chunkId`; a nonsense
  name fails draft validation loudly (repair once, then
  `needs_review`/`failed` per autonomy). The CR-less `"—"` creatures sort
  after every leveled creature in the roster (`parseLevelSort`).
- **Prompt-window ordering (ratified amendment):** with a 305-creature pack
  and a target level, the 300-line prompt window holds the 300 creatures
  closest to the target (the five farthest drop out, the truncation note
  still counts them, distance ties order by level then name); an empty or
  unparseable `levelHint` falls to the owning module's band midpoint, and
  with neither the window is byte-identical to the level/name ascending
  order; a creature outside the visible window still resolves through the
  roster name index.
- An import where every file fails produces a book with `status: 'error'`,
  an `errorMessage` that **leads with the first failure's issue**, and a
  toast — never an empty ready book.
- Existing backups restore unchanged; PDF ingestion and all current encounter
  flows regress none of their tests.
- Zero network calls from the adapters (mocked-fetch test asserts).

## 11. Milestones

- **M-A — Foundations + pf2e**: data-model delta, adapter architecture,
  `foundry-pf2e` adapter (per-file JSON + NDJSON + zip), import flow + UI +
  report, origin labels, tests. This alone fixes stat-less mobs for PF2e
  campaigns.
- **M-B — Encounter grounding**: roster index, `sourceName` citation, prompt
  + validation + finalize wiring, tests.
- **M-C — dnd5e SRD**: `js-yaml` dependency, `foundry-dnd5e-srd` adapter +
  fixtures. Cosmere is deferred until a source exists (§2); `generic-d20` has
  no structured source by definition and keeps the LLM-inline path.

## 12. Bestiary roster tab (source-viewers arc, player-safe)

The Rules screen's right pane gains a **Bestiary tab** beside Search
(05-UI.md §Rules): a browser over every ready book's stat-block chunks —
packs AND PDFs — so the GM can browse the imported bestiary without running
an encounter.

- **Rows.** `buildBestiaryRows` (the viewer variant of §7's
  `collectPackRoster`) maps each `statblock` chunk to a creature row: name
  from `headingPath[0]`, level, ordering key `parseLevelSort` (level
  ascending, ties by name; `"—"` last), and the §8 origin label
  (`"<book>: <creature>"` for packs, `"<book> p.<page>"` for PDFs).
- **Loud data errors stay per-row.** The pack pipeline's exactness invariant
  (§1) makes a pack chunk with `statBlock: null`, no creature name, or an
  unparseable level ILLEGITIMATE — those render as loud data-error rows
  pinned to the top of the list (and are counted in the toolbar), mirroring
  `collectPackRoster`'s throw but scoped to the offending chunk so one bad
  chunk does not blank the viewer. PDF chunks are different by design: their
  stat-block detection is best-effort (02-INGESTION §Step 3), so a PDF chunk
  with `statBlock: null` is simply not a creature entry (no error row), and
  a PDF level `parseLevelSort` cannot read keeps the row but sorts last —
  the documented best-effort reality, not a hidden failure.
- **Scale.** The list is virtualized (`@tanstack/react-virtual`): ~50k
  creatures must scroll smoothly.
- **Detail.** Selecting a row shows the full `StatBlockCard` with the origin
  label above it. The tab is player-safe: it only renders book content that
  is printed in the source material — nothing campaign-hidden.
- **Filters.** Name substring (case-insensitive) and game system; data-error
  rows are never filtered out.
- **Spawn into module (11-ENCOUNTER-GENERATOR D5 amendment, third writer).**
  The detail pane's "Spawn into module" get-or-creates the campaign's mob
  artifact for the creature's chunk (`spawnMobArtifactIntoModule`) and puts
  it into the picked module via `stampModuleOwnership` — module-owned,
  `module:<title>` tagged (spawning into another module PROMOTES it to
  shared campaign level instead of moving it — 10 D12; same-module spawn
  is an idempotent no-op with no revision churn). `/rules` is campaign-agnostic, so the picker chooses the campaign
  too (one campaign preselects; zero campaigns/modules are named empty
  states). Success toasts `"<creature> spawned into '<module>'"` with an
  "Open module" action that navigates to the module reader.

## 13. Equipment/item packs (item-corpus arc, 2026-09-07)

The pack pipeline gains a second, PARALLEL lane: equipment and treasure. The
same fetch → parse → import machinery gains item adapters, a new additive
`'item'` chunk type, and an encounter-side **item pool** — the roster's
equipment counterpart — so the Encounter Smith rewards the party with real,
cited equipment instead of inventing magic items.

### 13.1 Binding decisions

- **Parallel lanes, not a merged parser.** Each system gets a dedicated item
  adapter (`foundry-pf2e-equipment`, `foundry-dnd5e-equipment`) next to its
  creature adapter. `PackEntry.statBlock` stays REQUIRED and
  `PackFileParse` gains an optional `items: PackItemEntry[]`
  (`{ name, item: ItemData, text }`) — the creature adapters, their tests and
  their zero-valid semantics are untouched.
- **Additive zod discipline.** `ruleChunkSchema.itemData` is
  `itemDataSchema.nullish()` and `packMeta.itemsImported` is
  `.optional()` — NOT defaults: chunks and packMeta are read raw from Dexie,
  pre-arc rows genuinely lack the keys, and `z.infer` OUTPUT types must stay
  optional so no creature/PDF construction site changes.
- **Verbatim storage, loud errors.** Category (document `type`), rarity and
  rules edition are stored VERBATIM (the corpus's own spellings, e.g. dnd5e
  camelCase `veryRare`, the empty-string mundane rarity). Unsupported coins,
  negative amounts and bad bundle counts throw per-entry (collected as
  failures, never silently zeroed); unknown pf2e types are counted SKIPS;
  only document types verified in the corpus are accepted.
- **Prices are canonical per-unit cp** plus a deterministic display string.
  pf2e coin maps are zero-filled across all coins and may carry a `per`
  BUNDLE COUNT (Arrows: `{sp: 1}` with `per: 10` → 1 cp each, display
  "1 sp (per 10)"); an all-zero map means "no price stated" (null). dnd5e
  `{value, denomination}` stores a stated 0 as a REAL 0 (`priceCp: 0`,
  display "0 cp") — a mundane-but-free item is data, not an absence.
- **Item packs say "items".** The import toasts, the report badge and the
  fetch-card counts use "items" for item packs (`entryNoun`, `PackRecipe.unit`),
  while creature messages stay byte-identical (`entryNoun ?? 'creature'`).
- **The roster must skip item chunks.** Item books are `origin: 'pack'`
  books of the same system; without the mandatory skip in
  `collectPackRoster`, every encounter run after an equipment import would
  throw "no validated stat block".
- **The item pool mirrors the roster's conventions**: deterministic
  ordering, a hard prompt-window cap (120), a case-insensitive name index
  over ALL entries, counted truncation, cross-book duplicate suffixes, and
  retry-then-loud collection. It grounds the brief's free-text `treasure`
  field by exact item names — deliberately NO new structured output field
  in this arc.

### 13.2 Licensing

- **pf2e equipment** — Paizo Inc. content via the Foundry Gaming LLC
  partnership, mechanics OGL; user-imported for personal use under Paizo's
  Community Use Policy, not for redistribution.
- **dnd5e equipment** — SRD content, in-document `system.source.license:
  CC-BY-4.0`; the in-document `source.rules` field records the rules edition
  ('2014' | '2024') and becomes the item's `rulesEdition`.

### 13.3 Verified source formats (full live corpus sweeps 2026-09-07; fixture tests pin them)

**pf2e** — [foundryvtt/pf2e](https://github.com/foundryvtt/pf2e) `v14-dev`,
`packs/pf2e/equipment/` (flat, one JSON per item): **5707 documents**
(trees API; incl. one `_folders.json`, a counted skip). Accepted item types
are the swept inventory: `weapon`, `armor`, `shield`, `equipment`,
`consumable`, `treasure`, `ammo`, `backpack`, `kit`. Verified field shapes:

- `system.price.value` is a zero-filled MULTI-COIN MAP
  (`{cp:0, gp:45, pp:0, sp:0}`); optional `system.price.per` is the bundle
  count; `system.traits.rarity` is always present ('common'…'unique').
- `system.level.value` is `null` on kit documents (Adventurer's Pack) —
  a null level, not a skip.
- No rules-edition marker → `rulesEdition: null`. Legacy NDJSON `.db`
  releases accepted.

**dnd5e** — [foundryvtt/dnd5e](https://github.com/foundryvtt/dnd5e) `6.0.x`,
`packs/_source/` YAML: `equipment24/` (**679** documents, 2024 rules),
`items/` (**889**, 2014 rules), `tradegoods/` (**23**) — **all 1454 swept,
zero parse errors**. Accepted item types: `weapon`, `equipment`,
`consumable`, `tool`, `loot` (the complete inventory). Verified field
shapes:

- `system.price = {value, denomination}` with denominations cp/sp/gp only
  (the ladder accepts all five coins; others fail loudly).
- `system.rarity`: `''` (mundane), common, uncommon, rare, `veryRare`
  (camelCase, stored verbatim), legendary, artifact.
- Top-level `type` exists on every swept document and is the category;
  NO level exists anywhere — `itemData.level` is always null.
- `system.properties` (slugs like `ver`) map through the shared
  `DND5E_PROPERTY_LABELS` table; unknown slugs are KEPT RAW — never dropped.

### 13.4 Data model (delta to 01-DATA-MODEL and §4)

- `chunkTypeSchema` gains `'item'`; `ruleChunkSchema` gains `itemData`
  (nullish). An item chunk has `statBlock: null`, its name in
  `headingPath[0]`, and its stamps CONTINUE after the creature lane's
  (unique per book).
- `ItemData` (new domain schema): `system`, `category`, `level`
  (int, nullable), `priceDisplay`, `priceCp` (nonneg, nullable),
  `rarity` (default ''), `traits` (default []), `rulesEdition`
  (nullable).
- `packMeta.itemsImported` (optional int, nonneg): valid item entries in
  the book; `entriesImported` counts BOTH lanes. `PackImportResult`
  gains `itemsImported`.

### 13.5 Adapter, fetch and pipeline delta (delta to §5–§7 and 16)

- Adapters accept `.json`/`.db` (pf2e) and `.yml`/`.yaml` (dnd5e), are
  self-contained, and are registered after the creature adapters. **REWRITTEN by
  docs/17 row 143 (see the §5 amendment): the parenthetical that used to read
  *"(shared text-stripping rules copied per §5's precedent; the dnd5e
  property-label table is exported and reused verbatim)"* is SUPERSEDED on its
  first half — the text-stripping rules are no longer copied per adapter, both
  item lanes go through `ingest/packs/text.htmlToText` and DECLARE a style
  (`BRACKET_LINKS_LINE_BREAKS`; the pf2e lane declared
  `AT_LABEL_LAST_LINE_BREAKS` until docs/17 row 149 deleted it — see the §5
  amendment's re-import paragraph). The second half
  still stands: the dnd5e property-label table IS exported and reused verbatim.**
  **EXTENDED by docs/17 row 147 (see the §5 amendment): "self-contained" no
  longer covers the DOCUMENT STREAM either — both item lanes take their
  documents from `ingest/packs/text.parseYamlDocs` (whole-file YAML, one
  document per `---`), the pf2e lanes from `parseJsonDocs`, so what each adapter
  still owns is its zod SCHEMA and its MAPPER. The dnd5e EQUIPMENT lane's YAML
  body was the one that silently swallowed a comment-only file; the seam's rule
  (no document at all → loud file-level failure; a `null` document → one counted
  skip) is now the only one either dnd5e lane can take.**
- `PackAdapter.entryNoun?` names the zero-valid error's noun; the pf2e item
  source shares the pf2e repo/packRoot and `PackFetchSource.packDirs`
  scopes its advanced "list everything" listing to `packs/pf2e/equipment`
  (the dnd5e item source scopes `packs/_source` to `equipment24`, `items`,
  `tradegoods`); `PackRecipe.unit?: 'items'` labels the curated counts.
- The rules browser's type filter gains "Items"; item chunks render their
  `formatItemText` summary (category · Level N · price · rarity · rules)
  in the search browser.
- `collectItemPool`/`collectItemPoolWithRetry` (new `src/llm/
  encounterItems.ts`): reads ready pack books with
  `packMeta.itemsImported > 0`, item chunks only (a typed chunk without
  validated item data is a loud data error), optional
  `ItemPoolFilter {level?, priceCp?, rarities?, categories?}` narrowing
  BEFORE ordering and the cap, target-level distance ordering (ties by
  level, price, name), `ITEM_POOL_LIMIT = 120`.
- The retrieve step collects the pool alongside the roster (same resolved
  target level), persists `itemLines/itemTruncated/itemChunkByName`
  (additive zod defaults — old runs read back empty), and the draft and
  encounter-brief prompts render `formatItemPoolSection` after the roster
  section: null without item books, so those prompts are byte-identical
  to the pre-arc shape.

### 13.6 Non-goals

- No PDF item extraction, no Cosmere/4e/generic-d20 item sources, no price
  conversion between systems, no inventory/shopkeeping feature, no
  structured item output field on the encounter brief (the pool grounds the
  free-text `treasure` field), and no item citation ENFORCEMENT yet — an
  invented item name in the treasure text is a quality issue, not a run
  failure, until a follow-up arc adds validation.

### 13.7 Acceptance criteria (additive to §10)

- A pf2e item import produces an item-only book: `itemsImported` in the
  badge and toast, chunks of type `item` with validated `itemData`, and
  encounter runs in that system still work (roster skip-guard).
- The dnd5e item chain imports 2024 equipment, 2014 items and trade goods
  with the verbatim rarity/edition rules above; fixtures pin one real
  document per accepted type.
- The encounter prompt renders the item pool section (after the roster)
  only when an item pack book exists, and stays byte-identical otherwise;
  the stored retrieve output round-trips across pause/resume.
- Every gate passes against exactly the committed slice, per commit.


## 14. Treasure-budget grounding (room-keys/treasure arc, 2026-09-07)

The item pool (§13) grounds WHAT the treasure names; the room-keys/treasure
arc (11-ENCOUNTER-GENERATOR D9) grounds HOW MUCH. The encounter prompts'
treasure clause is per-system, and the licensing shape is binding:

- **dnd5e** — Campaigner ships its OWN documented approximation (pocket
  treasure ≈ 5 × CR in mixed gp-equivalent coins; hoards ≈ 50 gp × average
  encounter level; at most one magic item per two encounter levels). The
  DMG treasure chapters are **not licensable**: no DMG text is quoted,
  paraphrased or restated anywhere in the product — the approximation lives
  in `src/llm/treasureGuidance.ts` and its unit tests are the pin.
- **pathfinder2e** — the GM Core treasure rules are the law. Campaigner
  ships NO Paizo text; the model grounds amounts in the **VERBATIM** GM
  Core excerpts the retrieve step surfaced (user-ingested rulebook, Paizo's
  Community Use Policy, personal use) via the encounter personas' third
  bounded search (`'treasure budget by level party wealth hoard coins'`,
  limit 3, `chunkTypes: ['section', 'table']`) — excerpt context, never a
  citation channel, never re-ranked into the citable list. Without such an
  excerpt the model gives unquantified treasure rather than inventing
  amounts.
- Both budgets cohere with the §13 item-pool section: the pool clause names
  items verbatim, the budget clause sizes the reward — the prompt carries
  structure/budget ONLY around the pool wording, never re-states it.
- The free-text `treasure` output shape stands (no structured loot schema,
  §13.6 non-goals): hoard-level finds go to the encounter's top-level
  `treasure` field or the room's `keyTreasure`, pocket finds to the roster
  entry's additive `treasure` string.

## 15. Rules-text packs (journal/conditions/corpus arc, 2026-09-07)

The pack pipeline gains a THIRD parallel lane: rules TEXT. Motivation: the
encounter-budget advisory should ground in real GM Core tables, and the
already-pinned Foundry VTT PF2e repo ships them as journal packs —
`packs/pf2e/journals/gm-screen.json` is ONE JournalEntry document whose
pages carry the Encounter Budget (Trivial 40 or less / Low 60 / Moderate 80 /
Severe 120 / Extreme 160 + character adjustments), XP Awards by level offset,
Elite/Weak Monster Adjustments and the DC tables, each page footer-citing its
source ("Pathfinder GM Core pg. 75"). The same machinery then imports
conditions and the feats/spells/actions/class-features corpus. The contract
is unchanged: user-triggered fetches, per-pack buttons, provenance + license
on the book, network-free adapters, loud per-entry failures.

### 15.1 Binding decisions

- **A third parallel lane, not a parser change.** `PackFileParse` gains
  optional `sections: PackSectionEntry[]` (`{ categories, name, text }`) —
  `PackEntry.statBlock` stays REQUIRED and the creature/item lanes are
  untouched. `packImport` persists `section` RuleChunks (`statBlock: null`,
  `itemData` absent) after the item lane and counts them in
  `PackImportResult.sectionsImported` + `packMeta.sectionsImported` (both
  additive-optional — old rows parse unchanged; `entriesImported` counts all
  three lanes).
- **One chunk per journal page.** The journal adapter turns each page into a
  section chunk: the page name is the heading, the HTML is stripped
  TABLE-AWARE (cells join with ` | ` so "Trivial | 40 or less | 10 or less"
  stays readable), the page's `<em>Section: X</em>` footer becomes the
  heading category (the 5 level-1 divider pages carry no footer →
  `headingPath [pageName]`), and the `<em>…pg. N</em>` footer is re-emitted
  verbatim as a trailing `Source: …` line — citations preserved, never
  duplicated.
- **Per-entry licensing is PRESERVED, not dropped.** Conditions, feats,
  spells and actions carry `system.publication {license, remaster, title}`
  at full coverage (sampled: ORC/Player Core, OGL/Core Rulebook); the
  adapters re-emit it as each chunk text's trailing
  `Source: <title> (<license>)` line. The hygiene rider (same arc) carries
  the same field into creature `statBlock.extras['Source']` and additive
  `itemData.publication` (+ its `Source:` text line) — one convention across
  lanes.
- **The roster must skip rules chunks.** Rules-text books are `origin:
  'pack'` books of the same system; `collectPackRoster` skips `item`,
  `section` AND (since the spells arc §15.4) `spell` chunks — without the
  guard every encounter run after such an import would die on "no validated
  stat block". The `spell` arm is load-bearing the moment a rules pack is
  re-imported, because spells move OUT of `section` into their own type.
- **Volume honesty on the opt-in.** The GM Screen recipe counts PAGES (61 —
  the fetch is one document, the volume is its pages); the conditions recipe
  counts its 43 documents; the corpus source is ONE entry labelled with the
  volumes ("feats 6,284 · spells 1,994 · actions 574 · class features 874")
  so the user opts in deliberately. Toast/report nouns: journal pages and
  condition/corpus entries are all "sections".
- **Retrieval-weight tradeoff (named).** The corpus is ~9.7k new chunks; the
  keyword index is an in-memory MiniSearch rebuilt from Dexie, and hybrid
  ranking weights by relevance, so corpus hits rank alongside PDF-derived
  sections. The rules browser's book/type filters are the user's throttle;
  no retrieval code changed.
- **Single-document recipes.** `selectCreatureFiles` accepts a recipe that
  names ONE file (journal packs are one JSON per journal) — folder recipes
  behave byte-identically.

### 15.2 Licensing

- **GM Screen journal** — the book label says "PF2e GM Screen (Paizo–Foundry
  partnership; summarizes GM Core)": the journal SUMMARIZES Pathfinder GM
  Core, it is not GM Core itself; per-page citations to the GM Core source
  are preserved in the chunk text. Book license string keeps the CUP
  non-redistribution terms (§13.2 pattern).
- **Conditions / corpus** — Paizo content via the Foundry Gaming LLC
  partnership with PER-ENTRY licensing (ORC or OGL) stored in each chunk's
  Source line; user-imported for personal use under Paizo's Community Use
  Policy, not for redistribution.

### 15.3 Verified source formats (re-verified live 2026-09-07 at `v14-dev`; fixture tests pin them)

- **journals/gm-screen.json** — one JournalEntry document: `{name: 'GM
  Screen', pages: [61], categories: []}` (the discovery's "~100 pages"
  estimate was off — 61 actual, disclosed); page = `{name, text: {content:
  HTML}, title: {level, show}, category: null}`. Grouping lives in the page
  HTML footer, not `page.category`.
- **conditions/** — 43 flat per-condition JSON documents (`type:
  'condition'`; description HTML, traits, valued conditions like Frightened
  carry `value {isValued, value}` — not rendered, the description states the
  mechanics).
- **feats/** — 6,284 documents in 7 category folders (ancestry 1,561,
  archetype 2,340, class 1,993, general 41, miscellaneous 72, mythic 49,
  skill 228), nested to `feats/<category>/<sub>/<slug>.json`.
- **spells/** — 1,994 in focus (545) / impossible-spells (5) / rituals (167)
  / rank folders under `spells/spells/` (cantrip 71, rank-1 183 … rank-10
  28).
- **actions/** — 574 in 20 category folders (basic 30, skill 54, archetype
  140, class 196 …), nested to depth 3.
- **class-features/** — 874 documents, flat or per-class folders; they are
  `type: 'feat'` with `system.category: 'classfeature'` — the corpus
  adapter's folder walk (not the doc type) labels them "Class Features".
- Entity shape (feat/spell/action): `system.description.value` HTML,
  `system.traits {value, rarity, traditions}`, `system.level.value`,
  `system.actionType.value`, `system.prerequisites.value[].value`, spell
  `time/range/target/duration`, `system.publication` — the consumed subset;
  unknown keys ignored, never re-serialized.

### 15.4 Data model (delta to 01-DATA-MODEL and §4)

- `packMeta.sectionsImported` (optional int, nonneg) — valid rules-text
  entries in the book; `PackImportResult` gains `sectionsImported`. It keeps
  counting the rules-text LANE, whose chunks are now `section` OR `spell`.
- `itemData.publication` (additive nullish `{title, license}`) — the
  hygiene rider's stored metadata for items; rendered by `formatItemText`.
- **AMENDED 2026-09-16 (the spells arc, docs/17 row 181):** a PF2e spell
  document lands a `chunkType: 'spell'` RuleChunk carrying a new
  `spellData` payload (`src/domain/spellData.ts`): `system`; `rank` (a
  cantrip is 0 — MEASURED: `v14-dev` stores cantrips at `level.value: 1`
  with the `cantrip` trait, so the trait is normalized for a level-sorted
  list); `cantrip` (the TRAIT signal — the same one `rank: 0` is derived
  from); validated `traditions` (arcane/divine/occult/primal); verbatim
  `traits`; `rarity`; the four cast facts (`time`/`range`/`target`/
  `duration`); the per-entry `publication` (license preserved); and the
  HEIGHTENING capture, in three parts: `heightening` (the source's own
  `system.heightening` object VERBATIM — never normalized, `.nullish()` when
  the document carries none); `heighteningEntries` (notes parsed out of the
  RAW description HTML before it is stripped, in document order —
  `{kind:'fixed', rank:N, text}` from `<strong>Heightened (3rd)</strong> …`
  and `{kind:'increment', increment:N, text}` from
  `<strong>Heightened (+1)</strong> …`); and `heighteningUnparsed` (the raw
  description line(s) that mention "Heightened" but matched NEITHER shape —
  LOUD DATA, never a run failure and never a silent drop). NO derived
  cast-rank value is computed here: rendering a spell at the rank a mob
  actually casts it is the next arc's policy, and this capture exists so it
  needs no second pass over the packs.
  `ruleChunkSchema.spellData` is `.nullish()` for the item lane's exact
  reason — chunks are read raw from Dexie and pre-arc rows genuinely lack
  the key — so there is NO migration, NO Dexie index change (`chunkType` is
  already indexed) and NO guessing from prose. **A library written before
  this arc needs a RE-IMPORT of the rules pack to gain structured spells**;
  until then its rows stay honest `section` chunks and no spell list counts
  them. `chunkType` gains `'spell'` alongside `section/statblock/table/item`.
- **No new chunk type for the OTHER rules text** — conditions, feats,
  actions, class features and journal pages stay `section` chunks with no
  payload (`conditionData` still does not exist).
- **A named follow-up consequence of the `spell` type:** the Rules screen's
  existing chunk-type filter (`features/rules/search-browser.tsx`) lists
  Sections / Stat blocks / Tables / Items and has NO `Spells` option, so after
  a re-import a spell is no longer found under "Sections" when a type filter
  is active (an unfiltered search still finds it). Adding that filter entry
  belongs to the follow-up spell UI slice, which must also state per system
  that dnd5e spells are unimported; this DATA landing deliberately renders
  nothing. `runEngine`'s treasure-grounding search stays `['section',
  'table']` — a spell is not treasure, so that filter is unchanged by design.

### 15.5 Adapter, fetch and pipeline delta (delta to §5–§7 and 16)

- Three adapters, self-contained per §5's precedent (each carries its own
  strip/Source-line helpers): `foundry-pf2e-journal` (JournalEntry → one
  section per page), `foundry-pf2e-conditions` (condition entities),
  `foundry-pf2e-rules` (feat/spell/action corpus). All accept `.json`/`.db`.
  **REWRITTEN by docs/17 row 143 (see the §5 amendment): the "own strip helper"
  half of that parenthetical is SUPERSEDED — all three lanes now share
  `ingest/packs/text.htmlToText` and declare the block-and-table style
  (`AT_BRACE_LABEL_BLOCK_AND_TABLE`), so the three cannot drift apart. The
  "Source-line helper" half is NOT folded by that landing and is still carried
  twice (`publicationSourceLine` — private in `pf2e-rules.ts`, exported from
  `pf2e-conditions.ts`, byte-identical bodies); row 143 records it as the next
  occupant of the same module rather than a silent fold. **EXTENDED by docs/17
  row 147 (see the §5 amendment): that row TOOK the occupancy for the document
  parsers — all three lanes, and both dnd5e lanes, now take their documents from
  `ingest/packs/text.parseJsonDocs` / `parseYamlDocs`, so "self-contained"
  describes the adapters' SCHEMAS and MAPPERS only. It did NOT fold the
  Source-line helper: it landed the four-site DIFFERENTIAL pin instead
  (`tests/ingest/packs/source-line.test.ts`, all four byte-identical on the two
  real fixture families plus six edge shapes, with the raw `extras['Source']`
  form declared as the one intentional difference), because that sentence above
  still describes the copies as carried. The fold stays the OWNER'S CALL and
  the pin is what makes it safe to defer — a drift between the copies now fails
  a named test.**
- The corpus adapter maps the fetch-relative FOLDER PATH into heading
  categories: the pack folder names the lane ('Feats', 'Spells', 'Actions',
  'Class Features'), the first category folder rides the lane label
  ('Feats — Skill'), deeper folders become titled segments ('Level 1',
  'Cantrip', 'Rank 2'), the pack folder never repeats ('spells/spells/…' →
  'Spells — Cantrip'); loose manual imports fall back to doc type/category.
- Three fetch sources join `PACK_FETCH_SOURCES` (all foundryvtt/pf2e @
  `v14-dev`, `packRoot packs/pf2e`, `packDirs` scoped): journals (curated:
  GM Screen, 61 pages), conditions (43), rules corpus (4 recipes with the
  volume counts). Per-type summary lines: Feat/Spell/Cantrip + level, traits
  (+ spell traditions), Action/Reaction/Free Action, rarity when uncommon+,
  spell Cast line, Prerequisites line.
- **The spells arc ADDS a payload to that ONE mapping, never a second
  parser.** `pf2e-rules.ts`'s existing `mapRulesDoc` builds `spellDataFor`
  from the SAME parsed document fields it already renders, returns it on the
  `PackSectionEntry` as `spell`, and `packImport.sectionChunk` persists the
  `spell` chunk (or the unchanged `section` chunk when the key is absent).
  It also parses the heightening notes out of the RAW description HTML (the
  `<strong>Heightened …</strong>` tags are the only place the rank/interval
  lives) with the lane's ONE HTML→text seam, and captures the source's own
  `system.heightening` verbatim for a later arc.
  The emitted TEXT is byte-identical to the arc base — it IS the
  `contentHash`, so moving it would invalidate stored citations; the
  adapter's own compat pin (`pf2e-rules.test.ts`, per-fixture sha256 against
  the base bytes) and the pre-existing all-lane digest pin
  (`html-to-text.test.ts`) both hold it.
- The Settings card, import report badge and toasts name the new counts
  ('pages', 'sections'); the report gains a sections badge like the items
  one.

### 15.6 Non-goals

- No PDF/scraped Paizo text: the GM Screen arrives through the SAME curated
  fetch machinery as bestiaries (docs/16 §4.2) — no HTML scraping surface.
- No structured rules payloads EXCEPT the spells arc's `spellData` (docs/17
  row 181): conditions/feats/actions/class-features stay TEXT sections — no
  `conditionData`/`featData` schema — and there are no rules-aware prompt
  sections beyond the existing retrieve lane, no class-features-only recipe
  split, no per-entry license ENFORCEMENT. The spell payload captures
  heightening as DATA (the source's own structure plus the parsed notes); it
  deliberately computes NO derived value at a cast rank — choosing the rank a
  mob casts a spell at is the mob arc's policy, not ingest's.

### 15.7 Acceptance criteria (additive to §10)

- Each import produces a rules-text book: `sectionsImported` in badge/
  toast, chunks of type `section` (journal pages, conditions, feats,
  actions, class features) or `spell` with adapter-supplied heading paths
  and per-entry Source lines; encounter runs still work after such an import
  (roster skip-guard, pinned by test — including the `spell` arm).
- The GM Screen book's Encounter Budget chunk contains the table text
  ('Trivial | 40 or less | 10 or less' … 'Extreme | 160 | 40') and the
  'Source: Pathfinder GM Core pg. 75' line — the advisory-grounding pin.
- The corpus import lands folder-derived heading paths ('Feats — Skill' …)
  and ORC/OGL Source lines on real fixtures (2 feats + 1 spell + 1 action).
- The real Acid Splash fixture pins the structured payload field-for-field:
  `rank: 0` + `cantrip: true` (the trait), the traditions, the four cast
  facts, the OGL publication, the source `system.heightening` object
  deep-equal to the fixture's, and its FOUR fixed heightening notes (3rd,
  5th, 7th, 9th) verbatim in document order; a synthetic increment heading
  and a synthetic unparsed `Heightened` line are pinned too, and the emitted
  text sha256 is unchanged from the arc base.
- Every gate passes against exactly the committed slice, per commit.
