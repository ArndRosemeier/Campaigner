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
reconciled: 730c9a7 · 2026-09-15T08:03Z

SESSION  | cos=session-93cd9c40-6a9a-47ee-b8c4-dfee107cc1b8 | started=2026-09-15 | note=first session under this board; predecessor session-e5adac67 became unrecoverable (compaction of a 35MB, ~374-turn log)

IN-FLIGHT | none | note=row 168 verified and landed by the CoS; its branch/worktree retire with this landing

TRAP | what=stale-local-main | how=a successor read row 167 as "complete-unlanded" while origin/main already carried AND deployed it: the writer pushed, local main stayed 5 commits behind, and `git log main..branch` was asked instead of `HEAD..origin/main` | check=scripts/board.sh §git — it now names the behind-count

AWAITING-OWNER | id=claimA-pdf | cost=1 slice | question=PDF export drops markdown table rows (mdToPdfmake drops `|…|` lines) — build the table block?
AWAITING-OWNER | id=claimA-app | cost=1 arc | question=the reader prints table pipes as text (no remark-gfm) — add a second renderer?
AWAITING-OWNER | id=claimB-roster | cost=1 slice | question=treasureLedger never reads the roster's parsed `treasure`
AWAITING-OWNER | id=claimB-pack | cost=1 arc, probably unwanted | question=pack items are never parsed (absent from text/contentHash/search)

LANDED | row=168 | sha=730c9a7 | verify=my gate GREEN 333/333 files · 3930 tests · peak 1218MB of the 3000MB cap, PLUS my two injections — (1) the collision rule inverted (older row wins) RED 2/10 on `keeps the NEWER updatedAt…` + the tie-break pin; (2) the fold leaked into the `artifact:` key space RED 1/10 with the throw naming the key — each restored byte-identically (db.ts a026f437…, creature.ts a32e185a…) | retired=branch feat/persisted-key-fold + worktree /tmp/campaigner-keys-fold with this landing
LANDED | row=167 | sha=5348293 | verify=my gate GREEN 332/332 files · 3919 tests · peak 1249MB of the 3000MB cap, PLUS my injection (hand-rolled key restored in roomBudget.resolveBriefMonsterLevels) RED 2/18 — `expected [ undefined ] to deeply equal [ '2' ]` — file hash bf776416f1aafb3a15b73a0f1c1cf623b5a1c0dc identical after restore | retired=branch feat/name-key-spaces + worktree /tmp/campaigner-keys with this landing
LANDED | row=165 | sha=38c8424 | verify=331/331 files · 3901 tests · peak 1219MB · injection token-stamp RED 7 | retired=yes
LANDED | row=166 | sha=57def3f | verify=docs/17 row 166 | retired=yes
LANDED | row=162 | sha=16ae0d3 | verify=docs/17 row 162 | retired=yes
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
