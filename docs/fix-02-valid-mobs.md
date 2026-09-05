# fix-02 — Valid mobs: materialized Smith monsters, a citable stat-block pool and a hardened roster

Status: **implemented**. Builds on `12-BESTIARY-PACKS.md` (§1–§11, M-A/M-B/M-C
landed) and `11-ENCOUNTER-GENERATOR.md` (Smith/Cartographer contracts);
binding conventions from `00-OVERVIEW.md §Global conventions` and `AGENTS.md`
apply.

## Problem

After the bestiary-pack work, generated encounters can still field **stat-less
mobs**, through four remaining holes:

1. **The Encounter Smith finalizes name-only monsters silently.** Its draft
   validation only rejects citations that are *present but unresolvable*
   (`invalidCitationIssues`); a monster with no citation at all is
   "legitimate" and finalize writes `{ type: 'none' }`. The battle seeder then
   produces HP-less tokens excluded from initiative — the exact stat-less mob
   the pack work was meant to kill, now reachable even *with* a pack
   installed.
2. **The citable pool contains unparsed chunks.** PDF ingestion is allowed to
   give up on a stat block (`statBlock: null`, 02-INGESTION §Step 3) while the
   chunk keeps `chunkType: 'statblock'`. Both the Smith/Cartographer
   statblock-restricted retrieval and the "Link a rulebook stat block" dialog
   search `chunkTypes: ['statblock']`, so a null-statBlock chunk can consume a
   result slot: the model is invited to cite an excerpt with no stats behind
   it, and the dialog offers an unresolvable link (spec 12 §1: the statBlock
   is exact, never best-effort).
3. **A failing roster build has no retry and duplicate roster names are
   ambiguous.** The roster index is recomputed per run from the pack books; a
   transient failure (blocked DB, mid-import read) fails the run with an
   unwrapped low-level error. And when two ready pack books contain the same
   creature name, the roster line appears twice with no hint which book the
   citation resolves to (most-recent-book-first is deterministic but
   invisible).
4. **No-pack campaigns get no signal.** A campaign whose system has no ready
   pack book silently runs with excerpts/inline only; nothing tells the GM
   why every mob arrives as inline stats.

### Root causes (discovery, 2024 session)

1. **The Smith's finalize predates decision 12 §7's loudness.** `runFinalize`
   (`src/llm/runEngine.ts`) remaps monsters to `rulebook`/`inline`/`none`,
   and the Smith draft validator (`invalidCitationIssues`) deliberately
   skips name-only monsters — a compromise from M3-B that spec 12 §7 was
   supposed to retire ("never a silent fallback to name-only").
2. **The search layer filters on `chunkType` only.** `searchKeyword`
   (`src/search/keywordIndex.ts`) and `searchRules`
   (`src/search/search.ts`) cannot express "has a validated stat block", so
   both retrieval consumers filter after ranking — too late: the `limit`
   budget is already spent on null chunks.
3. **`collectPackRoster` is single-shot and name-blind across books.** No
   bounded retry wraps the Dexie reads, and `buildPackRoster` formats lines
   from name/level/traits alone.

## Binding decisions (product owner, 2024 session)

1. **Smith source-less monsters are materialized, never silent.** A
   Smith-generated monster with no resolvable source (no valid
   `sourceChunkIndex`/`sourceName`, no inline block) must end up with a REAL
   stat block: the run creates an NPC artifact with a full, zod-validated
   stat block and the encounter entry links it via the existing
   `{type:'npc-ref'}` route. Silent `{type:'none'}` finalize for Smith
   monsters is abolished.
2. **Loud failure if unproducible.** If a valid stat block cannot be produced
   within the existing one-repair loop, the draft is rejected with named
   per-monster issues and the existing autonomy mapping applies
   (manual→`awaiting_user`, review→`needs_review`, auto→failed run). Never a
   placeholder.
3. **The citable pool excludes unparsed chunks.** Retrieval
   (statblock-restricted search) and the "Link a rulebook stat block" dialog
   must never offer chunks with `statBlock == null` (spec 12 §1: exact, never
   best-effort). Marking titles instead of excluding is NOT accepted for the
   retrieval pool; the dialog may exclude likewise.
4. **Roster failure = retry, then loud.** A failing roster build retries
   automatically (bounded, 2 attempts) for transient failures; persistent
   failure fails the run loudly with a named error identifying the
   roster/book/chunk. No silent inline-only fallback.
5. **Duplicate roster names disambiguate only when duplicated.** Roster lines
   for a name present in more than one ready pack book get a
   `" — <bookTitle>"` suffix; resolution stays most-recent-book-first (landed
   behavior).
