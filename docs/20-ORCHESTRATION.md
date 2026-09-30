# 20 — Orchestration: the board

**Current state only.** History is `docs/17-DECISION-LEDGER.md` (what was
decided, and why); seams are `docs/18-ARCHITECTURE.md` (how the code works).
This file is the chief of staff's memory that outlives its own session
(`AGENTS.md` §Chief of staff): in-flight writers, unlanded branches, and the
owner's decision queue. It is **overwritten in place, never appended**, and it
must stay ONE SCREEN.

**COMPACTED 2026-09-21** at the owner's word (*"that mega board is cluttering
things up"*). The pre-compaction board — every historical LANDED record, every
closed reservation, every guard's full text, every decision's verbatim quote —
is ONE COMMAND away, and is the archive for anything not restated here:
`git show 3200807:docs/20-ORCHESTRATION.md`. Nothing was dropped that this file
does not point at.

The PROCESS this board serves — roles, record vocabulary, the gate, the
verification doctrine, the brief template and the porting checklist — is
described self-containedly in `docs/22-DEVELOPMENT-PROCESS.md`.

## The contract

1. **Record grammar: one line per fact, stable prefix, `field=value` pairs.**
   `grep '^IN-FLIGHT' docs/20-ORCHESTRATION.md` is the query, and the answer is
   one line — not a prose block to ingest.
2. **Updated in the same commit as the landing it records** (the `docs/18` §0
   rule), and **true before the CoS reports a landing to the owner**: if the
   session dies the second after that report, a successor must be able to act
   from nothing but this file, `docs/17`, and git.
3. **Every record names something checkable** — branch, worktree, session id,
   SHA, path. Prose about state rots; a claim that can be tested does not.
4. **The reconciliation is the enforcement.** No test can see branches or
   sessions; `bash scripts/board.sh` checks every claim below against git, the
   session directories and the host, and finishes with `BOARD RECONCILED` or
   `BOARD STALE`. Session start runs it before anything is dispatched.
5. **A SESSION and an IN-FLIGHT record name the MODEL** (`model=<provider>/<model>`).
   A plain `subagent`/`subagent_fork` inherits the session's route, so that is
   what it says; a worker dispatched through a `workflow` can carry a different
   one, and the record says which, because a landing's quality is only comparable
   across experiments if the model that produced it is on the record.
6. **THE BOARD IS BOUNDED, AND THE BOUND IS A TEST** (added 2026-09-21, when
   this file had grown to 349 dense lines): `tests/architecture/one-board-rule.test.ts`
   reds when the file passes 140 lines, when any line passes 500 characters,
   when a `LANDED` row is not `LANDED | row=N | sha=<hex> | verify=…`, or when
   no GATE GREEN landing remains. **A landing therefore PRUNES the oldest
   LANDED row** — history is `docs/17`'s and git's business, never a growing
   tail here.

## Board

