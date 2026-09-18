# 22 — The development process (portable)

**What this is.** A description of the working process this repository is built
with, written so it can be lifted into a NEW project. It is deliberately
self-contained: nothing below needs Campaigner's source to make sense. Where a
rule exists because of a real incident, the incident is named — a rule whose
reason is lost gets deleted by the next person in a hurry, and the incident
comes back.

**The one-line summary.** A human supplies intent and decisions; ONE agent acts
as chief of staff (scope, brief, dispatch, verify, retire, report); short-lived
writer agents each deliver ONE verified slice from their own worktree; and every
piece of state that matters lives on disk — a decision ledger, a seam index, and
a one-screen board — so the session that holds the role is disposable.

---

## 1 · The shape, in one page

```
            intent, decisions, acceptance
   owner ────────────────────────────────────────────┐
     ▲                                               ▼
     │ report (short, numbers, honest)        ┌───────────────┐
     │                                       │  DISPATCHER   │  intake → scope → brief
     │                                       │ (chief of staff)│ dispatch → verify → retire
     │                                       └───┬───────┬───┘
     │            landing (commit+push+report)   │       │  scoping answer (no writes)
     │        ┌──────────────────────────────────┘       └───────────────┐
     │        ▼                                                          ▼
     │   WRITERS (≤2 in flight)                                  PROBES (read-only, parallel)
     │   one slice each, own worktree                            "what does the code actually do?"
     │        │
     └────────┴──► DURABLE STATE (survives any death):
                   docs/17 decisions · docs/18 seams · docs/20 board · git branches/worktrees
```

Three claims make this work, and each is worth stating plainly:

1. **The agent's context is the scarce resource, not its intelligence.** Every
   mechanic below exists to keep knowledge OUT of the conversation and IN files.
2. **A handover must be possible in minutes.** Assume the session can die at any
   moment (it has: a predecessor died of a compaction failure with a 35 MB log).
3. **Work is only done when it is verified by someone other than its author.**
   The writer's own gate is necessary and not sufficient.

---

## 2 · Roles

| Role | Who | Owns |
|---|---|---|
| **Owner** | the human | intent, priorities, taste, product decisions, acceptance. Never asked to debug; asked to choose between named options. |
| **Dispatcher / chief of staff** | one long-lived agent session | intake (extract the intent behind the literal ask), scoping against the seam index, the brief, dispatch, **independent verification of every landing**, retiring branches/sessions, the board, the report. |
| **Writer** | a short-lived agent, one per slice | ONE coherent change: code + tests + docs + its own gate + its own differential, committed on its own branch, then a short landing report. |
| **Probe** | a read-only agent | answering one scoping question from the code ("where is X rendered, and what context does each surface have?"). Writes nothing. Its report becomes a brief. |

**Why separate a dispatcher from writers at all.** A writer that also plans
burns its context on the plan and rushes the change; a dispatcher that also
writes stops being able to verify anything (an author's test of their own work
answers "did I do what I meant?", not "is it right?"). The separation is not
ceremony — it is the only mechanism that produces independent verification
without a second human.

**Two writers maximum.** Writers run in parallel, and every one of them can
start a full test suite. The ceiling is not about git — it is about the machine
(see §11, "the box is shared").

---

## 3 · The four durable artifacts

Everything the process knows lives in four files plus git. Copy this shape into
a new project before writing any feature code.

| Artifact | Answers | Rule |
|---|---|---|
| **Decision ledger** (`docs/17-DECISION-LEDGER.md`) | *Why is it like this?* — one row per decision, with the owner's verbatim words, the evidence, what was rejected, and what is unproven. | **Append-only.** A decision is history; history never rots. Never edit another landing's row. |
| **Seam index** (`docs/18-ARCHITECTURE.md`) | *How does the code work, and where is the ONE way to do X?* — layer map, seam rows, gotchas, known debt. | A landing that adds/moves/deletes a seam updates its row **in the same commit**. Index entries describe the present, so they are **checkable**, never prose. |
| **Board** (`docs/20-ORCHESTRATION.md`) | *What is happening right now?* — in-flight writers, unlanded branches, the queue, traps. | **One screen, overwritten in place.** A record that no longer describes the present belongs in the ledger or nowhere. |
| **Testing doc** (`docs/08-TESTING.md`) | *What proves this, and what was actually run?* — the matrix, the pins, the differential arms with their hashes, the VOID probes. | Grows a section per landing; the raw gate log is kept until the landing is verified. |

**The insight these four encode:** docs that RESTATE behaviour rot; docs that
record DECISIONS do not. So behaviour lives in a test (the test *is* the
statement), and the doc holds the pointer and the reason.

---

## 4 · The board