6. **No-pack affordance.** The encounter run dialog shows one lightweight,
   non-blocking notice when the campaign system has no ready
   machine-readable bestiary pack (e.g. "No bestiary pack for <system>
   installed — mobs will be inline/name-only"). No notice when one exists.

---

## Design

### Smith materialization (decisions 1–2)

- **Prompt.** The Encounter Smith persona prompt (and the per-run draft
  contract in `runDraft`) require every monster that is not cited to a listed
  stat-block excerpt or a bestiary roster entry to carry a **complete inline
  `statBlock`** — same schema hint the Cartographer already injects
  (`statBlockSchemaHint`); a partial block is a validation failure. When the
  run has neither excerpts nor roster entries, the prompt states that *every*
  monster needs the inline block.
- **Draft validation.** The Smith draft now runs the same source check as the
  Cartographer brief (`encounterSourceIssues`): every monster must carry a
  resolvable citation or an inline block. Violations produce one named-issue
  repair turn, then the loud rejected path with the existing autonomy
  mapping (decision 2).
- **Finalize materialization (both Smith paths).** In `runFinalize` — which
  serves the fresh-draft creation *and* the in-place content run into an
  existing encounter — the remap becomes:
  - cited excerpt/roster chunk → `{ type: 'rulebook', chunkId }` (unchanged);
  - inline stat block → **materialized**: a campaign-scoped `npc` artifact is
    created through `createArtifact` (zod-parsed, `stampNewEntity`
    identity, revision-1 snapshot, revision meta `{source:'persona',
    runId}`) with `data.statBlock` set to the validated block, and the entry
    is written as `{ type: 'npc-ref', artifactId }`. The monster's tactical
    notes become the NPC's summary when non-empty; nothing else is invented.
  - an NPC of the exact name (case-insensitive, trimmed) already in the
    campaign is **reused, not duplicated** (fix-01's one-entity-per-name
    rule): the entry links the existing artifact, and if that NPC has no
    stat block yet the materialized block is written into it (a revisioned
    persona save); an existing block is never overwritten. Duplicate names
    inside one run collapse onto the first materialized NPC.
  - a monster with no citable source and no inline block reaching finalize
    (only possible through a hand-edited step) **throws** — finalize refuses
    to write `{ type: 'none' }`.
- **Cartographer untouched.** `runEncounterFinalize` keeps the verbatim
  roster semantics: its fresh-run inline blocks persist as `{type:'inline'}`,
  its regenerate path replaces sources from the target. Only the Smith
  materializes.

### Citable pool (decision 3)

- The keyword index stores a `hasStatBlock` flag per chunk and
  `searchKeyword` gains a `hasStatBlock` filter applied **before** the
  `limit` slice, so null-statBlock chunks cannot consume result budget.
- `searchRules` exposes `hasStatBlock` and applies it to the semantic
  candidate set as well, so fusion cannot reintroduce unparsed chunks.
- Consumers: the encounter retrieve step's statblock-restricted search and
  the "Link a rulebook stat block" dialog pass `hasStatBlock: true`.

### Roster hardening (decisions 4–5)

- `collectPackRosterWithRetry` wraps the roster build with **2 attempts**
  (one automatic retry; no delay). Persistent failure throws a named error —
  `Bestiary pack roster for system "<system>" failed after 2 attempts: …` —
  whose cause carries the original book/chunk-level message (e.g. "pack
  chunk <id> has no validated stat block — re-import the pack"). The run
  fails loudly via the normal engine path; there is no inline-only fallback.
- `buildPackRoster` appends ` — <bookTitle>` to a roster line only when that
  creature name occurs in **more than one** ready pack book (distinct
  `bookId`s per case-insensitive name). The name→chunkId map keeps bare-name
  keys; the suffix never affects ordering (levelSort, then name — the prompt
  window's target-level ordering is doc 12 §7's ratified amendment, and the
  suffix composes with either order).

### No-pack affordance (decision 6)

- The persona panel's encounter run section shows one muted, non-blocking
  notice when no ready pack book exists for the campaign system
  ("No bestiary pack for <System> installed — encounter monsters will be
  materialized from inline stat blocks."). With decision 1 landed the mobs
  are never name-only, so the notice names the inline/materialized reality.
  No notice while rulebooks load or when a ready pack exists.

---

## Acceptance criteria

- A Smith draft whose monster has no citation and no inline block is
  rejected after exactly one repair turn with a named per-monster issue; on
  auto autonomy the run fails with that issue in `errorMessage`; manual/review
  pause with the raw reply for editing. No artifact is created.
- A Smith run whose uncited monster carries a full inline stat block
  finalizes with `{ type: 'npc-ref', artifactId }`; `resolveMonsterEntry`'s
  npc-ref case returns the full block with origin `NPC: <name>`; battle
  seeding produces fighting tokens (HP + initiative) backed by the NPC
  artifact.
- A second Smith monster (or a later run) naming an NPC that already exists
  in the campaign links to it — no duplicate artifact; a statless twin gets
  the block filled, an existing block is preserved.
- A chunk with `statBlock: null` never appears in the statblock-restricted
  retrieval pool (and never consumes a `limit` slot) nor in the "Link a
  rulebook stat block" dialog.
- A roster build that fails once succeeds on the automatic retry (2 attempts
  total); a persistent failure fails the run with the named roster error.
- Roster lines for a name present in two pack books carry the
  ` — <bookTitle>` suffix; the suffix never reorders lines and unique names
  stay bare; `sourceName` resolution still matches the bare name. (Line
  ordering within the prompt window itself is doc 12 §7's ratified
  target-level amendment: distance to the target when one exists, otherwise
  the level/name ascending order this fix landed with.)
- The encounter run dialog shows the no-pack notice exactly when no ready
  pack book exists for the campaign system.
- `PackEntry.levelSort`/`traits` are gone; both adapters compile without
  them; roster ordering derives from the persisted `statBlock` via
  `parseLevelSort` (doc 12 §5 delta). `RuleChunk` is unchanged.
- `pnpm lint && pnpm typecheck && pnpm test` green; no existing test weakened.

## Non-goals

- Cartographer regenerate behavior (roster stays verbatim) and the
  autonomy-mapping divergence in its brief path (L5, separately queued).
- ChainRunner/runEngine dedup (separately queued).
- Cross-scope (global library) NPC materialization or alias UI.
- Improving PDF stat-block parsing (02-INGESTION stays as is; spec 12 §9).
- A retry/pack-health indicator beyond the single notice (decision 6 keeps
  it lightweight and non-blocking).
