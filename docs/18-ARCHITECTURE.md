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
lib} → domain`. Every upward import that exists at HEAD is enumerated in §5
(known debt) — read it before adding one, and never import a feature from a
repo.

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
  (campaign, modules, play/battle, rules, settings, bestiary,
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
  `stopEpoch`, `errors`, `debug`, `globalErrors`.
- **`src/app`** — shell: `router.tsx`, `routes.ts` (single route source),
  layout, `GlobalErrorBoundary`, theme, uiScale. `src/help` is the help
  dialog content store.

## 2. The seam index

Format: **to do X → use Y (file)** — never the anti-pattern in the last
column.

### 2.1 Data access (`src/db`)

**The destructive ladder, in one line** (escalating blast radius, each rung with
its own confirm): per-item trash (one artifact, any row) → **per-region remove
all** (`artifactRepo.deleteArtifactsOfKind` — one KIND, campaign-level rows of
one campaign; plain confirm) → "Remove all generated content"
(`campaignRepo.removeAllGeneratedContent` — everything generated, Party kept;
plain confirm) → "Clear workspace"
(`db/maintenance.deleteCampaignWorkspace` — the whole campaign bar its premise
row; the typed campaign name is the guard). The typed-name guard is the two
cross-campaign hammers' privilege, never the per-region rung (ledger 66).

| To do X | Use Y | NOT Z |
|---|---|---|
| Read/write artifacts | `artifactRepo` — every read zod-parses the row; a list feeding MODULE CREATION is narrowed first by `domain/artifact.moduleCreationPool` (the Party is excluded — `MODULE_CREATION_EXCLUDED_KINDS`, ledger 69, §2.2) | importing `db` and querying `db.artifacts` raw; passing a raw campaign list into a module-creation prompt, index or resolution set |
| Change an artifact's scope (move / adopt / publish / BULK release) | `moveToModule` / `adoptIntoCampaign` / `publishToLibrary` and the bulk form `releaseModuleOwnership(rows, tx)` (`deleteModule`'s 'keep' branch) — all funnel through the private `moveScope`, one tx incl. image re-anchor; the bulk form runs `moveScope` per row INSIDE the caller's rw tx (`ScopeTx`) so every released row gets the same revision snapshot + `updatedAt` a single move writes | a patch carrying `campaignId`/`moduleId` — `updateArtifact` pins scope fields; a `table.modify({moduleId: null})` bulk write that skips the revision contract |
| Promote an artifact on second-module use (link / roster / battle) | `db/artifactAutoPromote` — `promoteSecondModuleUses` (post-save text scans), `promoteRosterUses` (roster/seed/spawn hooks), `promoteArtifactForModuleUse[Loud]` (single-artifact) — every path funnels through `adoptIntoCampaign` → `moveScope` (no separate core state); the surface is a batched `toastSuccess` notice, never run-issue escalation | hooking render (`wiki-markdown` resolution stays pure); a second scope writer; silent promotion |
| Give a generated artifact module ownership | `artifactRepo.stampModuleOwnership` (loud existence check inside the tx) | `updateArtifact` with `moduleId` |
| Attach images (store + reference + re-anchor + prune + optional content patch) | `artifactRepo.attachImagesToArtifact` — one rw tx over images+artifacts+revisions+battles+modules+campaigns (battles rides the scope because the post-attach prune refchecks frozen boards, modules+campaigns because it refchecks cover slots — a read on an undeclared table throws); blobs are byte-prepared (`buildStoredImage`) BEFORE it opens; the optional `data` + `meta` patch lets a content write that must land with the attach (map-regenerate's layout/mapImageId/preset/siteShape/budgetAdvisory) commit atomically instead of a second `updateArtifact` write; the optional `removeImageIds` swaps gallery ids out in the same tx (single-map-slot replace, docs/11 D16); the optional `scrubImageIds` releases ONLY those ids from THIS artifact's revision snapshots in the same tx, so the post-attach `pruneCandidates` frees exactly the superseded blob — this remove+scrub+prune triple is portrait delete-after-replace (docs/11 D5 preservation rule): the old cover's history pins release atomically with the fresh cover's commit, never before | `createImage` then `updateArtifact` as separate writes |
| Point a module/campaign cover slot at a stored image (the cover-writer seam) | `features/covers/cover-image-queue.attachCover` — `createImage` then `patchModule` / `updateCampaign` carrying `{coverImageId}` (loud existence check: a row deleted mid-flight throws NotFoundError, never a dangling slot); modules/campaigns have no revision snapshots, so no scrub step exists — regen is swap-then-`deleteImageIfUnreferenced(old)` (delete-after-replace, §5) | routing a cover write through `attachImagesToArtifact` (artifact-only seam: gallery/snapshot semantics that cover rows don't have); clearing the slot before the replacement lands |
| Write rule chunks | `chunkRepo.writeChunks` (`putChunks` alias) — invalidates the keyword index with the write | `db.chunks.bulkPut` anywhere else; backup restore MUST route through this door |
| Get/create the live battle for a module | `battleRepo.ensureBattle` — the v16 unique `&moduleId` index is the arbiter | get-then-create across two transactions |
| Cite a library creature from an encounter roster (no artifact, nothing created) | The roster's `source` (`rulebook` / `npc-ref` / `inline` / `none`) + `db/creatureRepo.resolveCreatureCitation` — a citation names the BESTIARY (chunk id, else the content hash recorded at citation birth) and materializes nothing | the retired `mobArtifacts.getOrCreateMobArtifact` (docs/17 row 106)ing it away from the first module | scan-then-`createArtifact` in separate txs (splits token identity); moving a placed mob artifact to another module |
| Cast a library creature as this campaign's OWN npc (the Aunt Agatha path) | `db/creatureRepo.castCreatureAsNpc` — ONE function, idempotent per (campaign, module, name, IDENTITY): it creates the row on first cast, REUSES it on the second (writing nothing), refuses a same-named rival that draws from a different creature, refuses to cast over an authored npc, and refuses a creature the library cannot supply. Only the MODULE generator and the bestiary spawn dialog hold it | `createArtifact` plus a hand-written `creatureRef` at a call site; any cast attempt from the encounter side (structurally impossible — the roster schema cannot express one) |
| Ask the MODULE GENERATOR for a cast (the Aunt Agatha path, docs/17 row 107) | The entity record's optional `bestiary` slot (`domain/module.ts` — `{ creature, book? }`, the creature's name as the library spells it, `book` only when two books share it) + the spine clause `llm/promptStyles.spineEntityKindsClause` (rendered ONLY when `db/creatureRepo.listLibraryCreatures` is non-empty, so an empty library composes the pre-change prompt byte for byte) + `features/modules/entity-batch.libraryCitationForEntity` resolving the NAME to a citation at finalize and casting through `castCreatureAsNpc`, which is also where a persona run is NOT started (the stats are the library's, the prose is the module's own paragraphs about the entity). A name the library cannot supply, or one two books both carry, FAILS the entity loudly by name into the batch's existing `failed[]` | writing `creatureRef` by hand at a call site; a second creature lookup or a second cast function; guessing between two candidates; dropping the prose into a statless twin; making the clause unconditional (an unconditional clause changes the prompt for every workspace that has no bestiary) |
| Ground an UNCITED roster entry's on-demand creature (inline/none) | The roster entry ITSELF — its name + `notes` are the identity (`domain/creature.contentCreatureKey`) and the portrait prompt's whole grounding (`MobPortraitJob.grounding`); no row exists | `mobArtifacts.materializeInventedCreatureArtifact` (retired, docs/17 row 106)mmary marker; `moduleId` = encounter's when module-owned else campaign-level; roster entry NOT rewritten so seeds stay identical) + the run-engine Smith finalize's inline-statblock path (`materializeMonsterNpc` — `moduleId` = the run's `placementModuleId` when placed, campaign level otherwise, matching the encounter/generate create sites; reuse prefers a same-named row the USING module already owns and never re-scopes the row it links — a scope change is only ever `moveScope`) + `features/campaign/mob-portrait-queue.enqueueInventedCreaturePortraits` (chunk-less local-only jobs — invented covers never read/populate/overwrite the global cache). Superseded: docs/fix-02 put this path at campaign scope, which made a module-placed encounter's inline mobs survive `deleteModule` | a new kind or a `monsterChunkId` marker on a chunk-less row; rewriting the entry to npc-ref (changes seed identity); materializing at campaign level regardless of placement |
| Global mob portrait per cited chunk (canonical only, all campaigns) | `db/mobPortraitCache` (firewall `cacheKeyForMonsterSource`, read-through `fillCoverFromCache` (now called by NO production path: the portrait BATCH stopped passing it while enumerating — ledger 83: a cover-less canonical citation is a normal job whose worker clones the populated slot, so a visible hole is reported as WORK, never as `alreadyImaged`), render `cloneCachedPortraitToArtifact` — first-time clone skips imaged artifacts, the `force` flavor force-clones delete-after-replace for regen — plus artifact-to-artifact `cloneArtifactCover` for the content-regen carry-forward; all three ride the ONE `attachClonedCover` core, never a second mechanism — first-publish `storeCanonicalPortraitIfAbsent` — put-if-absent ONLY) + `features/campaign/mob-portrait-cache-queue.ensureCanonicalMobPortrait` (cross-campaign single-flight; Dexie v18 `mobPortraits` table `id, &chunkId`; docs/11 D5 amendment). Regen republishes through `replaceCanonicalPortrait` (the ONLY unconditional slot writer) via `regenerateCanonicalMobPortrait` (the ONLY always-fresh generation) — never `storeCanonicalPortraitIfAbsent` for a regen (it would keep the old bytes) | generating per campaign; attaching the shared global row as a cover; a flavored citation writing the cache; republishing the slot anywhere but `replaceCanonicalPortrait` |
| Count a mob-portrait batch before acting (the encounter editor's confirm) | `features/campaign/mob-portrait-queue.planMobPortraitBatch` — the read-only half of `enumerateBatchKinds`, the SAME enumeration the additive batch (`enqueueMobPortraits` / `enqueueInventedCreaturePortraits`) and both regen paths walk: it resolves what EXISTS (`findMobArtifactByChunk`, `mobArtifacts.findInventedCreatureArtifact`) and creates, clones and enqueues NOTHING; a dangling stamped `mobArtifactId` throws loud in both modes | a second enumeration that drifts from the batch (the confirm would promise work the queue will not do); counting by creating or cloning |
| Regenerate a mob / invented-creature portrait | `features/campaign/mob-portrait-queue.regenerateMobPortraits` (rulebook batch: validate → republish canonical slots fresh → enqueue delete-after-replace regen jobs `regen: true` for the imaged artifacts + the normal cover-less batch for the remainder) / `regenerateSingleMobPortrait` (battle-card single mob: the same three phases on one resolved target) / `regenerateInventedCreaturePortraits` (uncited: materialize → regen jobs for the imaged + the normal invented batch for the cover-less remainder) — delete-after-replace is the one way (docs/11 D5 preservation rule): the worker generates fresh bytes, then the attach seam swaps the cover in ONE tx (fresh cover commits, ONLY the superseded ids are scrubbed from that artifact's snapshots and refcount-pruned); a failed republish throws loud with all old covers intact and nothing enqueued; a failed, skipped, or queue-dropped regen keeps the old portrait with a loud error — regen entries upgrade (withdraw-then-enqueue) any stale queued/in-flight normal job for the same artifact so the dedupe can never strand a regen as a silent skip — the encounter editor's batch confirm chooses between the additive fill and this replace path from the read-only count (ledger 83), and states the shared-republish consequence BEFORE the click | detaching first (`removeImageFromArtifact` in a regen path — destroys the blob AND the restore path before the replacement exists); a second detach/enqueue path; re-enqueueing an imaged artifact expecting fresh bytes (the skip branch + cache read-through return the OLD art — a no-op regen); detaching without re-enqueueing (strands initials) |
| Show a creature's portrait, and write it — THE one reading and THE one write | `db/creatureRepo.creatureCoverImageId` (presentation row for the identity → the CAST npc's own cover → null) / `setCreatureCover` (insert-or-replace + release the superseded blob when nothing else pins it). Every renderer asks THIS, so two surfaces cannot disagree about whether a creature is illustrated | a per-surface art reading; `carryMobCoversForward` (retired with the mob artifact, docs/17 row 106)r → new roster, same-name rulebook entries, cover-less new row inherits the old row's cover via `cloneArtifactCover`); old rows stay as orphans | re-citing without carrying (abandons the cover while tokens fall back to initials); deleting the old row as part of the carry |
| Read / patch settings | `getSettings` (write-creates defaults) / `readSettings` (pure — liveQuery-safe) / `updateSettings` (tx, schema-validated merge; existing rows merge over defaults). The read is TWO parts: `coreSettingsSchema` (every load-bearing setting, strict) + the New Module draft validated on its own — see the draft row below | raw `db.settings` reads without the defaults-merge parse; a settings read that fails because of a CONVENIENCE field (docs/17 row 76) |
| Persist the New Module dialog's draft (owner request, docs/17 row 70) | `domain/settings.newModuleDraftSchema` — ONE settings field, `newModuleDraft`, REQUIRED-but-NULLABLE like `lastModule` (`null` = nothing stored; a row/backup written before the field parses as null), TAGGED with `campaignId`; the dialog prefills it only when the tag matches the campaign being created in, overwrites it (never merges across campaigns), debounces the save and FLUSHES on run start / dialog close / unmount, and offers **Reset to defaults** as the escape hatch. Deleting a campaign clears a draft tagged with it (`campaignRepo.deleteCampaign`); the two campaign WIPES deliberately KEEP it (`removeAllGeneratedContent`, `maintenance.deleteCampaignWorkspace` — it is authored input and retry-after-reset is the feature). A stored draft that no longer validates is SCOPED to the draft (docs/17 row 76, ledger decision after the owner's recommendation): `readStoredNewModuleDraft` returns `{ draft, error }` — never a half-value — and the dialog, the ONE consumer that shows a draft, reports the failure with `toastError` (once per open, keyed by message) and opens at its own DEFAULT levels rather than half-prefilling from data the app cannot read. The load-bearing settings around it stay readable, so a legacy row whose draft names an artifact kind that was since RETIRED cannot brick the app; the old contract (`readSettings` itself rejects, the dialog hits the error boundary) is in the git history before `84e77a9`. The prefill itself: the user's typing always wins (the form's "edited" mark is armed SYNCHRONOUSLY by the interaction, never by an effect) and the row stays the source of truth until then (a newer snapshot is re-applied while the form is untouched, and only the user's edits are ever written back — docs/05 §New Module dialog) | a per-campaign MAP (a second record shape that every delete path would have to sweep — the orphan class closed twice already); prefilling an untagged or foreign draft; clearing it in a wipe (defeats the retry); returning a corrupt draft as a value, or prefilling it silently (AGENTS 1/3); letting one unreadable draft fail every settings read in the app |
| Show an image | `useImageUrl` (`features/images/use-image-url.ts`) — object URLs revoked on change/unmount | `URL.createObjectURL` without revoke |
| Bring an image INTO the app (upload or generated blob) | `imageIntake.intakeImage` — EXIF-safe decode, ≤1600px long edge, WebP re-encode | ad-hoc canvas/FileReader scaling |
| Store map candidates mid-run | `imageRepo.createImage` per candidate — deliberately UNATTACHED until the pick step attaches via the seam; top-level use only (inside a tx: `buildStoredImage` before it opens, `db.images.put` inside) | attaching candidates eagerly |
| Delete a module / campaign / artifact | `moduleRepo.deleteModule` ('cascade' \| 'keep' \| 'promote-referenced') / `campaignRepo.deleteCampaign` / `artifactRepo.deleteArtifact` — 'promote-referenced' adopts outside-referenced rows (fresh `modulesReferencingOwnedArtifacts` scan: wiki-graph edges (module prose), artifact `links[]` relations, artifact BODY wiki-links, roster `npc-ref`/`mobArtifactId`, battle tokens/seeds — over the READER'S pool, campaign rows PLUS the global library, so a published encounter's citation counts) BEFORE the tx, then cascades the rest; 'keep' releases through `releaseModuleOwnership` (the scope seam, above); the list dialog shows the third state with the referenced names AND a separate REFERENCE census of the shared campaign-scoped mob artifacts its encounters cite (`mobArtifacts.countMobArtifactsCitedByModule` — never ownership: `deleteModule` does not touch them). **Durable version rows die in exactly ONE place**: `moduleVersionRepo.deleteModuleVersionsForModules(moduleIds)` (§2.3 simple undo) — `deleteModule` calls it with its own id, and EVERY bulk module delete does too (`deleteCampaign`, `removeAllGeneratedContent`, `deleteCampaignWorkspace`), always INSIDE the callee's delete transaction with the ids re-listed in that same tx immediately before the module rows go (afterwards the ids are unrecoverable; the tx holds `db.modules`, so no concurrent insert can land between the re-list and the sweep — the seam behaves identically in every caller). There is deliberately NO campaign-scoped query to use instead: `moduleVersions` carries no `campaignId` (`moduleId` is the only key) and adding one would be a Dexie version for a delete-only concern. `moduleVersionRepo.pruneOrphanedModuleVersions()` (distinct `moduleId` index keys vs the live module primary keys — ids only, never the `docText` rows) is the orphan DOOR the three campaign wipes also call: rows whose module row is already gone (residue from a build that predates this seam, which no module-keyed sweep can reach) are garbage by definition — a row is only ever written for an existing module — so collecting them is safe and cannot touch another campaign's live stack. `deleteModule` frees its own cover blob after the row delete (captured before, `deleteImageIfUnreferenced` after — the refcheck's cache-table read cannot join the delete scope); `deleteCampaign`'s image sweep frees module + campaign covers with everything else | ad-hoc cascades — these are transactional, recount-honest (rows re-listed inside the tx), scrub battles/links/images; a per-site copy of the version delete (one seam, four callers); stringifying a Dexie `IndexableType` key into a "uuid" (the seam throws on a non-string key instead of silently skipping a corrupt row) |
| Remove ONE kind's campaign-level artifacts in one campaign (the campaign tree's per-region "remove all") | `artifactRepo.deleteArtifactsOfKind(campaignId, kind)` + its live census `describeArtifactKindRemoval` — ONE rw tx over exactly the tables `deleteArtifact` needs, the campaign's rows of that kind re-listed INSIDE it (a row created after the confirm counted is swept by the same pass and counted), then nested `deleteArtifact` per row (subset scope ⇒ joins the tx, so any failure rolls the whole pass back — no partial run can reach a success toast); `imagesPruned`/`battlesDeleted` are MEASURED across the pass and the other counts come from the same in-tx inspection the census uses, so the confirm and the toast cannot drift; idempotent (zero rows = honest zeros), unknown campaign is loud. Guards: **campaign-level rows only** (`moduleId === null`, so module rows, module prose, module entity records and module version stacks are out of reach), **the global library is structurally untouchable** (the doomed set is derived from `campaignId`, so the `campaignId === null` class is never even scanned; the campaign image prune cannot see a global blob), **the Party is refused** through the domain constant `BULK_REMOVE_EXCLUDED_KINDS` (read by the tree AND the seam — never a scattered `kind !== 'pc'`). Census honesty (the confirm names these, live): surviving artifacts that lose back-links, scrubbed battle tokens + boards that empty out and delete themselves, seeded boards that lose their encounter, encounter roster entries falling back to the loud `missing ref`, freed images, and that there is NO undo for artifacts. Audited paths deliberately left dangling (all identical to the per-item trash today): run `targetArtifactId`/`contextArtifactIds`, battle `seedFighters` rows, encounter rosters (rewriting an authored roster behind the GM's back would be worse than the badge); `imageRepo.referencedImageIds` takes an optional exclusion set so the census's image count comes from the ONE coverage scan instead of a second copy | a loop of per-item `deleteArtifact` calls (no cross-call rollback); `db.artifacts.bulkDelete` (strands revisions, links and battle tokens); a remove-all on the Party region or the Library group; a second reference-coverage scan written for the dialog |
| Remove all generated content (fresh generation start, Party kept) | `campaignRepo.removeAllGeneratedContent` — ONE tx over every touched table, rows re-listed inside; per-row disposal rides nested `deleteArtifact` (subset scope, joins the tx), battles/modules/runs go by campaign sweep, **the wiped modules' durable version rows go WITH their modules in the same tx** (`deleteModuleVersionsForModules` with the module ids re-listed in-tx + `pruneOrphanedModuleVersions` — the sweep seam in the row above; undo history is not kept content), orphans prune via `pruneUnreferencedImages` (campaign rows only — library images structurally immune); in-flight module passes abort BEFORE the tx (native-promise import must never gap a Dexie scope) | per-module `deleteModule` calls outside a shared tx (no cross-call rollback); a second wipe implementation anywhere else; a second version-delete implementation |
| Clear one campaign's workspace (FULL reset, premise kept) | `db/maintenance.deleteCampaignWorkspace` — the `removeAllGeneratedContent` discipline (ONE tx, in-tx recount, nested `deleteArtifact`, campaign sweeps, prune, last-module shortcut clear, pre-tx `cancelModuleGen`) over EVERY artifact kind INCLUDING `pc` (the wipe keeps the Party — this one does not); keeps ONLY the campaign row, rulebook ingests (global source material, not campaign-keyed), the global portrait cache/library/personas/settings, and every other campaign — **the cleared modules' durable version rows are NOT kept**: they go with their modules in the same tx through the one sweep seam + its orphan door (row above), and the confirm copy names them so the dialog never implies undo history survives; the Edit-campaign confirm types the campaign NAME (exact, case-sensitive) with a one-at-a-time loud refusal, toasts loud naming the campaign, navigates out of deleted child routes, and needs NO reload (live queries refresh) | routing a full reset through the Party-keeping wipe (strands PCs); the global `deleteAllData` for a one-campaign job; hand-written `/c/…` prefix checks (use `campaignIdFromPath` + `workspacePath`) |
| Backup / export / import | `lib/backup.ts` (whole-DB restore rides `db.transaction('rw', db.tables)` + the chunk door; `OPTIONAL_TABLES` lists `moduleVersions` beside `pdfFiles`/`mobPortraits`, so a PRE-undo zip — one whose manifest predates the v19 table — restores with an EMPTY undo stack instead of failing the missing-table check) / `lib/exportImport.ts` (campaign export v2: modules/battles/runs + `dependencies` manifest, and `RETIRED_EXPORT_TABLES`/`retiredTableRows` counting the rows of a table this build no longer has — reported on import, never dropped in silence; import = ONE tx over the eight tables, array form, with module/artifact re-id maps rewriting every reference — an artifact whose exported `moduleId` is not in the file demotes to campaign level ONLY on a v1 file (the documented legacy rescue) and THROWS loudly on v2, the battle path's precedent, because demoting would move a row out of its module; `parseExportTolerant` is the import boundary's tolerance stage — strict first, then per-row retired/drift triage with skip-count, reassembled output strict-parsed before return) | table-by-table writes that can strand a half-import |
| Decide whether a module-owned orphan is deletable (the ONE guard predicate) | `orphanSweep.evaluateOrphanGuards(candidates, input)` (db/orphanSweep.ts — PURE, every input a value the caller already holds): the five guards in their load-bearing order (campaign-wide mention → ambiguity shadow → battle portrait token → frozen seed fighter) plus the SURVIVING-encounter roster pass, returning `refusal`/`null` per candidate with the loud reason text and the `moduleMentionedIds`/`shadowedIds` sets. The sweep assembles the FULL bundle from rows re-listed inside its tx; the panel passes the subset its props can see (`entity-orphans.panelOrphanGuardInput` — `campaignModules: [module]`, no battles), and `orphanOfferView` composes the derivation with the refusals a sweep RETURNED. Both surfaces therefore decide "deletable" with ONE function, pinned per candidate in `tests/features/orphan-offer-agreement.test.ts` | a second walk of the guards at read time (the owner's "Delete 2 orphans" offered two roster-cited creatures the sweep always refuses — ledger 92); a panel-side copy of the mention gate, the battle/outline guards or the roster pass; reading a guard's reason string to decide anything |
| Delete a module's orphaned entities (the guarded sweep) | `orphanSweep.sweepOrphanedArtifacts` (db/orphanSweep.ts — owns `ORPHAN_KINDS` + the orphan definition; docs/08 §M4-C "Orphaned entities", 14 §7) — ONE rw tx (array form: artifacts, revisions, images, battles, modules, campaigns) that RE-DERIVES candidates from re-listed rows INSIDE the tx (recount) and decides them with the shared `evaluateOrphanGuards` predicate (the seam row above): campaign-wide mentions via UNCAPPED `buildWikiGraph`, ambiguity shadow, battle `tokens[].artifactId` + `seedFighters[].id` on ANY campaign battle, encounter roster `npc-ref`/`mobArtifactId` on any SURVIVING encounter (SAME-module counts — the module survives); per-artifact outcomes `deleted`/`kept`+reason for ONE caller toast; deletes ride the frozen `deleteArtifact` nested (subset scope) | deleting per artifact with an ad-hoc hand-rolled cascade; trusting a dialog count instead of the tx recount; a silent drop of a guarded row |
| Tag a module's unmentioned entities and offer only what a sweep will delete (read time) | `entity-orphans.deriveModuleOrphans` / `useModuleOrphans` / `orphanOfferView` (features/modules — pure over the panel's EXISTING props `module` + `artifacts`; no live query, no new props): module-owned rows of `ORPHAN_KINDS` with zero resolving wiki-link mentions in THIS module's prose, mentions via `buildWikiGraph` tokens (reader semantics), each row carrying the shared predicate's verdict; ambiguity-shadowed rows stay out of the group; a guard-refused row renders as IN USE with the sweep's own reason and no trash; `orphanOfferView(rows, recordedSweepRefusals)` composes the derivation with the refusals a sweep returned (panel view state), so the count/button/dialog list only what a sweep will delete and a refusal never re-offers the row | `countOccurrences` substring scans; a panel-side campaign-wide copy (the sweep re-derives the gate in-tx); a second orphan predicate outside the sweep's `orphanCandidatesOf`; counting rows a guard refuses (ledger 92) |
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
| Monster level → sort key | `encounterRoster.parseLevelSort` | a second level parser — the module creator's window reads it too, over the chunk's own `statBlock.level` (docs/17 row 114) |
| **Show a prompt the creatures it may name** (docs/17 row 114, docs/12 §7) | `llm/creatorRoster.collectCreatorRoster(targetLevel?)` — builds the creator's window from `db/creatureRepo.listLibraryCreatures()` (the SAME pool the cast resolves against: every stat-block chunk, ANY book origin), orders it with the SHARED `encounterRoster.libraryLevelOrder` (level distance to the module's band midpoint, ties by levelSort then locale name, `"—"` last) and caps it at `CREATOR_ROSTER_LIMIT = 300` with the `(roster truncated; N more)` note; `moduleGen.spineMessages` is the ONE caller (its target is the module's `(levelMin + levelMax) / 2`) and hands the window to `promptStyles.spineContractValues`, which appends the rule plus the listing to the entity-kind clause. Recomputed per run, never persisted | a pack-only window (the encounter roster's own filter — it would be EMPTY for a rulebook-built library while the slot stayed on offer, i.e. the owner's defect with a different trigger); a second chunk read to find a level (the pool carries the `statBlock`); a second level parser; a private comparator; a slot offered without its vocabulary; a persisted or cached window |
| **Turn a cast refusal into a NEXT STEP** (docs/17 row 114) | `llm/creatorRoster.nearestLibraryCreatures(wanted, pool, limit = 3)` over `domain/creatureName.creatureNameSimilarity` (token overlap or normalized edit similarity — case, whitespace, umlauts/diacritics, hyphen-vs-space and a trailing `(…)` qualifier all normalized away), rendered with the library's own book labels by `features/modules/entity-batch`'s no-such-creature refusal, and ONLY there. Below `CREATURE_SUGGESTION_FLOOR = 0.4` the list is EMPTY and the pre-114 sentence stands, byte for byte | fuzzy RESOLUTION of any kind (that is `sameName`'s exact match, unchanged — a near miss still fails); auto-substituting the nearest creature; widening `sameName`; rendering a suggestion when nothing is close (a second wrong answer is worse than none) |
| Bestiary/item pack data | `ingest/packFetch` (only networked surface; newest-first with pinned-verified-ref fallback) → `packImport` → `packs/registry` adapters | fetching upstream files anywhere else; adapters stay network-free (test-pinned) |
| PF2e rules text (journal pages, conditions, feats/spells/actions corpus) | the same pack lane, third entry type: rules-text fetch sources (`packFetch`, `packDirs`-scoped) → `packImport` `sections` → `packs/pf2e-journal` / `pf2e-conditions` / `pf2e-rules` adapters → `section` chunks with per-entry Source lines | HTML scraping (there is none — the machine-readable packs are the one way; docs/12 §15); a second retrieval path — `encounterRoster` skips `section` chunks like `item` chunks |
| Ground a mob portrait in a creature chunk | `portraitGroundingForChunk` (`llm/imagePromptDraft.ts` — stat-exempt: size + creatureType identity plus traits/actions/reactions/legendary prose, every numeric field out by field, 800-char cap; null statBlock falls back to raw `chunk.text` as the loud residual render risk) + the default-on text-render guard (docs/11 D5, generalized: `IMAGE_TEXT_NEGATIVE` is the DEFAULT `negative` of the shared Illustrator contract — covers, entity images, portraits, the run-engine prompt draft, classic stylize, and the appearance shortcut are all guarded; the `negative` option stays the explicit-override seam; `MOB_PORTRAIT_TEXT_NEGATIVE` survives as the identical alias; the vision dungeon path is the one documented carve-out — its tailored plaque clause instead of the blanket list) — docs/11 D5 | feeding raw `chunk.text` into `buildImagePrompt` (image models render stat digits into portraits) |
| Ground a module/campaign cover prompt (no chat call) | `features/covers/cover-image-queue.draftPrompt` — the shared Illustrator contract (`buildImagePrompt` + `assembleImagePrompt`): a module grounds on title + concept (summary) + the full document text (`moduleDocumentText` — premise + parts), a campaign on name + description (summary, no body), styled by the owning campaign's system label; empty grounding throws in `buildImagePrompt` (describe the slot first — never a blank cover) | a prompt-crafting chat call (removed owner-directed 2026-09-05); grounding a module on its entity stubs instead of its document text |
| Background job pump (portraits, entity images, maps, covers) | `lib/jobQueue.createJobQueue` — inherits dedupe, cancellation, failed-list + retry, dock counters | a hand-rolled worker loop |
| Entity generation (batch AND single stub) | `features/modules/entity-batch.runEntityBatch` (the stub popover delegates a 1-target batch via `entity-detail.generateSingleEntity`) | a second "detail one entity" implementation (`chainRunner` is for Writers'-Room chains, not this) |
| Record what the owner asked creation to automate (owner decision, docs/17 row 71) | `domain/module.moduleAutomationIntentSchema` → the module row's additive optional `automationIntent` (`autoGenerateKinds`, `autoImageKinds`, `autoGenerateBattlemaps`, `autoGenerateMobImages`), written by `createModule` in the same call that starts the run and typed with `satisfies` so it can never drift from the row's own automation fields; `null` on every pre-existing row (legacy rows stay INERT — their automation fields describe what the engine did, never what the owner asked for). A later "Resume automatic module creation" surface DERIVES deviation by comparing this intent with the live state | storing a `hasProblems`/`deviates` verdict beside it (goes stale the moment the owner fixes or re-breaks the module — derive, never cache; the ban is stated in the schema's doc comment); inferring intent from a legacy row's automation fields; reading the intent back out of the dialog |
| Repair module TEXT for a failing check ("Fix module problems", owner request, docs/17 row 74) | `moduleGen.repairModuleEncounterFloor(moduleId, campaign, planIndexes)` — the ONE user-invoked text repair: it re-derives the scope from the live row (`floorRepairTargets` — the same scope the confirmation was built from, so it can only ever rewrite LESS than promised), writes a `snapshotModuleVersion` row BEFORE the attempt, sets the row `'generating'` so the canvas Stop and `stopAllGenerations` reach the in-flight call, rewrites each deficient part through the EXISTING floor-repair seam (`generatePart` with `floorRepairRewriteInstruction` — `floorRepairInstruction` plus the finale/cost tail — and `repairModel`), then re-runs `normalizeModuleEntityNames` (the floor counts links whose RECORDED kind is `encounter`, so a rewrite alone would not move the number) and recounts: met ⇒ `'ready'` plus one success toast, still short ⇒ `'failed'` with `encounterFloorMessage` loud, a part whose call threw ⇒ its pre-repair row restored byte-identically plus a loud per-part toast. ONE attempt per part per invocation; the stop epoch is captured at entry and checked between parts | a SECOND repair path (the rewrite rides `generatePart`, never a private prompt or call); retrying a failed part (no retry loop, no candidate slate); rewriting without a prior `snapshotModuleVersion` (the snapshot precedes the ATTEMPT — a failed attempt leaves a restorable, unchanged version rather than no version); entity, image, map or portrait work under this action; a hand-edit guard that silently skips a part the owner confirmed (the confirmation names hand-edited parts and says the rewrite replaces the text); adding a runtime gate, or changing the floor's schema, resolver, message or goldens |
| Module prompt STYLES (editable layer, owner decision, docs/17 row 86) | `src/llm/promptStyles.ts` — the ONE place the module prompts live: the CONTRACT texts (`SPINE_REPLY_FORMAT`, `SPINE_ENTITY_KINDS`, `SPINE_SCENE_KINDS`, `SPINE_WIKI_LINKS`, `PARTS_REPLY_FORMAT`, `PARTS_GM_ADDRESS`, `PARTS_WIKI_LINKS`, `PARTS_MECHANICS`, `PARTS_ENCOUNTER_CASTING`, `PART_ENDING_LINES`), the immutable built-ins (`BUILTIN_PROMPT_STYLES` = Classic, today's text verbatim; Story, beats instead of the ten-field block; **Freestyle** — the shape-free experiment of docs/17 row 87: the setting, the technology and the goal, and NONE of the field list, beat template or craft-discipline bullets the other two carry, while keeping every contract clause and stating the encounter floor's link dependency as technology — what the app counts — rather than as a heading rule), `modulePromptStyleOf` / `promptStyleForModule` (a module with NO recorded style resolves to Classic as `source: 'legacy-classic'` — provenance, not a fallback) — **the resolution ORDER is one sentence: the module's RECORDED style then, with nothing recorded, Classic by provenance; the app default is NOT a rung** (`settings.defaultPromptStyleId` — Freestyle since docs/17 row 88 — is consulted only where no style has been recorded for the module being CREATED, `moduleGen.resolveCreationPromptStyle`; §4) and the per-surface contract value builders `spineContractValues` / `partsContractValues`. A style is DATA (`src/domain/promptStyle.ts`, which also carries the id constants — `PROMPT_STYLE_CLASSIC_ID` (provenance) and `PROMPT_STYLE_FREESTYLE_ID`, the product default of docs/17 row 88, which the two settings defaults and the `freestyle` built-in entry all use instead of a literal): `templateText` sectioned by `--- SPINE ---` / `--- PARTS ---`, `{{named placeholders}}` (`PROMPT_STYLE_PLACEHOLDERS` is the vocabulary; contract tokens are `contract.*` and REQUIRED per surface), `validatePromptStyleTemplate` (unknown token / wrong surface / missing section / missing required clause / empty — each named, each fatal) and `composePromptFromTemplate` (substitutes values WITHOUT re-parsing; a placeholder alone on a paragraph disappears when its value is absent, alone on a line it leaves an empty line, inline it substitutes in place — all three are pre-style behaviour, pinned byte for byte) | a second prompt-building path beside the composer; a style omitting a `contract.*` clause (the validator names it and the composer refuses before any model call); editing or deleting a style reaching a module that already exists (a module RECORDS `{id,name,version,templateText}` on its row and every resume/repair/regeneration composes from that copy — `promptStyleForModule`); treating Classic as "the default that may drift" (its bytes are pinned by `tests/llm/promptStyles-classic-identity.test.ts` over fixtures rendered from the pre-style builders); storing styles in a new Dexie table (they live on the SETTINGS row — no version bump, and `settingsRepo.updateSettings` carries a field it does not own forward VERBATIM so a settings write cannot clobber them); building a prompt's instructions inline in `moduleGen` again |
| Module generation | `moduleGen.runSpine` / `runParts` / `approveSpineAndRun`; every artifact list these passes and the entity workflow build is the MODULE-CREATION POOL — `domain/artifact.ts` `MODULE_CREATION_EXCLUDED_KINDS` (`['pc']`, ledger 69) through `visibleToModuleCreation` / `moduleCreationPool`, ONE constant and never a scattered `kind !== 'pc'`: the shared cast block (`campaignCastContext`), the spine/parts "Existing campaign entities" indexes, the normalization artifact index + the incremental classification's resolved set, `post-generation`'s batch/image targets, `use-module-entities.useModuleEntities`' resolution and the stub popover's classification — the Party is AUTHORED, not campaign setting content, so a generated name equal to a PC's becomes a NEW module-owned entity instead of silently binding the module to a player character (a verdict that tries anyway fails the existing canonical validator and is recorded LOUD on the module row); reading surfaces keep the FULL pool (`resolveWikiLink` unchanged); entity name normalization via `normalizeModuleEntityNames` (one LLM call, never heuristics — fix-01); names the text picks up LATER (chat apply, hand edit, board rewrite, a cancelled parts run whose pass never fired, version restore) via `moduleGen.classifyNewModuleEntityNames` — the SAME pass narrowed to the names that have no record (same prompt builder/contract/validator/one retry, recorded canonicals as the legal canonical vocabulary, records APPEND-ONLY via `mergeNewEntityRecords`, consent proposals unioned via `mergeEntityRewriteProposals`), observed from the panel's fresh module-text read (`domain/entityNormalization.unclassifiedEntityNames`, pure — one event-free observation point) and dispatched by ONE explicit toolbar click, never by a render (owner stance on unrequested LLM calls, docs/17 row 9); the hard encounter floor via `countModuleEncounters` (pure: distinct canonical `[[encounter]]` links in `moduleDocumentText` against the MODULE'S OWN floor — `domain/module.encounterFloorGuardrailFor(module)` resolves the row's additive optional `encounterFloorGuardrail` (`{ enabled, perLevel }`) or today's default 1-per-level — per-band via `levelsInLevelBand`) + `assertEncounterFloor` (spine gate: zero encounter records → one escalated repair, then loud; parts gate: after re-normalize, before ready — one escalated repair rewrite per deficient part, hand-edited parts untouched, still short → `failed` naming parts + toast, automation tails skipped). The SAME resolved number renders every prompt clause it gates — `spineMessages`' floor bullet, the spine repair retry, the parts-pass per-part share and the floor repair — so a gate can never judge a different rule than the one the prompt asked for, and a disabled floor removes clause, gate and repair TOGETHER; every consumer reads it from the ROW, so a repair, a retry or a later pass uses the module's own rules, never a dialog's current state (owner decision, docs/17 row 70; golden-tested byte-identical at the default, `tests/fixtures/encounterGuardrails/`); what a scene IS and how conflicted the story must be are PROMPT DISCIPLINE, never a gate: an `encounter` is a FIGHT (battle map + monster roster, the only artifacts `post-generation` gives maps and mob portraits to — it filters both by `kind === 'encounter'`), anything else is an `event` (illustration only, no map, no monsters, no roster), and the conflict demands (contested situation whose carrier may shift, at least two VISIBLE approaches per situation differing in cost or consequence, a resolution that leaves someone worse off / a cost paid / a new problem opened, persistence of what the party changed, an antagonist visible from the first part, one non-swappable particular per scene, no NPC ally more bound to the plot than the PCs) ride `spineMessages` + `partsMessages` in the planner's/writer's voice with the three non-negotiables restated LAST; the retired `wants`/`conflictKind` declarations, `ENCOUNTER_CONFLICT_KINDS`, `assertEncounterMix` / `encounterMixMessage` / `encounterMixReport`, the `>= 1` mix thresholds and `requireEncounterDeclarations` are GONE (owner decision, docs/17 row 72; docs/08 §M4-B-1) — the declaration gate had no consumer beyond the declarations it demanded, so it measured the planner's wording instead of the module; every scene a generated part contains is written as a labeled SCENE BLOCK — a GM-facing SCAFFOLD inside ordinary part markdown, one field set in one order — `PART_SCENE_FIELD_LABELS` + `classicSceneFieldBullets()` in `src/llm/promptStyles.ts` are the ONE source (they moved out of `moduleGen` with the style layer, docs/17 row 86) and they belong to the CLASSIC STYLE, so a Story-style module has no field list at all and a Freestyle-style module prescribes no shape of any kind (the ENCOUNTER/EVENT tag, Where, First impression, Who is here and what they want right now, The situation, What changed, If the party acts, Secrets, Leads, Outcome — docs/08 §M4-B-2), with the ANTI-FORMULA demands (`PART_SCENE_VARIATION_DEMANDS` + the part-level rules, classic-style only) in the SAME instruction block immediately after the field list and pinned verbatim by test (the owner's explicit fear: "I dont want this to become formulaic. I fear that if we prompt this creativity gets lost.", docs/17 row 73). The block is a DOCUMENT-FORMAT convention ONLY: it lives in the part's markdown string, so it adds NO schema, NO Dexie version, NO migration and NO second document format, and the ENCOUNTER/EVENT tag is TEXT for now (maps, monsters and rosters stay decided by the entity's recorded `kind === 'encounter'` in `post-generation`). The one exception to "text only" is deliberate and load-bearing: the scene's HEADING carries its `[[link]]`, because the floor counts canonical `[[encounter]]` links in the part text — a scene named only in passing prose would be invisible to the counter and could fail a floor whose encounters are plainly written on the page; that is a link-syntax requirement serving the EXISTING counter, not a new gate, and the counter, its schema, its resolver, its per-part shares, its message and its goldens are untouched; the surviving tail's post-generation sweep also enqueues mob portraits for module-owned encounters when the row's `autoGenerateMobImages` is set (`features/modules/post-generation` → the mob-portrait batch `enqueueMobPortraits` — one per creature kind, skip-if-imaged, enqueue-don't-await) | any gate over PROSE (is the story conflicted, is the pacing right, is a clue fair) — a check there needs a classifier guessing at a gate, which AGENTS rules 1/3 forbid, so such a check may only be PROPOSED (docs/08 §M4-B-1 boundary); a gate or code CHECK over the scene block itself (field presence, tag mix, cardinality — "at least N routes per conclusion", "at least two factions", route counts, any ratio or quota in the block's family — the owner REJECTED these, docs/17 row 73), an alternates/candidate-slate field, or letting the tag drive maps/monsters instead of the artifact kind; a ratio/quota demand of any kind (combat share, scenes per part, art per page — the same class of error as the retired mix gate); heuristic name rewriting; a second encounter counter; repairing hand-edited parts headless; shipping a short module as ready; a SECOND classifier path for post-creation names (client heuristic or its own prompt) or records that re-key/replace an existing one; handing any module-creation step a RAW campaign artifact list (the pool is the only candidate set — the Party must not reach a prompt or a resolution set) |
| Recognize a module-forge stop | `moduleGen.isCancel(error, signal)` — the run controller's `signal.aborted` is the source of truth, never the error's type (the streaming pipeline can surface a stop as a cross-realm AbortError, a wrapped transport error, or no error at all); every cancel-vs-failure catch reads it, plus a fail-fast guard at the top of the parts loop so a stop between calls never starts the next part, a `throwIfStopped` guard at the loop's post-pass boundary (the stop that ends the LAST part would otherwise fall through to the normalization call), and `runPartsPass`'s `aborted` flag — the pass's own report of a cancel, because the persisted row CANNOT carry it (a cancelled pass keeps `'ready'` with parts present so Retry stays available, which is byte-identical to a completed pass; reading that status as "completed" is what started the post-generation sweep after a stop) | `instanceof DOMException && name === 'AbortError'` alone (fails cross-realm: probed CTOR DOMException + name AbortError with instanceof false); reading the module row's status as the completed-vs-cancelled signal |
| Treasure clauses in prompts | `treasureGuidanceFor` / `roomKeyGuidanceFor` (`treasureGuidance.ts`) | quoting DMG tables or paraphrasing Paizo numbers (licensing — docs/12 §13.2/§14) |
| Per-room challenge budgets | `roomBudget.ts` (`checkRoomBudget`, `expectedRoomThreat`, `reconcileRoomAssignments`, `roomBudgetGuidanceFor`, `fillGradeStockingFor`, `parseBudgetLevel` over `encounterRoster.parseLevelSort`) — the loop: over-band rooms lower a step through the brief's single repair turn, then LOUD advisory on step output + `data.budgetAdvisory`; complexes additionally carry the `fillGrade` stocking expectation (`src/domain/artifact.ts` — additive optional, drawn once by `drawFillGrade` when a complex first materializes with the field absent, owner value always wins) giving the lower verdicts — 'empty' (repairable on fresh complex briefs) and 'under' (advisory) — while single arenas keep "a quiet room is a feature" byte-identical; the Cartographer's stocking clauses + bounded roster EXPANSION are SHAPE-gated (`encounterDataIsComplex` — the parse-normalized `siteShape`, docs/11 D12 amendment) and key on the regeneration target's ACTUAL shape, never the remembered `preset` (a legacy complex row whose persisted preset is 'standard' still restocks; the preset keeps the grid tier/prose — D10 untouched): prefix verbatim, appended entries source-cited, cap = Σ room expectations + margin, append a DIRECTIVE for complex-shaped targets ("must append") and a permissive "MAY" for non-complex targets on a dungeon preset, prompt and evaluate gate sharing ONE authorization flag; a never-mapped target (layout null — the Smith stub) briefs unpinned-fresh whenever the contract authorizes (the MUST-style fresh-population clause + numbers + `freshCapped` cap, 1-room replies a repairable shape issue, finalize persisting the whole roster via the `freshPopulation` brief marker, the fixed-cast section threaded into the unpinned brief) while never-mapped singles and pf2e keep the verbatim pin byte-identical; re-sizing a roster against the grade rides the D18 two-button surface only (`features/campaign/encounterRegen`: Repopulate = roster-only pass, Regenerate everything = fresh full run — no standalone one-fight content button exists); the in-place fill packs unclaimed entries by nearest-band fit (round-robin fallback without expectations) | a second level parser; a second shape predicate beside `normalizeEncounterShapeData`; gating the stocking clauses on the remembered preset instead of the target's shape (the legacy-row trap); numeric pf2e budgets (Paizo licensing — docs/11 D12; `expectedRoomThreat` returns null for verbatim systems); redrawing a persisted fillGrade |
| Structured encounter level context (party of 4 at the part's level) | `llm/roomBudget.ts` (`PARTY_SIZE = 4` — the ONE party-size constant, `partyLevelLine`, `partLevelForMention`: first part in plan order whose markdown carries the encounter's `[[Name]]` mention supplies its `levelBand` as the EXACT level, multi-level bands parse to the low end, premise-only/unmentioned/unparseable ⇒ undefined with the free-text chain underneath) — the Smith draft carries it via `buildEntityBrief` (`features/modules/persona-request.ts`, encounter + npc stubs per `stubKindCarriesPartyLevel`, resolved in `entity-batch.ts` at the excerpt position) and the Cartographer brief via `runEncounterBrief` (module lookup through the target's `moduleId`); `fillGradeStockingFor`'s `promptLevel` prefers it, `parseRosterTargetLevel(levelHint/brief)` stays as fallback; the fixed cast rides the same seam (`fixedCastForEncounter` + `fixedCastSectionFor`: drafted npc-kind scene members pinned must-appear into the encounter brief, brief-time derivation from in-batch results + module text, never stored; encounters detail last via post-generation `orderedKinds`) | a second part-lookup implementation; a second party-size literal; band math over a part's levelBand; applying the module-creation Party exclusion (ledger 69) here — encounter difficulty is about LEVELS, not players, and the npc-only cast filter is not a party exclusion |
| Encounter site shape / play path | `domain/artifact.normalizeEncounterShapeData` (ONE derivation: parse-on-read + v17 backfill + backup validation) + `domain/encounterMap/schema` (`encounterSiteShapeSchema`, `spawnFirstPath`, layout `path` refine) | deriving siteShape from room count at read sites; trusting the rooms-array order as play order (packAttempt rotates it) |
| Encounter map style mode (natural site, docs/11 D17) | `domain/encounterMap/schema.resolveEncounterMapMode` (ONE derivation: owner `mapMode` override on the artifact data > brief `environment: 'outdoor'` OR `locationKind: 'wilderness'` (union) > architectural) consumed ONLY through `runEngine.effectiveEncounterBrief` (the brief step stamps `mapModeOverride`/`mapLocationKind` run facts; the mode re-derives from the EFFECTIVE brief prose, pre-mode rows read architectural) and `renderSchematic(layout, cellPx, factory, mode)` (`'natural'` = the placement-only overlay inside the same function; `'architectural'` default keeps the dungeon bytes) | branching on `environment`/`locationKind` directly at a render or prompt site; inverting the outdoor contract into terrain bans (the prose stays fully open — minimal contract, not an inverted one); stamping `mapMode` from a run (the field stays owner-owned/unset = derive) |
| Legacy persona values (removed kinds) | `domain/persona.normalizeLegacyProducesKind` (ONE `z.preprocess`: parse boundary + `updatePersona` + backup restore heal the stored row — git-proven mapping table, unknown values still fail loudly) | a catch-all kind fallback; hand-editing or deleting the poisoned row |
| Vision-located dungeon mapping (docs/11 D19) | `llm/visionDungeon.ts` (creation-path home: labeled-map prompt builder over rooms+concept, A–N labels, the 0–1000 vision locate contract + `locateDungeonLabels` locate→count-check→focused-re-ask→`VisionLocateError`, first-mark-wins dedupe) + the brief's `mapPath` marker (`resolveBriefMapPath`: rooms > 1 AND (per-run override ?? `settings.dungeonMapPath`) is `'vision'`) + `StartRunInput.dungeonMapPath` / run-row `dungeonMapPath` explicit-only (null = no override; resume/retry rebuilds carry it) + `EncounterRegenOptions.dungeonMapPath` (D18 complex-only steering, never persisted as the default; singles ignore, repopulation takes none; the unattended queue passes none so the Settings page's Encounter-maps default governs) + vision layouts (`mapPath: 'vision'`, letters + observed `x_norm/y_norm`, NO packed geometry — spawns/veils/markers resolve to the observed point, polygon consumers throw loud) | a regular/irregular toggle in the vision path (shape follows each room's description + the concept — owner clarification); inventing/defaulting a coordinate for a missed plaque (the map step fails loud, candidate pruned); aspect-normalizing the labeled map (cropping could cut plaques — the board letterboxes) |
| Legacy run rows carrying a REMOVED step | `domain/run.normalizeLegacyRunSteps` (ONE `z.preprocess` inside `personaRunSchema`: drops the deleted encounter `verify` step and re-indexes, so reads/updates heal the row and every engine continuation stays index-coherent) | executing the engine plan positionally over a shifted steps array |
| Campaign grounding for runs | `campaignGrounding.computeCampaignGrounding` + renderer (docs/15) | a second wiki-expansion implementation |
| Refill an existing artifact in place (smith kinds: pc/npc/location/event/faction/note/plotarc) | the editor's `ContentAiSection` → `contentRefillRequest` store → the persona panel's targeted generate run; grounding parity via `runEngine.targetModuleGrounding` (module document + premise rendered from the STORED retrieve output; every inapplicable state names itself) + `mergeRefillData` (preserves PC human-owned fields, curated stat blocks, the mob marker; model name → alias) | a second "detail one entity" implementation; a patch touching `moduleId`; a silent degrade |
| (Re)generate an encounter automatically (docs/11 D18, BOTH shapes) | `features/campaign/encounterRegen.ts` — the ONLY automatic surface: `repopulateEncounter()` (complex roster-only Cartographer pass `encounterScope: 'rosterOnly'` — brief with the repair loop + room-mirror + fresh cap, `runEncounterRosterFinalize` persisting ONLY `monsters` onto the preserved rooms/map; singles the Smith one-fight fill; roomless complexes refuse loud) / `regenerateEncounterEverything()` (complex row reset via `resetComplexForRegeneration` then the full pipeline with the row preset; singles the Smith draft then the unattended map queue) / `runProseRedesign()` chained when the checkbox is ticked (Smith `encounterProseOnly`: name/prose/body persist, ANY roster drift fails loud with nothing persisted); runs awaited via `runEngine.waitForRunStatus` (`awaitCompletedRun`); the editor section holds `encounter-regenerate-everything` / `encounter-repopulate` / `encounter-redesign-prose` and nothing else generates encounter content on its own (manual Clear + the unattended map queue are not generation buttons; the old panel hand-off store is deleted) | a standalone content-regen button; a standalone battlemap-regenerate button; a Smith extension restocking a dungeon (a complex repopulation is a roster-only Cartographer pass keyed on the target's actual shape); ticking the prose box to resize a roster (prose-only — it never touches monsters) |
| `event` kind mirrors `location` everywhere (social/non-combat content: GM text + showable image) | aliases, not copies — `eventDataSchema = locationDataSchema`, `eventDraftSchema = locationDraftSchema`; shared engine cases (`draftContractFor`/`dataForDraft`), shared `LocationForm`, own persona slug (`event-weaver`, never `worldbuilder`) + `REFILL_PERSONA_SLUGS` entry; EXCLUDED from battleSeed map-linking (location-only map role) and encounter/npc/statblock paths | an event-specific field (the alias would drift); mapping event onto the worldbuilder slug |
| Reject empty generation output | `substanceText` in `llm/schemas.ts` (name/summary/body ≥ 1 non-whitespace char on every draft contract; the strict schema can't express it — the zod parse rides the ONE repair turn, then loud) + the finalize re-guard (`runFinalize`: empty body refuses to create or overwrite — a refill keeps the existing content) | a prose-length floor (over-rejects short notes); a silent placeholder |
| Reject half-formed unicode escapes in generated text | `lib/encodingHygiene.findEscapeDebris` (pure: `?` + exactly 2 lowercase hex forming a non-ASCII tail, plus literal `\uXXXX` in decoded text) + `debrisIssuesForFields`/`collectTextLeaves` at the boundaries — `runEngine.runFinalize` scans the draft + statblock strings BEFORE any create/updateArtifact (hit → loud `rejected` with the debris named, nothing persists), `moduleGen.generatePart` scans normalized part prose before the ready write (hit → part `failed` with the debris named, chain continues). Detection backstop for the `language.ts` UTF-8 contract (prevention) | silent repair-and-continue; persisting debris as ready content; a second scanner implementation |
| Bind an encounter to the scene its module text stages (the ASSERTION RULE — docs/11 §The scene is the truth, ledger 89) | FOUR pieces, each encounter-only: (a) the writer's contract clause `PARTS_ENCOUNTER_CASTING` (`llm/promptStyles.ts`) — state what the fight IS and where, a stated count is binding, personal names stay off the rank and file, and the pipeline owns the casting; (b) `SCENE_AUTHORITY_SECTION` (`llm/sceneAuthority.ts`) rendered by `runEngine.runDraft` for `kind === 'encounter'` ONLY and by `runEncounterBrief` — the scene states nothing ⇒ design freely; (c) `buildEntityBrief`'s additive `encounterScene` framing (`features/modules/persona-request.ts`, set true by the encounter path in `entity-batch.ts` only) — the surrounding text becomes "The scene this encounter must stage"; (d) the additive optional `substitutions` on BOTH roster contracts (`encounterDraftSchema`, `encounterGeneratorBriefSchema`, `llm/schemas.ts` — absent/null = none declared) read through `sceneAuthority.sceneSubstitutionsOf` and surfaced by `roomBudget.substitutionAdvisories` on the EXISTING `data.budgetAdvisory` + step-notice seam, at all four encounter finalize seams | editing the built-in encounter persona text (`llm/personas/builtins.ts` — personas are user-editable stored rows, so the change would never reach an app that already exists); a "is the prose specific enough?" threshold, a prose classifier or any runtime gate over the prose (§4 gotcha); rendering the section for non-encounter kinds (their prompts are byte-identical, exact-bytes pinned); a SECOND advisory surface beside `data.budgetAdvisory`; silently swapping a stated creature for a generic equivalent (the whole point of `substitutions`); a prose-vs-roster checker that guesses beyond what the model declares |

| Validate a MODEL-AUTHORED inline stat block's `level` (ledger 90, docs/11 §D5 amendment) | `runEngine.statBlockLevelIssues` — the app's one level parser (`llm/encounterRoster.parseLevelSort`: number, fraction `"1/2"`, or `"—"`) as the spec, wired into `encounterSourceIssues` so BOTH model boundaries (the Smith draft and the Cartographer brief) get the existing one-repair-then-loud path, plus the independent refuse in `materializeMonsterNpc` before it writes an artifact row; the prompt's `statBlockSchemaHint` DESCRIBES the field (`"level": the creature's printed level — a number ("3"), a fraction ("1/2"), or "—"`) | tightening `domain/statblock.ts` (it is the READ boundary for the blank editor form's `level: ''` and for PDF best-effort chunks — §4); a second level grammar beside `parseLevelSort`; coercing or defaulting the value; dropping the monster |
| Enumerate what the portrait batch acts on (ledger 90, docs/11 §D5 amendment) | `features/campaign/mob-portrait-queue.enumerateBatchKinds` — ONE enumeration for the read-only count (`planMobPortraitBatch`), the additive batch (`enqueueMobPortraits` + `enqueueInventedCreaturePortraits`) and both regen paths, routing EVERY roster participant by what its creature IS: chunk-backed (`rulebook`, or `npc-ref` → an artifact with `data.monsterChunkId`) shares the bestiary portrait deduped by artifact; anything else (`inline`/`none`, `npc-ref` → an artifact WITHOUT the marker) is a LOCAL job with NO `chunkId` | reading `source.type` as the routing rule (an `npc-ref` row matched neither lane — the owner's materialized monster was invisible to the batch); handing a `chunkId` to a local job (that is the only thing that can reach the global `mobPortraits` cache); enumerating into a second, divergent list for the surface |
| Record WHICH MODEL wrote a text or an image (owner request, docs/17 row 93) | The WRITE SITE records the `modelUsed` its own call returned: `writerModel` on the artifact row (`domain/artifact.artifactBaseShape` — additive `.default('')`, no Dexie version bump), on the module row's `spine` and on EACH part (`domain/module.moduleSpineSchema` / `modulePartSchema`), and the pre-existing `storedImageSchema.model` for images. Recording seams: `runEngine.runDraft` step output → every finalize create/refill (+ `materializeMonsterNpc`'s run-level id), `db/mobArtifacts.materializeInventedCreatureArtifact` (the ENCOUNTER row's id — no call runs there), `moduleGen.runSpine` / `generatePart` (each including its repair turn), `db/moduleRepo.patchModulePartText` (rides through from the canvas chat/refine writers), `features/modules/canvas/{chatController,snapshotChat,CanvasPage}` for chat-applied and accepted-proposal text. Display: ONE rule `domain/provenance.recordedWritingModel` (trim; `''`/null ⇒ NOT RECORDED ⇒ render NOTHING) and ONE component `components/writer-model-id.WriterModelId`, mounted by the peek modal (card text + image banner), the module reader (premise + each part, BOTH premise branches — the generated reader and the spine checkpoint), the canvas preview (a caption under each part's rendered text) plus the canvas footer strip `features/modules/canvas/canvas-writer-model.CanvasWriterModel` (which summarises `domain/provenance.moduleWritingSummary`: one id when the premise and every part agree, the per-scope list — including `not recorded` — when they differ), the image lightbox / cover hero / campaign card art, and `play/artifact-cards.NpcCard`/`EncounterCard` behind the explicit `showWriterModel` opt-in | a settings lookup (`settings.defaultChatModel` names the model we ASKED, not the one that SERVED — §4); backfilling or guessing an id for a row written before the field (nothing recorded ⇒ nothing on screen, forever); letting the field reach a model: it is never INPUT to a prompt or a contract (the spine's emitted schema is `.omit({ writerModel: true })`, because a `.default('')` field comes out REQUIRED in the strict subset and would force the decoder to invent an id); rendering it in an export (§4); a second display rule or a per-surface caption component; putting a caption INSIDE the canvas document — that text is the module text (persisted to the parts and re-sent to models), so a canvas caption reads the SAVED ROWS and renders as a sibling of the text, never in it (§4) |
| **Decide whether module text is MACHINE-written or a person's — the consent gate** (docs/17 row 113, amending fix-01's `edited`-based rule) | ONE recorded field and ONE test: `domain/module.textOriginSchema` (`'human' | 'model'`) is the additive, nullable, parse-on-read `origin` on the module `spine` AND on each `ModulePart` (no Dexie version bump — a pre-field row parses to `null`), and `domain/provenance.textOriginIsMachineWritten(origin)` is the ONLY authorship test any consumer may call (`origin === 'model'` and nothing else; `null`/`undefined`/`'human'` all mean a person's text, which is the conservative legacy default). The origin is STAMPED at the ONE part-text seam `moduleRepo.patchModulePartText`, which already receives the identity of whoever writes: supplying a `writerModel` is the machine-write signature (`writerModel === undefined ? 'human' : 'model'`) — every canvas/chat apply path supplies one (`canvas/saveDoc.ts`, `CanvasPage`'s apply, `canvas/chatController.ts`, `canvas/snapshotChat.ts`) and a hand save omits it. For the premise (which has no part save seam) the two production writers stamp it themselves: `moduleGen.normalizeAndSave` writes `origin: 'model'` on the generated spine it saves, and the checkpoint's `approveSpineAndRun` reads the STORED row and stamps `'human'` only when the approved premise text differs — so clicking through the checkpoint claims nothing. Both stamps ride `domain/provenance.carriedTextOrigin` for the cases that must PRESERVE a previous origin (the parts pass's generating/failed/pending slots). Read through `features/modules/module-problems` (`modulePartWriterLabel` / `moduleTextWriterLabel` / `heldRewriteSummary` / `heldRewritesBanner`) so a surface renders the writer the ROW names — "You wrote this part." / "The model `id` wrote this part." / "This part was written by hand (or before the app recorded authorship)." | reading `ModulePart.edited` as authorship (it means "written outside the generator" and is stamped on EVERY write through the seam, including model text the canvas auto-accepted — that reading is exactly the owner's bug); deriving the origin from a stored `writerModel` (a hand edit CARRIES the previous model id forward, row 93, so the id cannot answer "who wrote this now"); a heuristic or backfill for a pre-field row (nothing recorded ⇒ it reads as the person's and keeps asking, forever); the model answering for itself (`spineReplySchema` `.omit({ origin: true, writerModel: true })`); a prompt that asserts authorship a row cannot support (§4) |
| Decide what mob-portrait work a roster holds, and which lane a creature rides (docs/17 rows 90/96) | `features/campaign/mob-portrait-participants` — ONE home for the batch's rules: `rosterParticipantRoute` (lane by what a row's creature IS, never by the shape of its `source`: chunk-backed — a `rulebook` citation, or an `npc-ref` to an artifact carrying `data.monsterChunkId` — shares the one bestiary portrait; `inline`/`none` and an `npc-ref` without the marker get a LOCAL job with no `chunkId`; a dangling `npc-ref` is the first-class `missing-ref` verdict the queue throws on), `portraitArtOf` (`coverImageId` ⇒ imaged, else `imageIds.length > 0` ⇒ imaged-but-not-cover, else `none`), `chunkKindKey`/`inventedKindKey` (per-kind identity), and the sync dry run `encounterNeedsMobPortraitWork(encounter, artifacts)`. Read by the queue's own enumeration (`enumerateBatchKinds` → `planMobPortraitBatch` / `enqueueMobPortraits` / `enqueueInventedCreaturePortraits` / both regen paths) AND by the module-level gap detector (`post-generation.encountersNeedingMobPortraits`, hence both "Resume automatic module creation" and the entity sidebar's "Generate everything"), so the offer and the work walk ONE rule; the artifact lookups it needs are pure cores in `db/mobArtifacts` (`mobArtifactIn`, `inventedCreatureArtifactIn`) that the async readers wrap | a second reading of `monsterSource.type` or of `coverImageId`/`imageIds` in any surface (the module path's private rulebook-only predicate is exactly how the owner's materialized core creatures became invisible and the "Generate everything" control disappeared — §4); gating a lane on the roster's SHAPE (`rulebookCount === 0`); reading the module ROW's automation fields where the run has an explicit target (the portrait block did, so the target's promise ran empty — §4); a second chunk→artifact or invented-creature scan instead of the `db/mobArtifacts` cores |
| Represent an ability value (ONE representation: d20 SCORES — docs/12 §5, ledger 95) | `domain/statblock` owns the whole convention: `abilityScoreFromModifier` (the ONE modifier→score conversion, `10 + 2·mod` — the pack importer's and the stat-block editor's), `printsAbilityModifiers(system)` (the ONE per-system switch) and `formatAbilityValue(system, score)` (the shared card's display: PF2e prints the signed BONUS only, every other system `score (bonus)`; the two PDF stat boxes compose the same predicate with their own compact layout). The MODEL boundary states the convention in `runEngine.statBlockSchemaHint` and refuses a SIGNED ability value through `runEngine.statBlockSignedAbilityIssues` — wired into `encounterSourceIssues` (Smith draft + Cartographer brief, both on the reply's RAW pre-coercion `monsters` array) and into the statblock step's own reply — as a NAMED issue on the existing one-repair-then-loud path; the editor's PF2e field edits the printed bonus and states the conversion on screen | a second modifier→score conversion (the importer's own `10 + 2·mod`); a per-surface display branch of its own; reading `+2` as a score anywhere; tightening `domain/statblock.ts` (the READ boundary — §4); a plausibility heuristic for the UNSIGNED case (§4) |
| **Answer the chat's request for an artifact's stored details — READ ONLY** (docs/17 row 103; the write half is row 101's seam and does NOT exist here) | `llm/canvasChat`: the assistant may emit `<request><name>EXACT NAME</name></request>` (≤ `MAX_REQUESTS_PER_REPLY` = 5 per reply), parsed by the SAME `parseCanvasChatReply` strict extractor as `<edit>` — one left-to-right walk over both tags, so malformed/unbalanced/over-cap fails the WHOLE reply (`CanvasChatParseError`). The answer is `resolveChatDetailsRequests({ requests, moduleId, pool })` over `loadChatDetailsPool(campaignId)` (the campaign's artifacts + the shared library — the chips' own pool), resolving each name through the EXISTING `lib/wikilinks.resolveWikiLink(name, pool, { moduleId })` (chip parity, including the ambiguity candidate list) and rendering the STORED row per kind (`renderArtifactDetails` / `artifactDetailLines`; roster stats via `monsterResolve.resolveMonsterEntryWithRepos`, a loud `stats: MISSING — …` when a citation does not resolve). The block rides ONE follow-up call per user turn — `buildCanvasChatDetailsPayload` (+ `canvasChatTurnContent`'s `details` arm) puts the model's asking reply and the app's `<requested-details>` turn (header `REQUESTED_DETAILS_HEADER`, contract `CANVAS_CHAT_DETAILS_INSTRUCTION`, roles kept alternating via `DETAILS_ANSWER_TURN`) into the SAME payload shape, refusals included as named verdicts (`NO SUCH ARTIFACT` / `AMBIGUOUS NAME` / `NOTHING STORED ON THE ROW`); the cap is `MAX_DETAILS_BLOCK_CHARS` with a LOUD `[TRUNCATED — …]` / `[BLOCK FULL — …]` marker, never a silent trim. A request in the FOLLOW-UP reply comes back as `ignoredRequests` — no third call ever | pre-supplying every artifact's details unconditionally (the owner's own hesitation: "maybe not unconditionally"); a kind-discriminated request or a second name resolver/pool (resolution IS `resolveWikiLink`); letting a request write anything (details change through `features/modules/change-artifact.changeArtifact`, row 101); answering from the row's summary, the module text or the model's own guess; a loop/retry until the details arrive; a silent trim or a partial block with no marker; a catch-and-continue around the follow-up parse (it is surfaced as a loud `failed` result while reply 1's work stands) |
| **Change an artifact from the CHAT** (docs/17 row 104 — the write half behind the read half above, so it supersedes that row's "the write half … does NOT exist here" parenthetical) | `llm/canvasChat`'s change half + `features/modules/canvas/chatChanges`: the assistant may emit `<change operation="repopulate\|everything"><name>EXACT NAME</name><instruction>…</instruction></change>` (≤ `MAX_CHANGES_PER_REPLY` = 3 per reply), parsed by the SAME `parseCanvasChatReply` strict extractor in the SAME one left-to-right walk as `<edit>`/`<request>` — a malformed block (unknown attribute, duplicated or invented `operation`, wrong children, empty name/instruction, unterminated) or an over-cap reply fails the WHOLE reply with NOTHING executed. Names resolve through the SAME `lib/wikilinks.resolveWikiLink(name, pool, { moduleId })` the chips and the read half use (`llm/canvasChat.resolveChatArtifactName`, ONE `loadChatDetailsPool` per turn); an unresolved/ambiguous name is a NAMED refusal carrying the resolver's own candidates — the app never guesses which row to OVERWRITE. `operation` is REQUIRED for an encounter and refused by name for every other kind, and there is NO default (`repopulate` restocks, prose untouched; `everything` regenerates the encounter with its prose, and never sets the editor's own `redesignProse` checkbox). Each change runs SEQUENTIALLY (one at a time, in reply order) through the ONE seam (`features/modules/change-artifact.changeArtifact`, row 101) with the resolved row's id + the instruction + the operation; the CHAT PATH itself writes NO row. Since each change is a real generation, the turn HANDS THE MODULE SLOT OVER for the phase (`llm/canvasBusy` is not re-entrant — §4) and a slot another generation holds is a named `MODULE BUSY` outcome, never a silent skip. The outcomes (`changed` / `refused` / `unsupported` / `unresolved` / `ambiguous` / `busy` / `failed`) ride the SAME one follow-up call the read half established, as a `<change-results>` block (`renderChangeResults` + `CHANGE_RESULTS_HEADER` + `CANVAS_CHAT_CHANGES_INSTRUCTION` through `buildCanvasChatFollowUpPayload`; every non-applied verdict reads `NOT APPLIED: <VERDICT>` with the asked-for instruction echoed), and a `<change>` in THAT reply is `ignoredChanges` — never a third call. The OWNER sees each outcome the moment it settles (`chatChanges.reportChatChangeOutcome`: a loud toast naming the artifact, its kind, the operation and the instruction, plus a progress-dock job `Changing «<name>»` linked to the row; the `failed` copy never claims nothing changed) in BOTH flows (`chatController` + `snapshotChat`). Recovery invents nothing: `updateArtifact` recorded a NEW revision with the previous one intact, restorable from the artifact editor's existing revision list (`restoreRevision`) | a chat-side or per-surface row writer (no provenance, no per-kind brief, no creature-row guard, no busy gate); a second command tag vocabulary, or a regex-guessed block; a default encounter operation; a silent newest-wins pick on an ambiguous name; running the changes in parallel; a second follow-up call; `catch`-and-continue around a change outcome (a specialist failure is a named `failed` outcome the model reads AND a loud owner toast); reading an abort as a change; a new rollback/undo mechanism beside the revision list |
| **Change any artifact from an instruction — THE one way** (docs/17 row 101) | `features/modules/change-artifact.changeArtifact({ artifactId, instruction?, encounter? })` — resolves the row and routes BY `artifact.kind` (never by a caller-declared kind): `encounter` → `features/campaign/encounterRegen` with the REQUIRED `encounter.operation` (`'repopulate'` / `'everything'` — genuinely different operations, and the second replaces the layout and map, so the destructive one is never a default) plus the existing `redesignProse` / `dungeonMapPath`; `npc` / `location` / `event` / `faction` / `note` → `features/modules/entity-batch.runEntityBatch` with a per-target `artifactId`, i.e. ONE target filled IN PLACE through `runEngine`'s refill (identity, links and images preserved; `writerModel` + the `persona` revision recorded), never a second row of the same name. The instruction rides the specialist's BRIEF in the ONE `Additional instruction: …` form (`llm/additionalInstruction` — the same form `runEngine`'s four render sites now use), so it persists on the run row's `userBrief` and survives a resume; empty/omitted renders no paragraph and leaves every brief byte-identical. Uniform semantics, not new ones: the EXISTING `llm/canvasBusy` one-generation-per-module gate is claimed for the change and released in `finally` (loud `ModuleBusyError`); failures THROW (a specialist error, an incomplete run with the specialist's own reason, a vanished campaign/module); the seam's own declines are returned as a discriminated result (`changed` with its `operation` / `refused` with its `reason` / `unsupported` with its `reason`, every arm carrying `artifactId` + `kind`) so no caller string-matches. REFUSED: a rulebook-cited creature row (`isMobArtifact` → `creature-row-guard.creatureRowAiRefusal` — a RATIFIED owner boundary, docs/17 row 101: never rewritable by instruction, nothing written, no engine called) and a module-less entity row (no module text to ground in). UNSUPPORTED: `pc` (the Party is authored) and `plotarc` (not a module entity kind). | a chat-side or per-surface writer that edits artifact rows itself (a second writer with no provenance, no per-kind brief, no creature-row guard, no busy gate); a `changeX` per kind or per surface; routing on a kind the CALLER declares; a per-kind instruction form; a required non-empty instruction (the editor's buttons have none — a canned one would change the prompts they have always sent); a default encounter operation; catching a specialist failure to return a `failed` status (failures throw, so a caller cannot ignore one); re-deriving a brief, a persona or a run wait inside the seam instead of calling the specialist |
| **Reconcile a module row a DEAD page left at `status: 'generating'`** (docs/17 row 110) | `llm/moduleGenReconcile.reconcileInterruptedModuleGens()` — called from `AppShell`'s mount effect (app START: a discarded tab RELOADS, so start is the load-bearing moment) and on the way back into a backgrounded tab (`onPageResumed`). Ownership is decided by ONE guard, `isModuleGenClaimed(id)` = `moduleGen.hasLiveModuleGen(id)` (this page's controller registry) OR a held generation lock (`lib/generationLocks.isGenerationLockHeld(moduleGenLockName(id))`, the cross-tab lease), and it is re-evaluated INSIDE the write transaction (`moduleRepo.failInterruptedModuleGen` takes the predicate). The write is LOUD and never a silent reset: `'failed'` + `INTERRUPTED_MODULE_GEN_MESSAGE` (a named sentence that also names the recovery control), every part slot still at `'generating'` rewound to `'pending'` — which is exactly the state the EXISTING `moduleGen.generateMissingParts` recovers from — and the batch entry point toasts the count | treating a persisted `'generating'` as PROOF that somebody is writing; a silent reset to `'draft'` (the owner must be told what happened and what to press); touching a row a live controller or another tab owns; re-deriving the rewind or the message at a second call site (ONE constant, ONE transaction); reconciling RUNS on `visibilitychange` — a hidden tab is still running its engine, and failing those rows would invent the very defect this seam removes |
| **Stop a module generation — the ONE behaviour behind every Stop control** (docs/17 row 110) | `llm/moduleGenReconcile.stopModuleGeneration(id)` returns what actually happened and each outcome ends in something the owner can SEE: a live controller in THIS page → `cancelModuleGen(id)` (a real abort, `'cancelled'`); another tab holds the generation lock → nothing stopped, nothing failed, a toast naming the other tab (`'elsewhere'`); nobody owns the row → `reconcileInterruptedModuleGen(id)` (`'reconciled'`); the row already settled → a toast saying so (`'idle'`). `features/progress/stop-all-generations` asks the same guard and reports `{ stopped, reconciled }`, counting a reconciled row as a SEPARATE number and never as work the sweep stopped | a bare `cancelModuleGen` from a Stop control (on a row no live controller owns it is `controllers.get(id)?.abort()` — a silent no-op, which is the defect the seam closes); reconciling a row another tab is generating; counting a dead row as "stopped" and toasting that it was stopped; letting `stopped === 0` claim "Nothing was running" while a dead row was reconciled |
| **Measure a stream watchdog against LIVENESS, and report only a limit that was ARMED** (docs/17 row 110) | `lib/pageLiveness`: `installPageLiveness()` (auto-installed on `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`) records the SUSPENDED GAPS, and `activeElapsedMs(from, to)` is wall time minus those gaps. `llm/openrouter.readStream` computes all three watchdog deltas through it, records `trippedLimit` when it actually calls `reader.cancel()`, and the post-loop diagnosis throws ONLY that limit — otherwise the accumulated text is the answer | `Date.now()` deltas in the watchdog OR in the post-loop diagnosis (a hidden/frozen page's gap then reads as silence and a healthy stream is cancelled; worse, the diagnosis ran after a CLEAN `done` close and discarded complete answers); loosening a limit to compensate (a genuinely dead stream must still fail on the same numbers); re-deriving the failure from elapsed time after the loop instead of asking what the watchdog DID; treating a cancelled stream as an error while keeping its partial text as if it were complete |
| **Wait for a run to leave `'running'`** (docs/17 row 110) | `runRepo.waitForRunRowChange(runId, known, signal)` — a Dexie `liveQuery` over the ONE run row, resolving on any change (including rows written by another tab's run) or when the row disappears — wrapped by `runEngine.waitForRunStatus` (which loops: read the row, check abort/terminal/paused, then await the change) | a `setTimeout` poll (250 ms chained ticks are a PACING bug: Chromium throttles a hidden page's timers to ~1/minute, so a chain or batch step boundary can idle for a minute); resolving on a write that is not terminal; dropping the `AbortError` or the "Run … disappeared while waiting for it to finish" contract (both are preserved to the character and pinned) |
| **Refill an existing artifact in place** (a persona run with `targetArtifactId` — the artifact editor's "Generate/Regenerate with AI", the persona panel's targeted run) | `runEngine.startRun({ targetArtifactId })`: the pipeline runs normally, `runFinalize` merges through the ONE `mergeRefillData(kind, draftData, target)` and writes with `updateArtifact` (which parses `anyArtifactSchema` — the write seam that makes a bad merge a loud failure, never a silent row). A refill target's OWN shape decides steps: a target that cites a library creature (`isCastCreatureNpc`, read through `npcCreatureRef`) is NEVER asked for a stat block — the step finishes `'skipped'` naming the citation, before the model call (docs/11 §A cited row's REFILL, ledger 112). `mergeRefillData` REFUSES, by name, a draft that carries a stat block for a cited row | a step plan that asks a cited row for stats because the draft said they matter; a merge that silently prefers one side of an exclusive pair (drop the block or drop the citation); pre-filtering the draft contract by kind instead of deciding at the step |

### 2.3 App & UI

| To do X | Use Y | NOT Z |
|---|---|---|
| Build a route path | `app/routes.ts`: `ROUTES` patterns + the `*Path()` builders | hand-writing `/c/...` strings |
| Save a renderer-built file to disk (backup, campaign/artifact export, artifact PDF) | `lib/filePicker.openSaveTarget` — THE one way to save files: acquire the `SaveTarget` inside the click handler BEFORE the slow build, `target.write(blob)` after; picker cancel = silent no-op (no build, no toast), picker failure = loud `toastError`; `BACKUP_TYPES` / `EXPORT_JSON_TYPES` / `EXPORT_ZIP_TYPES` / `EXPORT_PDF_TYPES` are the one picker-type registry | `downloadBlob` from UI code (the no-picker fallback lives INSIDE `openSaveTarget` only); build-then-pick ordering (the picker needs transient user activation) |
| Surface an error | `lib/toast.ts` (`toastError`/`toastErrorPersistent`), a failed run row with `errorMessage`, or the global boundary (`app/GlobalErrorBoundary` + `lib/globalErrors.installGlobalErrorHandlers`) — HUMANIZE-AT-THE-SEAM: a ZodError's `.message` is the raw `[{code,path,message}...]` array, so it is never rendered verbatim; the seam formats it via `lib/zodErrorSummary` (counted, grouped by table, first 3 + "and N more", version-skew mitigation; names never invented — issues carry no input values), keeps the leading title untouched (plain-Error copy passes byte-identical), and logs the full raw error to the console (one click away, never megabytes in the toast). Import failures append the same mitigation via `lib/exportImport.withImportMitigation`; `MissingDependenciesError.message` itself reads as numbered steps | `console.error` only (AGENTS 2); rendering `error.message` of a ZodError-shaped failure into a toast description |
| Long-running progress | `lib/progress.useProgressStore` + the app-wide `<ProgressDock/>`; queue jobs report via `dockGroup` | a disabled button or a "Generating…" label (00-OVERVIEW, binding) |
| State why a control cannot act | `components/blocked-control.BlockedControl` — THE one way: it wraps the control so the WRAPPER is the Tooltip trigger (a natively `disabled` form control fires no pointer events, and every shadcn Button adds `disabled:pointer-events-none`, so the control itself can never be hovered), it is focusable (`tabIndex=0`) while blocked so the reason opens on focus, and it renders the same sentence into a visually hidden node pointed at with `aria-describedby` (docs/05 §Why a control cannot act; one reason per state, naming the way out) | a `title` on the control itself (invisible in Chrome on a natively disabled control, unreachable by keyboard — docs/18 §4); a second tooltip idiom; a reason that is not true for the state that produces it; a wrapper when the block is self-evident (the label already says the state, an empty input, nothing to act on) |
| Wiki-link handling | `lib/wikilinks.ts` (extract/strip/rewrite/resolve/count; `WIKI_LINK_PATTERN`; `stripWikiLinks` = the DISPLAY every export renders, reached through `lib/markdown.markdownToDisplayText` — row 105) + `lib/remark-wikilinks.ts` → `WikiMarkdown` — the ONE chip renderer, so every wiki-aware surface (module reader, canvas preview, peek modal, artifact bodies, board cards, guide) gets the same chips and the same tooltip with no per-surface wiring. **How a chip knows the token it was written from** (docs/17 row 100): `splitWikiText` carries `match[0]` byte-exact on the wiki segment, `wikiLinkNode` puts it on the mdast node's `data.hProperties[WIKI_RAW_ATTRIBUTE]` (`'data-wiki-raw'` — the one supported mdast→hast route for custom properties; verified at HEAD that it reaches the React component and the DOM), and `WikiMarkdown` reads it back as a prop, sets it on the chip element and LEADS the chip's `title` with it, keeping whatever the chip already said as the tail | a private `\[\[...\]\]` regex; **reconstructing** the token from name+display (the plugin is the last point where the source bytes exist — the node's only child is the display text); a SECOND chip renderer or a per-surface tooltip wrapper; moving the token into the chip label or into any persisted string (it is render-time only, and `lib/modulePdf`/`lib/pdfExport` never import this module) |
| Write part text on the module row (ONE save path) | `features/modules/partText.saveModulePartText` → `moduleRepo.patchModulePartText` (row re-read INSIDE the rw tx — a concurrent parts write can't be lost; `status: 'ready'`, `edited: true`, and the recorded `origin` — `'human'` when the caller supplies no `writerModel`, `'model'` when it does, docs/17 row 113) + the post-save `promoteSecondModuleUses` scan. Callers: the reader's `savePartEdit` (PartTextEditor hand edits), the board rewrite's Apply and Discard | a stale-snapshot `parts` array written through plain `patchModule` (lost-update on concurrent saves); a part-text write that skips the promote scan; artifact revisions for part markdown (there are none — parts live on the module row) |
| Streaming state on a screen (reader/board tails) | The emitter is NEVER the subscription: `features/modules/streamTails` (reader) / `features/modules/board/stagedRewrites` (board) hold it in an external store with value-diffed frozen snapshots, consumed by the ONE component that shows it (`useStreamTail` → `useSyncExternalStore`); ONE bridge component subscribes to `moduleGenEvents` for the whole screen (`ModuleGenTailsBridge`, renders `null`, ignores other modules) | page-level `useState` fed by a `moduleGenEvents` listener — every token re-renders the page and re-parses every part (measured on 12 parts × 4 KB: 200 tokens = 13,578 ms task time, 200 long tasks of 50–115 ms, 32,134 DOM mutations; after the store: 520 ms, 0 long tasks, 134 mutations) |
| Board the whole module (viewport, layout, LOD) | `features/modules/board/` on `@xyflow/react` (attribution rendered): React Flow is THE viewport gesture owner (pan/zoom/pinch/drag — cards mount plain buttons only, scrollable bodies `nowheel`); node positions + viewport persist via the module row's `canvas` field (`patchModule`, debounced 600ms, flushed on unmount AND on the page going away through `lib/pageFlush` — docs/17 row 118 — rides backup/export); content slices in `boardStore` are value-diffed per node (node objects must stay stable — React Flow re-renders ALL nodes when node objects churn); node keys via `domain/module` (`premise`, `part-<planIndex>`, `prior-<id>`); continuity edges via `boardEdges.deriveContinuityEdges` over `buildWikiGraph` mentions, capped + surfaced | custom pointer handlers on board nodes (a second gesture-arming path — battle-machine rules apply to the battle board only, but the module board must never arm its own); localStorage layout copies; a second node-key format |
| Land a DEBOUNCED row write when the PAGE is going away — a frozen or discarded tab, which never unmounts (docs/17 row 111, extended by row 118) | `lib/pageFlush.registerPageFlush(flush)` — ONE registration list behind ONE `pagehide` listener and ONE `visibilitychange` listener (installed only while at least one flush is registered, removed when the last one goes; the hook fires only for `hidden`, never for `visible`). Registered by FOUR writers today: `features/modules/canvas/chatPersist` (at module scope — the pending queue and the debounce are the writer's own, so the writer owns its flush), `features/modules/new-module-dialog` (`flushPendingDraft`), `features/modules/board/BoardPage` (`flushPendingLayout`, row 118) and `features/campaign/components/artifact-editor` (`flushPendingEdits`, row 118). Every registered flush MUST keep the seam's three-part contract: PENDING-GATED (nothing queued ⇒ nothing written), IDEMPOTENT (the pending work leaves the writer's queue before the write, so `hidden` then `pagehide` is ONE write) and NON-THROWING (the writers already toast their own failures; anything escaping a lifecycle listener is toasted by the seam). `registerPageFlush` returns the unregister function, which is the `useEffect` cleanup for a component-scoped writer — and that writer puts the registration in the SAME effect as its unmount flush, whose cleanup is `unregister(); flushPending();` (the two triggers are one idea and one function, so a re-registration cannot leave the seam holding a stale closure) | flushing on every `visibilitychange` (a tab switch is not a write — measured: removing the `hidden` gate reds the named pin); registering a writer's UNMOUNT flush when it is not pending-gated (the draft's `flush` writes a touched draft even after its timer fired — the page-hide half needs its own gated wrapper, and the ungated version was measured to write on a tab switch); a per-writer `pagehide` handler (the one-handler-per-writer shape — the board and the editor are registered through this seam, and `tests/features/board-page-flush.test.tsx` source-scans `src/**` to keep a third listener from appearing); awaiting the write (a lifecycle handler cannot hold the page open); a Dexie version, a localStorage mirror or a timer-cancel API to make this work |
| Board per-part rewrite + staging | `features/modules/board/stagedRewrites` (zustand, SESSION-only) + the page's rewrite flow: engine = `runParts` subset (`planIndexes: [i]`) — floor gates own their bands, normalization included — WITHOUT `rewritePart`'s swallow-all catch so `ModuleBusyError` surfaces loudly (ONE generation per module); ghost tokens (`moduleGenEvents` part-token) buffer into the store rAF-throttled — partial text never touches the module row; Apply/Discard land through `features/modules/partText.saveModulePartText`. **Both writes state the AUTHORSHIP they do not change** (docs/17 row 113): `stageProposal` captures the replaced part's `origin` + `writerModel` at the one moment they are still readable, Apply adopts the engine's own text as `origin: 'model'` (it IS the model's rewrite), and Discard puts the previous text back WITH its captured authorship — never re-derived from an omitted writer model, which would stamp `'human'` on either | queueing or silently dropping a busy rewrite; persisting staging anywhere; a diff view (owner decision: new text renders as-is, Show previous on demand); letting Apply/Discard fall back to the writer-model default (that is how model text becomes the owner's — the defect docs/17 row 113 removes) |
| Markdown → the text a READER sees (every export) | `lib/markdown.markdownToDisplayText` — `markdownToText` plus `lib/wikilinks.stripWikiLinks`, the ONE wiki strip, so `[[Name]]` renders as the name, `[[Name\|display]]` as the display, and text that only LOOKS like a token stays literal (row 105; `parseInline`'s bold display run stays `mdToPdfmake`'s own job) | a private `\[\[…\]\]` regex at an export site; printing the token into a PDF, handout or text export (the single-artifact GM-notes/handout export DID, until row 105 — recorded by row 100, docs/07 §Wiki-links in an exported document) |
| Markdown → faithful plain text — NOT for a reader | `lib/markdown.markdownToText` — markdown syntax only, so wiki tokens stay `[[…]]`; the deterministic image-prompt builder's input, where the token is the only place the target's NAME survives and nothing is read by the owner | using it for anything a human reads; "fixing" it by making IT wiki-aware (the two jobs are one function apart, and the round-trip-safe half is load-bearing) |
| Render the MODULE PDF — the module IS the document (docs/17 row 108) | `lib/modulePdf.buildModulePdf(module, artifacts, generate, { audience })` — ONE builder, the audience an explicit option (`'gm' \| 'player'`), never a second renderer. The body is the module's own `spine.premise`, its part plan and its `parts`, assembled with `assembleModulePartsDocument` and re-split with `splitPartsDocument` (the canvas's pair), so the `==========` separators and `[Part n of total — title]` scaffold labels a stored document carries can NEVER reach a page; the artifact pool is the module's own mentions (`[[…]]`) plus its owned rows (`moduleId`), deduped in mention order. Chapters: cover → Contents (`toc`) → premise → part plan (GM) → parts (kicker `PART 1 OF 2 · LEVELS 1–2`) → kind chapters (locations/events/encounters/factions/party; plot arcs + notes GM-only) → NPC gallery → treasure ledger (GM). A **map plate is printed AT its encounter's anchor** from `encounter.data.mapImageId`, else the live battle's `board.mapImageId`, and a battle with NO stored image prints **NO plate and no substitute** — `data.layout` geometry is never drawn (owner decision, ledger 108). Failures are reported, not swallowed: the returned `problems` (deduped by `where`+`reason`) name the missing premise, a refused parts seam or an unreadable image, and `features/modules/module-pdf-button.tsx` (mounted in the canvas header AND the campaign tree's module-group header — ONE component, both surfaces) announces them while still writing the document | a deliverable/outline model or a stored copy of the module; a second builder per audience; rendering the stored document's scaffolding; a schematic/geometry/PROSE map drawn in place of a missing image; an appendix that collects the plates away from their encounters; `writerModel` provenance in a PDF; a second export control per surface; a SECOND body builder for a planned document (the plan feeds the same one) |
| Decide the module PDF's STRUCTURE with a model, as DATA (docs/17 row 109) | `domain/documentPlan.moduleDocumentPlanSchema` (STRICT: ordered sections, each with a title, ONE of four closed roles, an audience `all \| gm \| player`, a `source` union naming a part `planIndex` (`-1` = premise) / an artifact id / an encounter id, and `images` = ids the module already holds) → `llm/modulePlan.planModuleDocument` (the ONE planner seam: claims the module via `llm/canvasBusy`, refuses a module with no part plan, sends the scoped artifact + image inventory as names/kinds/one-line summaries, `parseJsonReply` + zod AT THE BOUNDARY, `documentPlanIssues` for the existence rule, provenance from the reply's own `modelUsed`) → `module.documentPlan` (additive optional, parse-on-read `z.unknown()`, ONE writer = that seam's caller, ONE reader = `domain/documentPlan.readStoredDocumentPlan`) → `lib/modulePdf.resolveDocumentPlan` (absent \| invalid \| rejected \| applied) → the SAME body builder, one section per entry, the role choosing the TREATMENT (`explanation` prose+data, `read-aloud` the filled box, `gm-note` the labeled box, `aside` an indented insert with no page break and no ToC entry) and the declared audience choosing PLACEMENT (kind rules are the defaults it may override; FIELD-level GM material stays keyed on the DOCUMENT audience). A stored plan that cannot be applied is loud in TWO places — a `problems` entry at `the document plan` AND a statement on the document's own page — while the procedural document still lands and NOTHING of the plan renders; an ABSENT plan is silent and normal. Inspect/regenerate: `features/modules/module-plan-dialog.tsx` (`ModulePlanButton`, canvas header), which offers Regenerate and ONE per-section correction (the audience) and nothing structural | a drag-and-drop outline builder, a tree editor, per-node add/remove/reorder or styling controls, or a second "plan" concept beside `documentPlan` (row 108's deletion stands); letting a model emit pdfmake nodes, markdown, or any rendering property (the schema is strict — an extra key is a refusal); a plan field a renderer silently ignores; rendering PART of a plan it cannot fully apply; a fallback that is silent or that clears the stored plan; a model call anywhere inside the renderer (export must stay deterministic and offline); validating the stored field at write time with a schema that could BRICK the module row |

| Decode + embed an image in a PDF | `lib/pdfImages.loadPdfImages(requests, { codec })` + `assertPdfmakeImageDataUrl(dataUrl, where)` — decodes each id ONCE at the LARGER budget it is asked for (`PDF_MAP_MAX_LONG_EDGE = 4096` for plates, `PDF_COVER_MAX_LONG_EDGE = 1024` for covers), NEVER throws, and records `{ id, where, reason }` for every failure (a missing row, an unreadable blob, a codec error) so the renderer can print a NAMED placeholder and report it; the browser codec (`canvasPdfImageCodec`) is the ONE injectable seam (`PdfImageCodec`) because jsdom has neither `createImageBitmap` nor a canvas. pdfmake embeds `jpeg`/`jpg`/`png` data URLs ONLY, and an unsupported one (WebP) **throws inside pdfmake's measurement pass** — outside any error handling — so the format boundary is asserted HERE, loudly, before a node is built | a silent placeholder instead of an error; a try/catch around the pdfmake call; re-decoding the same id per site; handing a cover-budget decode to a full-page plate; a second image-loading path for PDFs |
| PDF viewing | `lib/pdfRuntime.openPdfDocument` + `copyBytes` (worker-safe byte copies); retained book bytes via `pdfRepo` (`&bookId` unique) | re-parsing PDFs from user files |
| Encounter preset resolution | `domain/encounterMap/schema.resolveEncounterPreset(preset, locationKind)` — the global fallback is the Settings page's Encounter-maps Preset default | branching on `locationKind` directly |
| Cover monster spawn areas with a **veil** at battle seed | `domain/encounterMap/layout.veilsFromSpawnClusters(layout, rosterCounts)` — ONE VEIL per `monsterIndexes` group (owner order; the group's `placeMonsters` cells PLUS a one-cell margin on every side, clamped to the board bounds — the cover convention: a minimal box sits exactly coincident with the tokens, which paint above veils, so without the margin the veil body and edge handles are 100% occluded), then the overlap merge (`mergeVeilCovers`): same-room covers sharing ground collapse to their union bounding box (re-clamped) under the first-emitted identity — single-room adjacent spawns seed exactly one veil, disjoint same-room covers stay separate, cross-room covers never merge; no spawn-room exemption; the room's first group keeps `id = room.id` and every group veil carries `roomId` (`battleVeilSchema`, additive/optional) — the Path rail resolves rooms per ROOM via `veil.id` AND `veil.roomId`, and "Reveal next room" reveal-alls the room (a room reads veiled until its last group veil lifts) — never re-id veils per room | one veil per room for new seeds (`veilsFromRooms` is the legacy helper); duplicate `veil.id`s per room (breaks the rail lookup + React keys); resolving rail rooms through `veil.id` only (secondary group veils go unreachable: the room reads revealed while its mobs stay covered); a covered room's key marker above tokens/veils (z-10 marker pads swallow mob/veil pointerdowns — markers mount before veils/tokens with no z-index so DOM order puts them below); an opaque FOG over a mob area (it made the room's own key marker untappable, because markers sit at the mobsRect centre inside the cover and paint below veils) |
| Tell fog from veil (ledger 65, owner-ratified — supersedes the 8fa7abd 10%-in-both-views rule) | `veil.kind` (`battleVeilSchema`) is the ONE switch for BOTH the fill and the behavior, nowhere else: `VeilView` renders **fog = OPAQUE** (the `battle-fog-cloud` class in `index.css`: three layered alpha-free grey gradients combined with `background-blend-mode` only and drifting on ONE `background-position` animation, `prefers-reduced-motion` keeps a static cloud; never `opacity-*`, never `mix-blend-mode`, and no `position`/`z-index` in that rule — an unlayered declaration would win against Tailwind's `absolute` and the markers-below-veils paint order) and **veil = transparent** (`bg-black/10`) identically in GM and player view, and `finishMoveGesture` lets a **sub-threshold tap on a `kind: 'veil'` body pass through** to a room-key marker via the PURE `domain/battle/veil.markerUnderPoint(markers, point, contentSize)` (normalized point vs each marker's center + the 44px `MARKER_HIT_PAD_PX` pad, half-open edges) → `setSelectedKeyRoomId`; fog never asks and keeps blocking; the veil body keeps `data-gesture-grab` (drag/resize/select and `delete-veil` unchanged). `kind` already encodes the seeder's fog intent, so existing AND newly seeded rows behave correctly with NO migration and NO new field (the legacy-row pin proves the absence); generated COVERS are seeded `kind: 'veil'` (fog-cloud arc), so a mob area is plain cover and its room-key marker stays tappable, and the rail's delete action + edge-handle aria-labels take their noun from `veil.kind` while the test ids stay the family ids | alpha on the FOG fill, or an `opacity-*` class on the veil node (selection/drag must never swing the fill — the veil-presentation test forbids `opacity-\d`); a `kind`-independent fill (that IS the owner-reported bug: fog and veil did the same thing); a second "is this fog" field; `document.elementFromPoint` for the pass-through (jsdom does not hit-test — docs/08 §Testing — so a DOM hit-test could not be pinned and would be an unverifiable claim); moving the marker layer above veils or adding z-index to reach a covered key (469f058: lifted pads swallow token/veil pointerdowns — reachability comes from the veil's PASS-THROUGH, never from z-index or DOM reordering); dropping `data-gesture-grab` from the veil body or touching the gesture machine's arms/threshold; changing coverage/pruning/initiative (deliberately kind-agnostic, already fog-shaped) |
| Resize an effect marker from an edge handle | `resizeEffectFromEdge` (`domain/battle/effect.ts` — SYMMETRIC center-fixed: every n/s/e/w handle grows the same `sizeCells` span, cell-quantized via `veilSpanNorm`, min `EFFECT_MIN_CELLS`); the surface previews the size locally with zero writes and commits exactly once per gesture end (a tap / return-to-start / cancel commits nothing; the rail Grow/Shrink buttons own discrete steps) — the veil path rides the same gesture via `resizeVeilFromEdge` since the one-gesture-machine rebuild (the veil click-step path is deleted) | the veil's opposite-edge-pinned `resizeVeilFromEdge` (different shape contract — veils carry w×h spans, effects one span); a second cell quantizer around it |
| Battle-surface gestures (board drag/resize/pan/pinch/tap) | ONE machine (`domain/battle/gestureMachine`: `idle\|armed\|active` × `token\|veil\|effect\|effectResize\|pan\|pinch\|tap` in a single ref) + ONE set of board-level pointer handlers as the sole capture owner — pieces render `data-gesture-grab` / `data-gesture-resize` hit areas and never own streams. `gestureGate.ts` is booleans the machine drives (idempotent ends, no counters, no throws — the initiative-reconcile early-return reads the boolean): second-pointerdown never overwrites (background second finger promotes to pinch with abandon-no-commit, piece second grab ignored), moves are pointerId-checked, `pointercancel`/`lostpointercapture`/blur/unmount always abandon with zero commits (cancel never commits), scenery/player-safe gates run before arming, native dragstart suppressed on the board + `cursor-grabbing` while live | per-piece pointer handlers owning streams; depth counters + throwing `end*` (imbalance crashed — now a recoverable reset); the veil click-step `onClick` resize (deleted); capture without `lostpointercapture` handling; a second gesture arming path anywhere else |
| GM vs player-safe initiative membership (token-lifecycle arc) | `domain/battle/initiative.gmFighterTokenIds` + `pruneInitiativeToGmFighters` for the GM surface (visible fighters PLUS covered NPCs — hidden still pruned, covered PCs still pruned); `visibleFighterTokenIds` + `pruneInitiativeToVisibleFighters` stay the playerSafe computation, byte-identical (covered excluded, no leak) — the surface's reconcile branches on `playerSafe`, the enable button rides the GM set, and the sidebar's veiled badge + Hidden group only ever receive GM-view props | a third membership set; branching the playerSafe path off the GM set (leaks veil state); gating removal or membership on bare `artifactId` presence (says nothing about HP ownership — the kind check is artifact kind, else stats kind) |
| Remove a battle token (token-lifecycle arc) | the surface's `removeToken`: NPC-backed tokens drop the BOARD TOKEN + initiative entry, deselect, and toast loud naming the mob; PC-backed tokens refuse loud (HP lives on the artifact); stamps/statless keep the silent path — artifacts, roster rows, and portraits are never deleted (no artifactRepo/image writes in the removal path) | deleting the backing artifact/roster/portrait with the token; silently refusing an artifact-backed remove (the old ungate: spawned mobs could never leave the map) |
| Graph page derivation | `domain/wikiGraph.ts` (pure; docs/13/14/15) | graph logic in components |
| Bounded parallelism | `lib/parallel.mapWithConcurrency` | unguarded `Promise.all` over unbounded arrays |
| Encounter map automation | `useEncounterMapQueue` + the guards `encounterNeedsMap` / `isEncounterMapPending` (serial by contract) | re-enqueueing an already-mapped encounter; a second queue implementation |
| Post-run automation | `features/campaign/post-run-extras.ts` — rides the queues AFTER a completed run | reopening/failing a finished run row |
| Dev logging | `lib/debug.debugLog` | bare `console.log` (lint) or `console.error` as an error surface |
| Stop every running generation | `features/progress/stopAllGenerations` + the dock's Stop all button — the ONE sweep, and it has TWO halves. **(1) Cancel the units**: the FOUR queues' `cancelAll` (`useMobPortraitQueue`, `useEntityImageQueue`, `useEncounterMapQueue`, `useCoverImageQueue` — covers were the real miss: a working `cancelAll` nobody called), `runEngine.cancelAllActive` (every in-flight run; paused `awaiting_user`/`needs_review` runs are not generating and stay), `cancelModuleGen` (every module row at `'generating'`), `chainRunner.cancel`, and `cancelCanvasGenerations` (`llm/canvasBusy` — canvas chat/refine turns stream with no run row, so the registry is the only seam that reaches them; it aborts the turn's own signal AND the caller's controller, which is what makes the partial reply render 'aborted' instead of a "Chat failed" toast). **(2) Seal the "no new units" gate**: `lib/stopEpoch.bumpStopEpoch()` runs FIRST, before any cancel. Non-destructive: cancelled runs/rows stay resumable, queue jobs settle 'cancelled' silently, the count names the DISTINCT stopped units (a module counted as a forge is not counted again for its canvas turn). NOT covered, by design: PDF builds and backup jobs (no cancel seam), the cross-campaign shared mob-portrait cache worker (local participation aborts; the shared worker is not the user's job), queue FAILED retry lists (user-recoverable) | a second stop path or per-surface ad-hoc cancel wiring |
| Stop an ORCHESTRATION, not just its units | `lib/stopEpoch` — ONE app-level counter: a loop captures `getStopEpoch()` at entry and asks `stoppedSince(captured)` between units, so "a stopped orchestration must not start its next unit" (owner report, ledger 68). Consulted at: the post-generation kind loop and each of its three enqueue blocks (`features/modules/post-generation`), the entity-batch pool's worker entry (`features/modules/entity-batch`), the three parts-pass automation gates (`llm/moduleGen` — `runParts` returns `aborted`, because a cancelled pass keeps the row at `'ready'` for Retry and is otherwise indistinguishable from a completed one), the parts loop's post-pass normalization boundary, and `features/campaign/post-run-extras`' enqueue path (a run that finishes AFTER the stop enqueues nothing). Direct user actions are deliberately NOT gated (the entity panel's batch/image buttons, cover enqueue/regenerate, the portrait batch entries, `retryFailed`) — they are not a stopped orchestration's next unit | a sticky "stopping" boolean that has to be cleared (every clear races an orchestration still unwinding from the previous stop); a `lib → features` import (the epoch module is deliberately dumb: one counter, no imports) |
| A cancel is not a failure | `runEntityBatch` treats a `cancelled` run outcome as WITHDRAWN — no `failed` entry, no red toast — mirroring `jobQueue`'s silent `'cancelled'` `JobOutcome`; the cancelled batch also stops its own pool (no further target launched) and says 'Stopped by the user' on the dock. The forge's normalization pass propagates a cancel instead of recording `entityNamesNormalized: false` over a pass the user simply interrupted, and the canvas surfaces skip their error toast when their own controller is aborted | counting a user's stop as `N of M failed to generate` (the pre-ledger-68 behaviour); a blanket silence for real failures (a genuine run failure still toasts and lands in `failed`) |
| Persisted UI state | zustand store + `lib/persisted.zodPersistStorage(schema)` | localStorage by hand |
| Scale the UI app-wide | `app/theme/uiScale.useUiScaleSync` (mounted once in AppShell next to `useThemeSync`) + the uiScale store — `--ui-scale` var × root font-size (index.css); persisted via `zodPersistStorage` (the Persisted UI state seam) and kept through Delete-all-data in `db/maintenance.PRESERVED_KEYS` like the theme | CSS zoom (breaks the px-measured board/pointer/dice/PDF math); a settings-row field (device display preference — theme precedent, stays out of the data DB and backups) |
| Open a document co-authoring surface for the WHOLE module (v3 — no part selector) | `app/routes.ts` `canvasPath` (deep link `?part=<planIndex\|premise>` and `#part-<n>` hashes are SCROLL targets, never scope — landing in preview scrolls the preview articles (`part-<n>` anchors; the scroll re-runs once the content commits)) + `features/modules/canvas/` — `CanvasPage` (shell, leave-guard, preview toggle — OPEN BY DEFAULT: `openByModule` undefined ⇒ true, session-only; the canvas lands as chat + rendered preview side by side, the preview FILLING its pane beside the live chat, one click back to Edit — instruction dialog with the rewrite-part picker), `canvasScope.ts` (the one scroll-target parse site), `canvasEditor.tsx` (the React wrapper publishing `canvasView.activeCanvasView`), `wikiDecorations.ts`, `suggestions.ts`, `canvasStore.ts` | a second markdown editor substrate; hand-rolled `[[…]]` highlighting; a second scope parser |
| Own the canvas editor viewport | CodeMirror 6 via `@uiw/react-codemirror` + `@codemirror/lang-markdown` (GFM) — THE editor doc string IS the markdown (byte-exact; no parse→serialize) | a WYSIWYG round-trip (lossy, license-hostile); a textarea; a second gesture path |
| Take an AI action's span from the RENDERED preview (owner request, docs/17 row 102) | `features/campaign/components/wiki-markdown.remarkSourceSpans` (OPT-IN: the `WikiMarkdown` prop `sourceOffsets`, passed by `CanvasPreview` and by nobody else) wraps every rendered text run in a `<span data-md-from data-md-to>` carrying that run's byte range in the part's source, and `resolveSelectionRange(partText, start, end)` is its inverse — the ONE place a rendered DOM selection becomes source offsets. The capture is taken WHERE THE SELECTION IS MADE (`features/modules/canvas/previewStore.selectionByModule`, per module: a click on a header button collapses the browser selection, so it cannot be read at confirm time) by `CanvasPreview` on `selectionchange` + the pane's mouse/key release, and converted to whole-doc offsets with the part's `textFrom`; `CanvasPage.resolveRefineRange` re-resolves it against the live document at confirm, and the dialog SHOWS the exact source text (a scrollable `<pre>`) before anything can run. In the preview the apply rides the SAME seam as the preview chat — `applyPreviewInstruction`: splice the zod-validated reply over exactly `[from, to)`, validate the resulting parts document at that boundary (refuse loudly, nothing written), then `saveWholeModuleDocument` (`origin: 'ai'`, durable pre-change version `refine`/`rewrite`) and advance the mirror state (`previewDoc`/`baselineDoc`/`docText`/`lastReplacement`) exactly as a settled turn does. Byte-exact or REFUSE, by name: a point inside a wiki chip's label, a cross-part selection, an unmapped span (inline code, image, the unwritten-part placeholder), an empty selection, a run whose pieces do not reproduce its source slice, and a capture from an older document each say so and run nothing | geometry (`getBoundingClientRect`, `caretRangeFromPoint` — untestable in jsdom and wrong across the highlight and lazy layout); clamping, rounding or extending an unmappable selection to a nearby boundary; using a chip's DISPLAY label as the source span (the token is what the model must get, `data-wiki-raw`); a second apply/save path for the preview; making the reader carry the map (no prop ⇒ no plugin, no attribute, byte-identical output — pinned); reading the CM6 selection while the preview is open (there is no view) |
| Run a canvas AI action (selection refine / picked-part rewrite) | `llm/canvasRefine.refineModuleText` — the EXPLICIT input only (the selected range + enclosing block, or the picked part's current text — never the surrounding part, never the cursor) + instruction, reply ZOD-validated at the boundary (`canvasRefineReplySchema`) + `encodingHygiene.debrisIssuesForFields` scan (loud reject, never partial-apply) + `ModuleBusyError` for ONE-generation-per-module (registry claimed synchronously at entry + the row's `generating` status) + abort signal (a user stop is not an error) + the `canvasBusy` abort REGISTRY (a sweep abort reaches the turn AND the caller's controller, docs/17 ledger 68) | a private chat client; silent repair; queueing a busy module; a second module-busy mechanism; in the PREVIEW the span comes from the rendered selection and the apply rides the preview chat's own seam (the rendered-selection row) |
| Render + decide canvas proposals | `features/modules/canvas/suggestions.ts` — a CM6 StateField of suggestions rendered as DECORATIONS that never mutate the doc; span = struck original + ghost + inline Accept/Reject (disabled while streaming); whole-part = full-doc-range proposal rendered NO-DIFF (block replace widget, Show previous toggle); typing INSIDE a proposal invalidates it loudly (page toast), edge edits re-map (pure `suggestionSurvives`); Accept = ONE dispatch + `isolateHistory:'full'` (one undo unit); streaming effects ride `Transaction.addToHistory.of(false)`; Mod-y/Mod-u accept/reject at the cursor | writing proposals into the doc before acceptance; a diff view; a second undo convention; accepting a half-streamed replacement |
| Append canvas version history | `features/modules/canvas/canvasStore.useCanvasLedgerStore` — per-part append-only `{seq, markdown, origin 'user'\|'ai', label, createdAt}`; every accepted AI action AND manual canvas save appends (one entry per CHANGED part — the split-save decides); **Restore = propose-through-the-same-accept path** (rides undo + the save path); SESSION-ONLY (dies on reload — §4), shown as the menu's "session versions" group | persisting the ledger; a second part-text write path; restoring by direct row write |
| Snapshot the whole document BEFORE an AI change (durable simple undo, owner-directed, ledger 63) | `db/moduleVersionRepo.snapshotModuleVersion(moduleId, source, label)` — ONE row `{id, moduleId, createdAt, source, label, docText}` in the additive `moduleVersions` table (schema v19, no upgrade fn), where `docText` is the WHOLE parts document BYTE-EXACT in the ONE `assembleModulePartsDocument`/`splitPartsDocument` format (spine premise excluded); called immediately BEFORE the write, never after, by: `saveWholeModuleDocument` with `origin: 'ai'` (editor chat batch, preview-snapshot chat batch, accepted Refine/Rewrite proposal, restore — the `version` arg is REQUIRED for AI saves and its absence THROWS, writing nothing), `runParts` at entry (generation / missing-part fill / single-part rewrite+regenerate / board staged rewrite / floor repairs), each `normalizeModuleEntityNames` pass, and `entity-panel.applyProposals` (consented rewrite apply); `createdAt` is strictly increasing per module; `MODULE_VERSION_CAP` 25 per module, oldest pruned in the INSERT transaction, retention stated in the menu (**restore** validates the snapshot against the CURRENT part plan and refuses loudly on a mismatch, then rides the shared whole-doc proposal → accept → the split-save, taking its own pre-restore snapshot; **clear all previous versions** = destructive-confirmed menu item, module-keyed, no snapshot first, document untouched) | a second document format; snapshotting AFTER the change; snapshotting manual typing (CM6 history owns it) or the board's Apply/Discard of a staged rewrite (already captured at pass entry); a silent cap; a side-door restore write; clearing another module's stack; letting Clear chat delete undo history; making the session ledger durable |
| Keep a generated scene block intact through every document path (docs/08 §M4-B-2, docs/17 row 73) | NOTHING new — the scene block is plain markdown inside a part's `markdown` string, so there is ONE document format and no scene-aware code exists anywhere: `domain/modulePartsDocument.assembleModulePartsDocument` / `splitPartsDocument` (the only assemble/split pair), `features/modules/canvas/saveDoc.saveWholeModuleDocument` (the split-save), `db/moduleVersionRepo.snapshotModuleVersion` (byte-exact `docText`) and its restore-through-the-same-split-save, and `features/campaign/components/wiki-markdown.WikiMarkdown` (the reader's and canvas preview's renderer) all operate on the same text they always did. The block's heading uses `##`/`###` markdown and its labels are bold text, so the reader renders it as a heading, labels, list items and ordinary wiki chips; the encounter floor reads the heading's `[[link]]` exactly like any other link in the part text. Round-trip pinned end to end (assemble → split → split-save → snapshot → restore, plus legacy prose parts and the fake-header guard) by `tests/features/scene-block-document.test.ts` | scene-aware parsing at any read or write site (field extraction, a block model on the module row, a schema or Dexie version for it); a second document format or assembler; a scene-specific renderer in the reader/canvas (the block needs none); a migration for parts written before the format (legacy prose keeps rendering, saving and counting); changing `countModuleEncounters`, its schema, its resolver, its per-part shares, its message or `tests/fixtures/encounterGuardrails/floor-message-default.txt` for the format's sake |
| Show "Fix module problems" only when the module text has a problem a rewrite can fix (owner request, docs/17 row 74) | `features/modules/module-problems.deriveModuleProblems(module, readerPool)` — ONE pure derived problem set built from detectors that ALREADY exist: the module's own encounter floor (`countModuleEncounters` + `floorRepairTargets`, per level band) carries `repairable: true`, and the READER's unresolved-link test (`resolveWikiLink` over the premise and every part — the same verdict that renders the dashed "not detailed yet" chip) carries `repairable: false`; `hasRewritableProblems(set)` is the visibility rule the canvas reads, so entity-side problems are REPORTED in the confirmation (with their remedy) and never turn the control on — the owner's boundary, verbatim: "This is about the module text, not entities. Entities are automated in other ways." | a stored problem flag (the derivation IS the answer — a flag goes stale on the first hand edit); a NEW runtime gate or a detector this repo does not already have; a prose-quality check (pacing, fairness, "is it conflicted" — prompt discipline, docs/08 §M4-B-1); putting the entity shortfall (unresolved names) on the rewrite list; heuristic or fuzzy name matching for a phantom link (the normalization pass, judged by the model, is the only name resolver); gating VISIBILITY on entity work, which would make this entity work under a text label |
| Show "Resume automatic module creation" — or, in the entity sidebar, "Generate everything" — only when the live state falls short of its TARGET (owner request, docs/17 rows 71/74/80) | `features/modules/automation-deviation.deriveAutomationDeviation(module, campaignArtifacts, target?)` — the target state is the row's `automationIntent` (what the owner asked creation to automate) or, when `target` is given, THAT explicit target with the recorded intent not consulted at all (so a legacy row with no intent is served instead of inert); the deviation is DERIVED at render by comparing it with what actually exists, and the pool is the SWEEP's (`moduleCreationPool` over the campaign's artifact list) either way. EVERY target list is the sweep's own, exported from `features/modules/post-generation` (`batchTargets`, `imageTargets`, `encountersNeedingMaps`, `encountersNeedingMobPortraits`) plus `moduleGen.unclassifiedModuleNames` for names the text picked up with no recorded type; `deviationLines` is the ONE source of the confirmation's copy, and `automationIntentDrift` refuses a row whose automation fields no longer match the recorded intent (**the recorded-intent path only** — `resumeEverything` passes the target itself, so there is nothing left to drift from) | storing `deviates`/`hasProblems`/`needsWork` on the row (banned by the schema's own doc comment — the deviation must survive every hand edit, and a cached verdict does not); a SECOND target derivation beside the sweep's (the confirmation must name exactly the work the sweep would do); the READER's pool here (a global-library or party name would promise work the sweep skips); inferring intent for a legacy row (`automationIntent: null` ⇒ inert — UNLESS an explicit target was passed, docs/17 row 80); a drift refusal on the explicit-target path; treating the deviation as a gate (nothing blocks on it) |
| Resume automatic module creation (the run) — and, through the same pipeline, the entity sidebar's "Generate everything" (docs/17 rows 74/80) | `features/modules/resume-automation.runResume` — the ONE user-invoked pipeline, called with no target by `resumeModuleAutomation(moduleId, campaign)` (the canvas control: the recorded intent IS the target) and with `FULL_AUTOMATION_TARGET` by `resumeEverything` below: refuses LOUDLY on a row diverged from its recorded intent, on a row with no recorded intent (**both are the recorded-intent path's preconditions** — the explicit target is what serves a legacy row), and on a module whose parts pass is not complete (**never parameterized**: a module whose parts never landed has nothing to automate, whichever target is asked for); returns a no-op with no call, no write, no enqueue and no toast when nothing is missing; otherwise it may run the two EXISTING passes its reasons require (incremental classification for names with no record — `classifyNewModuleEntityNames`; the name-normalization pass when `entityNamesNormalized` is false, because a sweep called with the gate closed would generate nothing SILENTLY) and then the EXISTING sweep `features/modules/post-generation.runModulePostGeneration`, which is additive by construction (unresolved names only, entities without images, encounters without maps, mobs without portraits). It captures `getStopEpoch()` at entry and asks `stoppedSince` before each unit — classification, normalization, sweep — so "Stop all" during a resume ends it where it is; the sweep keeps its own capture for a stop landing mid-sweep | a parallel automation pipeline or a second sweep; re-generating, re-detailing or overwriting anything that already exists (the resume is ADDITIVE — that is the feature); touching the module's PROSE (the text half is "Fix module problems"); running units after a stop, or resurrecting a run the owner stopped; half-running (a normalization that still fails after its retry stops the whole resume loudly rather than letting the sweep generate nothing); a "resuming" flag that has to be cleared |
| Fill EVERY generation gap of one module (the entity sidebar's "Generate everything", owner request, docs/17 row 80) | `features/modules/resume-automation.resumeEverything(moduleId, campaign)` — `runResume` with `FULL_AUTOMATION_TARGET` (`features/modules/post-generation`: every `ENTITY_KINDS` entry in both lists, battle maps and mob portraits on) instead of the row's recorded `automationIntent`, so a module created before that field existed (which the intent-bound control refuses outright) is FILLED rather than refused; the sidebar derives its own visibility and its "Generate everything (N)" count from `deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET)`, shows the passive "Nothing missing" statement when nothing is left (never a permanently disabled button), and a `title` reason while a generation is in flight; the row's `automationIntent` and its four automation fields are NEVER written — they stay the record of what creation was asked to automate (docs/17 row 71) | a second sweep or a second pipeline (the unit order, the gates and the additive guarantees would drift); a stored, inferred or row-written target; redefining "missing" so the count matches a wish instead of the sweep's own detectors; consulting `automationIntentDrift` on this path (there is nothing to drift from) |
| Run a canvas CHAT turn (LLM co-authoring via XML edit commands over the WHOLE module) | `llm/canvasChat.sendCanvasChatMessage` — the request carries the LIVE whole-document editor doc passed by the page at send time (the doc IS the whole module — unsaved edits in EVERY part ride along, never a cached copy, never a row re-assembly) and splits the per-part snapshot it sent from that SAME doc (shared `domain/modulePartsDocument.splitModulePartsDocument` — the ONE assemble/split pair for editor and chat; a scaffolding-broken doc fails the send loud); spine premise EXCLUDED, `==========` delimiters + `[Part <n> of <total> — <title>]` scaffold labels; reply = prose + `<edit all="…"><search>…</search><replace>…</replace></edit>` blocks parsed by the STRICT extractor (`parseCanvasChatReply`, balanced scan; malformed/unbalanced/>40 commands = `CanvasChatParseError`, whole reply failed) + zod `canvasEditCommandSchema`; tolerant ladder `resolveCanvasEdit` runs PER PART (`resolveCanvasEditAcrossParts` — a spanning search cannot match, zero matches pick the closest candidate across parts, an empty part fills via its exact label line, ledger 51), never an auto-apply — aider lineage, ledger 50; a REFERENCE-ONLY grounding block (campaign premise + system label + ALL preceding modules' FULL text, story order, UNCAPPED — `renderChatGrounding`, deliberately not `moduleGen.priorModulesContext`'s caps) rides every request in the final turn, outside the persisted history; the FULL conversation history rides every request (ledger 57 — the message cap is deleted, no omission note; stale `<document>` blocks are stripped from older turns, the current doc rides once in the final turn); a module with no planned parts fails the pre-flight loud; claims the SHARED `llm/canvasBusy` registry (chat + refine serialize, `ModuleBusyError` loud). Application is `features/modules/canvas/chatApply.applyChatCommandsAcrossParts` (EVERY command: ONE CM6 transaction over the whole-document editor, NORMAL history — one undo step per command — then the batch persists through the split-save, only the changed parts hitting the row; a failed part save flips that part's outcomes loud + names the part); in PREVIEW (the default view — editor unmounted, never remounted hidden) the SAME protocol runs against the preview SNAPSHOT STRING (`snapshotChat.applyChatCommandsToSnapshot` — pure string splices through the SAME per-part ladder, no second matcher) and persists through the SAME split-save headlessly (`saveWholeModuleDocument` needs no editor; preview-applied edits have no CM history, so their undo is the DURABLE pre-change snapshot the save seam takes first — §2.3 snapshot row), then the snapshot + highlight advance and the preview re-renders, and return-to-Edit remounts the latest snapshot through the mountDoc path; a broken snapshot fails the send loud via the same `ModulePartsDocumentError` path. Both paths report the last command's first applied range for the last-replacement highlight (page `lastReplacement` state: whole-doc offsets + post-apply doc identity, identity-gated; editor = `lastReplacement.ts` CM6 background mark, preview = optional `WikiMarkdown` highlight prop, byte-identical without it). The flow is `chatController.runChatTurn` (streams prose only; commands apply AFTER the reply; report-to-LLM via `composeFailureReport` with the target part's current text from the live doc) and the preview mirror `snapshotChat.runSnapshotChatTurn` (+ snapshot report variants, excerpt from the current snapshot); the thread (messages + outcomes) persists on the module row's additive `chatThread` field after each settled turn (debounced `chatPersist.scheduleChatPersist`, loud-nonblocking; restores on canvas open as history, never auto-applies) and rides backup/export with the row; applied part edits land through the split-save (`saveWholeModuleDocument`) | a private chat transport; `responseFormat` on the chat call (prose+XML is deliberately not a JSON contract); regex-guessed block extraction; a fuzzy auto-apply on zero matches; matching across the assembled string instead of per part; reusing `moduleGen.priorModulesContext`'s caps (or any cap) on the chat grounding block; `addToHistory:false` on applied commands (undo must revert chat edits); remounting or hidden-mounting the editor to serve preview chat; a second command matcher for the snapshot path; a second chat-thread store beside the row field; a second module-busy registry; chat writing part text directly (the `chatThread` field is its sanctioned row write) |

| Return ONE module's canvas chat to a pristine state (Clear chat) | `features/modules/canvas/clearChat.clearModuleChat` — ROW FIRST (awaited: `chatPersist.clearPersistedChatThread` → the same `patchModule({chatThread: []})` seam the debounced writer uses, cancelling that key's pending debounce; a failure cancels the whole action), then the live conversation (`chatStore.clearModule`) + that module's session ledger (`canvasStore.clearModule`, owner-keyed `moduleId#planIndex`), the page drops the `lastReplacement` highlight (both surfaces); the panel-header control confirms through a destructive AlertDialog whose copy states what is NOT cleared; refuses LOUDLY (toast, nothing cleared) while a reply is in flight or any canvas AI action is live for the module | clearing document text (not an undo — revert lives in the Versions menu: the DURABLE snapshot stack, plus the session ledger as session review state); clearing the module's DURABLE versions (undo history is not chat state — the menu's own destructive item owns that); a second persistence path for `chatThread`; touching another module's thread/ledger/versions/highlight; a cancel-then-clear path |
| Bench image models + chat vision against each other (experiment lab, OUTSIDE the creation path) | `features/lab/` — `LabPage` shell + `experiments/registry.ts` (id/title/description/run config/results renderer; the next bench appends one entry, the shell stays untouched) + `experiments/labeledDungeon.ts` (8 hardcoded irregular rooms, the generation prompt + `{label,x,y}` 0–1000 vision contract now SHARED from `llm/visionDungeon.ts` — the lab aliases the production builder/parser, imports FROM the shared module, never the reverse — plus pure `normToPercent`) + `labClients.ts` (the app's `generateImages` pipeline + the configured chat model with a vision message — NO model pickers; session-only data URLs, no Dexie); `/lab` route linked from Settings → Experiments only, never the main nav | a model picker in the lab; persisting bench results; any creation-path import of lab code (lab imports FROM seams, never the reverse) |
| **Hold a cross-tab generation lease (and opt out of the freeze heuristics)** (docs/17 row 110) | `lib/generationLocks.withGenerationLock(moduleGenLockName(id), work)` around every generation pass (`moduleGen`'s spine/parts passes, `post-generation`'s sweep): `navigator.locks.request(name, { ifAvailable: true }, …)` and the callback's promise IS the hold, so the lock is released when the pass settles (throw, abort or success). With no Web Locks API the work runs DIRECTLY (`webLocksAvailable()` false), and an unavailable lock (another tab) still runs the work | making a pass depend on the lock, or blocking on it (`ifAvailable: true` so a second tab never queues behind a lease — that would be a new failure mode, not a fix); assuming the API exists when reading liveness (a missing `navigator.locks` means the cross-tab half of `isModuleGenClaimed` answers `false` — the page-local registry is then the only signal, stated in §4); an in-repo lock registry standing in for the real API |
| **Tell the owner, from a BACKGROUNDED tab, that a long generation finished or failed** (docs/17 row 110) | `lib/backgroundTitle`: `setBackgroundActivity(id, { label, state })` / `clearBackgroundActivity(id)` / `clearFinishedBackgroundActivities()`, applied through `applyBackgroundTitle()` — `document.title` is written ONLY while `document.hidden` (`Working: <label> — Campaigner`, `✓ Finished: …`, `⚠ Failed: …`, failed outranks finished outranks running, same-rank extras as `(+N more)`), and the app's own title is restored while the page is visible. Runs register from `runEngine` (label = persona name), generation passes from `moduleGen` (label = module title) | writing the title while the page is visible (it is a STRIP surface, not the document the owner is reading); a verdict a stop never reached (a user stop CLEARS the entry rather than inventing "finished"); using the title as a progress meter (the module never guesses "part 2 of 5" — the label is the caller's); leaving a `✓`/`⚠` on screen for the next trip away (`clearFinishedBackgroundActivities` runs on the way back in) |

## 3. Cross-cutting conventions (pointers, not restatements)

- **Parse-on-read** (docs/01 §Repository layer): every repo read zod-parses
  the row — `parseArtifactRow` / `parseBattleRow` / `parseRunRow` are the
  template. Legacy rows get schema defaults materialized; corrupt rows fail
  loudly. New fields ride schema defaults, not migrations; a migration is
  reserved for REAL schema changes (one Dexie version in `db.ts`, e.g. v16's
  unique `&moduleId`).
- **One rw transaction per logical write**: multi-table writes declare all
  tables in ONE `db.transaction`; nested writes must be a table SUBSET of the
  outer tx (e.g. `castCreatureAsNpc` joins `createArtifact`'s).
  Cascading deletes re-list rows INSIDE the tx (count honesty).
- **Every tx that can free an image must include `db.creatureImages`** (real
  incident, docs/17 row 106). `imageRepo.deleteImageIfUnreferenced` /
  `deleteUnreferencedImages` / `pruneUnreferencedImages` implicitly JOIN the
  open transaction and READ the presentation table, so a delete scope that
  omitted it threw `NotFoundError: … object store did not exist` the moment a
  row reached the pruning path — a silent-looking crash in an unrelated flow
  (`removeAllGeneratedContent`). One missing table name in the scope broke three
  test files; the widened scopes are `orphanSweep`, `artifactRepo` (three sites),
  `campaignRepo` (`deleteCampaign`, `removeAllGeneratedContent`),
  `maintenance` and `moduleRepo`.
- **Loud existence checks at ownership boundaries**: writers that reference
  another row (`stampModuleOwnership`, run-finalize placement) verify the
  target exists inside the tx and throw. A module deleted mid-run fails the
  run; kept artifacts of a deleted module surface as an explicit "Orphaned"
  tree group with one-click re-anchor (via `moveScope`) — never silently
  re-anchored.
- **Scope transitions are explicit functions only** (`moveScope` family);
  content patches pin scope fields; revision restore restores content-only.
  A BULK scope change is the same seam, not a bulk raw write:
  `deleteModule(id, 'keep')` releases its rows through
  `artifactRepo.releaseModuleOwnership(rows, tx)` — `moveScope` per row
  against the delete's own transaction, so every released row gets the
  revision snapshot + `updatedAt` a single move writes (ledger 67's arc;
  the previous inline `modify({ moduleId: null })` was the one scope write
  outside the family — docs/18's "one way" rule now holds without an
  exception).
- **Streaming state is subscribed to at the CARD, never at the page**
  (owner-reported "scrolling is slow and jumpy, as if it's getting rendered
  fresh and complete for each tick"; ledger 79). `moduleGenEvents` is in-memory
  and fire-and-forget (nothing is buffered, and `done` fires in a `finally`
  AFTER the row writes — so a tail store must NOT clear on `done`, or the
  streaming card flashes its empty placeholder on the way out; the
  unmount/subject-change reset clears instead). Tails live in
  `features/modules/streamTails` and are read by `StreamingTail` alone. A
  component that re-parses markdown (`WikiMarkdown`) or renders a whole
  document section (`PartBody`, `IntroBlock`) is `memo`ized, and its caller
  passes STABLE identities (`useCallback`, `useMemo`, `planIndex` instead of a
  closure) — jsdom can prove the render churn this prevents, but never the
  paint/scroll cost, so scroll numbers must come from a real browser.
- **Second-module use auto-promotes, loudly** (10 D12): module-owned rows stay put until
  another module references them — then they promote to campaign level through the same
  family (no separate core state). The notice is a batched `toastSuccess` naming the
  using module; a failed promote toasts loudly and never leaves a half-moved row
  (`moveScope` is one tx). The delete dialog's third state is the same rule at delete
  time: promote-and-keep the referenced rows vs force-delete. **Campaign-level exception
  (owner-ratified 2026-09-09, ledger 67):** a campaign-level USE (`userModuleId === null`
  — no using module at all, e.g. a campaign-level encounter's roster save) REFUSES to
  adopt another module's row. "A second module uses this" is evidence; the absence of a
  module is not, and silently pulling a row out of the module that owns it takes it away
  from that module's wiki-links and out of `deleteModule`'s keep/cascade reach. The use
  still lands (advisory, never blocking) and the refusal is loud — artifact, owning
  module, and the remedy (adopt deliberately from the artifact editor, or delete that
  module and use the dialog's third state) — through `toastError`; nothing moves, so no
  promotion is announced.
- **The Party is invisible to module creation** (owner-ratified, ledger 69):
  every module-creation artifact list — the shared cast block, the
  "existing campaign entities/artifacts" prompt indexes, the
  name-classification candidate set, and the resolution sets the spine/parts
  passes, the entity panel, the post-generation batches and the stub popover
  work from — is the module-creation
  pool: ONE domain constant (`MODULE_CREATION_EXCLUDED_KINDS` →
  `visibleToModuleCreation` / `moduleCreationPool`, `src/domain/artifact.ts`,
  the `BULK_REMOVE_EXCLUDED_KINDS` pattern), never a scattered
  `kind !== 'pc'`. A name collision with a PC therefore yields a NEW
  module-owned entity (the player's row is never aliased or re-scoped), and a
  verdict that tries to bind onto a PC fails the existing canonical validator
  loudly. Scope: GENERATION only — the owner's own prose, the reading
  surfaces, the party-level encounter context and the npc-only fixed cast are
  untouched.
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
  same queue; **a DB write into a tree whose live queries are mounted
  (`useModule` etc.) is drained, not awaited bare** — its live-query cascade
  lands in whatever bare `await` follows, taking the open dialog's internals
  with it (`canvas-module-actions`'s stale-confirmation test, docs/08 §Race
  cures) — and a **destructive-confirm dialog is settled (its testid
  waited out of the document) before the test navigates or does raw store
  reads**, since confirming closes it and Base UI unmounts the popup on an
  exit timer whose teardown updates otherwise land outside act under
  parallel-worker load; docs/08 §Console guard has the order and the
  `07a84bd` precedent). The same section holds the inverse case: a
  **confirm action that is `disabled` until a live query resolves is waited
  for (`waitFor` → `not.toBeDisabled()`) before it is clicked** — a click on
  the still-disabled button is a silent no-op, so that test fails on a missing
  call rather than on noise (the census window measured 13–23ms unloaded and
  widens under load; the gate is deliberate design, never weakened for the
  test). Leak prevention: `tests/helpers/flush.ts` — `actDrained`
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
  never silently skipped, and both sides decide "deletable" with the ONE
  `evaluateOrphanGuards` predicate.

## 4. Gotchas

- **A consent prompt may only claim authorship the ROW can support, and
  `edited` is not authorship** (ledger 113). `ModulePart.edited` means
  "written OUTSIDE the generator" — the one part-text save seam
  (`moduleRepo.patchModulePartText`) stamps it on EVERY write that goes
  through it, including model text the canvas applied and the owner accepted
  by ticking a box. Two defects came from reading it as "the owner wrote
  this": the normalization pass held a proposal for every such part (the
  owner's banner about text he never wrote), and the banner said
  "hand-edited". The authorship question is answered ONLY by the recorded
  `origin` through `domain/provenance.textOriginIsMachineWritten`; never
  re-derive it from `edited`, and never from a stored `writerModel` (a hand
  edit deliberately CARRIES the previous model id forward — ledger 93 — so the
  id answers "which model wrote this text at some point", not "who wrote it
  now"). A row written before the field parses to `origin: null`, which means
  the PERSON's text and keeps its consent prompt: that is the conservative
  direction, and it is a policy choice recorded in the ledger rather than a
  fact recoverable from the data — so any surface wording must survive it
  ("written by hand — or before the app recorded authorship"), and a future
  premise write must stamp an origin or its text silently joins the held set.
  The same rule generalizes: a prompt that says who wrote a text is a CLAIM,
  and it may only repeat what the row records. It also applies to writes that
  do NOT change the authorship: the board's Apply adopts the engine's own text
  and its Discard puts the previous text back, and deriving either from an
  omitted writer model would stamp "the owner" on a model's rewrite — so those
  two callers state the origin they hold (the seam's optional `authorship`),
  and the Discard's answer is captured at stage time because the rewrite
  overwrites the row before the decision is made.
- **A slot must never be offered without its VOCABULARY, and the window and the
  resolution must share ONE source** (ledger 114). The module creator's
  bestiary slot was offered on the strength of a BOOLEAN
  (`listLibraryCreatures().length > 0`) while the clause showed a single
  EXAMPLE name — so a German module answered «Zombie-Schläger»,
  «Zombie-Schlurfer» and a name that tried to encode a level-adapted variant,
  and every one of them was refused by a lookup that was working exactly as
  designed. The refusal was never the fault; asking a model to name a creature
  from a list it cannot see is. Two rules follow, and both are measured:
  1. **The vocabulary and the lookup are the SAME population**
     (`db/creatureRepo.listLibraryCreatures` — every stat-block chunk of ANY
     book origin). A window built from a narrower pool (the encounter roster's
     `origin === 'pack'` filter) is *empty* for a library imported from an
     ordinary rulebook while the slot is still offered: the same defect with a
     different trigger, and one that no pack-based test would catch. Where a
     window and a resolution could disagree, the WINDOW is wrong.
  2. **No vocabulary ⇒ no offer.** An empty library AND an empty window both
     compose the pre-change prompt byte for byte, slot included — a slot whose
     list is empty is uncastable by construction, so offering it can only
     produce invented names. The clause rides the EXISTING entity-kind bullet
     (no new placeholder, no template change), which is what keeps this
     additive: a style's own bytes never move.
  The refusal's other half is a MESSAGE, never a match: the nearest creatures
  are computed for the sentence only, the resolution stays exact
  (`sameName` is untouched), nothing is auto-substituted, and when nothing is
  close the suggestion is EMPTY rather than a wrong "did you mean".
- **An offer the deleter will refuse is a bug** (ledger 92). The orphan
  panel used to tag rows with its own read-time predicate while
  `sweepOrphanedArtifacts` applied FIVE guards inside its transaction, so the
  panel counted and listed rows the sweep always refused: the owner pressed
  "Delete 2 orphans", the sweep deleted none — both creatures were cited by a
  live encounter's roster — and the same two rows came straight back, an app
  repeatedly inviting the deletion of creatures in a live fight. The rule is
  two-sided: (1) the read-time deriver and the transaction deleter must share
  ONE guard predicate (`evaluateOrphanGuards` — never a second walk of the
  guards, and never a weaker set at read time: the guards stay exactly as
  strong as they are); (2) a refusal must never leave the same rows offered —
  a row a derivable guard refuses renders as IN USE with the sweep's own
  reason and no destructive control, and a guard the panel's props cannot see
  (the campaign-wide mention gate, battle tokens/seeds) is closed by RECORDING
  the sweep's refusals in the panel's view
  state (`orphanOfferView`), never by widening the hook's props (docs/08
  §M4-C binds it to `module` + `artifacts`). The recorded refusals hold for
  the mounted module and are deliberately NOT cleared when the artifact pool
  re-fires — a sweep that deletes rows changes the pool, and clearing there
  would re-offer exactly the rows it just refused; the two derivable guards
  (the encounter roster and the ambiguity shadow) are always live, so fixing
  the underlying citation clears immediately. Consequence to keep in mind:
  for the three underivable guards the FIRST offer after a page load can still
  name a row the sweep will refuse once — it is refused once, named, and then
  never offered again in that view.
- **"Unmount" is not "the page is going away" — and a flush test that waits longer than the debounce proves nothing** (ledger 111, extended by row 118). A debounced writer's unmount flush covers a route change and NOTHING else: **closing, discarding or freezing a tab never unmounts React** — the page is simply taken away, the effect cleanup never runs — so a settled chat turn, a typed New Module draft, a dragged board layout or a half-typed artifact edit sitting inside its window was simply gone (`lib/pageFlush` is the seam that closes it: `pagehide` plus `visibilitychange` → `hidden`, ONE registration list and ONE listener per event, now carrying FOUR writers — the chat thread, the New Module draft, the board's layout debounce (row 118) and the artifact editor's 800 ms autosave (row 118)). Three rules come out of building it, all measured on this box. (1) **A flush must be PENDING-GATED**, because `visibilitychange` fires on every tab switch, minimise and app-background: an ungated flush turns a display event into a row write — measured by removing the `hidden` gate (reds the "visible is not a write" pin), by removing the board's gate (reds three pins, including "writes nothing … when no layout write is pending") and by the draft writer, whose unmount `flush` writes a touched draft even after its timer fired, so its page-hide half had to be a gated wrapper rather than the unmount function itself. (2) **A test for a flush cannot wait longer than the debounce it is bypassing.** The first version of the chat page-hide pin asserted with a 5 s `waitFor` and stayed GREEN with `registerPageFlush` deleted outright: the 600 ms debounce landed the write inside the wait, so the test proved the timer, not the flush. Every flush pin now asserts the write was issued by the EVENT itself — the board's `patchModule` call is asserted synchronously, in the same turn as `dispatchEvent`, and the editor's row writes are counted after a microtask-only drain — so a deleted registration reds the pin instead of being absorbed by the timer. Generalised: when a test's subject is "this made the work land EARLIER than it otherwise would", the assertion must be bounded by the thing it is beating. One trap on the instrument side, MEASURED: a test that wraps a real writer with `vi.fn(real)` and calls `mockReset()` between tests turns the mock into a no-op unless the real implementation is put straight back (`mockImplementation(real)` — `vi.restoreAllMocks()` alone does NOT clear an implementation given at construction time, so the danger is the reset, not the restore) — and a counter that never reaches the real writer makes every "writes nothing" pin pass for the wrong reason.
- **A `vi.mock` of a module whose namespace is RE-EXPORTED through a barrel does not reach the component** (row 118, measured). `src/db/index.ts` re-exports the repositories as namespace objects (`export * as artifactRepo from '@/db/artifactRepo'`), and a namespace re-export is its own frozen module object: the component reads `artifactRepo.updateArtifact` off the BARREL, so a `vi.mock('@/db/artifactRepo')` the test installed was never called — the REAL write ran, and the pin read green while proving nothing. Worse, the obvious repair fails loudly in the other direction: assigning over the barrel's property throws `TypeError: Cannot set property updateArtifact of [object Module] which has only a getter`, so `vi.spyOn`/direct assignment are both out. What worked is watching the boundary the barrel's object actually reaches: the test hooks the Dexie TABLE the save writes (`db.artifacts.put` / `db.revisions.put`, re-bound with `.bind(db.revisions)` so the unbound-method lint rule is satisfied) and asserts the real write count. Generalised: when a mock did not take effect, do not conclude the code under test is correct — assert on a boundary whose identity you can prove (this session proved it by logging `_isMockFunction` from inside the component).
- **The module scene text is BINDING on the encounter it stages, not
  background — and a prose/roster contradiction is a REPORTED condition, never
  a silent substitution** (ledger 89, docs/11 §The scene is the truth). The
  scene reached the encounter prompt all along, but as *"Where it is
  mentioned:"* — context — while the designer's instruction was to build a
  level-appropriate, citable, environment-plausible roster, so what the text
  asserted about the fight carried no authority: two risen lumberjacks on a
  boggy footbridge became a sea hag, ghoul soldiers and skeletal guards. The fix
  is directional and has no threshold — everything the scene ASSERTS is fixed
  (roster AND map), everything it leaves open is the pipeline's to design — and
  it lives in FOUR places at once (the writer's contract clause, the encounter
  prompt section, the brief's framing label, the `substitutions` declaration;
  §2.2). Three consequences are easy to get wrong: (1) **a stated creature is
  never swapped for a generic equivalent in silence** — that path is the
  collision the owner's rule exists to kill, so a creature with no citable stat
  source is inlined as a complete `statBlock` for exactly the creature described
  or DECLARED in `substitutions`, which renders through the existing
  `data.budgetAdvisory` seam the fixed-cast advisories use (never a second
  surface, never a blocking failure); (2) **no code judges whether the prose is
  "specific enough"** — a classifier threshold is what a model answers
  inconsistently and then rationalises, and the vagueness half is load-bearing
  the other way: where the text says nothing the pipeline must design freely
  (pinned in the contract text AND the prompt), because a rule that read as
  "always obey the text" would make every vague scene worse; (3) **the contract
  layer is CODE, not recorded data** — changing a contract VALUE re-renders the
  parts prompt for every style, INCLUDING a module that already exists and is
  resumed (its recorded `templateText` is the style layer; the values are
  injected fresh), which is the owner-approved price of coherence between the
  prose and the encounter. So: never change a style TEMPLATE to carry the rule
  (the templates are frozen; only injected values move), and when a contract
  value changes, the composed-bytes fixtures under `tests/fixtures/promptStyles/`
  and `tests/fixtures/encounterGuardrails/parts-guardrail-default.txt` are
  hand-updated line by line — their pin means "no unintended drift" from that
  point on, while the spine fixtures and the floor-message golden keep their
  original "byte-identical to the pre-styles builders" meaning. Regenerating a
  fixture from the current code is never evidence.
- **A model-authored stat block is validated at the BOUNDARY, because
  `parseLevelSort` THROWS downstream** (ledger 90, docs/11 §D5 amendment). The
  inline `statBlock` a persona embeds is the ONE place a model writes a
  creature level, and `llm/encounterRoster.parseLevelSort` — the app's single
  level parser — rejects anything that is not a number, a fraction or `"—"` by
  THROWING. Every consumer therefore has to be defensive, and only some are:
  the bestiary roster turns the throw into a per-row data error (the creature
  disappears behind an error), `roomBudget.parseBudgetLevel` reports
  `unparseable` (a loud-unverified room), and `spawn-picker-logic.parseLevelOrLast`
  catches and sorts last — but the value was still PERSISTED (the owner's
  "Level sourceName" reached a real `npc` artifact and every view of it). The
  fix is not a second level grammar and not a defensive catch at each reader:
  the level is refused where the model authors it — `statBlockLevelIssues`
  inside `encounterSourceIssues` (both encounter contracts, existing
  repair-then-loud) plus the independent refuse in `materializeMonsterNpc`
  (§2.2). Two traps: tightening `domain/statblock.ts` "for safety" breaks TWO
  documented legitimate states — the editor's blank stat block
  (`blankStatBlock` parses `level: ''`) and PDF-ingested chunks, whose
  best-effort levels sort last by design (`tests/features/spawn-picker.test.tsx`
  seeds a chunk at level `'high'` on purpose) — so the acceptance set lives at
  the model boundary, not on the shared read schema; and the prompt's shape hint
  is part of the contract, because a bare `"level": string` invites exactly the
  slip that shipped.
- **An `npc-ref` roster entry is not automatically someone else's portrait job**
  (ledger 90, docs/11 §D5 amendment). Two batches used to split the roster by
  `monsterSource.type` — `rulebook` in one, `inline`/`none` in the other — and a
  materialized monster (`npc-ref` → the artifact the encounter created for a
  creature the prose staged) matched neither, so the owner's click answered
  *"No creatures to illustrate — add roster entries first"* while his two risen
  lumberjacks sat in the roster with no cover. Route by the row's creature
  IDENTITY, which is now a first-class value (`domain/creature`): a cited
  creature's key is the library chunk it names; an invented one's is its NAME
  AND its stat block (`contentCreatureKey`) — and that content identity is the
  ONLY thing standing between an invented creature and the global `mobPortraits`
  cache (owner decision: *"A special look for a special zombie is ok"*), so
  never hand a library key to an invented job or a lane label to a router. Enumeration has no art side effects: an artifact with a cover is
  `alreadyImaged` and is never detached, replaced or regenerated — which is what
  keeps a named NPC's own portrait safe.
- **A settings-row field is never allowed to be load-bearing for the whole
  row.** One unvalidated CONVENIENCE field took down every settings read in the
  app (and with it every settings-dependent surface), because the row was parsed
  as a single object: the New Module draft. The rule is the rip-out arc's, one
  step further — a retired/non-load-bearing field is tolerated on read, and any
  field that cannot be tolerated must be validated SEPARATELY so its failure
  stays scoped to itself (`settingsRepo`'s `coreSettingsSchema` +
  `readStoredNewModuleDraft`, docs/17 row 76). A NEW optional settings field that
  can be written by an older version belongs in the second camp.
- **The module prompt style resolves in ONE order, and the app default is not a
  rung of it.** A module's style is `promptStyleForModule` → the style the module
  RECORDED, else Classic by PROVENANCE (that is the text it was written with);
  `settings.defaultPromptStyleId` — Freestyle since docs/17 row 88 — is consulted
  ONLY where no style has been recorded for the module being CREATED
  (`resolveCreationPromptStyle`, `src/llm/moduleGen.ts`). Reading the app default
  in the module resolver looks like an obvious simplification and is in fact a
  silent re-voicing of every module written before styles existed, on its next
  resume, repair or per-part regeneration — the LEGACY block of
  `tests/llm/promptStyles-classic-identity.test.ts` plus
  `tests/llm/promptStyles-default-style.test.ts` fail when it is tried. A stored
  `defaultPromptStyleId` is data and is honored verbatim: no migration, no Dexie
  version, no upgrade normalization rewrites it.
- **A Dexie liveQuery querier that `await`s before touching Dexie never
  registers its range — the subscription then goes DEAF (measured).** Adding one
  microtask of delay before the table read inside a `useLiveQuery(() => read()…)`
  querier (a mocked read wrapped in `.then()`, a delayed helper) makes Dexie
  record no range for that subscription: the querier is called exactly ONCE for
  the mount and never again, so a test that "holds the read open" to reproduce a
  prefill race measures its own artifact and cannot pass whatever the product
  does. If a querier needs to wait for something, make it an `async` function
  (Dexie's `isAsyncFunction` path accounts for the awaits) — and reproduce a
  write/prefill race by delaying the WRITE, not the read (docs/08 §Race cures).

- **Dexie variadic cap.** `db.transaction(mode, t1…t5, scope)` caps at five
  tables (the scope function must be the last argument); more tables → the
  ARRAY form (`deleteModule` passes seven tables as an array; `deleteArtifact`,
  `attachImagesToArtifact`, `moveScope`, `exportImport` likewise). Tests that pin transaction shape
  reassign `db.transaction` (bind the original) — `vi.spyOn(db,
  'transaction')` is not reliable on the Dexie instance, and WhereClause
  objects are Proxy-wrapped (spying `.first()` resolves undefined); the
  working wrapper pattern is in `tests/db/removeAllGeneratedContent.test.ts`.
- **Unique-index get-or-create.** Concurrent get-or-create converges by
  catching `ConstraintError` — match by error NAME, fake-indexeddb's
  DOMException shares it — and re-reading the winner
  (`battleRepo.ensureBattle`, v16 `&moduleId`). Alternatively serialize
  scan+create in ONE tx (`db/creatureRepo.castCreatureAsNpc`, whose idempotency
  per (campaign, module, name, IDENTITY) is the live example).
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
  (`part-<planIndex>`), the canvas↔module seam and the encounter floor's band
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
  The DURABLE undo stack is a SEPARATE, parallel thing, deliberately not a
  "fix" to this one: whole-document snapshots taken before each AI change
  (`moduleVersions` / `moduleVersionRepo.snapshotModuleVersion`, §2.3) survive
  reload, while the session ledger keeps the semantics above unchanged (its
  header comment stands verbatim). Consequence (known behavior, not a bug):
  the CHAT THREAD persists on the module row, so a canvas reopened on a
  previous session's thread can show applied edits while the menu's SESSION
  group reads "Nothing accepted yet" and the header shows the passive Saved
  indicator (the doc matches the row) — the durable group above it lists that
  session's AI pre-change
  snapshots, so the state is still reviewable and revertible after the
  reload. The chat's **Clear chat** control (`clearChat.clearModuleChat`,
  §2.3) is the way back to a pristine CONVERSATION for one module; it does not
  touch the durable stack (that is the Versions menu's own destructive "Clear
  all previous versions").
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

- **The creature tier: a LIBRARY creature is not an artifact, and only the
  module side may CAST one.** Three facts, and the arc that produced them
  (docs/17 row 106) exists because the old model had a hidden `npc` artifact per
  cited chunk carrying `data.monsterChunkId`, which made 67 usages across 17
  files ask "is this NPC actually a mob?" — the question that stranded two
  encounter roster entries on a permanent `missing ref`.
  1. **Library tier, read-only and addressable.** A creature is a statblock
     chunk (or a prose chunk whose stat block the reader derived).
     `db/creatureRepo.listLibraryCreatures` / `wikiLinkCreatures` /
     `publishLibraryCreaturePool` (the app shell publishes it once per library
     state, `app/use-library-creatures`) READ it; nothing in the app writes a
     library row, and there is no guard file left to enforce that because there
     is no writer. A mention resolves to a DERIVED node
     (`lib/wikilinks.WikiLinkCreature`), so `[[Zombie]]` resolves for the reader
     (docs/11 D10) while the module entity view correctly answers "not detailed"
     — resolution and DETAIL are different questions.
  2. **A citation is data, never a row.** The roster's `source` variants are
     unchanged on disk (`rulebook` / `npc-ref` / `inline` / `none`, docs/11 D2)
     and `db/creatureRepo.resolveCreatureCitation` resolves ONE citation by
     chunk id, falling back to the content hash recorded at citation birth
     (survives a re-ingest under new row ids) and THROWING when the ref carries
     neither. The resolution NEVER creates anything: no artifact, no module row,
     no battle row.
  3. **Casting is ONE function, and only the module side holds it.** An `npc`
     carrying `data.creatureRef` is a CAST CREATURE: an AUTHORED row that
     borrows the library's stat block (owner's path, verbatim: *"Often modules
     want lets say a zombie, but its old aunt agatha. So, she will have zombie
     stats but with prose."*). `db/creatureRepo.castCreatureAsNpc` is
     idempotent per (campaign, module, name, IDENTITY) — created once, REUSED
     without a write thereafter — refuses a rival drawing from a different
     creature or an authored npc of that name, refuses a creature the library
     cannot supply, and stamps `moduleTagFor(module.title)` so the row is an
     ordinary module-owned npc to every module-scoped reader. Its stats are
     DERIVED at read time (`resolveDerivedNpcStats`), never stored: the
     `npcDataSchema` refine makes "a citation AND an authored stat block" a
     parse error, so the two sources of truth cannot both exist. The asymmetry
     is enforced by ABSENCE OF A FUNCTION, not by a guard: the encounter and
     sweep paths have no cast seam and no schema field to express one (pinned in
     `tests/db/creatureRepo.test.ts`), while the module generator and the
     bestiary spawn dialog are the two callers. AMENDED (docs/17 row 107): the
     module generator no longer only HOLDS the function, it can now ASK for it —
     an entity record carries an optional `bestiary` slot (the library
     creature's name, plus a book to disambiguate), the spine prompt states the
     clause offering it whenever the workspace has creatures to cast, and
     finalize resolves the name and calls `castCreatureAsNpc`. The request is
     the model's; the cast is still only ever this one function's (§2.1).
  Consequences a future edit must preserve: the cast row's `creatureRef` is
  never written by any writer (it is a different field from the one prose and
  stat-block writers touch), `changeArtifact` REFUSES a cast row (an instruction
  can rename it, and the name is the cast's identity — a rename would let the
  generator cast a second row for the same creature), and a refill of one is
  legal and rewrites only its prose. Portraits ARE presentation
  (`features/campaign/mob-portrait-queue`, `db/creatureRepo.setCreatureCover`):
  one canonical blob per identity in the global `mobPortraits` table plus one
  per-campaign presentation row in `creatureImages`, and every surface asks
  `creatureCoverImageId` — the reading that makes `artWithoutCover`
  structurally impossible (a creature the board illustrates is illustrated for
  the batch too, because they ask the same question).
- **The module entity view asks "does this name have an authored, DETAILED
  entity of its own?" — never "does anything resolve?"** The ONE verdict is
  `features/modules/detailed-entity.ts` (`detailedEntityVerdict` /
  `hasDetailedEntity`, read over the resolution's own winning-tier candidates;
  a creature answers `WikiLinkCreature`, so the creature half is the resolution
  ITSELF — there is no artifact marker to inspect any more, which is what killed
  the owner's bug at its root), and exactly TWO seams read it: `use-module-entities.useModuleEntities`
  (the entity panel's rows, buckets, "N detailed · M mentioned" line and batch
  work queue) and `post-generation.batchTargets` (the sweep's target set — and
  through it the "Generate everything" / "Resume automatic module creation"
  deviation, so a confirmation can never promise work the sweep skips). A name
  whose only resolution is a library creature is therefore NOT detailed: the
  panel offers it as work (the row carries a `bestiary only` marker whose title
  and screen-reader sentence name the creature the text cites and the remedy),
  the batch and the automation generate the module's OWN `npc` of that exact
  name (module-owned from birth, so the module tier then prefers it and the
  reader shows it too), and NOTHING is created for the library creature — that
  half is now structural rather than a pinned promise. Boundaries, deliberate:
  `imageTargets` keeps its own resolution semantics (an image job attaches to
  whatever row the name resolves to; the panel's images mode refuses a
  not-detailed row with "Detail this entity first"), the wiki-link tier rule
  (`resolveWikiLink`, module tier beats campaign tier) is untouched everywhere,
  and a name whose winning tier contains an authored row is detailed even when a
  creature row is the resolution's own winner (answering "not detailed" there
  would generate a duplicate beside an authored entity). Consequence worth
  knowing: a creature-only name with no recorded kind now also reads as
  unclassified in the panel (the classification pass is how a name becomes
  batchable). Ledger 82.

- **"Generate everything" fills ARTIFACT gaps derived from text that already exists — never the text itself** (docs/17 row 80; docs/05 §Screen: Module reader states it in the confirmation too). A fight the prose stages with no `[[encounter]]` link of its own, or with no `encounter` RECORD, is invisible to every derived detector: `countModuleEncounters` counts recorded canonical `[[encounter]]` links only, and the PARTS pass creates no encounter artifacts at all (encounters come from the encounter persona through the entity batch). The remedy for that case is the text path — "Fix module problems", a scoped prose rewrite with a durable snapshot — because detecting it would need a prose classifier over the spine and the scene tags, which docs/17 row 75 rejects.

- **The configured model is not the serving model — provenance comes from the reply, never from settings** (docs/17 row 93). Every chat call is resolved twice: the model we ASK per call (`resolveChatModel(settings, persona.model)` + the task's tier) and the model the SERVER reports it actually served with (`chat()`'s `modelUsed`, after `modelFallback.walkModelChain` may have escalated, or after a contract-repair retry ran on the escalation tier). Those differ exactly when the owner most wants to know what happened — and a settings lookup (or `opts.model`) would print the model we asked for, silently mislabelling the text on screen. Hence the rule: the WRITE SITE records the `modelUsed` of the call that produced the text it is saving (a repair turn's id when the repair turn is what shipped), the field is additive and read-time-defaulted (`.default('')`, no Dexie version), and `''` MEANS "not recorded" and renders NOTHING — a row written before the field keeps showing nothing forever, because inventing an id from today's settings is a lie about the past (owner decision). Three consequences worth knowing: (1) a HAND edit KEEPS the recorded id (`patchModulePartText`/`updateArtifact` treat an omitted `writerModel` as "carry", so the owner editing prose cannot erase which model wrote it — the id answers "which model wrote this", owner decision); (2) the field must never enter an LLM-facing contract, because a `.default('')` property comes out REQUIRED in the strict subset (`strictSchema`) and would force the decoder to invent an id — the spine's emitted schema omits it explicitly, and the draft contracts are separate schemas from the artifact row for this reason; (3) it is APP ONLY (owner decision): the PDF builders read explicit fields off rows and pre-rendered strings, so the ids never reach a shipped document — `tests/lib/provenance-export.test.ts` builds the REAL definitions from content that carries provenance and asserts no id (nor the field name) appears, while also asserting the ids are present on the rows, so the negative cannot pass vacuously.

- **A root `tsc --noEmit` type-checks NOTHING — the gate is `pnpm typecheck`
  (`tsc -b`)** (real incident, provenance landing `5b01142`/the follow-up). The
  root `tsconfig.json` is `files: []` plus `references` to `tsconfig.app.json`
  and `tsconfig.node.json`, so a bare `tsc --noEmit` builds an EMPTY program: it
  exits 0 on a tree with any number of type errors and reads exactly like a
  clean gate. It is only a project-reference dispatcher, and `-b` is what makes
  it build the referenced projects. What that costs: `tsconfig.app.json` covers
  `src` **and `tests`**, so `tsc -b` is the ONLY check that sees a test literal
  or a JSX call site missing a newly required field. The provenance landing
  shipped **36 type errors** (one of them PRODUCTION code — a reader branch's
  `IntroBlock` call site that dropped the now-required prop, so that branch
  silently rendered a premise card with no id) behind a reported "typecheck
  clean" that was this vacuous command. Rule: gate with
  `pnpm lint && pnpm typecheck && CAMPAIGNER_TEST_WORKERS=2 pnpm exec vitest run`
  — lint (typescript-eslint without type-aware project coverage of every file)
  and vitest (transpile-only, no type checking at all) cannot stand in for
  `tsc -b`, and a REQUIRED field on a zod-derived row type is exactly the change
  that slips past them (hand-built fixtures in ~20 test files did).

- **Provenance captions never enter the text they caption — and the canvas
  proved why** (owner decision, docs/17 row 93 amendment). The owner reversed
  the first "the canvas shows no id" call: "i do want to see who wrote the
  module text and i dont think i can see that elsewhere. So… please put it below
  the module text." The canvas is the trap: its editable document is the WHOLE
  module text assembled by `assembleModulePartsDocument`, and that string is
  persisted to the parts and re-sent to models — so an id placed "below the
  text" INSIDE it would become model INPUT (the same rule as the LLM-contract
  consequence above: provenance is never model input). Hence the placement rule
  the canvas obeys: the ids render as SIBLINGS of the text, from the SAVED ROWS
  (`module.parts[].writerModel` keyed by `planIndex`, `module.spine.writerModel`)
  — a per-part caption in the preview and a footer strip outside the editor —
  and they never touch the doc string, a part's `markdown`, or the assembled
  text. Pinned by `tests/features/canvas-provenance.test.tsx`, which asserts the
  ids are on screen AND absent from the live CodeMirror doc, the persisted
  parts' markdown and the assembled text. Generalize it: anywhere a caption sits
  next to editable or model-bound text, read the id from the row and render it
  outside the payload.

- **A detector that reads the roster's SHAPE instead of the roster's PARTICIPANTS under-reports, and the offer then silently disagrees with the work** (owner report, docs/17 row 96). `post-generation.encountersNeedingMobPortraits` used to answer "does this encounter need portraits?" with its OWN rule — roster rows whose `source.type === 'rulebook'` — so an encounter whose creatures were materialized into artifacts (`npc-ref`, INCLUDING the core/bestiary ones carrying the `monsterChunkId` marker) or left uncited produced an EMPTY deviation: the module sweep enqueued nothing for it, and the entity sidebar's "Generate everything" control was not rendered at all (its place said "Nothing missing") although the roster showed un-imaged mobs. The rule is ONE predicate — `features/campaign/mob-portrait-participants.encounterNeedsMobPortraitWork`, built from the same routing/art/kind-identity rules the queue's enumeration imports (`rosterParticipantRoute`, `portraitArtOf`, `chunkKindKey`/`inventedKindKey`) — and the module sweep runs BOTH lanes (`enqueueMobPortraits` + `enqueueInventedCreaturePortraits`), additively, exactly as the encounter editor's fill does. Generalize it: when a surface promises work, derive the promise from the roster's PARTICIPANTS through the queue's own enumeration, never from the shape of the rows; and never gate a lane on that shape (the editor's own press gated the rulebook lane on `rulebookCount === 0`, so a roster of nothing but chunk-backed `npc-ref` monsters was counted as "Fill 1 missing portrait" and then enqueued nothing). Two readers must also agree on WHICH switch decides: the sweep reads the RUN's own config (`target ?? module`, destructured once — the four fields together), so `module.autoGenerateMobImages` in the portrait block (while images, entity kinds and battlemaps all read the local) made the entity sidebar's confirmation, which is derived from the TARGET, promise portraits and enqueue none for a module whose row had the toggle off (the default). The one deliberate residue is the LOUD direction, not silence: a roster row whose artifact the snapshot cannot see (a dangling `npc-ref` or stamped `mobArtifactId`, or a row this campaign does not own) counts as work — the enqueue resolves it from the DB or throws naming the creature, aggregated into the sweep's one per-encounter failure toast — because the queue's per-kind dedupe plus skip-if-imaged make a re-run a no-op.
- **The offer and the work ask ONE portrait question, and a surface that NAMES
  work must pass the presentation snapshot** (docs/17 row 106, docs/11 D6). Two
  failures were found by tests while landing this arc, both in the "the offer
  disagrees with the batch" family:
  1. `enumerateBatchKinds` answered "is this creature imaged?" from the
     presentation table ALONE for the creature lane, so a CAST npc that carries
     its own cover was reported MISSING — the batch would have generated a second
     portrait over the owner's art. Both the batch and
     `encounterNeedsMobPortraitWork` now ask `creatureCoverImageId` (presentation
     row → the artifact's own cover), which is the same seam the board and the
     roster badge render from.
  2. The deviation/sweep callers had no way to see a presentation row at all.
     `encountersNeedingMobPortraits(module, artifacts, presentationByKey?)` and
     `deriveAutomationDeviation(module, artifacts, target?, presentationByKey?)`
     take it optionally; omitting it keeps the documented CONSERVATIVE answer
     (the batch is skip-if-imaged, so nothing is regenerated) — but a surface
     that lists specific work passes it, and `resume-automation` and the reader's
     "Generate everything" panel both do (`app/use-creature-presentation`).
     Consequence to remember: `artWithoutCover` is now structurally impossible —
     art that the board shows is art the batch counts, because there is no second
     reading left to drift.
- **A "missing ref" is ONE reason with an OPTIONAL NAME, and a surface that
  compares it to a literal goes silently dead** (docs/17 row 106; the bug was
  mine and a test caught it). The resolver's reason became
  `missing ref (Ghost Lumberjack)` — the cited name rides along, because a bare
  stem tells a GM nothing — while `missing-refs-banner.tsx` and the roster badge
  still compared the origin to the exact string `'missing ref'`, so the banner
  never fired and nothing failed: the data was right and the surface was mute.
  The predicate is `domain/encounterResolve.isMissingRefOrigin` (hash fallback
  tried FIRST, one surviving reason shape), and every surface between the
  resolver and the pixels must read it instead of re-spelling the string.
- **A delete census counts what the delete will DO, so narrowing its inputs is a
  user-visible change** (docs/17 row 106, docs/05 §Surface: campaign tree).
  `describeArtifactKindRemoval` is the live census the delete dialog prints, and
  it is computed by the same predicates the deletion runs — which is the point.
  Two numbers moved when the creature tier landed, and both moves are CORRECT:
  `rosterRefsDangling` counts only roster entries that name an ARTIFACT (a
  `rulebook` citation names the library, so it cannot dangle and is no longer
  counted), and the cascade no longer sees the retired hidden creature rows
  because the sweep no longer creates them. A future edit that "restores" either
  number is re-introducing the mob artifact, not fixing a regression.
- **A lane's writers are defined by ABSENCE OF A FUNCTION, not by a guard.**
  The encounter and sweep sides may CITE a library creature and may never CAST
  one: they hold no cast seam and the roster schema cannot even express the
  field, so there is nothing to check at runtime (pinned in
  `tests/db/creatureRepo.test.ts`). The module generator and the bestiary spawn
  dialog are the only two callers of `castCreatureAsNpc`, and the module
  generator is the only place the owner's Aunt Agatha path belongs (*"the
  encounter generated mobs ... should not introduce important NPCs on their
  own"*). Deleting a guard is right when the thing it guarded can no longer be
  expressed; keeping it "just in case" is how the 67-usage classification maze
  grew back.
  AMENDED (docs/17 row 107): the module generator can now ASK for a cast — an
  entity record carries the optional `bestiary` slot, the spine clause offers it
  — and that does NOT weaken the asymmetry by one inch, because the encounter
  side still has no schema field and no function to reach: the pin was EXTENDED
  from the encounter artifact's data schema to the encounter GENERATION
  contracts (the Smith draft and the Cartographer brief carry no `bestiary` and
  no `cast` property anywhere, `runEngine`/`encounterRoster` name neither
  `castCreatureAsNpc` nor `bestiarySlotForEntity`), in
  `tests/llm/moduleGen-cast.test.ts`. The direction to remember is the one the
  owner gave: the generator ASKS, the encounter side cannot even speak it.

- **A clause that is added to a shared prompt must be rendered CONDITIONALLY on
  something a run already has, or it changes the prompt for every workspace that
  has nothing to do with it** (docs/17 row 107, the additive discipline). The
  bestiary slot's clause rides the entity-kind bullet
  (`llm/promptStyles.spineEntityKindsClause`) and renders ONLY when
  `db/creatureRepo.listLibraryCreatures()` is non-empty: a workspace with no
  bestiary composes the pre-change prompt **byte for byte**, which is MEASURED,
  not asserted from memory — `tests/llm/moduleGen-cast.test.ts` runs the real
  `runSpine` against the same module row the pre-style golden was captured from
  and compares the prompt to
  `tests/fixtures/promptStyles/spine-classic-default.txt` character for
  character, then asserts the WITH-library prompt's delta is exactly
  `spineEntityKindsClause(true) - spineEntityKindsClause(false)` and that the
  field is mentioned nowhere else in the prompt. The style-preview surface is
  the deliberate exception (`features/settings/prompt-style-preview` renders the
  clause as PRESENT — it documents what a placeholder holds when it holds
  anything, and the template itself is identical either way).
- **An ability value is a d20 SCORE in EVERY system — a printed MODIFIER is
  never one, and only the SIGN can prove which the model meant** (owner report,
  docs/17 row 95, docs/12 §5). A generated Pathfinder 2e mob rendered
  **"2 (−4)"**: the model printed PF2e's modifier `+2`, `numericStat` (the
  shared schema's coercion) turned `"+2"` into the number `2` because
  `Number("+2")` is 2, and every consumer then read `2` as a score — the stat
  block, and the battle initiative's `abilityModifier(2) = -4`. The fix sits at
  the MODEL boundary, the same family as the level validator above:
  `statBlockSchemaHint` STATES the convention (worked example included) and
  `statBlockSignedAbilityIssues` refuses a signed value as a NAMED issue on the
  existing one-repair-then-loud path, at all three places a model authors a
  stat block (the Smith draft and the Cartographer brief through
  `encounterSourceIssues`, and the statblock step's own reply). Two traps.
  (1) **It must read the RAW reply**: the sign is destroyed by the shared
  schema's own coercion, so the check is fed the pre-coercion object the
  boundaries already hold — it deliberately has NO `materializeMonsterNpc`
  twin, because finalize only ever sees the coerced value and a check there
  would have to guess. (2) **The UNSIGNED case is not mechanically catchable,
  and must not be "fixed"**: a model that writes the bare number `2` while
  MEANING the modifier is indistinguishable from a creature that genuinely has
  a score of 2 (a plausible low-Int monster really is 2 — and so is a genuine
  score of 2 on a d20 sheet), so no threshold, plausibility range or heuristic
  may separate them; guessing would corrupt correct data. The defence for that
  case is the contract wording plus the worked example, and the ledger row says
  so. `domain/statblock.ts` stays exactly as permissive as it was — it is the
  READ boundary for the blank editor form and PDF-ingested chunks — which is why
  `statBlockSchema` was NOT tightened.

- **A test that starts real orchestration must SETTLE it before its teardown wipes the
  database — a pending continuation otherwise turns a green gate RED** (docs/17 row 97,
  docs/08 §the pending-continuation flake). The shape: a fresh encounter's creation
  hands the unattended Cartographer RUN to the encounter-map queue, and
  `runEngine.startRun`'s pipeline is FIRE-AND-FORGET (it resolves once the row is
  written) — the QUEUE, never the test, waits for a terminal status. A test that
  returns while that run is still `running` leaves a live pipeline mid-write, and the
  next test's `clearDatabase()` deletes the row it is writing: `runRepo.updateRun`'s
  row-must-exist guard throws, the error escapes `executeFrom`, and the engine's own
  `void this.executeFrom(…).catch((error) => void this.fail(runId, error))` chain calls
  `fail`, whose failed-row write goes through the SAME guard **with nothing awaiting
  it** — an unhandled rejection. Every test passes and the run still exits 1
  (`Errors 1 error`, measured: 1 of 6 isolated runs of the file), which is how a real
  regression in the same run gets dismissed as "just the flake". The cure is the ORDER,
  not a wider guard: an `afterEach` that drains the queues the file started through the
  queues' own state (`tests/features/post-run-extras.test.ts`'s `settleStartedQueues`)
  plus a pin that no run row is left `running` — never an `ALLOWED_NOISE` entry, never a
  swallowed rejection, never a `catch` around the DB write, and never a weakened
  `runRepo` guard (that guard is what made the pending write loud). Generalize it: a
  test that starts real orchestration owns settling it before teardown, because teardown
  is exactly where the row the pipeline is writing disappears. The same chain is
  REACHABLE from the app — the Runs list lets the owner delete a RUNNING run, so
  `deleteRun` removes the row the pipeline is writing and `lib/globalErrors` would
  surface the unhandled rejection as the global "Unhandled error in a background task"
  toast (deduced from the same chain, NOT measured in the app, and reported rather than
  fixed here): that cure belongs in `src/llm/runEngine.ts`, not in the guard.

- **A `title` on a natively `disabled` control is invisible in Chrome and
  unreachable by keyboard — "disabled with its reason in `title`" was a promise
  the UI could not keep** (ledger 98). Long-standing, externally documented
  browser behaviour, not a guess: a disabled form control fires no pointer
  events (Chrome skips it in hit-testing, so the events go to its parent —
  equinor/design-system issue 2724, microsoft/fluentui issue 17606, and the
  standard "wrap the disabled button, put the tooltip on the wrapper" recipe in
  KendoReact's tooltip-on-a-disabled-button guide), so a native tooltip on it
  never appears (Firefox differs); and because a disabled control cannot take
  focus, the same `title` is unreachable by Tab and unannounced by a screen
  reader. This repo wrote the recipe down as its OWN device in five places
  across four sections (docs/05 §Module reader, §Module canvas Save, §Module
  canvas header, §Entity panel, §Workspace persona Start)
  while every shadcn Button additionally carries `disabled:pointer-events-none`
  — measured at HEAD: a disabled `Button` renders
  `<button disabled … class="… disabled:pointer-events-none …">`, i.e. the
  control is not even a hit-test target. **The incident:** the owner reported
  three canvas header controls (`canvas-preview-toggle`,
  `canvas-refine-selection`, `canvas-rewrite-part`) as "doing nothing". They
  were implemented, correct and heavily pinned — what was missing was any reason
  AT ALL: a brace-aware scan of that commit shows none of the three carried a
  `title`, an `aria-describedby` or a hint beside it. The canvas opens in
  Preview and both AI actions were gated on `aiBlocked || previewOpen`, so on
  first open they were dead in silence — a gate docs/17 row 102 later removed
  (both actions now work in the preview, so the view is not part of any gate).
  The cure is the device in
  §2.3 (one home, `components/blocked-control`), and the corrected record:
  never say "its reason is in `title`" again — a `title` may stay as a mirror
  for the browsers that render it (and where an existing pin asserts it), but
  the reason must be perceivable through the device. One measured exception
  worth knowing before the next sweep: a disabled Base UI **Checkbox** renders
  `<span role="checkbox" aria-disabled="true" tabindex="-1">` — no native
  `disabled` attribute — so its `title` DOES render in Chrome, and its
  `aria-label` can carry the same reason for AT; check the rendered element
  before assuming a disabled control's `title` is invisible.
- **A blocked control raises THREE questions, and the sweep that adds a reason
  must answer all three (docs/17 row 99).** (1) *Is the block intended?* A
  surface that holds every one of its controls on ONE flag ends up blocking
  controls that are not that run's subject — measured, each one reported and
  deliberately KEPT: the embedding panel's **Clear** while a library embed runs,
  every un-pressed **Fetch** row while one fetch runs, the export dialog's
  **Export** while a build runs, the mob-portrait BATCH while a single ENTRY
  runs, and the second upload in the images/battlemap section while the first is
  still being saved. The reason still has to name the run that actually holds
  it, which is why several of those sentences say "…is being created right now"
  rather than "you pressed this". (2) *Can the state occur at all?* Measured:
  `spine-checkpoint`'s `busy` gate is only reachable from a caller branch
  (`parts.length === 0 && !busy`) that can never pass `busy: true`, so its four
  reasons are correct and currently unreachable — write the reason for the state
  the gate encodes, and report the reachability rather than inventing a caller.
  (3) *What does the control's held state LOOK like in the DOM?* It is not
  always the native attribute: a shadcn/Base UI **Switch** renders
  `<span role="switch" aria-disabled="true" tabindex="-1">` and a **menu item**
  renders `<div role="menuitem" aria-disabled="true" data-disabled>`, so
  `toBeDisabled()` — which only reads the native attribute off form tags — is
  the WRONG assertion there, and a pin that uses it passes or fails for a reason
  unrelated to the gate. Pin the form each control's own gate uses
  (`tests/helpers/blocked-reason.ts` has one helper per form, plus the
  self-evident pins).
- **A remark plugin that rewrites a text run into a synthetic node has
  DISCARDED the source bytes, and the discarding is silent (docs/17 row 100).**
  `remarkWikiLinks` reads `match[0]` and then throws it away, replacing the run
  with a link node whose only child is the DISPLAY text — so `[[Encounter:Ash
  Gate|the gate]]` and `[[Ash Gate]]` become indistinguishable downstream, and
  the difference the author wrote (encounter parameters, inner spacing) is gone
  with no error anywhere. **The rule: if any consumer will ever need the
  original text, carry it at the moment it still exists, on the node's
  `data.hProperties`** — that is the one supported mdast→hast route for custom
  properties (`mdast-util-to-hast`'s `applyData` merges it into the element it
  produced, and `hast-util-to-jsx-runtime` hands it to the React component).
  VERIFIED at HEAD rather than assumed — react-markdown 10.1.0 /
  mdast-util-to-hast 13.2.1 — because a *documented* carrier that silently does
  not survive would leave the tooltip empty and every test passing on the
  fallback: a `link` node carrying `data.hProperties['data-wiki-raw']` renders
  `<a href="#wiki:…" data-wiki-raw="[[Name|display]]">` and the `a` component
  receives `href, data-wiki-raw, node, children`. Corollaries:
  (1) **never RECONSTRUCT** — `[[${name}|${display}]]` looks right and is wrong
  (measured: it fails the byte-exactness pins on `[[ Ash Gate |the gate]]`,
  which a name+display rebuild turns into `[[Ash Gate|the gate]]`), so pin the
  token in a fixture whose inner padding differs from the canonical form;
  (2) the carrier is render-time only — keep it out of every persisted string.
  **The two export paths disagreeing about `[[…]]` is FIXED (row 105, measured
  at `b06775d`).** This gotcha used to record that
  `lib/markdown.markdownToText` (the single-artifact PDF body path) was NOT
  wiki-aware, so it printed `[[…]]` verbatim while `lib/mdToPdfmake`
  (the module PDF) rendered the display text — the defect row 100's arc
  found and pinned instead of fixing. The cure is one seam, not a third
  implementation: `lib/markdown.markdownToDisplayText` (= `markdownToText` +
  `lib/wikilinks.stripWikiLinks`) is what the GM-notes and handout bodies
  render, `mdToPdfmake` keeps its own rich-run path UNCHANGED, and
  `markdownToText` stays the faithful-source stripper its other consumer (the
  image-prompt builder) needs (§2.3). Both pipelines now render the DISPLAY,
  and both are pinned together in `tests/lib/wiki-raw-export.test.ts`.

- **An additive instruction must leave the no-instruction prompt BYTE-IDENTICAL,
  and the honest place for it is the BRIEF the specialist builds, not a new run
  input (docs/17 row 101).** MEASURED at `e72bc82`: `runEngine`'s
  `extraInstruction` paragraph is already rendered at four sites (draft,
  statblock, review check, encounter brief) but is reachable ONLY from
  `retryStep`/`resumeRun` — `startRun` cannot carry one and the run row does not
  persist one, so a seam that added a run-input field would silently drop the
  instruction on every resume. Appending it to the brief the specialist already
  builds is the one way that keeps all three properties at once: the empty case
  returns the SAME string (so every existing full-literal prompt/brief pin still
  guards the default — e.g. `tests/features/persona-request.test.ts`), the
  non-empty case persists on `userBrief` and survives a resume, and the paragraph
  has exactly ONE implementation (`llm/additionalInstruction`), which the
  engine's own render sites call too. A second copy of that template string is
  the drift this closes, and an "additional instruction" that rewrites rather
  than appends would be a behaviour change wearing a seam's clothes.
- **A model's structural decision must be DATA the renderer executes, and a
  "deterministic" PDF has a hidden clock in its trailer (docs/17 row 109).**
  Two facts, measured at `docs/17` row 109's landing, that a future arc will
  otherwise rediscover the hard way:
  (1) **pdfkit derives the PDF trailer `/ID` from the document's `CreationDate`**
  — `PDFSecurity.generateFileID(info)` is `md5(CreationDate.getTime() + info)` —
  so two renders of the SAME definition are NOT byte-identical: measured, equal
  sizes (7834) with the first differing byte at offset 7740, in the trailer. Pin
  `info.creationDate` (the module PDF pins it to the compile DAY it prints on
  the cover: `buildModulePdf(..., { compiledAt })`) and the same definition is
  byte-identical (`diff -1`, 7891 == 7891, one `/ID`). A "same bytes" test that
  does not pin a date is either flaky or vacuous — and `TDocumentInformation`
  (@types/pdfmake) has NO date field, so the pin needs one documented
  structural assignment rather than a cast the linter accepts.
  (2) **The model authors the PLAN, the renderer authors the PAGES.** The plan is
  validated data on the module row (a closed role set, an audience, and a
  `source` naming a part/artifact/encounter that EXISTS) and the renderer decides
  every typographic property of it, which is what makes a re-export diffable, the
  AI's decisions inspectable/correctable, and the export deterministic (NO model
  call inside the renderer). The failure mode this forbids is the tempting one:
  letting the model emit the document (or a styling hint the renderer must
  interpret), which makes the same module print differently on two runs and
  leaves a bad decision with no surface to correct it.

- **A centralized seam that DUPLICATES a specialist is worse than none.**
  `features/modules/change-artifact.changeArtifact` composes no brief, resolves
  no persona, starts no run and waits for no outcome — it resolves the row, picks
  the route from the row's own kind, and calls the specialist (extending the
  specialist's request object where a change needs a field creation does not,
  e.g. `EntityBatchTarget.artifactId`). The alternative it refuses is concrete:
  rebuilding the entity brief inside the seam would have been a second
  `buildEntityBrief`, and waiting on a run inside the seam would have been a
  second place that knows how a persona run reaches a terminal status. If a seam
  needs knowledge the specialist has, extend the specialist's input — never
  re-implement its steps.
- **A multi-call chat turn is a transcript of CALLS, not of messages — and a
  capability the model was never told about cannot be claimed as "no prompt
  change"** (the canvas chat's requested-details round trip, docs/17 row 103).
  Two traps, both hit while wiring it. (1) **Role alternation**: a turn that
  answers with two calls (the model asks for stored details → the app answers
  → the model replies again) is stored as TWO assistant bubbles, and replaying
  that history into the next turn puts two `assistant` messages back to back —
  several providers reject adjacency outright. The TRANSCRIPT therefore
  carries an app turn between them (`DETAILS_ANSWER_TURN`, the same fixed
  sentence the live round trip sends), and the follow-up call is built by its
  OWN builder (`buildCanvasChatDetailsPayload` = the ordinary payload + the
  model's asking reply + the app's answer), so the two-call shape is never
  re-derived by the history loop. (2) **"Unused ⇒ byte-identical" is a claim
  about the TURN, not about the system prompt**: the model cannot emit
  `<request>` unless the system prompt describes it, so
  `canvasChatSystemPrompt()` DID gain a paragraph — while staying ONE constant,
  identical for a turn that uses the capability and one that does not. What is
  pinned byte-for-byte instead is everything the turn decides:
  `canvasChatTurnContent` (no `<requested-details>` when nothing is requested),
  exactly ONE `chat` call, no extra DB reads, the same apply path, and
  `chatProseSoFar` returning the raw reply byte-identically when the reply
  carries no command opener. Stating the strong claim loosely would have made
  it false; stating it precisely is what the pins can hold.
- **A rendered string is not its source, and SLICING markdown before rendering
  silently loses text (measured, docs/17 row 102).** The canvas preview washed
  the last replacement by parsing `value` in three slices (before / washed /
  after). MEASURED in jsdom: `one two three` with the wash over `[4,7)` rendered
  **`onetwothree`** — the spaces are gone, not merely unstyled — because
  CommonMark strips the INITIAL and FINAL whitespace of a paragraph's content
  and each slice was parsed as its own document; the same slice rendering also
  re-chunks any `[[wiki-link]]` or emphasis run that straddles a boundary. The
  cure is general: never re-parse a substring of markdown to decorate it —
  parse the WHOLE string once and mark the nodes/runs the range covers (here the
  wash rides the same source-range span the DOM→source map already builds, which
  also keeps a washed run mappable). Any future feature that wants to style part
  of rendered markdown has the same trap and the same answer; a jsdom pin on
  `textContent` is what catches it, because the loss is invisible to a test that
  only asks whether the wash exists.
- **The one-generation-per-module slot is a `Set`, and `claimModuleGeneration`
  is not re-entrant — so a phase that runs a generation INSIDE an
  already-claiming turn must HAND THE SLOT OVER** (the canvas chat's change
  half, docs/17 row 104). The chat turn claims the module's slot on entry (the
  chat/refine serialization rule) and a `<change>` runs a REAL generation
  through `changeArtifact`, which claims the SAME slot for itself. A nested
  claim neither queues nor waits: `llm/canvasBusy`'s registry is a `Set`, so the
  inner claim throws `ModuleBusyError` on the spot and the generation would
  never run — while looking, from the outside, exactly like "the module is
  busy". The turn therefore RELEASES the slot for the change phase and
  re-claims it in a `finally` for the follow-up call; if a real generation takes
  it in that window the turn does NOT retry or wait — the outcomes stand and the
  follow-up is skipped with a LOUD named reason (the changes were made; the
  model was not told), because waiting would hold the owner's turn behind
  somebody else's run. Generalised: before a multi-phase turn claims a
  generation slot, ask which of its phases itself generates, and hand the slot
  over around it.
- **A second capability rides the turn's ONE extra call — a call of its own is a
  whole extra turn's cost** (same arc, docs/17 rows 103/104).
  `sendCanvasChatMessage` is ONE call per user message plus at most ONE
  follow-up; the change half added no call, it added a block.
  `canvasChatFollowUpTurnContent` composes the `<requested-details>` and
  `<change-results>` blocks into that same follow-up (each block present only
  when its phase ran; the details-only form stays byte-identical), and a
  capability asked for in the FOLLOW-UP reply is a named no-op
  (`ignoredRequests` / `ignoredChanges`) rather than a third call. Any future
  capability wired into this turn adds an arm to that builder and an `ignored…`
  list — never a call of its own, and never a second `chat` call site.

- **A document DERIVED from a row cannot drift, and deleting a stored concept is
  the one change that must SHOUT** (docs/17 row 108). The deliverables concept was
  deleted end to end instead of migrated, so the two boundaries where old data can
  still arrive each report what they could not use: an **export file** is counted
  BEFORE tolerant parsing (`RETIRED_EXPORT_TABLES` + `retiredTableRows` on the RAW
  object — the tolerant shell strips unknown keys, so a post-parse census would
  always read zero) and the count is toasted on import; a **database** is upgraded
  by Dexie v21, whose `.stores({ deliverables: null })` drops the table and whose
  upgrade body writes the removed row count into `settings.deliverablesRemoved`,
  which `AppShell` toasts once and resets (an upgrade body runs before React
  exists, so it cannot toast itself — the `retiredSessionNotesRemoved` precedent).
  Two traps for the next removal: (1) `db.tables` no longer lists the table, so a
  test that proves the drop must assert on `db.tables.map(t => t.name)` AND on the
  reported count, never on a query that would throw either way; (2) the drop must
  NOT be expressed as an empty `.stores({})` — Dexie needs the explicit `null` to
  delete a store, and a missing key silently leaves the old table in place.
- **A derived PDF's honesty is a PROBLEMS LIST, not a try/catch — and the image
  format boundary is the sharpest edge in the whole pipeline.** `buildModulePdf`
  returns `{ blob, problems }`; the blob is always produced (a wrong-but-complete
  document beats no document for the owner's own use) and every defect is namespaced
  by `where` and deduped by (`where`, `reason`) so one broken image is reported
  once, not once per site. The format rule is pdfmake's, not ours: only
  `jpeg`/`jpg`/`png` data URLs embed, and an unsupported one (measured: a WebP data
  URL) **throws during pdfmake's synchronous measurement pass** — i.e. outside the
  `try` that surrounds document generation, as an uncatchable-looking crash rather
  than a named failure. `lib/pdfImages.assertPdfmakeImageDataUrl` therefore refuses
  it at the seam that owns the decision, and `loadPdfImages` never throws at all:
  it records `{ id, where, reason }` per failure so the renderer can print a NAMED
  placeholder. What CANNOT be proved here: jsdom has neither `createImageBitmap` nor
  a canvas, so the browser codec's real decode/encode of JPEG/WebP bytes is
  **UNPROVEN by any test** (the suite pins the seam with a genuine 1×1 PNG rendered
  through the real pdfmake path — asserted as `/Subtype /Image` in the produced
  bytes — plus an injected `PdfImageCodec` for the budget and failure branches).
  Stated, not implied: a future arc that needs that proof must run the codec in a
  browser, not in jsdom.

- **A persisted status is a LEASE, not a fact** (ledger 110). `'generating'`
  on a module row is a claim that SOMEBODY is writing, and a page that dies —
  reloaded, discarded by the browser, closed — leaves the claim behind with no
  owner. Measured at `360a056`: nothing reconciled it, so the module spun
  forever, the Stop button was a silent no-op (`cancelModuleGen` on a
  controller-less module is `controllers.get(id)?.abort()`), every retry
  affordance was gated behind `!busy`, and Stop all counted the dead row as
  stopped and toasted that it had stopped it. Three rules follow, and they are
  the whole seam: (1) the ownership question is answered by ONE guard
  (`isModuleGenClaimed` — this page's controller registry OR a held generation
  lock) and the answer is re-checked INSIDE the write transaction, because a
  pass can register between the read and the write; (2) a reconcile is LOUD and
  never a silent reset — `'failed'` with a named sentence, unfinished part
  slots rewound to `'pending'` so the EXISTING `generateMissingParts` path
  recovers exactly the lost work, and the `!busy` gate opens; (3) a control
  that cannot act says so. The same rule is why RUN rows are NOT reconciled on
  `visibilitychange`: a hidden tab keeps running its engine, and failing those
  rows would invent the very defect being removed. The honest limit is the
  cross-tab half: with no Web Locks API (jsdom, older browsers)
  `isGenerationLockHeld` answers `false`, so a second tab cannot see another
  tab's forge and start-time reconciliation can fail a row that is genuinely
  being written there. It is self-healing — that pass rewrites the status on
  its next part boundary and completes — but a transient spurious failure is
  possible, and that is a stated limitation, not a hidden one.
- **A watchdog measures LIVENESS, and a post-loop diagnosis may only report a
  limit that was ARMED** (ledger 110). Two independent defects, measured at
  `360a056`: the 1 Hz watchdog in `llm/openrouter.readStream` compared
  `Date.now()` deltas, so a page that was hidden, frozen or discarded mid-stream
  came back with a gap that read as silence and `reader.cancel()` killed a
  healthy stream; and the diagnosis after the read loop re-derived the failure
  from the same wall clocks, so a stream that simply CLOSED (a provider that
  ends the body instead of sending `[DONE]`) had its complete answer thrown
  away — `if (done) break` falls straight through into the diagnosis. The fix
  is `lib/pageLiveness.activeElapsedMs` (wall time minus the gaps the page
  reported via `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`) plus
  a `trippedLimit` recorded at the moment the watchdog cancels. The seductive
  wrong fix is a looser limit, so both directions are pinned: a gap twenty times
  the content-stall limit does not kill a healthy stream, a clean close after a
  ten-minute suspension returns the complete text, and a stream that really died
  still fails — after the resume, on the same numbers. UNPROVEN by
  construction: no test in this repo can freeze a page or throttle its timers,
  so the gap crediting is pinned by driving the events the browser fires, never
  by observing a freeze; the freeze MITIGATION (the Web Lock held for a pass)
  rests on Chromium's published opt-out criteria and is documented as a
  mechanism, not as a measured outcome.
- **A backgrounded tab has exactly two surfaces, and both must be honest**
  (ledger 110). The tab strip (`document.title` through
  `lib/backgroundTitle`, written ONLY while `document.hidden`) and the
  generation lease. The title may say `Working: …` while work is running and
  `✓`/`⚠` only from a VERDICT a row actually reached — a user stop reaches no
  verdict and CLEARS the entry, because a title that invents "finished" is worse
  than no title at all; and the app's own title comes back the moment the page
  is visible, so nothing the owner reads on screen changes. The same rule
  applies to the lease: `withGenerationLock` is advisory (with no Web Locks API,
  or with the lock held elsewhere, the pass runs anyway), so its absence costs
  the mitigation and nothing else. Neither surface may become a progress meter:
  the label is the caller's ("The Drowned Vault"), never a guessed
  "part 2 of 5".
- **A citation and an authored stat block are mutually exclusive BY
  CONSTRUCTION — no seam may build the pair** (ledger 112). `npcDataSchema`
  refuses an npc that carries both a `creatureRef` and a `statBlock`, and the
  refusal is the ONLY reason a cited row's numbers can never quietly become a
  second, divergent source of truth: the cast tier births such a row with
  `statBlock: null` in the SAME literal (`db/creatureRepo`, the sole creator),
  readers prefer the authored block and otherwise DERIVE from the citation
  (`roomBudget.fixedCastStatsFor`), and the one place that could assemble the
  pair is the refill merge (`runEngine.mergeRefillData`) — which now THROWS a
  named sentence instead of writing, and whose statblock-step force-off keeps
  that refusal unreachable from the pipeline it just ran. Hunted and verified
  at every other `creatureRef`+stat-block site: `canvasChat`'s two renderers
  are read-only (one narrows to `statBlock === null`), the entity/roster
  batches cannot reach a cited row (`entity-batch` starts a run only when
  `target.artifactId === undefined`; `change-artifact` refuses cast rows), and
  the cast writer writes both fields in one literal. The rule for a future
  writer: never add a second creator/merger of these two fields, and never
  "resolve" the pair by preferring one side — a silent preference is how a
  derived number starts disagreeing with the library it cites.
- **A zod issue dump is not a user-facing message, and a UNION makes it
  worse** (ledger 112, measured). `ZodError.message` IS the raw
  `[{code,path,message}…]` JSON, and `lib/toast` humanizes only a toast's
  DESCRIPTION — the headline is passed through untouched — so any fail site
  that hands `errorMessage(error)` to `toastError` for a zod failure puts
  megabytes-shaped JSON in front of the owner (his own words: *"tons of
  text … looked like lots of json"*) while the run row keeps the same dump and
  a kind label ("Unusable model reply") that blames the model. Use
  `runEngine.composedFailureMessage` for a surface: it composes a sentence for
  a zod failure and passes every other error's message through VERBATIM (so
  named refusals keep their wording). It also digs through union branches, and
  that part is a MEASURED trap: `anyArtifactSchema` IS a union (campaign-scoped
  row vs library row), and zod 4 renders a failed union as ONE issue whose own
  `path` is `[]` and whose `message` is the literal "Invalid input" — the
  field names live only in the nested `errors` branches, so the obvious
  `formatZodIssues`/`parseErrorSummary` route yields "reply: Invalid input",
  a sentence that names nothing (measured on this branch before
  `readableZodIssues` existed; `formatZodIssues` still does this where a repair
  PROMPT consumes it, which is acceptable there — a prompt is not a surface).
  One residual, stated rather than smoothed over: a NAMED refusal the engine
  throws is a plain `Error`, so `failureKindOf` classifies it `'unknown'`
  ("Unclassified failure") where the schema failure it replaces was
  `'invalid-output'` ("Unusable model reply"). That is the honest kind of the
  three available (`invalid-output` blamed the model for a refusal the app
  made; `bug` would tell the owner to report a deliberate refusal), the kind
  only ANNOTATES — the message is the surface — and `llm/failureKind.ts` is a
  different seam than this one, so it is left alone.
- **A stop is an INTENT that outlives the call recording it, and the run
  pipeline asks about it at every write boundary.** `RunEngine.cancelRequested`
  is not a momentary flag that `cancel()` toggles: the step holding an `await`
  when the owner stops a run has not observed the abort yet, so clearing the
  intent inside `cancel()` made that live pipeline uncancellable — its next write
  restored `'running'` OVER the `'cancelled'` row (a stopped run that then
  "completed"), and a write meeting a row the owner had since deleted threw
  `NotFoundError` out of `runRepo.updateRun` (`src/db/runRepo.ts:50`), which the
  pipeline's catch wrapped as `Encounter step "brief" failed: PersonaRun not
  found: …` and `fail` toasted — a failure report for a stop the owner asked for
  (MEASURED: that is exactly the message the spurious-toast pin in
  `tests/features/encounter-map-queue.test.ts` produces before this fix, on
  demand, by delaying the reply the step is waiting on; `docs/05-UI.md`: "a
  cancelled run is never reported as a failure"). Three rules hold this seam
  together: the intent is CONSUMED where the pipeline actually ends
  (`executeFrom`'s `finally`, and its early return for a run already
  cancelled/failed/gone) and DROPPED by each deliberate restart of the same row
  (`startRun`/`retryStep`/`resumeRun`/`regenerateEncounter*` — the newest owner
  action wins); a step result that lands AFTER the stop is discarded before any
  write, so the stop's verdict on the row stands; and the cancel path's own
  writes go through `recordCancelled`, which tolerates a row that no longer
  exists — cancel-path ONLY, so a step that dies with no stop in play still
  wraps, still toasts and still writes its failed row. Do not "simplify" any of
  the three by keying on an error's KIND (`AbortError`, `NotFoundError`): a
  genuine failure arriving in the same clothes would be swallowed (ledger 115).
- **Deleting a run is an owner INTENT too, and every path that deletes run ROWS
  stops the run FIRST through the same cancel the Stop button records.** The Runs
  tab's delete is offered for every row whatever its status
  (`features/campaign/components/persona-panel.tsx:1903`), so the owner can delete
  a run whose step is still parked on a model reply. Without a stop, that step's
  next write meets a row that is gone: `runRepo.updateRun` throws `NotFoundError`
  (`src/db/runRepo.ts:50`), the pipeline's catch wraps it as
  `Encounter step "brief" failed: PersonaRun not found: …` and `fail` toasts the
  owner's own delete back at him plus a `'failed'` row it cannot write — ledger
  97's real-app analogue, row 115's UNPROVEN item (5), paid by ledger 116. The
  ONE way to do it is `RunEngine.stopRunsBeforeDelete(ids)`
  (`src/llm/runEngine.ts:2053`), wired at `persona-panel.tsx:1785` and — for the
  campaign-level wipes that delete a campaign's runs wholesale — through
  `stopGeneratingRunsForCampaign(campaignId)` (`:426`) at
  `db/campaignRepo.ts:93-94` + `:265-266` and `db/maintenance.ts:105-106`.
  Three rules hold it: (a) the stop is the EXISTING cancel intent (row 115), not a
  second "this run was deliberately stopped" mechanism — a late step result is
  already discarded before any write, and `recordCancelled` already tolerates a
  row that is gone; (b) it must be awaited BEFORE the caller opens a Dexie
  transaction (`cancel()` writes the row through its own, which would join and
  early-commit an open scope — the `cancelModuleGen` precedent in the same
  functions, and why the `db` → `llm/runEngine` import is dynamic); (c) a row that
  is NOT generating is left alone, so deleting a finished run writes nothing and
  moves no verdict — while `fail` STAYS loud for a step that dies with no stop and
  no delete in play (pinned both ways: `tests/features/run-delete-running.test.tsx`
  asserts `cancel` is never called for a failed row, and its contrast pin asserts a
  self-inflicted death still toasts and still writes its failed row). The measured
  residue this seam left — a run the unattended encounter-map queue is watching
  still reported the owner's own stop as a failure — is CURED by ledger 117: the
  queue now reads the engine's ONE withdrawal predicate and settles silently (see
  the next gotcha). Do not revive the private status comparison there.
- **A queue job whose RUN was withdrawn by an owner action settles SILENTLY, and
  the withdrawal is one named fact the ENGINE owns** (docs/17 row 117; AGENTS
  rule 4 — this idea had a fourth surface waiting). `isRunWithdrawn(run)`
  (`src/llm/runEngine.ts:372`) is THE spelling: true when the row is
  `'cancelled'` (the owner's Stop, Stop all, every cancel seam) or when the row
  is GONE (every run-row delete stops the run first, ledger 116, so a vanished
  row is that same gesture one step later); FALSE for a run that died on its own
  (`'failed'` with its `errorMessage`) — including `failRunningRuns`' reload
  reconcile, whose `failureKind: 'cancelled'` names the KIND of failure, not a
  withdrawal. Read it wherever a caller must decide between silence and a
  failure verdict, never an error's kind or its message; three callers are
  already folded onto it (`features/modules/encounter-map-queue.ts:149` and the
  re-read at `:140`, `features/modules/entity-batch.ts:501`,
  `llm/chainRunner.ts:201` + `:318`). The verdict crosses the job-queue seam
  through `ctx.withdraw()` (`src/lib/jobQueue.ts:63`) — NOT a new outcome and not
  a swallowed error: it rides the SAME withdrawal path as `dequeue`
  (`withdrawJob`, `:203`: abort the job's signal, decrement its dock counter
  instead of ticking it done, no toast, no retry entry), idempotent per key and
  cleared when that key is enqueued again. `processJob` also guarantees that an
  ABORTED job can never settle as `'done'`/`'skipped'`/`'failed'`, whatever the
  body returns. MEASURED before/after, all three shapes (the map job parked on a
  run the test stops by hand, no `dequeue` in play): at the base SHA the queue
  toasted `Could not generate a map for "…"` carrying `run ended cancelled`
  (plain `cancel()`), `Run <id> disappeared while waiting for it to finish`
  (delete, and cancel-then-delete) and filed the job on the retryable `failed`
  list; now all three settle silently with the dock drained. The two rules that
  keep this from becoming a blanket catch: only a run that was WITHDRAWN goes
  quiet (a `'failed'` run still throws, still toasts the queue's own title and
  still lands retryable — injecting `true` for the predicate REDs three pins,
  two of them pre-existing), and a job that cannot even START still reports
  (`campaign no longer exists`, `encounter no longer exists`, the missing
  Cartographer persona). Two lines of the seam are consistency rather than
  coverage, named in §5.

## 5. Known debt (live divergences at HEAD — do not "discover" them)
- **Every upward import that exists at HEAD** (§1 says dependencies point
  downward; these are the exceptions, all deliberate — do not "discover" them
  and do not add a further one): `db/seed.ts` + `db/personaRepo.ts` →
  `llm/personas/builtins` (the built-in persona definitions);
  `db/campaignRepo.ts`, `db/moduleRepo.ts` and `db/maintenance.ts` → dynamic
  `import('@/llm/moduleGen')` (a static import would be a cycle);
  `db/campaignRepo.ts` + `db/maintenance.ts` → dynamic
  `import('@/llm/runEngine')` for the pre-transaction run stop that a run-row
  delete owes (docs/17 row 116) — the same cycle reason: `llm/runEngine` already
  imports `db/campaignRepo`;
  `llm/moduleGen` → `features/modules/post-generation.runModulePostGeneration`
  (the sweep has ONE implementation, and a copy inside `llm` would drift from
  the code the UI reads — docs/17 row 80; the retired
  `features/campaign/creature-row-guard` refusal copy went with the mob artifact
  it protected, docs/17 row 106);
  `llm/moduleGen` + `llm/runEngine` → `@/app/routes`, plus all 28
  `features/**` sites → `@/app/routes` (route builders are treated as
  constants, not as app state); `domain/wikiGraph.ts` +
  `domain/encounterMap/layout.ts` → `@/lib` (`wikilinks`, `errors` — pure
  helpers with no upward dependency of their own).

- **The Advanced floor editor's minimum disagrees with its own schema.** The
  "Per level" input falls back to `0` when it is cleared
  (`guardrailCountInput(0, …)`, `min={0}`), but
  `encounterFloorGuardrailSchema` refuses `perLevel: 0` while the floor is
  enabled — so a GM can hold a draft whose save the settings boundary rejects.
  The failure is LOUD (`persist` toasts and the draft simply is not saved until
  a count is put back), which is why it is debt and not a fallback: nothing is
  faked and nothing is lost. Clamping the fallback to the schema's `1` was tried
  and REVERTED — the field is controlled, so clearing it then typing "2" turned
  into `12` (it broke a pinned floor assertion), i.e. the real fix is a
  text-vs-number editing change in the floor editor, which the draft brief puts
  out of scope. Left as-is on purpose: do not "fix" the minimum without fixing
  the editing flow in the same change.

- ~~Map-regenerate attach bypasses the image seam~~ — closed: `runEngine.runEncounterFinalize`'s regenerate branch rides `attachImagesToArtifact` (new optional `data` + `meta` patch fields) — re-anchor + content write commit in the one attach tx, and the cover is explicitly kept (never cleared). Extended by docs/11 D16 (single-map-slot): the same tx swaps the previous map out of `imageIds` (`removeImageIds`), refchecks its blob (`pruneCandidates`), converges never-live boards, and declares `db.battles` in its scope for the board-aware refcount. The fresh-encounter `createArtifact` birth path stays intentionally off-seam (single-row create, no desync window — see below).
- **Queue reload survival is deferred BY OWNER DECISION** (`lib/jobQueue`
  header): the in-memory queues lose queued/failed jobs on reload; run rows
  reconcile via `runRepo.failRunningRuns`. Do not invent persistence.
- **The shared job-queue contract gained ONE member and ONE guarantee** (docs/17
  row 117), both documented at their seam and both additive for the three queues
  that do not use them: `JobContext.withdraw()` (`src/lib/jobQueue.ts:63`) is the
  body's own withdrawal — the SAME settlement as `dequeue`'s, for an owner action
  the queue cannot see by itself — and `processJob` now settles an ABORTED job as
  `'cancelled'` even when the body returns normally (`:222`). Consequences a
  reader must know: `dequeue`/`cancelAll` and a body's withdrawal share one
  idempotent path (`withdrawJob`, `:203`), so a single dequeue can no longer
  double-decrement the dock counter, and a withdrawal is spent per JOB — the key
  is cleared on enqueue (`:315`) because the regen sweeps
  (`features/campaign/mob-portrait-queue.ts:452`,
  `features/covers/cover-image-queue.ts:223`) deliberately dequeue a key and
  re-enqueue it. TWO lines of that seam are consistency, not coverage, and no pin
  reaches either: the idempotence guard itself (removing it leaves every suite
  green — it protects the concurrent `cancelAll`-during-a-body's-own-unwinding
  race) and the aborted-never-settles-as-work return (the encounter-map body
  always throws after `withdraw()`; it protects a body that resolves after a
  dequeue). Both were injected and came back GREEN (docs/08 §A run the owner
  withdrew).
- **`features/campaign/encounterRegen.ts:93` still reports a cancelled run as a
  failure** (`awaitCompletedRun` throws `` `${label} ended ${run.status}` `` for
  anything but `completed`). That is the MANUAL regen button's own contract —
  its caller owns what the surface says when the owner stops the run it asked
  for — and it is deliberately NOT folded onto `isRunWithdrawn` (docs/17 row
  117): a queue job's withdrawal is moot work, while a manual regen that
  evaporates has a caller to answer to. Listed so nobody "discovers" it as a
  leftover of row 117; changing it is a surface decision, not a refactor.
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