The board is the chief of staff's memory that outlives its own session. It is
one screen of one-line records with stable prefixes and `field=value` pairs, so
a query is a `grep` and the answer is a line, not a paragraph.

### 4.1 Record vocabulary

| Prefix | Means |
|---|---|
| `reconciled: <sha> · <timestamp>` | the commit the rest of the board was checked against |
| `SESSION` | an actor that may dispatch (id, model, state) |
| `PROBE` | a read-only agent in flight and the question it answers |
| `IN-FLIGHT` | a writer: row, session, model, worktree, branch, base, **state**, and the full scope |
| `LANDED` | a verified landing: row, sha, **the dispatcher's own verification numbers**, what was retired, the note, the docs |
| `QUEUE` | owner requests and known debt not yet dispatched, with the row number reserved |
| `QUEUE-CLOSED` | a queue line whose scope has been consumed (kept for one screen of history, then dropped) |
| `TRAP` | a mistake that actually happened, with the rule that prevents it |
| `GUARD` | a mechanism protecting the process (host, RAM, compaction), and how to verify it |
| `RECOVERY` | where a successor finds lost context |

Example records (real, trimmed). The `/tmp` worktree and log paths in these
historical samples PREDATE the in-repo recipe (§Parallel writers 5, rows 231/232)
— do not copy them:

```
IN-FLIGHT | row=216 | writer=session-f6ae… | model=<provider>/<model> | worktree=/tmp/p-spell-peek
  | branch=feat/spell-peek | base=41be57c | dispatched_by=session-93cd9c40 | state=dispatched 09:05Z, no commit yet
  | note=<the owner's verbatim report, the measured defect, the scope, the decisions, the pins>

LANDED | row=216 | sha=3967206 | verify=MY OWN: gate GREEN 341/341 files · 4431 tests · combined peak 2352MB of
  the 3000MB cap (raw log /tmp/gate-verify-216.log) PLUS my own injections, hashes printed and the baseline
  BYTE-IDENTICAL to the writer's own (…1eb7165c…) | retired=branch + worktree + writer session | note=…
```

### 4.2 The reconciler

Prose about state rots, so the board is **checked, never believed**:

```bash
bash scripts/board.sh      # → BOARD RECONCILED  |  BOARD STALE — fix docs/20 before dispatching
```

The script compares every claim against reality: does each `LANDED` sha exist on
`origin/main`; is a claimed `IN-FLIGHT` writer still a live session in the
OpenCode session API; does a branch claimed as retired still exist; is the suite
lock held and by whom; is there a child session under this repo updated in the
last hours that the board does not name; is `reconciled:` an ancestor of HEAD;
does a `LANDED` row still carry an `IN-FLIGHT` line (a classic stale pair). It
also prints host load, available memory and any orphan test processes. The
registry source is the OpenCode server (`OPENCODE_API_URL`, default
`http://127.0.0.1:5551/session`); when it cannot be reached the run SAYS SO in
its `=== sessions ===` header rather than passing silently.

**Rules that make the board trustworthy**

1. **Updated in the same commit as the landing it records.**
2. **True BEFORE the dispatcher reports the landing to the owner.** If the
   session dies the second after that report, a successor must be able to act
   from the board, the ledger and git alone.
3. **Every record names something checkable** — sha, branch, worktree, session
   id, path. "Probably fine" is not a record.
4. **Session start = reconcile first.** Read the board, run the reconciler,
   compare with the live agent registry and the host, fix what lied, then wait
   for a request. Nothing is dispatched before that pass.
5. **Reconcile against `origin/main`, never local `main`.** A landing read as
   "unlanded" for hours because the local branch was five commits behind is a
   recorded incident, not a hypothetical.

---

## 5 · The rules that carry the weight

These are the project's `AGENTS.md` bindings. They are short on purpose; each
one exists because its absence cost real work.

### 5.1 Four engineering rules

1. **No silent fallbacks.** When data, parsing or a step fails, propagate a
   LOUD error. Forbidden: finalizing an artifact from an empty/failed draft,
   `catch`-and-continue around parsing, `console.error` with no user surface,
   placeholder values standing in for required data. Defaults are allowed only
   for genuine user preference or optional enrichment, never to mask a failure.
2. **Errors must be visible** — through the app's one toast/error surface, the
   error boundary, or a failed row with a message.
3. **Validate at every boundary.** Machine output is parsed with a schema; a
   validation failure fails the step. It never becomes empty data.
4. **Centralize, and keep it simple.** When one idea is implemented in more than
   one place, make it ONE seam and route callers through it. When you touch an
   already-distributed pattern, folding it is part of the change — unless that
   is genuinely more expensive than the defect, in which case say so in writing
   where the next reader will hit it.