```
reconciled: c84c08c · 2026-09-30 · GATE GREEN on Linux (422 files / 5189 tests, wall 683s) over rows 417-418 (code tips 6fefb24 and 8fb6865): the undetailed-link hover and the chat's link rules, both landed Windows-verified and now covered by this integrated run. No writers in flight. QUEUED: dungeon rework, 361, 363-364. Remainders (yours): derived spine/parts view, stored levelPlans/levelStates.
LANDED | row=415 | sha=10279f6 | verify=GATE GREEN (419 files / 5175 tests; typecheck + lint clean, 0 voided, the integrated run at 10279f6, docs-only ahead of the 6ca9b54 code tip). A HIDDEN TAB NO LONGER PAUSES THE STREAM TIME LIMITS; only a FROZEN one does (freeze / bfcache), so a backgrounded tab stops reporting "paused". This run also covers rows 412-414, whose records keep their Windows-only provenance.
LANDED | row=412 | sha=ab43028 | verify=WINDOWS ONLY (see reconciled). THE CHAT'S WAITING IS VISIBLE: every model call of a canvas chat turn is its own progress-dock entry (reply, follow-up, the review's critique + edit) with model and live phase; fallback named; "paused — the browser reports this tab as hidden" when the watchdog clock is paused; the bubble shows cumulative text (it showed the last token). One reporter: llm/streamProgress.
LANDED | row=413 | sha=1419b5c | verify=WINDOWS ONLY (landed as bebd110, one pin fixed forward in 1419b5c). A STOP REACHES THE WORK: waitForRunStatus cancelOnAbort threads the chat's Stop into <change> runs; canvasBusy.cancelCanvasGeneration makes Stop work across Edit/Preview; openrouter.httpErrorOf bounds every error-body read (15 s). 1419b5c fixed the one pin it broke.
LANDED | row=414 | sha=a60fa62 | verify=WINDOWS ONLY (landed as a98ff88, eslint fixed forward in a60fa62). A CHAT-BORN MODULE IS NORMALIZED ON ITS FIRST GENERATION: the dialog names unclassified linked names and Generate runs the gate first, then re-derives the selection.
DECIDED-OWNER | id=paused-watchdog | 2026-09-30 | OPTION A: a HIDDEN tab no longer pauses the stream time limits; only a FROZEN one does (freeze / bfcache). LANDED as row 415.
LANDED | row=416 | sha=307f14a | verify=GATE GREEN (420 files / 5178 tests; typecheck + lint clean, 0 voided, the integrated run at 88fbbe3, docs-only ahead of this row's code tip 307f14a). A SYSTEM PICKER BESIDE NEW CAMPAIGN (it was always Generic d20); the rulebook and bestiary system selects folded into the one GameSystemSelect.
LANDED | row=417 | sha=6fefb24 | verify=GATE GREEN (422 files / 5189 tests; typecheck + lint clean, 0 voided, the integrated run at c84c08c). UNDETAILED LINK HOVER: kind, level, intent, cast creature and variants from the module record; four record reads folded onto entityRecordFor.
LANDED | row=418 | sha=8fb6865 | verify=GATE GREEN (422 files / 5189 tests; the same integrated run at c84c08c). THE CHAT IS TOLD WHAT TO LINK: llm/wikiLinkRules shared by chat, refine and parts (locations, factions, events were never asked for).
LANDED | row=419 | sha=a5e4a0d | verify=WINDOWS ONLY (tsc 0, eslint 0, dialog + run pins, injection; Linux gate owed). GENERATE CLOSES AT ONCE: the run has its own dock entry naming its step; that entry blocks a second run.
QUEUE | SMALL | FOLLOW-UPS FROM 413/414: (a) encounter-map-queue keeps its own abort→runEngine.cancel path (different settle semantics, recorded in row 413); (b) the entity panel's accept-proposals write re-implements applyNormalizationVerdict's rewrite+save (row 414); (c) tests/features/canvas-module-actions.test.tsx leaks act() noise intermittently on Windows (3/4 runs on the base) — check on the Linux gate before chasing.
QUEUE | DUNGEON REWORK (owner research, not briefed) | Paint ONE unlabeled organic dungeon; a vision model DETECTS rooms as points plus notes; the app draws the markers. Owner test 15/15. RULES: an undetected room is an empty room (ONE read, no re-asks, never fail on a miss); merge near-duplicate points; markers editable in v1; a painted figure is a warning. Paint and read models are SETTINGS. NO batch measurement (model-dependent). WAITS for the owner’s own experiments.
DECIDED-OWNER | id=pc-assistant-shape | 2026-09-27 | THE PC ASSISTANT'S FORMAT IS THE APP'S OWN STAT BLOCK (his pick of two, option A): level/features/feats as traits+actions, proficiencies in saves/skills, the real spell list in spells, the rest as prose. NO new `pcSheet` payload (REJECTED — dead data no reader owns). The pc lane also drops the corpus whitelist, the caster clause and the spell repair/"Unresolved mob spells" notice.
NOTE | deploy | THE AUTO-DEPLOY IS GONE: `cc0179a` ("remove the Actions auto-deploy — the old host is retired") deleted the FTP workflow, authored by the project identity but NOT by this dispatcher. CONSEQUENCE: a push no longer publishes, so the live site and its badge FREEZE at the last deployed build; "confirm the publish" is replaced by "confirm the push" (`git ls-remote`) until the owner says how he deploys now. The badge is no longer an honest window onto HEAD.
REVERTED | row=366 | sha=be6099f | note=GALLERY FAVOURITES WERE BUILT, GATED GREEN AND THEN REVERTED at the owner's request (asked in the wrong chat: "please stash the gallery work and revert it"). The revert is `778a8f7`; the work is PRESERVED on the pushed branch `gallery-favourites-stashed` at `be6099f`, recoverable by cherry-pick into the chat it belonged to. Nothing else was touched — see row 368.
SESSION  | cos=session-c2da6d4f-3506-428f-a828-de12da4f3fbb | started=2026-09-20 | model=deepseek-official/deepseek-flash | state=STOPPED (superseded 2026-09-21) | note=THE LONGRUN CoS: landed rows 276–302, retired every writer/worktree/branch it opened; its last pushed tree `9424f09` deployed GREEN.
SESSION  | cos=session-66d8aa43-ffdd-43e3-b637-06ec93548dbb | started=2026-09-21 | model=deepseek-official/deepseek-flash (inherited route) | state=STOPPED (ARCHIVED 2026-09-21) | note=reconciled at `9424f09`, fixed nine stale records and compacted this board (row 303). Its last event is an `approval/asked` at 18:33:41 for a `danger-full-access` write to `~/apps`, so its apps.futuremagic.de publish never completed (it fails closed); nothing was staged.
SESSION  | cos=session-b276401e-48d8-4c02-b2fb-7494264a77da | started=2026-09-20 | model=deepseek-official/deepseek-flash | state=LIVE (owner-designated 2026-09-21) | note=reconciled at `0b2b2b2`; landed rows 274, 275, 304–309, the dedup arc 312–316 (one census RED fixed forward), rows 319, 322, 323 (positive image text rule; workspace artifact selection; in-use entities not reported) and the AGENTS commit-pathspec guard (`07f227b`). Holds ONE standing goal, PAUSED; wake events only.
NOTE | older CoS sessions and every reconciliation before 2026-09-21 are in this file's git history (`git log --follow docs/20-ORCHESTRATION.md`); nothing needed to act is in them.

DECIDED-OWNER | id=publish-on-push | 2026-09-21 | EVERY PUSH TO `main` IS A DEPLOY, and the publish is CONFIRMED (workflow conclusion + live badge), never assumed; a failed deploy is NAMED with its run link and what is still live, and pushing continues. Verbatim: *"always publish when you push."* Binding in AGENTS §Workflow.
DECIDED-OWNER | id=no-regex-on-free-text | 2026-09-20 | FREE TEXT IS READ BY THE MODEL, never by a pattern; if a value must be exact the FORM becomes structured. Binding as AGENTS rule 5, and the WHOLE TREE is in scope.
DECIDED-OWNER | id=clean-cut-no-migrations | 2026-09-20 | ABOLISH THE MIGRATION LAYER — a clean cut that REFUSES old data instead of migrating it (owner: losing data is fine in the test phase). LANDED: `db.ts` carries ONE `.version(31)` with no `.upgrade()` bodies, plus `db/cleanCut.ts` and the cleanCut notice.
DECIDED-OWNER | id=one-level-source-of-truth | 2026-09-20 | A MOB HAS ONE LEVEL, and it is the one its STATS say — two places may never disagree (verbatim: *"There should be only 1 source of truth about a mob level."*).
DECIDED-OWNER | id=level-target-policy | 2026-09-20 | How a mob level is targeted when the module states none: module hint first; else around module level for encounter participants; non-encounter mobs infer from significance.
DECIDED-OWNER | id=mob-spells-invented | NO — the AI may not invent spells; it assigns only spells that resolve in the imported library, and anything unknown is a LOUD named issue plus an unresolved chip.
DECIDED-OWNER | id=mob-spells-heightened | COMPLETE heightening via the Paizo formula: `fixed` = highest `heightening.levels[L]` with L <= cast rank, `interval` = the (+N) increment per rank step. LANDED as part of the row-181 arc.
DECIDED-OWNER | id=mob-copy-remaining-now | DISPATCH THE WHOLE REMAINING ROW-248 SLICE NOW — the module arm (`entityKinds[].bestiary`), the per-row guard, and deletion of the pointer arms for converted rows — rather than holding the deletion until v24 had been exercised on real data; the safer REJECTED alternative is in the archive.
DECIDED-OWNER | id=red-deploy-reported | A FAILED DEPLOY IS REPORTED with its run link and what the live version therefore still is; pushing continues (verbatim: *"Just tell me so i know the current version is not up."*).
DECIDED-OWNER | id=battle-belongs-to-its-encounter | 2026-09-19 | ONE battle per ENCOUNTER: starting encounter 2 opens encounter 2's own board and nothing running is ever replaced.
DECIDED-OWNER | id=no-core-references-in-modules | STOP ALL REFERENCES TO CORE ITEMS INSIDE MODULES — core items are always only ever COPIED (verbatim: *"That also gets rid of dependencies when saving/loading campaigns."*).
DECIDED-OWNER | id=copy-arc-mechanisms | 2026-09-19 | the three copy-arc forks, all recommendations accepted: (1) GLOBAL library artifacts ADOPT into the campaign as a real copy — the campaign is the unit of save/load; (2) SPELLS copy the full entry INCLUDING its `publication {title, license}` line, with the export-size cost MEASURED not assumed; (3) SCOPE = module and campaign content only — run state (`personaId`, `pinnedChunkIds`) is deliberately NOT in the rule.
DECIDED-OWNER | id=library-is-ingest-only | THE LIBRARY IS AN INGEST SOURCE ONLY — no runtime dependency on it may remain (verbatim, told the battle rows still pointed at a library row: *"Imagine i refetch the monster core. It has a new version."*).
DECIDED-OWNER | id=library-isolation-complete | CAMPAIGN DATA MUST BE COMPLETELY ISOLATED FROM LIBRARIES — no stored library reference of ANY kind, including an identity key.
DECIDED-OWNER | id=landscape-enforced-in-the-manifest | KEEP `manifest.orientation: "landscape"` — the owner REJECTED removing it (verbatim: *"this is a web app on ipad. It really does not work good in non landscape mode."*).
DECIDED-OWNER | id=recommendations-accepted | EVERY OTHER RECOMMENDATION IS ACCEPTED (verbatim: *"lets go with your recommendation."*). The list as put to him, the sequenced iPad slices and the standing defaults he did not veto (wake lock AUTO; an absent battle view restores quietly while a corrupt one is loud and player-safe) are at `.gate-logs/plans/decisions-and-recommendations.md` and `.gate-logs/plans/ipad-battle-readiness.md`.
DECIDED-OWNER | id=dice-engine-release-between-uses | KEEP THE RELEASE of the dice engine when the roller leaves use — a dispatcher default under the owner's blanket acceptance, VETOABLE IN ONE COMMIT.
DECIDED-OWNER | id=all-players-in-every-battle | 2026-09-21 | EVERY CAMPAIGN PLAYER IS IN EVERY BATTLE, ALWAYS ("All campaign players need to be in all battles, always."). Players need HP, NOT stats, so `statBlock: null` is no longer a precondition for appearing; a NEW player's HP defaults to **20**, never 0. REVERSES docs/09 §M5-C step 4 and its pin ("leaves statless PCs unspawned") — whose loud badge was never implemented; `db/fighterStats.ts:114`'s silent `continue` is the defect.
DECIDED-OWNER | id=prose-assertions-are-absolute | 2026-09-21 | PROSE ASSERTIONS ARE ABSOLUTE, FILL UP WHAT'S MISSING. The reading model TRANSCRIBES the scene's stated cast into a checkable list (surfaced to the owner, stored for resume); the app ENFORCES it — presence required (repair then FAIL LOUDLY), asserted cast EXEMPT from the budget (so the repair cannot drop it), a substitution NEVER covering an asserted figure. The FILLER stays free; NO CAP; the scene outranks any bounded spec.

QUEUE | row RESERVED 347 | ARC — AWAITING THE OWNER'S GO-AHEAD | THE ITEMIZATION ARC (docs/12 §17, docs/17 row 345): items as game content PLUS loot itemization, the owner's own pairing. Proposed Phase 1 = the item library page + item detail card, mirroring `features/spells/SpellsPage`, `spell-card.tsx` and the `routes.ts` table — additive, schema-free, no non-goal reversed. Phases 2-3 (structured loot; inventory, awarding, coins) REVERSE a recorded non-goal and wait for his word.
QUEUE | row RESERVED 348 | SMALL — the same defect class, a DIFFERENT seam | A RETRY OF THE CLASSIC MAP STYLIZE STEP DROPS TYPED TEXT: `runStep` dispatches `stylize` WITHOUT the `extraInstruction` argument (`runEngine.ts:3029`), so a retry from the Details view loses the owner's words silently. NOT row 346's seam: `runEncounterStylize` composes from the Cartographer's structured plan and has no direct-instruction line, and `usabilityBans` must stay last — own design and pins.
QUEUE | row RESERVED 351 | SMALL — an OWED PIN | THE HEALED TOKEN'S OWN STORED HP IS ASSERTED BY NOTHING: deleting the repair's HP patch leaves ALL 9 pins GREEN, because the journey pin reads HP through `combatHpForToken`, which derives from the frozen seed row and defaults. Found by the dispatcher's own arm C and probed for VOIDness (bytes changed; the resolver explains the green). Add the direct assertion.
QUEUE | row RESERVED 361 | SMALL — an OWED PIN | A TEXTLESS-PREMISE REFUSAL IS UNASSERTED: inverting the target check in `chatChanges.missingTargetReason` (so a premise with no text reports the PART refusal) leaves all 48 pins GREEN — the dispatcher's own arm B, probed and confirmed a GAP rather than a void arm. Add the assertion for the premise arm's message.
QUEUE | rows RESERVED 363-364 | ARC — GM ASSIST (docs/17 row 362): 363 = PERSIST the second thread (`gmChatThread` + the ONE `chatPersist` writer parameterised by field — one writer, no new table); LOAD-BEARING, since "keep the chat informed what actually happened" means the thread must survive a reload to BE that record. 364 = the STORY-side context: the GM's own narration in the thread, plus the module's story content and the party — NOT the encounter or the battle.
AWAITING-OWNER | id=itemization | cost=an ARC in 3 phases | question=CORRECTED (row 345): the old `claimB-pack` premise was REFUTED — dedicated item adapters DO ingest equipment packs; only equipment EMBEDDED IN A CREATURE doc is missing. PROPOSED additive-first: Phase 1 = an item library page + detail card mirroring the SPELLS seams; Phase 2 = an OPTIONAL structured loot list beside the prose, REVERSING a recorded non-goal (§13.6); Phase 3 = inventory/awarding/coins. Go-ahead on Phase 1?
QUEUE | id=campaign-arc-rework | OWNER-APPROVED 2026-09-28; spec `docs/23-CAMPAIGN-ARC.md` | order=CHAT FIRST | DATA=CLEAN CUT RATIFIED | entity rule=FIRST mention, but a PREMISE (level-0) entity gets NO automatic level — a NAMED hint, else FREE model inference (the premise may already name the end boss) | phases: 0 spec DONE; 1 the document + version(32); 2 one module per campaign; 3 the chat from nothing; 4 level-scoped generation. NEXT=PHASE 1.
QUEUE | row RESERVED 381 | SMALL — owner-requested, PHASE 3 (the chat) | TWO LEVEL-ADDRESSED COMMANDS: `replace_level N` and `append_level N` (append to level N, or CREATE it when N = max+1). THE PREMISE IS LEVEL 0: no separator, everything before the first `=====Level 1=====`, so the SAME commands edit the premise — no `replace_premise`. The APP writes the separator and number, so the model never emits the scaffold. Invariant: an existing level or exactly max+1; out of range is LOUD.
QUEUE | row RESERVED 234 | MEDIUM — needs the owner's go-ahead | THE MODULE-GROUNDING EXCERPT SEAM SILENTLY TRUNCATES AND MATCHES BY SUBSTRING (`lib/wikilinks`): queued rather than fixed because it changes a shared seam.
QUEUE | row RESERVED 248 | LARGE — SLICE 1 LANDED (the v24 migration + stamping); the REMAINING SLICE is scoped in docs/18 §5: the MODULE arm (`entityKinds[].bestiary`, through the ONE library name-matching seam) plus pointer-arm deletion for CONVERTED rows. Owner: `mob-copy-remaining-now`.
QUEUE | row RESERVED 255 | OPEN UMBRELLA for "no stored core references": the rule landed across the module/reference families (255a/255b/255c) and the adoption family (257/268), and the clean cut removed the unconvertible-row blocker it once carried; it stays open for whatever a later isolation sweep finds.
QUEUE | row RESERVED 262 | iPad battle readiness — the sweep and the plan are done (`.gate-logs/plans/ipad-battle-readiness.md`); the sequenced slices remain.
QUEUE | row RESERVED 279 | SMALL, deliberately batched with the next code slice | STALE CODE COMMENTS still name the removed v22/v24 Dexie upgrades and deleted seams.
QUEUE | row RESERVED 292 | POSTPONED BY THE OWNER (verbatim: *"That is postponed, we dont need that for some time."*) | PDF/TXT PROSE TO STAT-BLOCK EXTRACTION: a MODEL read, or NO extraction at all with a structured form (rule 5's own preference). Priced by the read-only scan `b11ab1cb`; its report is `.gate-logs/discoveries/free-text-regex-scan.md`.
QUEUE | row RESERVED 296 | SMALL, OPTIONAL | an architecture pin ENUMERATING the allowed pattern-over-text sites, so a new free-text reader reds at birth the way the duplication tripwire does.
QUEUE | row RESERVED 310 | MEDIUM — SUBORDINATE, unblocked | THE FILLER SPEC: the app hands the model a bounded composition spec for what the scene leaves OPEN (`roomBudget.expectedRoomThreat` already computes expected levels + an approximate count, and `drawFillGrade` is the existing draw-once RNG precedent). It NEVER outranks the scene (row 309).
QUEUE | row RESERVED 311 | SMALL — batched with the next code slice | SIX OWED PINS, each found by an arm that stayed GREEN: a statless PC with a NON-ZERO `initiativeOverride`; the deep-link reload into a live board that misses a new player; row 309's IN-PLACE-FILL exemption; row 313's two `on` delegates; row 323's orphan-group heading COUNT; and row 327's selection RESOLUTION, which would take library rows unguarded — only the missing checkbox keeps them out.
QUEUE | row RESERVED 318 | SMALL — batched with the next code slice | ONE OWED PIN the dedup arc's own arms exposed: `features/modules/missing-entity-panel.MissingEntityPanel` has NO behavioural pin (nothing asserts the message it renders or that its back link goes to `modulesPath(campaignId)`) — its fold is proven a byte-MOVE by the tripwire hash, but a wrong link target would ship silently across all 7 render sites.
QUEUE | row RESERVED 321 | SMALL — owner may veto | THE ENCOUNTER LEVEL CHAIN IS NOT SELF-REPORTING: `budgetAdvisory` renders (`kind-forms.tsx`), but neither the RESOLVED TARGET level nor each mob's own level is shown, so a level-9 mob in a level-1 room stays invisible whenever the target itself resolved high or the figure was asserted/exempt (row 309). The owner's level-9 report is CLOSED-UNREPRODUCIBLE — he deleted it, suspects a model fluke; a panel screenshot is the cheap capture.
QUEUE | row RESERVED 330 | SMALL | LEDGER TABLE-INTEGRITY PIN — the escape is DONE (row 335): 33 in-code pipes escaped, proven structure-preserving (every pre-existing row’s TRUE cell count compared HEAD against the edit: 0 changed). What remains is the PIN: no unescaped pipe inside a code span, and a row whose real cells differ from its own table header. 20 rows still disagree with their nearest header for other reasons (older 3/4-column eras) — the pin lands WITH that triage.
QUEUE | row RESERVED 343 | IN FLIGHT — owner defect | THE SPAWN DIALOG *STILL* DOES NOT SCROLL on iPad with MANY SCREENS OF MOBS. Cause CONFIRMED in-repo: `HelpDialog` scrolls the SAME inner `flex-1` body because its dialog is a DEFINITE `h-[80vh]`, while the picker is only `max-h-[85vh]` — WebKit does not bound a child under a `max-height`-only parent, so it clips. Fix = a hard definite height via ONE shared seam; the base cap stays. THREE dialogs: SpawnPicker, SetupWizard, peek-modal.


```

