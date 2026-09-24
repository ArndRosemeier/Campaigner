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
reconciled: 35649eb · 2026-09-24T07:05Z (ROWS 336 FIX-FORWARD + 337 GATE GREEN over the union — the three spawn defects are fixed (including the lost update that made a spawned mob vanish), and a battlemap now must depict NO figures: the prompts frame it and the existing vision read ENFORCES it. GATE GREEN: 379 files / 4848 tests, 7/7 chunks, lint 0, peak 2631MB, 626s. OWED: the CORE-MOBS rows still overlap on iPad (excluded from the wrap fix); QUEUE 311 (seven owed pins), 318, 321, 330.)
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





LANDED | row=337 | sha=35649eb | verify=GATE GREEN — union gate over 336ff+337: 379 files / 4848 tests, 7/7 chunks, lint 0, peak 2631MB, 626s. A BATTLEMAP DEPICTS NO FIGURES: one clause rides both prompts; the vision read must answer a REQUIRED `figures` list — a non-empty answer THROWS before any re-ask and finalizes nothing. GAP: the CLASSIC path has no vision read (one vision call per map to enforce — the owner’s call). Dispatcher arm: dropping the clause from ONE classic branch → RED.
LANDED | row=336 | sha=1ed9250 | verify=GATE GREEN (fix-forward) — the same UNION gate (row 337). THREE SPAWN DEFECTS: the lost update (one `writeBattleRow` save-or-delete transaction), the author-section illustrate checkbox, the viewport fix. THE RED IS KEPT: the first gate failed — an emptied battle stopped deleting itself — `saveBattle`’s normalize-on-write re-ensured PC tokens, so the second read judged the normalized row. New pin: the ROW is gone, survivor named. OWED: Core-mobs overlap.
LANDED | row=334 | sha=ceae054 | verify=GATE GREEN — the same UNION gate (row 333). THE PARTY WIZARD: "Add party…" in the pc region; two questions per character (name; integer initiative bonus), each Add = ONE `artifactRepo.createArtifact` write, Done creates nothing. Every player comes from `blankArtifactData('pc')` with only `initiativeOverride` replaced → `currentHp: 20` and `statBlock: null` (row-308 re-asserted). A blank name refuses loudly. Dispatcher arm: injecting a `statBlock` → RED.
LANDED | row=333 | sha=715942d | verify=GATE GREEN — UNION gate over 333+334: 378 files / 4827 tests, 7/7 chunks, lint 0, peak 2578MB, 623s. Part 1 is an OFF-by-default "illustrate mobs with no image" checkbox enqueuing the existing single-mob portrait only for spawned creatures with no art; part 2 authors a mob with `npc-smith` (name / STRUCTURED level / description) and spawns it — a failed run or a null `statBlock` fails loudly and spawns nothing. Arm: default flipped → RED.
LANDED | row=331 | sha=f3aace6 | verify=GATE GREEN — 375 files / 4812 tests, 7/7 chunks, lint 0, peak 2477MB, 598s (log `.gate-logs/gate-2-…`). PLAYERS ARE NEVER COVERAGE-HIDDEN (TEST-ONLY). Pins: the PRODUCER (`coveredTokenIds` = the NPC id, with a veil AND fog over a PC, an NPC, a statless token and a stamp), the PLAYER-SAFE render (PC present, covered NPC absent; GM sees all) and the layer ORDER (both kinds before every token). Arm: fogs dropped → RED. Boundary: `visible:false` is untouched.

LANDED | row=328 | sha=4ca8515 | verify=GATE GREEN — union gate over 327+328 (row 327). A BATTLE ADOPTS THE ENCOUNTER’S CURRENT MAP: a board with no map heals on open (a mapped board is untouched), "Use the encounter’s current map" moves map AND layout behind a confirm (tokens stay), and the toast names that action. ONE derivation (`battleSeed.encounterBattlemap`) + ONE board-map write; auto-converging live boards stays REJECTED. Dispatcher arm: the action firing without its confirm → RED.


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
