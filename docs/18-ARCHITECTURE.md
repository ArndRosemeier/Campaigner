# 18 — Architecture: the code map and the seam index

This is the layer between `AGENTS.md` (binding rules) and the feature specs
(docs/04/05/07/08/11/12/13/14/15/16/17/19): the high-level map of how the code is
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
- **CURRENT STATE is `docs/20-ORCHESTRATION.md`** (in-flight writers, unlanded
  branches, the owner's decision queue, the failure-mode guards) — every landing
  updates it in the same docs commit as this doc, and it never restates a seam
  or a decision.

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
  images, quickfind, onboarding, guide, dice, progress, covers,
  **idea-board**). DB-derived UI state =
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
  `stopEpoch`, `errors`, `debug`, `globalErrors`, `clipboard`, `editorTheme`.
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
| **Compare two NAMES — the comparable form — and add a name to an artifact's alias pool** (the pool `[[wiki links]]` resolve against: ledger 121; the comparable form is ledger 162) | `domain/artifactAlias.comparableName(name)` is THE comparable form of any user-visible name — `normalize('NFC')` (Unicode CANONICAL EQUIVALENCE, not diacritic folding: a Mac-authored NFD `Müller` and a precomposed one are ONE name), `trim()`, `toLowerCase()` — and both tier comparisons are built on it: `sameAliasName` (artifacts/aliases, and the wiki RESOLVER, which was folded onto it by ledger 162 — its thirteen hand-rolled `toLowerCase` comparisons are seam calls now, counted by `tests/features/alias-merge-seam.test.ts`) and `creatureName.sameCreatureName` (the creature tier, the same strictness). **Ledger 166 folded the last hand-rolled NAME comparisons in `src/` onto it** — TWENTY-TWO sites across eleven files, the bestiary cast's among them (`features/modules/entity-batch.libraryCitationForEntity` filtered the library pool with `creature.name.trim().toLowerCase() === wanted.toLowerCase()`, so a DECOMPOSED slot name missed a precomposed library name and the cast refused a creature the library holds), and the scan's `FOLDED` map names every one of them BY COUNT, so reverting any single one reds it: `db/creatureRepo.ts`, `domain/entityNormalization.ts` (`comparableName(` ×23 — folded WHOLE, because this module's every key is a name and a partial fold here neutralizes itself: a comparable-form equality answered through a still-lowercased map key simply misses the entry), `domain/module.ts` (the `sameSlot` CREATURE half + the three `entityKinds` lookups; its BOOK half is left alone), `domain/wikiGraph.ts`, `features/modules/entity-batch.ts` (`sameCreatureName(` ×1 — the creature tier), `features/modules/entity-panel.tsx`, `features/modules/stub-popover.tsx`, `llm/canvasChat.ts`, `llm/moduleGen.ts` (`applyNormalizationVerdict`'s two spelling maps and its `canonicalKey === nameKey` early-continue went with its comparison), `llm/roomBudget.ts`, `llm/runEngine.ts` (its resolution memo key is a name too). A NAME-ANCHORED `HAND_ROLLED_NAME_COMPARISON` shape now runs over all of `src/` in `tests/features/alias-merge-seam.test.ts`, with exactly TWO declared sites (the `alias-editor.tsx` form rejection below, and `db/mobPortraitCache.isCanonicalCitation` — a SURVIVOR, not a boundary: it is the portrait path ledger 165 owns and was in flight in another worktree). `mergeAliasNames(existing, names, artifactName)` — the ONE alias comparison (`sameAliasName`) and the ONE merge rule: a name equal to the artifact's OWN name is NOT an alias (`resolveWikiLink` matches the name first, so it could never resolve), a duplicate is never stored (against the pool OR against an earlier name of the same batch), the accepted spelling is stored VERBATIM (the comparison trims, the row does not), and a merge that adds nothing returns the caller's list UNCHANGED — the same reference — so `merged === existing` is the "nothing to write" test. Persisting it is `artifactRepo.addArtifactAliases(id, names, meta)`: the row is read INSIDE its own `rw` tx over artifacts+revisions (the `stampModuleOwnership` shape, so a caller's stale snapshot cannot clobber a concurrent alias) and written as ONE revision, or `null` with NOTHING written when the pool already answers (a missing row throws). Callers whose alias rides a COMBINED content patch — the run engine's three in-place writes (`:5756`, `:5784`, `:6000` at base `276f41f`) and `entity-batch.alignEntityName`'s rename — call `mergeAliasNames` and put the result in their OWN patch: the write path is for an alias-only save, and a second write there would split one revision in two | a hand-rolled `aliases.some((a) => a.trim().toLowerCase() === …)`, a `…trim().toLowerCase() === …` on a NAME anywhere — **since ledger 166 that shape is not a rule but a SOURCE SCAN: any `creature.name.trim().toLowerCase() === wanted.toLowerCase()` or relative in any `src/` file reds `tests/features/alias-merge-seam.test.ts` with its path named, and each FOLDED file asserts the shape is absent from its code (comments skipped)** — or `[...artifact.aliases, name]` beside the seam (six copies had drifted into THREE comparison rules, one untrimmed — the reader duplicated an alias the batch skipped); a SECOND normalisation helper beside `comparableName` (ledger 162: the pre-162 spellings ARE the class this row forbids — one comparable form, not two); a LOCALE-AWARE case fold used for MATCHING (`toLocaleLowerCase` — in a Turkish locale `I` folds to `ı`, so a name would resolve on one machine and not on another; `toLowerCase` is correct here and is deliberately NOT to be fixed); writing a pool from a snapshot read outside the transaction; `[...artifact.aliases, …]` beside the seam. **Deliberate boundaries, not oversights:** `lib/wikilinks.ts` RESOLVES a link against the pool (a different question — folding the MERGE rule in would tie resolution precedence to it; it IS a caller of `comparableName`/`sameAliasName` since ledger 162, which deleted the boundary entry that had licensed its hand-rolled comparisons), and `features/campaign/components/alias-editor.tsx` REJECTS a keystroke a person just typed (form feedback, no row write). **CLASSIFIED, NOT MERGED — the KEY-INDEX spelling of the same idea** (ledger 166 named it; **ledger 167 classified it into EIGHT DECLARED KEY SPACES**, each named with its consumer in `domain/artifactAlias`'s header and held by counted needles + one consumer-level composed-vs-decomposed pin per identity space in `tests/domain/name-key-spaces.test.ts`): `PACK_POOL_NAME_KEY` (`encounterRoster.rosterNameIndex`/`encounterItems.itemPoolNameIndex` mint; `runEngine`'s three `rosterChunkByName` lookups and `roomBudget.resolveBriefMonsterLevels` read — the model's `sourceName` must ask in the index's OWN key space), `MODULE_NAME_KEY` (the module's own names vs each other: fixed-cast keys, room reconciliation, the bestiary-slot source map, the run engine's roster digest), `WRITTEN_LINK_NAME_KEY` (one WRITTEN `[[token]]` across a prose set: resolution memo, token count, phantom node id, rewrite matcher, chip census, adopt set), `LIBRARY_CREATURE_NAME_KEY` (one library creature prints/suggests once), `IMPORT_IDENTITY_KEY` (the L1 verdict's title+creature halves share one tolerance — though `sameSlot` keeps its book half hand-rolled), `PRINTED_NAME_DEDUPE_KEY` (one displayed name, once), `PROMPT_STYLE_NAME_KEY` (clash map AND free-copy set are one space — keying one half by `.toLowerCase()` alone misses the other half's entries, the partial-fold trap ledger 167 fixed in `freeCopyName`), and `CREATURE_CONTENT_IDENTITY_KEY` — `domain/creature.contentCreatureKey`, **FOLDED since ledger 168**: its bytes are a Dexie index value (`mobPortraits: 'id, &creatureKey'`, `creatureImages: '[campaignId+creatureKey]'`) and every battle key carries it stamped, so the owner-ratified fold ships WITH a data migration — `domain/creature.foldCreatureKey(key)` is the ONE migration/import seam (the v22 Dexie upgrade and `lib/exportImport` both call it), a creature stored under BOTH compositions merges by the newer `updatedAt` (a tie goes to the row already under the composed key, where the read path used arbitrary UUID order), and the per-population counts plus every dropped key/imageId land in `settings.creatureKeyFold` for `AppShell`'s one-shot toast. THE ANTI-SPACES are declared too, because the primitive is WRONG there: `ALIAS_FORM_KEY` (`campaignGrounding`'s grounding spelling pick — its values become detection REGEXES, so folding composition DROPS a real spelling; ledger 167 REVERTED that fold, watched red as `expected [] to deeply equal [ 'Wächter' ]`), the SEARCH NEEDLES (substring contains, fuzzy by contract), the EMPTINESS PROBES, an ORDERING comparator, a zod enum case coercion, a keyword registry, an ingest trait literal, the alias-editor FORM, and tag-editor's tag dedupe (a tag is not a name). The boundary scan in the new file polices the trimmed KEY shape (`const key = name.trim().toLowerCase()`) over all of `src/` with 15 declared files (`domain/creature.ts` left the list when ledger 168 folded its persisted key); the name-comparison scan above remains deliberately blind to keys (a comparison of two already-built keys carries no `toLowerCase` on its line), which is why the folded files are held by BOTH scans' counted needles. The seventh copy the audit missed (`campaign-tree.tsx`'s rename-keep-alias path) was folded by ledger 123 onto this same seam — its two untrimmed comparisons are `sameAliasName` + `mergeAliasNames(kept, [target.name], name)` now, with the NEW name passed as `artifactName` |
| Change an artifact's scope (move / adopt / publish / BULK release) | `moveToModule` / `adoptIntoCampaign` / `publishToLibrary` and the bulk form `releaseModuleOwnership(rows, tx)` (`deleteModule`'s 'keep' branch) — all funnel through the private `moveScope`, one tx incl. image re-anchor; the bulk form runs `moveScope` per row INSIDE the caller's rw tx (`ScopeTx`) so every released row gets the same revision snapshot + `updatedAt` a single move writes | a patch carrying `campaignId`/`moduleId` — `updateArtifact` pins scope fields; a `table.modify({moduleId: null})` bulk write that skips the revision contract |
| Promote an artifact on second-module use (link / roster / battle) | `db/artifactAutoPromote` — `promoteSecondModuleUses` (post-save text scans), `promoteRosterUses` (roster/seed/spawn hooks), `promoteArtifactForModuleUse[Loud]` (single-artifact) — every path funnels through `adoptIntoCampaign` → `moveScope` (no separate core state); the surface is a batched `toastSuccess` notice, never run-issue escalation | hooking render (`wiki-markdown` resolution stays pure); a second scope writer; silent promotion |
| Give a generated artifact module ownership | `artifactRepo.stampModuleOwnership` (loud existence check inside the tx) | `updateArtifact` with `moduleId` |
| Attach images (store + reference + re-anchor + prune + optional content patch) | `artifactRepo.attachImagesToArtifact` — one rw tx over images+artifacts+revisions+battles+modules+campaigns (battles rides the scope because the post-attach prune refchecks frozen boards, modules+campaigns because it refchecks cover slots — a read on an undeclared table throws); blobs are byte-prepared (`buildStoredImage`) BEFORE it opens; the optional `data` + `meta` patch lets a content write that must land with the attach (map-regenerate's layout/mapImageId/preset/siteShape/budgetAdvisory) commit atomically instead of a second `updateArtifact` write; the optional `removeImageIds` swaps gallery ids out in the same tx (single-map-slot replace, docs/11 D16); the optional `scrubImageIds` releases ONLY those ids from THIS artifact's revision snapshots in the same tx, so the post-attach `pruneCandidates` frees exactly the superseded blob — this remove+scrub+prune triple is portrait delete-after-replace (docs/11 D5 preservation rule): the old cover's history pins release atomically with the fresh cover's commit, never before | `createImage` then `updateArtifact` as separate writes |
| Point a module/campaign cover slot at a stored image (the cover-writer seam) | `features/covers/cover-image-queue.attachCover` — `createImage` then `patchModule` / `updateCampaign` carrying `{coverImageId}` (loud existence check: a row deleted mid-flight throws NotFoundError, never a dangling slot); modules/campaigns have no revision snapshots, so no scrub step exists — regen is swap-then-`deleteImageIfUnreferenced(old)` (delete-after-replace, §5) | routing a cover write through `attachImagesToArtifact` (artifact-only seam: gallery/snapshot semantics that cover rows don't have); clearing the slot before the replacement lands |
| Write rule chunks | `chunkRepo.writeChunks` (`putChunks` alias) — invalidates the keyword index with the write | `db.chunks.bulkPut` anywhere else; backup restore MUST route through this door |
| **Read chunks of one type** (docs/17 row 182) | `chunkRepo.listChunksByType(chunkType)` — THE one `where('chunkType').equals(...)` read, through the already-indexed `chunkType` column; no new index and no payload column read (`spellData` rides the row exactly like `itemData`). Three callers: the library creature pool (`db/creatureRepo.listLibraryCreatures`), the wiki-link creature publisher (`app/use-library-creatures`) — both FOLDED onto it — and the campaign spell list. The `COPIES: 3→1` line in docs/17 row 182 is this fold | a hand-spelled `db.chunks.where('chunkType')…` at a caller — `tests/db/chunk-type-read-seam.test.ts` (a SOURCE SCAN over `src/`, comments skipped) reds it by file and count. Caller-side `.filter()`/`.sort()` ARE fine and live at the callers: the QUERY is the seam, not the shaping |
| **Carry structured pack data on a rule chunk** (12-BESTIARY-PACKS §13 item lane; docs/12 §15 spells arc, ledger 181; **ledger 189** adds the pf2e bestiary creature's own `statBlock.spells`; **ledger 191** adds the FOCUS item's no-rank stamp and its source fixed auto rank) | `domain/rulebook.ruleChunkSchema`'s per-kind nullish payload slots — `statBlock` (creatures), `itemData` (equipment), `spellData` (spells, including the heightening capture: the source's own `system.heightening` verbatim plus the notes parsed from the raw description) — each validated by its own schema and discriminated by the already-indexed `chunkType` (`'statblock'`/`'item'`/`'spell'`). The adapter's ONE mapping emits payload + text on the SAME entry and `packImport.sectionChunk` stamps the matching chunk type. Every payload is `.nullish()` (raw Dexie reads; rows written before its arc genuinely lack the key): no migration, no Dexie index change, no side table — a pre-arc rules row stays an honest `section` with no payload until its pack is re-imported. **Ledger 189 (the library-mob half of the spells arc) rides the SAME `statBlock` slot on the creature side:** the `foundry-pf2e` adapter's one item walk stamps the creature's OWN `items[]` of type `spell` onto `statBlock.spells` (source order; name verbatim; the source's own cast rank `castRank = system.location.heightenedLevel ?? system.level.value` — the upstream `SpellPF2e.rank` expression — with a `cantrip`-trait item carrying NO cast rank), reading the cantrip signal through the ONE `domain/spellData.spellTraitsAreCantrip` the rules lane also uses, and the ONE resolver `domain/mobSpells.mobSpellChips` renders it later — no second report. **Ledger 191 adds the FOCUS half to the SAME walk:** a `focus`-trait `spell` item (the signal is the ONE `domain/spellData.spellTraitsAreFocus`; upstream's tradition-less-cantrip arm of `isFocusSpell` adds nothing because a cantrip is auto-heightened anyway) is stamped with NO cast rank — upstream ignores its `heightenedLevel` — and carries the source's fixed auto rank `autoHeightenLevel` (the item's `location.autoHeightenLevel`, else its `spellcastingEntry`'s `system.autoHeightenLevel.value`, resolved in ONE pre-pass over `items[]`), because those two fields live on the CREATURE document and the rule reads only the rules-pack `SpellData`. **Ledger 194 adds the dnd5e half to the SAME slot:** the `foundry-dnd5e-srd` adapter emits `type: 'spell'` documents on the SAME third lane (`PackSectionEntry.spell` → a `spell` chunk) with `system: 'dnd5e'`, `rank` = the source's own `system.level` (**0 = cantrip**), `cantrip` = `level === 0` (the ONE `dnd5eSpellIsCantrip` — 5e has NO cantrip trait), `school` validated against the system's own eight codes, `properties`, `traditions: []` (a 5e spell is NEVER given a PF2e tradition), `filterAxis: 'school'` (the axis the document carries, stamped by the adapter that read it), and the dnd5e counterpart of `heightening` — `upcast {baseLevel, sentence, parts[]}`, where `parts` carry the source's own damage `scaling` blocks and `sentence` is the source's own "At Higher Levels" paragraph VERBATIM | a side table or second store for payloads; a migration that GUESSES a payload from chunk prose; a second parser or a second text renderer for the structured half (the text IS the `contentHash`); a new chunk type for rules text that carries NO payload (conditions/feats stay `section`); computing a DERIVED cast-rank value at ingest (the payload captures heightening as data — choosing a rank is the mob arc's policy); **resolving, normalizing or rejecting a creature's own spell NAME at import** (the importer stamps the source's own spelling verbatim; the ONE resolver `domain/mobSpells.mobSpellChips` owns matching — through `comparableName` — and its loud report lives at render/export time, because the bestiary and rules packs import separately and in either order); a SECOND cantrip signal (the `cantrip` trait is read in exactly one place — `tests/architecture/one-cantrip-signal.test.ts` reds a hand-spelled `.includes('cantrip')` by file); **a SECOND focus signal or a derived focus rank at ingest** — the `focus` trait is read only through `domain/spellData.spellTraitsAreFocus` (the same scan reds a hand-spelled `.includes('focus')`), and the importer carries the source's fixed `autoHeightenLevel`, never a computed rank (the rank is `spellAtRank`'s) |
| **Compute a spell's values at the rank it is actually cast** (docs/17 ledger 183; the mob arc's ONE dependency) | `domain/spellHeightening.spellAtRank` — the ONE heightening rule, pure and payload-only. `fixed`: the HIGHEST listed layer `<= appliedRank`, each layer a COMPLETE replacement (base below the lowest); `interval`: the source's own delta applied once per whole `floor((appliedRank - rulesBaseRank) / interval)` step (the pinned reference implementation's expression) plus a per-step `area` ADD; `cantrip`: the RANK is derived here, `clamp(ceil(casterLevel / 2), 1, 10)`, with the cantrip RULES base rank 1 (never the list rank 0) — **the arithmetic is now the ONE exported `domain/spellHeightening.pf2eCantripRankFor(level)` (the row-194 follow-up): the cantrip arm and the focus arm CALL it, and `domain/mobSpells.maxCastableRank` — the vocabulary's eligibility cap — CALLS the SAME function, so the cap and the rank a cantrip is actually cast at cannot drift; `tests/architecture/one-cantrip-rank-rule.test.ts` reds a second spelling of the arithmetic (needle: the whitespace-collapsed `Math.min(10, Math.max(1, Math.ceil(<name> / 2)))`, so a rename cannot hide a copy), and the agreement pin in `tests/domain/mobSpells.test.ts` holds all three consumers to one number at caster levels 7 and 9**; **`focus` (ledger 191): a non-cantrip `focus`-trait spell derives its rank here in upstream's order** — `request.autoHeightenLevel` (the source creature's item-then-entry fixed rank, carried by the importer because the rules-pack payload never holds it), else `clamp(ceil(casterLevel / 2), 1, 10)`, with its OWN provenance `source: 'focus-auto'` / `focusAuto` (never `cantrip-auto`), and an EXPLICIT `castRank` WINS over every derived rank; prose-only: the applicable note VERBATIM plus the loud `PROSE_ONLY_MARKER` and NO computed numbers. **Ledger 194 makes the seam SYSTEM-AWARE, and that is what closes the cantrip trap:** `spellAtRank` dispatches on `spell.system` BEFORE any arm above — `'dnd5e'` goes to `spellAtRankDnd5e`, and the PF2e path is byte-identical. **THE 5e ARM IS A DIFFERENT MECHANISM, NOT A SECOND RULE:** a levelled 5e spell scales by the SLOT it is cast in (`steps = castRank - upcast.baseLevel`, each `scaling.mode: 'whole'` part gaining `scaling.number * steps` dice of its own denomination), a part whose mode is empty is PROSE ONLY (the source's `upcast.sentence` VERBATIM behind `DND5E_PROSE_ONLY_MARKER`, no number), `'half'` is a loud refusal, and a 5e CANTRIP is never given PF2e's `clamp(ceil(casterLevel / 2), 1, 10)`: it stays `appliedRank: 0`, scales at `floor((characterLevel + 1) / 6)` tiers (upstream `ScalingIncrease`) with the new `cantripScaling` flag, and a creature stating no character level gets the per-tier values with the tier UNCHOSEN (loud) — never a number derived from a printed CR. The dnd5e assignment's `casterLevel`/`characterLevel` are refused LOUDLY on a PF2e spell, so the two systems' levels never mix | Formulas combine SYMBOLICALLY (same-die counts add; dice in first-appearance order; one flat total last) and are never evaluated or rolled; `appliedSteps`/`stepRemainder`, `notes`, `unparsed` and `warnings` carry the provenance | a SECOND heightening rule anywhere — a mob/UI/LLM re-deriving the cantrip or FOCUS rank or the fixed/interval selection, or a copy of the formula combiner; **reusing `'cantrip-auto'` for a focus spell** (the two are different rules and a chip's provenance line is the only place the owner can see which ran); **requiring a caster level for a focus spell whose source states a fixed `autoHeightenLevel`** (upstream short-circuits to the fixed rank); computing numbers from `heighteningEntries` PROSE (it is displayed verbatim and flagged, never arithmetic); parsing the stored spell text for a base formula (the payload carries `spellData.damage`/`area`); evaluating or rolling a formula; rounding a non-whole interval step UP or throwing on it (floor + a reported `stepRemainder` is the Paizo/Foundry rule); silently dropping `heighteningUnparsed`, a layer key the rule does not consume, or an interval delta with no base damage entry |
| Get/create the live battle for a module | `battleRepo.ensureBattle` — the v16 unique `&moduleId` index is the arbiter | get-then-create across two transactions |
| Cite a library creature from an encounter roster (no artifact, nothing created) | The roster's `source` (`rulebook` / `npc-ref` / `inline` / `none`) + `db/creatureRepo.resolveCreatureCitation` — a citation names the BESTIARY (chunk id, else the content hash recorded at citation birth) and materializes nothing | the retired `mobArtifacts.getOrCreateMobArtifact` (docs/17 row 106)ing it away from the first module | scan-then-`createArtifact` in separate txs (splits token identity); moving a placed mob artifact to another module |
| Cast a library creature as this campaign's OWN npc (the Aunt Agatha path) | `db/creatureRepo.castCreatureAsNpc` — ONE function, idempotent per (campaign, module, name, IDENTITY): it creates the row on first cast, REUSES it on the second (writing nothing), refuses a same-named rival that draws from a different creature, refuses to cast over an authored npc, and refuses a creature the library cannot supply. Only the MODULE generator and the bestiary spawn dialog hold it | `createArtifact` plus a hand-written `creatureRef` at a call site; any cast attempt from the encounter side (structurally impossible — the roster schema cannot express one) |
| Ask the MODULE GENERATOR for a cast (the Aunt Agatha path, docs/17 row 107) | The entity record's optional `bestiary` slot (`domain/module.ts` — `{ creature, book? }`, the creature's name as the library spells it, `book` only when two books share it) + the spine clause `llm/promptStyles.spineEntityKindsClause` (rendered ONLY when `db/creatureRepo.listLibraryCreatures` is non-empty, so an empty library composes the pre-change prompt byte for byte) + `features/modules/entity-batch.libraryCitationForEntity` resolving the NAME to a citation at finalize and casting through `castCreatureAsNpc`. A persona run IS started for that entity, ALWAYS, since docs/17 row 135 — the module's paragraphs are its context, never its description (see the row below) — and the stats are never the run's, they stay the library's. **THE SLOT'S `book` IS A DISAMBIGUATOR, NEVER A VETO (docs/17 row 161): exactly ONE library creature of that name RESOLVES whatever book the slot named — the book is not even read on that arm; two or more need a book that matches EXACTLY ONE candidate; and the name match is EXACT, because the pool is the prompt's own VOCABULARY (row 114) and a fuzzy match would cast a different creature than the module asked for.** A name the library cannot supply, or one whose ambiguity its book does not narrow to one candidate, FAILS the entity loudly by name into the batch's existing `failed[]` — the no-such-name arm byte-identical to before (nearest-name suggestions included), the ambiguity arm listing every candidate WITH the book it really comes from. The citation ALWAYS stamps the LIBRARY's title (`domain/encounterResolve.citationBookTitle`), never the slot's string | writing `creatureRef` by hand at a call site; a second creature lookup or a second cast function; **a FUZZY or nearest name match at resolve** (the pool is the prompt's vocabulary — a suggestion is a MESSAGE, never a cast); **a silent pick among ambiguous candidates**; **a book title taken from the MODEL rather than the library** (the slot's `book` is a hint the model may have localised — it must never become the citation's `bookTitle`, or `missing ref` names a pack that does not exist); **a second copy of the lookup** (a source pin in `tests/features/entity-batch-creature-book.test.ts` holds `listLibraryCreatures`'s call sites to `db/creatureRepo` / `llm/creatorRoster` / `entity-batch`, and the definition of `libraryCitationForEntity` to ONE file); guessing between two candidates; dropping the prose into a statless twin; making the clause unconditional (an unconditional clause changes the prompt for every workspace that has no bestiary) |
| **Decide whether a cast entity has a DESCRIPTION at all** — **CLOSED by docs/17 row 135** (opened at row 133): there is no such decision, and the seam that made it is DELETED from `src/` | NOTHING decides it: every NPC the module's text produced gets an authored description, because a batch target is BY CONSTRUCTION a wiki-link of the module text (`post-generation.namesOfKind` = `extractWikiLinks(moduleDocumentText)`, filtered by the recorded kind) and the link IS the name — the owner, verbatim: *"An NPC is named if its a wikilink in the module text. Because that link IS the name."* / *"Author a description anyway."* The entity's own persona runs TARGETING the cast row (`targetArtifactId`, no placement) so the ratified cited-row REFILL does the write: statblock step `'skipped'` with its reason before the model call, citation byte-identical, `statBlock` null. The module's own paragraphs ride the SAME brief the ordinary npc arm builds, as CONTEXT — the anchor is the LINK, not a search for the name string: `surroundingParagraphs` normalizes every wiki token to its TARGET name before matching, so an aliased `[[Aunt Agatha\|Müllerin]]`, whose name never appears in the rendered prose, is still found and its raw token still reaches the model. The no-clobber guarantee is the TARGET SET now: `batchTargets` filters on `hasDetailedEntity`, so a name that already has an authored row of its own — exactly what a description makes it — is not a target at all, and `castCreatureAsNpc` refuses (never takes over) a same-named row that is not the same creature | re-introducing a threshold, a length check, a word count, a name-strip or any "is this passage descriptive enough?" seam — `lib/wikilinks.describesEntity` and its floor `ENTITY_DESCRIPTION_FLOOR` are GONE and a source scan holds their absence (a textual scan cannot see a dead condition, so the behaviour is pinned through the REAL engine as well); letting the module's mention stand in for a description; reading the module's paragraphs as anything but context; asking the cast row's OWN body whether to write (row 133's second ask, deleted — the target set is the guarantee); authoring a stat block for a cast row, or minting an ordinary npc beside the cast; writing the description through anything but the cited-row refill |
| Ground an UNCITED roster entry's on-demand creature (inline/none) | The roster entry ITSELF — its name + `notes` are the identity (`domain/creature.contentCreatureKey`) and the portrait prompt's whole grounding (`MobPortraitJob.grounding`); no row exists | `mobArtifacts.materializeInventedCreatureArtifact` (retired, docs/17 row 106)mmary marker; `moduleId` = encounter's when module-owned else campaign-level; roster entry NOT rewritten so seeds stay identical) + the run-engine Smith finalize's inline-statblock path (`materializeMonsterNpc` — `moduleId` = the run's `placementModuleId` when placed, campaign level otherwise, matching the encounter/generate create sites; reuse prefers a same-named row the USING module already owns and never re-scopes the row it links — a scope change is only ever `moveScope`) + `features/campaign/mob-portrait-queue.enqueueInventedCreaturePortraits` (chunk-less local-only jobs — invented covers never read/populate/overwrite the global cache). Superseded: docs/fix-02 put this path at campaign scope, which made a module-placed encounter's inline mobs survive `deleteModule` | a new kind or a `monsterChunkId` marker on a chunk-less row; rewriting the entry to npc-ref (changes seed identity); materializing at campaign level regardless of placement |
| Global mob portrait per cited chunk (canonical only, all campaigns) | `db/mobPortraitCache` (firewall `cacheKeyForMonsterSource`, read-through `fillCoverFromCache` (now called by NO production path: the portrait BATCH stopped passing it while enumerating — ledger 83: a cover-less canonical citation is a normal job whose worker clones the populated slot, so a visible hole is reported as WORK, never as `alreadyImaged`), render `cloneCachedPortraitToArtifact` — first-time clone skips imaged artifacts, the `force` flavor force-clones delete-after-replace for regen — plus artifact-to-artifact `cloneArtifactCover` for the content-regen carry-forward; all three ride the ONE `attachClonedCover` core, never a second mechanism — first-publish `storeCanonicalPortraitIfAbsent` — put-if-absent ONLY) + `features/campaign/mob-portrait-cache-queue.ensureCanonicalMobPortrait` (cross-campaign single-flight; Dexie v18 `mobPortraits` table `id, &chunkId`; docs/11 D5 amendment). Regen republishes through `replaceCanonicalPortrait` (the ONLY unconditional slot writer) via `regenerateCanonicalMobPortrait` (the ONLY always-fresh generation) — never `storeCanonicalPortraitIfAbsent` for a regen (it would keep the old bytes) | generating per campaign; attaching the shared global row as a cover; a flavored citation writing the cache; republishing the slot anywhere but `replaceCanonicalPortrait` |
| Count a mob-portrait batch before acting (the encounter editor's confirm) | `features/campaign/mob-portrait-queue.planMobPortraitBatch` — the read-only half of `enumerateBatchKinds`, the SAME enumeration the additive batch (`enqueueMobPortraits` / `enqueueInventedCreaturePortraits`) and both regen paths walk: it resolves what EXISTS (`findMobArtifactByChunk`, `mobArtifacts.findInventedCreatureArtifact`) and creates, clones and enqueues NOTHING; a dangling stamped `mobArtifactId` throws loud in both modes | a second enumeration that drifts from the batch (the confirm would promise work the queue will not do); counting by creating or cloning |
| Regenerate a mob / invented-creature portrait | `features/campaign/mob-portrait-queue.regenerateMobPortraits` (rulebook batch: validate → republish canonical slots fresh → enqueue delete-after-replace regen jobs `regen: true` for the imaged artifacts + the normal cover-less batch for the remainder) / `regenerateSingleMobPortrait` (battle-card single mob: the same three phases on one resolved target) / `regenerateInventedCreaturePortraits` (uncited: materialize → regen jobs for the imaged + the normal invented batch for the cover-less remainder) — delete-after-replace is the one way (docs/11 D5 preservation rule): the worker generates fresh bytes, then the attach seam swaps the cover in ONE tx (fresh cover commits, ONLY the superseded ids are scrubbed from that artifact's snapshots and refcount-pruned); a failed republish throws loud with all old covers intact and nothing enqueued; a failed, skipped, or queue-dropped regen keeps the old portrait with a loud error — regen entries upgrade (withdraw-then-enqueue) any stale queued/in-flight normal job for the same artifact so the dedupe can never strand a regen as a silent skip — the encounter editor's batch confirm chooses between the additive fill and this replace path from the read-only count (ledger 83), and states the shared-republish consequence BEFORE the click | detaching first (`removeImageFromArtifact` in a regen path — destroys the blob AND the restore path before the replacement exists); a second detach/enqueue path; re-enqueueing an imaged artifact expecting fresh bytes (the skip branch + cache read-through return the OLD art — a no-op regen); detaching without re-enqueueing (strands initials) |
| Show a creature's portrait, and write it — THE one reading and THE one write (AMENDED by docs/17 row 165) | **`db/creatureRepo.creaturePortraitImageIn({presentationByKey, creatureKey, npcArtifact})`** is THE portrait question over the values a caller already holds: the artifact the row points at, when it has art (a cast or hand-authored npc's OWN cover, then its first gallery image — what a module surface renders for that row) → else the campaign's presentation row for the creature IDENTITY → else `null`. **THE ORDER IS AMENDED BY ROW 165**: the two halves were the other way round, which made the rule answer with an image no surface of that row showed; both halves are unchanged in what they mean. Pure and synchronous BY DESIGN, because the surfaces that must agree render from live snapshots (the battle board's tokens, the board's selection card and lightbox, the battle card's Generate-vs-Regenerate state, the module gap detector's predicate) and may not take a database read per token or per roster row. `creatureCoverImageId` is the ASYNC shape of the same rule — it reads the two rows for its caller and DELEGATES, so the two cannot drift — and `setCreatureCover` is THE one write (insert-or-replace + release the superseded blob when nothing else pins it). Every renderer asks THIS, so two surfaces cannot disagree about whether a creature is illustrated: before row 165 the battle board was the ONE surface that did not (it drew the token's ARTIFACT cover, which a cited creature does not have), and the owner saw initials on the map while the module surface showed the portrait | **a per-surface art reading** (the board's artifact-cover-only art was exactly this); **a fallback lookup for a key that missed** (the ORDER above IS the rule — the row's own art first, then the presentation row for the identity); **a second resolution order** beside this one (a surface that re-derives "presentation row, else cover" is the drift this seam exists to prevent); `carryMobCoversForward` (retired with the mob artifact, docs/17 row 106); `documentCoverImageId` (deleted by row 165 — it was the blob reader of one presentation row with no caller left once the ONE reading returned the row's `imageId` itself); re-citing without carrying (abandons the cover while tokens fall back to initials); deleting the old row as part of the carry |
| Read / patch settings | `getSettings` (write-creates defaults) / `readSettings` (pure — liveQuery-safe) / `updateSettings` (tx, schema-validated merge; existing rows merge over defaults). The read is TWO parts: `coreSettingsSchema` (every load-bearing setting, strict) + the New Module draft validated on its own — see the draft row below | raw `db.settings` reads without the defaults-merge parse; a settings read that fails because of a CONVENIENCE field (docs/17 row 76) |
| Persist the New Module dialog's draft (owner request, docs/17 row 70) | `domain/settings.newModuleDraftSchema` — ONE settings field, `newModuleDraft`, REQUIRED-but-NULLABLE like `lastModule` (`null` = nothing stored; a row/backup written before the field parses as null), TAGGED with `campaignId`; the dialog prefills it only when the tag matches the campaign being created in, overwrites it (never merges across campaigns), debounces the save and FLUSHES on run start / dialog close / unmount, and offers **Reset to defaults** as the escape hatch. Deleting a campaign clears a draft tagged with it (`campaignRepo.deleteCampaign`); the two campaign WIPES deliberately KEEP it (`removeAllGeneratedContent`, `maintenance.deleteCampaignWorkspace` — it is authored input and retry-after-reset is the feature). A stored draft that no longer validates is SCOPED to the draft (docs/17 row 76, ledger decision after the owner's recommendation): `readStoredNewModuleDraft` returns `{ draft, error }` — never a half-value — and the dialog, the ONE consumer that shows a draft, reports the failure with `toastError` (once per open, keyed by message) and opens at its own DEFAULT levels rather than half-prefilling from data the app cannot read. The load-bearing settings around it stay readable, so a legacy row whose draft names an artifact kind that was since RETIRED cannot brick the app; the old contract (`readSettings` itself rejects, the dialog hits the error boundary) is in the git history before `84e77a9`. The prefill itself: the user's typing always wins (the form's "edited" mark is armed SYNCHRONOUSLY by the interaction, never by an effect) and the row stays the source of truth until then (a newer snapshot is re-applied while the form is untouched, and only the user's edits are ever written back — docs/05 §New Module dialog) | a per-campaign MAP (a second record shape that every delete path would have to sweep — the orphan class closed twice already); prefilling an untagged or foreign draft; clearing it in a wipe (defeats the retry); returning a corrupt draft as a value, or prefilling it silently (AGENTS 1/3); letting one unreadable draft fail every settings read in the app |
| **Record a recently used GLOBAL chat model** (docs/17 rows 193 and 198) | `db/settingsRepo.recordRecentChatModel(model)` — THE one recording WRITE: ONE `rw` transaction reads the settings row, merges through the ONE pure `domain/settings.withRecentChatModel` (trim, move-to-front, dedupe, cap `RECENT_CHAT_MODELS_CAP` = 8, oldest dropped) and writes through the ONE `updateSettings` (validation + the prompt-styles carry-forward inherited, never re-implemented). `llm/recentChatModel.recordGlobalChatModelInUse(model)` (docs/17 row 198) is THE one IN-USE seam over it — the place a caller says "the global chat model was genuinely in play"; it is FIRE-AND-FORGET with its own catch/toast (awaiting a settings transaction on a run's critical path was a measured regression, row 193). Callers: `features/settings/model-widget`'s `choose` (the ONE model-picking widget changes the global model — its `recentModels`-carrying mounts are exactly the top bar, the Settings chat-model field and the wizard's key-step field, docs/17 row 199 — and it calls the WRITE directly, because a pick IS that write) and, through the in-use seam, `llm/runEngine.recordChatModelInUse` at `executeFrom`'s top (a run whose chat model resolves to the GLOBAL default; an image-mode or persona-override run is skipped), `llm/moduleGen` (the spine pass, the parts pass, the three normalization entry points), `llm/modulePlan`, `llm/canvasRefine`, `llm/canvasChat` (only when no session model is set) and `llm/ideaBoard` (only when `board.model` is empty). The whole resolution population with its record/exclude decision is pinned by `tests/architecture/global-chat-model-recording.test.ts`. The list lives on the ONE settings row as `recentChatModels: z.array(z.string()).default([])` (additive; no migration, no Dexie version) | a component-side read-modify-write (two concurrent recorders read a stale list and lose an entry — AGENTS rule 1); a second ordering rule; a second in-use recording helper; recording a persona override, `fallbackChatModel`, an image/embedding model, a per-board or per-session selection, or the dev bench's diagnostic vision probe (docs/17 row 198); a second settings write path |
| Show an image | `useImageUrl` (`features/images/use-image-url.ts`) — object URLs revoked on change/unmount | `URL.createObjectURL` without revoke |
| Bring an image INTO the app (upload or generated blob) | `imageIntake.intakeImage` — EXIF-safe decode, ≤1600px long edge, WebP re-encode | ad-hoc canvas/FileReader scaling |
| Store map candidates mid-run | `imageRepo.createImage` per candidate — deliberately UNATTACHED until the pick step attaches via the seam; top-level use only (inside a tx: `buildStoredImage` before it opens, `db.images.put` inside) | attaching candidates eagerly |
| Delete a module / campaign / artifact | `moduleRepo.deleteModule` ('cascade' \| 'keep' \| 'promote-referenced') / `campaignRepo.deleteCampaign` / `artifactRepo.deleteArtifact` — 'promote-referenced' adopts outside-referenced rows (fresh `modulesReferencingOwnedArtifacts` scan: wiki-graph edges (module prose), artifact `links[]` relations, artifact BODY wiki-links, roster `npc-ref`/`mobArtifactId`, battle tokens/seeds — over the READER'S pool, campaign rows PLUS the global library, so a published encounter's citation counts) BEFORE the tx, then cascades the rest; 'keep' releases through `releaseModuleOwnership` (the scope seam, above); the list dialog shows the third state with the referenced names AND a separate REFERENCE census of the shared campaign-scoped mob artifacts its encounters cite (`mobArtifacts.countMobArtifactsCitedByModule` — never ownership: `deleteModule` does not touch them). **Durable version rows die in exactly ONE place**: `moduleVersionRepo.deleteModuleVersionsForModules(moduleIds)` (§2.3 simple undo) — `deleteModule` calls it with its own id, and EVERY bulk module delete does too (`deleteCampaign`, `removeAllGeneratedContent`, `deleteCampaignWorkspace`), always INSIDE the callee's delete transaction with the ids re-listed in that same tx immediately before the module rows go (afterwards the ids are unrecoverable; the tx holds `db.modules`, so no concurrent insert can land between the re-list and the sweep — the seam behaves identically in every caller). There is deliberately NO campaign-scoped query to use instead: `moduleVersions` carries no `campaignId` (`moduleId` is the only key) and adding one would be a Dexie version for a delete-only concern. `moduleVersionRepo.pruneOrphanedModuleVersions()` (distinct `moduleId` index keys vs the live module primary keys — ids only, never the `docText` rows) is the orphan DOOR the three campaign wipes also call: rows whose module row is already gone (residue from a build that predates this seam, which no module-keyed sweep can reach) are garbage by definition — a row is only ever written for an existing module — so collecting them is safe and cannot touch another campaign's live stack. `deleteModule` frees its own cover blob after the row delete (captured before, `deleteImageIfUnreferenced` after — the refcheck's cache-table read cannot join the delete scope); `deleteCampaign`'s image sweep frees module + campaign covers with everything else | ad-hoc cascades — these are transactional, recount-honest (rows re-listed inside the tx), scrub battles/links/images; a per-site copy of the version delete (one seam, four callers); stringifying a Dexie `IndexableType` key into a "uuid" (the seam throws on a non-string key instead of silently skipping a corrupt row) |
| Remove ONE kind's campaign-level artifacts in one campaign (the campaign tree's per-region "remove all") | `artifactRepo.deleteArtifactsOfKind(campaignId, kind)` + its live census `describeArtifactKindRemoval` — ONE rw tx over exactly the tables `deleteArtifact` needs, the campaign's rows of that kind re-listed INSIDE it (a row created after the confirm counted is swept by the same pass and counted), then nested `deleteArtifact` per row (subset scope ⇒ joins the tx, so any failure rolls the whole pass back — no partial run can reach a success toast); `imagesPruned`/`battlesDeleted` are MEASURED across the pass and the other counts come from the same in-tx inspection the census uses, so the confirm and the toast cannot drift; idempotent (zero rows = honest zeros), unknown campaign is loud. Guards: **campaign-level rows only** (`moduleId === null`, so module rows, module prose, module entity records and module version stacks are out of reach), **the global library is structurally untouchable** (the doomed set is derived from `campaignId`, so the `campaignId === null` class is never even scanned; the campaign image prune cannot see a global blob), **the Party is refused** through the domain constant `BULK_REMOVE_EXCLUDED_KINDS` (read by the tree AND the seam — never a scattered `kind !== 'pc'`). Census honesty (the confirm names these, live): surviving artifacts that lose back-links, scrubbed battle tokens + boards that empty out and delete themselves, seeded boards that lose their encounter, encounter roster entries falling back to the loud `missing ref`, freed images, and that there is NO undo for artifacts. Audited paths deliberately left dangling (all identical to the per-item trash today): run `targetArtifactId`/`contextArtifactIds`, battle `seedFighters` rows, encounter rosters (rewriting an authored roster behind the GM's back would be worse than the badge); `imageRepo.referencedImageIds` takes an optional exclusion set so the census's image count comes from the ONE coverage scan instead of a second copy | a loop of per-item `deleteArtifact` calls (no cross-call rollback); `db.artifacts.bulkDelete` (strands revisions, links and battle tokens); a remove-all on the Party region or the Library group; a second reference-coverage scan written for the dialog |
| Remove all generated content (fresh generation start, Party kept) | `campaignRepo.removeAllGeneratedContent` — ONE tx over every touched table, rows re-listed inside; per-row disposal rides nested `deleteArtifact` (subset scope, joins the tx), battles/modules/runs go by campaign sweep, **the wiped modules' durable version rows go WITH their modules in the same tx** (`deleteModuleVersionsForModules` with the module ids re-listed in-tx + `pruneOrphanedModuleVersions` — the sweep seam in the row above; undo history is not kept content), orphans prune via `pruneUnreferencedImages` (campaign rows only — library images structurally immune); in-flight module passes abort BEFORE the tx (native-promise import must never gap a Dexie scope) | per-module `deleteModule` calls outside a shared tx (no cross-call rollback); a second wipe implementation anywhere else; a second version-delete implementation |
| Clear one campaign's workspace (FULL reset, premise kept) | `db/maintenance.deleteCampaignWorkspace` — the `removeAllGeneratedContent` discipline (ONE tx, in-tx recount, nested `deleteArtifact`, campaign sweeps, prune, last-module shortcut clear, pre-tx `cancelModuleGen`) over EVERY artifact kind INCLUDING `pc` (the wipe keeps the Party — this one does not); keeps ONLY the campaign row, rulebook ingests (global source material, not campaign-keyed), the global portrait cache/library/personas/settings, and every other campaign — **the cleared modules' durable version rows are NOT kept**: they go with their modules in the same tx through the one sweep seam + its orphan door (row above), and the confirm copy names them so the dialog never implies undo history survives; the Edit-campaign confirm types the campaign NAME (exact, case-sensitive) with a one-at-a-time loud refusal, toasts loud naming the campaign, navigates out of deleted child routes, and needs NO reload (live queries refresh) | routing a full reset through the Party-keeping wipe (strands PCs); the global `deleteAllData` for a one-campaign job; hand-written `/c/…` prefix checks (use `campaignIdFromPath` + `workspacePath`) |
| **Open an encounter from the module reader and show its roster** (docs/17 row 179; docs/08 §M4-C) | `features/modules/ModuleReaderPage.openArtifact` is the one reader opening seam for sidebar rows and prose chips; `features/modules/peek-modal.PeekBody` dispatches to `play/artifact-cards.EncounterCard`, which mounts the shared `MonsterStatblocksPanel` with the reader artifact pool. The sidebar keeps row metadata and independent `RunBattleButton`; workspace navigation remains the card's explicit action. | a sidebar-only route exception; an inline roster mount that expands below the row; a second roster renderer or resolution path |
| **Show a cited npc's BORROWED numbers** (the Aunt Agatha row's stats; docs/17 row 134, docs/11 §A cited row's REFILL) | `domain/encounterResolve.resolveDerivedNpcStats(npcName, citation, lookups)` — THE one derived-stats rule: an empty citation THROWS (`creatureRefIsEmpty`), a citation the library cannot supply answers the named `missing ref (<the citation's own creature name>)`, and a resolved one answers the library block under `derivedStatOrigin` (`NPC: <name> (stats from <book p.N>)`). The encounter roster's `npc-ref` arm calls it and `db/creatureRepo.resolveDerivedNpcStats` is the repo-wired wrapper top code reads. RENDERING is ONE component, `features/campaign/components/borrowed-stats.BorrowedStatBlock`, MOUNTED by `features/campaign/components/kind-forms.NpcForm` (the artifact editor's details) and by `features/play/artifact-cards.NpcCard` (the read-only card the module reader's peek modal and session mode show) — it draws the block READ-ONLY with a `Borrowed from the library` badge plus the origin label, renders a named destructive notice for a missing creature, and raises a thrown read through `lib/toast` | a second derivation or a hand-rolled stat extraction in a component; a `StatBlockCard` rendered off `data.creatureRef` at a surface of its own; writing a block onto a cited row (the pair is refused by name); offering a cited row the `Add stat block` button (the cited-row refill refuses it before any model call); rendering a blank/greyish stat area for a missing library creature (defaults that mask a failure are forbidden) |
| Backup / export / import | `lib/backup.ts` (whole-DB restore rides `db.transaction('rw', db.tables)` + the chunk door; `OPTIONAL_TABLES` lists `moduleVersions` beside `pdfFiles`/`mobPortraits`, so a PRE-undo zip — one whose manifest predates the v19 table — restores with an EMPTY undo stack instead of failing the missing-table check) / `lib/exportImport.ts` (campaign export v2: modules/battles/runs + `dependencies` manifest, and `RETIRED_EXPORT_TABLES`/`retiredTableRows` counting the rows of a table this build no longer has — reported on import, never dropped in silence; import = ONE tx over the eight tables, array form, with module/artifact re-id maps rewriting every reference — an artifact whose exported `moduleId` is not in the file demotes to campaign level ONLY on a v1 file (the documented legacy rescue) and THROWS loudly on v2, the battle path's precedent, because demoting would move a row out of its module; `parseExportTolerant` is the import boundary's tolerance stage — strict first, then per-row retired/drift triage with skip-count, reassembled output strict-parsed before return) | table-by-table writes that can strand a half-import |
| Decide whether a module-owned orphan is deletable (the ONE guard predicate) | `orphanSweep.evaluateOrphanGuards(candidates, input)` (db/orphanSweep.ts — PURE, every input a value the caller already holds): the five guards in their load-bearing order (campaign-wide mention → ambiguity shadow → battle portrait token → frozen seed fighter) plus the SURVIVING-encounter roster pass, returning `refusal`/`null` per candidate with the loud reason text and the `moduleMentionedIds`/`shadowedIds` sets. The sweep assembles the FULL bundle from rows re-listed inside its tx; the panel passes the subset its props can see (`entity-orphans.panelOrphanGuardInput` — `campaignModules: [module]`, no battles), and `orphanOfferView` composes the derivation with the refusals a sweep RETURNED. Both surfaces therefore decide "deletable" with ONE function, pinned per candidate in `tests/features/orphan-offer-agreement.test.ts` | a second walk of the guards at read time (the owner's "Delete 2 orphans" offered two roster-cited creatures the sweep always refuses — ledger 92); a panel-side copy of the mention gate, the battle/outline guards or the roster pass; reading a guard's reason string to decide anything |
| Delete a module's orphaned entities (the guarded sweep) | `orphanSweep.sweepOrphanedArtifacts` (db/orphanSweep.ts — owns `ORPHAN_KINDS` + the orphan definition; docs/08 §M4-C "Orphaned entities", 14 §7) — ONE rw tx (array form: artifacts, revisions, images, battles, modules, campaigns) that RE-DERIVES candidates from re-listed rows INSIDE the tx (recount) and decides them with the shared `evaluateOrphanGuards` predicate (the seam row above): campaign-wide mentions via UNCAPPED `buildWikiGraph`, ambiguity shadow, battle `tokens[].artifactId` + `seedFighters[].id` on ANY campaign battle, encounter roster `npc-ref`/`mobArtifactId` on any SURVIVING encounter (SAME-module counts — the module survives); per-artifact outcomes `deleted`/`kept`+reason for ONE caller toast; deletes ride the frozen `deleteArtifact` nested (subset scope) | deleting per artifact with an ad-hoc hand-rolled cascade; trusting a dialog count instead of the tx recount; a silent drop of a guarded row |
| Tag a module's unmentioned entities and offer only what a sweep will delete (read time) | `entity-orphans.deriveModuleOrphans` / `useModuleOrphans` / `orphanOfferView` (features/modules — pure over the panel's EXISTING props `module` + `artifacts`; no live query, no new props): module-owned rows of `ORPHAN_KINDS` with zero resolving wiki-link mentions in THIS module's prose, mentions via `buildWikiGraph` tokens (reader semantics), each row carrying the shared predicate's verdict; ambiguity-shadowed rows stay out of the group; a guard-refused row renders as IN USE with the sweep's own reason and no trash; `orphanOfferView(rows, recordedSweepRefusals)` composes the derivation with the refusals a sweep returned (panel view state), so the count/button/dialog list only what a sweep will delete and a refusal never re-offers the row | `countOccurrences` substring scans; a panel-side campaign-wide copy (the sweep re-derives the gate in-tx); a second orphan predicate outside the sweep's `orphanCandidatesOf`; counting rows a guard refuses (ledger 92) |
| Describe what an export cites but does not carry (rulebook chunks, library NPCs) | `collectDependencies` (`domain/exportDependencies.ts` — pure, `DependencyLibrary` maps injected; `buildCampaignExport` does the bulk Dexie reads) + the L0(contentHash)/L1(system+title+creature)/L2(chunkId) identity contract (docs/07 M3-E); missing image blobs land on `missingImages` with referrers named, never silently dropped | re-resolving rulebooks at read sites; a second citation-identity scheme |
| Check an export's rulebook deps BEFORE importing it | `analyzeDependencies` (same file — pure, `chunksByHash` pool + `books` injected; `checkImportDependencies` in `lib/exportImport.ts` does the Dexie reads: one `contentHash.anyOf` probe + same-system book chunks) → `importExport`/`importZip` default-abort via `MissingDependenciesError` BEFORE the tx opens (nothing to roll back); rulebook chunkIds are KEPT as-is so `missing ref` markers stay truthful; pre-stamp entries heal content identity from the manifest (`healRulebookSources` — matched by exporting artifact + cited chunkId, every field gap-only and INDEPENDENTLY: an entry that already has its hash still heals a missing `bookTitle`; docs/17 row 155); the AppShell `MissingRefsBanner` derives from the same `resolveMonsterEntry` contract (banner and badges clear together when byte-identical content is installed — the hash fallback, not the uuid) and reports WHAT is missing per its own seam row below | an ad-hoc hash compare inside the import tx; healing chunkIds to local rows; a toast-only surface; a second healing pass for the book alone |
| **Persist the standalone Idea Board — ONE app-level document plus its transcript** (docs/21, docs/17 row 173) | `db/ideaBoardRepo`: `getIdeaBoard()` creates the single row INSIDE one rw transaction (two concurrent opens cannot mint two boards), and `saveIdeaBoard(next, expected)` is an in-transaction COMPARE-AND-SWAP against the snapshot the session loaded, so a write another tab already superseded is REFUSED by name instead of silently overwriting it. ONE board is the feature's contract and `domain/ideaBoard.parseIdeaBoards` enforces it (two stored rows refuse loudly rather than being picked or discarded). Additive Dexie v23 (`ideaBoards: 'id, updatedAt'`, no upgrade body). The full-app backup carries it — `ideaBoards` is in `backup.OPTIONAL_TABLES` (a pre-v23 zip restores EMPTY, which is the truth about that database) and `importBackup` validates the rows BEFORE its destructive write — while the campaign EXPORT deliberately does not (the board is app-level, never campaign state) | a second board row or a plain `table.put` without the snapshot check (the lost-update shape); storing the board on `settings` (a preferences row), on a module row (module-owned, and exported with the module), or on an artifact (scope/revision semantics the board must not inherit); a campaign-keyed board table (it would have to be swept by three delete paths and would travel in campaign exports); an auto-retry loop around the refused save (the refusal would be reported forever) |
| **Read a campaign system's imported SPELL CORPUS — and index it by the ONE comparable name** (docs/17 row 184) | `db/spellRepo.ts` is the ONE spell-corpus read: `loadSpellChunksFor(system)` composes the two rules the app already owns — `db/rulebookRepo.readyBookIds(system)` (the ONE ready-book rule, MOVED here from `search/search.ts` by row 184 and re-exported by `@/search`, so every existing caller is unchanged; a `db` module importing the retrieval barrel was both a layering inversion and a live coupling — three LLM tests mock `@/search` with only `searchRules`, so the imported `readyBookIds` arrived `undefined` and every stat-block run threw) and `chunkRepo.listChunksByType('spell')` (the ONE chunk-type read, docs/17 row 182) — and returns the RAW chunks, so each caller keeps its own loud corrupt-row reporting; the pure projection `domain/spellData.spellCorpusEntries` (a spell chunk → `{ chunkId, name, rank, cantrip, data }`, MOVED down from `features/spells/spell-rows` by row 184's verification because `db`/`llm` importing a FEATURE is the same layering inversion as importing the retrieval barrel; `features/spells/spell-rows` re-exports it so the feature keeps its public surface, and it owns the corrupt-row SKIP whose loud report is `buildSpellRows`'s `data-error` rows); `loadSpellIndexesFor(systems)` is the ONE index builder (`domain/mobSpells.mobSpellIndex`, keyed by `domain/artifactAlias.comparableName`, first-wins) and `statBlockSystems(blocks)` the small collector the two PDF exporters share. Consumers: `features/spells/SpellsPage` (the list), `features/spells/mob-spell-chips` (a stat block's chips), `llm/runEngine.spellLibraryFor` (prompt + validation) and both PDF exporters' async pre-passes | the NOT-Z column: a second `where('chunkType').equals('spell')` or a hand-rolled `status === 'ready' && system === …` filter (the chunk-type read and the ready-book rule are each already single-site); a case-folding `name.trim().toLowerCase()` comparison instead of `comparableName` (the ONE comparable form, docs/18 §2.1); a cached module-scope index that a rules-pack re-import cannot refresh (the run engine reads per LLM step by design); merging two systems' corpora into one index (each system gets its OWN map); **a second ready-book filter** — the two component copies (`bestiary-roster`, `SpawnPicker`) were folded onto `listReadyRulebooks` and `tests/db/ready-book-seam.test.ts` reds the predicate by file (a single book's status BADGE is a different question and is not the needle); **a corpus read that is not scoped to its system or its ready books** — `tests/db/spellRepo.test.ts` seeds a ready PF2E book AND a ready dnd5e book that both carry `spell` chunks and requires each read to return only its own, in BOTH directions (since ledger 194 the dnd5e half is a REAL corpus rather than a probe: the dnd5e adapter imports `type: 'spell'` documents into the same lane, so the scoping pin protects two live lanes), plus the not-ready book's chunk dropped, plus the per-system index (`loadSpellIndexesFor`) and the collector (`statBlockSystems`) — the dispatcher's arm D (`readyBookIds(system)` → `readyBookIds()`) changed this file's bytes and left every OTHER test green, which is why this pin exists. **AMENDED BY REFERENCE (docs/17 row 207): the rule is NOT fully held by the spell corpus alone.** Three GENERATION reads escaped it — the module PARTS rule excerpts (`llm/moduleGen.ruleExcerptSection` called `searchRules` with no `system`), the module creator's bestiary window (`llm/creatorRoster` → `db/creatureRepo.listLibraryCreatures()`) and the CAST that resolves it (`features/modules/entity-batch.libraryCitationForEntity`), so a Pathfinder 2e campaign with a dnd5e book installed could ground, offer and CAST cross-system content. Row 207 closes that seam with ONE optional `system` on the creature pool (`listLibraryCreatures(system)`, filtered by the OWNING BOOK's system) plus `system` in the search options; the spell-corpus rule above is UNCHANGED, and the global Rules page / bestiary browser / wiki-link publisher remain deliberately unscoped |


### 2.2 LLM (`src/llm`)

| To do X | Use Y | NOT Z |
|---|---|---|
| One JSON-contract chat call | `openrouter.chat` with `responseFormat: schemaResponseFormat(zodSchema)` (`strictSchema.ts`) | hand-written `response_format`; the ONLY downgrade to `'json'` is the Settings `strictOutputs` toggle (default ON) — never automatic |
| zod → JSON Schema | `strictSchema.strictJsonSchema` / `schemaResponseFormat` — read the strict-subset header first | a private converter |
| Parse a model reply | `jsonReply.parseJsonReply` + the contract's zod `parse`; failure fails the run / pauses for review (AGENTS 3) | catch-and-continue around parsing |
| Model escalation / refusals | `modelFallback.walkModelChain` — UNCONDITIONAL escalation (owner 2026-09-07: "ANY ERROR, ANY AT ALL should lead to the fallback"): every error advances to the next chain entry, the chain is the bound, exhaustion throws the combined `chainError`; only `MissingApiKeyError` and user aborts stop the walk. `failureKind`/`fallbackReasonFor`/`FILTER_PATTERN` classify for the Details view and notice wording — annotation only, never a gate | ad-hoc retry loops; silent model swaps; gating escalation on the failure class again |
| Classify a failed run for the owner | `failureKind.failureKindOf(error)` (`llm/failureKind.ts` — structural over the typed error classes) + the `domain/run` `FAILURE_KIND_LABELS`/`FAILURE_KIND_GUIDANCE` maps; every fail site writes the kind next to the verbatim `errorMessage` (docs/05, ledger 35) | prose-matching the raw message; replacing or truncating the message with the kind |
| Wait for a run | `runEngine.waitForRunStatus` (one primitive; `includePaused` for chain steps) | private poll loops; `TERMINAL_RUN_STATUSES` is the only terminal-status list |
| **Say WHY a run did not finish — THE one way** (ledger 128) | `runEngine.runNotCompletedReason(run, label = 'run')` (`src/llm/runEngine.ts`, beside `isRunWithdrawn` — the file that owns a run's state vocabulary): the engine's own authored `errorMessage` IS the sentence and is returned VERBATIM; only when the engine wrote nothing does the caller's own vocabulary name the fact — `` `${label} ended ${run.status}` ``, `'run'` when the caller has no label. Callers: `features/modules/encounter-map-queue.ts` (both of its "this body must stop" throws: the withdrawn arm and the run that died on its own) and `features/modules/entity-batch.ts` (one batch entity whose run did not complete). `features/campaign/encounterRegen.ts`'s `awaitCompletedRun` is the ONE documented boundary (§5) | re-deriving `run.errorMessage !== '' ? run.errorMessage : \`run ended ${run.status}\`` at a call site (it stood TWICE in one queue function and once in the entity batch, i.e. three spellings of one fallback); re-wording the engine's message into a fragment, or demoting it to a colon-suffixed detail, at a site that has no label of its own; reading this seam as a VERDICT — whether a run's end is reportable at all is `isRunWithdrawn`'s question, and the two must never be folded (ledger 117) |
| **Say WHY a STEP was rejected — THE one way** (docs/17 row 152; the sibling of the row above, and the fix for the sentence that claimed a JSON defect for every refusal) | `llm/rejectionReason.ts` owns the whole idea: `REJECTION_REASONS` (the union, ALSO the source `rejectionReasonSchema` is built from: `'invalid-json' \| 'unresolved-source' \| 'ability-convention' \| 'brief-contract' \| 'escape-debris' \| 'scaffolding-echo'`), `rejectionReasons(step)` / `rejectionIssues(step)` (readers for a refused step's stored output), `rejectedStepOutput(raw, issues, reasons)` (the ONLY constructor for a refused step's output — a class is REQUIRED, an empty list THROWS, so a site cannot record a refusal that cannot say what happened) and `rejectedStepSentence(stepName, step)` (the ONLY composer of the user-visible sentence, called by `runEngine.executeFrom`'s auto-autonomy branch). `REJECTION_CLAUSES` is a `Record<RejectionReason, string>`, so **a class added to the union without a sentence is a COMPILE ERROR** — that is the non-vacuity device, not a review habit. Each class is attached by the site that DECIDED the refusal (the seven `finishStep(..., 'rejected')` sites: draft/stat-block/report parse → `invalid-json`, `encounterSourceIssues` → `unresolved-source`, `statblockSignedAbilityIssues` → `ability-convention`, `runEncounterBrief`'s `evaluate` returning `reasons` beside its issues → `invalid-json` / `unresolved-source` / `brief-contract`, the finalize hygiene scan → `escape-debris` and/or `scaffolding-echo`), and `generatedTextHygiene.generatedTextScanForFields(fields, documentFields?) → { issues, reasons }` reports the classes BESIDE the issues its two halves produce. The class is stored ADDITIVELY and OPTIONALLY inside the refused output (`{ raw, issues, reasons? }`) — no Dexie version (no index reaches into a step's output: `runs` is `'id, campaignId, personaId, status, updatedAt'`), nothing backfilled, and a row with no class renders its own truthful sentence (*"this run row records no rejection class …"*) rather than claiming JSON | the NOT-Z column: **a SECOND CLASSIFIER rebuilt from the stored issue strings** (any regex/keyword pass over `issues`, or a `reasonForIssues()`-shaped helper — the class travels with the issues from the mechanism that produced them, never reconstructed afterwards); a sentence that DEFAULTS to the JSON clause for a class it does not know (the `invalid-json` clause is the ONE class whose wording predates the seam and it is pinned byte-identical); a class recorded WITHOUT a sentence (the `Record` makes it a compile error, and `rejectionReason.test.ts` re-states it at run time); a class silently dropped at one site (a hand-built `{ raw, issues }` output or a `finishStep(..., 'rejected')` that bypasses `rejectedStepOutput` — red by the source-scan pin that counts the seven sites against the seven constructions); a BACKFILLED class on an old row (nothing recorded ⇒ nothing invented, forever); a hand-rolled second sentence composer anywhere in `src/` (the historic clause appears in `llm/rejectionReason.ts` and nowhere else — source-scan pinned); a class stored for a refusal that never reaches a user (module spine/part validation THROWS on the part/module row instead — it has no step sentence and no class) |
| Cancel all in-flight runs | `runEngine.cancelAllActive()` — the engine's controller registry is the authoritative in-flight set (rows → resumable 'cancelled'; paused runs are not stoppable work) | querying `db.runs` for 'running' rows; ad-hoc cancel sweeps |
| Persona run pipelines | `runEngine` step plans per mode (`domain/persona.mode` = generate/review/image/encounter): `retrieve→draft→statblock→finalize`, `gather→check→finalize`, `prompt-draft→generate→pick` (pick ALWAYS pauses), classic encounter `brief→layout→schematic→stylize→pick→finalize` (pick ALWAYS pauses; NO verify step — D14, the user is the judge and Regenerate candidates is the correction) and vision encounter `brief→vision-map→finalize` (docs/11 D19: complex-only, no pick pause — the single map is selected by contract, locate+verify is the gate; the shape re-resolves after the brief stamps its `mapPath` marker) | a bespoke pipeline for a shape that fits an existing plan |
| Image generation | `imageGen.generateImages` — UNCONDITIONAL model-chain escalation on ANY error (typed OpenRouter error envelopes classify structurally); `cappedToOne`/`fallback`/`filteredCount` surface as user-visible step notices; a single-entry chain's failure names the missing fallback config | raw image API calls elsewhere |
| **Generate ONE image and prepare it for storage — THE one way** (ledger 126) | `llm/oneImage.generateOneImage(prompt: ImagePromptDraft, { model, signal })` — owns the prompt-contract assembly (`assembleImagePrompt`), the n=1 call, the empty-result refusal (`NO_IMAGE_FROM_API_MESSAGE`) and the EXIF-safe `imageIntake.intakeImage`; returns `GeneratedOneImage` (`{ blob, mimeType, width, height, prompt, model }` — the intake result PLUS the assembled prompt and the escalation-aware `modelUsed`), which is `NewStoredImage` minus `campaignId`/`source`/`role` and the shape every one-image storage writer takes. Four byte-identical hand-rolled copies became this call (cover queue, entity queue, mob portrait queue, canonical portrait cache); the shape's own repeated type literals read `GeneratedOneImage` now too | re-assembling a draft + calling `generateImages(…, 1, …)` + re-checking `images[0]` + calling `intakeImage` at a call site (four copies drifted into a fifth wording of "the API gave us nothing" with the refusal pinned zero times); passing `n` — the seam is n=1 by construction, and candidate-choice paths are a different question |
| **Image generation with a CANDIDATE COUNT (the owner picks)** — deliberately NOT the seam above | `imageGen.generateImages(prompt, n, …)` stays the entry point for the two paths that answer "how many, and which one wins": `runEngine`'s persona generate step (`n: 2` + the pick step, `:5336`) and the encounter map's `unattended ? 1 : 2` pair (`:4705`, intake `{ role: 'map' }`). `runEngine`'s vision-map step (`:4491`) is a third boundary: a raw `buildLabeledMapPrompt` string (the documented text-render carve-out — no draft to assemble), a `{ role: 'map' }` intake, and it reaches the client through `encounterRunAdapters`, the indirection the run/map pins spy on — so it keeps its own sentence, which names the consequence the owner sees | routing a candidate-count path through `generateOneImage` (the seam takes no `n` on purpose); folding `:4491` for the wording alone (it would bypass `encounterRunAdapters` and lose the map consequence — §4) |
| Monster stat lookups | `monsterResolve.resolveMonsterEntryWithRepos`; fighter shapes via `db/fighterStats.ts` (`fighterStatsFromArtifact`, `buildFighterStatsLookup`) | re-parsing `statBlock` ad hoc |
| **What a roster row's reference, its box and its TREASURE are — ONE formatter, both exporters** (docs/17 rows 144 and 159, docs/11 §Monster sources) | `domain/encounterResolve.rosterReferenceFor(entry, resolved, target?)` — THE one rule for what a roster row prints: the TRUE origin of a `rulebook` citation (`Bestiary p.132`, from the resolved origin the pre-pass already produces), the NAMED missing-ref reason of a citation nothing can satisfy, `see <name>` (+ the row's pdfmake destination) for an `npc-ref`, the no-citation statement for `none`, and NOTHING for `inline` (its own box prints underneath). It returns `{ text, printed, link? }` — `printed` is the line a caller renders and `link` the row a caller links to — so a caller composes RUNS, never words. Its twin `rosterStatBlockFor(entry, resolved)` is THE one rule for WHOSE numbers print (the library chunk's own `statBlock` for a cited creature, the entry's own block for `inline`, `null` for everything else and for a citation the library cannot supply). Both exporters go through them: `lib/modulePdf` (the roster resolution pre-pass fills `ModulePdfInput.rosterResolution`, `referenceRun` styles the run, `statBoxContent` with an optional source attribution prints the box) and `lib/pdfExport` (`resolveExportRoster` is the same pre-pass for the single-artifact GM export, `rosterRows` renders the same reference and the same box). Its THIRD answer, added by docs/17 row 159, is `rosterTreasureFor(entry)` — the TREASURE a roster row prints: `{ text, printed }` (the label `Treasure: ` composed HERE, in `TREASURE_LABEL`) for a mob that carries something, and **`null` for one that carries nothing**, so the emptiness decision and the printed line live in ONE place. Every roster-printing surface reads it: `lib/modulePdf`'s encounter section (a `muted` line under the mob's own name, **GM-only** — `player ? null : …`) and its treasure ledger `treasureLedger` (one row per carrying mob, labelled `<encounter> · <mob> ×count` so a GM sees WHICH creature holds what and which fight it belongs to), `lib/pdfExport.rosterRows` (a NODE of its own, **never appended to the roster line** — the reference printed beside the name is the other exporter's own pinned string), and the reader's `features/campaign/components/monster-source.tsx` (`data-testid="roster-treasure"`). The encounter's OWN `treasure` field is a different thing and keeps its own line in the section, in the single-artifact export and in the ledger — the two sources are NEVER merged. Nothing is materialized: the citation keeps its `chunkId` + identity and the render reads the chunk AT EXPORT TIME | a second formatter, or a caller composing its own separator or `see ` (two callers did exactly that: `modulePdf.rosterOriginRun` printed the constant `' (see Bestiary)'` — a chapter the module book has never had — and `pdfExport`'s encounter case printed no reference at all); printing an empty or placeholder box for a citation whose `chunk.statBlock` is `null` (best-effort ingest parse — the named missing-ref line stands alone); writing a resolved block or origin onto the row (a citation is a CITATION, docs/12 §Storage); a second stat renderer beside `modulePdf.statBoxContent` (it is the ONE box, printing traits, actions, REACTIONS, legendary and `extras`); **a SECOND roster-treasure formatter** (the line composed at a call site, or a caller reading `monster.treasure` and building `Treasure: ` itself — a source scan in `tests/lib/roster-reference-parity.test.ts` holds `modulePdf`, `pdfExport` and `monster-source` to `rosterTreasureFor` and free of the label, of `monster.treasure` and of `entry.treasure`); **per-mob treasure reaching the PLAYER document** (it is a GM checklist exactly like the encounter's own field: the section's line is audience-guarded and the ledger is GM-only — no per-mob treasure in the player book, ever); **treasure merged into ONE unlabelled string** (the encounter's own line and each mob's are separate lines and separate ledger rows, and every mob row NAMES its carrier); **a label standing over a blank value** (`rosterTreasureFor`'s `null` is the ONE emptiness rule — no empty line, no empty cell); **a SECOND LEDGER** (the single-artifact GM export grows none: the back matter belongs to the module book); **folding the surfaces that are NOT roster rows into this seam** (the editor textarea is the WRITER of the field, `db/battleSeed` is storage that freezes it onto tokens, and the GM token card and the canvas chat's details block render the frozen token / a prompt-shaped line of their own — docs/17 row 159 says why each is left alone) |
| Rulebook citation identity (chunk-hash-fallback; the BOOK half is docs/17 row 155) | the rulebook `monsterSource` carries additive optional `contentHash` + `creatureName` + `bookTitle` (`domain/artifact.ts`; the authored-npc `creatureRef` mirror is `domain/creature.ts`); EVERY birth stamps them through the pure `contentIdentityFor` (`domain/encounterResolve.ts`) — runEngine finalize (both remap sites, via `rulebookSourceFor`, which throws loud on a vanished chunk), the editor rulebook-link dialog (`monster-source`, the book title riding the search hit), the spawn picker (`buildMobPickEntry`) and the module generator's cast (`entity-batch.libraryCitationForEntity`, folded into the same constructor) — and `bookTitle` is OMITTED when unknown (never stored empty: a surface must be able to tell "not recorded" from a title). The two readings of a book's title are deliberately ONE pair in the same module: `citationBookTitle(book)` (the STAMP — `undefined` when there is no row or its title is blank) and `rulebookDisplayTitle(book)` (the LABEL — `Rulebook` stand-in), so the banner and `creatureOriginLabel` cannot name different books; `resolveMonsterEntry` falls back to `getChunkByContentHash` on a uuid miss (exact hash only — same creature/new version stays `missing ref`; L1 deferred, docs/11); `collectDependencies` carries a dangling entry's own stamp onto its `missing-chunk` citation (chunk wins when present) so re-exports stay L0-clearable | stamping citations uuid-only; a same-creature fuzzy match at resolve; healing chunkIds to local rows; a second citation constructor (the cast site WAS one — a hand-written copy of the shape, which is exactly why it missed the stamp); storing an empty `bookTitle` as a placeholder; a second title reading beside these two |
| Monster level → sort key | `encounterRoster.parseLevelSort` | a second level parser — the module creator's window reads it too, over the chunk's own `statBlock.level` (docs/17 row 114) |
| **Show a prompt the creatures it may name** (docs/17 row 114, docs/12 §7; the pack titles amended by docs/17 row 163) | `llm/creatorRoster.collectCreatorRoster(targetLevel?)` — builds the creator's window from `db/creatureRepo.listLibraryCreatures()` (the SAME pool the cast resolves against: every stat-block chunk, ANY book origin), orders it with the SHARED `encounterRoster.libraryLevelOrder` (level distance to the module's band midpoint, ties by levelSort then locale name, `"—"` last) and caps it at `CREATOR_ROSTER_LIMIT = 300` with the `(roster truncated; N more)` note; **each line is `Name — Pack Title`** (`CREATOR_ROSTER_TITLE_SEPARATOR`, the ONE shape, rendered by `creatorRosterLine`), the title being the one the LIBRARY records for that creature — read through the ONE stamping read `domain/encounterResolve.citationBookTitle(await getRulebook(bookId))` from the `bookId` the pool carries on the row, ONE read per BOOK the window covers (never per line), and a creature whose library records NO title prints its NAME ALONE; `moduleGen.spineMessages` is the ONE caller (its target is the module's `(levelMin + levelMax) / 2`) and hands the window to `promptStyles.spineContractValues`, which appends the rule plus the listing to the entity-kind clause. Recomputed per run, never persisted | a pack-only window (the encounter roster's own filter — it would be EMPTY for a rulebook-built library while the slot stayed on offer, i.e. the owner's defect with a different trigger); **a second pool reader** (the window is ONE of `listLibraryCreatures`' three call sites, held by the source pin in `tests/features/entity-batch-creature-book.test.ts`); a second chunk read to find a level (the pool carries the `statBlock`) or to find a book (it carries the `bookId`); **a title taken from anywhere but the LIBRARY** (the slot's `book` is a hint the model may have localised — nothing but the book row may produce a title); **the LABEL reading's placeholder title** (`rulebookDisplayTitle`'s `Rulebook` stand-in is right for a surface that MUST name a book; in a window the model copies it becomes a fabricated pack); **a title printed for a creature whose library records none** (no separator, no empty dash, no `Unknown`); **dropping a name — or reordering the list — to pay for the titles** (the titles are appended to the line, and the name list's order and content are pinned unchanged); a second level parser; a private comparator; a slot offered without its vocabulary; a persisted or cached window. **AMENDED BY REFERENCE (docs/17 row 207): the window is also SYSTEM-SCOPED.** `collectCreatorRoster(targetLevel?, system?, …)` passes the campaign's system to the ONE pool read (`listLibraryCreatures(system)`, filtered by the OWNING BOOK's system), and `features/modules/entity-batch.libraryCitationForEntity` passes the SAME value — so the vocabulary the spine prompt shows and the cast that judges the answer are one scoped population, and a Pathfinder 2e module can neither be offered nor cast a dnd5e creature. The UI/wiki-link callers (`bestiary/roster`, `app/use-library-creatures`, `db/creatureRepo.wikiLinkCreatures`) deliberately pass NO system — pinned by `tests/bestiary/roster.test.ts` and `tests/llm/creatorRoster.test.ts` |
| **Turn a cast refusal into a NEXT STEP** (docs/17 row 114) | `llm/creatorRoster.nearestLibraryCreatures(wanted, pool, limit = 3)` over `domain/creatureName.creatureNameSimilarity` (token overlap or normalized edit similarity — case, whitespace, umlauts/diacritics, hyphen-vs-space and a trailing `(…)` qualifier all normalized away), rendered with the library's own book labels by `features/modules/entity-batch`'s no-such-creature refusal, and ONLY there. Below `CREATURE_SUGGESTION_FLOOR = 0.4` the list is EMPTY and the pre-114 sentence stands, byte for byte. The STRICT tier keeps its own shape and now shares the ONE comparable form: `sameCreatureName` is `artifactAlias.comparableName` (canonical composition, trim, case-fold — ledger 162), and the LOOSE `normalizeCreatureName` folds NFC/NFD for free because NFKD decomposes first whatever the input's composition was. **Ledger 166 routed the RESOLUTION itself through it** — `features/modules/entity-batch.libraryCitationForEntity`'s pool filter was the last hand-rolled name comparison in `src/` and is `sameCreatureName(creature.name, wanted)` now, so the exact-match arm this whole tier rests on (`sameName`: a near miss still fails, a different diacritic is still a different creature) is the SAME comparable form the tier states, and a DECOMPOSED slot name resolves a COMPOSED library name | fuzzy RESOLUTION of any kind (that is `sameName`'s exact match, unchanged — a near miss still fails); auto-substituting the nearest creature; widening `sameName`; rendering a suggestion when nothing is close (a second wrong answer is worse than none); a SECOND comparable form for the creature tier (a hand-rolled `left.trim().toLowerCase() === right.trim().toLowerCase()` beside it — that is the pre-162 spelling, and it silently failed a Mac-authored NFD name); **the RESOLUTION's own lookup spelled by hand** — `libraryCitationForEntity`'s pool filter was exactly that spelling until ledger 166, and it is now red by the source scan rather than by a reader who noticed; a locale-aware case fold for matching |
| Bestiary/item pack data | `ingest/packFetch` (only networked surface; newest-first with pinned-verified-ref fallback) → `packImport` → `packs/registry` adapters | fetching upstream files anywhere else; adapters stay network-free (test-pinned) |
| PF2e rules text (journal pages, conditions, feats/spells/actions corpus) | the same pack lane, third entry type: rules-text fetch sources (`packFetch`, `packDirs`-scoped) → `packImport` `sections` → `packs/pf2e-journal` / `pf2e-conditions` / `pf2e-rules` adapters → `section` chunks with per-entry Source lines; a `type: 'spell'` document ADDITIONALLY carries a validated `spellData` payload and lands a `spell` chunk (docs/12 §15.4, ledger 181) | HTML scraping (there is none — the machine-readable packs are the one way; docs/12 §15); a second retrieval path — `encounterRoster` skips `section` AND `spell` chunks like `item` chunks; a second spell parser or a second text renderer (the structured half rides the existing mapping, text byte-identical); expecting the Rules browser's existing type filter to surface `spell` chunks — it has no `Spells` entry until the follow-up UI slice (docs/12 §15.4), so this DATA landing renders nothing |
| **Read a pack DATA file's documents** — THE one ingest document-parser seam (docs/17 row 147) | `packs/text.parseJsonDocs(text, fileName)` (whole-file JSON, else NDJSON one document per line) and `packs/text.parseYamlDocs(text, fileName)` (`loadAll`, one document per `---`), both in `src/ingest/packs/text.ts` beside `htmlToText`. Seven call sites, two helpers, no adapter with a parser of its own. **The rule is the JSON family's own invariant, made true for YAML: a stream that yields NO document at all is a LOUD file-level failure (`<file>: no YAML document`), and a document that parses to `null` is RETURNED and counted as a SKIP** — never a failure, never nothing. **AMENDED by docs/17 row 171:** a top-level ARRAY is a document STREAM in BOTH families — the seam unwraps it ONE level (JSON whole-file, and YAML too, because MEASURED `loadAll('- a\n- b\n')` is ONE document, not N), a document's own array FIELDS are untouched, an empty top-level array throws `<file>: top-level array holds no documents` instead of resolving `[]`, and "this parsed value is a document" is the ONE exported `text.isDocumentRecord` all seven lanes import — the seven private `isRecord` copies are gone, and its `!Array.isArray` arm is the other half of the unwrap rule. The loud half exists because the two YAML bodies used to disagree: a comment-only file returned `[]` from one adapter and came back through `packImport.ts` as `{entries: 0, skipped: 0, failures: []}`, i.e. accounted NOWHERE (AGENTS rule 1), pinned by nothing | the NOT-Z column: **a per-adapter document parser** — no `JSON.parse`, no js-yaml `loadAll`, no `function parseDocs` and no `from 'js-yaml'` import anywhere under `src/ingest/packs/` but `text.ts`, red by the SOURCE SCAN in `tests/ingest/packs/parse-docs.test.ts`; **a silent empty result** — `docs.filter((doc) => doc != null)` in the YAML helper (that filter IS the silent-drop defect) or dropping the `docs.length === 0` check, both red by the ACCOUNTING pins in the same file, which assert `entries`/`items`/`sections`/`skipped`/`failures` TOGETHER rather than only the throw; a whitespace-only file that does not fail loudly; a **second** document-dialect helper in an adapter file (a THIRD dialect is a legitimate new seam — it belongs in `text.ts` beside these two, never in an adapter); **a second document-record predicate or a second array unwrap** — no `function isRecord`, `isRecord(` or `Array.isArray` outside `text.ts`, red by the row-171 SOURCE SCAN in `tests/ingest/packs/parse-docs.test.ts`, which also requires each of the seven lanes to import `isDocumentRecord` and non-vacuously counts the seam's three `Array.isArray` sites |
| **Turn a pack document's HTML into the stored plain `text`** — THE one ingest HTML→text seam (docs/17 rows 143, 149 and 170) | `packs/text.htmlToText(html, style)` in `src/ingest/packs/text.ts`, which is ALSO the ingest layer's DOCUMENT-conventions home (`parseJsonDocs`/`parseYamlDocs` are its second and third occupants, docs/17 row 147 — AMENDED BY REFERENCE: that row landed the parsers and left `publicationSourceLine` deliberately unfolded, with a differential pin instead). TWO styles are DECLARED AS DATA in that one file and named for what they DO (docs/17 row 149 deleted the third, `AT_LABEL_LAST_LINE_BREAKS`, whose repaired behaviour was byte-identical to the second): `BRACKET_LINKS_LINE_BREAKS` (the dnd5e DIALECT — `[[…]]{L}` / `[[…\|l]]` / a label-less `[[…]]` → nothing / `&reference[…]` CASE-INSENSITIVELY (row 170: the corpus spells it `&amp;Reference`), then the shared brace rule, then the target's last segment; line breaks only, because NO dnd5e fixture carries table markup) and `AT_BRACE_LABEL_BLOCK_AND_TABLE` (the `@`-notation rule — `@Type[…]{Label}` → `Label` FIRST, then the BRACKET-BALANCED `@Type[…]` scan: the default is the target's last dotted segment (`@Type[a.b.C\|…]` → `C`), while TWO KINDS carry more than a target and each drops BY RULE (row 170) — `@Embed[<target> <space-separated options>…]` keeps the first whitespace-delimited token and drops the option list, because the options configure HOW the embed renders and carry no prose, and `@Damage[<formula>[<type>,…]]` keeps the formula verbatim and drops the damage-TYPE sets, because they are machine descriptors; block-and-table aware). **The brace rule is ONE helper (`resolveBraceLabels`) that both notations apply — the dialect prelude stays the dnd5e grammar's own, so the two grammars are SHARED-rule compatible, never merged.** Eight call sites across seven adapters, two styles, no site with a body of its own; a new adapter PICKS a declared style by name. **AMENDED by ledger 181: NINE call sites — `pf2e-rules` gained a second, to this SAME seam, for its heightening-note segments (docs/12 §15); still ONE stripper.** **The bytes are load-bearing**: the return value becomes `PackEntry.text` → the chunk's stored `text` → `contentHash = sha256Hex(text)` (stamped at import in `packImport.ts`, at citation birth in `encounterResolve.ts`), `resolveMonsterEntry` resolves by uuid then by EXACT hash, and an unresolvable citation BLOCKS a bundle export (`exportDependencies.ts` / `exportImport.ts` throws `MissingDependenciesError`). **Row 143 folded the seven copies BYTE-PRESERVING; row 149 then CHANGED the bytes on purpose** — a description now stores its resolved brace label and a PF2e item its table cells — **and row 170 changed them again for exactly the three notation residues row 149 had recorded** (`@Embed`'s dropped option list in `dnd5e-equipment/bag-of-beans`, the resolved case-insensitive `&Reference[prone]` in `dnd5e/saber-toothed-tiger`, the kept nested-bracket `@Damage` formula in `pf2e-rules/acid-splash`: one entry per affected lane) — and the accepted consequence, the owner's decision recorded in row 143, is that a citation stored against the old text reads the NAMED `missing ref (<creature>)` after a re-import: **re-import the pack, then re-pick the creature** (no rebind tool, no migration, no contentHash re-stamp). That sentence is shown in the app on the pack-import report (`pack-import-rereimport-note`), and the emitted bytes of every lane are pinned per lane in `tests/ingest/packs/html-to-text.test.ts` | a per-adapter strip helper (seven copies had drifted into two block conventions and THREE notation dialects; the copies are GONE — `grep` finds no `function stripHtml/stripDescription/stripJournalHtml` in the directory); a second tag-stripping regex, entity table or `@`-notation resolver anywhere under `src/ingest/packs/` — the SOURCE SCAN in `tests/ingest/packs/html-to-text.test.ts` reds it with the file and the shape named; an `HtmlToTextStyle` literal or a `blockAware` mention in an adapter file (a new style is a behaviour change, not a local choice); a behaviour change here without the re-import story (docs/17 rows 149 and 170 own it: the brace residue and the table collapse were FIXED by 149, the three notation residues by 170, the accepted `missing ref (<creature>)` outcome is the owner's decision, and the instruction — re-import the pack, then re-pick the creature — is on the pack-import report); **the WRONG fix for the `@Embed` option list** — a whitespace split of EVERY `@`-notation target: a legitimate UUID target contains spaces (`Compendium.pf2e.spells-srd.Item.Peaceful Rest`, `Compendium.pf2e.other-effects.Item.Effect: Aid`, both in fixtures), so the split is scoped to the `@Embed` KIND and the `space inside a uuid target` differential case reds a generic one; **a `@Damage` formula resolved by the last-dotted-segment rule** (it would split inside the formula's own `@item.level` shorthand and store the old `level/2))[persistent,acid]` fragment — the `nested-bracket damage formula` case reds it); **a SECOND stripper** (a per-adapter strip helper again, or a second tag-stripping regex, entity table or `@`-notation resolver outside `text.ts`); **a dialect MERGED BY ACCIDENT** — the dnd5e prelude (`[[…]]`, `&reference[…]`) resolving under the `@`-notation style, or the `@`-notation brace rule being re-spelled inside `bracket-links` instead of shared with it: the two notations are separate grammars that share ONE helper, and a pin asserts the prelude resolves nothing in the other style; **a paragraph convention at INGEST** — blank-line paragraphs belong to the RENDER-time seam (`lib/textBlocks`, docs/17 row 146), and emitting them here would change the hash of every stored chunk for a job the reader already does; **a lane changed without a decision** — every adapter's emitted text is pinned as a per-lane digest with its PRE-row-149 value beside it, so an unchanged lane is asserted as unchanged and a changed lane must be NAMED in row 149 or 170 (row 143's `AT_LABEL_LAST_LINE_BREAKS` is retired-and-reachable: no adapter may name it, and the notation must stay in `text.ts` so the old bytes remain statable) |
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
| Per-room challenge budgets | **The policy (docs/17 row 180): `domain/encounterBudget.ts` is the ONE home of `EncounterBudgetPolicy` (`'system' \| 'pf2e-budget' \| 'verbatim'`), `defaultEncounterBudgetPolicy(system)` and `resolveEncounterBudgetPolicy(module)`; `roomBudget.encounterBudgetFor(policy, system)` resolves it ONCE into the run's `EncounterBudget` (`{policy, mode, scale, repairUnder}`), threaded by `runEngine` to the Cartographer brief, the per-room check, the stocking cap, repopulate/finalize and the in-place fill — no call site re-derives a mode from the system, and a module's stamped row value decides every later run. A pf2e module defaults to `'pf2e-budget'` (Campaigner's OWN `2 × party level` approximation, `repairUnder` true), every other system to `'system'`; a row without the field reads `'system'` (legacy, byte-identical); `'verbatim'` keeps the no-numbers licensing stance. `encounterPartyLevel` is the ONE party-level resolver the roster WINDOW and the Cartographer brief share.** **The module DIFFICULTY (docs/17 row 190) is the SIBLING of that policy, not a second version of it: `domain/moduleDifficulty.ts` is the ONE home of the five steps (`much-easier`…`much-harder`, middle `normal`), `MODULE_DIFFICULTY_LABELS`, `difficultyBudgetMultiplier` (`0.5/0.75/1/1.5/2`) and `resolveModuleDifficulty(module)` (absent/null → `normal`); `EncounterBudget` carries the resolved `difficulty` beside `policy`, and `roomBudgetBandUpperFor` — the ONE function that computes a room's standard-encounter number for BOTH scales — multiplies its base by the difficulty multiplier, so the 'over' verdict, `expectedRoomThreat`, the stocking cap and `fillGradeStockingFor`'s stated numbers all move together; `moduleDifficultyGuidanceFor` states the step (and, off normal, the SCALED band) in the Cartographer brief, while under `'verbatim'` no number is computed at all so difficulty is a DIRECTION only (the licensing stance is untouched).** `roomBudget.ts` (`checkRoomBudget`, `expectedRoomThreat`, `reconcileRoomAssignments`, `roomBudgetGuidanceFor`, `fillGradeStockingFor`, `parseBudgetLevel` over `encounterRoster.parseLevelSort`) — the loop: over-band rooms lower a step through the brief's single repair turn, then LOUD advisory on step output + `data.budgetAdvisory`; complexes additionally carry the `fillGrade` stocking expectation (`src/domain/artifact.ts` — additive optional, drawn once by `drawFillGrade` when a complex first materializes with the field absent, owner value always wins) giving the lower verdicts — 'empty' (repairable on fresh complex briefs) and 'under' (advisory) — while single arenas keep "a quiet room is a feature" byte-identical; the Cartographer's stocking clauses + bounded roster EXPANSION are SHAPE-gated (`encounterDataIsComplex` — the parse-normalized `siteShape`, docs/11 D12 amendment) and key on the regeneration target's ACTUAL shape, never the remembered `preset` (a legacy complex row whose persisted preset is 'standard' still restocks; the preset keeps the grid tier/prose — D10 untouched): prefix verbatim, appended entries source-cited, cap = Σ room expectations + margin, append a DIRECTIVE for complex-shaped targets ("must append") and a permissive "MAY" for non-complex targets on a dungeon preset, prompt and evaluate gate sharing ONE authorization flag; a never-mapped target (layout null — the Smith stub) briefs unpinned-fresh whenever the contract authorizes (the MUST-style fresh-population clause + numbers + `freshCapped` cap, 1-room replies a repairable shape issue, finalize persisting the whole roster via the `freshPopulation` brief marker, the fixed-cast section threaded into the unpinned brief) while never-mapped singles keep the verbatim pin byte-identical and a pf2e module keeps it only under its recorded `'verbatim'`/legacy `'system'` policy (docs/17 row 180); re-sizing a roster against the grade rides the D18 two-button surface only (`features/campaign/encounterRegen`: Repopulate = roster-only pass, Regenerate everything = fresh full run — no standalone one-fight content button exists); the in-place fill packs unclaimed entries by nearest-band fit (round-robin fallback without expectations) | a second level parser; a second shape predicate beside `normalizeEncounterShapeData`; gating the stocking clauses on the remembered preset instead of the target's shape (the legacy-row trap); embedding Paizo's encounter-budget tables in code (docs/12 §13.2/§14) — the `'pf2e-budget'` path must use `pf2eStandardThreatLevels` (Campaigner's own `2 × party level` approximation) and persist `PF2E_APPROXIMATION_ADVISORY`; applying the dnd5e `T + 2` band to pf2e (the licensing/system boundary); returning null from `expectedRoomThreat` for a BAND-mode budget; redrawing a persisted fillGrade; **a SECOND difficulty enum or a hand-spelled difficulty multiplier beside `domain/moduleDifficulty` (the ladder is ONE map, applied in ONE place — `tests/architecture/module-difficulty-seam.test.ts`); a second budget formula that scales for difficulty outside `roomBudgetBandUpperFor`; embedding Paizo/DMG numbers to express a difficulty step; applying a numeric multiplier under `'verbatim'` (no numbers exist there — it is a DIRECTION only); an editable-after-creation difficulty control in this slice** |
| Structured encounter level context (party of 4 at the part's level) | `llm/roomBudget.ts` (`PARTY_SIZE = 4` — the ONE party-size constant, `partyLevelLine`, `partLevelForMention`: first part in plan order whose markdown carries the encounter's `[[Name]]` mention supplies its `levelBand` as the EXACT level, multi-level bands parse to the low end, premise-only/unmentioned/unparseable ⇒ undefined with the free-text chain underneath) — the Smith draft carries it via `buildEntityBrief` (`features/modules/persona-request.ts`, encounter + npc stubs per `stubKindCarriesPartyLevel`, resolved in `entity-batch.ts` at the excerpt position) and the Cartographer brief via `runEncounterBrief` (module lookup through the target's `moduleId`); `fillGradeStockingFor`'s `promptLevel` and the roster WINDOW both resolve through the SAME `encounterPartyLevel(module, name, levelHint)` (part mention first, `parseRosterTargetLevel(levelHint/brief)` as fallback) — docs/17 row 180 folded the two resolvers so they can never disagree for one encounter; the fixed cast rides the same seam (`fixedCastForEncounter` + `fixedCastSectionFor`: drafted npc-kind scene members pinned must-appear into the encounter brief, brief-time derivation from in-batch results + module text, never stored; encounters detail last via post-generation `orderedKinds`) | a second part-lookup implementation; a second party-size literal; band math over a part's levelBand; a second party-level resolver for the roster window (`encounterPartyLevel` is the ONE — docs/17 row 180); applying the module-creation Party exclusion (ledger 69) here — encounter difficulty is about LEVELS, not players, and the npc-only cast filter is not a party exclusion |
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
| Reject half-formed unicode escapes in generated text | `lib/encodingHygiene.findEscapeDebris` (pure: `?` + exactly 2 lowercase hex forming a non-ASCII tail, plus literal `\uXXXX` in decoded text) + `debrisIssuesForFields`/`collectTextLeaves` at the boundaries — `runEngine.runFinalize` scans the draft + statblock strings BEFORE any create/updateArtifact (hit → loud `rejected` with the debris named, nothing persists), `moduleGen.generatePart` scans normalized part prose before the ready write (hit → part `failed` with the debris named, chain continues). Detection backstop for the `language.ts` UTF-8 contract (prevention). It is one HALF of the ONE persist-boundary scan `llm/generatedTextHygiene.generatedTextScanForFields`, which carries the prompt-scaffolding echo beside it (next row) | silent repair-and-continue; persisting debris as ready content; a second scanner implementation; a boundary that calls this half directly and silently loses the scaffolding half |
| **Reject OUR OWN prompt scaffolding echoed back into generated text** (docs/17 row 142) | `llm/promptScaffolding` — the ONE source of the fixed sentences and section labels every brief and schema-repair prompt is built FROM: the composers render those constants (`features/modules/persona-request`'s `buildEntityBrief`, `llm/runEngine`'s two repair turns, `llm/moduleGen`'s spine/part repair turns, `llm/roomBudget`'s fixed-cast section, `llm/campaignGrounding`'s section header; **plus the entity-INTENT paragraph's two literals, `INTENT_LABEL`/`INTENT_HIERARCHY`, MOVED here from `features/modules/persona-request` by row 145 so the detector can read the bytes the composer renders — importing them the other way would be an import cycle, and the feature imports them back; they are TWO LITERAL markers, never a slotted one, because this marker's slot would be a free-text note that legitimately contains quotes and the slotted form's `[^\n"]+` slot would be silently dead on it**) and `findScaffoldingEcho` matches the SAME constants (full literal only, whitespace reflow tolerated), so a reworded sentence changes what is sent and what is detected in ONE edit — and `tests/llm/scaffoldingEcho.test.ts` pins that the composed brief is itself detected, so a composer that stops reading a constant is caught. ONE boundary scan carries it: `llm/generatedTextHygiene.generatedTextScanForFields(fields, documentFields?)` = escape debris (its historic scope) + this echo, returning `{ issues, reasons }` — **AMENDED BY REFERENCE, docs/17 row 152: the aggregate's name changed (it was `generatedTextIssuesForFields`, which returned the issues alone) because it now reports WHICH of the two classes fired, beside them; same call, same halves, same issue order.** Callers, all before the write: `runEngine.runFinalize` (the effective draft + statblock strings → loud `rejected` step, nothing persists), `moduleGen.parseSpine` (throws into the spine's existing one-repair turn, then the module fails loudly), `moduleGen.generatePart` (the part goes `failed` with the marker named, its markdown never stored), `modulePlan` (section titles), `canvasRefine` (a replacement), `canvasChat`'s two apply seams | stripping the sentence and keeping the rest; a placeholder; a silent skip; a `console.error` without a user-visible surface; a hand-copied second list of marker strings (the list would rot the first time a sentence is reworded); calling `lib/encodingHygiene.debrisIssuesForFields` directly at a boundary (the SCAN pin reds it — the scaffolding half would be dropped); scanning `name`/`aliases`/`tags`/`id` (`documentTextFields` excludes them: link targets and filter metadata, not prose) |
| Decide what an entity detail OWNS, by KIND (the OWNERSHIP BOUNDARY — docs/17 row 140, a RE-REPORT of row 10 with a wider content class) | `buildEntityBrief`'s `kind` parameter (`features/modules/persona-request.ts`) appends ONE paragraph — `OWNERSHIP_BOUNDARY_BY_KIND`, an EXHAUSTIVE `Readonly<Record<StubKind, string \| null>>` so a new entity kind cannot be added without deciding its boundary — for `location`, `event` and `faction` ONLY: the OPPOSITION belongs to the encounter artifact (point at where the fight is, by the name the module text's own wiki-link uses, instead of describing it), no tactics / no encounter-handling advice / no GM guidance on running the fight, `inhabitants` means people and factions and never monsters (location+event; the faction variant names its own fields — goals/methods/resources/ranks — instead), and the case the owner reported: module text written in the encounter's own field vocabulary ("If the party acts", "Secrets", "Outcome") is the ENCOUNTER's material, never restated as this artifact's own detail. The paragraph cites the module prose's own clause (`promptStyles.PARTS_MECHANICS`, one ownership doctrine, not two) and states its reason in ONE clause ("one fact, one owner"). ONE production call site passes the kind (`entity-batch.ts`, whose `kind` IS the entity's kind), so the batch, post-generation's automation, the stub popover's single-entity delegation and the change/refill seam all reach it; `npc`, `encounter`, `note` and every kind-less caller render `null` and keep their exact bytes | the rule in the persona text (`llm/personas/builtins.ts` — DISCRETIONARY and seed-once, §4 gotcha below: it reaches a new install only, which is exactly why row 10's clause reached nobody); filtering or shrinking the context paragraphs (the module text is the ground truth the worker reads — the fix is about what the entity OWNS); a prose classifier or any runtime gate over the generation output (docs/17 row 75; this section's own ban, stated in the module-generation row); a `note` boundary (nobody reported it — decided out of scope); a second brief builder or a per-kind copy of the brief |
| Record what an entity is FOR — the author's INTENT note on the entity record (docs/17 row 141, the owner's *"optional hint parameter … to steer detail building"*, placed on the RECORD after his *"Then that is the right place."*) | ONE additive optional field: `domain/module.moduleEntityKindSchema.intent` (`z.preprocess(null/'' /whitespace → undefined)`, capped at `ENTITY_INTENT_MAX_LENGTH` = 400 with a NAMED loud message). Three spellings of absence (key absent, `null`, `''`) all read as `undefined` — nothing backfilled, no default materialized, no Dexie version bump. Written by the spine planner (`moduleGen.modelEntityKindSchema` carries `intent: absentable(z.string())`, so the emitted contract makes it REQUIRED-nullable — `null` is the planner's "nothing to say") and READ by ONE reader, `domain/module.entityIntentFor`, at ONE production call site (`features/modules/entity-batch.ts`). The cap is enforced where both the model's reply (`entityKindsReplySchema`) and every stored row are parsed: past it the spine parse fails with `entities.0.intent` and the reason, the run's existing retry-then-loud arm takes over (row → `failed` + `toastError`), and NOTHING is truncated. The request itself rides the spine call's SYSTEM MESSAGE (`moduleGen.SPINE_ENTITY_INTENT`, bound interpolated from the same constant), and the note SURVIVES name normalization because `withEntityBestiarySlots` carries it onto the canonical records, refusing loudly by name when two source records answer one canonical with different notes | a hint in the WIKI TOKEN (`[[Name\|hint]]`): the display slot is the ALIAS mechanism normalization depends on, the token is the most-wired seam in the app and every display/export/wiki-strip would have to learn a fourth meaning, the chip prints the raw token to a READER, and a hint belongs to the entity rather than to one mention; a per-mention hint; a second presence rule (the schema's preprocess IS the one spelling of absence); silent truncation at the cap; a default value backfilled onto old rows; reading `intent` anywhere but `entityIntentFor`; putting the request in a style CONTRACT VALUE (it would break the pre-styles spine fixtures' provenance and a user style could edit it away — see §4); the owner-editable field itself (slice B, NOT landed) |
| Deliver the author's intent to the detail worker (docs/17 row 141) | ONE paragraph from `buildEntityBrief`'s additive 9th `intent` parameter (`features/modules/persona-request.ts`): `The module's author intended: <intent>. This steers EMPHASIS and OWNERSHIP; what the module text states is fixed, and your own charter still governs what this kind may contain.` — placed immediately BEFORE the `Additional instruction: …` paragraph (`withAdditionalInstruction`) and AFTER `OWNERSHIP_BOUNDARY_BY_KIND[kind]`, which stays LAST of the body: one form, two sources (the instruction transient, the note persistent). Its hierarchy sentence is load-bearing — a note that outranked the module text would be a second author. NO intent (key absent, `null`, `''`, whitespace) renders nothing, so the brief is the pre-field brief BYTE FOR BYTE; every entity brief passes this ONE seam (the kind-keyed boundary row above, the batch, post-generation's automation, the stub popover's single-entity delegation and the change/refill lane, which re-enters `runEntityBatch` with the module row) | printing the note on any surface a reader sees (the reader chips and their raw-token tooltip, the canvas, the module document, `buildModuleDefinition` and every export — pinned absent); letting it override the module text or the kind's charter; merging it into the `Additional instruction` paragraph or into the ownership boundary; an empty paragraph for an empty note; a second brief builder or a second presence rule |
| **Deliver the author's recorded LEVEL to the entity generators — THE one channel** (owner request, docs/17 row 197) | ONE field on the ENTITY RECORD, beside `intent`: `domain/module.moduleEntityKindSchema.levelHint` (additive optional integer, `ENTITY_LEVEL_HINT_MIN`..`_MAX` = 1..20, absent/`null`/`''` ⇒ `undefined`, malformed ⇒ LOUD by field). Emitted by the SPINE pass only (`moduleGen.modelEntityKindSchema.levelHint`, contract clause `SPINE_ENTITY_LEVEL_HINT` in the spine call's SYSTEM message — never a style contract value); CARRIED onto canonical records by the EXISTING normalization carry `domain/module.withEntityBestiarySlots` (two different levels ⇒ loud); read by ONE reader `domain/module.entityLevelHintFor` (the `sameAliasName` seam, shared with `entityKindFor`/`entityIntentFor`); threaded by `features/modules/entity-batch.runEntityBatch` — read by NAME off `module.entityKinds` (the `entityIntentFor` precedent; NOT a new `EntityBatchTarget` field, which four target-building call sites would have to attach) — into BOTH structured paths: `buildEntityBrief`'s additive 10th `levelHint` parameter (paragraph `ENTITY_LEVEL_HINT_LABEL`/`ENTITY_LEVEL_HINT_HIERARCHY` from `llm/promptScaffolding`, right after the party-level line) and `StartRunInput.entityLevelHint` (persisted on the run row via `domain/run` + `domain/create`, reconstructed by `runEngine.resumeRun`). `runEngine.runStatblock` prefers it over `/level\s*(\d{1,2})/i`, which survives ONLY as the no-hint fallback; a block whose printed level differs gets the step's EXISTING `notice` (`levelHintDeviationNotice`, compared through `encounterRoster.parseLevelSort`). Unmatched hints (name never mentioned in `moduleDocumentText`) are LOUD through `domain/module.unmatchedEntityLevelHints` + `entity-batch.reportUnmatchedEntityLevelHints` and NEVER invent an entity. Visible read-only as the entity panel row's `entity-level-hint` badge | a SECOND top-level `entityHints` array (a second name comparison, cap, normalization carry and "which wins" answer — AGENTS rule 4); extending the `level N` regex instead of a typed field (the regex is the defect, not the fix); a per-kind or per-call-site target field; a silent clamp or truncation of an out-of-range value; a drop of an unmatched hint; a `title`-only or console-only report (rule 2); wiring the encounter generator's own `encounterPartyLevel` in this slice (stated boundary, docs/17 row 197); printing a hint on a reader-facing surface or building the human editing surface (slice B) **AMENDED BY REFERENCE, docs/17 row 206: this row's "THE one channel" described the channel accurately for every path that PASSED it, but it was not ONE read at the generator — the artifact editor's "Regenerate with AI" rebuilt `StartRunInput` from scratch without `entityLevelHint` and silently lost a module-fixed level (the owner's 7 → 13, with NO notice and an unfiltered spell vocabulary). The boundary this slice closes: the resolution is now at ONE ENGINE SEAM — `runStatblock` resolves `input.entityLevelHint ?? context.moduleGrounding?.entityLevelHint`, where `targetModuleGrounding` carries `entityLevelHintFor(module.entityKinds, target.name)` on the stored retrieve step — so EVERY targeted generate run reaches the recorded level however its caller built the input; the brief-text fallback can no longer read the generated party line (`roomBudget.withoutPartyLevelLines`); and a module-owned entity with NO recorded level is LOUD on the step's existing `notice` seam (`moduleLevelHintAbsenceNotice`) instead of silently unconstrained. Row body otherwise untouched.** |
| Bind an encounter to the scene its module text stages (the ASSERTION RULE — docs/11 §The scene is the truth, ledger 89) | FOUR pieces, each encounter-only: (a) the writer's contract clause `PARTS_ENCOUNTER_CASTING` (`llm/promptStyles.ts`) — state what the fight IS and where, a stated count is binding, personal names stay off the rank and file, and the pipeline owns the casting; (b) `SCENE_AUTHORITY_SECTION` (`llm/sceneAuthority.ts`) rendered by `runEngine.runDraft` for `kind === 'encounter'` ONLY and by `runEncounterBrief` — the scene states nothing ⇒ design freely; (c) `buildEntityBrief`'s additive `encounterScene` framing (`features/modules/persona-request.ts`, set true by the encounter path in `entity-batch.ts` only) — the surrounding text becomes "The scene this encounter must stage"; (d) the additive optional `substitutions` on BOTH roster contracts (`encounterDraftSchema`, `encounterGeneratorBriefSchema`, `llm/schemas.ts` — absent/null = none declared) read through `sceneAuthority.sceneSubstitutionsOf` and surfaced by `roomBudget.substitutionAdvisories` on the EXISTING `data.budgetAdvisory` + step-notice seam, at all four encounter finalize seams | editing the built-in encounter persona text (`llm/personas/builtins.ts` — personas are user-editable stored rows, so the change would never reach an app that already exists); a "is the prose specific enough?" threshold, a prose classifier or any runtime gate over the prose (§4 gotcha); rendering the section for non-encounter kinds (their prompts are byte-identical, exact-bytes pinned); a SECOND advisory surface beside `data.budgetAdvisory`; silently swapping a stated creature for a generic equivalent (the whole point of `substitutions`); a prose-vs-roster checker that guesses beyond what the model declares |

| Validate a MODEL-AUTHORED inline stat block's `level` (ledger 90, docs/11 §D5 amendment) | `runEngine.statBlockLevelIssues` — the app's one level parser (`llm/encounterRoster.parseLevelSort`: number, fraction `"1/2"`, or `"—"`) as the spec, wired into `encounterSourceIssues` so BOTH model boundaries (the Smith draft and the Cartographer brief) get the existing one-repair-then-loud path, plus the independent refuse in `materializeMonsterNpc` before it writes an artifact row; the prompt's `statBlockSchemaHint` DESCRIBES the field (`"level": the creature's printed level — a number ("3"), a fraction ("1/2"), or "—"`) | tightening `domain/statblock.ts` (it is the READ boundary for the blank editor form's `level: ''` and for PDF best-effort chunks — §4); a second level grammar beside `parseLevelSort`; coercing or defaulting the value; dropping the monster |
| Enumerate what the portrait batch acts on (ledger 90, docs/11 §D5 amendment) | `features/campaign/mob-portrait-queue.enumerateBatchKinds` — ONE enumeration for the read-only count (`planMobPortraitBatch`), the additive batch (`enqueueMobPortraits` + `enqueueInventedCreaturePortraits`) and both regen paths, routing EVERY roster participant by what its creature IS: chunk-backed (`rulebook`, or `npc-ref` → an artifact with `data.monsterChunkId`) shares the bestiary portrait deduped by artifact; anything else (`inline`/`none`, `npc-ref` → an artifact WITHOUT the marker) is a LOCAL job with NO `chunkId` | reading `source.type` as the routing rule (an `npc-ref` row matched neither lane — the owner's materialized monster was invisible to the batch); handing a `chunkId` to a local job (that is the only thing that can reach the global `mobPortraits` cache); enumerating into a second, divergent list for the surface |
| Record WHICH MODEL wrote a text or an image (owner request, docs/17 row 93) | The WRITE SITE records the `modelUsed` its own call returned: `writerModel` on the artifact row (`domain/artifact.artifactBaseShape` — additive `.default('')`, no Dexie version bump), on the module row's `spine` and on EACH part (`domain/module.moduleSpineSchema` / `modulePartSchema`), and the pre-existing `storedImageSchema.model` for images. Recording seams: `runEngine.runDraft` step output → every finalize create/refill (+ `materializeMonsterNpc`'s run-level id), `db/mobArtifacts.materializeInventedCreatureArtifact` (the ENCOUNTER row's id — no call runs there), `moduleGen.runSpine` / `generatePart` (each including its repair turn), `db/moduleRepo.patchModulePartText` (rides through from the canvas chat/refine writers), `features/modules/canvas/{chatTurn,chatController,snapshotChat,CanvasPage}` for chat-applied and accepted-proposal text (the chat apply itself rides `chatTurn.runCanvasChatTurn`; ledger 150). Display: ONE rule `domain/provenance.recordedWritingModel` (trim; `''`/null ⇒ NOT RECORDED ⇒ render NOTHING) and ONE component `components/writer-model-id.WriterModelId`, mounted by the peek modal (card text + image banner), the module reader (premise + each part, BOTH premise branches — the generated reader and the spine checkpoint), the canvas preview (a caption under each part's rendered text) plus the canvas footer strip `features/modules/canvas/canvas-writer-model.CanvasWriterModel` (which summarises `domain/provenance.moduleWritingSummary`: one id when the premise and every part agree, the per-scope list — including `not recorded` — when they differ), the image lightbox / cover hero / campaign card art, and `play/artifact-cards.NpcCard`/`EncounterCard` behind the explicit `showWriterModel` opt-in | a settings lookup (`settings.defaultChatModel` names the model we ASKED, not the one that SERVED — §4); backfilling or guessing an id for a row written before the field (nothing recorded ⇒ nothing on screen, forever); letting the field reach a model: it is never INPUT to a prompt or a contract (the spine's emitted schema is `.omit({ writerModel: true })`, because a `.default('')` field comes out REQUIRED in the strict subset and would force the decoder to invent an id); rendering it in an export (§4); a second display rule or a per-surface caption component; putting a caption INSIDE the canvas document — that text is the module text (persisted to the parts and re-sent to models), so a canvas caption reads the SAVED ROWS and renders as a sibling of the text, never in it (§4) |
| **Decide whether module text is MACHINE-written or a person's — the consent gate** (docs/17 row 113, amending fix-01's `edited`-based rule) | ONE recorded field and ONE test: `domain/module.textOriginSchema` (`'human' | 'model'`) is the additive, nullable, parse-on-read `origin` on the module `spine` AND on each `ModulePart` (no Dexie version bump — a pre-field row parses to `null`), and `domain/provenance.textOriginIsMachineWritten(origin)` is the ONLY authorship test any consumer may call (`origin === 'model'` and nothing else; `null`/`undefined`/`'human'` all mean a person's text, which is the conservative legacy default). The origin is STAMPED at the ONE part-text seam `moduleRepo.patchModulePartText`, which already receives the identity of whoever writes: supplying a `writerModel` is the machine-write signature (`writerModel === undefined ? 'human' : 'model'`) — every canvas/chat apply path supplies one (`canvas/saveDoc.ts`, `CanvasPage`'s apply, `canvas/chatTurn.ts` — the ONE turn controller both surfaces call, ledger 150) and a hand save omits it. For the premise (which has no part save seam) the two production writers stamp it themselves: `moduleGen.normalizeAndSave` writes `origin: 'model'` on the generated spine it saves, and the checkpoint's `approveSpineAndRun` reads the STORED row and stamps `'human'` only when the approved premise text differs — so clicking through the checkpoint claims nothing. Both stamps ride `domain/provenance.carriedTextOrigin` for the cases that must PRESERVE a previous origin (the parts pass's generating/failed/pending slots). Read through `features/modules/module-problems` (`modulePartWriterLabel` / `moduleTextWriterLabel` / `heldRewriteSummary` / `heldRewritesBanner`) so a surface renders the writer the ROW names — "You wrote this part." / "The model `id` wrote this part." / "This part was written by hand (or before the app recorded authorship)." | reading `ModulePart.edited` as authorship (it means "written outside the generator" and is stamped on EVERY write through the seam, including model text the canvas auto-accepted — that reading is exactly the owner's bug); deriving the origin from a stored `writerModel` (a hand edit CARRIES the previous model id forward, row 93, so the id cannot answer "who wrote this now"); a heuristic or backfill for a pre-field row (nothing recorded ⇒ it reads as the person's and keeps asking, forever); the model answering for itself (`spineReplySchema` `.omit({ origin: true, writerModel: true })`); a prompt that asserts authorship a row cannot support (§4) |
| Decide what mob-portrait work a roster holds, and which lane a creature rides (docs/17 rows 90/96, AMENDED by row 165) | `features/campaign/mob-portrait-participants` — ONE home for the batch's rules: `rosterParticipantRoute` (lane by what a row's creature IS, never by the shape of its `source`: a row that CITES a library creature — a `rulebook` citation, or an `npc-ref` to a row carrying a `creatureRef` (the cast creature, docs/11 D3) — shares the one bestiary portrait; `inline`/`none` is a LOCAL job with no `chunkId`; an `npc-ref` to a hand-authored npc rides the `authored` lane and is illustrated on its OWN cover; a dangling `npc-ref` is the first-class `missing-ref` verdict the queue throws on). **The identity a lane keys on is NOT derived here**: `rosterParticipantRoute` calls `domain/creature.rosterEntryCreatureIdentity(entry, linked)`, the SAME one rule `db/battleSeed` stamps its battle tokens with (row 165), so a token's `creatureKey` and the key this route's job writes the portrait under are one string by construction. The art reading is not derived here either: `encounterNeedsMobPortraitWork(encounter, artifacts, presentationByKey?)` asks `db/creatureRepo.creaturePortraitImageIn` over the rows its caller holds — the SAME function the battle board renders each token with — so "this creature is imaged", "the board shows its portrait" and "the batch skips it" are one statement (a caller with no presentation snapshot passes none and gets the documented conservative "work" answer). Read by the queue's own enumeration (`enumerateBatchKinds` → `planMobPortraitBatch` / `enqueueMobPortraits` / `enqueueInventedCreaturePortraits` / both regen paths) AND by the module-level gap detector (`post-generation.encountersNeedingMobPortraits`, hence both "Resume automatic module creation" and the entity sidebar's "Generate everything"), so the offer and the work walk ONE rule | a second reading of `monsterSource.type` or of `coverImageId`/`imageIds` in any surface (the module path's private rulebook-only predicate is exactly how the owner's materialized core creatures became invisible and the "Generate everything" control disappeared — §4); **a second creature-identity rule** (the key is born in `rosterEntryCreatureIdentity` and NOWHERE else: the seeder and this file construct none — a source scan in `tests/db/creature-identity-spelling.test.ts` holds that); **a surface that renders a different portrait reading than the predicate asks** (the board drew its token art from the token's ARTIFACT cover while everything else asked the identity — the owner's "no portrait on the battle map" report; §4); a FALLBACK lookup for a key that missed (the ONE reading's order IS the rule); a per-surface art rule of its own; gating a lane on the roster's SHAPE (`rulebookCount === 0`); reading the module ROW's automation fields where the run has an explicit target (the portrait block did, so the target's promise ran empty — §4); a second chunk→artifact or invented-creature scan instead of the identity seam |
| Represent an ability value (ONE representation: d20 SCORES — docs/12 §5, ledger 95) | `domain/statblock` owns the whole convention: `abilityScoreFromModifier` (the ONE modifier→score conversion, `10 + 2·mod` — the pack importer's and the stat-block editor's), `printsAbilityModifiers(system)` (the ONE per-system switch) and `formatAbilityValue(system, score)` (the shared card's display: PF2e prints the signed BONUS only, every other system `score (bonus)`; the two PDF stat boxes compose the same predicate with their own compact layout). The MODEL boundary states the convention in `runEngine.statBlockSchemaHint` and refuses a SIGNED ability value through `runEngine.statBlockSignedAbilityIssues` — wired into `encounterSourceIssues` (Smith draft + Cartographer brief, both on the reply's RAW pre-coercion `monsters` array) and into the statblock step's own reply — as a NAMED issue on the existing one-repair-then-loud path; the editor's PF2e field edits the printed bonus and states the conversion on screen | a second modifier→score conversion (the importer's own `10 + 2·mod`); a per-surface display branch of its own; reading `+2` as a score anywhere; tightening `domain/statblock.ts` (the READ boundary — §4); a plausibility heuristic for the UNSIGNED case (§4) |
| **Answer the chat's request for an artifact's stored details — READ ONLY** (docs/17 row 103; the write half is row 101's seam and does NOT exist here) | `llm/canvasChat`: the assistant may emit `<request><name>EXACT NAME</name></request>` (≤ `MAX_REQUESTS_PER_REPLY` = 5 per reply), parsed by the SAME `parseCanvasChatReply` strict extractor as `<edit>` — one left-to-right walk over both tags, so malformed/unbalanced/over-cap fails the WHOLE reply (`CanvasChatParseError`). The answer is `resolveChatDetailsRequests({ requests, moduleId, pool })` over `loadChatDetailsPool(campaignId)` (the campaign's artifacts + the shared library — the chips' own pool), resolving each name through the EXISTING `lib/wikilinks.resolveWikiLink(name, pool, { moduleId })` (chip parity, including the ambiguity candidate list) and rendering the STORED row per kind (`renderArtifactDetails` / `artifactDetailLines`; roster stats via `monsterResolve.resolveMonsterEntryWithRepos`, a loud `stats: MISSING — …` when a citation does not resolve). The block rides ONE follow-up call per user turn — `buildCanvasChatDetailsPayload` (+ `canvasChatTurnContent`'s `details` arm) puts the model's asking reply and the app's `<requested-details>` turn (header `REQUESTED_DETAILS_HEADER`, contract `CANVAS_CHAT_DETAILS_INSTRUCTION`, roles kept alternating via `DETAILS_ANSWER_TURN`) into the SAME payload shape, refusals included as named verdicts (`NO SUCH ARTIFACT` / `AMBIGUOUS NAME` / `NOTHING STORED ON THE ROW`); the cap is `MAX_DETAILS_BLOCK_CHARS` with a LOUD `[TRUNCATED — …]` / `[BLOCK FULL — …]` marker, never a silent trim. A request in the FOLLOW-UP reply comes back as `ignoredRequests` — no third call ever | pre-supplying every artifact's details unconditionally (the owner's own hesitation: "maybe not unconditionally"); a kind-discriminated request or a second name resolver/pool (resolution IS `resolveWikiLink`); letting a request write anything (details change through `features/modules/change-artifact.changeArtifact`, row 101); answering from the row's summary, the module text or the model's own guess; a loop/retry until the details arrive; a silent trim or a partial block with no marker; a catch-and-continue around the follow-up parse (it is surfaced as a loud `failed` result while reply 1's work stands) |
| **Change an artifact from the CHAT** (docs/17 row 104 — the write half behind the read half above, so it supersedes that row's "the write half … does NOT exist here" parenthetical) | `llm/canvasChat`'s change half + `features/modules/canvas/chatChanges`: the assistant may emit `<change operation="repopulate\|everything"><name>EXACT NAME</name><instruction>…</instruction></change>` (≤ `MAX_CHANGES_PER_REPLY` = 3 per reply), parsed by the SAME `parseCanvasChatReply` strict extractor in the SAME one left-to-right walk as `<edit>`/`<request>` — a malformed block (unknown attribute, duplicated or invented `operation`, wrong children, empty name/instruction, unterminated) or an over-cap reply fails the WHOLE reply with NOTHING executed. Names resolve through the SAME `lib/wikilinks.resolveWikiLink(name, pool, { moduleId })` the chips and the read half use (`llm/canvasChat.resolveChatArtifactName`, ONE `loadChatDetailsPool` per turn); an unresolved/ambiguous name is a NAMED refusal carrying the resolver's own candidates — the app never guesses which row to OVERWRITE. `operation` is REQUIRED for an encounter and refused by name for every other kind, and there is NO default (`repopulate` restocks, prose untouched; `everything` regenerates the encounter with its prose, and never sets the editor's own `redesignProse` checkbox). Each change runs SEQUENTIALLY (one at a time, in reply order) through the ONE seam (`features/modules/change-artifact.changeArtifact`, row 101) with the resolved row's id + the instruction + the operation; the CHAT PATH itself writes NO row. Since each change is a real generation, the turn HANDS THE MODULE SLOT OVER for the phase (`llm/canvasBusy` is not re-entrant — §4) and a slot another generation holds is a named `MODULE BUSY` outcome, never a silent skip. The outcomes (`changed` / `refused` / `unsupported` / `unresolved` / `ambiguous` / `busy` / `failed`) ride the SAME one follow-up call the read half established, as a `<change-results>` block (`renderChangeResults` + `CHANGE_RESULTS_HEADER` + `CANVAS_CHAT_CHANGES_INSTRUCTION` through `buildCanvasChatFollowUpPayload`; every non-applied verdict reads `NOT APPLIED: <VERDICT>` with the asked-for instruction echoed), and a `<change>` in THAT reply is `ignoredChanges` — never a third call. The OWNER sees each outcome the moment it settles (`chatChanges.reportChatChangeOutcome`: a loud toast naming the artifact, its kind, the operation and the instruction, plus a progress-dock job `Changing «<name>»` linked to the row; the `failed` copy never claims nothing changed) in BOTH flows (`chatController` + `snapshotChat`). Recovery invents nothing: `updateArtifact` recorded a NEW revision with the previous one intact, restorable from the artifact editor's existing revision list (`restoreRevision`) | a chat-side or per-surface row writer (no provenance, no per-kind brief, no creature-row guard, no busy gate); a second command tag vocabulary, or a regex-guessed block; a default encounter operation; a silent newest-wins pick on an ambiguous name; running the changes in parallel; a second follow-up call; `catch`-and-continue around a change outcome (a specialist failure is a named `failed` outcome the model reads AND a loud owner toast); reading an abort as a change; a new rollback/undo mechanism beside the revision list |
| **Change any artifact from an instruction — THE one way** (docs/17 row 101) | `features/modules/change-artifact.changeArtifact({ artifactId, instruction?, encounter? })` — resolves the row and routes BY `artifact.kind` (never by a caller-declared kind): `encounter` → `features/campaign/encounterRegen` with the REQUIRED `encounter.operation` (`'repopulate'` / `'everything'` — genuinely different operations, and the second replaces the layout and map, so the destructive one is never a default) plus the existing `redesignProse` / `dungeonMapPath`; `npc` / `location` / `event` / `faction` / `note` → `features/modules/entity-batch.runEntityBatch` with a per-target `artifactId`, i.e. ONE target filled IN PLACE through `runEngine`'s refill (identity, links and images preserved; `writerModel` + the `persona` revision recorded), never a second row of the same name. The instruction rides the specialist's BRIEF in the ONE `Additional instruction: …` form (`llm/additionalInstruction` — the same form `runEngine`'s four render sites now use), so it persists on the run row's `userBrief` and survives a resume; empty/omitted renders no paragraph and leaves every brief byte-identical. Uniform semantics, not new ones: the EXISTING `llm/canvasBusy` one-generation-per-module gate is claimed for the change and released in `finally` (loud `ModuleBusyError`); failures THROW (a specialist error, an incomplete run with the specialist's own reason, a vanished campaign/module); the seam's own declines are returned as a discriminated result (`changed` with its `operation` / `refused` with its `reason` / `unsupported` with its `reason`, every arm carrying `artifactId` + `kind`) so no caller string-matches. REFUSED: a rulebook-cited creature row (`isMobArtifact` → `creature-row-guard.creatureRowAiRefusal` — a RATIFIED owner boundary, docs/17 row 101: never rewritable by instruction, nothing written, no engine called) and a module-less entity row (no module text to ground in). UNSUPPORTED: `pc` (the Party is authored) and `plotarc` (not a module entity kind). | a chat-side or per-surface writer that edits artifact rows itself (a second writer with no provenance, no per-kind brief, no creature-row guard, no busy gate); a `changeX` per kind or per surface; routing on a kind the CALLER declares; a per-kind instruction form; a required non-empty instruction (the editor's buttons have none — a canned one would change the prompts they have always sent); a default encounter operation; catching a specialist failure to return a `failed` status (failures throw, so a caller cannot ignore one); re-deriving a brief, a persona or a run wait inside the seam instead of calling the specialist |
| **Reconcile a module row a DEAD page left at `status: 'generating'`** (docs/17 row 110) | `llm/moduleGenReconcile.reconcileInterruptedModuleGens()` — called from `AppShell`'s mount effect (app START: a discarded tab RELOADS, so start is the load-bearing moment) and on the way back into a backgrounded tab (`onPageResumed`). Ownership is decided by ONE guard, `isModuleGenClaimed(id)` = `moduleGen.hasLiveModuleGen(id)` (this page's controller registry) OR a held generation lock (`lib/generationLocks.isGenerationLockHeld(moduleGenLockName(id))`, the cross-tab lease), and it is re-evaluated INSIDE the write transaction (`moduleRepo.failInterruptedModuleGen` takes the predicate). The write is LOUD and never a silent reset: `'failed'` + `INTERRUPTED_MODULE_GEN_MESSAGE` (a named sentence that also names the recovery control), every part slot still at `'generating'` rewound to `'pending'` — which is exactly the state the EXISTING `moduleGen.generateMissingParts` recovers from — and the batch entry point toasts the count | treating a persisted `'generating'` as PROOF that somebody is writing; a silent reset to `'draft'` (the owner must be told what happened and what to press); touching a row a live controller or another tab owns; re-deriving the rewind or the message at a second call site (ONE constant, ONE transaction); reconciling RUNS on `visibilitychange` — a hidden tab is still running its engine, and failing those rows would invent the very defect this seam removes |
| **Stop a module generation — the ONE behaviour behind every Stop control** (docs/17 row 110) | `llm/moduleGenReconcile.stopModuleGeneration(id)` returns what actually happened and each outcome ends in something the owner can SEE: a live controller in THIS page → `cancelModuleGen(id)` (a real abort, `'cancelled'`); another tab holds the generation lock → nothing stopped, nothing failed, a toast naming the other tab (`'elsewhere'`); nobody owns the row → `reconcileInterruptedModuleGen(id)` (`'reconciled'`); the row already settled → a toast saying so (`'idle'`). `features/progress/stop-all-generations` asks the same guard and reports `{ stopped, reconciled }`, counting a reconciled row as a SEPARATE number and never as work the sweep stopped | a bare `cancelModuleGen` from a Stop control (on a row no live controller owns it is `controllers.get(id)?.abort()` — a silent no-op, which is the defect the seam closes); reconciling a row another tab is generating; counting a dead row as "stopped" and toasting that it was stopped; letting `stopped === 0` claim "Nothing was running" while a dead row was reconciled |
| **Measure a stream watchdog against LIVENESS, and report only a limit that was ARMED** (docs/17 row 110) | `lib/pageLiveness`: `installPageLiveness()` (auto-installed on `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`) records the SUSPENDED GAPS, and `activeElapsedMs(from, to)` is wall time minus those gaps. `llm/openrouter.readStream` computes all three watchdog deltas through it, records `trippedLimit` when it actually calls `reader.cancel()`, and the post-loop diagnosis throws ONLY that limit — otherwise the accumulated text is the answer | `Date.now()` deltas in the watchdog OR in the post-loop diagnosis (a hidden/frozen page's gap then reads as silence and a healthy stream is cancelled; worse, the diagnosis ran after a CLEAN `done` close and discarded complete answers); loosening a limit to compensate (a genuinely dead stream must still fail on the same numbers); re-deriving the failure from elapsed time after the loop instead of asking what the watchdog DID; treating a cancelled stream as an error while keeping its partial text as if it were complete |
| **Wait for a run to leave `'running'`** (docs/17 row 110) | `runRepo.waitForRunRowChange(runId, known, signal)` — a Dexie `liveQuery` over the ONE run row, resolving on any change (including rows written by another tab's run) or when the row disappears — wrapped by `runEngine.waitForRunStatus` (which loops: read the row, check abort/terminal/paused, then await the change) | a `setTimeout` poll (250 ms chained ticks are a PACING bug: Chromium throttles a hidden page's timers to ~1/minute, so a chain or batch step boundary can idle for a minute); resolving on a write that is not terminal; dropping the `AbortError` or the "Run … disappeared while waiting for it to finish" contract (both are preserved to the character and pinned) |
| **Refill an existing artifact in place** (a persona run with `targetArtifactId` — the artifact editor's "Generate/Regenerate with AI", the persona panel's targeted run) | `runEngine.startRun({ targetArtifactId })`: the pipeline runs normally, `runFinalize` merges through the ONE `mergeRefillData(kind, draftData, target)` and writes with `updateArtifact` (which parses `anyArtifactSchema` — the write seam that makes a bad merge a loud failure, never a silent row). A refill target's OWN shape decides steps: a target that cites a library creature (`isCastCreatureNpc`, read through `npcCreatureRef`) is NEVER asked for a stat block — the step finishes `'skipped'` naming the citation, before the model call (docs/11 §A cited row's REFILL, ledger 112). `mergeRefillData` REFUSES, by name, a draft that carries a stat block for a cited row | a step plan that asks a cited row for stats because the draft said they matter; a merge that silently prefers one side of an exclusive pair (drop the block or drop the citation); pre-filtering the draft contract by kind instead of deciding at the step |
| **Refine a plain-text Idea Board document — ONE chat call, no module protocol** (docs/21, docs/17 row 173) | `llm/ideaBoard.refineIdeaBoard(board, instruction, signal)` — the board's WHOLE contract, and it is deliberately NOT `canvasChat`: that protocol splits a parts document, grounds on the campaign premise and prior modules, resolves wiki-links and replies with `<edit>`/`<request>`/`<change>` commands that mutate artifacts, none of which a board has. Here ONE `chat` call carries a system prompt stating the surface's rules (ordinary text, NO wiki-links or app markup; answer in `reply`; the COMPLETE resulting text in `document` when asked to write, else `null`), the stored transcript as history, and a final `{ document, instruction }` JSON turn; the reply is `parseJsonReply` + `ideaBoardReplySchema.parse` and the returned `modelUsed` is the escalation winner (provenance, never a settings lookup). Grounded on the document AS OF SEND TIME, so typing during a request is never sent and never clobbered. EVERY failure is loud and named: an empty instruction throws before any call, a non-JSON reply fails the parse, a whitespace-only replacement is refused BY NAME (the strict decoder strips `minLength`, so the parsed value is checked), and the shared `generatedTextScanForFields` refuses escape debris or our own scaffolding echoed back BEFORE the text can be accepted. It also returns the text as a PROPOSAL — the engine never writes the document | reusing `llm/canvasChat` (its whole vocabulary is module-shaped — see docs/21 §What it is NOT); a second transport or a private `fetch`; applying the reply to the document inside the engine (the owner's explicit accept, `replaceIdeaDocument`, is the only model-write path); a hardcoded model id (unset board model falls back to `settings.defaultChatModel`); a `catch`-and-continue around the parse or the hygiene scan; treating a user abort as an error |
| **Give an AI-authored mob spells, ground them in the REAL library, and refuse an invented name LOUDLY** (docs/17 row 184) | `domain/mobSpells.mobSpellChips(spells, casterLevel, index)` is the ONE assignment resolver — it decides which library spell a name means and which rank to ask about, and every VALUE comes from `domain/spellHeightening.spellAtRank` (the ONE heightening rule; a cantrip is never given a rank, it is handed the caster level; a FOCUS spell is the same — docs/17 row 191 — with the creature's own fixed `autoHeightenLevel`, when the importer carried one, riding the assignment). **Ledger 194 adds the dnd5e assignment shape to the SAME resolver and the SAME chip:** an assignment carries `casterLevel`/`characterLevel` (the creature's own `cantripLevel(spell)`, resolved by the importer) beside `castRank`, and for a resolved `dnd5e` payload those are handed to the rule as the cantrip progression's input while the MOB's printed level is NOT (a 5e stat block's level is a challenge rating); the chip's `system` field decides the noun (`rank` for PF2e, `level` for dnd5e) and its detail prints the source's `upcastProse` verbatim — no second resolver, no second chip, no cross-system level `llm/mobSpellPrompt.formatMobSpellSection` composes the ONE vocabulary section (from the bounded `mobSpellVocabulary`, rendered only when the corpus is non-empty so spell-less prompts keep their bytes), `llm/mobSpellPrompt.formatMobSpellContractClause` composes the reply contract's own `"spells"` clause from the SAME `llm/promptScaffolding.MOB_SPELL_ENTRY_SHAPE` and the SAME corpus gate (docs/17 row 200 — so a prompt can never invite a field its "COMPLETE schema" line omits), `runEngine.statBlockSchemaHint` renders it in EVERY inline stat-block shape, and `runEngine.statblockSpellIssues` / `encounterSpellIssues` turn the chips into `mobSpellIssues` sentences naming the spell AND the mob; the THREE lanes are the NPC stat-block step, an encounter draft's inline blocks, and (docs/17 row 200) the Cartographer's brief — each spends ONE repair turn on its own offenders (`llm/promptScaffolding.MOB_SPELL_REPAIR_LEAD_IN`), then the entry is STORED so its chip renders UNRESOLVED and the step carries a loud notice. **Ledger 201 adds the caster CLAUSE to the SAME composer** (`llm/mobSpellPrompt.formatMobSpellCasterClause`, its literal `llm/promptScaffolding.MOB_SPELL_CASTER_CLAUSE`, the SAME `mobSpellVocabularyRenders` gate), rendered by the NPC lane's DRAFT and STAT-BLOCK steps only — the encounter draft and the Cartographer keep the OPTIONAL invitation | a second heightening computation anywhere (no caller chooses a cantrip's rank, adds a delta or picks a `fixed` layer); dropping an unresolvable name (it must stay as an unresolved chip + a named issue — the owner's no-invention policy); rejecting the whole stat block over one spell (a good mob would be lost, and the policy asks for a chip, not a refusal); a repair message that does not name the offenders; a spell vocabulary rendered for a system with no imported spells (it would change every dnd5e prompt's bytes); a hand-written `spells` entry shape or `"spells"` contract clause at a call site (`tests/architecture/one-spells-shape.test.ts` reds the JSON-quoted `"castRank"` shape outside `llm/statBlockContract` by file, and any `"spells":` literal in `runEngine.ts`); **ONE system's assignment keys demanded of another** (docs/17 row 205) — the REQUEST contract is per system (`llm/statBlockContract.statBlockSchemaFor(system, spellCorpus)`, `spellEntryShape(system)`, `statBlockResponseFormat(system, spellCorpus)`) and every spell-bearing lane goes through it, while `domain/statblock.statBlockSchema` stays the SUPERSET for the parse boundary; `tests/llm/stat-block-contract.test.ts` is the differential (the two emitted `spells` items must DIFFER) plus the population pins (`statBlockResponseFormat(` once, `encounterDraftSchemaFor(` once, `encounterGeneratorBriefSchemaFor(` once, `schemaResponseFormat` left only for the two stat-block-less contracts), and **reporting a stray cross-system field as "a spell it cannot use"** (it is a WARNING on the chip's own `warnings` channel, never an `issues` entry, so it cannot spend the repair turn — `mobSpellWarnings`/`mob-spell-warnings`; the one `ignore`-tolerance lives in `domain/mobSpells.foreignAssignmentWarnings`, and no surface may promote a warning to an issue) |

### 2.3 App & UI

| To do X | Use Y | NOT Z |
|---|---|---|
| Build a route path | `app/routes.ts`: `ROUTES` patterns + the `*Path()` builders | hand-writing `/c/...` strings |
| **Render a chip** (docs/17 row 182) | `components/chip.Chip` — THE one chip ELEMENT (`CHIP_BASE` shape, a `tone` class string, the button's own props). The resolved-kind tone vocabulary (`KIND_CHIP_CLASSES`) and the unresolved tone (`CHIP_UNRESOLVED`) live in that one module; consumers are `features/campaign/components/wiki-markdown` (resolved + unresolved wiki chips, folded onto it) and `features/spells/SpellsPage` (spell chips). A caller passes a TONE and behaviour and never re-spells the shape | a second hand-styled pill — `tests/architecture/one-chip-element.test.ts` (a SOURCE SCAN) reds a re-spelled base class or kind colour by file; reusing `WikiMarkdown` as a LIST renderer (the spell list is not markdown); a chip variant enum in the shared module (the wiki side already has two declared tones and the spell list a third) |
| **Render a mob's spells as chips, at the rank the mob casts them** (docs/17 row 184) | `components/spell-chip.SpellChip` — THE one spell chip (the resolved indigo tone, the `CHIP_UNRESOLVED` dashed state with the name still visible, the `spell-chip`/`spell-chip-unresolved` testids), used by BOTH `features/spells/SpellsPage` and `features/spells/mob-spell-chips.MobSpellChips`; that component owns the live corpus read and renders one chip per `domain/mobSpells.mobSpellChipDetail(chip)` — the SAME bytes the PDF prints, naming the rule that derived the rank (`cantrip-auto` / `focus-auto`, docs/17 rows 183/191) — with every issue below LOUDLY, and (docs/17 row 205) every WARNING below QUIETLY in its own `mob-spell-warnings` box: the chip's `warnings` channel means a stored field that does not apply to the spell's system, while `issues` keeps meaning unusable/unresolvable and stays the repair trigger. The request contract that produced those assignments is per system (`llm/statBlockContract`), never the stored superset. `features/campaign/components/stat-block.StatBlockCard` is the ONE stat-block card, so mounting it there reaches the NPC card, the module reader, the encounter editor, the bestiary and the battle table at once; the PDF half is `lib/modulePdf.spellBoxSection` (exported), rendered by `statBoxContent` and `lib/pdfExport.statBlockSection` from the same chips | a second hand-styled spell pill (`tests/architecture/one-spell-chip.test.ts` reds a re-spelled tone by file); a chip that hides, blanks or resolves an unresolved name; a second detail composer (the chip's `title` and the printed line must be the same bytes); a spell section that renders for a legacy block with no `spells` key (it must render exactly as before — no chips, no error); a PDF build that silently omits a block's spells (a direct `buildModulePdfDocument` caller with no index prints a loud line instead) |
| **Make an AI-authored NPC come out as a CASTER — the clause at BOTH steps, and the caster's own numbers** (docs/17 row 201) | `llm/mobSpellPrompt.formatMobSpellCasterClause(vocabulary)` is the ONE caster clause, its bytes declared once in `llm/promptScaffolding.MOB_SPELL_CASTER_CLAUSE`, sharing `mobSpellVocabularyRenders`' corpus gate with the vocabulary so a spell-less prompt gets NEITHER. It reaches BOTH NPC steps — `runEngine.runDraft`'s npc arm (identity/prose) and `runStatblock` (spells + numbers) — and NO other lane (the encounter draft and the Cartographer keep their optional invitation; pinned by pre-arc goldens). `domain/statblock` gains the additive nullable `spellDC` / `spellAttack` / `tradition` (numeric strings coerced; `tradition` is a free string, never an enum) plus `statBlockIsCaster` / `statBlockStatesNoSpellDc` / `casterStatLine`; the ONE line renders on the ONE `StatBlockCard` and in both PDF stat boxes through `lib/modulePdf.casterBoxSection`. NEVER INVENTED: a caster that states no DC prints `SPELL_DC_MISSING_MARKER` (*"this caster states no spell DC"*), never a number derived from its level. A caster's cantrip still auto-heightens through the ONE `domain/spellHeightening.spellAtRank` from the block's printed level (a level-7 caster's cantrip is rank 4); an unknown level stays a loud issue | a THEME or SCHOOL filter on the vocabulary (owner: a spell that merely SOUNDS necromantic is fine); a second caster clause or a per-lane copy (`tests/architecture/one-spells-shape.test.ts` reds `Caster awareness` outside `promptScaffolding` and counts exactly TWO `formatMobSpellCasterClause(` call sites); a DERIVED or defaulted spell DC (a caster with none must be LOUD — AGENTS rule 1); a caster flag on `npcDraftSchema` (the module's own paragraphs + intent already ride `input.brief` into both steps — measured, docs/17 row 201); a caster line for a mundane/legacy block (the helpers return `null`/`[]`); touching `spellAtRank` (rows 183/191/194) |
| Save a renderer-built file to disk (backup, campaign/artifact export, artifact PDF) | `lib/filePicker.openSaveTarget` — THE one way to save files: acquire the `SaveTarget` inside the click handler BEFORE the slow build, `target.write(blob)` after; picker cancel = silent no-op (no build, no toast), picker failure = loud `toastError`; `BACKUP_TYPES` / `EXPORT_JSON_TYPES` / `EXPORT_ZIP_TYPES` / `EXPORT_PDF_TYPES` are the one picker-type registry | `downloadBlob` from UI code (the no-picker fallback lives INSIDE `openSaveTarget` only); build-then-pick ordering (the picker needs transient user activation) |
| **Build a filename stem** (ledger 130) | `lib/fileSlug.fileSlug(name, fallback = 'artifact')` — THE one way to turn a title into a URL-safe stem: lower-cased, every run of characters outside `[a-z0-9]` collapsed to ONE `-`, leading/trailing dashes trimmed, `fallback` when the input reduces to nothing. It was hand-rolled FOUR times (`lib/exportImport.ts`'s `sanitize`, `lib/pdfExport.ts`'s `pdfFileName`, `features/campaign/components/export-single-artifact.ts`'s `artifactSlug`, `features/modules/module-pdf-button.tsx`'s `modulePdfFileName` — the first three character-identical apart from their names, the fourth differing only in its fallback), and each of the five surviving call sites passes its fallback EXPLICITLY (`'artifact'` for the four artifact/campaign-shaped names, `'module'` for a module title) so every emitted filename is byte-identical to the pre-fold output. **The SUFFIX is NOT part of this seam and must not be merged:** `pdfExport.pdfFileName` appends a PDF TEMPLATE name (`gm-notes`/`handout`), `modulePdfFileName` appends an AUDIENCE word (`gm`/`player`), and the export callers append `-<date>.<json\|zip>` — those are three different questions (`docs/17` row 130), and a "unification" onto one suffix would change an emitted filename | a fourth hand-rolled slug (the audit's four were the whole population: the idiom `[^a-z0-9]+ → '-'` plus the dash trim exists nowhere else in `src/`, and the seam's scan reds if a caller names that alphabet or re-derives either half); reading the fallback from the seam's default at a call site; folding the two PDF naming ROLES together |
| **Say WHICH packs and creatures a campaign is missing** (docs/17 row 155; docs/12 §8) | `features/campaign/components/missing-refs-banner.tsx` (the live `useLiveQuery` over the campaign's encounter artifacts, resolved entry by entry through `db/monsterResolve.resolveMonsterEntryWithRepos`) + `missing-refs-summary.missingRefsSummary(strands)` — THE one sentence: the count it always carried, then `Missing: A, B (+N more).` (deduped case-insensitively, ordered by the locale of that comparison key, bounded by `MISSING_REF_NAME_CAP` with the exact remainder), then the pack (`The missing pack is «X».` / `The missing packs are …` + `N of M citations does not record which pack it was written from.`) or, when none is recorded, `The pack was not recorded when this citation was written.` (the `Rules` link stays `/rules` — the Rules page serves no filter or deep-link seam). WHAT it names comes from the resolver's structured `missingRef {creature, bookTitle}`, composed TOGETHER with the `missing ref (…)` label by `domain/encounterResolve.missingRefReason` so label and field cannot disagree; a strand that names no creature is still COUNTED and said (`N of them names no creature.`). Everything is re-derived every render: nothing is persisted, so installing the pack clears the banner | a pack guessed from a creature's name (or from any registry cross-check) — an unrecorded pack is stated as unrecorded; a second citation constructor feeding the report (the stamp has ONE writer seam, above); a banner that reports the COUNT only (the owner's report); a persisted gap list driving the display (a second, staler answer that cannot clear itself — measured, not built); parsing the `missing ref (X)` label to recover the creature |
| **Say whether a fetch recipe is already in the library** (docs/17 row 210) | `features/rules/pack-import-state.packSourceImportState(source, recipe, adapter.system, summaries)` — THE one identity derivation, pure over row 204's live book read (`features/rules/hooks.useRulebookSummaries`: book rows + the live spell lane). Candidates are THIS source's ready pack books (`origin === 'pack' && status === 'ready' && packMeta.sourceId === source.adapterId`); the keys are, in order, the fetch PROVENANCE (`packMeta.sourceUrl` = `https://github.com/<owner>/<repo>/tree/<ref>/<recipeId>`, so the recipe id is the URL's tail inside the source's repo) and the TITLE fallback (`domain/artifactAlias.comparableName(book.title) === comparableName(recipe.label)` — a manual import has no provenance). One proven match is `imported` (with which key matched and the live lane counts); ZERO proven matches with a letters-and-digits lookalike title is `unidentified`; two or more are `ambiguous`; either reads UNKNOWN, never a pick, and an unanswered read (`summaries === undefined`) is its own `library-loading` state so the card can never say "not imported" before the library answers. The Settings card renders it (state line, `Re-import` label, the system-mismatch line naming Rules → "Set system") | the NOT-Z column: **a stored "imported" flag or a `packMeta`-only answer** (goes stale the moment a book is renamed, deleted or re-imported in another tab — the invisible state the owner reported); a second matching implementation (a `packSourceImportState` call-site scan pins the seam + the card); `via`/`systemMismatch` re-derived at the card; showing "not imported" for a lookalike or while the read is unanswered; showing a lane breakdown for an ambiguous match; a SECOND lane formatter (row 204's `formatPackLanes` over `bookPackLaneCounts`, live spell lane included, is reused — its call-site scan counts the card twice); a disabled `Re-import` (re-import is the documented remedy for a pre-spells-arc book, docs/12 §15.4) |
| Surface an error | `lib/toast.ts` (`toastError`/`toastErrorPersistent`), a failed run row with `errorMessage`, or the global boundary (`app/GlobalErrorBoundary` + `lib/globalErrors.installGlobalErrorHandlers`) — HUMANIZE-AT-THE-SEAM: a ZodError's `.message` is the raw `[{code,path,message}...]` array, so it is never rendered verbatim; the seam formats it via `lib/zodErrorSummary` (counted, grouped by table, first 3 + "and N more", version-skew mitigation; names never invented — issues carry no input values), keeps the leading title untouched (plain-Error copy passes byte-identical), and logs the full raw error to the console (one click away, never megabytes in the toast). Import failures append the same mitigation via `lib/exportImport.withImportMitigation`; `MissingDependenciesError.message` itself reads as numbered steps. **A PERSISTENT notice carries a real dismiss control** (ledger 136): `toastErrorPersistent` asks sonner for its close button PER TOAST (`closeButton: true`), because `duration: Infinity` means only the user can clear it; the `<Toaster>` sets NO global `closeButton`, so transient toasts keep no closer. Dismissal destroys no evidence — the reason also lives on the console record and/or the failed run row. | `console.error` only (AGENTS 2); rendering `error.message` of a ZodError-shaped failure into a toast description |
| Long-running progress | `lib/progress.useProgressStore` + the app-wide `<ProgressDock/>`; queue jobs report via `dockGroup` | a disabled button or a "Generating…" label (00-OVERVIEW, binding) |
| State why a control cannot act | `components/blocked-control.BlockedControl` — THE one way: it wraps the control so the WRAPPER is the Tooltip trigger (a natively `disabled` form control fires no pointer events, and every shadcn Button adds `disabled:pointer-events-none`, so the control itself can never be hovered), it is focusable (`tabIndex=0`) while blocked so the reason opens on focus, and it renders the same sentence into a visually hidden node pointed at with `aria-describedby` (docs/05 §Why a control cannot act; one reason per state, naming the way out). **The wrapper's `reason` is the ONLY home of a reason** (ledger 125): the child's `title` may carry the DESCRIPTION of what pressing the control does, and only when the control can act (`title={blocked ? undefined : '…'}`) — never a restatement of the reason, and never `reason ?? 'description'`. **No allowance is left for either shape** (ledger 127): the last two sites ledger 125 named (`entity-panel`'s `generate-everything`, `artifact-editor`'s `encounter-repopulate`) are folded and the scan's known list was deleted with them, so any restated title in `src/**` reds `tests/features/blocked-control-title-scan.test.ts`. The `blocked` in that gate is the control's FULL held expression — the ONE boolean its `disabled` reads too (`generateAllHeld`, `repopulateHeld`, `classifyBlocked`, CanvasPage's `fixBlocked`/`resumeBlocked`) — so a control held by a state other than the one that happens to be named in the title branch never advertises its description either | a `title` on the control itself (invisible in Chrome on a natively disabled control, unreachable by keyboard — docs/18 §4); a second tooltip idiom; a reason that is not true for the state that produces it; a wrapper when the block is self-evident (the label already says the state, an empty input, nothing to act on); gating the description on a PARTIAL held expression (it then paints on a control that cannot act — measured at `encounter-repopulate`, where `running === 'everything'` holds it too) |
| Wiki-link handling | `lib/wikilinks.ts` (extract/strip/rewrite/resolve/count; **ONE grammar, two flag variants (row 145)**: the token shape is written down ONCE as `WIKI_LINK_GRAMMAR` (a `String.raw` string) and both patterns are built from it — `WIKI_LINK_PATTERN = new RegExp(WIKI_LINK_GRAMMAR, 'g')` for `matchAll`/`replaceAll`, and the NON-global `WIKI_LINK_TOKEN = new RegExp(WIKI_LINK_GRAMMAR)` for a caller that LOOPS with `exec`; `lib/mdToPdfmake.pushWithWiki` reads the companion); `stripWikiLinks` = the DISPLAY every export renders, reached through `lib/markdown.markdownToDisplayText` — row 105) + `lib/remark-wikilinks.ts` → `WikiMarkdown` — the ONE chip renderer, so every wiki-aware surface (module reader, canvas preview, peek modal, artifact bodies, board cards, guide) gets the same chips and the same tooltip with no per-surface wiring. **Since docs/17 row 158 it is also the app's ONE table renderer**: `remark-gfm@4.0.1` (a direct dependency) is prepended to that component's remark pipeline, and its `components` map renders `table` through `WikiTable` — a REAL `<table>` inside its own `overflow-x-auto` wrapper (`data-testid="markdown-table-scroll"`), styled by Tailwind descendant variants on the table element. One component, so ONE change reached all four table surfaces (reader, peek modal, editor preview, board cards); GFM's other extensions (strikethrough, autolink literals, task lists, footnotes) ride along, which row 158 records. **How a chip knows the token it was written from** (docs/17 row 100): `splitWikiText` carries `match[0]` byte-exact on the wiki segment, `wikiLinkNode` puts it on the mdast node's `data.hProperties[WIKI_RAW_ATTRIBUTE]` (`'data-wiki-raw'` — the one supported mdast→hast route for custom properties; verified at HEAD that it reaches the React component and the DOM), and `WikiMarkdown` reads it back as a prop, sets it on the chip element and LEADS the chip's `title` with it, keeping whatever the chip already said as the tail | a private `\[\[...\]\]` regex; **reconstructing** the token from name+display (the plugin is the last point where the source bytes exist — the node's only child is the display text); a SECOND chip renderer or a per-surface tooltip wrapper; moving the token into the chip label or into any persisted string (it is render-time only, and `lib/modulePdf`/`lib/pdfExport` never import this module); **a SECOND table plugin copy** — a per-surface markdown component, or a hand-picked table-only micromark wiring beside `remark-gfm` (the row-158 exact-one pin reds on a second `from 'remark-gfm'` import anywhere in `src/`, and on a `<table>` element outside the two declared sites: this renderer and the lab's own synthetic grid); **a table that breaks the reader's column** — the table is real `<table>` semantics inside a horizontal-overflow wrapper, and BOTH halves are pinned (a wide table scrolls, it never blows the layout out); **chips lost inside a cell** — `[[link]]` in a `tableCell` still renders as a chip with its byte-exact `data-wiki-raw` carrier (its own pin, and the injection that makes the plugin skip cells reds it while every other chip pin stays green); **the PDF and the app grammars drifting silently** — the app is GFM and the PDF is `lib/mdToPdfmake`'s line parser, and where the two genuinely disagree (GFM has no headerless table; GFM TRUNCATES a row wider than its header while the PDF widens the table; an indented table is nested in the list item, an unindented one is lazy-continuation TEXT) docs/17 row 158 names each one and each has its own pin — a divergence is recorded, never engineered away by a second parser |
| **Render the derivation's `where` convention for a person** (14 §2, docs/17 row 145) | `features/campaign/mentionView.whereLabel(where)` — THE one home: `'premise'` → `"Premise"`, `'part-<planIndex>'` → `"Part N"` (`planIndex + 1`, the reader's numbering), and anything else rendered VERBATIM (this helper's own contract — it is a display helper, not a parser). Consumers: the Mentions panel and the label-health report through `mentionSummaryText`, and `llm/campaignGrounding`, which builds every `ExpansionExcerpt.source` from it (`"<module title> — Part N"`) — an `llm → features` import (§5). That `source` is STORED on the run row's `expansionExcerpts` and rendered back into the prompt on resume, so a second spelling there would store a different label than the reader shows. | a second `whereLabel` anywhere in `src/` (the private copy in `llm/campaignGrounding` was byte-identical apart from its missing `export` and row 145 deleted it; the pin scans for the declaration and reds on a third). **The ONE deliberate second spelling is `db/orphanSweep.whereLabel`** — lowercase PROSE (`premise` / `part N`) embedded mid-sentence in a user-visible refusal ("mentioned in campaign prose — \"Tide Gate\" premise ×1"), pinned CASE-SENSITIVELY; the owner was told both exist and agreed, so the differential pin declares the relation (`prose === label.toLowerCase()`) instead of unifying them. That copy also throws LOUDLY on a malformed `where` (the `boardEdges.planIndexOf` shape) instead of the values it used to invent (`''` → `part 1`) — the throw is unreachable by construction, since every `where` comes from `domain/wikiGraph.moduleDocuments` over a `moduleSchema`-parsed `planIndex` |
| Write part text on the module row (ONE save path) | `features/modules/partText.saveModulePartText` → `moduleRepo.patchModulePartText` (row re-read INSIDE the rw tx — a concurrent parts write can't be lost; `status: 'ready'`, `edited: true`, and the recorded `origin` — `'human'` when the caller supplies no `writerModel`, `'model'` when it does, docs/17 row 113) + the post-save `promoteSecondModuleUses` scan. Callers: the reader's `savePartEdit` (PartTextEditor hand edits), the board rewrite's Apply and Discard | a stale-snapshot `parts` array written through plain `patchModule` (lost-update on concurrent saves); a part-text write that skips the promote scan; artifact revisions for part markdown (there are none — parts live on the module row) |
| Streaming state on a screen (reader/board tails) | The emitter is NEVER the subscription: `features/modules/streamTails` (reader) / `features/modules/board/stagedRewrites` (board) hold it in an external store with value-diffed frozen snapshots, consumed by the ONE component that shows it (`useStreamTail` → `useSyncExternalStore`); ONE bridge component subscribes to `moduleGenEvents` for the whole screen (`ModuleGenTailsBridge`, renders `null`, ignores other modules) | page-level `useState` fed by a `moduleGenEvents` listener — every token re-renders the page and re-parses every part (measured on 12 parts × 4 KB: 200 tokens = 13,578 ms task time, 200 long tasks of 50–115 ms, 32,134 DOM mutations; after the store: 520 ms, 0 long tasks, 134 mutations) |
| Board the whole module (viewport, layout, LOD) | `features/modules/board/` on `@xyflow/react` (attribution rendered): React Flow is THE viewport gesture owner (pan/zoom/pinch/drag — cards mount plain buttons only, scrollable bodies `nowheel`); node positions + viewport persist via the module row's `canvas` field (`patchModule`, debounced 600ms, flushed on unmount AND on the page going away through `lib/pageFlush` — docs/17 row 118 — rides backup/export); content slices in `boardStore` are value-diffed per node (node objects must stay stable — React Flow re-renders ALL nodes when node objects churn); node keys via `domain/module` (`premise`, `part-<planIndex>`, `prior-<id>`); continuity edges via `boardEdges.deriveContinuityEdges` over `buildWikiGraph` mentions, capped + surfaced | custom pointer handlers on board nodes (a second gesture-arming path — battle-machine rules apply to the battle board only, but the module board must never arm its own); localStorage layout copies; a second node-key format |
| Land a DEBOUNCED row write when the PAGE is going away — a frozen or discarded tab, which never unmounts (docs/17 row 111, extended by row 118) | `lib/pageFlush.registerPageFlush(flush)` — ONE registration list behind ONE `pagehide` listener and ONE `visibilitychange` listener (installed only while at least one flush is registered, removed when the last one goes; the hook fires only for `hidden`, never for `visible`). Registered by FOUR writers today: `features/modules/canvas/chatPersist` (at module scope — the pending queue and the debounce are the writer's own, so the writer owns its flush), `features/modules/new-module-dialog` (`flushPendingDraft`), `features/modules/board/BoardPage` (`flushPendingLayout`, row 118) and `features/campaign/components/artifact-editor` (`flushPendingEdits`, row 118). Every registered flush MUST keep the seam's four-part contract: PENDING-GATED (nothing queued ⇒ nothing written), IDEMPOTENT (the pending work leaves the writer's queue before the write, so `hidden` then `pagehide` is ONE write), NON-THROWING (the writers already toast their own failures; anything escaping a lifecycle listener is toasted by the seam) and **VOID-RETURNING — the flush returns NOTHING, which is where "cannot reject unhandled" comes from (ledger 122). The seam's `try`/`catch` can only contain a SYNCHRONOUS throw, so a flush that RETURNED a promise would put its rejection outside the seam's reach: the async work stays fire-and-forget INSIDE the writer (`void saveDraft()`, `void persistLayout()`, `void flushChatPersist()`). MEASURED: all four registrations return `undefined` — and the TYPE does not enforce it (an `async () => {}` argument is accepted cleanly against `PageFlush = () => void`, verified with `tsc --noEmit`), so this is a convention the writers keep and the seam's doc comment names the gap rather than a compile-time guarantee.** Do NOT add a `.catch(() => {})` here or at a caller to quiet a rejection — it would hide a real one from the next writer, and the writers already toast their own failures by name.** `registerPageFlush` returns the unregister function, which is the `useEffect` cleanup for a component-scoped writer — and that writer puts the registration in the SAME effect as its unmount flush, whose cleanup is `unregister(); flushPending();` (the two triggers are one idea and one function, so a re-registration cannot leave the seam holding a stale closure) | flushing on every `visibilitychange` (a tab switch is not a write — measured: removing the `hidden` gate reds the named pin); registering a writer's UNMOUNT flush when it is not pending-gated (the draft's `flush` writes a touched draft even after its timer fired — the page-hide half needs its own gated wrapper, and the ungated version was measured to write on a tab switch); a per-writer `pagehide` handler (the one-handler-per-writer shape — the board and the editor are registered through this seam, and `tests/features/board-page-flush.test.tsx` source-scans `src/**` to keep a third listener from appearing); awaiting the write (a lifecycle handler cannot hold the page open); a Dexie version, a localStorage mirror or a timer-cancel API to make this work |
| Board per-part rewrite + staging | `features/modules/board/stagedRewrites` (zustand, SESSION-only) + the page's rewrite flow: engine = `runParts` subset (`planIndexes: [i]`) — floor gates own their bands, normalization included — WITHOUT `rewritePart`'s swallow-all catch so `ModuleBusyError` surfaces loudly (ONE generation per module); ghost tokens (`moduleGenEvents` part-token) buffer into the store rAF-throttled — partial text never touches the module row; Apply/Discard land through `features/modules/partText.saveModulePartText`. **Both writes state the AUTHORSHIP they do not change** (docs/17 row 113): `stageProposal` captures the replaced part's `origin` + `writerModel` at the one moment they are still readable, Apply adopts the engine's own text as `origin: 'model'` (it IS the model's rewrite), and Discard puts the previous text back WITH its captured authorship — never re-derived from an omitted writer model, which would stamp `'human'` on either | queueing or silently dropping a busy rewrite; persisting staging anywhere; a diff view (owner decision: new text renders as-is, Show previous on demand); letting Apply/Discard fall back to the writer-model default (that is how model text becomes the owner's — the defect docs/17 row 113 removes) |
| Markdown → the text a READER sees (every export) | `lib/markdown.markdownToDisplayText` — `markdownToText` plus `lib/wikilinks.stripWikiLinks`, the ONE wiki strip, so `[[Name]]` renders as the name, `[[Name\|display]]` as the display, and text that only LOOKS like a token stays literal (row 105; `parseInline`'s bold display run stays `mdToPdfmake`'s own job) | a private `\[\[…\]\]` regex at an export site (the rich-run path's own copy in `lib/mdToPdfmake` was the LAST one and row 145 deleted it — the grammar lives only in `lib/wikilinks.ts`, and the sole declared exceptions are `src/ingest/packs/text.ts`'s two dnd5e DOCUMENT-dialect regexes, a different grammar that resolves nothing); importing the GLOBAL `WIKI_LINK_PATTERN` into a loop that calls `exec` (row 145, §4: it carries `lastIndex` between calls and silently drops every second link from the printed PDF); printing the token into a PDF, handout or text export (the single-artifact GM-notes/handout export DID, until row 105 — recorded by row 100, docs/07 §Wiki-links in an exported document) |
| **Structured PLAIN TEXT (a model's field) → BLOCKS — ONE rule for the app and the PDF** (the owner's *"big text blobs without any paragraph… walls of text, no formatting at all"*; docs/17 row 146) | `lib/textBlocks.ts` — `textBlocks(text)` is the ONE rule (a blank line, however many, is a PARAGRAPH BREAK; a single newline is a LINE BREAK inside one block, never a break of its own; whitespace-only text is no block at all; trailing spaces dropped, indentation kept) and `blockText(block)` is the block AS one run. TWO consumers, each owning only how to DRAW a block: `components/text-blocks.TextBlocks` (the app — `features/campaign/components/stat-block.StatBlockCard`'s prose fields and named entries; `whitespace-pre-line` for line breaks, a block-level element for every block after the first) and `lib/modulePdf.labeledSection` (the PDF — one run per block; **a single-block body is byte-identical to what it printed before**, and it feeds `statBoxContent`, the ONE box both exporters share, so a roster mob's sections and every prose field of the module book gain the paragraphs at once) | a second paragraph splitter in either consumer (a source scan in `tests/lib/text-blocks.test.tsx` enumerates the files allowed to reach the rule and fails on any other; the presenter is asserted to hold no `.split(`); a `\n\n` left inside one run (the wall of text) or a single `\n` promoted to a paragraph break (the two behaviours are pinned APART); a multi-block body written as a MIGRATION of stored text (this is render-time by design — the stored bytes ARE the model's `\n\n`, and rewriting them would move every content hash); a section dropped or reordered by the box change (every section's label run and its relative order are pinned); a reader-composed reference (see the row above) |
| Markdown → faithful plain text — NOT for a reader | `lib/markdown.markdownToText` — markdown syntax only, so wiki tokens stay `[[…]]`; the deterministic image-prompt builder's input, where the token is the only place the target's NAME survives and nothing is read by the owner | using it for anything a human reads; "fixing" it by making IT wiki-aware (the two jobs are one function apart, and the round-trip-safe half is load-bearing) |
| **Markdown → the PDF’s RICH CONTENT — paragraphs, headings, lists, quotes, fences, and TABLES (docs/17 row 157)** | `lib/mdToPdfmake.ts` — ONE seam, and the module book is its only caller. `parseMarkdown(markdown, options)` → `MdBlock[]` (the union: `heading` / `paragraph` / `list` / `quote` / `fence` / **`table`**) → `mdToPdfmakeContent(...)` → pdfmake `Content[]`, reached from exactly THREE doors in `lib/modulePdf.ts` — `artifactProse` (`:1177`, every artifact body), `premiseContent` (`:1411`), `partTextContent` (`:1427`) — and a source scan in `tests/lib/mdToPdfmake.test.ts` reds on a fourth caller or a new file. **THE TABLE GRAMMAR (row 157), one rule each:** a line written with outer pipes is a ROW (the shape this module always recognised); a `\| --- \|` DELIMITER row — every cell `:?-+:?` — makes the line above it the HEADER (`headerRows: 1`, bold and shaded, so pdfmake REPEATS it where a table crosses a page break), and a delimiter row FIRST is a table written without a header, which renders without one instead of inventing one from its first data row; `\|` inside a cell is an ESCAPED pipe and does not split the row; the column count is the WIDEST row’s, and every row — header included — is padded to it with explicit empty cells, so pdfmake is never left to guess; the layout is an OBJECT of functions rather than one of pdfmake’s layout NAMES, because `lib/pdfPageModel`’s `estimateHeight` measures a table by CALLING the layout’s paddings and a named layout would measure as padding-free | **a SECOND markdown parser or second pdfmake renderer** (`remark-gfm` and the app’s `WikiMarkdown` are a DIFFERENT renderer — §2.3’s own split — and neither is this seam’s business: docs/17 row 157 recorded the disagreement and **row 158 closed it on the APP side**, so BOTH surfaces now render tables through their OWN parser and the remaining divergences are named in row 158 instead of being silent; `lib/textBlocks` (row 146) and `lib/markdown.markdownToText` stay text-only); **A TABLE, A ROW, OR A CELL THAT SILENTLY DISAPPEARS** — the pre-row-157 defect: `sanitizeLine` turned ANY pipe line into the empty string, so a table row was DELETED at parse time with no problem, no placeholder and no toast, a list item whose whole text was a pipe line printed an EMPTY BULLET, and `## \| a \| b \|` printed an EMPTY HEADING; a pipe block the parser cannot recognise is TEXT (a paragraph, a bullet, a heading), never a deletion — which is why a table needs no `ModulePdfProblem`; a cell dropped so a ragged row “fits” (pad with empty cells, or WIDEN the table for a row that carries more); an app-side table renderer added here; **a table that overflows the main column unnoticed** — jsdom asserts DEFINITIONS, never a rendered page, and the builder is definition-only by design (docs/19 §3), so a wide table’s column widths and wrapping are the owner’s to judge in a real PDF |
| Render the MODULE PDF — the module IS the document (docs/17 row 108) | `lib/modulePdf.buildModulePdf(module, artifacts, generate, { audience })` — ONE builder, the audience an explicit option (`'gm' \| 'player'`), never a second renderer. The body is the module's own `spine.premise`, its part plan and its `parts`, assembled with `assembleModulePartsDocument` and re-split with `splitPartsDocument` (the canvas's pair), so the `==========` separators and `[Part n of total — title]` scaffold labels a stored document carries can NEVER reach a page; the artifact pool is the module's own mentions (`[[…]]`) plus its owned rows (`moduleId`), deduped in mention order. Chapters: cover → Contents (`toc`) → premise → part plan (GM) → parts (kicker `PART 1 OF 2 · LEVELS 1–2`) → kind chapters (locations/events/encounters/factions/party; plot arcs + notes GM-only) → NPC gallery → treasure ledger (GM: the encounter's own `treasure` line AND one labelled row per mob that carries something — `<encounter> · <mob> ×count`, docs/17 row 159). A **map plate is printed AT its encounter's anchor** from `encounter.data.mapImageId`, else the live battle's `board.mapImageId`, and a battle with NO stored image prints **NO plate and no substitute** — `data.layout` geometry is never drawn (owner decision, ledger 108). **An artifact's OWN image is the DESCRIPTION's, not the plan's** (docs/17 row 187): its `coverImageId` and its map plate print wherever the artifact is described — the procedural kind chapter, the NPC GALLERY (which used to pass `covers: false` under a comment that falsely claimed the gallery had no cover thumbnails) and a PLANNED section alike — through the ONE `modulePdf.artifactDetail` seam, whose two halves (`artwork` / `mechanics`) `modulePdf.companionContent` composes; `artifactOwnImages` is the ONE derivation the placement decision's `hasImage`, the plan-anchor filter AND the preload list's artifact half are computed from, so a location/event with a cover gets the §4 full-width treatment its picture needs. The plan's `images` anchors stay meaningful as EXTRAS, and an anchor naming the artifact's own picture is SKIPPED rather than printing the same image twice. Failures are reported, not swallowed: the returned `problems` (deduped by `where`+`reason`) name the missing premise, a refused parts seam or an unreadable image, and `features/modules/module-pdf-button.tsx` (mounted in the canvas header, the campaign tree's module-group header AND the module reader header — ONE component, THREE surfaces; docs/17 row 185) announces them while still writing the document. **THE EXPORT PLANS BEFORE IT RENDERS** (docs/17 row 139): the button calls `llm/modulePlan.planAndStoreModuleDocument` first and hands the PATCHED row to this builder, so one press prints the planned book; a planning failure is passed on as `ModulePdfInput.planFailure` (an optional option of `buildModulePdf`), which makes the document state on its own page WHICH book it printed instead (the module's last stored plan, or the procedural outline) beside the export's `toastError` | a deliverable/outline model or a stored copy of the module; **a SECOND LEDGER** (the single-artifact GM export grows none, and the module book's ledger is the only aggregation of a printed encounter's treasure — extended in place by docs/17 row 159, never duplicated); **a silently empty ledger LINE** (a mob that carries nothing contributes no row and no line, and the chapter prints only when there is at least one row — `rosterTreasureFor`'s `null` is the ONE emptiness rule); a second builder per audience; a caller that renders without planning (the plan is not a step — see `module-pdf-button.tsx`); rendering the stored document's scaffolding; a schematic/geometry/PROSE map drawn in place of a missing image; an appendix that collects the plates away from their encounters; `writerModel` provenance in a PDF; a second export control per surface; a SECOND body builder for a planned document (the plan feeds the same one) |
| **Lay out a PAGE of the module PDF — geometry, placement, page ends (docs/17 row 148, docs/19 §3–§5)** | `lib/pdfPageModel.ts` — THE one place a page model lives, and the reason `lib/modulePdf` no longer holds a width of its own. It owns (a) every GEOMETRY value, converted from docs/19 §3's millimetres once (`PAGE_WIDTH` 595.28 / `PAGE_HEIGHT` 841.89 / `PAGE_MARGIN` 56.7 / `MAIN_COLUMN_WIDTH` 294.8 / `SIDEBAR_COLUMN_WIDTH` 170.1 / `COLUMN_GUTTER` 17 / `PAGE_CONTENT_HEIGHT` 728.5 / `DETAIL_FONT_SIZE` 9.5); (b) `estimateHeight(node, ctx)`, the ONE fit estimator — arithmetic over the DEFINITION's own text at a given width, deliberately tuned wide and answering ZERO for anything it does not know, so it can err toward promoting a block but can never drop one; (c) `detailPlacement({kind, hasImage, height})`, the ONE placement rule — `beside` → `beside-continued` (≤2 sidebars) → `adjacent`, with `OWN_PAGE_KINDS = {encounter, event}` and ANY block carrying an image forced to `adjacent`, so the ladder is a pure function of its three arguments and the same input always places the same way; (d) `paginateDocument(blocks, {styles})`, the ONE paginator — it asks the placement rule, measures the companion at the SIDEBAR width, splits (never truncates) what does not fit, arms the continuation BEFORE closing the page (closing is what OPENS the next one, which is where §5 puts the `(continued)` head), and emits `DocumentPage { main, sidebar }`; (e) the MARKER/REAL seam — `marker(text, destination?)` is the ONE constructor for all three marker sentences (`ownPageNote`, `continuedNote`, `earlierDetailNote`) and `isMarkerContent(node)` is the ONE test for "is this an announcement or real content" (docs/17 row 186). The brand is a SYMBOL on the node, so the definition's JSON — and every byte-determinism pin — is unchanged by it, and neither the paginator nor `lib/modulePdf.pageNodes` ever string-matches a sentence. `lib/modulePdf` then has exactly two calls into it: `blockPlacement` (the ONLY place a placement is asked for) and `pageNodes` (the ONLY place a page becomes pdfmake nodes — a `columns` node with the two widths and the sidebar's `style: 'detail'`/`fontSize`, `columnGap`, and `pageBreak: 'before'`; a plain full-width `stack` whenever either half holds no REAL content, so a populated column never sits beside an empty one, a marker sentence never owns a column, and the marker rides the text column). Because the page node owns the break, NO section heading carries one, and §3's "sections flow" is the default rather than a special case. **EVERY page of the document is one of those nodes (docs/17 row 156):** the cover, the **Contents**, a plan-verdict statement and the treasure-ledger page are `PageBlock`s like any other (`modulePdf.plainBlock`), so `buildModuleDefinition`'s `content` is exactly `pageNodes(paginateDocument(blocks))` and holds no page the paginator did not measure — before row 156 the Contents was two loose top-level nodes with a `pageBreak` on the heading. The paginator reserves a FULL PAGE for a ToC (`estimateHeight`'s `toc` branch, which row 148 wrote and nothing called until row 156), and `pageNodes` omits the break on the FIRST page because a `pageBreak: 'before'` on the document's first node makes pdfmake print an EMPTY page in front of the cover (measured — it would push every number in the Contents out by one) | a second width, margin or type size anywhere (`modulePdf`'s own `PAGE_CONTENT_WIDTH = 515` was DELETED for this); a page break left on a section heading (the pre-row-148 shape — one full page per section is exactly the owner's complaint); measuring inside the builder (the export is deterministic and offline by design — a two-pass render would put a layout pass in it, so the estimator is arithmetic over the definition and the deviation is stated in docs/19 §3); a page model that silently CLIPS or re-writes content to make it fit (the ladder may only MOVE a block, and `tests/lib/pdfLayout.test.ts` holds a differential over three real documents that fails if a single text run the pre-change renderer produced goes missing); **rendering a two-column page whose main or sidebar holds no REAL content** (the owner's row-186 report in both directions: a main column squeezed to 104 mm beside a sidebar that holds one 8 pt pointer, and a sheet whose only content is the announcement — `isMarkerContent` decides "real", and the paginator additionally DROPS any page that would be marker sentences alone); a second paginator or a per-section break rule at a call site; **a page that is NOT one of these nodes** — a hand-placed page node, a `pageBreak` on a heading or a raw top-level node beside the Contents/ledger (the pre-row-156 shape; red by the shape pin in `tests/lib/pdfLayout.test.ts`, which requires every top-level node to be a `stack`/`columns` page and only the first to carry no break); **A HAND-ROLLED PAGE MAP OR A COMPUTED PAGE NUMBER** — "which page is this section on" is NEVER derived here: pdfmake's own `tocItem`/page-reference resolves it at layout time and the number is pinned by READING THE RENDERED PAGE back with pdfjs (`pdfLayout.test.ts`), because a second placement rule would drift the moment a page overflows (the fixtures render 19 pages from 18 page nodes) and a number that is merely close sends the reader to the wrong page; **a TOC PAGE LONGER THAN THE ONE PAGE THE ESTIMATOR RESERVES** — the reservation is a page, not a measured entry list (the entry list does not exist until pdfmake lays the document out), so a document with more sections than fit one page flows a second Contents page that pdfmake produces and this paginator did not count — it is a KNOWN, inert limit rather than a defect: nothing in the placement ladder depends on absolute page numbers, and pdfmake's numbers stay right because it resolves them after layout |
| **Turn the document's own text into NAVIGATION — a link on every wiki-link, a back-reference line on every artifact section, one companion with a link back (docs/17 row 151, docs/19 §7/§10)** | Three parts, ONE rule each, all of them RENDER-time and none of them stored. (a) **The link** — `lib/mdToPdfmake.MdRenderOptions.destinationFor`: a caller says where a `[[name]]` prints, `parseInline`/`pushWithWiki` puts `linkToDestination` on the SAME bold display run it always emitted (never a reworded run — the text is byte-identical, only the annotation is new), and a caller that passes NO options gets exactly the old module. The answer itself is never computed here: `lib/modulePdf`'s `wikiDestination` resolves the name through the reader's own `lib/wikilinks.resolveWikiLink` over the reader's own pool and then looks the row up in `destinations` — the ONE map of “which artifact prints at which pdfmake id” that already decides linkability elsewhere (§4's own-page ids, `referenceRun`'s roster links, `artifactLinksContent`). `undefined` ⇒ the run stays the plain bold text it always was. (b) **“Where is this row referred to from?”** — `modulePdf.referenceSitesFor`, which is the SAME rule the document's scope and the owner's §10.3 omission decision already use: `extractWikiLinks` over the place's text + `resolveWikiLink`. The places are the DOCUMENT's own text (the premise and the parts as this document prints them, labelled by the section's own title), and `referencedFromContent` draws ONE line per section — `Referenced from: <place> · <place>`, every place a link — into the section's MAIN column, so an `aside`/`read-aloud` section (which carries no companion by role) states it too. A row the text never names gets NO line. (c) **§10.1's “ONCE, with a link back”** — `modulePdf.companionOnce` at the ONE place a repeated companion is emitted: the first section that really emits a companion prints it and records `destinations`-shaped destination; a later one prints `pdfPageModel.earlierDetailMarker` instead, a kicker-tier pointer LINKED to that destination, built through the SAME `marker` seam the §5 own-page pointer uses (the sentence differs because §5's says the detail FOLLOWS, which is false for a back-reference). The record is per BUILD (`state.companionsPrinted`), never a stored field, and is taken only when the artifact's MECHANICS are really emitted — docs/17 row 187 split `artifactDetail` into its ARTWORK (which prints at every description, whatever the role) and its MECHANICS (which this rule owns), so an `aside`/`read-aloud` section still prints its artifact's own picture while its empty mechanics can never claim the row and point a reader at a sidebar holding nothing (that would print the artifact's mechanics nowhere, violating §10's “the document is COMPLETE”). The reachable shape is a PLAN THAT NAMES ONE ROW TWICE, which `domain/documentPlan.documentPlanIssues` permits by design (it validates anchors, never duplicates) | a second wiki-resolution rule anywhere (the PDF and the app's chips must name the same row — that is why `destinationFor` is a CALLER hook and not a resolver inside the renderer); a second “does this row get mentioned?” rule (a row could then be DROPPED as unreferenced while its own back-reference line named the sentence that refers to it); **a link that REPLACES or rewrites content** — the annotation rides the existing run, so a `toContain` on the display text still passes and the differential's string count moves by exactly the two NEW strings (`Referenced from: ` and ` · `); **a STORED back-reference, companion record or link target** (a Dexie field, a `documentPlan` field or a cached destination map would rot the moment the module's text changed, and docs/19 binds the whole layout to render time — a module generated before this slice gains navigation on its next export, with no migration and no re-render of any stored byte); emitting a `linkToDestination` for a row the document does NOT carry (pdfmake throws on a dangling destination, and in the planned document a name the plan gave no section keeps its plain bold run); **a page number WE compute** — since docs/17 row 156 the `chapters` Contents DOES print page numbers, and it still does not compute one: pdfmake fills each entry from the heading node's own `tocItem` registration (`DocMeasure.measureToc` → a page reference here, `linkToDestination: getNodeId(node)` there), which is why the entry's LINK identity is the same id this row describes and §7 has ONE link rule; a hand-rolled "which page is this on" map, or any number that is not pdfmake's own, is the NOT-Z (row 156's I2 injection reds the rendered-page pin with `expected { section: 'Premise', page: 2 } to deeply equal { section: 'Premise', page: 3 }`); reusing §5's own-page pointer sentence for the link back (it says the detail follows, which is false); a second pointer FORM (the marker seam is one function) — **EXTENDED by docs/17 row 188: the same `companionOnce` governs a COMPANION a plan names twice (a part-sourced section's introduced row), and the introducing SECTION's own destination is the link target** |
| Decide the module PDF's STRUCTURE with a model, as DATA (docs/17 row 109) | `domain/documentPlan.moduleDocumentPlanSchema` (STRICT: ordered sections, each with a title, ONE of four closed roles, an audience `all \| gm \| player`, a `source` union naming a part `planIndex` (`-1` = premise) / an artifact id / an encounter id, and `images` = ids the module already holds) → `llm/modulePlan.planModuleDocument` (the ONE planner seam: claims the module via `llm/canvasBusy`, refuses a module with no part plan, and since docs/17 row 169 sends REAL CONTENT — the module's own text (`domain/moduleDocumentText`), the part↔entity structure from the ONE graph derivation (`domain/wikiGraph.buildWikiGraph`), each scoped row's real stored fields through the CANVAS CHAT's own renderer (`canvasChat.renderStoredArtifactSection`, the same one its `<request>` answer uses) and the image inventory — under ONE loud character cap (`MODULE_PLAN_CONTENT_BUDGET_CHARS`, with `[TRUNCATED — …]`/`[BLOCK FULL — …]` markers; a row that stores nothing is named, never dropped), `parseJsonReply` + zod AT THE BOUNDARY, `documentPlanIssues` for the existence rule, provenance from the reply's own `modelUsed`) + `llm/modulePlan.planAndStoreModuleDocument` (THE one plan WRITE — it persists what `planModuleDocument` returned, and it is the call BOTH entry points make: the export's automatic step, docs/17 row 139, and the surface's Regenerate) → `module.documentPlan` (additive optional, parse-on-read `z.unknown()`, ONE writer = that seam, ONE reader = `domain/documentPlan.readStoredDocumentPlan`; **NOT a cache** — every export plans, always, and REPLACES it, because the timestamp a staleness rule would need does not exist on the row: `saveModule` re-stamps `updatedAt` after `plannedAt` is stamped) → `lib/modulePdf.resolveDocumentPlan` (absent \| invalid \| rejected \| applied) → the SAME body builder, one section per entry, the role choosing the TREATMENT (`explanation` prose+data, `read-aloud` the filled box, `gm-note` the labeled box, `aside` an indented insert with no page break and no ToC entry) and the declared audience choosing PLACEMENT (kind rules are the defaults it may override; FIELD-level GM material stays keyed on the DOCUMENT audience). A stored plan that cannot be applied is loud in TWO places — a `problems` entry at `the document plan` AND a statement on the document's own page — while the procedural document still lands and NOTHING of the plan renders; an ABSENT plan is silent and normal. Inspect/regenerate: `features/modules/module-plan-dialog.tsx` (`ModulePlanButton`, canvas header + the campaign tree's module group) — an INSPECTOR with a manual regenerate, never a prerequisite: exporting plans for itself (row 139) — which offers Regenerate and ONE per-section correction (the audience) and nothing structural | a drag-and-drop outline builder, a tree editor, per-node add/remove/reorder or styling controls, or a second "plan" concept beside `documentPlan` (row 108's deletion stands); letting a model emit pdfmake nodes, markdown, or any rendering property (the schema is strict — an extra key is a refusal); a plan field a renderer silently ignores; rendering PART of a plan it cannot fully apply; a fallback that is silent or that clears the stored plan; a model call anywhere inside the RENDERER (`buildModulePdf`/`buildModulePdfDocument`/`buildModuleDefinition` stay deterministic and offline — the planning call belongs to the export button, one per press); a staleness/reuse decision on the stored plan, or a caller other than `planAndStoreModuleDocument` writing `documentPlan`; validating the stored field at write time with a schema that could BRICK the module row — see the companion row below for the field docs/17 row 188 added to this same seam |

| **A section may introduce ONE COMPANION — the row whose profile prints in the section's sidebar BESIDE the story that introduces it (docs/17 row 188, the owner: *"important NPCs should be introduced in a sidebar where the story introduces them. I understand that the sidebar can get crowded though, thats where an LLM needs to make an intelligent judgement call."*)** | `domain/documentPlan.documentPlanSectionSchema.companion` — `.nullish()` and NEVER a default, so every stored plan keeps parsing, a no-companion section materializes no key, and the no-companion render is byte-identical; a strict `{ artifactId }` reference to ONE row already in the section's own pool, checked by the SAME `documentPlanIssues` seam as `source` (an unknown id is a NAMED failure of the WHOLE plan; an `encounter` is refused with its reason — its mechanics are own-page material; the section's own source is refused — one row must not be described twice) and authored by the SAME `llm/modulePlan` planner, whose prompt delegates the SCARCITY judgement to the model and states the reply shape. The renderer composes it into the section's DETAIL through the ONE `companionContent`/`artifactDetail`/`roleDetail` seam (`modulePdf.plannedSectionBlock` + `companionDetail`, which prefixes the row's own NAME because a companion has no main column to carry it): a PART-sourced section keeps the part's story in MAIN and gains the introduced row's profile in the sidebar, an artifact-sourced one keeps its own mechanics AND gains the companion, the section's ROLE gates both rows' mechanics (row 187's split), and the artwork prints at every description. `companionOnce` (docs/19 §10.1) governs a companion named twice; `artifactOwnImages` over BOTH rows decides `hasImage` (so an introduced NPC's portrait gets §4's own-page treatment); a companion counts as PRINTED (`printedArtifacts`), so the NPC gallery never describes it a second time; and its wiki-link destination is the introducing SECTION's (`destinations`). Placement stays `lib/pdfPageModel`'s — the existing §5 ladder, no new rule. Visible in `features/modules/module-plan-dialog.tsx` | a SECOND companion mechanism (a private detail builder, a second once-rule, a second image path); a `companion` default that materializes a key on old plans; silently SKIPPING an unknown companion id, an encounter companion or a self-companion instead of refusing the plan; letting a companion bypass `hasImage` or the §5 ladder; feeding the companion's kind into `detailPlacement` (its own art and measured height already route it); a plan field the renderer ignores; a gallery that reprints the NPC the sidebar already printed; a second plan surface |

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
| **Decide an encounter still needs a map** (ledger 129) | TWO named halves of one fact, never a third copy. **The OFFER** — "which encounters are map work" — is `features/modules/post-generation.encountersNeedingMaps(module, artifacts)`: kind `'encounter'` + `moduleId === module.id` + the GAP (`data.layout === null \|\| data.mapImageId === null`, a DISJUNCTION — a stored layout with no image IS still work). Every surface that PROMISES map work reads it and nothing else: the post-generation sweep's battlemap block, the "Resume automatic module creation" deviation (`automation-deviation.deriveAutomationDeviation`), and the entity sidebar's "Generate N encounter maps" button — label, count AND payload (ledger 129). **The QUEUE's per-artifact guard** is `features/modules/encounter-map-queue.encounterNeedsMap(artifact)` — the gap ALONE, with no kind and no ownership test, because the enqueue site already chose the target; it is the no-double-work belt inside `processJob` (state can change while a job waits). **The pending question is a THIRD thing and stays where it is:** `isEncounterMapPending` reads the queue's own zustand store, so it is read by the AUTOMATION enqueue lanes and is deliberately NOT folded into the offer — folding it would hand the pure sweep and the deviation a global mutable dependency and change THEIR plans, and a re-offered encounter is dropped anyway by `lib/jobQueue`'s enqueue dedupe against queued + active, so the panel's count can over-advertise but can never double-book | a second inline copy of the offer filter (the panel's, cured by ledger 129 — it also could not see `isEncounterMapPending`, which is how the advertised count and the sweep's work drift); reading `data.mapImageId`/`data.layout` for this question at any other site; deciding the gap from the layout alone; moving the pending query into `encountersNeedingMaps` |
| Post-run automation | `features/campaign/post-run-extras.ts` — rides the queues AFTER a completed run. Beside the automatic battlemap it runs the AUTOMATIC ROSTER PORTRAITS trigger (docs/17 row 196): a completed run whose result artifact is an encounter it TARGETED (`targetArtifactId !== null`: the creation-time Cartographer restock, "Repopulate", "Regenerate everything") re-READS the row and, when the owning module's `autoGenerateMobImages` is on (campaign-level encounters have no module switch and stay on the editor/extra route), fills it through the ONE seam `features/campaign/mob-portrait-queue.enqueueEncounterPortraitFill` — both lanes in the queue's own order, the same call the editor's fill press and the module sweep make, so `enumerateBatchKinds` decides which creatures lack art | reopening/failing a finished run row; a bespoke "which creature needs art" list; the regen paths (`regenerateMobPortraits` / `regenerateInventedCreaturePortraits`) — this trigger only ADDS art; replacing the sweep's step 4 (still the gap-filler for a roster no run just wrote) |
| **Restock EVERY encounter of a module at its current difficulty, and edit that difficulty after creation** (docs/17 row 195) | `features/modules/module-restock.restockModuleEncounters(moduleId)` — the module-level SWEEP: `listArtifactsByModule(moduleId)` filtered to `kind === 'encounter'` (the repo's own alphabetical order), then `repopulateEncounter(id, { redesignProse: false })` ONCE PER ENCOUNTER, awaited in the loop — `features/campaign/encounterRegen` stays the ONE orchestration seam and the sweep is only a caller. It holds the module's shared slot (`llm/canvasBusy.claimModuleGeneration`/`release`, so a chat/refine/change or a second sweep is refused with the existing loud `ModuleBusyError`) and captures the app stop epoch (`lib/stopEpoch.getStopEpoch`) at entry, asking `stoppedSince` before each unit AND after a run throws — so the existing Stop all (`stopAllGenerations` bumps the epoch first) ends it at the next boundary, a cancelled run is a STOP and not a named failure, and this file owns no cancel mechanism of its own. Failure policy: CONTINUE (one bad encounter never abandons the module) with a LOUD end-of-sweep report raised BY THE SWEEP — `toastErrorPersistent` naming every failed encounter and its reason, plus the pasteable one-string `[campaigner] module-restock summary {…}` console record; a clean sweep toasts success, a stop toasts the honest "the rest were not touched". Progress rides the shared dock (`module-restock:<id>`, `lib/progress`, href = the module). The control is `features/modules/module-restock-button.ModuleRestockButton`, mounted beside `ModulePdfButton`/`ModulePlanButton` on BOTH module surfaces (canvas header + campaign tree module group), and it displays the RESOLVED difficulty read-only (`resolveModuleDifficulty`) because pressing it runs at that value. The post-creation WRITE is the editor's ONE shared `features/modules/module-difficulty-control.ModuleDifficultyControl` (mounted in the New Module dialog too, so the five steps/labels exist once) calling `db/moduleRepo.patchModule(id, { difficulty })`; the engine needs nothing new because the encounter run resolves the owning module's `difficulty` FRESH at run start (`llm/runEngine`'s `getModule(owningModuleId)`), so the very next Repopulate scales the room budget | a new generation path or a parallel `Promise.all` over the encounters; a second cancel mechanism (per-run AbortController) or a second stop flag; a hand-rolled Dexie difficulty write instead of `patchModule`; a second five-step renderer or a second label map; rewriting prose (repopulate is roster-only — the per-artifact prose checkbox owns words); a sweep that stops on the first failure (it would guarantee a half-done module) or one that reports failures only in console (rule 2) or only transiently; a module-level action that hides the difficulty it acts at |
| Dev logging | `lib/debug.debugLog` | bare `console.log` (lint) or `console.error` as an error surface |
| Stop every running generation | `features/progress/stopAllGenerations` + the dock's Stop all button — the ONE sweep, and it has TWO halves. **(1) Cancel the units**: the FOUR queues' `cancelAll` (`useMobPortraitQueue`, `useEntityImageQueue`, `useEncounterMapQueue`, `useCoverImageQueue` — covers were the real miss: a working `cancelAll` nobody called), `runEngine.cancelAllActive` (every in-flight run; paused `awaiting_user`/`needs_review` runs are not generating and stay), `cancelModuleGen` (every module row at `'generating'`), `chainRunner.cancel`, and `cancelCanvasGenerations` (`llm/canvasBusy` — canvas chat/refine turns stream with no run row, so the registry is the only seam that reaches them; it aborts the turn's own signal AND the caller's controller, which is what makes the partial reply render 'aborted' instead of a "Chat failed" toast). **(2) Seal the "no new units" gate**: `lib/stopEpoch.bumpStopEpoch()` runs FIRST, before any cancel. Non-destructive: cancelled runs/rows stay resumable, queue jobs settle 'cancelled' silently, the count names the DISTINCT stopped units (a module counted as a forge is not counted again for its canvas turn). NOT covered, by design: PDF builds and backup jobs (no cancel seam), the cross-campaign shared mob-portrait cache worker (local participation aborts; the shared worker is not the user's job), queue FAILED retry lists (user-recoverable) | a second stop path or per-surface ad-hoc cancel wiring |
| Stop an ORCHESTRATION, not just its units | `lib/stopEpoch` — ONE app-level counter: a loop captures `getStopEpoch()` at entry and asks `stoppedSince(captured)` between units, so "a stopped orchestration must not start its next unit" (owner report, ledger 68). Consulted at: the post-generation kind loop and each of its three enqueue blocks (`features/modules/post-generation`), the entity-batch pool's worker entry (`features/modules/entity-batch`), the three parts-pass automation gates (`llm/moduleGen` — `runParts` returns `aborted`, because a cancelled pass keeps the row at `'ready'` for Retry and is otherwise indistinguishable from a completed one), the parts loop's post-pass normalization boundary, and `features/campaign/post-run-extras`' enqueue path (a run that finishes AFTER the stop enqueues nothing). Direct user actions are deliberately NOT gated (the entity panel's batch/image buttons, cover enqueue/regenerate, the portrait batch entries, `retryFailed`) — they are not a stopped orchestration's next unit | a sticky "stopping" boolean that has to be cleared (every clear races an orchestration still unwinding from the previous stop); a `lib → features` import (the epoch module is deliberately dumb: one counter, no imports) |
| A cancel is not a failure | `runEntityBatch` treats a `cancelled` run outcome as WITHDRAWN — no `failed` entry, no red toast — mirroring `jobQueue`'s silent `'cancelled'` `JobOutcome`; the cancelled batch also stops its own pool (no further target launched) and says 'Stopped by the user' on the dock. The forge's normalization pass propagates a cancel instead of recording `entityNamesNormalized: false` over a pass the user simply interrupted, and the canvas surfaces skip their error toast when their own controller is aborted | counting a user's stop as `N of M failed to generate` (the pre-ledger-68 behaviour); a blanket silence for real failures (a genuine run failure still toasts and lands in `failed`) |
| Persisted UI state | zustand store + `lib/persisted.zodPersistStorage(schema)` | localStorage by hand |
| Scale the UI app-wide | `app/theme/uiScale.useUiScaleSync` (mounted once in AppShell next to `useThemeSync`) + the uiScale store — `--ui-scale` var × root font-size (index.css); persisted via `zodPersistStorage` (the Persisted UI state seam) and kept through Delete-all-data in `db/maintenance.PRESERVED_KEYS` like the theme | CSS zoom (breaks the px-measured board/pointer/dice/PDF math); a settings-row field (device display preference — theme precedent, stays out of the data DB and backups) |
| Open a document co-authoring surface for the WHOLE module (v3 — no part selector) | `app/routes.ts` `canvasPath` (deep link `?part=<planIndex\|premise>` and `#part-<n>` hashes are SCROLL targets, never scope — landing in preview scrolls the preview articles (`part-<n>` anchors; the scroll re-runs once the content commits)) + `features/modules/canvas/` — `CanvasPage` (shell, leave-guard, preview toggle — OPEN BY DEFAULT: `openByModule` undefined ⇒ true, session-only; the canvas lands as chat + rendered preview side by side, the preview FILLING its pane beside the live chat, one click back to Edit — instruction dialog with the rewrite-part picker), `canvasScope.ts` (the one scroll-target parse site), `canvasEditor.tsx` (the React wrapper publishing `canvasView.activeCanvasView`), `wikiDecorations.ts`, `suggestions.ts`, `canvasStore.ts`. The canvas has exactly TWO entry points, one per destination-shape: the modules list row navigates the plain `canvasPath`, and the reader header carries ONE canvas link, **Chat** → `canvasChatPath` (`canvasPath` + `?chat=open`, which forces the collapsible sidebar open over the session toggle — ledger 57) — the reader header's plain-canvas **Canvas** link was RETIRED by owner request (ledger 138: it and Chat landed on the same page, so the reader nav is Board + Chat + Contents, and a reader who wants the canvas without the sidebar arrives from the list row or closes the sidebar with its own header toggle) | a second markdown editor substrate; hand-rolled `[[…]]` highlighting; a second scope parser; a SECOND canvas entry in the reader header (one destination, one entry — ledger 91's rule, extended to the reader by ledger 138) |
| Own the canvas editor viewport | CodeMirror 6 via `@uiw/react-codemirror` + `@codemirror/lang-markdown` (GFM) — THE editor doc string IS the markdown (byte-exact; no parse→serialize) | a WYSIWYG round-trip (lossy, license-hostile); a textarea; a second gesture path |
| Take an AI action's span from the RENDERED preview (owner request, docs/17 row 102) | `features/campaign/components/wiki-markdown.remarkSourceSpans` (OPT-IN: the `WikiMarkdown` prop `sourceOffsets`, passed by `CanvasPreview` and by nobody else) wraps every rendered text run in a `<span data-md-from data-md-to>` carrying that run's byte range in the part's source, and `resolveSelectionRange(partText, start, end)` is its inverse — the ONE place a rendered DOM selection becomes source offsets. The capture is taken WHERE THE SELECTION IS MADE (`features/modules/canvas/previewStore.selectionByModule`, per module: a click on a header button collapses the browser selection, so it cannot be read at confirm time) by `CanvasPreview` on `selectionchange` + the pane's mouse/key release, and converted to whole-doc offsets with the part's `textFrom`; `CanvasPage.resolveRefineRange` re-resolves it against the live document at confirm, and the dialog SHOWS the exact source text (a scrollable `<pre>`) before anything can run. In the preview the apply rides the SAME seam as the preview chat — `applyPreviewInstruction`: splice the zod-validated reply over exactly `[from, to)`, validate the resulting parts document at that boundary (refuse loudly, nothing written), then `saveWholeModuleDocument` (`origin: 'ai'`, durable pre-change version `refine`/`rewrite`) and advance the mirror state (`previewDoc`/`baselineDoc`/`docText`/`lastReplacement`) exactly as a settled turn does. Byte-exact or REFUSE, by name: a point inside a wiki chip's label, a cross-part selection, an unmapped span (inline code, image, the unwritten-part placeholder), an empty selection, a run whose pieces do not reproduce its source slice, and a capture from an older document each say so and run nothing | geometry (`getBoundingClientRect`, `caretRangeFromPoint` — untestable in jsdom and wrong across the highlight and lazy layout); clamping, rounding or extending an unmappable selection to a nearby boundary; using a chip's DISPLAY label as the source span (the token is what the model must get, `data-wiki-raw`); a second apply/save path for the preview; making the reader carry the map (no prop ⇒ no plugin, no attribute, byte-identical output — pinned); reading the CM6 selection while the preview is open (there is no view) |
| Run a canvas AI action (selection refine / picked-part rewrite) | `llm/canvasRefine.refineModuleText` — the EXPLICIT input only (the selected range + enclosing block, or the picked part's current text — never the surrounding part, never the cursor) + instruction, reply ZOD-validated at the boundary (`canvasRefineReplySchema`) + `generatedTextHygiene.generatedTextScanForFields` scan — escape debris + our own prompt scaffolding echoed back (loud reject, never partial-apply, docs/17 row 142) + `ModuleBusyError` for ONE-generation-per-module (registry claimed synchronously at entry + the row's `generating` status) + abort signal (a user stop is not an error) + the `canvasBusy` abort REGISTRY (a sweep abort reaches the turn AND the caller's controller, docs/17 ledger 68) | a private chat client; silent repair; queueing a busy module; a second module-busy mechanism; in the PREVIEW the span comes from the rendered selection and the apply rides the preview chat's own seam (the rendered-selection row) |
| Render + decide canvas proposals | `features/modules/canvas/suggestions.ts` — a CM6 StateField of suggestions rendered as DECORATIONS that never mutate the doc; span = struck original + ghost + inline Accept/Reject (disabled while streaming); whole-part = full-doc-range proposal rendered NO-DIFF (block replace widget, Show previous toggle); typing INSIDE a proposal invalidates it loudly (page toast), edge edits re-map (pure `suggestionSurvives`); Accept = ONE dispatch + `isolateHistory:'full'` (one undo unit); streaming effects ride `Transaction.addToHistory.of(false)`; Mod-y/Mod-u accept/reject at the cursor | writing proposals into the doc before acceptance; a diff view; a second undo convention; accepting a half-streamed replacement |
| Append canvas version history | `features/modules/canvas/canvasStore.useCanvasLedgerStore` — per-part append-only `{seq, markdown, origin 'user'\|'ai', label, createdAt}`; every accepted AI action AND manual canvas save appends (one entry per CHANGED part — the split-save decides); **Restore = propose-through-the-same-accept path** (rides undo + the save path); SESSION-ONLY (dies on reload — §4), shown as the menu's "session versions" group | persisting the ledger; a second part-text write path; restoring by direct row write |
| Snapshot the whole document BEFORE an AI change (durable simple undo, owner-directed, ledger 63) | `db/moduleVersionRepo.snapshotModuleVersion(moduleId, source, label)` — ONE row `{id, moduleId, createdAt, source, label, docText}` in the additive `moduleVersions` table (schema v19, no upgrade fn), where `docText` is the WHOLE parts document BYTE-EXACT in the ONE `assembleModulePartsDocument`/`splitPartsDocument` format (spine premise excluded); called immediately BEFORE the write, never after, by: `saveWholeModuleDocument` with `origin: 'ai'` (editor chat batch, preview-snapshot chat batch, accepted Refine/Rewrite proposal, restore — the `version` arg is REQUIRED for AI saves and its absence THROWS, writing nothing; **ONE snapshot per AI SAVE, never per part and never twice** — the whole batch shares it, because two snapshots split one revision in two, and the count is pinned on both chat surfaces in `tests/features/canvas-chat-turn-parity.test.ts`), `runParts` at entry (generation / missing-part fill / single-part rewrite+regenerate / board staged rewrite / floor repairs), each `normalizeModuleEntityNames` pass, and `entity-panel.applyProposals` (consented rewrite apply); `createdAt` is strictly increasing per module; `MODULE_VERSION_CAP` 25 per module, oldest pruned in the INSERT transaction, retention stated in the menu (**restore** validates the snapshot against the CURRENT part plan and refuses loudly on a mismatch, then rides the shared whole-doc proposal → accept → the split-save, taking its own pre-restore snapshot; **clear all previous versions** = destructive-confirmed menu item, module-keyed, no snapshot first, document untouched) | a second document format; snapshotting AFTER the change; snapshotting manual typing (CM6 history owns it) or the board's Apply/Discard of a staged rewrite (already captured at pass entry); a silent cap; a side-door restore write; clearing another module's stack; letting Clear chat delete undo history; making the session ledger durable |
| Keep a generated scene block intact through every document path (docs/08 §M4-B-2, docs/17 row 73) | NOTHING new — the scene block is plain markdown inside a part's `markdown` string, so there is ONE document format and no scene-aware code exists anywhere: `domain/modulePartsDocument.assembleModulePartsDocument` / `splitPartsDocument` (the only assemble/split pair), `features/modules/canvas/saveDoc.saveWholeModuleDocument` (the split-save), `db/moduleVersionRepo.snapshotModuleVersion` (byte-exact `docText`) and its restore-through-the-same-split-save, and `features/campaign/components/wiki-markdown.WikiMarkdown` (the reader's and canvas preview's renderer) all operate on the same text they always did. The block's heading uses `##`/`###` markdown and its labels are bold text, so the reader renders it as a heading, labels, list items and ordinary wiki chips; the encounter floor reads the heading's `[[link]]` exactly like any other link in the part text. Round-trip pinned end to end (assemble → split → split-save → snapshot → restore, plus legacy prose parts and the fake-header guard) by `tests/features/scene-block-document.test.ts` | scene-aware parsing at any read or write site (field extraction, a block model on the module row, a schema or Dexie version for it); a second document format or assembler; a scene-specific renderer in the reader/canvas (the block needs none); a migration for parts written before the format (legacy prose keeps rendering, saving and counting); changing `countModuleEncounters`, its schema, its resolver, its per-part shares, its message or `tests/fixtures/encounterGuardrails/floor-message-default.txt` for the format's sake |
| Show "Fix module problems" only when the module text has a problem a rewrite can fix (owner request, docs/17 row 74) | `features/modules/module-problems.deriveModuleProblems(module, readerPool)` — ONE pure derived problem set built from detectors that ALREADY exist: the module's own encounter floor (`countModuleEncounters` + `floorRepairTargets`, per level band) carries `repairable: true`, and the READER's unresolved-link test (`resolveWikiLink` over the premise and every part — the same verdict that renders the dashed "not detailed yet" chip) carries `repairable: false`; `hasRewritableProblems(set)` is the visibility rule the canvas reads, so entity-side problems are REPORTED in the confirmation (with their remedy) and never turn the control on — the owner's boundary, verbatim: "This is about the module text, not entities. Entities are automated in other ways." | a stored problem flag (the derivation IS the answer — a flag goes stale on the first hand edit); a NEW runtime gate or a detector this repo does not already have; a prose-quality check (pacing, fairness, "is it conflicted" — prompt discipline, docs/08 §M4-B-1); putting the entity shortfall (unresolved names) on the rewrite list; heuristic or fuzzy name matching for a phantom link (the normalization pass, judged by the model, is the only name resolver); gating VISIBILITY on entity work, which would make this entity work under a text label |
| Show "Resume automatic module creation" — or, in the entity sidebar, "Generate everything" — only when the live state falls short of its TARGET (owner request, docs/17 rows 71/74/80) | `features/modules/automation-deviation.deriveAutomationDeviation(module, campaignArtifacts, target?)` — the target state is the row's `automationIntent` (what the owner asked creation to automate) or, when `target` is given, THAT explicit target with the recorded intent not consulted at all (so a legacy row with no intent is served instead of inert); the deviation is DERIVED at render by comparing it with what actually exists, and the pool is the SWEEP's (`moduleCreationPool` over the campaign's artifact list) either way. EVERY target list is the sweep's own, exported from `features/modules/post-generation` (`batchTargets`, `imageTargets`, `encountersNeedingMaps`, `encountersNeedingMobPortraits`) plus `moduleGen.unclassifiedModuleNames` for names the text picked up with no recorded type; `deviationLines` is the ONE source of the confirmation's copy, and `automationIntentDrift` refuses a row whose automation fields no longer match the recorded intent (**the recorded-intent path only** — `resumeEverything` passes the target itself, so there is nothing left to drift from) | storing `deviates`/`hasProblems`/`needsWork` on the row (banned by the schema's own doc comment — the deviation must survive every hand edit, and a cached verdict does not); a SECOND target derivation beside the sweep's (the confirmation must name exactly the work the sweep would do); the READER's pool here (a global-library or party name would promise work the sweep skips); inferring intent for a legacy row (`automationIntent: null` ⇒ inert — UNLESS an explicit target was passed, docs/17 row 80); a drift refusal on the explicit-target path; treating the deviation as a gate (nothing blocks on it) |
| Resume automatic module creation (the run) — and, through the same pipeline, the entity sidebar's "Generate everything" (docs/17 rows 74/80) | `features/modules/resume-automation.runResume` — the ONE user-invoked pipeline, called with no target by `resumeModuleAutomation(moduleId, campaign)` (the canvas control: the recorded intent IS the target) and with `FULL_AUTOMATION_TARGET` by `resumeEverything` below: refuses LOUDLY on a row diverged from its recorded intent, on a row with no recorded intent (**both are the recorded-intent path's preconditions** — the explicit target is what serves a legacy row), and on a module whose parts pass is not complete (**never parameterized**: a module whose parts never landed has nothing to automate, whichever target is asked for); returns a no-op with no call, no write, no enqueue and no toast when nothing is missing; otherwise it may run the two EXISTING passes its reasons require (incremental classification for names with no record — `classifyNewModuleEntityNames`; the name-normalization pass when `entityNamesNormalized` is false, because a sweep called with the gate closed would generate nothing SILENTLY) and then the EXISTING sweep `features/modules/post-generation.runModulePostGeneration`, which is additive by construction (unresolved names only, entities without images, encounters without maps, mobs without portraits). It captures `getStopEpoch()` at entry and asks `stoppedSince` before each unit — classification, normalization, sweep — so "Stop all" during a resume ends it where it is; the sweep keeps its own capture for a stop landing mid-sweep | a parallel automation pipeline or a second sweep; re-generating, re-detailing or overwriting anything that already exists (the resume is ADDITIVE — that is the feature); touching the module's PROSE (the text half is "Fix module problems"); running units after a stop, or resurrecting a run the owner stopped; half-running (a normalization that still fails after its retry stops the whole resume loudly rather than letting the sweep generate nothing); a "resuming" flag that has to be cleared |
| Fill EVERY generation gap of one module (the entity sidebar's "Generate everything", owner request, docs/17 row 80) | `features/modules/resume-automation.resumeEverything(moduleId, campaign)` — `runResume` with `FULL_AUTOMATION_TARGET` (`features/modules/post-generation`: every `ENTITY_KINDS` entry in both lists, battle maps and mob portraits on) instead of the row's recorded `automationIntent`, so a module created before that field existed (which the intent-bound control refuses outright) is FILLED rather than refused; the sidebar derives its own visibility and its "Generate everything (N)" count from `deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET)`, shows the passive "Nothing missing" statement when nothing is left (never a permanently disabled button), and a `title` reason while a generation is in flight; the row's `automationIntent` and its four automation fields are NEVER written — they stay the record of what creation was asked to automate (docs/17 row 71) | a second sweep or a second pipeline (the unit order, the gates and the additive guarantees would drift); a stored, inferred or row-written target; redefining "missing" so the count matches a wish instead of the sweep's own detectors; consulting `automationIntentDrift` on this path (there is nothing to drift from) |
| Run a canvas CHAT turn (LLM co-authoring via XML edit commands over the WHOLE module) | `llm/canvasChat.sendCanvasChatMessage` — the request carries the LIVE whole-document editor doc passed by the page at send time (the doc IS the whole module — unsaved edits in EVERY part ride along, never a cached copy, never a row re-assembly) and splits the per-part snapshot it sent from that SAME doc (shared `domain/modulePartsDocument.splitModulePartsDocument` — the ONE assemble/split pair for editor and chat; a scaffolding-broken doc fails the send loud); spine premise EXCLUDED, `==========` delimiters + `[Part <n> of <total> — <title>]` scaffold labels; reply = prose + `<edit all="…"><search>…</search><replace>…</replace></edit>` blocks parsed by the STRICT extractor (`parseCanvasChatReply`, balanced scan; malformed/unbalanced/>40 commands = `CanvasChatParseError`, whole reply failed) + zod `canvasEditCommandSchema`; tolerant ladder `resolveCanvasEdit` runs PER PART (`resolveCanvasEditAcrossParts` — a spanning search cannot match, zero matches pick the closest candidate across parts, an empty part fills via its exact label line, ledger 51), never an auto-apply — aider lineage, ledger 50; a REFERENCE-ONLY grounding block (campaign premise + system label + ALL preceding modules' FULL text, story order, UNCAPPED — `renderChatGrounding`, deliberately not `moduleGen.priorModulesContext`'s caps) rides every request in the final turn, outside the persisted history; the FULL conversation history rides every request (ledger 57 — the message cap is deleted, no omission note; stale `<document>` blocks are stripped from older turns, the current doc rides once in the final turn); a module with no planned parts fails the pre-flight loud; claims the SHARED `llm/canvasBusy` registry (chat + refine serialize, `ModuleBusyError` loud). Application is THE ONE applier, `features/modules/canvas/chatApply.applyChatCommands` over an injected `ChatDocumentHandle` (ledger 150; `editorChatHandle(view)` dispatches ONE CM6 transaction per command — NORMAL history, one undo step, and TWO dispatches are the defect a real `undo(view)` pin catches — while `stringChatHandle(doc)` splices backwards for the preview string, so the two surfaces are ADAPTERS over one algorithm, never two copies); the batch then persists through the split-save, only the changed parts hitting the row; a failed part save flips that part's outcomes loud + names the part); in PREVIEW (the default view — editor unmounted, never remounted hidden) the SAME protocol runs against the preview SNAPSHOT STRING (`chatApply.applyChatCommandsToSnapshot` — the string handle over the SAME applier, no second matcher; re-exported by `snapshotChat`) and persists through the SAME split-save headlessly (`saveWholeModuleDocument` needs no editor; preview-applied edits have no CM history, so their undo is the DURABLE pre-change snapshot the save seam takes first — §2.3 snapshot row), then the snapshot + highlight advance and the preview re-renders, and return-to-Edit remounts the latest snapshot through the mountDoc path; a broken snapshot fails the send loud via the same `ModulePartsDocumentError` path. Both paths report the last command's first applied range for the last-replacement highlight (page `lastReplacement` state: whole-doc offsets + post-apply doc identity, identity-gated; editor = `lastReplacement.ts` CM6 background mark, preview = optional `WikiMarkdown` highlight prop, byte-identical without it). The flow is ONE parameterized controller, `features/modules/canvas/chatTurn.runCanvasChatTurn` (streams prose only; commands apply AFTER the reply; report-to-LLM via `composeFailureReport` with the target part's current text) — `chatController.runChatTurn` (live editor doc) and `snapshotChat.runSnapshotChatTurn` (+ snapshot report variants, excerpt from the current snapshot) are its two surface wrappers, passing a handle and a `ChatTurnSurface` that names where THAT surface keeps unsaved edits; a FAILED turn returns the document that still carries the applied edits on BOTH surfaces, because that is what the refusal text tells the user; the thread (messages + outcomes) persists on the module row's additive `chatThread` field after each settled turn (debounced `chatPersist.scheduleChatPersist`, loud-nonblocking; restores on canvas open as history, never auto-applies) and rides backup/export with the row; applied part edits land through the split-save (`saveWholeModuleDocument`) | a private chat transport; `responseFormat` on the chat call (prose+XML is deliberately not a JSON contract); regex-guessed block extraction; a fuzzy auto-apply on zero matches; matching across the assembled string instead of per part; reusing `moduleGen.priorModulesContext`'s caps (or any cap) on the chat grounding block; `addToHistory:false` on applied commands (undo must revert chat edits); remounting or hidden-mounting the editor to serve preview chat; a second command matcher for the snapshot path; **a SECOND APPLY IMPLEMENTATION** (a per-surface copy of the ladder walk / the outcome builders / `MAX_CARD_SNIPPET` — the deleted copy was 86% verbatim and a differential fuzz found zero divergences, i.e. it would have drifted in silence); **a SECOND TURN CONTROLLER** (the preview copy was 87% verbatim and had ALREADY diverged on its failure return); **TWO CM6 transactions for one user action** (one command is one undo step, pinned with a real `undo(view)`); **a turn that omits `writerModel`** (supplying it IS the machine-write signature — `origin` flips to `human` and model text is stamped as the reader's, silently) or **takes the `moduleVersions` snapshot twice** (one revision splits in two); a second chat-thread store beside the row field; a second module-busy registry; chat writing part text directly (the `chatThread` field is its sanctioned row write) |
| **Apply a chat reply's commands to a chat document — and run the turn that does it** (docs/17 row 150) | `features/modules/canvas/chatApply.applyChatCommands({ commands, partPlan, handle })` — THE one applier: the per-part ladder re-resolved PER COMMAND against `handle.read()`, the debris scan, the empty-search guard, `all="false"` demanding one match across the module, the empty-part label-anchor fill, the shared outcome builders (`failedOutcome`/`appliedOutcome`) and `MAX_CARD_SNIPPET = 280`. A surface supplies a `ChatDocumentHandle` (`read()` / `replaceRanges(ranges, insert)` as ONE user action): `editorChatHandle(view)` for the live editor (ONE CodeMirror transaction — one undo step per command) and `stringChatHandle(doc)` for the preview snapshot (pure splices; `text()` returns the result). The public entry points `applyChatCommandsToDocument` (editor) and `applyChatCommandsToSnapshot` (preview, re-exported by `snapshotChat.ts`) are handle + core, nothing more. The TURN around it is ONE parameterized controller too: `features/modules/canvas/chatTurn.runCanvasChatTurn` owns send → stream → apply → split-save → thread, with `chatController.runChatTurn` / `snapshotChat.runSnapshotChatTurn` as the two surface wrappers (handle + `ChatTurnSurface`). Obligation pin: the 310-case differential in `tests/features/canvas-chat-apply-differential.test.tsx` runs both entry points over one table and requires identical document text and identical outcome fields; the SOURCE SCAN in the same file and in `tests/features/canvas-chat-turn-parity.test.ts` holds the declarations to one file each | **a second apply implementation** (a per-surface copy of the ladder walk — the deleted one was 166/192 lines verbatim and a 3000-case fuzz found ZERO divergences, so a copy can drift in total silence); **a second turn controller** (the deleted one was 266/306 lines verbatim and had already diverged on its failure return); **two CM6 transactions for one user action** (a replace-all must undo in one step); **a chat apply that omits `writerModel`** (it IS the machine-write signature: omit it and `origin` reads `human`, i.e. model text stamped as the reader's); **a `moduleVersions` snapshot taken twice** (one revision split in two); a preview failure return that discards the edits its own refusal promises are still there |

| Return ONE module's canvas chat to a pristine state (Clear chat) | `features/modules/canvas/clearChat.clearModuleChat` — ROW FIRST (awaited: `chatPersist.clearPersistedChatThread` → the same `patchModule({chatThread: []})` seam the debounced writer uses, cancelling that key's pending debounce; a failure cancels the whole action), then the live conversation (`chatStore.clearModule`) + that module's session ledger (`canvasStore.clearModule`, owner-keyed `moduleId#planIndex`), the page drops the `lastReplacement` highlight (both surfaces); the panel-header control confirms through a destructive AlertDialog whose copy states what is NOT cleared; refuses LOUDLY (toast, nothing cleared) while a reply is in flight or any canvas AI action is live for the module | clearing document text (not an undo — revert lives in the Versions menu: the DURABLE snapshot stack, plus the session ledger as session review state); clearing the module's DURABLE versions (undo history is not chat state — the menu's own destructive item owns that); a second persistence path for `chatThread`; touching another module's thread/ledger/versions/highlight; a cancel-then-clear path |
| Bench image models + chat vision against each other (experiment lab, OUTSIDE the creation path) | `features/lab/` — `LabPage` shell + `experiments/registry.ts` (id/title/description/run config/results renderer; the next bench appends one entry, the shell stays untouched) + `experiments/labeledDungeon.ts` (8 hardcoded irregular rooms, the generation prompt + `{label,x,y}` 0–1000 vision contract now SHARED from `llm/visionDungeon.ts` — the lab aliases the production builder/parser, imports FROM the shared module, never the reverse — plus pure `normToPercent`) + `labClients.ts` (the app's `generateImages` pipeline + the configured chat model with a vision message — NO model pickers; session-only data URLs, no Dexie); `/lab` route linked from Settings → Experiments only, never the main nav | a model picker in the lab; persisting bench results; any creation-path import of lab code (lab imports FROM seams, never the reverse) |
| **Hold a cross-tab generation lease (and opt out of the freeze heuristics)** (docs/17 row 110) | `lib/generationLocks.withGenerationLock(moduleGenLockName(id), work)` around every generation pass (`moduleGen`'s spine/parts passes, `post-generation`'s sweep): `navigator.locks.request(name, { ifAvailable: true }, …)` and the callback's promise IS the hold, so the lock is released when the pass settles (throw, abort or success). With no Web Locks API the work runs DIRECTLY (`webLocksAvailable()` false), and an unavailable lock (another tab) still runs the work | making a pass depend on the lock, or blocking on it (`ifAvailable: true` so a second tab never queues behind a lease — that would be a new failure mode, not a fix); assuming the API exists when reading liveness (a missing `navigator.locks` means the cross-tab half of `isModuleGenClaimed` answers `false` — the page-local registry is then the only signal, stated in §4); an in-repo lock registry standing in for the real API |
| **Tell the owner, from a BACKGROUNDED tab, that a long generation finished or failed** (docs/17 row 110) | `lib/backgroundTitle`: `setBackgroundActivity(id, { label, state })` / `clearBackgroundActivity(id)` / `clearFinishedBackgroundActivities()`, applied through `applyBackgroundTitle()` — `document.title` is written ONLY while `document.hidden` (`Working: <label> — Campaigner`, `✓ Finished: …`, `⚠ Failed: …`, failed outranks finished outranks running, same-rank extras as `(+N more)`), and the app's own title is restored while the page is visible. Runs register from `runEngine` (label = persona name), generation passes from `moduleGen` (label = module title) | writing the title while the page is visible (it is a STRIP surface, not the document the owner is reading); a verdict a stop never reached (a user stop CLEARS the entry rather than inventing "finished"); using the title as a progress meter (the module never guesses "part 2 of 5" — the label is the caller's); leaving a `✓`/`⚠` on screen for the next trip away (`clearFinishedBackgroundActivities` runs on the way back in) |
| **Say "this module already has a generation running"** (docs/17 row 120) | `features/modules/module-busy.ts` — THE one seam for the condition's COPY, and it is deliberately TWO sentences. `MODULE_BUSY_TOAST_TITLE` + `toastModuleBusy(error)` = the toast for a refused ACTION, the ONE call for all seven catch sites (ChatSidebar ×2, CanvasPage ×4, BoardPage ×1). `MODULE_GENERATING_REASON` = the reason a blocked CONTROL states through `BlockedControl`, the ONE constant for all FOUR readers (CanvasPage's `busyReason`/`saveBlockedReason`, `spine-checkpoint`, `boardNodes`, and `entity-panel`'s `generateAllBlockedReason`, folded by ledger 123). One condition, TWO audiences — a disabled control has no action to have been refused, and a refusal toast states nothing about a control — so the sentences are never collapsed into one (AGENTS rule 4: what is shared is the FACT, not the sentence). Inherently cross-surface (canvas, board, checkpoint), which is exactly why it is a module and not a private constant per file | a per-file `MODULE_GENERATING_REASON` copy (the audit found THREE, plus a fourth inline in `entity-panel.tsx` — folded by ledger 123, so the sentence is stated in exactly ONE source file, asserted by EQUALITY rather than by the carve-out subset that licensed the fourth copy); ONE merged sentence for both audiences; a literal toast title in a catch block; letting `ModuleBusyError.message` reach the owner as the toast's description — the toast seam drops it BY ERROR NAME and logs the raw error instead (the message is a sentence of its own since ledger 123 and carries no row id; the suppression STAYS because the title already names the state and both ways out, so a description would only restate it). The GATE is not here and must not move: `llm/canvasBusy` (the in-page claim registry) and `lib/generationLocks` (the cross-tab advisory lease) stay two authorities for two jobs |
| **Record WHY an entity batch failed — per failure as it happens, and per batch at the end — and then tell the owner** (docs/17 row 131; owner, verbatim: *"the root problem is simply not recorded … something in the console to post back to you"*) | `features/modules/entity-batch-report` — THE seam, with ONE writer per failure and ONE per batch. **Per failure** (as it happens, from the batch's single funnel — see the next row): `recordEntityBatchFailure(context, failure)` emits the PASTEABLE line `[campaigner] entity-batch failure {…}` as ONE string argument, plus the same record as a live object under a DISTINCT tag (`[campaigner] entity-batch detail …`). **Per batch**: `reportEntityBatchFailures({ campaign, module, kind, total, failures })` — the ONE call BOTH batch surfaces make (`entity-panel.tsx`'s per-kind button and `post-generation.ts`'s unattended sweep) and the ONE composer of the count sentence — emits the greppable headline `[campaigner] <kind> batch: N of M failed` with the structured payload, the same payload again as the pasteable `[campaigner] entity-batch summary {…}` line (one source of truth: the line is produced FROM the object the console shows, pinned by deep equality), and `toastErrorPersistent(sentence)` (rule 2 — never console-only **and** never transient: the count has no other surface, the dock drops its job, and a refusal's run COMPLETED while a setup throw starts no run at all). Every payload carries the batch context (`campaign`, `module`, `batchKind`, `total` — `batchKind` because `kind` is the FAILURE's class in the same object) and per failure `name`, `kind`, `message`, `runId`, `status`, `failureKind`, `errorMessage`, `raw`, `issues`. The record it reports is `entity-batch.EntityBatchFailure` | a second copy of the sentence at a call site (it was at two, character-for-character); `toastError` (transient — the measured cause of the owner's "vanished quickly"); reporting only at batch END (a batch that dies mid-flight then leaves no evidence); a live object as the only form (devtools' "copy object" truncates nested values — the line is the deliverable); the pasteable line carrying a second argument (a devtools-specific preview lands in whatever gets copied); two different facts sharing the `kind` key; building the payload by re-deriving what the record already holds (`errorMessage(error)` flattens a ZodError to its raw issues array); treating a designed refusal or a page-reload interruption as a generator failure; a console entry with no user-visible surface |

| **Append a failed entity to the batch's list** (docs/17 row 131) | `features/modules/entity-batch.ts`'s local `recordFailure(failure)` — the ONLY line in the file that appends to `failed`, and it writes the failure down through `recordEntityBatchFailure` in the same breath. Every failure arm (a cast-creature refusal, a run that did not complete or was interrupted, a setup throw) calls it, so no class can be counted without being recorded — and the record exists even when the batch never reaches its callers' end-of-batch report (a page reload, the owner's Stop, a throw out of the function). A scan pin holds `failed.push(` to exactly one occurrence and `recordEntityBatchFailure(` to this one caller | appending in each arm and reporting at batch end (the shape that lost the owner's evidence); four call sites each logging on their own (rule 4); re-deriving the batch context at each arm instead of closing over it |
| **Open a standalone writing surface that belongs to NO campaign** (docs/21, docs/17 row 173) | `app/routes.ROUTES.ideaBoard` (`/idea-board`) + `app/layout/nav.appNavItems` — an APP-LEVEL route in the primary nav beside Rules and Settings, and that is the point: `campaignIdFromPath('/idea-board')` is `undefined`, so the campaign bar renders its disabled-tabs state and no campaign has to exist. `features/idea-board/IdeaBoardPage` is the page: a plain-text CodeMirror document beside a left refinement sidebar (`md:w-80`, the module chat's shape) with the transcript, the session model selection and the instruction box, plus the copy button and the Previous drafts list. The document is ORDINARY TEXT — no wiki-link decorations, no markdown language extension, no parts or scaffolding — and a refinement only ever offers a proposal. **Its editor config is a named seam, `features/idea-board/editor.ideaBoardEditorExtensions`** (plain text on `plainEditorTheme`, `basicSetup` OFF with `history()` + keymaps listed because the page's Undo/Redo controls dispatch `undo`/`redo` against that view), mounted for REAL in `tests/features/idea-board-editor.test.tsx` — the page-level test mocks CodeMirror, so a set that throws or lost `history()` would otherwise reach the browser green. **TWO LAYOUT INVARIANTS, each a fix the owner had to report once (docs/17 row 174):** the page root is `h-full`, NOT `flex-1` (the shell's `<main>` is a plain block, so `flex-1` resolved to nothing and the board sat at its floor height, wasting the viewport — `CanvasPage` fills the same slot the same way); and the writing surface carries the app's Card edge (`ring-1 ring-foreground/10`) rather than `border`, because in LIGHT mode `--card` and `--background` are BOTH pure white and the 92%-grey `--border` left it reading as a featureless white block ("white on white") | putting the board UNDER a campaign (`/c/:campaignId/…` — it is not campaign state and must work with none open); resolving `[[tokens]]` on the board (the feature's whole point against the module canvas: they are literal characters); mounting `features/modules/canvas/CanvasPage` (module parts, split-save and busy-by-module semantics); a campaign tab instead of an app nav item; **a `flex-1` page root in this slot** (it silently collapses — the shell main is not a flex container); **a `border`-only edge on a light-mode surface whose colour equals the page's**; **a second, private editor extension list** (the page passes the seam by identity, pinned by the test) |
| **Copy text to the clipboard** (docs/21, docs/17 row 173) | `lib/clipboard.copyText(text)` — THE one place `navigator.clipboard.writeText` is reached, widening the capability check the DOM lib cannot express (`navigator.clipboard` is typed as always present but is missing in insecure contexts and test environments). Callers own their own user-visible success/failure messages, because the sentence belongs to the thing being copied. `tests/architecture/clipboard-seam.test.ts` holds the population to this ONE file and asserts the folded call sites still call it, so a third hand-rolled `writeText` reds | a bare `navigator.clipboard.writeText` at a call site (it was hand-rolled twice in `persona-panel.tsx`, once WITHOUT the availability check — the two drifted exactly as copies do); a toast inside the seam (it would prescribe one message for every caller) |
| **Theme a plain-text editor** (docs/21, docs/17 row 173) | `lib/editorTheme.plainEditorTheme` + `editorThemeSpec` — the CodeMirror THEME TOKENS (background, caret, selection, active line, scroller font, focus ring) as one CSS-custom-property spec, with no language extension. `features/modules/canvas/canvasTheme` COMPOSES it and re-exports `editorThemeSpec as canvasThemeSpec` (so the existing markdown syntax-highlight tokens and the spec-pinning tests are unchanged), and the Idea Board uses it directly — one theme, two surfaces, no copy of the eight tokens | a second `EditorView.theme({...})` literal for the board (the exact duplication the AGENTS centralization rule exists for); moving the markdown `HighlightStyle` into the plain seam (the board must not highlight markdown) |
| **Pick a model — ONE widget for every instance** (docs/17 rows 193 and 199, docs/05 §Top bar/§Settings/§Onboarding) | `features/settings/model-widget.ModelWidget` — THE one model-picking component, two surface variants over one implementation: `field` (label + free-form text input + browse popover; the deleted `ModelInput`'s shape, keeping `id`/`label`/`placeholder` and the size-class props so the dense canvas-chat field stays 44px) and `trigger` (the compact top-bar button the deleted `ModelPicker` was). Both own the SAME popover panel: the account list through the ONE option seam below, the free-form `Use "<typed id>"` entry, the loud no-key / loading / failed-fetch / empty-account states (an empty list never reads as "no models"), and the optional recents. `canBrowse` is the caller's key probe (one input; the widget opens a subscription for neither), and `recentModels` is the RECENTS gate: its PRESENCE (even `[]`) enables the "Recently used" group AND records the pick through `db/settingsRepo.recordRecentChatModel` (above). `tests/architecture/one-model-option-source.test.ts` pins the exact mount population by file and count — the top bar (1), Settings (5), persona (1), Idea Board (1), canvas chat (1), wizard key step (1) — plus `recentModels` exactly at the three global-chat mounts and `recordRecentChatModel(` exactly at the widget + the in-use seam's own file (docs/17 row 198; the run funnel and every other global-model path go through `recordGlobalChatModelInUse`). Callers write through their own `onChange` (each instance persists its own setting) | a second model-picking component or a wrapped `ModelInput`/`ModelPicker`; a copied `/models` fetch; a second recents rendering; a second "is the key present" probe; showing or recording global-chat recents at a persona/image/embedding/fallback/board/session-cache instance (the list would lie about what it means); a closed list that drops free-form entry; an empty Account-models group that reads as "no models" when the real cause is a missing key or a failed fetch (rule 1) |
| **Offer the account's model ids to a model-choice control** (docs/17 row 193) | `features/settings/model-options.listModelIds()` — THE one account model-id option source (`(await listModels()).map(m => m.id)`, the transport cache beneath it), used by `ModelWidget`'s default browse list (both variants, every mount); `fetchOptions` remains the escape hatch for a DIFFERENT list (image models, `listImageModels`). `tests/architecture/one-model-option-source.test.ts` pins the exact `listModels(` population (the transport definition, this seam, and the two named different-purpose consumers: the Settings "Test key" probe and `ReasoningEffortSelect`'s full-row reasoning metadata) | a copied `(await listModels()).map(...)` at a new model-choice surface (a would-be second `/models` fetch); folding the Test-key probe or the reasoning-metadata reader into an ids-only seam (they need the live endpoint / the full rows) |

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
  cures). **The window is the BODY, and an `afterEach` drain cannot close
  it** (docs/17 row 178): the afterEach settles the TAIL, while the delivery
  fires during the test body's own bare awaits — so the cure belongs on the
  raw step (or the shared read helper every caller uses), never on the
  teardown. Measured on `features/creature-portrait-agreement.test`: a 120 ms
  delay on the board's provenance read reds it with
  `An update to BattleSurface inside a test was not wrapped in act(...)`
  (`useLiveQuery`'s subscriber in the stack) though every assertion passes;
  `actDrained` on its two shared read helpers is the cure. **A
  destructive-confirm dialog is settled (its testid
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
- **"Is this idea implemented twice?" is answered by the duplicate-body
  tripwire** (AGENTS §Centralization obligation 4, docs/17 row 172).
  `tests/architecture/no-duplicate-implementations.test.ts` reads every
  `src/**/*.ts(x)` named function/method body through the TypeScript compiler
  API, normalizes it (comments stripped, whitespace collapsed, the function's
  own name and parameter names blanked in value position — property keys stay,
  so `artifact.name` and `entry.title` remain different bodies), and requires
  the population of normalized bodies at 2+ sites at or above **75 normalized
  characters** to EQUAL the checked-in baseline
  (`tests/architecture/duplicateImplementationsBaseline.json`) exactly. A new
  copy reds naming every `file:function:line` and the shared body hash; a
  baselined copy that is folded, renamed or moved reds the stale entry, so the
  baseline is debt a fold FORCES out. It catches identical copies, not
  paraphrases — a tripwire, not a proof. `tests/` is out of scope by design
  (fixtures repeat legitimately); nothing under `src/` is excluded.

## 4. Gotchas

- **Merging test files that share a background puts them in ONE module
  registry — the `--no-isolate` failure mode, inside one file (docs/17 row 176,
  docs/08 §Tests that share one background belong in one file).** Vitest gives
  every test FILE a fresh module registry; a merged file does not. So two
  originals whose `vi.mock` factories DIFFER cannot be merged (the second
  factory never applies — the measured `--no-isolate` red was `vi.fn()` mocks
  not applied), and a `vi.resetModules()` sprinkled in to make them get along is
  evidence that they do NOT share a background, not a fix. A merged file also
  loses its originals' file-scoped `ALLOWED_NOISE` allowance, because
  `tests/setup.ts` scopes the console guard by `ctx.task.file.name`. Merge only
  what shares ONE helper/fixture import and the same provider/Dexie mount, keep
  the merged file under ~120 tests, and leave the act()-heavy family
  (`board-*`, `canvas-*`, `chat-*`, `battle-*`, `creature-portrait-*`,
  `module-reader*`, `persona-run-ui*`) out until the rule is proven further.
  **The sweep (docs/17 row 177) added four measured riders.** (1) A merged file
  shares ONE mock instance per mocked module, so per-`describe` teardown is not
  enough: a previous `describe`'s `mockImplementation` answers a later test's
  `...Once` overflow and its call history persists — every merged file whose
  originals mock needs a FILE-LEVEL `beforeEach(() => { vi.resetAllMocks(); })`
  (outer hooks run before inner, so each `describe` still installs its own).
  (2) The two `test.projects` are a HARD environment split: a `nodeTestGlobs`
  file can never merge with a default-jsdom file, whatever the mock sets.
  (3) A file whose tests leave async background continuations
  (`moduleGen-auto-spine`) cannot merge with files that assert call counts —
  it was measured changing a later describe's `chat` count from 2 to 3, and was
  split out. (4) A `describe` that mutates process-wide globals by direct
  assignment (`cover-art`'s `URL.createObjectURL`, `spawn-picker`'s
  `HTMLElement.prototype.offsetWidth`) goes LAST in the merged file.

- **A global regex used in a LOOP carries `lastIndex` between calls, and the
  loss is SILENT — so a caller that loops `exec` over slices must not share
  the `g` pattern (docs/17 row 145).** `lib/mdToPdfmake.pushWithWiki` runs
  `exec` on the shrinking tail of ONE string, and `parseInline` calls it once
  per slice around every markdown run (`**bold**`, `` `code` ``, `*italic*`).
  MEASURED: with the SHARED GLOBAL `lib/wikilinks.WIKI_LINK_PATTERN`, the body
  `plain **bold** [[Ash Gate]] and [[Kael]] and [[Pier]].` renders
  `['Ash Gate', 'Pier']` — **`Kael` is dropped from the printed PDF**, with no
  error, no warning and no failing test, and the raw token
  `[[ Ash Gate |the gate]]` leaks into the rendered module definition. Nothing
  about the fold LOOKS wrong: the grammar is byte-identical, so
  "import the shared constant" is the obvious move and it is the one that
  ships the bug. The rule: the grammar is ONE source string in
  `lib/wikilinks.ts` with TWO flag variants — `WIKI_LINK_PATTERN` (global, for
  `matchAll`/`replaceAll`) and `WIKI_LINK_TOKEN` (non-global, for a loop) — and
  a non-global regex never reads or writes `lastIndex` at all, which is what
  makes one shared value safe for every looping caller.

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
  3. **What the cast COMPARES, the window must SHOW** (ledger 163). The slot's
     `book` is matched against the library's own title
     (`domain/encounterResolve.citationBookTitle`), so the window prints that
     title beside each name (`Name — Pack Title`). A disambiguator a model
     cannot see is one it must GUESS — and the owner's guessed translations
     («Monsterkern», «NSC-Galerie») narrowed nothing. The title comes from the
     book row and nowhere else, and a creature whose library records no title
     prints its name ALONE (a placeholder is a value the model would copy).
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
- **A fire-and-forget async flush whose failure path updates UI state can reject after the test environment is torn down — and it turns a FULLY GREEN suite red** (ledger 122, MEASURED twice on the pre-fix tree of row 118's page-hide work, and found by the dispatcher, not by a test: `pnpm lint && pnpm typecheck && vitest run` exited **1** while reporting `288 files / 3324 tests` green plus an `Unhandled Errors` block). The stack is the tell: `Unhandled Rejection: ReferenceError: window is not defined` at `getCurrentEventPriority ← requestUpdateLane ← dispatchSetState ← artifact-editor.tsx:251` — React dispatching a `setState` from a promise that settled after jsdom was gone, so `window` no longer exists and the `ReferenceError` reaches nobody, because a page-hide flush is fire-and-forget BY DESIGN (a lifecycle handler cannot hold the page open). **The mechanism, precisely.** `saveDraft` is pending-gated on `lastSavedRef`, which moves only on a write that LANDED; a FAILED page-hide flush therefore leaves the gate open, and the editor's registration effect cleanup is `unregister(); flushPendingEdits();` — so the UNMOUNT flush `cleanup()` runs in `tests/setup.ts`'s `afterEach` re-issues the same draft. Vitest runs a FILE's own `afterEach`s BEFORE the config/setup ones, so a pin that restores its failing-write stub in a `finally` has already restored the REAL writer by then: the retry hits real Dexie, settles later than the environment's teardown, and its continuation dispatches into a dead React. Two probes proved it deterministically (instrumenting `globalThis.window` with a recording accessor reproduced the dispatcher's exact stack; forcing one deferred write with the test ending early produced the same unhandled rejection) — while a full pre-fix suite run came back green, because the race needs teardown to land inside a write's settlement window. **The rule this is an instance of.** A test that TRIGGERS a fire-and-forget chain owns that chain: it must settle what it starts inside the test body, so nothing is in flight when the environment goes away — here, by waiting for the retry to LAND (which closes the gate, making every later flush a no-op). **The fix belongs in the TEST, not in production**, and the seam is where the containment rule is stated: the flush's `try`/`catch` can only contain a synchronous throw, so a flush that returned a promise would put its rejection beyond the seam's reach — hence `PageFlush = () => void`, with the async work `void`-discarded inside each writer (and note the TYPE does not enforce that: an `async` flush is accepted against `() => void`, measured with `tsc --noEmit`). Adding a `.catch(() => {})` to the seam or a caller would silence the SAME signal that exposed this and would double-report the failures the writers already toast by name. **The class is the real cost:** an unhandled rejection reds a run whose every assertion passed, so "1 error" becomes background noise and a GENUINE unhandled rejection hides inside it — which is why this was paid down rather than accepted.
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
- **A NEW thing to ask the spine for does NOT go in a style contract value — it
  goes in the spine call's system message** (ledger 141; the measured
  consequence of the rule above). The spine fixtures
  (`tests/fixtures/promptStyles/spine-classic-*.txt`) keep their ORIGINAL
  "byte-identical to the pre-styles builders" meaning, and that meaning is only
  worth something while the bytes they pin are the bytes the app still composes:
  a clause added to `SPINE_REPLY_FORMAT` / `SPINE_ENTITY_KINDS` (or to a new
  placeholders' value) re-renders the composed spine prompt for EVERY module,
  existing ones included, so it would either red those fixtures or force the
  writer to hand-update them — which retires exactly the provenance they exist
  for. The other half is authority: a contract value lives inside the owner's
  EDITABLE style, so a requirement carried there could be edited away, while an
  app contract must not be. `moduleGen.SPINE_ENTITY_INTENT` is the worked
  example — the entity `intent` requirement rides the same system message that
  already states the reply format ("Always answer in the exact JSON format
  requested"), and the emitted JSON schema (which is NOT part of the composed
  prompt and so has no fixture) makes the property required-nullable. Pinned
  both ways in `tests/llm/moduleGen.test.ts`: the system message carries the
  clause, the composed user prompt does not — with
  `tests/llm/promptStyles-classic-identity.test.ts` green and every fixture
  untouched. Corollary for a field the strict decoder must see: the emitted
  schema states the SHAPE, and anything the strict subset strips (`maxLength` —
  constraints are dropped, §strictSchema) has to be said in prose in the same
  message, from the same constant the runtime boundary enforces.
- **Prompt scaffolding is COMPOSED and DETECTED from ONE source — and the
  detector is only legitimate because the strings are OURS** (docs/17 row 142). A
  model echoed our own brief into a generated artifact and nothing noticed: every
  check in the app is a mechanical one, and none of them compared the output
  against the prompt that produced it. The rule that keeps this sound is that the
  fixed sentences and section labels a brief or a repair prompt is built from are
  exported from `llm/promptScaffolding.ts`, the composers render those constants,
  and `findScaffoldingEcho` matches the SAME constants — so a hand-copied second
  list of "marker strings" is not a smaller version of this seam, it IS the
  defect: it rots the first time a sentence is reworded, and the detector then
  keeps flagging the old sentence while missing the new one. The pin that catches
  the drift is that the composed brief is ITSELF detected
  (`tests/llm/scaffoldingEcho.test.ts`), so a composer that stops reading a
  constant reds it. This is NOT the prose gate §2.2 forbids (a classifier
  guessing at a gate over whether prose is any GOOD): it decides whether a
  specific string we wrote, byte for byte, appears in output — the
  `encounterSourceIssues` / escape-debris class of decidable fact. Two
  consequences: match the FULL literal, never a fragment or a keyword ("do not
  invent new factions" in the GM's own prose is not an echo), and FAIL loudly —
  never strip the sentence and keep the rest (that silently rewrites the model's
  text), never a placeholder.
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
- **A surface that RENDERS art must ask the SAME question the predicate and the
  batch ask** (owner report, docs/17 row 165). The portrait batch, the module gap
  detector and the battle card all asked "which image is this creature's look IN
  THIS CAMPAIGN?" — `db/creatureRepo.creatureCoverImageId`, the ONE reading
  (docs/11 D6) — while `features/play/battle/BattleSurface.TokenView` drew its
  token art from the token's ARTIFACT cover. That was the same answer back when
  every cited chunk had a hidden mob artifact (docs/17 row 106 retired it), and
  after the creature tier it was a DIFFERENT question: a cited creature's token
  has no artifact at all, so the owner saw initials on the battle map for a mob
  the module surface showed a portrait for — and, because the predicate was
  RIGHT, nothing was offered and nothing was enqueued ("generate everything" was
  absent "although mobs miss images"). The tell is the shape of the disagreement:
  one surface reads a place the others stopped writing. When you touch a
  portrait, an image id or an "is this imaged?" question, ask
  `creaturePortraitImageIn` (sync snapshot) or `creatureCoverImageId` (async) —
  and if you find yourself writing "presentation row, else the artifact cover",
  you are re-deriving the rule that already exists.
- **A creature's identity is ONE key, and it is born in ONE seam** (docs/17 row
  165). `domain/creature.rosterEntryCreatureIdentity` answers "which creature is
  this roster row?" for every shape — statful or statless, cited, cast or
  invented — and `db/battleSeed` (both token paths) and
  `features/campaign/mob-portrait-participants.rosterParticipantRoute` both call
  it, which is what makes a token's `creatureKey`, the presentation row's key,
  the global cache key and the predicate's key the same string. While the seeder
  computed it in three arms of its own, a citation the library HEALED by its
  content hash and a `creatureRef` carrying only a content hash each got TWO
  identities — the token pointed at one creature and the portrait row sat under
  another.
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
  legal and rewrites only its prose. AMENDED (docs/17 row 133): the batch's
  description arm is the SECOND caller that refills a cast row in place — it
  targets the row it just cast when the module's text only NAMES the entity — so
  "a refill of one is legal" is now load-bearing for the ordinary generate path,
  and that path must keep going through this one refill (statblock step-off
  included) rather than writing prose beside it. Portraits ARE presentation
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
  (3) **The same date is PRINTED, on the cover — so any capture of a document's
  runs off the ambient clock is a midnight time bomb** (docs/17 row 154):
  `lib/modulePdf.ts` prints `Compiled with Campaigner · ${compiledDay}` from
  `compiledAt ?? new Date()`, so a baseline captured against the wall clock is
  green on the capture day and RED at the next midnight, deterministically, on
  an unchanged commit. It is the SAME seam as (1), and both halves must go
  through it: the byte pins pin `compiledAt` so two re-renders match, and a
  CONTENT baseline pins it so the comparison is about the document instead of
  about the day the suite ran. Concretely: **a date-stamped document is never
  compared, captured or re-rendered off the ambient clock** — pass `compiledAt`
  (the input's own documented purpose), regenerate the baseline under that same
  fixed date so it is stable forever, and pin the REAL-clock behaviour
  separately (`tests/lib/modulePdf.test.ts`), so pinning the clock cannot hide a
  cover that stopped stamping the date. Normalizing the dated run away in the
  extractor was rejected: it removes the only pin that the footer is there.

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
  are read-only (one narrows to `statBlock === null`), `change-artifact` refuses
  cast rows, and the cast writer writes both fields in one literal. AMENDED
  (docs/17 row 133): the emitted `entity-batch` run is no longer always
  `target.artifactId === undefined` — the cast branch now starts its DESCRIPTION
  run AT the row it just cast (`entity-batch.ts:655-665`), so this refusal is
  reachable from the ordinary generate path in exactly one way: if that run ever
  asks for a stat block. The step-off (above, and §2's description row) is what
  keeps it unreachable, and it is PINNED by measurement rather than assumed —
  disabling `isCastCreatureNpc` in `runStatblock` reds the description pins with
  the refusal sentence in the run row (ledger 133, injection I6). The rule for a
  future writer: never add a second creator/merger of these two fields, and never
  "resolve" the pair by preferring one side — a silent preference is how a
  derived number starts disagreeing with the library it cites.
- **THE ROSTER PATH WAS THE SECOND PAIR-BUILDER, and row 112's audit said there
  was only one** (docs/17 row 137, correcting row 112; the code comment at
  `runEngine.ts`'s refill refusal carried the same false claim and now names
  both sites). The `mergeRefillData` refusal above is NOT the only place that
  could put `creatureRef` and `statBlock` on one row. `runEngine.
  materializeMonsterNpc`'s reuse branch — the finalize seam that reuses a
  same-named NPC row for a roster monster — filled a stat-less match with the
  model's inline block, and a CAST CREATURE row is stat-less BY CONSTRUCTION, so
  a roster monster named like a cast row built the refused pair. This is the
  owner's own failing encounter; it was DETERMINISTIC on a fresh retry because
  `anyArtifactSchema.parse` runs BEFORE the write in `updateArtifact`, so nothing
  landed and every retry re-walked the path. And the model was not at fault: the
  fixed-cast brief ORDERS such a participant to embed the library creature's
  block inline (`roomBudget.fixedCastSectionFor`), while the draft contract
  never exposes `creatureRef`, so the model cannot know the two collide. The
  branch now LINKS the cast row and writes NOTHING (`isCastCreatureNpc`, the ONE
  classification — never a second predicate), reusing the "NEVER CONSTRUCT the
  refused pair" rule in docs/11 §A cited row's REFILL; the roster's `npc-ref`
  arm then reads the library's numbers through the ONE derived rule, so nothing
  is lost. The no-fixed-cast variant is covered by the same guard: a
  model-authored block matching a campaign-wide cast row by name — the row's
  citation wins. Do not re-open the write, and do not add a "copy the block onto
  the cast row" special case: the pair is refused by name at the schema and its
  constructor is gone.
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

- **A named seam whose doc comment promises "one wording" is not a seam until
  every site CALLS it — and a catch that decides cancel-vs-failure must read the
  cancel helper, so a guard on a signal nobody passes is not a cure** (docs/17
  row 119; AGENTS rule 4). MEASURED at base `2fabc05`:
  `recordNormalizationFailure` (`src/llm/moduleGen.ts:1133-1135`) carried the
  promise *"ONE wording, so a repair run and a parts pass report it
  identically"* while two sites re-stated its body inline (`:1999` in the full
  pass's own catch, `:2128` in the incremental classification's) and a fourth
  copy sat in the entity panel's belt (`entity-panel.tsx:467`) — and the copy
  that had DRIFTED was `:2128`: the only one of the four catches with no
  `isCancel` guard, on a pass that also handed `normalizationCall` no signal
  (`:2114-2123`), so the stop it could not recognize was the stop it would
  record as the owner's failure. Two rules, both enforced by pins rather than by
  comment. (1) **Every site calls the seam.** The sentence now exists in exactly
  one file under `src/` and the panel reads the export
  (`NORMALIZATION_FAILURE_MESSAGE`, `moduleGen.ts:1136`); the pin is a SOURCE
  SCAN (`tests/features/normalization-failure-wording.test.tsx`), because a
  toast spy cannot see a copy — reverting the panel's belt to its literal, or
  the full pass's catch to its inline copy, leaves every behavioural pin green
  (the words are byte-identical by requirement; only the scan's file list and
  its occurrence count go red). (2) **A cancel guard must be able to fire.**
  `isCancel(error, signal)` is the ONE cancel-vs-failure decision, and it needs
  the run's own signal, so the SIGNAL MUST BE THREADED into the call the guard
  wraps: `classifyNewModuleEntityNames(moduleId, signal?)`
  (`moduleGen.ts:2100`) passes `{ canonicalNames, signal }` into the same
  `normalizationCall` the full pass uses (`:2152`) and guards its catch at
  `:2165`. REACHABILITY IS PART OF THE ENTRY, not an afterthought: no caller
  passes a signal today (both its callers are buttons —
  `entity-panel.tsx:484`, `resume-automation.ts:187` — and the resume sweep's own
  entry points are buttons too), the pass has no run row, no `'generating'` forge
  row and no canvas handle for Stop all to find
  (`features/progress/stop-all-generations.ts:92-138`), and the stop epoch gates
  only the NEXT unit (`lib/stopEpoch.ts:14`), so this guard is DEFENCE and its
  own doc comment says so. Read a guard's presence as a shape, never as coverage:
  the pin that proves it is an aborted controller handed to the pass directly.
  A catch that has no signal must NOT re-derive the decision privately — it reads
  `signal !== undefined && isCancel(error, signal)`, which keeps the pre-existing
  verdict for a signal-less call instead of reading an `AbortError`'s type as a
  user stop (`isCancel`'s own doc, `moduleGen.ts:209-217`: the signal is the
  source of truth, not the error's type).
- **One condition, two audiences: a toast about a refused ACTION and a reason on
  a blocked CONTROL are not the same sentence** (ledger 120). "This module
  already has a generation running" reaches the owner through two surfaces that
  ask two DIFFERENT questions — a catch block whose action the module's single
  generation slot refused, and a disabled control that was never pressed and
  only needs its state explained — and the audit found the first written out
  seven times as a literal and the second three times as a private constant
  (plus a fourth copy inline in `entity-panel.tsx`, which ledger 123 folded
  onto `MODULE_GENERATING_REASON`). MEASURED that they are
  genuinely two audiences and not one string used twice: mutating
  `MODULE_BUSY_TOAST_TITLE` leaves EVERY blocked-control pin GREEN (35 tests
  across `blocked-reasons`, `spine-checkpoint`, `generate-everything`,
  `blocked-control`) and REDs the toast pin, while mutating
  `MODULE_GENERATING_REASON` does the exact inverse (`blocked-reasons` +
  `spine-checkpoint` RED, every toast pin GREEN). So fold the FACT into one
  module (`features/modules/module-busy.ts`) and keep the two SENTENCES
  distinct — collapsing them would answer the control's question with the
  refusal's words, which is the "two different questions merged" half of
  rule 4, not centralization. Three riders, all measured rather than assumed:
  1. **A behavioural pin verifies the SENTENCE, never the ROUTE.** Reverting a
     folded call site to the inline literal leaves its own toast pin GREEN
     because the arguments are byte-identical (`module-board-rewrite` stays
     green at `BoardPage.tsx:197`), and re-duplicating a same-valued constant
     leaves the rendering pin green too (`spine-checkpoint.test.tsx`). The
     routing is therefore held by a SOURCE SCAN in
     `tests/features/module-busy.test.ts`, which says in its own doc comment
     that it is a scan.
  2. **A value-based scan is blind to a REWORDED copy** (it searches for the
     exact sentence), so the two sentences are pinned separately as constants
     with independent copies in the test — the scan is a backstop for
     RE-DUPLICATION, not for rewording.
  3. **The raw error's `.message` must not be the detail line.** `toastError`'s
     description is `error.message` by default, so an internal id
     (`Module <id> is already generating`) rode into the owner's toast as a
     uuid; the toast seam now drops the description for that error BY NAME
     (`lib/toast.ts` cannot import the class — `llm/moduleGen` already imports
     it — so the name is the contract, and it is pinned against the REAL class
     rather than left implicit) and logs the raw error to the console instead.
     **Ledger 123 then cured the message ITSELF**, which row 120 had named as the
     better fix and deferred: it is `This module is already generating — wait for
     it to finish or stop it first.` and the row id rides structurally
     (`ModuleBusyError.moduleId`, enforced by the compiler: removing the field is
     a TS6133 at `tsc -b`). The name-matched suppression is KEPT — its reason
     changes rather than its behaviour (the title already names the state and
     both ways out, so the refusal's own sentence as a description would say the
     same thing twice in one toast) — and it was MEASURED that the suppression
     pins pass for the NAME: reverting the reword REDs only the new message pin
     (1 of 8) and leaves both of them green.

- **Copies of a comparison rule drift into DIFFERENT rules before anyone
  notices, and folding them back is INVISIBLE to every behavioural pin — so the
  fold needs a source scan, and the scan is the pin that holds it** (ledger 121).
  MEASURED on this slice, on a shared 8-core box with `CAMPAIGNER_TEST_WORKERS=2`,
  one suite at a time. (1) **The drift.** "Add this name to an artifact's alias
  pool, case-insensitively, without duplicating" was hand-rolled SIX times, and
  the six copies implemented THREE different comparison rules: five compared
  `trim().toLowerCase()`, `ModuleReaderPage.linkExisting` compared
  `toLowerCase()` on both sides UNTRIMMED, and `moduleGen`'s variant filter
  compared the stored pool trimmed but never against the artifact's own name at
  all. The untrimmed one is the one with a live consequence: a stored alias
  `"Kael "` (an imported row, a backup restore, an older writer) already answers
  `[[Kael]]` — the RESOLVER trims, `wikilinks.ts:177` — so the reader appended a
  duplicate `"Kael"` that `entity-batch.alignEntityName` skipped: one name, two
  rows, and a pool whose spelling depended on which surface touched it last.
  Every individual site looked correct on its own, which is exactly why six
  copies survived an audit pass that was looking for them. (2) **A fold is
  invisible to behaviour, so it cannot be pinned behaviourally.** Reverting ONE
  of the six folds and re-running the suites that cover it: `runEngine`'s
  encounter-refill site → **52 behavioural pins GREEN** (2 scan pins RED);
  `runEngine`'s generate-persona site → **17 GREEN** (2 RED);
  `moduleGen` → **91 GREEN** (2 RED); `stub-popover` → **34 GREEN** (2 RED);
  `entity-batch.alignEntityName` → **7 GREEN** (2 RED). The fold is
  byte-identical BY CONSTRUCTION — same value, same writes — so the only thing
  that can see a half-done, partial or later-reverted fold is a scan of the
  SOURCE, counted per file (`tests/features/alias-merge-seam.test.ts`, labelled
  as a scan in its name and in this doc). The two folds that CAN be seen
  behaviourally are the two that changed a rule: the reader's trim
  (`module-reader.test.tsx`, its own RED) and the prose-only branch's
  duplicate-append (`encounterRepopulate.test.ts`, its own RED). (3) **A brief
  can promise a behaviour change that the code makes unreachable**, and the
  honest answer is to measure it rather than to write a pin that cannot fail:
  the expected "`moduleGen` stops writing a self-name alias" is impossible at
  HEAD — the pass only records a variant when `canonicalKey !== nameKey`
  (`moduleGen.ts:2221`) and finds the artifact BY that canonical key (`:2224`),
  so the variant is structurally guaranteed ≠ the artifact's own name — the fold
  there is byte-identical and the self-name rule is defence, pinned at the rule
  and the write path instead. (4) **A surface that looks reachable may not be**:
  the reader's untrimmed comparison is reachable ONLY through the stub popover's
  editable Name field, because a name the resolver answers can never produce an
  unresolved chip (the resolver trims) and the reader's resolution pool
  (`useArtifacts` + library, `ModuleReaderPage.tsx:124`) is a SUPERSET of the
  picker's (`useScopedArtifacts('moduleView')`) — so the UI pin drives that
  route, and the row/ledger say so instead of implying a chip click was enough.
  (5) **The audit missed a seventh copy** (`campaign-tree.tsx:313-317`), found by
  the seam's own scan-shaped review rather than by the audit. That slice reported
  it in §5 instead of folding it (a third behaviour change it was told not to
  smuggle), and **ledger 123 folded it**: both untrimmed comparisons are the
  seam's now, the `BOUNDARIES` carve-out is DELETED and the file joined the
  counted `FOLDED` set (docs/08 §The two deferred folds and the busy message's
  own sentence).

- **A negative DOM assertion built on TRANSIENT UI state is a flaky pin, and
  the cure is to AWAIT the transition — never to sleep, never to loosen it**
  (ledger 124). `tests/rules-page.test.tsx` failed about one full gate in two
  with `expect(element).not.toBeInTheDocument()` on a live
  `div[data-slot="tooltip-content"][data-open=""]` — measured to be the reason
  POPUP of the very control under assertion, mounted with no hover from the
  test; `document.activeElement` was that control's own `…-blocked` wrapper.
  Both edges of a Base UI tooltip popup are the framework's own asynchronous
  transitions: it is mounted while the tooltip is open and removed after the
  exit animation's frame (`internals/useAnimationsFinished`: one
  `requestAnimationFrame` + a microtask, then a `flushSync` unmount — jsdom
  takes exactly that path, `Element.getAnimations` is stubbed empty in
  `tests/setup.ts`). So a synchronous absence assertion is a race against
  whatever the APP does on its own schedule, and this app opens the reason
  ITSELF wherever it puts FOCUS on a held control: a Base UI menu's own focus
  placement lands on the held item's wrapper (`useFocusableWhenDisabled` — the
  disabled item is not natively focusable, the wrapper's `tabIndex=0` is the tab
  stop, §2.3) and `BlockedControl` opens the reason on focus BY DESIGN. That is
  a correct pin on a racy instant, not a broken assertion — and it is not an app
  defect either: the reason really is delivered through `BlockedControl`, never
  through a `title` Chrome would not show.
  The cure is ONE seam behind every reason pin
  (`tests/helpers/blocked-reason.dismissOpenPopup`): (1) drain what the app has
  already scheduled (`flushAsyncUpdates`, the suite's own drain), (2) hand back
  the two triggers it can have used (pointer away, focus away), then (3) AWAIT
  the removal. Step 3 is also the non-vacuity half, and it is why the assertion
  was not relaxed instead: a popup that is always rendered cannot be dismissed,
  so it fails LOUDLY on the timeout rather than passing on a wrapper that opens
  nothing. Two shapes are rejected by this rule: a `setTimeout` sleep (it
  guesses a duration the transition owns) and dropping the assertion (it stops
  pinning anything). The falsifier ships WITH the fix — a test-side drain at the
  exact site (the delayed cause) that turns the pre-fix tree RED 3 runs of 3,
  while the pre-fix tree WITHOUT it stays green on repetition alone, which is
  why repetition was never evidence.
- **A `title` beside a `BlockedControl` is invisible, and it is exactly where a
  second, drifting copy of the reason grows** (ledger 125, MEASURED). The
  wrapper is the tooltip trigger and the tab stop (§2.3), so the sentence is
  already delivered on hover AND on focus; the child's own `title` adds no
  fallback, because a natively `disabled` control is reached by no pointer
  event and no key. What it does add is a SECOND place to write the same
  sentence: the audit found FIVE wrappers whose child carried one, and
  re-verification found TWO more — seven in `src/` — and the copies had already
  diverged in shape: four were `title={reason ?? description}`, one a bare
  `title={reason}`, and two restated the wrapper's own sentence in a branch
  (one of those, `encounter-repopulate`, under a comment that blessed the
  duplication by name — *"its own sentence, already in the `title`"*). The rule
  that came out of it, and the one the scan pins: **the wrapper's `reason` is
  the ONLY home of a reason**; a `title`
  inside a wrapper may only carry the DESCRIPTION of what pressing the control
  does, and only gated on the control being able to act
  (`title={blocked ? undefined : '…'}`) — on a live control that is a surface
  the owner really has. Two shapes are forbidden, because they are the two the
  defect took: a bare identifier or a nullish-coalesce (`title={reason ?? '…'}`,
  where which half is visible depends on the state and the reason is the
  invisible one), and a branch whose string is also in the wrapper's own
  `reason`. `tests/features/blocked-control-title-scan.test.ts` is a SOURCE scan
  and says so. **ALL SEVEN sites are folded (ledger 127), and the scan carries
  NO known list**: ledger 125's two-entry `KNOWN_RESTATED_TITLES` (asserted by
  EQUALITY as a transition device) was deleted in the same commit that folded
  the two it named, so `restatedTitleViolations()` must now be EMPTY — an
  allowance must not outlive its cause, which is rows 123/125's own lesson
  applied to its own device. Three things the scan cannot do. (1) It reads
  `src/**` as text (a sentence COMPOSED at runtime is invisible to it). (2) It
  needs `reason={…}` written as a bare identifier to be resolved one level to
  its `const` declaration — MEASURED, without that step the `branch` rule is
  blind to a collapsed reason and a title restating it reads as clean (the
  first run of injection I3 came back GREEN on the scan for exactly that
  reason, which is why the resolution exists). (3) NEWLY MEASURED (ledger 127
  injection I3, GREEN on purpose): the `branch` rule compares LITERALS, so a
  reason that reaches the wrapper through a FUNCTION CALL has no literal in the
  `reason={…}` span at all, and a title quoting that sentence verbatim reads as
  clean. `generate-everything` is that site — its reason comes from
  `generateAllBlockedReason()` — so only the `shape` rule guards it, and a
  literal restatement injected into its held branch
  (`src/features/modules/entity-panel.tsx:862`) left the scan GREEN 2/2 while
  the two behavioural pins RED. The blindness is reported, not papered over:
  closing it needs a scanner that parses ternaries and function bodies, and the
  shape rule already catches the shape this control's defect actually took.

- **An error path copied four times can be pinned ZERO times — and a
  copy-pasted RATIONALE is what makes the copies read as deliberate decisions**
  (ledger 126, measured). The "generate ONE image and prepare it for storage"
  tail stood in four files byte for byte (`cover-image-queue.ts:94-103`,
  `entity-image-queue.ts:87-96`, `mob-portrait-queue.ts:351-360`,
  `mob-portrait-cache-queue.ts:197-207` at base `d6b54fa`): assemble the
  contract, `generateImages(prompt, 1, …)`, refuse an empty result, intake.
  Each copy carried the SAME explanatory comment ("candidate-count caps cannot
  trigger on this path"), and that is exactly what made four copies of one tail
  read like four places that had each thought about it; a fifth site words the
  same fact completely differently (`runEngine.ts:4491`, "The image model
  returned no map images…"). MEASURED: `grep -rn 'the image API returned no
  image' tests/` found NOTHING — the refusal that stands between an empty API
  answer and a silently blank cover or portrait was asserted by no test
  anywhere, in any of its four copies, and nothing failed when three of the
  four were deleted. A duplicated failure branch is therefore worth LESS than
  its line count suggests: it looks defended because it is repeated, and it is
  defended once per copy by nothing at all. The seam is `llm/oneImage.ts` and
  its refusal is pinned by name in `tests/llm/oneImage-seam.test.ts`.
  Two further measurements from the same slice, both counter-intuitive:
  (1) **a fold is invisible to behaviour** — reverting EACH of the four folds
  to its byte-identical pre-fold block left 60 pre-existing behavioural pins
  GREEN (11 + 6 + 27 + 16) with only the source scan red, so the scan is the
  pin and behaviour is the regression net; (2) **`Blob` deep equality is
  CONTENT-BLIND in vitest** — passing a DIFFERENT Blob to the intake
  (`intakeImage(new Blob(['other']))`) left all 9 seam pins GREEN, because two
  Blobs of different bytes have no own enumerable properties and compare deep-
  equal. `expect(mock).toHaveBeenCalledWith(blob)` therefore asserts that SOME
  blob reached the intake, not WHICH bytes; the pin needs reference identity
  (`expect(mock.mock.calls[0]?.[0]).toBe(raw)`). Any pin that asserts a Blob
  argument by value anywhere in this suite has the same hole.

- **Adding an export to `llm/runEngine.ts` obliges the three PARTIAL mock
  factories that fake it — and only the one whose pins reach the new line
  NEEDS it** (ledger 128, MEASURED). `tests/features/entity-batch-fixed-cast.test.ts`,
  `tests/features/change-artifact-instruction.test.ts` and
  `tests/llm/moduleGen-cast.test.ts` all `vi.mock('@/llm/runEngine', …)` with a
  factory that lists the members the code under test reads (`isRunWithdrawn`,
  `runEngine`, `waitForRunStatus`) — deliberately, so the predicate stays REAL.
  Vitest's mock proxy throws only when a MISSING export is ACCESSED, so a new
  member is invisible until a pin drives the line that calls it. MEASURED by
  injection: dropping `runNotCompletedReason` from the entity-batch factory REDs
  the two pins that reach the batch's reason line (the withdrawal pin stays
  green — the predicate answers first); dropping it from the OTHER two factories
  left 25/25 GREEN, because every run those files fake is `'completed'`. Those
  two entries are therefore a latent-trap guard, not coverage — say which one a
  pin is when you add it.
- **The `runNotCompletedReason` scan is a CALL-COUNT and it is comment-BLIND**
  (ledger 128, MEASURED while writing it). It counts the literal
  `runNotCompletedReason(` per file, so a doc comment that mentions the helper
  WITH a call parenthesis — `` `runNotCompletedReason(run, label)` `` — reads as
  a second call site and REDs the route pin. The seam's own comments (and the
  boundary comment in `features/campaign/encounterRegen.ts`) therefore name it
  WITHOUT one; that is a constraint of the instrument, not a style rule, and the
  same blindness means a copy that composes the sentence through an intermediate
  variable is invisible to it (the pin's header says so).

- **A source scan cannot see a copy that arrives through a NAMED PREDICATE**
  (ledger 129, MEASURED twice on the encounter-map offer). The offer scan
  (`tests/features/encounter-map-offer-scan.test.ts`) holds the panel's routing
  with four needles — the gap DISJUNCTION, the two FIELD names, and the offer
  seam's own call count and pinned emitter line — and the measurements split
  them apart rather than lumping them: (a) a truthiness spelling
  (`!a.data.layout || !a.data.mapImageId`) does NOT match the disjunction needle
  but IS caught by the field needles; (b) a copy that borrows the queue's own
  per-artifact guard —
  `artifacts.filter((a) => a.kind === 'encounter' && a.moduleId === module.id && encounterNeedsMap(a))`
  — matched NONE of the first three needles, left the scan GREEN 2/2 and the
  count pin GREEN too, and needed a fourth needle (banning `encounterNeedsMap(`
  in the panel) to red; (c) folding the DECLINED pending filter into the emitter
  line reds the scan's VALUE pin while 29/29 behavioural pins stay green. So a
  byte-identical or behaviourally-identical copy is invisible to behaviour and
  must be caught by a needle that names the SHAPE the copy took — which is why
  the needles are enumerated in the scan and in docs/08 rather than summarised
  as "the scan guards this". The residual blindness is stated, not implied: a
  copy arriving through a FUNCTION CALL in another module that itself calls
  `encounterNeedsMap` is still invisible (the ledger 125/127 lesson one level
  deeper), and the needle set is comment-BLIND — a comment in the panel naming
  the guard WITH a call parenthesis would red it, so this seam's comments name
  it without one.


- **A slug seam's scan cannot see an EQUIVALENT spelling, and the per-caller
  CALL COUNT is the backstop** (ledger 130, MEASURED). `tests/lib/fileSlug.test.ts`
  holds the fold with needles for the two halves of the idiom (`[^a-z0-9]+/g, '-'`
  and the `^-+|-+$/g` trim), the seam's signature pinned as a value, the seam-call
  COUNT per caller, and a ban on naming the slug alphabet in a caller. The
  measurements separate them: replacing a call site with
  `name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-') || 'artifact'`
  matched NEITHER idiom needle, so only that file's count red it — an equivalent
  spelling is invisible to a needle that quotes a spelling. Adding the same copy
  BESIDE a surviving seam call (count unchanged) red the alphabet needle instead.
  What is STILL invisible: a spelling that names a different class for the same
  alphabet (`[^A-Za-z0-9]`, `\W`), and a hand-rolled slug in any file that is not
  one of the four named callers (the needle list is per-caller, so a NEW caller
  inherits nothing) — the call count is the only thing that reaches those, and it
  reaches them only when the caller STOPS calling the seam.


- **A batch failure's toast vanished in four seconds, and the console said
  nothing at all** (docs/17 row 131, MEASURED — do not "rediscover" it as a
  rendering bug). `lib/toast.toastError` passes NO `duration`, so sonner's own
  default applies: `TOAST_LIFETIME = 4000` (`node_modules/sonner/dist/index.mjs:470`,
  sonner 2.0.8), and the app's single `<Toaster>` (`app/layout/AppShell.tsx:229`)
  sets no `duration` either, so `toast.duration || durationFromToaster ||
  TOAST_LIFETIME` resolves to 4000 ms. The entity batch's summary was raised
  through exactly that helper, which is the owner's "vanished quickly". It was
  ALSO the only record: nothing on that path reached `console.error`, and the
  progress dock carries no failure field (`lib/progress.ProgressJob` has
  `id`/`label`/`detail`/`progress`/`href`) and drops the job on finish
  (`entity-batch.ts` calls `progressFinish(jobId)`). So `toastErrorPersistent`
  (`duration: Infinity`) is the helper the file's own doc names for "a failure
  nothing else caught" — and for a `refused` or a `setup-error` failure there is
  not even a failed run row to fall back on: a refusal's run COMPLETED, and a
  setup throw before `startRun` leaves no row at all.

- **The error ICON is not a closer, and the app rendered no closer at all**
  (docs/17 row 136, MEASURED — the owner's *"That error message is still on my
  screen and the little closer it has does not close it"*, and do not
  "rediscover" it as a rendering bug). The app's `Toaster`
  (`components/ui/sonner.tsx`) draws its error type with `OctagonXIcon` — an
  octagon containing an X — so a persistent notice showed an X-shaped glyph that
  is DECORATION, while sonner renders a real close button only when
  `toast.closeButton ?? toaster.closeButton` is truthy
  (`node_modules/sonner/dist/index.mjs:521-526`, conditional at `:842`). Nothing
  in `src/` set either, so `toastErrorPersistent`'s `duration: Infinity` was a
  PERMANENT notice: no X, no timer, no other exit, and the owner clicked the icon.
  Two rules come out of it: the seam asks for the close button PER TOAST
  (`closeButton: true`, so the app's 4-second toasts are untouched — a global
  flag on the `<Toaster>` is the rejected design, and the pin that says so is
  `tests/lib/toast-persistent-dismiss.test.tsx`'s transient case), and no SECOND
  dismiss affordance is added beside it (AGENTS rule 4 — a labelled "Dismiss"
  `ToastAction` was considered and declined because sonner already answers
  "dismiss this toast" with a button). The icon itself is left alone: overriding
  it only on persistent notices would make one error look different depending on
  which seam raised it. Pinned by accessible name + a real click, never by the
  glyph or `data-close-button` — a pin keyed to the markup would survive the
  control becoming unreachable, which is the defect.

- **"Cancelled" is TWO different facts in this codebase, and the difference is
  the difference between silence and a failure report** (docs/17 row 131,
  MEASURED). A run whose `status` is `'cancelled'` is the WITHDRAWN owner-stop:
  `entity-batch.ts` reads `isRunWithdrawn` first and records NOTHING (row 117's
  silence, pinned at three surfaces). A run killed by a page reload is
  `status: 'failed'` with `failureKind: 'cancelled'` —
  `db/runRepo.failRunningRuns` (called from an `AppShell` mount effect) writes
  exactly that — so it takes the failure arm and used to reach the owner as
  "N of M npcs failed to generate". The batch therefore names it
  `interrupted`, never `cancelled`, and the payload carries the run's own
  `failureKind` + `errorMessage` beside its status. **The row cannot separate a
  reload from a genuine abort**: `llm/failureKind.failureKindOf` returns
  `'cancelled'` for any `DOMException` named `AbortError` (`failureKind.ts:35`)
  and `failRunningRuns` writes the same value, so both are indistinguishable in
  `failureKind`; only the `errorMessage` literal ('Interrupted by reload', the
  default argument of `failRunningRuns`) tells them apart, and copy is not a
  classifier — the seam names the class from the ROW's own vocabulary ("cancelled
  or interrupted", the label `domain/run.FAILURE_KIND_LABELS.cancelled` shows)
  rather than claiming to know which one it was.

- **A batch's `refused` failure has no caller that can reach it at HEAD — read
  this before "fixing" its absence from a log** (docs/17 row 131, reasoned from
  the code and MEASURED at the guard). `entity-batch.ts`'s cast guard fires only
  when the run's `resultArtifactId` is a CAST CREATURE npc. Every caller that
  creates entities passes a target with no `artifactId` (`post-generation.batchTargets`,
  the panel's unresolved buckets, `entity-detail.generateSingleEntity`), which the
  engine's generate finalize turns into `createArtifact` — a FRESH row — and
  `dataForDraft('npc', …)` never writes `creatureRef`; the only creator of that
  field is `db/creatureRepo.castCreatureAsNpc`. The one caller that DOES pass
  `artifactId` (the change lane) refuses a cast creature BEFORE the batch runs
  (`change-artifact.resolveChangeRoute`, `:240-247`, consulted at `:396-397`).
  So the guard is a belt whose input no path supplies today: the pins in
  `tests/features/entity-batch-fixed-cast.test.ts` drive it with a faked engine,
  which proves the BRANCH, not its reachability. A name that resolves only to a
  library creature is still generated as the module's own entity (that path is
  pinned in `tests/features/creature-row-resolution.test.tsx`), and an entity the
  module RECORDED a bestiary slot for is CAST — a SUCCESS, in `result.cast`,
  never in `result.failed`.

- **An identity assertion is only available for a value the site hands over
  untouched** (docs/17 row 131, MEASURED the hard way). `EntityBatchFailure.raw`
  is pinned with `toBe` for the run row and for a thrown error (the batch stores
  the reference it was given). It canNOT be pinned that way for a `refused`
  failure: the raw value is the destination artifact read through
  `artifactRepo.getArtifact`, which zod-parses the stored row, so **every read
  returns a fresh object** — `expect(failure.raw).toBe(<the same row read in the
  test>)` failed against CORRECT code before the pin was changed to content
  equality plus a field-level assertion. Lesson: before writing `toBe` on a
  value, check who produced it — a repo read is a copy.

- **The record the owner pastes is a TEXT LINE, and that is a deliberate shape**
  (docs/17 row 131, MEASURED). A console row carrying `[jsonString, object]` is
  inspectable but not faithfully copyable — devtools renders its own (truncated)
  preview of the object argument into whatever gets copied — so the pasteable
  record is emitted as a SINGLE string argument, and the live object is a
  SECOND entry under a DIFFERENT tag (`[campaigner] entity-batch detail …`). The
  distinct tag is not cosmetic: while both entries began with the record tag, a
  parser reading `[campaigner] entity-batch failure …` could not tell the JSON
  line from the human one (MEASURED — the parse threw on
  `run-not-completed`). Two further measured properties of that line: it is
  produced from the very object the batch summary shows (`summary` deep-equals
  `payload`, so a field cannot exist in one and not the other), and a value
  `JSON.stringify` cannot serialize (a cycle, a `BigInt`) yields a line that
  SAYS `unserializable` rather than throwing — throwing there would abort the
  batch, and a reporting failure must never become a generation failure.

- **Two facts may not share one key in a diagnostic payload** (docs/17 row 131,
  MEASURED the moment the per-failure record was written). The batch's kind
  (`npc`/`location`/…) and the failure's class (`refused`/`interrupted`/
  `run-not-completed`/`setup-error`) both wanted to be `kind`; spread in one
  object, the failure's class silently OVERWROTE the batch's kind and the record
  became unreadable in a way no shape pin could see. The batch's kind is
  `batchKind` in every record; `kind` means the failure's class, which is the
  field the owner named. Same family as the two spellings of "cancelled" above:
  this payload's whole job is to be unambiguous to someone diagnosing from one
  line.

- **A new `console.error` in a code path the suite exercises fails EVERY test
  that reaches it** (`tests/setup.ts` §Console guard). The batch-failure entry is
  deliberate output from a real failing batch, so `entity-panel.test.tsx` needed
  documented `ALLOWED_NOISE` entries, scoped PER FILE and matched on the
  record's own tags (`[campaigner] entity-batch failure|summary|detail` and the
  `<kind> batch: N of M failed` headline). FOUR files needed one, and the count
  is itself the measurement: recording moved into the BATCH (so the record
  survives a batch that never reports), and `moduleGen-cast.test.ts` +
  `stop-orchestration.test.ts` started failing the guard the moment it did —
  the guard caught the new output in files nobody had thought about, which is
  exactly what it is for. A FIFTH file that starts driving a failing batch will
  fail with `Console noise leaked into …` rather than silently joining the
  allowance; the fix is a documented `why`, never a spy that hides a real
  regression (the files that PIN the records do spy — they assert the value,
  which is a different thing).

- **A source scan for this fold has a MEASURED hole, and it is stated rather
  than implied** (docs/17 row 131, docs/08 §The fold is invisible to
  behaviour/§A batch failure is reported through ONE seam). The seal
  (`tests/features/entity-batch-failure-report-scan.test.ts`) pins the seam's
  caller SET by equality, the files that contain the count sentence by
  equality, four composition needles, and that the seam raises both surfaces.
  Injected one at a time: reverting either call site's fold REDs 3 scan pins
  (behaviour green at the sweep, red at the panel because its pins assert the
  persistent helper); re-adding the plain copy BESIDE a surviving seam call
  REDs 2. **The attack it was not designed for walked through**: the same
  sentence rebuilt from pieces (`['failed','to','generate'].join(' ')`,
  `${kind}s` for the plural, `String.fromCharCode(59)` for the join,
  `'see the '+'Runs '+'tab'` for the tail) beside a surviving call left the scan
  **GREEN 5/5** and all 35 behavioural pins GREEN. Nothing in the suite catches
  that; a needle list quotes a spelling, and this copy has no spelling to
  quote. A `.join('; ')` needle was tried first and REJECTED for firing on
  healthy code in both files (`entity-panel.tsx:678`, `post-generation.ts:453`) —
  a needle that fires on correct code gets deleted, so the count sentence's own
  tail is a needle instead. The needle loop short-circuits on the first match.

- **The `module:<title>` compatibility tag lands only after the batch's target
  POOL drains, by design — so a produced row is observable WITHOUT it for a few
  milliseconds** (docs/17 row 132, docs/08 §A barrier must cover the FIELD it
  asserts). In `features/modules/entity-batch.ts` the per-target leg renames the
  row as soon as its own run settles (`alignEntityName`, `:639`), while the tag
  is stamped by the post-batch loop that runs only once
  `mapConcurrency`/`mapWithConcurrency` has drained the WHOLE pool
  (`:691-703`). Between those two revisions the artifact is a normal,
  module-owned row — module ownership is set from birth via
  `placementModuleId` (`:587-589`), which is what the wiki-link resolution and
  the post-run battlemap read — it simply does not carry the tag yet. That state
  is BENIGN and must not be "fixed": the tag's only readers are the batch's own
  idempotence check (`:697`) and the cast re-stamp
  (`db/creatureRepo.ts:580`), no UI surface filters on it, and stamping earlier
  would buy an extra revision (or a differently-timed write) for no product
  reason. The ordering DOES cost a test barrier, and that is where it bit: a wait
  satisfied by the rename (a row of the right name existing) does not cover the
  tag, which is how `tests/features/creature-row-resolution.test.tsx` raced it.
  Assert the tag INSIDE the wait — the cure there (`:482`) and the pattern
  `entity-panel.test.tsx:765-771` already uses — never after a weaker one.

- **A cast creature npc's DERIVED STATS were rendered NOWHERE the owner looked —
  CLOSED by docs/17 row 134 (opened at row 133, where his *"no text, no stat
  block, nothing"* was measured as two defects and this was the second one).**
  The record of the gap, because it is the reason the seam exists: the design is
  that a cast row's numbers come from the library creature at READ time, and
  `db/creatureRepo.resolveDerivedNpcStats` was the ONE read built for that — with
  **zero callers in `src/`** (MEASURED at `ef8744d`: only its own definition and
  `tests/db/creatureRepo.test.ts:135,141`), while the encounter roster derived
  through `domain/encounterResolve` and `NpcForm`
  (`features/campaign/components/kind-forms.tsx:129-168`) rendered `StatBlockCard`
  only when `data.statBlock !== null`, otherwise an "Add stat block" button — an
  affordance that can never produce anything on a cited row (the cited-row refill
  refuses such a block before any model call, and `npcDataSchema` refuses to keep
  the pair). What a future edit must PRESERVE now: the derivation is ONE rule
  (`domain/encounterResolve.resolveDerivedNpcStats`, repo-wired as
  `db/creatureRepo.resolveDerivedNpcStats`), the render is ONE component
  (`features/campaign/components/borrowed-stats.BorrowedStatBlock`) MOUNTED by
  `NpcForm` and by the read-only `NpcCard`, the numbers are never written onto the
  row, the borrowed label (`Borrowed from the library` + the disclosed origin
  `NPC: <name> (stats from <book p.N>)`) is what separates them from an authored
  block, and a cited row is offered NO "Add stat block". Do not "discover" the old
  gap as a regression, and do not conclude from the absent button that a cast row
  has no numbers — it has the LIBRARY's, always derived, never stored. A missing
  library creature and a citation carrying neither key are both LOUD: the first
  renders the named `missing ref (<the creature>)` in place, the second is an
  error surfaced in place AND through `lib/toast` (never a blank stat area).

- **A cast row's description may be written by a persona run, and that is the ONE
  case a name appears in BOTH `cast` and `failed`** (docs/17 row 133). When the
  module's text only names the entity, the batch runs her own persona against the
  row it just cast and lets the cited-row refill write the prose; if that run does
  not complete, the artifact EXISTS (cast landed, citation intact, portrait on it)
  and the prose does not — so the batch reports it in `failed[]` while the name
  stays in `cast` (the artifact is the cast's; the run only wrote into it, it did
  not create it). Do not "fix" the overlap by moving the name to `generated` (it
  would lie about where the row came from) or by silencing the failure (the owner
  would find a bare row later, AGENTS rule 2). A withdrawn run is silent at both
  arms.

- **Built-in persona text is DISCRETIONARY — an enforcement rule can never live
  there** (docs/17 row 140; owner decision). `seed.seedBuiltInPersonas` adds a
  built-in persona only when its slug is ABSENT (`db/personaRepo.ts:32` states
  it: *"Built-in seeding skips existing slugs, so old rows are never rewritten"*),
  so a built-in prompt is a seed-once STORED row: editing
  `llm/personas/builtins.ts` reaches a NEW install only, and every install that
  already exists keeps the old bytes forever. That is why the Worldbuilder/Event
  Weaver monster clause of `fe1d365` reached nobody (ledger row 10) and why the
  kind-keyed OWNERSHIP BOUNDARY lives in `buildEntityBrief` instead. The owner
  was asked whether to refresh un-hand-edited built-in rows so an edited prompt
  reaches an existing install, and DECIDED AGAINST IT, verbatim: *"If the user
  wants to regenerate things with a new prompt he can already do so, so... no
  need for that. I dont see that as something that will happen often-"*. The
  consequence is the rule: **persona text is style, emphases and habits**, the
  user's channel is Settings → Personas → Reset to default (then regenerate) and
  it is expected to be rare, and **a rule that must hold for everyone has to be
  in code**, at a seam every call passes through. A later agent must not "fix" a
  boundary, a refusal or a contract by editing `builtins.ts` again — the prompt
  may still SAY it (both non-combat prompts do), but the prompt is not where it
  is enforced.

## 5. Known debt (live divergences at HEAD — do not "discover" them)
- **The single-artifact GM export's OWN stat block does not go through the
  text→blocks rule yet** (§2.3, docs/17 row 146). `lib/pdfExport.statBlockSection`
  renders an npc's/pc's authored block with its own `named()` and `labelValue()`
  rows — one run per entry, so a multi-paragraph appearance/personality or trait
  body still prints as one blob on THAT path. It is the third consumer of the
  same idea. It was NOT folded in row 146's landing because `labelValue` returns
  `{columns} | null` and is called from ~20 sites, so routing it through the rule
  turns a column into a stack at every one of them — more churn in re-pinned
  definition dumps than the defect costs on the path the owner reads most (the
  roster/mob box and every module-PDF prose field DO go through the rule, since
  `statBoxContent` is shared). Fold it by giving `labelValue` the same
  multi-block shape the rule prescribes, in its own slice.
- **The three notation residues of docs/17 row 149 are CLOSED by row 170 — read
  that row before re-opening them.** Each needed a rule the seam did not have,
  and each now has one (all three in `src/ingest/packs/text.ts`):
  1. `@Embed[Compendium.dnd5e.tables24.RollTable.dmgBagOfBeansEff rollable
     caption=false]` (`tests/fixtures/packs/dnd5e-equipment/bag-of-beans.yml`)
     stored `dmgBagOfBeansEff rollable caption=false` and now stores
     `dmgBagOfBeansEff`: `@Embed` is a THIRD `@`-notation kind, and its
     space-separated option list is dropped **by rule** (the options configure
     how the embed renders) while the first whitespace-delimited token still
     resolves by the last-dotted-segment rule. The split is scoped to the
     `@Embed` kind — a UUID target may itself contain a space
     (`Item.Peaceful Rest`, `Effect: Aid`), which is a pinned non-regression.
  2. `&Reference[prone]` (`tests/fixtures/packs/dnd5e/saber-toothed-tiger.yml`)
     survived VERBATIM because the prelude's `&reference[…]` rule was
     case-SENSITIVE; it now carries the `i` flag, so the corpus' own
     `&amp;Reference[prone]` stores `prone`. A rule fix, not a declaration.
  3. `@Damage[(ceil(@item.level/2))[persistent,acid]]`
     (`tests/fixtures/packs/pf2e-rules/acid-splash.json`) stored
     `level/2))[persistent,acid]` — a fragment from the MIDDLE of the
     expression; the `@`-notation scan reads its brackets BALANCED now and
     stores `(ceil(@item.level/2))`, the bracketed damage-TYPE sets dropped
     **by rule** (machine descriptors) and the formula kept verbatim. This one
     had NO fixture pin; row 170 added it.
  Each is now pinned as the FIXED behaviour in
  `tests/ingest/packs/html-to-text.test.ts` (the two dnd5e fragments flipped in
  place, the nested-bracket one through the real `pf2e-rules` adapter), the
  rules are stated as differential sample rows, and each affected lane's digest
  moved. The ONE surviving declared residue in this family is the SYNTHETIC
  `&reference[Compendium.dnd5e.rules.x]{Ruling}` differential case
  (`reference form`): a `{Label}` written AFTER a `&reference[…]` target stays
  in the text, because the prelude replaces the link with its target before the
  brace rule runs. **No fixture carries that shape**, so it stays declared
  rather than being fixed behind a fixture nobody has; the real, fixture-borne
  uppercase spelling is item 2 and IS fixed. The three affected entries' stored
  citations face the row-149 re-import consequence unchanged (re-import the
  pack, re-pick the creature).
- **CLOSED (docs/17 row 171): a top-level ARRAY is a document STREAM, unwrapped
  one level in the seam — so the failure REASON can no longer lie.** The debt
  docs/17 row 147 recorded here was: all five JSON lanes share
  `packs/text.parseJsonDocs`, which tried `JSON.parse(trimmed)` first, so a file
  holding `[{…creature…}, {…creature…}]` yielded ONE document, the array
  itself, which every adapter skipped as "not a document I know". The import
  then failed with the zero-valid reason, and the reason was false comfort:
  `no valid creature entries in the pack selection (1 skipped, 0 failed) — book
  "Array Book" marked as error`. MEASURED at `tests/fixtures/packs` shapes: the
  same two creatures as NDJSON (one JSON object per line) import fine
  (`entries: ['Goblin Warrior', 'Wolf'], skipped: 0, failures: 0`), while the
  array form gave `entries: 0, skipped: 1, failures: 0` and the message above.
  **THE RULE NOW (both families, one seam):** a top-level array is unwrapped ONE
  level into N documents by whichever helper parsed it — `parseJsonDocs` for a
  whole-file JSON array, and `parseYamlDocs` for a top-level YAML sequence,
  which needed the SAME fix rather than a declaration (MEASURED with the repo's
  own js-yaml: `loadAll('- a\n- b\n')` returns ONE document, the array). A
  document's own array FIELDS are untouched; a top-level array OF arrays yields
  the inner arrays as documents, which `isDocumentRecord` rejects and the lane
  counts as skips (ONE level, never a recursive flatten); the NDJSON arm does
  not unwrap, because there the top level IS the line stream. An EMPTY
  top-level array throws `<file>: top-level array holds no documents` — it
  never resolves `[]`, which would be a file accounted NOWHERE. The count is
  fixed by fixing the PARSE, not the message: a non-document element is skipped
  PER ELEMENT, so two wrapped folder documents are `skipped: 2`. Pinned through
  the REAL adapters (`foundry-pf2e` on `[baseNpc(), folderDoc()]` imports the
  creature and skips the folder; `foundry-dnd5e-equipment` on a top-level YAML
  sequence maps both items) and at the seam in
  `tests/ingest/packs/parse-docs.test.ts`. **The one test that used to feed an
  array** (`tests/ingest/packs/pf2e-foundry.test.ts`, `encodeJson([baseNpc(),
  folderDoc()])`) asserted only that no network call happened; it now asserts
  the parse OUTCOME.
- **The module document's LAYOUT arc is BUILT except its last step.** What this
  entry used to call "v1-shaped, and v2 not built" is now history: the page model
  (MAIN COLUMN + SIDEBAR, detail tiers) with adjacency and the overflow ladder
  (docs/17 row 148), navigation/back-references (row 151), the ToC's real page
  numbers (row 156), automatic planning on every export (row 139) and the
  planner's toolkit — real module text, the wiki graph and each row's stored
  fields, under one LOUD character budget (row 169) — are all in. **docs/19 is the
  design of record and its §11 strikes match this entry; check them before
  believing any claim here.** What genuinely remains: §11 step 6, PRINT REFINEMENT
  (duplex spread pairing), which the owner DEFERRED (docs/19 §10.4) — not
  "obvious" work; plus one follow-up recorded by row 169: a module whose own text
  alone exceeds `MODULE_PLAN_CONTENT_BUDGET_CHARS` is cut LOUDLY rather than given
  its own budget, and a split text/detail budget is the next step if real plans
  fight the cap.
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
  `llm/campaignGrounding` → `features/campaign/mentionView.whereLabel` (the ONE
  home of the `where` label convention, 14 §2; the private byte-identical copy
  in `llm` was deleted by docs/17 row 145 — its output is STORED as an
  `ExpansionExcerpt.source` and rendered back into the prompt on resume, so two
  spellings would store a different label than the reader shows);
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
- **`awaitCompletedRun` also keeps its own "why this leg did not finish"
  SENTENCE — the one caller that does not adopt `runNotCompletedReason`**
  (ledger 128; the bullet above names the function at the base-SHA line `:93`,
  which ledger 128's boundary comment moved to `:121`). Two facts decide it,
  and both are about the LABEL rather than about taste: (1) the label names
  WHICH LEG of a chained operation died ("Regenerate everything (content)" vs
  "(battlemap)" vs "Prose redesign"), and the engine's own sentence cannot
  carry that — both legs brief under the SAME step name — so adopting the seam
  would delete the only place the owner can read which leg evaporated after one
  click; (2) the engine already surfaces its own sentence on this path (the
  run's failure toasts it), so the message rides here as a colon-suffixed
  DETAIL behind the leg, exactly as the three folded sites ride it AS the
  sentence. The FALLBACK branch is byte-identical to the seam's own fallback
  under this label, so "ended <status>" still means one thing app-wide; only
  the non-empty composition differs. Pinned as a boundary rather than left
  implicit: `tests/llm/encounterRepopulate.test.ts` pins BOTH branches
  (`Repopulate ended failed: <engine sentence>` and `Repopulate ended
  cancelled`) and the scan in `tests/llm/runNotCompletedReason.test.ts` records
  this file as the only other composer of the fallback formula and REDS if the
  site is folded without moving the docs and those pins with it. Do NOT adopt
  the seam here without an owner decision — and do NOT read this as licence to
  fold `isRunWithdrawn` in either (the bullet above stands unchanged).
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
- **The duplicate-body tripwire's FIRST capture found 16 duplicate groups /
  46 sites in `src/` at base `7b390de` — the seven `isRecord` helpers the
  owner named are only 7 of the 46 sites.** Every group is recorded (with a
  reason) in `tests/architecture/duplicateImplementationsBaseline.json`, which
  is DEBT, not a licence. The ones worth naming here so nobody "discovers"
  them as fresh work:
  - `parseFile` ×7 (all seven pack adapters) and `titleCase` ×3 and
    `publicationSourceLine` ×2 — the same pack-adapter duplication family as
    `isRecord`; row 171's landing (or its successor) owns the fold.
  - The image-queue trio `mob-portrait-queue.ts` / `cover-image-queue.ts` /
    `entity-image-queue.ts` copies `workerCount` ×3 — and its `settledDetail`
    copies normalize to 74 characters, ONE character under the floor, so the
    tripwire does not compare them (a floor decision recorded, not a silent
    gap).
  - The `Missing*` panels ×3 (`MissingModule` / `MissingBoard` /
    `MissingCanvas`), the local `Field` label wrapper ×2, `getChunkByContentHash`
    ×2, the three `on()` emitters ×3, `levelDistance`/`levelDistanceTo` ×2 and
    `duplicatedAcrossBooks` ×2, `extensionOf` ×2, and `getArtifactStatBlock`
    defined twice inside `runEngine.ts`.
  Each entry's `reason` names the seam a fold should extend; the tripwire reds
  the moment a copy moves, so a fold cannot leave a stale blessing behind.