Older landings are `docs/17`'s business — this section is not a history.

## Guards (why this workflow has teeth)
```
GUARD | failure=stale workers | where=the DSH core offers only `send_message`/`interrupt_agent`/`list_agents`; the installed `dsh-plugin-subagent-delete` adds `delete_subagent`/`release_subagent`/`list_subagents` (finished one-shots included). Retiring a verified landing = session deleted + `git worktree remove --force` + `git worktree prune` + branch deleted, and NEVER delete a running writer.
GUARD | failure=RAM / worker storms | where=`scripts/gate.sh` is the ONE way the suite runs: an atomic lock at `<repo>/.campaigner-lock` (the same path from every worktree), at most TWO chunks with ONE worker each, a combined-RSS watchdog at 3000 MB with a 90% fallback to sequential before the kill line, and VOID chunks re-run and never counted. Never hand-roll a gate, and never pipe one through `tail`/`head` — a pipeline returns the tail's status, so an unverified landing can be committed.
GUARD | failure=context / compaction | where=the route is `deepseek-flash` and compaction is pinned in `~/.dsh/profiles/web/cordis.patch.yml` (maxTokens 65536, 2 retries). Evidence goes into docs, never into the thread.
GUARD | id=the-inflight-row-dies-in-the-landing-commit | how=THE IN-FLIGHT ROW AND THE LANDED ROW ARE ONE RECORD AT TWO TIMES, so the commit that records a landing MUST delete its IN-FLIGHT row in the same commit.
GUARD | id=a-landing-closes-its-reservation | how=A LANDED SLICE MUST CLOSE ITS OWN `QUEUE` RESERVATION in the same board commit, or the queue lies about what is left.
GUARD | id=in-repo-scratch-must-be-lint-ignored | how=EVERY in-repo directory that can hold scratch SOURCE files must be in `eslint.config.js` ignores (`worktrees`, `.gate-logs`), because the main tree's lint run walks the whole repo.
GUARD | id=green-reaches-the-badge | how=`scripts/buildStatus.mjs` reads the NEWEST GATE GREEN `LANDED` record on HEAD's ancestry from THIS file, so a compaction must keep at least that one record parseable (`LANDED | row=N | sha=<hex> | verify=…`) — `one-board-rule.test.ts` pins exactly that, because a compacted board that cannot be parsed makes the badge answer `cannot-tell`.
GUARD | id=job-wake-budget | how=A SETTLED BACKGROUND JOB STOPS WAKING THE SESSION AFTER THREE CONSECUTIVE COMPLETIONS with no user message in between. A WRITER therefore gates IN-TURN (its background jobs die with its turn); the DISPATCHER's landing gate may run in the background only under the lock and the memory ceiling, watched in-session.
GUARD | id=quote-the-failure-text-first | how=READ THE FAILING ASSERTION OR THE RAW LOG BEFORE THEORISING A MECHANISM. Three plausible theories in one session were all wrong while the deciding evidence sat in a file not yet read.
GUARD | id=the-injection-sanity-gate-covers-tests | how=A LONE `tsc --noEmit -p tsconfig.app.json` DOES NOT TYPECHECK `tests/**`, so an injected arm sanity-checked that way can report "clean" over a tree that does not compile and its RED/GREEN means nothing. Use `tsc -b`.
GUARD | id=a-background-wrapper-must-not-swallow-the-gate-exit | how=A GATE LAUNCHED SO THAT `echo` IS THE LAST COMMAND MAKES THE JOB REPORT 0 WHILE THE GATE EXITED 1 (measured on row 373: the job said exit code 0, the gate said GATE RED) — the job carries the last command's status, the same masking class as a gate piped through `tail`. Launch the gate with NO trailing command so the job's status IS the gate's, and report the gate's own printed GREEN/RED, never the job's status.
GUARD | id=a-background-gate-launch-contains-only-the-gate | how=A LAUNCH THAT CHAINS PRE-CHECKS IN FRONT OF THE GATE CAN DIE BEFORE THE GATE EVER STARTS AND READ AS A GATE FAILURE (measured on row 377: a leading `git rev-parse` aborted the chain with exit 128 and NO log was written at all — the missing log is the tell). Run the pre-checks in their OWN call, then launch the gate ALONE, so the job’s status IS the gate’s.
```

## Recovery pointers

```
RECOVERY | context=docs/17-DECISION-LEDGER.md | note=the ledger is the decision record, `docs/18-ARCHITECTURE.md` is the seam index, `docs/22-DEVELOPMENT-PROCESS.md` is the role/process brief, and the PRE-COMPACTION board (every historical record and full guard text) is `git show 3200807:docs/20-ORCHESTRATION.md`.
```