### 5.2 Centralization, made mechanical (the four obligations)

Duplication is invisible when a copy is BORN: nothing fails and each copy is
correct where it was written. So it is caught by pins, not by discipline.

1. **A brief names the seam it extends.** Before dispatching, find how the repo
   already does the thing and name that ONE seam. A writer that finds a SECOND
   mechanism reports it instead of quietly adding a third.
2. **A centralization lands with an "exactly one" pin** — a test that goes red
   when a second implementation appears (a source scan over call sites, or a
   differential running every copy against the same inputs). Never centralize by
   prose alone.
3. **An index entry is checkable; a decision is history.** The seam index is
   updated in the same commit as the change; the ledger is never rewritten.
4. **A discovery that spans more than one code piece starts with the seam
   question, and the answer is WRITTEN DOWN.** Every brief and every landing
   report carries one greppable line:
   `COPIES: n→1 — <the seam that now carries it>` when copies were folded, or
   `COPIES: 1 — checked, no duplication (grepped: <what>)` when the change really
   is single-site. A brief without that line is incomplete; a landing without it
   is not verified.

   The real case this exists for: **seven identical `isRecord` helpers**, one
   per pack adapter, that no test could see until a task happened to grep the
   right word. They are now folded, and a generic detector
   (`tests/architecture/no-duplicate-implementations.test.ts`) parses every named
   function body in `src/**` and `tests/**`, normalizes it (comments stripped,
   formatting collapsed, the function's own and parameter names blanked so a
   rename cannot hide a copy), and requires each 2+-site population to equal a
   checked-in inventory EXACTLY. A new copy reds naming every site; a folded copy
   reds as a stale entry until its line is deleted, so a blessing cannot outlive
   the duplication. It is a tripwire, not a proof — it cannot see paraphrases or
   bodies under its measured floor — so obligation 2's per-idea pin still closes
   each fold.

### 5.3 Critique the instruction (owner-directed, and it applies to briefs too)

The human's instruction is INTENT, not design.

1. Extract the intent first — the felt problem behind the literal ask.
2. If the requested mechanism is wrong, fragile, or more expensive than the
   goal, say so plainly and offer the better route, briefly.
3. Do not silently substitute: a different design may replace the asked-for one
   only when it serves the SAME intent and the owner has been told. The owner
   must always be able to see which decisions were theirs.
4. Judge the friction: minor imperfections get decided in one line, not debated.
5. Route the critique through reality, not taste: "this breaks X, here is the
   code/doc that proves it" is a critique; "this feels off" is not.
6. **Briefs are bound by this too.** Every brief states the intent and the
   chosen mechanism, and tells the writer to report BLOCKED — with evidence —
   rather than implement something it can prove is wrong, **including when the
   flaw is in the brief's own design**. Real case: a brief pinned a spell's cast
   rank to the wrong upstream field; the writer refused, cited upstream's own
   source and a real fixture, and the dispatcher ratified the correction.
7. The decision stays the owner's. Present the better way once; if the owner
   reaffirms, execute it well and stop re-arguing.

---

## 6 · Delegation mechanics

