# 20 — Orchestration: the board

**Current state only.** History is `docs/17-DECISION-LEDGER.md` (what was
decided, and why); seams are `docs/18-ARCHITECTURE.md` (how the code works).
This file is the chief of staff's memory that outlives its own session
(`AGENTS.md` §Chief of staff): in-flight writers, unlanded branches, and the
owner's decision queue. It is **overwritten in place, never appended**, and it
must stay ONE SCREEN — a record that no longer describes the present belongs in
`docs/17` (if it decided something) or nowhere.

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

## Board

```
reconciled: 4d7f528 · 2026-09-15T14:05Z

SESSION  | cos=session-f7c658e6-c56b-444f-b956-865d5803f9b0 | started=2026-09-15 | note=successor to session-93cd9c40; reconciled against origin/main + scripts/board.sh before dispatching anything (no writers in flight, suite lock free, MemAvailable ~11.9GB)

IN-FLIGHT | none | note=row 173 verified and landed at 4d7f528; no writer in flight

TRAP | what=stale-queue | how=this board's first AWAITING-OWNER list was COPIED from the predecessor's compaction summary and three of its four items were ALREADY BUILT and deployed (claimA-pdf = docs/17 row 157, claimA-app = row 158 with the owner's verbatim "Yes — render tables in the app as well", claimB-roster = row 159); two writers were nearly dispatched to rebuild shipped work | check=re-derive the queue from the TREE at brief time — docs/18 §5 (known debt at HEAD) + the arc docs' build order — and verify each item against HEAD before writing a brief; a pending list in a summary is a HINT, never a queue
TRAP | what=stale-local-main | how=a successor read row 167 as "complete-unlanded" while origin/main already carried AND deployed it: the writer pushed, local main stayed 5 commits behind, and `git log main..branch` was asked instead of `HEAD..origin/main` | check=scripts/board.sh §git — it now names the behind-count

QUEUE | source=docs/18 §5 known debt, each verified at HEAD + docs/19 §11's remaining build order + the row-172 duplicate baseline | note=THE TRIPWIRE PAID OFF ON ITS FIRST DAY: its 16-group baseline is now the measured inventory of one-idea-written-many-times debt, and the biggest single item is `parseFile` ×7 in the same pack adapters — the identical parse-and-map loop behind the seven `isRecord` copies row 171 folded (fold seam: one shared adapter driver). Others, each with its reason in the baseline: `workerCount` ×3 (image-queue trio), `Missing*` panels ×3, `titleCase` ×3, `on()` ×3, `Field` ×2, `getChunkByContentHash` ×2, `levelDistance`/`duplicatedAcrossBooks`/`extensionOf` ×2 each, four same-file pairs, and `settledDetail` ×3 one char under the floor (recorded in docs/18 §5). `lib/pdfExport.statBlockSection` is still the un-briefed slice (its ~20 `labelValue` call sites must be scoped first); docs/19 §11 slice 6 (print refinement) is owner-DEFERRED; the Advanced floor editor's minimum and the Cartographer's brief parity are recorded debts with a stated reason not to touch them

AWAITING-OWNER | id=claimB-pack | cost=1 arc, verified unwanted-until-said | question=pack ITEM entries other than feat/weapon are still dropped at ingest (absent from text/contentHash/search; verified at HEAD, `dnd5e-foundry.ts:806` / `pf2e-foundry.ts:257` try two schemas only) — the lane split (docs/17 row 14) says an arc, not a slice

LANDED | row=173 | sha=4d7f528 | verify=my gate GREEN 338/338 files · 3975 tests · peak 1236MB of the 3000MB cap, lint 0, typecheck clean; the FIRST gate of this slice was RED (4 `db.verno` head pins + 4 knock-on console-noise failures from the aborted tests) and the re-gate is green after updating the pins and fixing the warning's CAUSE, never allowlisting it | retired=none — the dead writer (cf914bd5) had no branch and no worktree; its uncommitted slice was salvaged, re-verified and landed here, and the session is deleted | note=COPIES: 2→1 clipboard (two persona-panel call sites folded) + editor theme 2→1; the module canvas chat was deliberately NOT reused (module-shaped protocol) — the seams below it were
LANDED | row=172 | sha=109bc9b | verify=my gate GREEN 334/334 files · 3945 tests · peak 1230MB of the 3000MB cap (the writer's own numbers reproduced), PLUS the tripwire's self-proof on REAL change — after rebasing onto row 171 it went RED by itself with `STALE BASELINE ENTRY — 601a24cbc975d090 [the seven isRecord sites]`, exactly the mechanism it was built for; I deleted that one group (13 lines, nothing else) and it went green; then MY injection (a fresh copy of the document-record body appended to `packImport.ts`) RED with `NEW DUPLICATE — shared normalized body 601a24cbc975d090 (75 chars) is implemented at 2 sites` — the SAME hash the removed entry carried, so the detector sees the population it exists for | retired=branch feat/dup-tripwire + worktree /tmp/campaigner-dupes with this landing | note=COPIES: 1 — the detector slice folded nothing by design; its 16-group baseline is the measured debt inventory (see QUEUE)
LANDED | row=171 | sha=18165fa | verify=my gate GREEN 333/333 files · 3955 tests · peak 1221MB of the 3000MB cap, PLUS my injection (the unwrap made RECURSIVE, flattening nested arrays) RED 2/29 — `unwraps exactly ONE level — an element that is itself an array stays a document` and `N skipped finally means N` — hash b91e55f9… identical after restore | retired=branch feat/pack-array-docs + worktree /tmp/campaigner-arraydocs with this landing | note=OWNER DECISION A: COPIES 7→1 (`isDocumentRecord` in the ONE parse seam); the seven `isRecord` copies are gone, a top-level array is N documents in BOTH formats, an empty top-level array throws by name, and the skip count is per element
LANDED | row=170 | sha=302561c | verify=my gate GREEN 333/333 files · 3941 tests · peak 1233MB of the 3000MB cap, PLUS my injection (the `@`-target whitespace split made GENERIC, the "obvious" fix the rule scoping avoids) RED 4/46 — `space inside a uuid target: expected 'casts Peaceful on it' to be 'casts Peaceful Rest on it'` plus two lane digests — hash d2b9b769… identical after restore | retired=branch feat/ingest-notation + worktree /tmp/campaigner-notation with this landing | note=the writer died silently after committing, resumed on one nudge, then landed; its commit held code+tests+docs/17+18, its docs/08 delta was only committed at landing
LANDED | row=169 | sha=616ea98 | verify=my gate GREEN 333/333 files · 3936 tests · peak 1220MB of the 3000MB cap, PLUS my injection (a row whose stored fields are all empty made silently blank instead of named) RED 1/20 on `names a row whose stored fields are all empty instead of dropping it quietly`, hash 4e4a1165… identical after restore | retired=branch feat/planner-toolkit + worktree /tmp/campaigner-planner with this landing | note=docs/19 §11 slice 2; docs/18 §5's layout-debt paragraph amended (it still said v2 was "not built")
LANDED | row=168 | sha=730c9a7 | verify=my gate GREEN 333/333 files · 3930 tests · peak 1218MB of the 3000MB cap, PLUS my two injections — (1) the collision rule inverted (older row wins) RED 2/10 on `keeps the NEWER updatedAt…` + the tie-break pin; (2) the fold leaked into the `artifact:` key space RED 1/10 with the throw naming the key — each restored byte-identically (db.ts a026f437…, creature.ts a32e185a…) | retired=branch feat/persisted-key-fold + worktree /tmp/campaigner-keys-fold with this landing
LANDED | row=167 | sha=5348293 | verify=my gate GREEN 332/332 files · 3919 tests · peak 1249MB of the 3000MB cap, PLUS my injection (hand-rolled key restored in roomBudget.resolveBriefMonsterLevels) RED 2/18 — `expected [ undefined ] to deeply equal [ '2' ]` — file hash bf776416f1aafb3a15b73a0f1c1cf623b5a1c0dc identical after restore | retired=branch feat/name-key-spaces + worktree /tmp/campaigner-keys with this landing
```

