# 18 — Architecture: the code map and the seam index

This is the layer between `AGENTS.md` (binding rules) and the feature specs
(docs/04/05/07/08/11/12/13/14/15/16/17): the high-level map of how the code is
organized and — for everything that has needed doing more than once — THE one
way to do it. Before writing a repo function, a queue, a toast path or a
schema conversion, check §2; a seam already exists for it.

Pointers are **file + exported symbol** — never trust a remembered line
number; grep the symbol.

## 0. Standing order (how this doc stays fresh)

- **Every arc that adds or changes a seam** (a new "one way", a convention, a
  gotcha, a known-debt entry) **amends this doc in the same docs commit as its
  feature spec** — the standing order lives in AGENTS.md §Workflow. A seam
  that changed without amending this doc is treated as missing.
- When you find code that diverges from a seam below: either fix it toward
  the seam, or add one line to §5 — never document the divergence as the way.
- Keep entries to 1–3 lines + pointer. This is a seam index, not a subroutine
  catalog; feature specs own the details — point, never duplicate.

## 1. Layer map (dependency direction)

Dependencies point downward only: `app → features → {db, llm, search, ingest,
lib} → domain`. Nothing imports upward — no repo imports a feature (the one
exception is `moduleRepo.deleteModule`'s dynamic `import('@/llm/moduleGen')`,
sanctioned only because a static import would be a cycle).

- **`src/domain`** — pure TS + zod: every entity type, schema and pure
  algorithm (battle engine in `battle/`, encounter layout in `encounterMap/`,
  `wikiGraph`, `encounterResolve`). **No IO, no React.** Cross-module data
  shapes come ONLY from here (00-OVERVIEW); the barrel is `domain/index.ts`.
- **`src/db`** — the ONLY IndexedDB access: `db.ts` (Dexie versions, one
  additive version per schema change) plus one repo module per table.
  Parse-on-read, one-rw-transaction writes, transactional cascades (§3).
  Components import through the barrel `db/index.ts`.