**Separate worktrees, always.** Two writers in one tree share one git index, and
`git commit` commits the whole index — file disjointness does NOT protect the
commit phase (a real purge commit swept a concurrent writer's staged feature
work under the wrong subject). So: one worktree per writer. WHERE it lives is
harness-specific, and getting it wrong is measured, not theoretical: on this
harness `/tmp` is a per-call, READ-ONLY tmpfs, so a worktree created there in
one call does not exist for the next — the recipe is IN-REPO, under
`<repo>/worktrees/<slice>` (gitignored, and ignored by `eslint.config.js`, so it
is NOT swept into the main tree's lint run), installed with a plain
`pnpm install --frozen-lockfile`. Symlinked `node_modules` does NOT work (28 test
files fail on `pdfjs-dist` under Vite's `server.fs.allow`) even though lint and
typecheck pass. AGENTS §Parallel writers 5 is the binding recipe; this paragraph
states the principle it implements.

**Absolute paths, stated twice in every brief.** Every shell call runs in a
fresh shell whose working directory is the session workspace, and file tools
resolve relative paths against that same workspace — so a writer told to work in
`<repo>/worktrees/<slice>` edits the MAIN tree unless every path is absolute (or
the call passes a working directory). Real incident: a writer's six-file slice
landed in the main tree while its own worktree sat clean and commitless, and the
other writer's gates kept failing on half-finished foreign files.

**File disjointness holds for source files and CANNOT hold for the docs.** Every
landing amends the ledger, the testing doc and usually the seam index. So:

- The **dispatcher assigns the ledger row number in every brief**, read from the
  ledger at brief time, so two briefs cannot claim the same one. (Two writers
  once both numbered a row 136 and each wrote that number into its own docs,
  code comments and tests.)
- A writer that still hits a docs conflict resolves it as a **mechanical union**,
  renumbers its OWN row only, touches nothing of the other landing, proves that
  with `git diff --name-only <other landing> <its commit>`, re-gates the full
  suite on the rebased tree and pushes.
- **A conflict anywhere else means the disjointness check missed something:
  STOP and report**, do not resolve it.

**Rebase before every push**: `git pull --rebase origin main`, then
`git push origin HEAD:main`. Where `main` DEPLOYS (the owner tests it minutes
later), `main` is not a staging area: a red or half-finished landing is
user-visible, which is why the gate runs before every push.

**Cadence contract.** A brief says: report on LANDING or BLOCKED, nothing in
between. The dispatcher waits in silence; a mid-flight nudge is a last resort for
real stagnation (registry idle, no report across checks), never a demand for
progress updates. A clean tree with no new commit while the registry says
`running` is NORMAL for a deep-verify or long-generation phase.

**A writer that cannot finish must COMMIT the coherent partial state on its
branch and report BLOCKED.** Uncommitted work dies with the session. Twice in
one day, writers failed with empty reports — the one that had committed survived;
the one that had not survived only because its worktree still existed.

---

## 7 · The gate

**One script runs the suite. Nobody hand-rolls a test command.** The gate is the
single place where correctness, the machine, and the shared host are handled at
once. Its responsibilities, in a form you can re-implement anywhere:

1. **An atomic lock** (`mkdir` succeeds or it does not) — not a `pgrep` snapshot,
   because two agents can look in the same instant, both see "free", and both
   start. The lock names its owner (pid, time, worktree). A lock older than 30
   minutes with no suite process alive is STALE: remove it and say so.
2. **Refuses to start while ANY other suite runs** — including a peer project's,
   which you cannot lock out. `pgrep` is the diagnostic for those.
3. **Bounded parallelism**: at most two chunks at a time, ONE worker each, each
   in its own process group (a fresh process per chunk, because the growth that
   fills the machine is off-heap and no heap cap stops it).
4. **A memory ceiling and an availability floor**: sample the COMBINED resident
   size of every live chunk and kill the run at the cap, or when available memory
   drops below a floor; fall back to sequential BEFORE the kill line when the
   combined peak merely approaches it. A kill is VOID, is re-run sequentially,
   and is never counted.
5. **Chunking by path** with the two long test directories split so their tails
   overlap; a per-run union check that the chunk lists are exactly the test
   files, none twice.
6. **Diff-scoped order**: the chunks a diff touches run FIRST, so a red surfaces
   in ~1–2 minutes instead of ~12. vitest is skipped ENTIRELY only for a
   docs-only diff (lint and typecheck still run), and a tests-only diff runs only
   the chunks containing them. EVERY other diff runs the full set — there is no
   other skipping, because a gate that guesses at coverage is the failure mode
   this refuses.
7. **A plan-only mode** (`GATE_PLAN_ONLY=1`) that prints the plan and runs
   nothing — how the mapping is reviewable without a 7-minute run.
8. **Summed counts and peaks** on one summary, with the raw log kept. **Never
   pipe a gate through `tail`/`head`**: a real incident destroyed both the
   failing test's name and its expected/received block, and the surviving tail
   misattributed the failure to the wrong line.
9. **Two tiers, because they answer two different questions.** The COMPILE tier
   (`GATE_TESTS=0`) runs typecheck — the deploy-critical check — and no suite,
   in ~30s, and it is what blocks a push. The FULL run is the default and is
   what makes a change VERIFIED; it runs *after* the push, in the background.
   The two must never be confused: the compile tier exits 2 and prints its own
   banner, so a result that did not run the suite can never be quoted as "the
   gate passed". This is a deliberate trade, not a shortcut — see §7.1.

**Rules around it**

- **One suite at a time in the whole session.**
- **A killed run's result is VOID**, never evidence: re-run it under the lock.
- **A red gate is information, not an obstacle.** Fix the cause; never re-run
  until green. (A writer's first gate red on a real typecheck error in its own
  new test *is* the system working.)
- **An injection holds the tree only while its run is LIVE.** Take the lock
  FIRST, then inject, then run, then restore in a `trap`. Real incident: an
  injection was applied before waiting for the lock and sat in the shared tree
  for ~20 minutes while two writers gated — one of them found it and correctly
  reported it instead of resolving it. A writer running `git add -A` would have
  committed it.

### 7.1 · The two tiers, and why the full gate no longer blocks a push

The 12-minute full gate is the single largest serial cost of a slice, and on a
small box it is irreducible: the memory ceiling (the thing that keeps the shared
machine alive) caps the suite at two concurrent chunks, and MEASURED here that
is 716s wall (120s tooling + 595s vitest) against a summed 1141s of chunk time.
The only honest lever left is *overlap*, not skipping — so the gate was split by
the question each half answers:

| | Compile tier | Full gate |
|---|---|---|
| Command | `GATE_TESTS=0 scripts/gate.sh` | `scripts/gate.sh` |
| Runs | typecheck (lint opt-in via `GATE_CHECKS`) | lint + typecheck + every chunk |
| Cost (measured) | **27s** (build-config diff: +`pnpm build`) | **~12 min** |
| Question | *does it still build?* | *did behaviour move?* |
| Blocks | the push | nothing — it follows the push |
| Verdict | exit 2 (NOT verified) | exit 0 GREEN / exit 1 RED |

**Why typecheck is the blocking half, and lint is not.** The deploy job runs
`pnpm build` (= `tsc -b && vite build`). A type error therefore fails the deploy
and the live site silently keeps the previous bundle; nothing in CI runs eslint,
so a lint error breaks no build. The blocking tier runs exactly what can break a
deploy, and the ~94s of eslint is opt-in (`GATE_CHECKS=all`) or covered by the
full run.

**One exception the compile tier must not skip.** `tsc -b` proves the TYPES
compile; it does not prove `vite build` succeeds. A diff touching
`vite.config.ts`, `tsconfig*.json`, `package.json`, the lockfile, `index.html` or
`public/` can pass typecheck and still produce a build the server rejects — and
the owner's requirement is not merely that a deploy "succeeds" but that the app
stays testable (verbatim: *"no compile errors before push, thats really needed
because i need to be able to still test the app"*). So the compile tier detects
that diff and runs `pnpm build` too (`GATE_BUILD=0` refuses it deliberately and
loudly). The cost is ~1–2 minutes, and it buys the one failure the owner cannot
work around.

**Why the full gate may follow the push.** This is an owner decision with a
stated precondition (verbatim): *"its actually ok to push unverified code as long
as it compiles and as long as the verified code goes in a few minutes later. I do
not need a verified state all the time because i am the only user of this app at
the moment."* The trade is written down with its boundary: `origin/main` can
carry an unverified commit for ~10 minutes, which is acceptable for a single-user
app whose only consumer is the person who asked — and it REVERTS to gate-then-push
the moment a second user or a second consumer of `main` exists. Two rules keep it
from decaying: the full run is started in the same session that pushed (an
unowned background gate is how a red result gets lost), and a red is fixed
forward IMMEDIATELY, never stacked behind another unverified commit.

**Two mechanical requirements** this model adds, both learned the hard way here:
a background run's log must live in the WORKSPACE (`GATE_LOGDIR` now defaults
there) — a `/tmp` log is invisible to every later shell in this harness and a red
result becomes undiagnosable; and the lock must be on a shared path before two
gates can be trusted to exclude each other.

---

## 8 · Verification doctrine (the part that makes it a process)

**The dispatcher verifies every landing itself, before retiring anything.** The
writer's word is a claim; the following is the check:

1. **The sha is on `origin/main`** (not the branch, not the local tree).
2. **The dispatcher's OWN gate**, raw log kept, with the summed counts, the peak
   and the chunk arithmetic quoted in the board record. It is normal for these
   numbers to differ slightly from the writer's (they are separate runs).
3. **The dispatcher's OWN differential** — at least one injection the writer did
   not run — with every arm's file hash PRINTED, the lock held before injecting,
   and the restore done FROM HEAD by a `trap`. A finished injection whose file
   hash was not printed is not evidence.
   - **Two arms with identical output are a VOID probe**, never evidence against
     the landing. Real incident: a probe broke the cure in the same step as the
     delay, so its two "different" arms measured the same bytes; the dispatcher
     read the identical result as falsifying a writer's fix and reopened a slice
     whose full gate had already passed.
   - **A green arm whose mutation certainly changed behaviour is a WRONG-FILE or
     missing-pin signal FIRST.** Real incident, twice: an arm came back green
     because the test-file SET did not contain the file that owns the pin. Both
     "pin-coverage gaps" were the dispatcher's error, and one of them was
     reported to the owner before being disproved. Grep for the pin's own file
     and run THAT file.
   - **Restore from HEAD, never from the index**: a bare `git checkout -- <path>`
     restores the INDEX and has silently left injected code in a tree.
   - **Restore from HEAD only the bytes HEAD actually holds.** In the shared tree
     the landing is committed, so `git checkout HEAD -- <path>` is right. In a
     WRITER's tree mid-slice the change is UNCOMMITTED and the same command WIPES
     it — real incident (row 221): a writer's first arm run restored two uncommitted
     source files from HEAD and destroyed the work, recovered only because it could
     re-apply it. The brief must say either "commit the slice first, then inject" or
     "take an out-of-tree copy and restore from the COPY". A trap restores
     *something*; make sure it is the thing you meant.
   - The first arm is the untouched baseline, and its hash should match the
     writer's own reported baseline — that is provenance, and it has caught
     verification against the wrong tree.
4. **The docs were amended in the same commit** (ledger row, seam index row if a
   seam moved, testing doc section).
5. **Retire**: delete the session, remove the worktree, delete the branch (after
   the safe-delete test: no commits outside main), record the tip sha.
6. **A recovered or silent writer's branch is verified as a FRESH landing** — a
   dead writer's commit has never been gated by a live report.

**Stale-tree discipline (a real dispatcher error):** fetch AND fast-forward
before verifying. A verification run that executes against a stale local `main`
produces arms that anchor nothing; if it is noticed in time, kill it and say so —
none of its numbers may be used.

**The dispatcher is a writer for the parallel-writers rule.** An uncommitted edit
of its own in the shared tree makes a landing writer's `git pull --rebase` refuse
mid-landing. Stage, commit and push dispatcher edits in ONE chained command,
and never leave one uncommitted while a writer is gating.

---

## 9 · The brief (copy this)

A brief is self-contained: the writer never sees the conversation. Template,
with the reason for each part:

```markdown
You are a WRITER on <project> (<stack, one line>). Read `<AGENTS.md>` FIRST —
the binding rules, §critique the instruction, §Centralization, §host hygiene,
§parallel writers. Then read <the specs and ledger rows for this area>.

# Where you work (READ THIS TWICE)
Your worktree is <ABSOLUTE in-repo path, `<repo>/worktrees/<slice>`> on branch
<branch>, based on origin/main =
<sha>, deps installed. Every bash call runs in a fresh shell whose cwd is the MAIN
repo and file tools resolve RELATIVE paths against it — so EVERY read/edit/write/
bash call MUST use an ABSOLUTE path under <worktree> (or pass a workdir). Never
touch the main tree. N other writer(s) may be in flight; your files are disjoint.

# Your ledger row: <N>
A DOCS conflict is a mechanical UNION (renumber YOUR row only); a NON-docs
conflict: STOP and report.

# The owner's report (verbatim) and the intent
"<paste the owner's words exactly>" — then: what outcome the request is reaching
for, and the MEASURED state of the code today (file:line).

# What to build
One numbered list. Name the ONE seam it extends. State the design decisions the
dispatcher has already made and that the writer may prove wrong. Name what is
deliberately OUT of scope and why.

# Pins
The behaviours that must go red when broken, each phrased as a statement. Reuse
the existing test harnesses; never build a second fixture set.

# Verification (yours)
1. The ONE gate command; exit 9 = lock busy → WAIT and retry, never reap another
   actor's processes; keep the RAW log. Your LANDING still carries a FULL green
   run on your slice — the two-tier model (§7.1) lets the DISPATCHER push behind
   a 27s compile check, not you: a writer never reports LANDED on a compile-only
   result.
2. Your own differential with every arm's file hash printed; lock held before
   injecting; restore from HEAD in a trap (or from an out-of-tree copy while the slice is
   still uncommitted — HEAD does not hold it yet); identical arms are VOID.
3. Commit style; rebase before push.
4. If you cannot finish, COMMIT the coherent partial state and report BLOCKED
   with the reasoning.

# Docs to amend in the SAME commit
<ledger row N, seam index, testing doc> — and carry the `COPIES:` line.

# Your report (short)
LANDED or BLOCKED, then: sha; gate counts + peak; each arm with its printed hash
and observed failures; the COPIES line; the judgement calls; the docs amended;
and anything this brief got wrong. Report NOTHING in between — silence until
LANDED or BLOCKED. If you can PROVE a rule here is wrong (including this brief's
own design), report BLOCKED with the evidence rather than implementing it.
```

Two clauses do the most work: **"the brief may be wrong — prove it and report
BLOCKED"** (it has caught two incorrect dispatcher designs) and **"silence until
LANDED or BLOCKED"** (it stops the report-churn that burns a writer's context).

---

## 10 · The landing report

Writers report: **LANDED or BLOCKED**; sha; gate as summed counts + peak; each
differential arm with its printed hash and what red; the `COPIES:` line; how the
deliverable actually works (which read, which lookup); judgement calls; docs
amended; **and every way the brief was wrong**. Honest correction is treated as
a successful report, not a failure.

The dispatcher's report to the owner is short, numeric and first-person about
its own verification: what landed, the dispatcher's own gate numbers, the arms it
ran, what it found that the writer did not, what it got wrong, and the queue.
Evidence goes into docs, never into the chat.

---

## 11 · Insights (why this works, and where it hurts)

1. **Externalize state or die of context.** The predecessor of this process died
   of a compaction failure with a 35 MB session log. The answer is not a bigger
   context — it is a small thread plus a board, a ledger and git. Rule of thumb:
   quote numbers, never paste logs.
2. **The board is prose and must be checked.** Every reconciliation failure so
   far has been the board lying, never the code. Automate the reconciliation or
   the board becomes decoration.
3. **Verification must be independent to be worth anything.** The writer's gate
   proves the change does what the writer meant; the dispatcher's injected arm
   proves the pins actually hold the property. Both are needed.
4. **A test's NAME is part of the deliverable** (a pin that reds must say what
   it protects). Green with no name is unverifiable later.
5. **An injection that does not change bytes proves nothing** (VOID), and a
   mutation that changes bytes but stays green means the pin is missing or the
   run used the wrong file. Both are information; neither is a verdict.
6. **Rules must carry their incident.** "Never pipe the gate through `tail`" is
   a rule because a lost failure block cost a full investigation. A rule without
   its story is deleted by the next busy agent.
7. **Intent over literalism.** The best landings in this repo started with the
   dispatcher saying "the mechanism you asked for cannot serve the intent; here
   is the better route" — and the worst ones with a brief flattened into
   literalism.
8. **Transport artifacts are not symptoms.** Text pasted through a translation
   layer mangles characters. Scope work from what the owner sees on screen or
   from an artifact you can render yourself — never from a mangled glyph.
9. **The box is shared.** At most two writers, one suite at a time, a hard
   memory ceiling: four writers plus a load generator once drove load average to
   ~106 on an 8-core box and the harness had to be restarted by the owner.
   An OOM-killed session is indistinguishable from a writer dying silently with
   an empty report — memory pressure destroys WORK, not just responsiveness.
10. **Running looks like idling.** A writer in a deep-verify phase has a clean
    tree and no new commit. Never nudge, never kill a running writer; wake on a
    report, a failure notice, or the human.
11. **Work is only finished when it is retired.** Delete the session, remove the
    worktree, delete the branch, update the board. An unretired finished writer
    is how a stale list becomes a wrong decision.
12. **Delegation scales the conversation, not the machine.** Probes are cheap
    and parallel because they write nothing; writers are expensive and are
    capped. Using a probe to answer "what does the code actually do?" before
    writing a brief is the highest-leverage habit in the whole process — the
    rendering slice in this repo was scoped from one read-only report that
    enumerated every surface and killed two wrong designs before dispatch.
13. **One slice, one idea, one seam.** A brief that bundles two ideas produces a
    landing that can only be verified half-way.
14. **Docs split by time-sensitivity**: decisions (never rot) · seams (checkable,
    updated in the same commit) · state (one screen, reconciled) · behaviour
    (the test is the statement).

---

## 12 · Anti-patterns (how this fails)

| Anti-pattern | What it looks like | The fix |
|---|---|---|
| **Green by wrong file** | an injected arm stays green; "the pin is missing" | grep for the pin's own test file and run THAT; a changed-behaviour green is a wrong-file signal first |
| **VOID probe read as evidence** | two arms identical; "the fix does not work" | print the changed file's hash per arm; identical arms are VOID |
| **Verifying a stale tree** | arms anchor nothing; the baseline hash differs from the writer's | fetch AND fast-forward; kill the run and say so if noticed |
| **Dispatcher dirt** | a writer's rebase refuses mid-landing | commit and push dispatcher edits in one chained command |
| **Uncommitted writer work** | a silent writer's slice vanishes | briefs require a commit before BLOCKED; salvage-check branches before deleting |
| **Blessing duplication** | a baseline line added to make a new copy green | a baseline is debt; a folded copy must red as stale until its line is deleted |
| **Prose-only centralization** | "we agreed there is one way to do X" | land the fold with an "exactly one" pin, or it drifts back |
| **Nudging a live writer** | "any progress?" every few minutes | wait for the report; the cadence contract is part of the brief |
| **Board as history** | the board grows and stops being one screen | a record that no longer describes the present belongs in the ledger or nowhere |
| **Ledger as behaviour doc** | the ledger restates how the code works | behaviour lives in a test; the ledger holds the decision and the pointer |

---

## 13 · Porting checklist for a new project

**Day 1 — build the process before the features.**

1. **`AGENTS.md`** — the binding rules (§5 above, adapted): no silent fallbacks;
   visible errors; validate at boundaries; centralize with the four obligations
   and the `COPIES:` line; critique the instruction; parallel writers; host
   hygiene. Keep it short and give every rule its incident.
2. **`docs/17-DECISION-LEDGER.md`** — a table with one row per decision:
   `| n | **statement** (evidence, at `base-sha`) — what landed — what is
   unproven | files | why | status |`. Append-only.
3. **`docs/18-ARCHITECTURE.md`** — the seam index: layer map, "the one way to do
   X" rows, gotchas, known debt. Update the row whenever a seam moves.
4. **`docs/20-ORCHESTRATION.md`** — the board: the contract, the record
   vocabulary, the guards, the recovery pointers. One screen, overwritten.
5. **`scripts/gate.sh`** — the ONE way the suite runs (§7). Start with the lock,
   the memory ceiling and the summed summary; add chunking and diff-scoping when
   the suite gets slow.
6. **`scripts/board.sh`** — the reconciler (§4.2). Even a 50-line version pays
   for itself the first time the board lies.
7. **`docs/08-TESTING.md`** — the matrix and, per landing, the differential arms
   with their hashes and the VOID probes. This is where "what was actually run"
   is written down.
8. **The worktree recipe** (§6) written into the rules, including the absolute
   path warning — it is the single most common way a slice lands in the wrong
   tree.
9. **The first slice is the process itself** if the project has none: a gate and a
   board before the second feature.

**Per slice, the loop is**: intake (restate the intent) → scope against the seam
index (probe if the answer is not obvious) → brief (row number assigned,
worktree, gate, pins, docs, BLOCKED clause) → dispatch (≤2 writers) → verify
(sha, own gate, own injection, docs) → retire (session, worktree, branch) → board
→ report.

**What to adapt, not copy**

- Paths, the lock's name, chunk names, the reconciler's specific checks, and the
  docs numbering are repo-specific.
- The **harness** matters: this process was run on an agent harness with
  subagents and a session board. The roles need equivalents: a way to run a
  second agent with its own context, and a way to see which agents are live. On
  the OpenCode harness this repo now runs on, that registry is the
  `list_subagents` tool (global `ocm-list-subagents` plugin: the CURRENT
  session's child sessions; the predecessor's DSH `list_agents`/`send_message`
  and its goal mechanism do not exist here, and there is NO agent-facing
  subagent-delete — cleanup is OpenCode Manager's). Without a registry, the
  board's `IN-FLIGHT` records become your only liveness signal — check them
  against the filesystem instead.
- The **host limits**: replace the 3000 MB cap and the two-writer ceiling with
  numbers measured on your machine. The rule is "one suite at a time, a hard
  ceiling, and never a bare unbounded test run" — the numbers are local.
- **Where `main` deploys**, keep the rule that a red or half-finished push is
  user-visible within minutes.

**The smallest version that still works**: one human, one dispatcher agent, one
`AGENTS.md` with the four rules and the `COPIES:` line, one gate script with a
lock and a memory ceiling, one decision ledger, one board with a reconciler, and
the rule that a landing is verified by the dispatcher before it is retired. Every
other mechanic in this document was added after a specific failure — add them
when you meet the failure, not before.

---

## 14 · For the human: how to drive this

The process only works if the human side is played the same way. What has proven
to work:

- **Give intent, not implementation.** "The spell chips should open the spell
  description" beats "add an onClick to SpellChip" — the agent will find the one
  seam that already does it, and a dictated mechanism can fight the codebase. If
  you *do* propose a mechanism and it is wrong, you get told once, with evidence.
- **Report what you SEE.** A screen is evidence; pasted text is transport (it can
  be mangled before anyone sees it). Naming the screen — "this was the npc view
  from the model entities" — halved that slice's scope in one line.
- **Say "log that in" when a decision matters.** Decisions become ledger rows
  that quote you, so a later slice does not re-litigate them. "The NPC smith
  needs to be explicitly caster aware" became a binding clause every later
  generation reads.
- **Batch small reports, and split big ones.** Each landing costs a full
  verification gate (minutes of machine time) plus writer time. Three
  independent defects can be one report with three lines; one defect on one
  screen is one report.
- **Expect short, numeric reports** — counts, hashes, what went red, what the
  agent got wrong. Ask for the missing thing instead of re-reading the code; the
  evidence is in the docs by design.
- **Answer questions with a choice.** "A or B?" unlocks a dispatch; silence
  stops the queue. The agent is expected to ask rather than guess when two
  honest designs exist.
- **Push back on the three real failure modes**: a green test that does not go
  red when the fix is removed; a report containing "probably"; a board or
  document that says something you can see is untrue. Those are the signals that
  the process is being performed rather than used.
- **You may simply say "dispatch the queue".** The dispatcher will order it by
  value, keep at most two writers in flight, verify each landing itself, and
  report as they complete.