Older landings are `docs/17`'s business — this section is not a history.

## Guards (why this workflow has teeth)

```
GUARD | failure=stale workers | where=plugin dsh-plugin-subagent-delete v0.2.0 (vendored ~/.dsh/profiles/web/vendor/sad, mounted in cordis.patch.yml) — the core provides send_message/interrupt_agent/list_agents, the plugin adds delete_subagent/release_subagent/list_subagents + web-UI removal | verify=spawn a trivial probe subagent, delete it, expect dirRemoved/projRemoved/removed_from_ui_list true (done 2026-09-15, DSH 0.1.5-rc.2) — RE-RUN THIS AFTER EVERY DSH UPDATE: the plugin is vendored (`file:./vendor/sad`) and its README targets DSH 0.1.0-rc.8, so an update can break the delete path while the tools still appear in the list
GUARD | failure=RAM / worker storms | where=scripts/gate.sh (atomic lock, disjoint chunks with an arithmetic check, 1536MB/worker heap, RSS cap 3000MB + available-memory floor 2500MB watchdog) + AGENTS §Host hygiene 1–7 | verify=bash scripts/board.sh (lock owner + orphans + load), and never hand-roll a gate
GUARD | failure=context / compaction | where=model route deepseek-official/deepseek-flash declares a 1,000,000-token context (native catalog); `compaction-basic` is patched in ~/.dsh/profiles/web/cordis.patch.yml (maxTokens 65536, compactionRetries 2, summarizer pinned to z-ai/glm-5.3-flash) because the 8192 default truncated large-span summaries and failed with "Compaction could not produce a useful summary" — the predecessor's unrecoverable state | verify=the compaction block is still in cordis.patch.yml; a CoS session keeps its thread small on purpose (AGENTS §Chief of staff, context budget)
```

## Recovery pointers

```
RECOVERY | context=/home/box/Harness/Tetris/recovered-campaigner-context.md | content=the Campaigner CoS, 2026-09-09→09-14, ~374 turns, 24 compaction summaries + 196 owner messages | note=the header names session-b25245f5 and the CivGlm session dir; the exact SOURCE SESSION IS NOT PINNED — neither that log (16.5MB, last write 19:37) nor the Campaigner dir's largest (session-e5adac67, 35MB, last write 19:14) reconciles with the content's last events (20:28–22:15) | status=content intact, header path unreliable
RECOVERY | context=/home/box/Harness/Tetris/recovered-civglm-context.md | content=the CivGlm CoS (the parallel project), ends ~2026-09-14 21:27 | note=references Campaigner only as a deploy-script example; not this project's session keeping
```
