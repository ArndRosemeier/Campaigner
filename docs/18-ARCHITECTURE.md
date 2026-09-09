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
  images, quickfind, onboarding, guide, dice, progress, covers). DB-derived UI state =
  `useLiveQuery` hooks in the feature's `hooks.ts`; session/UI state = small
  zustand stores (§3). Run orchestration lives here too: `entity-batch.ts`,
  `post-run-extras.ts`, the four job queues.
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
| Attach images (store + reference + re-anchor + prune + optional content patch) | `artifactRepo.attachImagesToArtifact` — one rw tx over images+artifacts+revisions+battles+modules+campaigns (battles rides the scope because the post-attach prune refchecks frozen boards, modules+campaigns because it refchecks cover slots — a read on an undeclared table throws); blobs are byte-prepared (`buildStoredImage`) BEFORE it opens; the optional `data` + `meta` patch lets a content write that must land with the attach (map-regenerate's layout/mapImageId/preset/siteShape/budgetAdvisory) commit atomically instead of a second `updateArtifact` write; the optional `removeImageIds` swaps gallery ids out in the same tx (single-map-slot replace, docs/11 D16); the optional `scrubImageIds` releases ONLY those ids from THIS artifact's revision snapshots in the same tx, so the post-attach `pruneCandidates` frees exactly the superseded blob — this remove+scrub+prune triple is portrait delete-after-replace (docs/11 D5 preservation rule): the old cover's history pins release atomically with the fresh cover's commit, never before | `createImage` then `updateArtifact` as separate writes |
| Point a module/campaign cover slot at a stored image (the cover-writer seam) | `features/covers/cover-image-queue.attachCover` — `createImage` then `patchModule` / `updateCampaign` carrying `{coverImageId}` (loud existence check: a row deleted mid-flight throws NotFoundError, never a dangling slot); modules/campaigns have no revision snapshots, so no scrub step exists — regen is swap-then-`deleteImageIfUnreferenced(old)` (delete-after-replace, §5) | routing a cover write through `attachImagesToArtifact` (artifact-only seam: gallery/snapshot semantics that cover rows don't have); clearing the slot before the replacement lands |
| Write rule chunks | `chunkRepo.writeChunks` (`putChunks` alias) — invalidates the keyword index with the write | `db.chunks.bulkPut` anywhere else; backup restore MUST route through this door |
| Get/create the live battle for a module | `battleRepo.ensureBattle` — the v16 unique `&moduleId` index is the arbiter | get-then-create across two transactions |
| Mob artifact per cited monster chunk | `mobArtifacts.getOrCreateMobArtifact` / `spawnMobArtifactIntoModule` — a second-module spawn PROMOTES the artifact (shared campaign level) instead of moving it away from the first module | scan-then-`createArtifact` in separate txs (splits token identity); moving a placed mob artifact to another module |
| On-demand npc artifact per UNCITED roster entry (inline/none) | `mobArtifacts.materializeInventedCreatureArtifact` (roster name + notes/treasure appearance + inline block-or-null + encounter summary marker; `moduleId` = encounter's when module-owned else campaign-level; roster entry NOT rewritten so seeds stay identical) + `features/campaign/mob-portrait-queue.enqueueInventedCreaturePortraits` (chunk-less local-only jobs — invented covers never read/populate/overwrite the global cache) | a new kind or a `monsterChunkId` marker on a chunk-less row; rewriting the entry to npc-ref (changes seed identity) |
| Global mob portrait per cited chunk (canonical only, all campaigns) | `db/mobPortraitCache` (firewall `cacheKeyForMonsterSource`, read-through `fillCoverFromCache`, render `cloneCachedPortraitToArtifact` — first-time clone skips imaged artifacts, the `force` flavor force-clones delete-after-replace for regen — plus artifact-to-artifact `cloneArtifactCover` for the content-regen carry-forward; all three ride the ONE `attachClonedCover` core, never a second mechanism — first-publish `storeCanonicalPortraitIfAbsent` — put-if-absent ONLY) + `features/campaign/mob-portrait-cache-queue.ensureCanonicalMobPortrait` (cross-campaign single-flight; Dexie v18 `mobPortraits` table `id, &chunkId`; docs/11 D5 amendment). Regen republishes through `replaceCanonicalPortrait` (the ONLY unconditional slot writer) via `regenerateCanonicalMobPortrait` (the ONLY always-fresh generation) — never `storeCanonicalPortraitIfAbsent` for a regen (it would keep the old bytes) | generating per campaign; attaching the shared global row as a cover; a flavored citation writing the cache; republishing the slot anywhere but `replaceCanonicalPortrait` |
| Regenerate a mob / invented-creature portrait | `features/campaign/mob-portrait-queue.regenerateMobPortraits` (rulebook batch: validate → republish canonical slots fresh → enqueue delete-after-replace regen jobs `regen: true` for the imaged artifacts + the normal cover-less batch for the remainder) / `regenerateSingleMobPortrait` (battle-card single mob: the same three phases on one resolved target) / `regenerateInventedCreaturePortraits` (uncited: materialize → regen jobs for the imaged + the normal invented batch for the cover-less remainder) — delete-after-replace is the one way (docs/11 D5 preservation rule): the worker generates fresh bytes, then the attach seam swaps the cover in ONE tx (fresh cover commits, ONLY the superseded ids are scrubbed from that artifact's snapshots and refcount-pruned); a failed republish throws loud with all old covers intact and nothing enqueued; a failed, skipped, or queue-dropped regen keeps the old portrait with a loud error — regen entries upgrade (withdraw-then-enqueue) any stale queued/in-flight normal job for the same artifact so the dedupe can never strand a regen as a silent skip | detaching first (`removeImageFromArtifact` in a regen path — destroys the blob AND the restore path before the replacement exists); a second detach/enqueue path; re-enqueueing an imaged artifact expecting fresh bytes (the skip branch + cache read-through return the OLD art — a no-op regen); detaching without re-enqueueing (strands initials) |
| Carry a mob cover onto a re-cited row (content-regen preservation) | `mobArtifacts.carryMobCoversForward` — runEngine's in-place encounter finalize calls it after the content write (old roster → new roster, same-name rulebook entries, cover-less new row inherits the old row's cover via `cloneArtifactCover`); old rows stay as orphans | re-citing without carrying (abandons the cover while tokens fall back to initials); deleting the old row as part of the carry |
| Read / patch settings | `getSettings` (write-creates defaults) / `readSettings` (pure — liveQuery-safe) / `updateSettings` (tx, schema-validated merge; existing rows merge over defaults) | raw `db.settings` reads without the defaults-merge parse |
| Show an image | `useImageUrl` (`features/images/use-image-url.ts`) — object URLs revoked on change/unmount | `URL.createObjectURL` without revoke |
| Bring an image INTO the app (upload or generated blob) | `imageIntake.intakeImage` — EXIF-safe decode, ≤1600px long edge, WebP re-encode | ad-hoc canvas/FileReader scaling |
| Store map candidates mid-run | `imageRepo.createImage` per candidate — deliberately UNATTACHED until the pick step attaches via the seam; top-level use only (inside a tx: `buildStoredImage` before it opens, `db.images.put` inside) | attaching candidates eagerly |
| Delete a module / campaign / artifact | `moduleRepo.deleteModule` ('cascade' \| 'keep' \| 'promote-referenced') / `campaignRepo.deleteCampaign` / `artifactRepo.deleteArtifact` — 'promote-referenced' adopts outside-referenced rows (fresh `modulesReferencingOwnedArtifacts` scan: wiki-graph edges + roster + battle tokens) BEFORE the tx, then cascades the rest; the list dialog shows the third state with the referenced names. `deleteModule` frees the module's own cover blob after the row delete (captured before, `deleteImageIfUnreferenced` after — the refcheck's cache-table read cannot join the delete scope); `deleteCampaign`'s image sweep frees module + campaign covers with everything else | ad-hoc cascades — these are transactional, recount-honest (rows re-listed inside the tx), scrub battles/links/images |
| Remove all generated content (fresh generation start, Party kept) | `campaignRepo.removeAllGeneratedContent` — ONE tx over every touched table, rows re-listed inside; per-row disposal rides nested `deleteArtifact` (subset scope, joins the tx), battles/modules/runs/deliverables go by campaign sweep, orphans prune via `pruneUnreferencedImages` (campaign rows only — library images structurally immune); in-flight module passes abort BEFORE the tx (native-promise import must never gap a Dexie scope) | per-module `deleteModule` calls outside a shared tx (no cross-call rollback); a second wipe implementation anywhere else |
| Backup / export / import | `lib/backup.ts` (whole-DB restore rides `db.transaction('rw', db.tables)` + the chunk door) / `lib/exportImport.ts` (campaign export v2: modules/battles/runs/deliverables + `dependencies` manifest; import = ONE tx over the eight tables, array form, with module/artifact re-id maps rewriting every reference; `parseExportTolerant` is the import boundary's tolerance stage — strict first, then per-row retired/drift triage with skip-count, reassembled output strict-parsed before return) | table-by-table writes that can strand a half-import |
| Delete a module's orphaned entities (the guarded sweep) | `orphanSweep.sweepOrphanedArtifacts` (db/orphanSweep.ts — owns `ORPHAN_KINDS` + the orphan definition; docs/08 §M4-C "Orphaned entities", 14 §7) — ONE rw tx (array form: artifacts, revisions, images, battles, modules, campaigns, deliverables) that RE-DERIVES candidates + guards from re-listed rows INSIDE the tx (recount): campaign-wide mentions via UNCAPPED `buildWikiGraph`, ambiguity shadow, battle `tokens[].artifactId` + `seedFighters[].id` on ANY campaign battle, encounter roster `npc-ref`/`mobArtifactId` on any SURVIVING encounter (SAME-module counts — the module survives), deliverable outline nodes; per-artifact outcomes `deleted`/`kept`+reason for ONE caller toast; deletes ride the frozen `deleteArtifact` nested (subset scope) | deleting per artifact with an ad-hoc hand-rolled cascade; trusting a dialog count instead of the tx recount; a silent drop of a guarded row |
| Tag a module's unmentioned entities (the orphan tag, read time) | `entity-orphans.deriveModuleOrphans` / `useModuleOrphans` (features/modules — pure over the panel's EXISTING props `module` + `artifacts`; no live query, no new props): module-owned rows of `ORPHAN_KINDS` with zero resolving wiki-link mentions in THIS module's prose, mentions via `buildWikiGraph` tokens (reader semantics), ambiguity-shadowed rows flagged out of the group | `countOccurrences` substring scans; a panel-side campaign-wide copy (the sweep re-derives the gate in-tx); a second orphan predicate outside the sweep's `orphanCandidatesOf` |
| Describe what an export cites but does not carry (rulebook chunks, library NPCs) | `collectDependencies` (`domain/exportDependencies.ts` — pure, `DependencyLibrary` maps injected; `buildCampaignExport` does the bulk Dexie reads) + the L0(contentHash)/L1(system+title+creature)/L2(chunkId) identity contract (docs/07 M3-E); missing image blobs land on `missingImages` with referrers named, never silently dropped | re-resolving rulebooks at read sites; a second citation-identity scheme |
| Check an export's rulebook deps BEFORE importing it | `analyzeDependencies` (same file — pure, `chunksByHash` pool + `books` injected; `checkImportDependencies` in `lib/exportImport.ts` does the Dexie reads: one `contentHash.anyOf` probe + same-system book chunks) → `importExport`/`importZip` default-abort via `MissingDependenciesError` BEFORE the tx opens (nothing to roll back); rulebook chunkIds are KEPT as-is so `missing ref` markers stay truthful; pre-stamp entries heal content identity from the manifest (`healRulebookSources` — matched by exporting artifact + cited chunkId, fills gaps only); the AppShell `MissingRefsBanner` derives from the same `resolveMonsterEntry` contract (banner and badges clear together when byte-identical content is installed — the hash fallback, not the uuid) | an ad-hoc hash compare inside the import tx; healing chunkIds to local rows; a toast-only surface |


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
| Persona run pipelines | `runEngine` step plans per mode (`domain/persona.mode` = generate/review/image/encounter): `retrieve→draft→statblock→finalize`, `gather→check→finalize`, `prompt-draft→generate→pick` (pick ALWAYS pauses), classic encounter `brief→layout→schematic→stylize→pick→finalize` (pick ALWAYS pauses; NO verify step — D14, the user is the judge and Regenerate candidates is the correction) and vision encounter `brief→vision-map→finalize` (docs/11 D19: complex-only, no pick pause — the single map is selected by contract, locate+verify is the gate; the shape re-resolves after the brief stamps its `mapPath` marker) | a bespoke pipeline for a shape that fits an existing plan |
| Image generation | `imageGen.generateImages` — UNCONDITIONAL model-chain escalation on ANY error (typed OpenRouter error envelopes classify structurally); `cappedToOne`/`fallback`/`filteredCount` surface as user-visible step notices; a single-entry chain's failure names the missing fallback config | raw image API calls elsewhere |
| Monster stat lookups | `monsterResolve.resolveMonsterEntryWithRepos`; fighter shapes via `db/fighterStats.ts` (`fighterStatsFromArtifact`, `buildFighterStatsLookup`) | re-parsing `statBlock` ad hoc |
| Rulebook citation identity (chunk-hash-fallback) | the rulebook `monsterSource` carries additive optional `contentHash` + reserved `creatureName` (`domain/artifact.ts`); EVERY birth stamps both through the pure `contentIdentityFor` (`domain/encounterResolve.ts`) — runEngine finalize (both remap sites, via `rulebookSourceFor`, which throws loud on a vanished chunk), the editor rulebook-link dialog, the spawn picker (`buildMobPickEntry`); `resolveMonsterEntry` falls back to `getChunkByContentHash` on a uuid miss (exact hash only — same creature/new version stays `missing ref`; L1 deferred, docs/11); `collectDependencies` carries a dangling entry's own stamp onto its `missing-chunk` citation (chunk wins when present) so re-exports stay L0-clearable | stamping citations uuid-only; a same-creature fuzzy match at resolve; healing chunkIds to local rows |
| Monster level → sort key | `encounterRoster.parseLevelSort` | a second level parser |
| Bestiary/item pack data | `ingest/packFetch` (only networked surface; newest-first with pinned-verified-ref fallback) → `packImport` → `packs/registry` adapters | fetching upstream files anywhere else; adapters stay network-free (test-pinned) |
| PF2e rules text (journal pages, conditions, feats/spells/actions corpus) | the same pack lane, third entry type: rules-text fetch sources (`packFetch`, `packDirs`-scoped) → `packImport` `sections` → `packs/pf2e-journal` / `pf2e-conditions` / `pf2e-rules` adapters → `section` chunks with per-entry Source lines | HTML scraping (there is none — the machine-readable packs are the one way; docs/12 §15); a second retrieval path — `encounterRoster` skips `section` chunks like `item` chunks |
| Ground a mob portrait in a creature chunk | `portraitGroundingForChunk` (`llm/imagePromptDraft.ts` — stat-exempt: size + creatureType identity plus traits/actions/reactions/legendary prose, every numeric field out by field, 800-char cap; null statBlock falls back to raw `chunk.text` as the loud residual render risk) + `MOB_PORTRAIT_TEXT_NEGATIVE` on both mob drafts (canonical cache-queue + flavored local branch; `buildImagePrompt` `negative` option, default `''` so other callers are unaffected; the `appearance` shortcut still wins, the creation-dialog artifact-body path stays out of scope) — docs/11 D5 | feeding raw `chunk.text` into `buildImagePrompt` (image models render stat digits into portraits) |
| Ground a module/campaign cover prompt (no chat call) | `features/covers/cover-image-queue.draftPrompt` — the shared Illustrator contract (`buildImagePrompt` + `assembleImagePrompt`): a module grounds on title + concept (summary) + the full document text (`moduleDocumentText` — premise + parts), a campaign on name + description (summary, no body), styled by the owning campaign's system label; empty grounding throws in `buildImagePrompt` (describe the slot first — never a blank cover) | a prompt-crafting chat call (removed owner-directed 2026-09-05); grounding a module on its entity stubs instead of its document text |
| Background job pump (portraits, entity images, maps, covers) | `lib/jobQueue.createJobQueue` — inherits dedupe, cancellation, failed-list + retry, dock counters | a hand-rolled worker loop |
| Entity generation (batch AND single stub) | `features/modules/entity-batch.runEntityBatch` (the stub popover delegates a 1-target batch via `entity-detail.generateSingleEntity`) | a second "detail one entity" implementation (`chainRunner` is for Writers'-Room chains, not this) |
| Module generation | `moduleGen.runSpine` / `runParts` / `approveSpineAndRun`; entity name normalization via `normalizeModuleEntityNames` (one LLM call, never heuristics — fix-01); the hard encounter floor via `countModuleEncounters` (pure: distinct canonical `[[encounter]]` links in `moduleDocumentText` vs levelCount, per-band via `levelsInLevelBand`) + `assertEncounterFloor` (spine gate: zero encounter records → one escalated repair, then loud; parts gate: after re-normalize, before ready — one escalated repair rewrite per deficient part, hand-edited parts untouched, still short → `failed` naming parts + toast, automation tails skipped); structural conflict via `wants: [a, b]` + `conflictKind` (`ENCOUNTER_CONFLICT_KINDS`, docs/11 vocabulary) on encounter records — spine parse rejects incomplete declarations (retry-once, then loud), spine-time verdicts map names only with the planner's declarations carried over code-side (`canonicalEntityRecords(verdicts, spineKinds)`), post-parts verdicts author their own (`requireEncounterDeclarations`, violation → retry-once, then the recorded normalization failure), and the declared mix via `assertEncounterMix` (counts declarations — an undeclared kind fails loud, never defaults; spine gate repairs once; full parts runs own the module-level mix, subset runs own bands only); the surviving tail's post-generation sweep also enqueues mob portraits for module-owned encounters when the row's `autoGenerateMobImages` is set (`features/modules/post-generation` → the mob-portrait batch `enqueueMobPortraits` — one per creature kind, skip-if-imaged, enqueue-don't-await) | heuristic name rewriting; a second encounter counter; repairing hand-edited parts headless; shipping a short module as ready |
| Recognize a module-forge stop | `moduleGen.isCancel(error, signal)` — the run controller's `signal.aborted` is the source of truth, never the error's type (the streaming pipeline can surface a stop as a cross-realm AbortError, a wrapped transport error, or no error at all); every cancel-vs-failure catch reads it, plus a fail-fast guard at the top of the parts loop so a stop between calls never starts the next part | `instanceof DOMException && name === 'AbortError'` alone (fails cross-realm: probed CTOR DOMException + name AbortError with instanceof false) |
| Treasure clauses in prompts | `treasureGuidanceFor` / `roomKeyGuidanceFor` (`treasureGuidance.ts`) | quoting DMG tables or paraphrasing Paizo numbers (licensing — docs/12 §13.2/§14) |
| Per-room challenge budgets | `roomBudget.ts` (`checkRoomBudget`, `expectedRoomThreat`, `reconcileRoomAssignments`, `roomBudgetGuidanceFor`, `fillGradeStockingFor`, `parseBudgetLevel` over `encounterRoster.parseLevelSort`) — the loop: over-band rooms lower a step through the brief's single repair turn, then LOUD advisory on step output + `data.budgetAdvisory`; complexes additionally carry the `fillGrade` stocking expectation (`src/domain/artifact.ts` — additive optional, drawn once by `drawFillGrade` when a complex first materializes with the field absent, owner value always wins) giving the lower verdicts — 'empty' (repairable on fresh complex briefs) and 'under' (advisory) — while single arenas keep "a quiet room is a feature" byte-identical; the Cartographer's stocking clauses + bounded roster EXPANSION are SHAPE-gated (`encounterDataIsComplex` — the parse-normalized `siteShape`, docs/11 D12 amendment) and key on the regeneration target's ACTUAL shape, never the remembered `preset` (a legacy complex row whose persisted preset is 'standard' still restocks; the preset keeps the grid tier/prose — D10 untouched): prefix verbatim, appended entries source-cited, cap = Σ room expectations + margin, append a DIRECTIVE for complex-shaped targets ("must append") and a permissive "MAY" for non-complex targets on a dungeon preset, prompt and evaluate gate sharing ONE authorization flag; pf2e keeps the byte-identical verbatim pin; re-sizing a roster against the grade rides the D18 two-button surface only (`features/campaign/encounterRegen`: Repopulate = roster-only pass, Regenerate everything = fresh full run — no standalone one-fight content button exists); the in-place fill packs unclaimed entries by nearest-band fit (round-robin fallback without expectations) | a second level parser; a second shape predicate beside `normalizeEncounterShapeData`; gating the stocking clauses on the remembered preset instead of the target's shape (the legacy-row trap); numeric pf2e budgets (Paizo licensing — docs/11 D12; `expectedRoomThreat` returns null for verbatim systems); redrawing a persisted fillGrade |
| Structured encounter level context (party of 4 at the part's level) | `llm/roomBudget.ts` (`PARTY_SIZE = 4` — the ONE party-size constant, `partyLevelLine`, `partLevelForMention`: first part in plan order whose markdown carries the encounter's `[[Name]]` mention supplies its `levelBand` as the EXACT level, multi-level bands parse to the low end, premise-only/unmentioned/unparseable ⇒ undefined with the free-text chain underneath) — the Smith draft carries it via `buildEntityBrief` (`features/modules/persona-request.ts`, encounter + npc stubs per `stubKindCarriesPartyLevel`, resolved in `entity-batch.ts` at the excerpt position) and the Cartographer brief via `runEncounterBrief` (module lookup through the target's `moduleId`); `fillGradeStockingFor`'s `promptLevel` prefers it, `parseRosterTargetLevel(levelHint/brief)` stays as fallback; the fixed cast rides the same seam (`fixedCastForEncounter` + `fixedCastSectionFor`: drafted npc-kind scene members pinned must-appear into the encounter brief, brief-time derivation from in-batch results + module text, never stored; encounters detail last via post-generation `orderedKinds`) | a second part-lookup implementation; a second party-size literal; band math over a part's levelBand |
| Encounter site shape / play path | `domain/artifact.normalizeEncounterShapeData` (ONE derivation: parse-on-read + v17 backfill + backup validation) + `domain/encounterMap/schema` (`encounterSiteShapeSchema`, `spawnFirstPath`, layout `path` refine) | deriving siteShape from room count at read sites; trusting the rooms-array order as play order (packAttempt rotates it) |
| Encounter map style mode (natural site, docs/11 D17) | `domain/encounterMap/schema.resolveEncounterMapMode` (ONE derivation: owner `mapMode` override on the artifact data > brief `environment: 'outdoor'` OR `locationKind: 'wilderness'` (union) > architectural) consumed ONLY through `runEngine.effectiveEncounterBrief` (the brief step stamps `mapModeOverride`/`mapLocationKind` run facts; the mode re-derives from the EFFECTIVE brief prose, pre-mode rows read architectural) and `renderSchematic(layout, cellPx, factory, mode)` (`'natural'` = the placement-only overlay inside the same function; `'architectural'` default keeps the dungeon bytes) | branching on `environment`/`locationKind` directly at a render or prompt site; inverting the outdoor contract into terrain bans (the prose stays fully open — minimal contract, not an inverted one); stamping `mapMode` from a run (the field stays owner-owned/unset = derive) |
| Legacy persona values (removed kinds) | `domain/persona.normalizeLegacyProducesKind` (ONE `z.preprocess`: parse boundary + `updatePersona` + backup restore heal the stored row — git-proven mapping table, unknown values still fail loudly) | a catch-all kind fallback; hand-editing or deleting the poisoned row |
| Vision-located dungeon mapping (docs/11 D19) | `llm/visionDungeon.ts` (creation-path home: labeled-map prompt builder over rooms+concept, A–N labels, the 0–1000 vision locate contract + `locateDungeonLabels` locate→count-check→focused-re-ask→`VisionLocateError`, first-mark-wins dedupe) + the brief's `mapPath` marker (`resolveBriefMapPath`: rooms > 1 AND (per-run override ?? `settings.dungeonMapPath`) is `'vision'`) + `StartRunInput.dungeonMapPath` / run-row `dungeonMapPath` explicit-only (null = no override; resume/retry rebuilds carry it) + `EncounterRegenOptions.dungeonMapPath` (D18 complex-only steering, never persisted as the default; singles ignore, repopulation takes none; the unattended queue passes none so the setting governs) + vision layouts (`mapPath: 'vision'`, letters + observed `x_norm/y_norm`, NO packed geometry — spawns/veils/markers resolve to the observed point, polygon consumers throw loud) | a regular/irregular toggle in the vision path (shape follows each room's description + the concept — owner clarification); inventing/defaulting a coordinate for a missed plaque (the map step fails loud, candidate pruned); aspect-normalizing the labeled map (cropping could cut plaques — the board letterboxes) |
| Legacy run rows carrying a REMOVED step | `domain/run.normalizeLegacyRunSteps` (ONE `z.preprocess` inside `personaRunSchema`: drops the deleted encounter `verify` step and re-indexes, so reads/updates heal the row and every engine continuation stays index-coherent) | executing the engine plan positionally over a shifted steps array |
| Campaign grounding for runs | `campaignGrounding.computeCampaignGrounding` + renderer (docs/15) | a second wiki-expansion implementation |
| Refill an existing artifact in place (smith kinds: pc/npc/location/event/faction/note/plotarc) | the editor's `ContentAiSection` → `contentRefillRequest` store → the persona panel's targeted generate run; grounding parity via `runEngine.targetModuleGrounding` (module document + premise rendered from the STORED retrieve output; every inapplicable state names itself) + `mergeRefillData` (preserves PC human-owned fields, curated stat blocks, the mob marker; model name → alias) | a second "detail one entity" implementation; a patch touching `moduleId`; a silent degrade |
| (Re)generate an encounter automatically (docs/11 D18, BOTH shapes) | `features/campaign/encounterRegen.ts` — the ONLY automatic surface: `repopulateEncounter()` (complex roster-only Cartographer pass `encounterScope: 'rosterOnly'` — brief with the repair loop + room-mirror + fresh cap, `runEncounterRosterFinalize` persisting ONLY `monsters` onto the preserved rooms/map; singles the Smith one-fight fill; roomless complexes refuse loud) / `regenerateEncounterEverything()` (complex row reset via `resetComplexForRegeneration` then the full pipeline with the row preset; singles the Smith draft then the unattended map queue) / `runProseRedesign()` chained when the checkbox is ticked (Smith `encounterProseOnly`: name/prose/body persist, ANY roster drift fails loud with nothing persisted); runs awaited via `runEngine.waitForRunStatus` (`awaitCompletedRun`); the editor section holds `encounter-regenerate-everything` / `encounter-repopulate` / `encounter-redesign-prose` and nothing else generates encounter content on its own (manual Clear + the unattended map queue are not generation buttons; the old panel hand-off store is deleted) | a standalone content-regen button; a standalone battlemap-regenerate button; a Smith extension restocking a dungeon (a complex repopulation is a roster-only Cartographer pass keyed on the target's actual shape); ticking the prose box to resize a roster (prose-only — it never touches monsters) |
| `event` kind mirrors `location` everywhere (social/non-combat content: GM text + showable image) | aliases, not copies — `eventDataSchema = locationDataSchema`, `eventDraftSchema = locationDraftSchema`; shared engine cases (`draftContractFor`/`dataForDraft`), shared `LocationForm`, own persona slug (`event-weaver`, never `worldbuilder`) + `REFILL_PERSONA_SLUGS` entry; EXCLUDED from battleSeed map-linking (location-only map role) and encounter/npc/statblock paths | an event-specific field (the alias would drift); mapping event onto the worldbuilder slug |
| Reject empty generation output | `substanceText` in `llm/schemas.ts` (name/summary/body ≥ 1 non-whitespace char on every draft contract; the strict schema can't express it — the zod parse rides the ONE repair turn, then loud) + the finalize re-guard (`runFinalize`: empty body refuses to create or overwrite — a refill keeps the existing content) | a prose-length floor (over-rejects short notes); a silent placeholder |
| Reject half-formed unicode escapes in generated text | `lib/encodingHygiene.findEscapeDebris` (pure: `?` + exactly 2 lowercase hex forming a non-ASCII tail, plus literal `\uXXXX` in decoded text) + `debrisIssuesForFields`/`collectTextLeaves` at the boundaries — `runEngine.runFinalize` scans the draft + statblock strings BEFORE any create/updateArtifact (hit → loud `rejected` with the debris named, nothing persists), `moduleGen.generatePart` scans normalized part prose before the ready write (hit → part `failed` with the debris named, chain continues). Detection backstop for the `language.ts` UTF-8 contract (prevention) | silent repair-and-continue; persisting debris as ready content; a second scanner implementation |

### 2.3 App & UI

| To do X | Use Y | NOT Z |
|---|---|---|
| Build a route path | `app/routes.ts`: `ROUTES` patterns + the `*Path()` builders | hand-writing `/c/...` strings |
| Save a renderer-built file to disk (backup, campaign/artifact export, artifact PDF) | `lib/filePicker.openSaveTarget` — THE one way to save files: acquire the `SaveTarget` inside the click handler BEFORE the slow build, `target.write(blob)` after; picker cancel = silent no-op (no build, no toast), picker failure = loud `toastError`; `BACKUP_TYPES` / `EXPORT_JSON_TYPES` / `EXPORT_ZIP_TYPES` / `EXPORT_PDF_TYPES` are the one picker-type registry | `downloadBlob` from UI code (the no-picker fallback lives INSIDE `openSaveTarget` only); build-then-pick ordering (the picker needs transient user activation) |
| Surface an error | `lib/toast.ts` (`toastError`/`toastErrorPersistent`), a failed run row with `errorMessage`, or the global boundary (`app/GlobalErrorBoundary` + `lib/globalErrors.installGlobalErrorHandlers`) — HUMANIZE-AT-THE-SEAM: a ZodError's `.message` is the raw `[{code,path,message}...]` array, so it is never rendered verbatim; the seam formats it via `lib/zodErrorSummary` (counted, grouped by table, first 3 + "and N more", version-skew mitigation; names never invented — issues carry no input values), keeps the leading title untouched (plain-Error copy passes byte-identical), and logs the full raw error to the console (one click away, never megabytes in the toast). Import failures append the same mitigation via `lib/exportImport.withImportMitigation`; `MissingDependenciesError.message` itself reads as numbered steps | `console.error` only (AGENTS 2); rendering `error.message` of a ZodError-shaped failure into a toast description |
| Long-running progress | `lib/progress.useProgressStore` + the app-wide `<ProgressDock/>`; queue jobs report via `dockGroup` | a disabled button or a "Generating…" label (00-OVERVIEW, binding) |
| Wiki-link handling | `lib/wikilinks.ts` (extract/strip/rewrite/resolve/count; `WIKI_LINK_PATTERN`) + `lib/remark-wikilinks.ts` → `WikiMarkdown` | a private `\[\[...\]\]` regex |
| Write part text on the module row (ONE save path) | `features/modules/partText.saveModulePartText` → `moduleRepo.patchModulePartText` (row re-read INSIDE the rw tx — a concurrent parts write can't be lost; `status: 'ready'`, `edited: true`) + the post-save `promoteSecondModuleUses` scan. Callers: the reader's `savePartEdit` (PartTextEditor hand edits), the board rewrite's Apply and Discard | a stale-snapshot `parts` array written through plain `patchModule` (lost-update on concurrent saves); a part-text write that skips the promote scan; artifact revisions for part markdown (there are none — parts live on the module row) |
| Board the whole module (viewport, layout, LOD) | `features/modules/board/` on `@xyflow/react` (attribution rendered): React Flow is THE viewport gesture owner (pan/zoom/pinch/drag — cards mount plain buttons only, scrollable bodies `nowheel`); node positions + viewport persist via the module row's `canvas` field (`patchModule`, debounced 600ms, unmount flush — rides backup/export); content slices in `boardStore` are value-diffed per node (node objects must stay stable — React Flow re-renders ALL nodes when node objects churn); node keys via `domain/module` (`premise`, `part-<planIndex>`, `prior-<id>`); continuity edges via `boardEdges.deriveContinuityEdges` over `buildWikiGraph` mentions, capped + surfaced | custom pointer handlers on board nodes (a second gesture-arming path — battle-machine rules apply to the battle board only, but the module board must never arm its own); localStorage layout copies; a second node-key format |
| Board per-part rewrite + staging | `features/modules/board/stagedRewrites` (zustand, SESSION-only) + the page's rewrite flow: engine = `runParts` subset (`planIndexes: [i]`) — floor gates own their bands, normalization included — WITHOUT `rewritePart`'s swallow-all catch so `ModuleBusyError` surfaces loudly (ONE generation per module); ghost tokens (`moduleGenEvents` part-token) buffer into the store rAF-throttled — partial text never touches the module row; Apply/Discard land through `features/modules/partText.saveModulePartText` | queueing or silently dropping a busy rewrite; persisting staging anywhere; a diff view (owner decision: new text renders as-is, Show previous on demand) |
| Markdown → plain text | `lib/markdown.markdownToText` | a second strip-regex |
| PDF viewing | `lib/pdfRuntime.openPdfDocument` + `copyBytes` (worker-safe byte copies); retained book bytes via `pdfRepo` (`&bookId` unique) | re-parsing PDFs from user files |
| Encounter preset resolution | `domain/encounterMap/schema.resolveEncounterPreset(preset, locationKind)` | branching on `locationKind` directly |
| Cover monster spawn areas with fog at battle seed | `domain/encounterMap/layout.veilsFromSpawnClusters(layout, rosterCounts)` — ONE fog veil per `monsterIndexes` group (owner order; the group's `placeMonsters` cells PLUS a one-cell margin on every side, clamped to the board bounds — the cover convention: a minimal box sits exactly coincident with the tokens, which paint above veils, so without the margin the veil body and edge handles are 100% occluded), then the overlap merge (`mergeVeilCovers`): same-room covers sharing ground collapse to their union bounding box (re-clamped) under the first-emitted identity — single-room adjacent spawns seed exactly one veil, disjoint same-room covers stay separate, cross-room covers never merge; no spawn-room exemption; the room's first group keeps `id = room.id` and every group veil carries `roomId` (`battleVeilSchema`, additive/optional) — the Path rail resolves rooms per ROOM via `veil.id` AND `veil.roomId`, and "Reveal next room" reveal-alls the room (a room reads veiled until its last group veil lifts) — never re-id veils per room | one veil per room for new seeds (`veilsFromRooms` is the legacy helper); duplicate `veil.id`s per room (breaks the rail lookup + React keys); resolving rail rooms through `veil.id` only (secondary group veils go unreachable: the room reads revealed while its mobs stay covered); a covered room's key marker above tokens/veils (z-10 marker pads swallow mob/veil pointerdowns — markers mount before veils/tokens with no z-index so DOM order puts them below) |
| Resize an effect marker from an edge handle | `resizeEffectFromEdge` (`domain/battle/effect.ts` — SYMMETRIC center-fixed: every n/s/e/w handle grows the same `sizeCells` span, cell-quantized via `veilSpanNorm`, min `EFFECT_MIN_CELLS`); the surface previews the size locally with zero writes and commits exactly once per gesture end (a tap / return-to-start / cancel commits nothing; the rail Grow/Shrink buttons own discrete steps) — the veil path rides the same gesture via `resizeVeilFromEdge` since the one-gesture-machine rebuild (the veil click-step path is deleted) | the veil's opposite-edge-pinned `resizeVeilFromEdge` (different shape contract — veils carry w×h spans, effects one span); a second cell quantizer around it |
| Battle-surface gestures (board drag/resize/pan/pinch/tap) | ONE machine (`domain/battle/gestureMachine`: `idle\|armed\|active` × `token\|veil\|effect\|effectResize\|pan\|pinch\|tap` in a single ref) + ONE set of board-level pointer handlers as the sole capture owner — pieces render `data-gesture-grab` / `data-gesture-resize` hit areas and never own streams. `gestureGate.ts` is booleans the machine drives (idempotent ends, no counters, no throws — the initiative-reconcile early-return reads the boolean): second-pointerdown never overwrites (background second finger promotes to pinch with abandon-no-commit, piece second grab ignored), moves are pointerId-checked, `pointercancel`/`lostpointercapture`/blur/unmount always abandon with zero commits (cancel never commits), scenery/player-safe gates run before arming, native dragstart suppressed on the board + `cursor-grabbing` while live | per-piece pointer handlers owning streams; depth counters + throwing `end*` (imbalance crashed — now a recoverable reset); the veil click-step `onClick` resize (deleted); capture without `lostpointercapture` handling; a second gesture arming path anywhere else |
| GM vs player-safe initiative membership (token-lifecycle arc) | `domain/battle/initiative.gmFighterTokenIds` + `pruneInitiativeToGmFighters` for the GM surface (visible fighters PLUS covered NPCs — hidden still pruned, covered PCs still pruned); `visibleFighterTokenIds` + `pruneInitiativeToVisibleFighters` stay the playerSafe computation, byte-identical (covered excluded, no leak) — the surface's reconcile branches on `playerSafe`, the enable button rides the GM set, and the sidebar's veiled badge + Hidden group only ever receive GM-view props | a third membership set; branching the playerSafe path off the GM set (leaks veil state); gating removal or membership on bare `artifactId` presence (says nothing about HP ownership — the kind check is artifact kind, else stats kind) |
| Remove a battle token (token-lifecycle arc) | the surface's `removeToken`: NPC-backed tokens drop the BOARD TOKEN + initiative entry, deselect, and toast loud naming the mob; PC-backed tokens refuse loud (HP lives on the artifact); stamps/statless keep the silent path — artifacts, roster rows, and portraits are never deleted (no artifactRepo/image writes in the removal path) | deleting the backing artifact/roster/portrait with the token; silently refusing an artifact-backed remove (the old ungate: spawned mobs could never leave the map) |
| Graph page derivation | `domain/wikiGraph.ts` (pure; docs/13/14/15) | graph logic in components |
| Bounded parallelism | `lib/parallel.mapWithConcurrency` | unguarded `Promise.all` over unbounded arrays |
| Encounter map automation | `useEncounterMapQueue` + the guards `encounterNeedsMap` / `isEncounterMapPending` (serial by contract) | re-enqueueing an already-mapped encounter; a second queue implementation |
| Post-run automation | `features/campaign/post-run-extras.ts` — rides the queues AFTER a completed run | reopening/failing a finished run row |
| Dev logging | `lib/debug.debugLog` | bare `console.log` (lint) or `console.error` as an error surface |
| Stop every running generation | `features/progress/stopAllGenerations` + the dock's Stop all button (queues' `cancelAll`, `runEngine.cancelAllActive`, `cancelModuleGen`, `chainRunner.cancel` composed there — the ONE sweep; non-destructive, rows stay resumable) | a second stop path or per-surface ad-hoc cancel wiring |
| Persisted UI state | zustand store + `lib/persisted.zodPersistStorage(schema)` | localStorage by hand |
| Scale the UI app-wide | `app/theme/uiScale.useUiScaleSync` (mounted once in AppShell next to `useThemeSync`) + the uiScale store — `--ui-scale` var × root font-size (index.css); persisted via `zodPersistStorage` (the Persisted UI state seam) and kept through Delete-all-data in `db/maintenance.PRESERVED_KEYS` like the theme | CSS zoom (breaks the px-measured board/pointer/dice/PDF math); a settings-row field (device display preference — theme precedent, stays out of the data DB and backups) |
| Open a document co-authoring surface for the WHOLE module (v3 — no part selector) | `app/routes.ts` `canvasPath` (deep link `?part=<planIndex\|premise>` and `#part-<n>` hashes are SCROLL targets, never scope — landing in preview scrolls the preview articles (`part-<n>` anchors; the scroll re-runs once the content commits)) + `features/modules/canvas/` — `CanvasPage` (shell, leave-guard, preview toggle — OPEN BY DEFAULT: `openByModule` undefined ⇒ true, session-only; the canvas lands as chat + rendered preview side by side, the preview FILLING its pane beside the live chat, one click back to Edit — instruction dialog with the rewrite-part picker), `canvasScope.ts` (the one scroll-target parse site), `canvasEditor.tsx` (the React wrapper publishing `canvasView.activeCanvasView`), `wikiDecorations.ts`, `suggestions.ts`, `canvasStore.ts` | a second markdown editor substrate; hand-rolled `[[…]]` highlighting; a second scope parser |
| Own the canvas editor viewport | CodeMirror 6 via `@uiw/react-codemirror` + `@codemirror/lang-markdown` (GFM) — THE editor doc string IS the markdown (byte-exact; no parse→serialize) | a WYSIWYG round-trip (lossy, license-hostile); a textarea; a second gesture path |
| Run a canvas AI action (selection refine / picked-part rewrite) | `llm/canvasRefine.refineModuleText` — the EXPLICIT input only (the selected range + enclosing block, or the picked part's current text — never the surrounding part, never the cursor) + instruction, reply ZOD-validated at the boundary (`canvasRefineReplySchema`) + `encodingHygiene.debrisIssuesForFields` scan (loud reject, never partial-apply) + `ModuleBusyError` for ONE-generation-per-module (registry claimed synchronously at entry + the row's `generating` status) + abort signal (a user stop is not an error) | a private chat client; silent repair; queueing a busy module; a second module-busy mechanism |
| Render + decide canvas proposals | `features/modules/canvas/suggestions.ts` — a CM6 StateField of suggestions rendered as DECORATIONS that never mutate the doc; span = struck original + ghost + inline Accept/Reject (disabled while streaming); whole-part = full-doc-range proposal rendered NO-DIFF (block replace widget, Show previous toggle); typing INSIDE a proposal invalidates it loudly (page toast), edge edits re-map (pure `suggestionSurvives`); Accept = ONE dispatch + `isolateHistory:'full'` (one undo unit); streaming effects ride `Transaction.addToHistory.of(false)`; Mod-y/Mod-u accept/reject at the cursor | writing proposals into the doc before acceptance; a diff view; a second undo convention; accepting a half-streamed replacement |
| Append canvas version history | `features/modules/canvas/canvasStore.useCanvasLedgerStore` — per-part append-only `{seq, markdown, origin 'user'\|'ai', label, createdAt}`; every accepted AI action AND manual canvas save appends (one entry per CHANGED part — the split-save decides); **Restore = propose-through-the-same-accept path** (rides undo + the save path) | persisting the ledger; a second part-text write path; restoring by direct row write |
| Run a canvas CHAT turn (LLM co-authoring via XML edit commands over the WHOLE module) | `llm/canvasChat.sendCanvasChatMessage` — the request carries the LIVE whole-document editor doc passed by the page at send time (the doc IS the whole module — unsaved edits in EVERY part ride along, never a cached copy, never a row re-assembly) and splits the per-part snapshot it sent from that SAME doc (shared `domain/modulePartsDocument.splitModulePartsDocument` — the ONE assemble/split pair for editor and chat; a scaffolding-broken doc fails the send loud); spine premise EXCLUDED, `==========` delimiters + `[Part <n> of <total> — <title>]` scaffold labels; reply = prose + `<edit all="…"><search>…</search><replace>…</replace></edit>` blocks parsed by the STRICT extractor (`parseCanvasChatReply`, balanced scan; malformed/unbalanced/>40 commands = `CanvasChatParseError`, whole reply failed) + zod `canvasEditCommandSchema`; tolerant ladder `resolveCanvasEdit` runs PER PART (`resolveCanvasEditAcrossParts` — a spanning search cannot match, zero matches pick the closest candidate across parts, an empty part fills via its exact label line, ledger 51), never an auto-apply — aider lineage, ledger 50; a REFERENCE-ONLY grounding block (campaign premise + system label + ALL preceding modules' FULL text, story order, UNCAPPED — `renderChatGrounding`, deliberately not `moduleGen.priorModulesContext`'s caps) rides every request in the final turn, outside the persisted history; the FULL conversation history rides every request (ledger 57 — the message cap is deleted, no omission note; stale `<document>` blocks are stripped from older turns, the current doc rides once in the final turn); a module with no planned parts fails the pre-flight loud; claims the SHARED `llm/canvasBusy` registry (chat + refine serialize, `ModuleBusyError` loud). Application is `features/modules/canvas/chatApply.applyChatCommandsAcrossParts` (EVERY command: ONE CM6 transaction over the whole-document editor, NORMAL history — one undo step per command — then the batch persists through the split-save, only the changed parts hitting the row; a failed part save flips that part's outcomes loud + names the part); in PREVIEW (the default view — editor unmounted, never remounted hidden) the SAME protocol runs against the preview SNAPSHOT STRING (`snapshotChat.applyChatCommandsToSnapshot` — pure string splices through the SAME per-part ladder, no second matcher) and persists through the SAME split-save headlessly (`saveWholeModuleDocument` needs no editor; preview-applied edits have NO undo — documented caveat), then the snapshot + highlight advance and the preview re-renders, and return-to-Edit remounts the latest snapshot through the mountDoc path; a broken snapshot fails the send loud via the same `ModulePartsDocumentError` path. Both paths report the last command's first applied range for the last-replacement highlight (page `lastReplacement` state: whole-doc offsets + post-apply doc identity, identity-gated; editor = `lastReplacement.ts` CM6 background mark, preview = optional `WikiMarkdown` highlight prop, byte-identical without it). The flow is `chatController.runChatTurn` (streams prose only; commands apply AFTER the reply; report-to-LLM via `composeFailureReport` with the target part's current text from the live doc) and the preview mirror `snapshotChat.runSnapshotChatTurn` (+ snapshot report variants, excerpt from the current snapshot); the thread (messages + outcomes) persists on the module row's additive `chatThread` field after each settled turn (debounced `chatPersist.scheduleChatPersist`, loud-nonblocking; restores on canvas open as history, never auto-applies) and rides backup/export with the row; applied part edits land through the split-save (`saveWholeModuleDocument`) | a private chat transport; `responseFormat` on the chat call (prose+XML is deliberately not a JSON contract); regex-guessed block extraction; a fuzzy auto-apply on zero matches; matching across the assembled string instead of per part; reusing `moduleGen.priorModulesContext`'s caps (or any cap) on the chat grounding block; `addToHistory:false` on applied commands (undo must revert chat edits); remounting or hidden-mounting the editor to serve preview chat; a second command matcher for the snapshot path; a second chat-thread store beside the row field; a second module-busy registry; chat writing part text directly (the `chatThread` field is its sanctioned row write) |

| Bench image models + chat vision against each other (experiment lab, OUTSIDE the creation path) | `features/lab/` — `LabPage` shell + `experiments/registry.ts` (id/title/description/run config/results renderer; the next bench appends one entry, the shell stays untouched) + `experiments/labeledDungeon.ts` (8 hardcoded irregular rooms, the generation prompt + `{label,x,y}` 0–1000 vision contract now SHARED from `llm/visionDungeon.ts` — the lab aliases the production builder/parser, imports FROM the shared module, never the reverse — plus pure `normToPercent`) + `labClients.ts` (the app's `generateImages` pipeline + the configured chat model with a vision message — NO model pickers; session-only data URLs, no Dexie); `/lab` route linked from Settings → Experiments only, never the main nav | a model picker in the lab; persisting bench results; any creation-path import of lab code (lab imports FROM seams, never the reverse) |

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
  mention, relation (never "links"), alias, phantom, orphaned
  (unmentioned) — the panel's module-zero tag vs the tree's module-less
  Orphaned group; the orphan surface splits read time
  (`entity-orphans.deriveModuleOrphans`, pure over the panel's props) from
  tx time (`orphanSweep.sweepOrphanedArtifacts`, the recount + guards +
  the only deleter) — a guarded row is always reported with its reason,
  never silently skipped.

## 4. Gotchas

- **Dexie variadic cap.** `db.transaction(mode, t1…t5, scope)` caps at five
  tables (the scope function must be the last argument); more tables → the
  ARRAY form (`deleteModule` passes seven tables as an array; `deleteArtifact`,
  `attachImagesToArtifact`, `moveScope`, `exportImport` likewise). Tests that pin transaction shape
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
  revision for part text, so every human-adopted part-text write goes through
  `features/modules/partText.saveModulePartText` (module-row write re-read
  inside the tx, `status: 'ready'`, `edited: true`, post-save promote scan)
  and the revision story is the `edited` flag + the rewrite-overwrite confirm.
  Never route a part-text write through the artifact revision seam.
- **`planIndex` is IDENTITY, never an index to renumber.** Board node keys
  (`part-<planIndex>`), deliverable seeding and the encounter floor's band
  allocation all key off it; `spine.partPlan` edits reorder CONTENT, never
  identities. The board's node-key format has exactly one parse site
  (`planIndexFromCanvasNodeKey`).
- **One generation per module — also on the board.** The board rewrite runs
  the same `runParts` subset as the reader's rewrite, so the module-level
  controller guard applies: a busy module fails the second request with
  `ModuleBusyError`, and the board surfaces it LOUDLY (never queues, never
  swallows — which is why the board calls the engine without
  `rewritePart`'s swallow-all catch).
- **Board rewrites stage in memory only.** The staged-rewrite store
  (`features/modules/board/stagedRewrites`) is session-only by owner
  decision: no diffs, the new text renders as-is with Show previous for the
  old text, and a reload mid-proposal leaves the engine-written text on the
  row (`edited: false`) with the staging gone — documented, do not invent
  persistence.
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
- **The canvas editor doc IS the truth; decorations are view chrome.**
  Wiki chips, proposal ghosts and the whole-part no-diff preview are CM6
  decorations over the document — the module row only changes through
  `partText.saveModulePartText` (manual Save, accepted proposal). A proposal
  streaming in is a best-effort PREVIEW (an incremental extractor peels the
  `replacement` value out of the raw JSON deltas); the settled, zod-validated
  reply is the canonical proposal text — never render raw JSON deltas as
  markdown. Block decorations must be computed from state fields via a facet
  (CM6 forbids block widgets from view plugins), and the suggestion state
  fields must be REGISTERED in the editor's extension list (the decoration
  source reads them with a safe fallback — a missing field silently renders
  nothing).
- **The canvas ledger is session-only by design.** The per-part version
  ledger and every pending proposal die on reload AND on part switch (the
  loud guard exists for exactly that); the row always holds a complete,
  un-proposed text. Do not invent persistence for the ledger, and do not
  "fix" the scope guard — it is the documented price of session staging.
- **The chat context is the doc AS OF SEND, and every request says so.**
  Canvas chat NEVER caches the document across turns: the WHOLE-module parts
  document re-assembles from the module row at send time (the OPEN part's
  text from the live CM6 doc) and the system prompt states that it is the
  CURRENT state including all previously applied edits. Caching an initial
  copy (or letting older user turns re-send stale `<document>` blocks) makes
  the model re-edit text that no longer exists — the exact failure the
  contract exists to prevent. Commands resolve per part AT APPLY time
  (re-resolved per command, so earlier commands in one reply never shift
  later ranges). The thread (messages + outcomes) persists on the module
  row's additive `chatThread` field after every settled turn (debounced,
  loud-nonblocking) and restores on canvas open as history — only the model
  selection stays session-only, keyed per MODULE. The REFERENCE-ONLY
  grounding block (campaign premise + system +
  prior modules' FULL text) is deliberately uncapped and rides in the final
  turn, outside the persisted history — do not "optimize" it back to the generation-time
  caps (owner-directed, ledger 51).

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
- **Cover regen is delete-after-replace (swap + prune old, §2.1 cover-writer
  seam)** — chosen over detach-first and over the portrait remove+scrub+prune
  triple: modules/campaigns have no revision snapshots, so there is nothing
  to scrub — the worker swaps the slot (`createImage` then
  `patchModule`/`updateCampaign`), then frees ONLY the superseded id via
  `deleteImageIfUnreferenced`. A failed generation, a skipped job, or a
  queue dropped on reload leaves the old cover intact with a loud error; a
  row deleted between resolve and swap throws loudly and strands an
  unreferenced orphan (the next prune sweep owns it), never a dangling slot.