- **`src/llm`** — everything that talks to OpenRouter: `openrouter.ts` (chat,
  streaming, strict structured outputs, refusals), `strictSchema.ts` (zod →
  strict JSON schema), `jsonReply.ts` (reply parsing), `runEngine.ts` (persona
  run pipelines), `chainRunner.ts` (Writers'-Room multi-persona chains),
  `moduleGen.ts` (module forge spine→parts + entity name normalization),
  `modelFallback.ts` (escalation chains), the encounter/roster/items and
  image clients, `campaignGrounding.ts` (docs/15), `treasureGuidance.ts`.
  Persists exclusively through `db` repos.
- **`src/search`** — MiniSearch keyword index, OpenRouter embeddings, hybrid
  `searchRules` (docs/03). Rebuilt from Dexie; invalidation is coupled to
  chunk writes (§2.1).
- **`src/ingest`** — the PDF → chunks pipeline (`buildLines`, `chunker`,
  `statblock`, `ingestFiles`, `pipeline`, pdfjs in `workers/ingest.worker.ts`;
  docs/02-INGESTION) and the bestiary/item pack system (`packs/` adapters +
  `registry`, `packImport`, `packFetch` — the app's ONLY networked import
  surface; docs/12, docs/16).
- **`src/features/*`** — screens and feature logic, one folder per area
  (campaign, modules, play/battle, rules, settings, deliverables, bestiary,
  images, quickfind, onboarding, guide, dice, progress). DB-derived UI state =
  `useLiveQuery` hooks in the feature's `hooks.ts`; session/UI state = small
  zustand stores (§3). Run orchestration lives here too: `entity-batch.ts`,
  `post-run-extras.ts`, the three job queues.
- **`src/components`** — shadcn/ui primitives (`ui/`) + shared presentational
  components. They reach repos via the barrel; they never import `dexie` or
  open scopes.
- **`src/lib`** — cross-cutting helpers, each with its seam below: `toast`,
  `progress`, `jobQueue`, `wikilinks`, `remark-wikilinks`, `markdown`,
  `imageIntake`, `pdfRuntime`, `backup`, `exportImport`, the PDF export chain
  (`pdfExport`, `mdToPdfmake`, `modulePdf`), `persisted`, `parallel`,
  `errors`, `debug`, `globalErrors`.
- **`src/app`** — shell: `router.tsx`, `routes.ts` (single route source),
  layout, `GlobalErrorBoundary`, theme, uiScale. `src/help` is the help
  dialog content store.

## 2. The seam index

Format: **to do X → use Y (file)** — never the anti-pattern in the last
column.

### 2.1 Data access (`src/db`)

| To do X | Use Y | NOT Z |
|---|---|---|
| Read/write artifacts | `artifactRepo` — every read zod-parses the row | importing `db` and querying `db.artifacts` raw |
| Change an artifact's scope (move / adopt / publish) | `moveToModule` / `adoptIntoCampaign` / `publishToLibrary` — all funnel through the private `moveScope`, one tx incl. image re-anchor | a patch carrying `campaignId`/`moduleId` — `updateArtifact` pins scope fields |
| Promote an artifact on second-module use (link / roster / battle) | `db/artifactAutoPromote` — `promoteSecondModuleUses` (post-save text scans), `promoteRosterUses` (roster/seed/spawn hooks), `promoteArtifactForModuleUse[Loud]` (single-artifact) — every path funnels through `adoptIntoCampaign` → `moveScope` (no separate core state); the surface is a batched `toastSuccess` notice, never run-issue escalation | hooking render (`wiki-markdown` resolution stays pure); a second scope writer; silent promotion |
| Give a generated artifact module ownership | `artifactRepo.stampModuleOwnership` (loud existence check inside the tx) | `updateArtifact` with `moduleId` |
| Attach images (store + reference + re-anchor + prune + optional content patch) | `artifactRepo.attachImagesToArtifact` — one rw tx over images+artifacts+revisions+battles (battles rides the scope because the post-attach prune refchecks frozen boards — a read on an undeclared table throws); blobs are byte-prepared (`buildStoredImage`) BEFORE it opens; the optional `data` + `meta` patch lets a content write that must land with the attach (map-regenerate's layout/mapImageId/preset/siteShape/budgetAdvisory) commit atomically instead of a second `updateArtifact` write; the optional `removeImageIds` swaps gallery ids out in the same tx (single-map-slot replace, docs/11 D16) | `createImage` then `updateArtifact` as separate writes |
| Create / edit / restore content | `createArtifact` / `updateArtifact` / `restoreRevision` (restore is content-only, scope pinned) | hand-writing revision rows (`writeRevision` is private) |
| Write rule chunks | `chunkRepo.writeChunks` (`putChunks` alias) — invalidates the keyword index with the write | `db.chunks.bulkPut` anywhere else; backup restore MUST route through this door |
| Get/create the live battle for a module | `battleRepo.ensureBattle` — the v16 unique `&moduleId` index is the arbiter | get-then-create across two transactions |
| Mob artifact per cited monster chunk | `mobArtifacts.getOrCreateMobArtifact` / `spawnMobArtifactIntoModule` — a second-module spawn PROMOTES the artifact (shared campaign level) instead of moving it away from the first module | scan-then-`createArtifact` in separate txs (splits token identity); moving a placed mob artifact to another module |
| On-demand npc artifact per UNCITED roster entry (inline/none) | `mobArtifacts.materializeInventedCreatureArtifact` (roster name + notes/treasure appearance + inline block-or-null + encounter summary marker; `moduleId` = encounter's when module-owned else campaign-level; roster entry NOT rewritten so seeds stay identical) + `features/campaign/mob-portrait-queue.enqueueInventedCreaturePortraits` (chunk-less local-only jobs — invented covers never read/populate/overwrite the global cache) | a new kind or a `monsterChunkId` marker on a chunk-less row; rewriting the entry to npc-ref (changes seed identity) |
| Global mob portrait per cited chunk (canonical only, all campaigns) | `db/mobPortraitCache` (firewall `cacheKeyForMonsterSource`, read-through `fillCoverFromCache`, render `cloneCachedPortraitToArtifact`, publish `storeCanonicalPortraitIfAbsent`) + `features/campaign/mob-portrait-cache-queue.ensureCanonicalMobPortrait` (cross-campaign single-flight; Dexie v18 `mobPortraits` table `id, &chunkId`; docs/11 D5 amendment) | generating per campaign; attaching the shared global row as a cover; a flavored citation writing the cache |
| Read / patch settings | `getSettings` (write-creates defaults) / `readSettings` (pure — liveQuery-safe) / `updateSettings` (tx, schema-validated merge; existing rows merge over defaults) | raw `db.settings` reads without the defaults-merge parse |
| Show an image | `useImageUrl` (`features/images/use-image-url.ts`) — object URLs revoked on change/unmount | `URL.createObjectURL` without revoke |
| Bring an image INTO the app (upload or generated blob) | `imageIntake.intakeImage` — EXIF-safe decode, ≤1600px long edge, WebP re-encode | ad-hoc canvas/FileReader scaling |
| Store map candidates mid-run | `imageRepo.createImage` per candidate — deliberately UNATTACHED until the pick step attaches via the seam; top-level use only (inside a tx: `buildStoredImage` before it opens, `db.images.put` inside) | attaching candidates eagerly |
| Delete a module / campaign / artifact | `moduleRepo.deleteModule` ('cascade' \| 'keep' \| 'promote-referenced') / `campaignRepo.deleteCampaign` / `artifactRepo.deleteArtifact` — 'promote-referenced' adopts outside-referenced rows (fresh `modulesReferencingOwnedArtifacts` scan: wiki-graph edges + roster + battle tokens) BEFORE the tx, then cascades the rest; the list dialog shows the third state with the referenced names | ad-hoc cascades — these are transactional, recount-honest (rows re-listed inside the tx), scrub battles/links/images |
| Remove all generated content (fresh generation start, Party kept) | `campaignRepo.removeAllGeneratedContent` — ONE tx over every touched table, rows re-listed inside; per-row disposal rides nested `deleteArtifact` (subset scope, joins the tx), battles/modules/runs/deliverables go by campaign sweep, orphans prune via `pruneUnreferencedImages` (campaign rows only — library images structurally immune); in-flight module passes abort BEFORE the tx (native-promise import must never gap a Dexie scope) | per-module `deleteModule` calls outside a shared tx (no cross-call rollback); a second wipe implementation anywhere else |
| Backup / export / import | `lib/backup.ts` (whole-DB restore rides `db.transaction('rw', db.tables)` + the chunk door) / `lib/exportImport.ts` (campaign export v2: modules/battles/runs/deliverables + `dependencies` manifest; import = ONE tx over the eight tables, array form, with module/artifact re-id maps rewriting every reference) | table-by-table writes that can strand a half-import |
| Describe what an export cites but does not carry (rulebook chunks, library NPCs) | `collectDependencies` (`domain/exportDependencies.ts` — pure, `DependencyLibrary` maps injected; `buildCampaignExport` does the bulk Dexie reads) + the L0(contentHash)/L1(system+title+creature)/L2(chunkId) identity contract (docs/07 M3-E); missing image blobs land on `missingImages` with referrers named, never silently dropped | re-resolving rulebooks at read sites; a second citation-identity scheme |
| Check an export's rulebook deps BEFORE importing it | `analyzeDependencies` (same file — pure, `chunksByHash` pool + `books` injected; `checkImportDependencies` in `lib/exportImport.ts` does the Dexie reads: one `contentHash.anyOf` probe + same-system book chunks) → `importExport`/`importZip` default-abort via `MissingDependenciesError` BEFORE the tx opens (nothing to roll back); rulebook chunkIds are KEPT as-is so `missing ref` markers stay truthful; the AppShell `MissingRefsBanner` derives from the same `resolveMonsterEntry` contract (banner and badges clear together) | an ad-hoc hash compare inside the import tx; healing chunkIds to local rows; a toast-only surface |


### 2.2 LLM (`src/llm`)

| To do X | Use Y | NOT Z |
|---|---|---|
| One JSON-contract chat call | `openrouter.chat` with `responseFormat: schemaResponseFormat(zodSchema)` (`strictSchema.ts`) | hand-written `response_format`; the ONLY downgrade to `'json'` is the Settings `strictOutputs` toggle (default ON) — never automatic |
| zod → JSON Schema | `strictSchema.strictJsonSchema` / `schemaResponseFormat` — read the strict-subset header first | a private converter |
| Parse a model reply | `jsonReply.parseJsonReply` + the contract's zod `parse`; failure fails the run / pauses for review (AGENTS 3) | catch-and-continue around parsing |
| Model escalation / refusals | `modelFallback.walkModelChain` — UNCONDITIONAL escalation (owner 2026-09-07: "ANY ERROR, ANY AT ALL should lead to the fallback"): every error advances to the next chain entry, the chain is the bound, exhaustion throws the combined `chainError`; only `MissingApiKeyError` and user aborts stop the walk. `failureKind`/`fallbackReasonFor`/`FILTER_PATTERN` classify for the Details view and notice wording — annotation only, never a gate | ad-hoc retry loops; silent model swaps; gating escalation on the failure class again |
| Classify a failed run for the owner | `failureKind.failureKindOf(error)` (`llm/failureKind.ts` — structural over the typed error classes) + the `domain/run` `FAILURE_KIND_LABELS`/`FAILURE_KIND_GUIDANCE` maps; every fail site writes the kind next to the verbatim `errorMessage` (docs/05, ledger 35) | prose-matching the raw message; replacing or truncating the message with the kind |
| Wait for a run | `runEngine.waitForRunStatus` (one primitive; `includePaused` for chain steps) | private poll loops; `TERMINAL_RUN_STATUSES` is the only terminal-status list |
| Cancel all in-flight runs | `runEngine.cancelAllActive()` — the engine's controller registry is the authoritative in-flight set (rows → resumable 'cancelled'; paused runs are not stoppable work) | querying `db.runs` for 'running' rows; ad-hoc cancel sweeps |
| Persona run pipelines | `runEngine` step plans per mode (`domain/persona.mode` = generate/review/image/encounter): `retrieve→draft→statblock→finalize`, `gather→check→finalize`, `prompt-draft→generate→pick` (pick ALWAYS pauses), `brief→layout→schematic→stylize→pick→finalize` (pick ALWAYS pauses; NO verify step — D14, the user is the judge and Regenerate candidates is the correction) | a bespoke pipeline for a shape that fits an existing plan |
| Image generation | `imageGen.generateImages` — UNCONDITIONAL model-chain escalation on ANY error (typed OpenRouter error envelopes classify structurally); `cappedToOne`/`fallback`/`filteredCount` surface as user-visible step notices; a single-entry chain's failure names the missing fallback config | raw image API calls elsewhere |
| Monster stat lookups | `monsterResolve.resolveMonsterEntryWithRepos`; fighter shapes via `db/fighterStats.ts` (`fighterStatsFromArtifact`, `buildFighterStatsLookup`) | re-parsing `statBlock` ad hoc |
| Monster level → sort key | `encounterRoster.parseLevelSort` | a second level parser |
| Bestiary/item pack data | `ingest/packFetch` (only networked surface; newest-first with pinned-verified-ref fallback) → `packImport` → `packs/registry` adapters | fetching upstream files anywhere else; adapters stay network-free (test-pinned) |
| PF2e rules text (journal pages, conditions, feats/spells/actions corpus) | the same pack lane, third entry type: rules-text fetch sources (`packFetch`, `packDirs`-scoped) → `packImport` `sections` → `packs/pf2e-journal` / `pf2e-conditions` / `pf2e-rules` adapters → `section` chunks with per-entry Source lines | HTML scraping (there is none — the machine-readable packs are the one way; docs/12 §15); a second retrieval path — `encounterRoster` skips `section` chunks like `item` chunks |
| Background job pump (portraits, entity images, maps) | `lib/jobQueue.createJobQueue` — inherits dedupe, cancellation, failed-list + retry, dock counters | a hand-rolled worker loop |
| Entity generation (batch AND single stub) | `features/modules/entity-batch.runEntityBatch` (the stub popover delegates a 1-target batch via `entity-detail.generateSingleEntity`) | a second "detail one entity" implementation (`chainRunner` is for Writers'-Room chains, not this) |
| Module generation | `moduleGen.runSpine` / `runParts` / `approveSpineAndRun`; entity name normalization via `normalizeModuleEntityNames` (one LLM call, never heuristics — fix-01) | heuristic name rewriting |
| Recognize a module-forge stop | `moduleGen.isCancel(error, signal)` — the run controller's `signal.aborted` is the source of truth, never the error's type (the streaming pipeline can surface a stop as a cross-realm AbortError, a wrapped transport error, or no error at all); every cancel-vs-failure catch reads it, plus a fail-fast guard at the top of the parts loop so a stop between calls never starts the next part | `instanceof DOMException && name === 'AbortError'` alone (fails cross-realm: probed CTOR DOMException + name AbortError with instanceof false) |
| Treasure clauses in prompts | `treasureGuidanceFor` / `roomKeyGuidanceFor` (`treasureGuidance.ts`) | quoting DMG tables or paraphrasing Paizo numbers (licensing — docs/12 §13.2/§14) |
| Per-room challenge budgets | `roomBudget.ts` (`checkRoomBudget`, `reconcileRoomAssignments`, `roomBudgetGuidanceFor`, `parseBudgetLevel` over `encounterRoster.parseLevelSort`) — the asymmetric loop: too easy ships, too hard lowers a step through the brief's single repair turn, then LOUD advisory on step output + `data.budgetAdvisory` | a second level parser; numeric pf2e budgets (Paizo licensing — docs/11 D12) |
| Encounter site shape / play path | `domain/artifact.normalizeEncounterShapeData` (ONE derivation: parse-on-read + v17 backfill + backup validation) + `domain/encounterMap/schema` (`encounterSiteShapeSchema`, `spawnFirstPath`, layout `path` refine) | deriving siteShape from room count at read sites; trusting the rooms-array order as play order (packAttempt rotates it) |
| Legacy persona values (removed kinds) | `domain/persona.normalizeLegacyProducesKind` (ONE `z.preprocess`: parse boundary + `updatePersona` + backup restore heal the stored row — git-proven mapping table, unknown values still fail loudly) | a catch-all kind fallback; hand-editing or deleting the poisoned row |
| Legacy run rows carrying a REMOVED step | `domain/run.normalizeLegacyRunSteps` (ONE `z.preprocess` inside `personaRunSchema`: drops the deleted encounter `verify` step and re-indexes, so reads/updates heal the row and every engine continuation stays index-coherent) | executing the engine plan positionally over a shifted steps array |
| Campaign grounding for runs | `campaignGrounding.computeCampaignGrounding` + renderer (docs/15) | a second wiki-expansion implementation |
| Refill an existing artifact in place (smith kinds: pc/npc/location/event/faction/note/plotarc) | the editor's `ContentAiSection` → `contentRefillRequest` store → the persona panel's targeted generate run; grounding parity via `runEngine.targetModuleGrounding` (module document + premise rendered from the STORED retrieve output; every inapplicable state names itself) + `mergeRefillData` (preserves PC human-owned fields, curated stat blocks, the mob marker; model name → alias) | a second "detail one entity" implementation; a patch touching `moduleId`; a silent degrade |
| `event` kind mirrors `location` everywhere (social/non-combat content: GM text + showable image) | aliases, not copies — `eventDataSchema = locationDataSchema`, `eventDraftSchema = locationDraftSchema`; shared engine cases (`draftContractFor`/`dataForDraft`), shared `LocationForm`, own persona slug (`event-weaver`, never `worldbuilder`) + `REFILL_PERSONA_SLUGS` entry; EXCLUDED from battleSeed map-linking (location-only map role) and encounter/npc/statblock paths | an event-specific field (the alias would drift); mapping event onto the worldbuilder slug |
| Reject empty generation output | `substanceText` in `llm/schemas.ts` (name/summary/body ≥ 1 non-whitespace char on every draft contract; the strict schema can't express it — the zod parse rides the ONE repair turn, then loud) + the finalize re-guard (`runFinalize`: empty body refuses to create or overwrite — a refill keeps the existing content) | a prose-length floor (over-rejects short notes); a silent placeholder |
| Reject half-formed unicode escapes in generated text | `lib/encodingHygiene.findEscapeDebris` (pure: `?` + exactly 2 lowercase hex forming a non-ASCII tail, plus literal `\uXXXX` in decoded text) + `debrisIssuesForFields`/`collectTextLeaves` at the boundaries — `runEngine.runFinalize` scans the draft + statblock strings BEFORE any create/updateArtifact (hit → loud `rejected` with the debris named, nothing persists), `moduleGen.generatePart` scans normalized part prose before the ready write (hit → part `failed` with the debris named, chain continues). Detection backstop for the `language.ts` UTF-8 contract (prevention) | silent repair-and-continue; persisting debris as ready content; a second scanner implementation |

### 2.3 App & UI

| To do X | Use Y | NOT Z |
|---|---|---|
| Build a route path | `app/routes.ts`: `ROUTES` patterns + the `*Path()` builders | hand-writing `/c/...` strings |
| Surface an error | `lib/toast.ts` (`toastError`/`toastErrorPersistent`), a failed run row with `errorMessage`, or the global boundary (`app/GlobalErrorBoundary` + `lib/globalErrors.installGlobalErrorHandlers`) | `console.error` only (AGENTS 2) |
| Long-running progress | `lib/progress.useProgressStore` + the app-wide `<ProgressDock/>`; queue jobs report via `dockGroup` | a disabled button or a "Generating…" label (00-OVERVIEW, binding) |
| Wiki-link handling | `lib/wikilinks.ts` (extract/strip/rewrite/resolve/count; `WIKI_LINK_PATTERN`) + `lib/remark-wikilinks.ts` → `WikiMarkdown` | a private `\[\[...\]\]` regex |
| Hand-edit module part text (find/replace) | `features/modules/part-text-editor.PartTextEditor` (toolbar over the `editDraft` string; pure `findDraftMatches`/`replaceDraftMatch`/`replaceAllDraftMatches`, same non-overlapping loop semantics as `reader-search.findMatches`) committing through `savePartEdit` → `patchModuleTextPart` (module-row `parts` write, `edited: true` + toast + auto-promote; arms the rewrite overwrite confirm) | artifact revisions for part markdown (there are none — parts live on the module row); a second save path around `savePartEdit` |
| Markdown → plain text | `lib/markdown.markdownToText` | a second strip-regex |
| PDF viewing | `lib/pdfRuntime.openPdfDocument` + `copyBytes` (worker-safe byte copies); retained book bytes via `pdfRepo` (`&bookId` unique) | re-parsing PDFs from user files |
| Encounter preset resolution | `domain/encounterMap/schema.resolveEncounterPreset(preset, locationKind)` | branching on `locationKind` directly |
| Cover monster spawn areas with fog at battle seed | `domain/encounterMap/layout.veilsFromSpawnClusters(layout, rosterCounts)` — ONE fog veil per `monsterIndexes` group (owner order; minimal cell box of the group's `placeMonsters` cells), no spawn-room exemption; the room's first group keeps `id = room.id` (the Path rail resolves rooms through `veil.id` — never re-id veils per room) and every group veil carries `roomId` (`battleVeilSchema`, additive/optional) | one veil per room for new seeds (`veilsFromRooms` is the legacy helper); duplicate `veil.id`s per room (breaks the rail lookup + React keys); "Reveal next room" lifting secondary group veils (surface-owned behavior — reveal lifts the primary, the GM lifts extras by hand) |
| Resize an effect marker from an edge handle | `resizeEffectFromEdge` (`domain/battle/effect.ts` — SYMMETRIC center-fixed: every n/s/e/w handle grows the same `sizeCells` span, cell-quantized via `veilSpanNorm`, min `EFFECT_MIN_CELLS`); the surface previews the size locally with zero writes and commits exactly once per gesture end (a tap / return-to-start / cancel commits nothing; the rail Grow/Shrink buttons own discrete steps) | the veil's opposite-edge-pinned `resizeVeilFromEdge` (different shape contract — veils carry w×h spans, effects one span); a second cell quantizer around it |
| Graph page derivation | `domain/wikiGraph.ts` (pure; docs/13/14/15) | graph logic in components |
| Bounded parallelism | `lib/parallel.mapWithConcurrency` | unguarded `Promise.all` over unbounded arrays |
| Encounter map automation | `useEncounterMapQueue` + the guards `encounterNeedsMap` / `isEncounterMapPending` (serial by contract) | re-enqueueing an already-mapped encounter; a second queue implementation |
| Post-run automation | `features/campaign/post-run-extras.ts` — rides the queues AFTER a completed run | reopening/failing a finished run row |
| Dev logging | `lib/debug.debugLog` | bare `console.log` (lint) or `console.error` as an error surface |
| Stop every running generation | `features/progress/stopAllGenerations` + the dock's Stop all button (queues' `cancelAll`, `runEngine.cancelAllActive`, `cancelModuleGen`, `chainRunner.cancel` composed there — the ONE sweep; non-destructive, rows stay resumable) | a second stop path or per-surface ad-hoc cancel wiring |
| Persisted UI state | zustand store + `lib/persisted.zodPersistStorage(schema)` | localStorage by hand |
| Scale the UI app-wide | `app/theme/uiScale.useUiScaleSync` (mounted once in AppShell next to `useThemeSync`) + the uiScale store — `--ui-scale` var × root font-size (index.css); persisted via `zodPersistStorage` (the Persisted UI state seam) and kept through Delete-all-data in `db/maintenance.PRESERVED_KEYS` like the theme | CSS zoom (breaks the px-measured board/pointer/dice/PDF math); a settings-row field (device display preference — theme precedent, stays out of the data DB and backups) |

## 3. Cross-cutting conventions (pointers, not restatements)

- **Parse-on-read** (docs/01 §Repository layer): every repo read zod-parses
  the row — `parseArtifactRow` / `parseBattleRow` / `parseRunRow` are the
  template. Legacy rows get schema defaults materialized; corrupt rows fail
  loudly. New fields ride schema defaults, not migrations; a migration is
  reserved for REAL schema changes (one Dexie version in `db.ts`, e.g. v16's
  unique `&moduleId`).
- **One rw transaction per logical write**: multi-table writes declare all
  tables in ONE `db.transaction`; nested writes must be a table SUBSET of the
  outer tx (e.g. `createArtifact` joins `mobArtifacts`'s get-or-create).
  Cascading deletes re-list rows INSIDE the tx (count honesty).
- **Loud existence checks at ownership boundaries**: writers that reference
  another row (`stampModuleOwnership`, run-finalize placement) verify the
  target exists inside the tx and throw. A module deleted mid-run fails the
  run; kept artifacts of a deleted module surface as an explicit "Orphaned"
  tree group with one-click re-anchor (via `moveScope`) — never silently
  re-anchored.
- **Scope transitions are explicit functions only** (`moveScope` family);
  content patches pin scope fields; revision restore restores content-only.
- **Second-module use auto-promotes, loudly** (10 D12): module-owned rows stay put until
  another module references them — then they promote to campaign level through the same
  family (no separate core state). The notice is a batched `toastSuccess` naming the
  using module; a failed promote toasts loudly and never leaves a half-moved row
  (`moveScope` is one tx). The delete dialog's third state is the same rule at delete
  time: promote-and-keep the referenced rows vs force-delete.
- **Error surfaces** (AGENTS 2): toast / run `errorMessage` / boundary.
  Queue failures toast per artifact and land on a retryable failed list.
- **Strict contracts** (docs/04 §Strict structured outputs): contract-shaped
  calls send zod→strict-schema (`strictSchema.ts`); the zod parse still
  guards every reply; the escalation chain retries EVERY failure on the
  next model — refusals included — and fails loudly with the combined
  end-of-chain error when no fallback is configured or the chain exhausts
  (classification annotates, it does not gate).
- **Test hygiene** (docs/08 — read before touching tests): the
  console-hygiene guard (`tests/setup.ts`) fails any test that logs
  `console.error`/`warn` outside `ALLOWED_NOISE`; entries need file scope +
  a concrete `why`. act() warnings are never allowlisted — zero act-timing
  entries exist (the two legacy `persona-run-ui`/`onboarding-wizard` ones
  were root-fixed and removed; `actDrained` is the standing cure, including
  under open Base UI dialogs whose transition rAF/unmount timers ride the
  same queue). Leak prevention: `tests/helpers/flush.ts` — `actDrained`
  wraps raw awaited steps that sit between act-wrapped ones;
  `flushAsyncUpdates` drains cascades before unwrapped reads and at test
  end. **Caveat:** never wrap paired `fireEvent` pointer
  sequences (down→up) in ONE spanning act — each `fireEvent` must flush its
  own render or the gesture pairing strands (the battle-surface
  selection-card class). New routes/shell elements extend
  `tests/app/ui-smoke.test.tsx`.
- **State split**: DB-derived state = `useLiveQuery` hooks in the feature's
  `hooks.ts` (pure `readSettings()` inside live queries, never
  `getSettings()` — it writes). Session/UI state = small zustand stores
  (`quickfind`, `pin`, `onboarding`, `help`, `progress`, the job queues).
- **Parallel writers** (AGENTS §Parallel writers): read-only agents always
  run in parallel; writers need the file-disjointness + gate-budget check,
  `git pull --rebase` before every push, and the re-verify duty.
- **Terminology** (00-OVERVIEW, binding for user-facing copy): wiki-link,
  mention, relation (never "links"), alias, phantom.

## 4. Gotchas

- **Dexie variadic cap.** `db.transaction(mode, t1…t5, scope)` caps at five
  tables (the scope function must be the last argument); more tables → the
  ARRAY form (`deleteModule` passes six tables as an array; `attachImagesToArtifact`,
  `moveScope`, `exportImport` likewise). Tests that pin transaction shape
  reassign `db.transaction` (bind the original) — `vi.spyOn(db,
  'transaction')` is not reliable on the Dexie instance, and WhereClause
  objects are Proxy-wrapped (spying `.first()` resolves undefined); the
  working wrapper pattern is in `tests/db/mobArtifacts.test.ts`.
- **Unique-index get-or-create.** Concurrent get-or-create converges by
  catching `ConstraintError` — match by error NAME, fake-indexeddb's
  DOMException shares it — and re-reading the winner
  (`battleRepo.ensureBattle`, v16 `&moduleId`). Alternatively serialize
  scan+create in ONE tx (`mobArtifacts.getOrCreateMobArtifact`).
- **fake-indexeddb timing.** Live queries re-fire on its timed queue; any raw
  `await` while a tree is mounted can emit a state update outside act —
  that is exactly what `actDrained`/`flushAsyncUpdates` absorb (docs/08
  §jsdom notes).
- **TS strict extras**: `exactOptionalPropertyTypes` (optional ≠ `|
  undefined` — signatures write `field?: X | undefined` deliberately; omit
  the key instead of passing `undefined`) and `noUncheckedIndexedAccess`
  (indexing yields `T | undefined`). Both shape the LLM schemas'
  "absentable" convention (optional+null → parsed back to `undefined`).
- **zod v4 → strict JSON schema subset** (`strictSchema.ts` header — read
  before authoring a contract): `.default()` fields come out REQUIRED;
  `.optional()` is re-emitted required+nullable; free-form `z.record()`
  properties are DROPPED (StatBlock `extras` never comes from the LLM);
  constraint keywords are stripped (zod still enforces them at the boundary);
  recursive schemas throw `StrictSchemaError` — loud, by design.
- **No native promises inside a transaction scope** (`createImage`'s
  `blob.arrayBuffer()` broke the attach seam): awaiting a non-Dexie promise
  (`Blob.arrayBuffer()`, `createImageBitmap`, `canvas.toBlob`, FileReader,
  fetch) inside a `db.transaction` scope breaks Dexie's PSD zone — the tx
  auto-commits at that gap and later writes land outside it ("Transaction
  committed too early", http://bit.ly/2kdckMn). Decode/encode/byte
  preparation happens BEFORE the tx opens; the scope holds Dexie operations
  only. Inside a caller's tx, `imageRepo.buildStoredImage` prepares the row
  first and `db.images.put` persists it (`attachImagesToArtifact` is the
  template; regression-pinned in `tests/db/artifactRepo.test.ts`).
- **pdfjs under vitest** warns about `standardFontDataUrl` (allowlisted; text
  extraction does not use fonts). jsdom lacks ResizeObserver /
  `scrollIntoView` / Web Animations — stubbed in `tests/setup.ts`.
- **Module part bodies live on the MODULE ROW, not in artifacts.**
  `Module.parts[i].markdown` is the only copy — there is no `updateArtifact`
  revision for part text, so hand edits persist via `patchModule` on the
  module row (`patchModuleTextPart`: `status: 'ready'`, `edited: true`) and
  the revision story is the `edited` flag + the rewrite-overwrite confirm.
  Never route a part-text write through the artifact revision seam.
- **The battle board is a FROZEN COPY of the encounter map; Open battle never
  reseeds.** Seeding copies `mapImageId` + `mapLayout` onto the board, and
  from then on the two evolve independently: regenerate swaps the
  encounter's slot (docs/11 D16) and only never-live boards converge — a
  live board keeps playing the old map until the GM explicitly re-runs the
  battle. Never "refresh" a board from the encounter outside
  `convergeBoardsToRegeneratedMap` (repo-level, `patchBattle` path), and
  never touch the surface for it.
- **UI scale never touches px-measured surfaces**: `--ui-scale` (uiScale
  store) multiplies the root font-size, so only the rem-based Tailwind/shadcn
  scale grows. The battle board (DOM + transforms over world units, measured
  px), the dice stage (fixed canvas), the PDF viewer canvas
  (fit-to-measured-width), `ResizablePanel` px minSizes and px micro-labels
  are intentionally fixed — do not "fix" them to rem, and do not replace the
  mechanism with CSS zoom (board/pointer px math, Firefox breakage).

## 5. Known debt (live divergences at HEAD — do not "discover" them)

- ~~Map-regenerate attach bypasses the image seam~~ — closed: `runEngine.runEncounterFinalize`'s regenerate branch rides `attachImagesToArtifact` (new optional `data` + `meta` patch fields) — re-anchor + content write commit in the one attach tx, and the cover is explicitly kept (never cleared). Extended by docs/11 D16 (single-map-slot): the same tx swaps the previous map out of `imageIds` (`removeImageIds`), refchecks its blob (`pruneCandidates`), converges never-live boards, and declares `db.battles` in its scope for the board-aware refcount. The fresh-encounter `createArtifact` birth path stays intentionally off-seam (single-row create, no desync window — see below).
- **Queue reload survival is deferred BY OWNER DECISION** (`lib/jobQueue`
  header): the in-memory queues lose queued/failed jobs on reload; run rows
  reconcile via `runRepo.failRunningRuns`. Do not invent persistence.
- **Fresh-encounter finalize embeds `imageIds` at birth** via `createArtifact`
  instead of the attach seam — single-row create, no desync window. Listed
  so nobody "fixes" it without reading why.
- **The CARTOGRAPHER's in-place map run has no module-context parity**:
  smith-kind targeted runs AND the mode-generate Encounter Smith's content
  fill ground in the owning module (`targetModuleGrounding` — the draft step
  renders the stored section), but the mode-encounter Cartographer's BRIEF
  step keeps its docs/11 context contract — roster verbatim + general
  grounding, NO module-document/premise section and no detection
  enrichment. Deliberate: the encounter brief prompt is a frozen contract
  (fix-02/D2) with heavy pins; extending parity there needs an
  owner-ratified amendment of docs/11, not a quiet prompt change.
- ~~The panel's encounter content hand-off dropped the target~~ — fixed in
  the parity arc: `start()` gained the producesKind-'encounter' targeted
  branch (the mode-generate Encounter Smith used to fall through to
  fresh-create and DUPLICATE the stub; probe-pinned in persona-run-ui).
- ~~Encounter site-shape work landing concurrently with this doc~~ — landed
  (c0bf5cf → 32db5bb): the shape/preset/budget seams are in §2.2 above and
  the decision rows live in docs/11 D11–D13 + docs/17 rows 31–33.
