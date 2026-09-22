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
reconciled: c0c7dfc · 2026-09-22T23:05Z (ROWS 322+323 GATE GREEN — artifacts are SELECTABLE IN THE WORKSPACE (export the selection, remove selected through the confirm, import into this campaign) and an in-use entity is no longer REPORTED in the orphan group. GATE GREEN over `c0c7dfc`: 375 files / 4795 tests, 7/7 chunks, lint 0, peak 2505MB, 653s. OPEN: the battle-map staleness FORK (AWAITING-OWNER below); QUEUE 311 holds FIVE owed pins, plus 318/321.)
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

AWAITING-OWNER | id=claimB-pack | cost=1 arc, verified unwanted-until-said | question=pack ITEM entries other than feat/weapon are still DROPPED at ingest (re-verified at HEAD: `dnd5e-foundry.ts` tries only the feat/weapon schemas, `pf2e-foundry.ts` only melee/action/spell), and the lane split (docs/17 row 14) makes this an ARC, not a slice. Do you want it?
AWAITING-OWNER | id=battle-map-staleness | cost=1 slice | FORK (row 325): a battle renders its OWN frozen `board.mapImageId`, so after a regenerate the CARD shows the new map and the board does not. Convergence skips a live board on purpose, and its toast says "re-run battle to pick up the new map" — an action that does NOT exist. RECOMMENDED: (a) heal on open when the board has NO map + (b) an explicit "use the encounter's current map" on a live board; REJECTED: auto-converging live boards.

