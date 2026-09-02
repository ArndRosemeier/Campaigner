# 10 — Milestone 6: Ownership scopes & play retirement

Three ownership levels for authored content — **Global** (shared library),
**Campaign** (today's artifact) and **Module** (owned by one module) — plus
the retirement of the standalone Session-Mode play view: **the module view
becomes the only play view**, and battles re-anchor from session artifacts
to modules.

Binding conventions from `00-OVERVIEW.md §Global conventions` and
`AGENTS.md` apply throughout (no silent fallbacks; zod at every boundary;
failures loud; gate + one logical task per commit).

## Decisions (binding, settled across three iteration rounds)

| # | Decision |
|---|---|
| D1 | Scope is **derived** from `(campaignId, moduleId)` — never a stored `scope` column. |
| D2 | Everything related to an artifact (images, revisions, tags, notes) travels with it across scopes. The one HP exception stays as built in M5: NPC current HP lives on the battle token; PC current HP lives on the pc artifact. |
| D3 | Visibility is a **user-controlled scope filter** (three toggles: Global / Campaign / Module), remembered as a UI preference — not a hardcoded default. |
| D4 | The **module view is the play view**; its scope control defaults to **all scopes visible**. There is no separate Play page (retired in M6-E). |
| D5 | Deleting a module **asks**: delete its artifacts (cascade, counts shown) or keep them (they become campaign-owned). "Adopt into campaign" is available per artifact at any time. |
| D6 | Global kinds: `npc`, `location`, `faction`, `encounter`. **Never** `pc` (its HP lives on the artifact — a global PC would share wounds across campaigns; pregens ship via a later import/export feature), never `plotarc`, and `session` ceases to exist (D8). |
| D7 | Campaigns **always reference** global artifacts in place — links, battles, persona reads, images all point at the one global row. **Duplication is not a feature**: no copy-on-use, no "duplicate" button. Editing a global artifact is instantly visible to every campaign that references it; the Global badge is the warning surface. |
| D8 | Bare-name wiki-link resolution across scopes, fixed precedence **module-owned → campaign → global**; no cross-scope ambiguity warnings (fix-01 keeps working within each scope). |
| D9 | Persona runs may **target global artifacts** (`runs.campaignId` stays NOT NULL — the run is anchored where it started; the write lands on the global row). |
| D10 | **Battles anchor per module**: `battles` gains `moduleId`, "Run battle" lives in the module view, battle route moves under the module reader. The `session` artifact kind is **removed** along with the play view. |

## M6-A — Storage: the ownership fields (v10, additive only)

### Schema (`src/domain/artifact.ts`, one `db.version(10)`)

- `artifactBaseSchema` gains `moduleId: z.uuid().nullable().default(null)`.
  `campaignId` becomes `z.uuid().nullable()` **for the base schema only** —
  a `superRefine` on the union enforces the invariant:
  - `campaignId === null` (global) ⇒ `moduleId === null` AND kind ∈
    {npc, location, faction, encounter} (D6),
  - `moduleId !== null` ⇒ `campaignId !== null` (module artifacts are
    anchored in their home campaign).
- `artifactScope(artifact)`: derived helper returning
  `'global' | 'campaign' | 'module'`; the single source of truth for UI
  branching (D1).
- New repo functions: `listGlobalArtifacts()`, `listArtifactsByModule(moduleId)`,
  `getAnyArtifact(id)`. The write-path moves land with their UI increments —
  `moveToModule`/adopt-into-campaign in M6-B, `publishToLibrary`/adopt-from-
  library in M6-C — so no global row can exist before its writer and v10
  stays purely additive. (`listArtifactsByCampaign` already returns campaign-
  AND module-owned rows of the campaign — both carry its `campaignId`; the
  scope control filters client-side via `artifactScope`.)
- Dexie v10: artifacts gain indexes `moduleId`, `[moduleId+kind]`. Images
  are untouched here — `images.campaignId` nullability ships in M6-C together
  with the first global writer (D2 requires it: a published artifact's
  images must leave the old campaign's prune scope).
- **v10 upgrade**: backfill `moduleId: null` on every artifact row. No
  existing row is global (campaignId stays non-null), so no other change.

### Tests
- v9→v10 migration golden (existing rows keep id/kind/campaignId; new field
  present; every existing query result unchanged).
- `artifactScope` + invariant refines (global pc rejected; module without
  campaign rejected; global with moduleId rejected).
- Repo: publish → adopt round-trip; `listArtifactsByCampaign` excludes
  global rows; `[campaignId+kind]` behavior with global rows present.

## M6-B — Module designer ownership

- Stub popover, batch generation and forge regeneration write
  `moduleId: module.id` on every artifact they create (the `module:<title>`
  tag stays for backward compatibility but is no longer the ownership
  mechanism).
- Entity panel and reader search source module-owned artifacts via
  `listArtifactsByModule` (+ campaign fallback), not tag matching.
- **Module delete** (D3 ✅): confirm dialog offers **"Delete module and its
  N artifacts"** (cascade: artifacts + their revisions/images, counts shown)
  vs **"Keep the N artifacts (become campaign-owned)"** (default). Never
  silent (AGENTS rule 1).
- **Adopt into campaign**: per-artifact action in the entity panel / editor
  (clears `moduleId`, keeps id/images/revisions).
- **Move to module**: campaign-owned artifacts of the home campaign can be
  moved into a module of the same campaign (completes the state machine;
  same loud confirm).

### Tests
- Stub/batch produce `moduleId` rows; reader + panel resolve via the new
  query; tag no longer decides ownership.
- Delete-module both branches (cascade counts; keep → rows survive with
  `moduleId: null`).
- Adopt/move preserve ids, images, revisions.

## M6-C — Scope control + the global library

- **Scope control component** (one shared component, D3): three toggles
  (Global / Campaign / Module), persisted in `settings` (a genuine UI
  preference, not campaign data). Defaults: workspace tree = Campaign +
  Module on, Global off; **module view = all three on** (D4).
- **Tree**: the control sits in the tree header; global artifacts render in
  a dedicated "Library" group at the top, never mixed into campaign
  folders; module-owned artifacts appear inside their module's group.
- **Pickers** ("Link existing…", persona target, battlemap pickers): same
  component; authoring pickers default Campaign + Module.
- **Publish to library**: artifact menu action on the ✅ kinds only (D6) —
  loud confirm ("shared content — visible and editable from every
  campaign"), then `publishToLibrary` (images follow, D2). Editor shows a
  **Global** badge on global rows; the run panel repeats it when a run
  targets one (D7's warning surface).
- **Adopt from library**: on a global artifact — moves it into a chosen
  campaign with a confirm listing the campaigns currently referencing it
  (references in other campaigns will resolve as unresolved chips).
- **Battle stat lookup** (`buildFighterStatsLookup`): order becomes
  campaign → module-owned → global → `seedFighters`. Token HP semantics
  unchanged (NPC HP is token-owned; only campaign-scoped PCs get
  `ownedBy: 'artifact'`).
- **Quick-find**: artifact group follows the scope control; global hits are
  labeled "Library".

### Tests
- Scope control toggling changes tree/picker/quick-find results (live-query
  behavior).
- Publish/adopt flows: kind whitelist enforced, images follow, badge
  renders, reference-listing confirm.
- Battle lookup resolves a global monster; its tokens stay token-owned.

## M6-D — Cross-scope runs, images, deliverables

- **Runs** (D9): run targeting accepts global artifacts; engine writes land
  on the global row; `runs.campaignId` keeps anchoring the run to where it
  was started. Step outputs reference the global target by id.
- **Images**: `images.campaignId` becomes nullable (second small schema
  note in v10's block is NOT used — images nullability ships in M6-D as
  **v11-prep within M6-D's own `db.version(11)`**, or folds into M6-E's
  v11 if E starts first — exact version assignment decided at
  implementation time, one breaking concern per version). Global artifacts
  carry their images; `pruneUnreferencedImages` gains a global pass tied to
  artifact deletion (D2: images follow their artifact's lifecycle).
- **Deliverables / module PDFs**: module-owned artifacts included; global
  artifacts only when explicitly added to the outline.
- **Retrieval context**: persona context building may read global artifacts
  (read-only) when the scope control includes them.

### Tests
- Run targeting a global artifact completes and writes the global row;
  another campaign's view of the same artifact reflects the edit (D7).
- Global images survive campaign-scoped prunes; deleting the global
  artifact removes its images.
- Deliverable outlines accept globals only explicitly.

## M6-E — Play retirement (module-anchored battles, session removal, v11)

The module view is the play view (D4/D10). This increment removes the old
play mechanic and re-anchors battles:

- **Battle anchoring**: `battleSchema` swaps `sessionId` → `moduleId`;
  `ensureBattle(campaignId, moduleId)`; `battles` index becomes
  `'id, campaignId, moduleId'`; route `/c/:campaignId/m/:moduleId/battle`;
  `battlePath(moduleId)`. "Run battle" and "Show battle" move into the
  module view (entity panel / encounter cards inside the module reader);
  `seedBattleFromEncounter(campaignId, moduleId, encounterArtifactId)`.
- **v11 upgrade (breaking, loud)**:
  - `battles` rows are **cleared** — they are live play state, not authored
    content (authored artifacts/images/modules untouched); "Run battle"
    re-seeds from the encounter in one click. Documented here and in the
    upgrade; no fake re-anchoring of session-bound rows.
  - **`session` artifacts are deleted** (the kind's quick-log and prep data
    belonged to the retired play view). The upgrade records the deleted
    count in `settings`; the app shows a one-time info toast ("N session
    notes from the retired play view were removed") — loud, never silent.
  - Session artifacts referenced elsewhere (none known: battles held the
    only structural reference) are scrubbed by the existing
    `deleteArtifact` pathways.
- **Removals**: `/c/:campaignId/play` route + `PlayPage.tsx` (focus rail,
  context grid, scenes, quick log), TopBar "▶ Play" button, `playStore`
  (focus, focusHistory, activeSessionId, railCollapsed), `play-page.test.tsx`;
  quick-find "Enter sets focus" becomes plain navigation.
- **`session` kind removal**: `ARTIFACT_KINDS`, `sessionDataSchema`,
  `DEFAULT_ARTIFACT_NAMES`/group labels, editor `kind-forms` branch,
  `modulePdf.ts` session branch, fixtures and tests. Battle tests re-written
  against module anchoring.

### Tests
- v10→v11 migration: battles cleared, session artifacts deleted with count
  recorded, all other artifacts intact.
- "Run battle" from the module view seeds a module-anchored battle; the
  table surface opens at `/c/:campaignId/m/:moduleId/battle`; PC current HP
  still persists on the pc artifact across battles.
- Route sweep and 404 checks updated; no `playStore` references remain.

## M6-F — Docs

- `01-DATA-MODEL.md`: ownership fields, invariant refines, v10/v11,
  images nullability.
- `05-UI.md`: scope control, Library group, module view as the play view,
  battle route move, global badge; play screen section removed.
- `08-TESTING.md`: matrix rows for ownership, scope control, retirement.
- `00-OVERVIEW.md`: doc index + global-conventions note ("module view is
  the play view").
- This document becomes the binding spec of record.

## Build order

A (storage, additive v10) → B (module ownership) → C (scope control +
library) → D (cross-scope runs/images) → E (play retirement + v11) → F
(docs). One logical task per commit; `pnpm lint && pnpm typecheck &&
pnpm test` before every commit; push to `origin/main`.

## Acceptance criteria

- A monster published to the library appears in a **different** campaign's
  tree (Library group on), resolves by bare name from that campaign's and
  any module's text, and can be run in a battle there — with **independent
  token HP per battle** and no copy of the artifact ever created.
- Editing the global monster's statblock in campaign A is immediately
  visible in campaign B (same row); the Global badge marks it everywhere.
- Module view shows all three scopes by default; toggling Global off hides
  library rows everywhere the control applies; the preference survives a
  reload.
- Deleting a module asks, with counts: cascade removes its artifacts; keep
  demotes them to campaign-owned with ids/images intact.
- A global `pc` (and any global `session`/`plotarc`) is **impossible to
  store** — refine rejects it; the publish flow never offers those kinds.
- No `/play` route, no `playStore`, no `session` kind in the schema or UI;
  battles anchor to modules; a one-time toast reports removed session
  notes after the v11 upgrade.
- `pnpm lint && pnpm typecheck && pnpm test` passes with migration goldens
  for v9→v10 and v10→v11.

## Non-goals (unless reopened)

- Per-user ownership (local/single-user app).
- Any duplication/copy of artifacts between scopes (D7 — import/export may
  revisit later, including pregen PC sharing from D6).
- Sharing by reference between two campaigns without going global.
- Transfer of personas/deliverables across scopes.
