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
  the bytes into this pipeline. The import path itself stays network-free:
  adapters parse bytes they are handed and never fetch (unit-test asserted).
- **Loud failure policy.** Per-entry validation failures are collected and
  shown in an import report (AGENTS rule 1). Zero valid entries → the book is
  marked `error` and the import throws; an empty "ready" book is forbidden.

## 2. Licensing constraints (binding)

Campaigner must **never bundle, redistribute, or re-serve** the content below
(amended 2026-09-05 by 16-BESTIARY-FETCH: *user-triggered fetch from the
pinned sources there is allowed and changes the acquisition channel, not the
licensing model — the fetch downloads to the user's own browser storage from
the upstream repo the user chose; Campaigner never bundles, re-serves, or
redistributes, and the book stores provenance — source ref, URL, fetch time —
plus the license, displayed in the UI*).
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
docs as NDJSON (`.db`) files — the adapter accepts both. Relevant shape (all
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
dependency — a pack zip or a repo zip's pack folder both work). The runner
recurses into zip folder structure so "select the whole bestiary folder zip"
is one action.

### `foundry-pf2e` mapping (all entries with `type !== 'npc'` are skipped)

| pf2e pack field | StatBlock target |
|---|---|
| `name` | identity + `headingPath[0]` |
| `system.details.level.value` | `level` (string) |
| `system.abilities.*.mod` (modifiers!) | **score = 10 + 2·mod** (binding: the exact inverse of `abilityModifier`, so the shared stat-block UI prints identically); raw mods additionally into `extras['Ability modifiers']` for fidelity |
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

## 9. Non-goals

- No fetching from any network **in the import path** (unit-test asserted).
  Amended 2026-09-05 by 16-BESTIARY-FETCH: fetching lives exclusively in
  `src/ingest/packFetch.ts` (user-triggered, pinned sources); the adapters
  and `packImport` still import no `fetch`.
- No Foundry *system code*: no rule elements, roll formulas, or automation —
  packs are read once, mapped to `StatBlock`, and the source JSON is not kept.
- No creature art / token images.
- No changes to the PDF stat-block detector (02-INGESTION stays as is).
- No cross-book dedup of re-imports (same policy as PDFs; the `contentHash`
  embedding cache already avoids double embedding cost).
- No spellcasting data in v1.

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