QUEUE | row RESERVED 234 | MEDIUM — needs the owner's go-ahead | THE MODULE-GROUNDING EXCERPT SEAM SILENTLY TRUNCATES AND MATCHES BY SUBSTRING (`lib/wikilinks`): queued rather than fixed because it changes a shared seam.
QUEUE | row RESERVED 248 | LARGE — SLICE 1 LANDED (the v24 migration + stamping); the REMAINING SLICE is scoped in docs/18 §5: the MODULE arm (`entityKinds[].bestiary`, through the ONE library name-matching seam) plus pointer-arm deletion for CONVERTED rows. Owner: `mob-copy-remaining-now`.
QUEUE | row RESERVED 255 | OPEN UMBRELLA for "no stored core references": the rule landed across the module/reference families (255a/255b/255c) and the adoption family (257/268), and the clean cut removed the unconvertible-row blocker it once carried; it stays open for whatever a later isolation sweep finds.
QUEUE | row RESERVED 262 | iPad battle readiness — the sweep and the plan are done (`.gate-logs/plans/ipad-battle-readiness.md`); the sequenced slices remain.
QUEUE | row RESERVED 279 | SMALL, deliberately batched with the next code slice | STALE CODE COMMENTS still name the removed v22/v24 Dexie upgrades and deleted seams.
QUEUE | row RESERVED 292 | POSTPONED BY THE OWNER (verbatim: *"That is postponed, we dont need that for some time."*) | PDF/TXT PROSE TO STAT-BLOCK EXTRACTION: a MODEL read, or NO extraction at all with a structured form (rule 5's own preference). Priced by the read-only scan `b11ab1cb`; its report is `.gate-logs/discoveries/free-text-regex-scan.md`.
QUEUE | row RESERVED 296 | SMALL, OPTIONAL | an architecture pin ENUMERATING the allowed pattern-over-text sites, so a new free-text reader reds at birth the way the duplication tripwire does.
QUEUE | row RESERVED 310 | MEDIUM — SUBORDINATE, unblocked | THE FILLER SPEC: the app hands the model a bounded composition spec for what the scene leaves OPEN (`roomBudget.expectedRoomThreat` already computes expected levels + an approximate count, and `drawFillGrade` is the existing draw-once RNG precedent). It NEVER outranks the scene (row 309).
QUEUE | row RESERVED 311 | SMALL — batched with the next code slice | FIVE OWED PINS, each found by an arm that stayed GREEN: a statless PC with a NON-ZERO `initiativeOverride` (row 308's pin asserts 0); the deep-link reload into a live board that misses a new player (docs/18 §5); row 309's IN-PLACE-FILL budget exemption; row 313's two `on` delegates (the emitter arm reds only moduleGen's ); and row 323's orphan-group heading COUNT — an arm that adds `keptInUse` back stays GREEN.
QUEUE | row RESERVED 318 | SMALL — batched with the next code slice | ONE OWED PIN the dedup arc's own arms exposed: `features/modules/missing-entity-panel.MissingEntityPanel` has NO behavioural pin (nothing asserts the message it renders or that its back link goes to `modulesPath(campaignId)`) — its fold is proven a byte-MOVE by the tripwire hash, but a wrong link target would ship silently across all 7 render sites.
QUEUE | row RESERVED 321 | SMALL — owner may veto | THE ENCOUNTER LEVEL CHAIN IS NOT SELF-REPORTING: `budgetAdvisory` renders (`kind-forms.tsx`), but neither the RESOLVED TARGET level nor each mob's own level is shown, so a level-9 mob in a level-1 room stays invisible whenever the target itself resolved high or the figure was asserted/exempt (row 309). The owner's level-9 report is CLOSED-UNREPRODUCIBLE — he deleted it, suspects a model fluke; a panel screenshot is the cheap capture.
QUEUE | row RESERVED 327 | IN FLIGHT — owner | THE CHECKBOX MOVES TO MODULE-OWNED ROWS TOO: the workspace selection resolves over ALL of this campaign's rows, so a module NPC or location can be exported and reused in another campaign (the import lands it at campaign level). Remove still refuses module-owned rows by name, and the bar now says so. Owner: *"A nice NPC for example or a location can be reused elsewhere."*

IN-FLIGHT | row=327 | state=DISPATCHED | writer=cf87e1b0-2047-486d-a828-b1926781e44d | worktree=/home/administrator/projects/Campaigner/worktrees/sel-module | branch=sel-module | model=deepseek-official/deepseek-flash (inherited route) | note=module-owned rows get the checkbox (export/reuse); brief `.gate-logs/briefs/row327.md`; reports ON LANDING or BLOCKED only.
LANDED | row=323 | sha=c0c7dfc | verify=GATE GREEN — UNION gate over 322+323: 375 files / 4795 tests, peak 2505MB, 653s (log `.gate-logs/gate-2-20260922T214557-26947`). AN IN-USE ENTITY IS NOT REPORTED: `orphanOfferView` partitions into `group` (deletable only), `keptInUse` (held out) and `hidden`; `OrphanGroupRow`/`inUseReason` and the panel's `in use — …` line + testid are DELETED. Adopt UNTOUCHED. OWED PIN → QUEUE 311: my arm adding `keptInUse` back to the heading count stayed GREEN.
LANDED | row=322 | sha=955a4b9 | verify=GATE GREEN — the same UNION gate (row 323). ARTIFACTS ARE SELECTABLE IN THE WORKSPACE: checkboxes + an action bar (Export the selection, Remove selected via the confirm + live census, Import… into THIS campaign). SET-based removal (Party/module-owned/foreign ids refused BY NAME), `selectionOnly` (a selection no longer drags the campaign's modules/battles/runs), target-campaign import (rows at campaign level). Dispatcher arm: delete on dialog-open → RED.

LANDED | row=319 | sha=bb447aa | verify=GATE GREEN — 373 files / 4772 tests, 7/7 chunks, lint 0, peak 2473MB, 583s (log `.gate-logs/gate-2-20260922T201805-26119`). THE IMAGE TEXT RULE IS POSITIVE: the shared avoid list is DELETED, there is no default `Avoid:` line, and `IMAGE_TEXT_WHEN_NEEDED_CLAUSE` rides both branches + both battlemap modes; an explicit caller list still reaches `Avoid:`. Arms: default list back → RED; clause dropped → RED. Boundary untouched: battlemap bans, vision plaques.

LANDED | row=315 | sha=ed15823 | verify=GATE GREEN — UNION gate over rows 315+316: 373 files / 4775 tests, 7/7 chunks, lint 0, peak 2520MB, 633s (log `.gate-logs/gate-2-20260921T222141-8529`). THREE FOLDS (`form-field.Field`, `settingsRepo.maxParallelWorkers()` ×4 sites incl. entity-batch's inline one, `bestiary-fetch-section.applyProgress`); baseline 3→0. Dispatcher arms: a re-born `Field` → `NEW DUPLICATE 12c29e97676c2c29`; `maxParallelWorkers()` → `return 2` red NAMED portrait-queue tests.
LANDED | row=316 | sha=dddcf4e | verify=GATE GREEN — the same UNION gate (numbers in row 315). `missing-entity-panel.MissingEntityPanel` carries the ONE missing-entity panel: the three named copies PLUS a FOURTH INLINE copy in `CanvasPage` (invisible to the detector, found by grep) are gone, 7 render sites migrated; baseline `1996f7df8ca0ab87` deleted. Dispatcher arm: a twin in the seam file → `NEW DUPLICATE 1996f7df8ca0ab87 (331 chars) at 2 sites`; pristine hash `a40b2234…` restored.
LANDED | row=313 | sha=35e524d | verify=GATE GREEN — UNION gate over 313+312 at `35e524d`: 373 files / 4775 tests, 7/7 chunks, lint 0, peak 2509MB, 584s (log `.gate-logs/gate-2-20260921T215041-16059`). FOUR `src/llm/**` FOLDS, one seam each (emitter, levelDistanceTo, duplicatedAcrossBooks, statBlockReader); baseline 13→9. THE RED IS KEPT: the first gate was RED on the name-key census (`encounterItems` `comparableName(` 3→2, missed by the writer's focused set), fixed forward as `35e524d`.
LANDED | row=312 | sha=f0140fb | verify=GATE GREEN — the same UNION gate (numbers in row 313). FIVE FOLDS, one seam each (`text.titleCase` ×3, `text.publicationSourceLine` ×2 byte-preserving, `types.extensionOf`, `moduleRepo.saveModule` + `createModule` alias, `board.captureStageSnapshot`); baseline 9→4. ERRATUM: its commit body says "13 -> 8 groups" — stale pre-rebase text; the true base was 9 and the union left 4.
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
```

## Recovery pointers

```
RECOVERY | context=docs/17-DECISION-LEDGER.md | note=the ledger is the decision record, `docs/18-ARCHITECTURE.md` is the seam index, `docs/22-DEVELOPMENT-PROCESS.md` is the role/process brief, and the PRE-COMPACTION board (every historical record and full guard text) is `git show 3200807:docs/20-ORCHESTRATION.md`.
```
