# Campaigner — agent/workspace rules

TTRPG campaign manager. Vite + React + TS strict, Tailwind/shadcn, Dexie,
zod, OpenRouter LLM runs. Spec lives in `docs/` — read the relevant doc
before working on an area; conventions in `docs/00-OVERVIEW.md §Global
conventions` are binding.

## Binding engineering rules

1. **No silent fallbacks.** When data, parsing, or a step fails, propagate a
   loud error — never substitute placeholder output. Concretely forbidden:
   - finalizing artifacts from empty/failed drafts, or naming them after the
     persona/step ("Worldbuilder"-class bugs),
   - `catch`-and-continue around parsing/validation,
   - `console.error` without a user-visible surface,
   - placeholder values ("unknown artifact", empty strings) standing in for
     required data.
   Defaults are allowed ONLY for genuine user preferences and optional
   enrichment (unset generation language → `'en'`), never to mask a failure.
2. **Errors must be visible.** Every caught error surfaces via
   `src/lib/toast.ts` (`toastError`), the global error boundary, or a failed
   run row with `errorMessage`. No error may end in `console.error` only.
3. **Validate at every boundary.** LLM/JSON output is parsed with zod; a
   validation failure is an error (fail the run / pause for review), never a
   path to empty data.
4. **Centralize what is duplicated, and keep it simple** (owner-directed,
   verbatim: *"Always try to centralize when you see distributed code pieces
   that do basically the same. KISS principle, keep it simple."*). When one
   idea is implemented in more than one place, make it ONE seam and have the
   callers go through it — a rule enforced at three call sites is a bug
   waiting at the fourth, and two mechanisms for one idea drift apart (the
   owner-visible run this rule came from: "a deliberate owner action is not a
   failure" had to be fixed at three separate surfaces in a row, one slice
   each). When you touch a pattern that is ALREADY distributed, folding it
   into one seam is part of the change unless that is genuinely more expensive
   than the defect — in which case say so plainly and leave a note where the
   next reader will hit it.
   Simplicity cuts the other way too: prefer the smallest design that does the
   job — no speculative generality, no abstraction serving a single caller, no
   new mechanism where an existing one already answers the question.

## Standing rule: critique the instruction (owner-directed)

The owner's instructions are INTENT, not design. Never implement a mechanism
you can show is flawed, and never flatten a request into literalism when a
better route to the same intent exists.

1. **Extract the intent first.** Before scoping, state (to yourself, in the
   brief, or to the owner) what outcome the request is trying to reach — the
   felt problem behind the literal ask. The literal mechanism is often one of
   several ways there.
2. **Say it when the ask is flawed.** If the requested mechanism is wrong,
   fragile, or more expensive than the goal needs, say so plainly and offer
   the better way with its reasoning — briefly (a few lines), not a lecture.
   Presenting a real counter-proposal is part of the job, not insubordination.
3. **Do not silently substitute.** A different design may replace the asked-for
   one only when it serves the SAME intent and the owner has been told. Silent
   re-scoping is a bug of its own: the owner must always be able to see which
   decisions were theirs and which were the agent's.
4. **Judge whether it is worth the friction.** Minor imperfections in an
   otherwise sound instruction get decided and noted in one line, not turned
   into a debate. Reserve pushback for choices that cost real quality, real
   work, or real user surprise.
5. **Route the critique through reality, not taste.** "This feels off" is not
   a critique; "this breaks X, here is the code/doc that proves it, and this
   other seam already does the job" is. Diagnose before objecting.
6. **Bind briefs to it too.** Every writer brief states the intent and the
   chosen mechanism, and instructs the writer to report BLOCKED (with the
   reasoning) rather than implement something it can prove is wrong — including
   when the flaw is in the brief's own design.
7. **The decision stays the owner's.** Present the better way once, clearly.
   If the owner reaffirms the original direction, execute it well and stop
   re-arguing; record the reasoning in the commit body or docs if it matters
   later.

## Workflow

- Start every task at `docs/18-ARCHITECTURE.md` (the seam index: layer map,
  "the one way to do X", gotchas, known debt), then read the feature spec for
  the area you are touching.
- Any arc that adds or changes a seam, convention, gotcha or known-debt entry
  amends `docs/18-ARCHITECTURE.md` in the same docs commit as its feature
  spec — an unamended seam is treated as missing.
- Gate before every commit: `pnpm lint && pnpm typecheck && pnpm test`.
- Commit style: subject + root-cause body + test count. Author identity is
  set per-commit via
  `git -c user.name='Campaigner Dev' -c user.email='dev@campaigner.local' commit`.
- One logical task per commit; push to `origin/main` after committing.

## Parallel writers

Read-only agents always run in parallel. Two WRITING agents may run in
parallel only in SEPARATE worktrees (`git worktree add` per agent): writers
sharing one working tree share one git index, and `git commit` commits the
whole index — file-disjointness does NOT protect the commit phase (real
incident: a purge commit swept a concurrent writer's staged feature work
under the wrong subject). Same-tree writers therefore serialize: one
writer stages, commits and pushes at a time. When separate worktrees are
used:

1. File disjointness still applies (no shared files across the slices).
2. Gate budget: combined test workers ≤ cores. `vite.config.ts` already
   defaults `maxWorkers` to `DEFAULT_TEST_WORKERS` (2) and the CLI
   `--maxWorkers` flag does NOT bind here (§Host hygiene 3), so a bare
   `pnpm exec vitest run` is bounded as it stands; lower it further only via
   `CAMPAIGNER_TEST_WORKERS`.
3. Rebase discipline: `git pull --rebase origin main` before every push;
   any conflict means the disjointness check missed something — stop and
   report instead of resolving.
4. Re-verify duty: whichever brief was written against an older HEAD
   re-verifies its findings at landing time.
5. **Worktree setup (verified recipe).** Put the worktree under `/tmp`,
   never inside the repo: an in-repo worktree gets swept into the main
   tree's `eslint .` run and corrupts the other writer's gate. Symlinking
   the main tree's `node_modules` does NOT work — 28 test files fail with
   `Denied ID …/pdfjs-dist/legacy/build/pdf.worker.mjs?url` from Vite's
   `server.fs.allow` while lint and typecheck still pass, so it reads as a
   real regression. `pnpm install --offline` fails with
   `ERR_PNPM_NO_OFFLINE_META`; a plain `pnpm install --frozen-lockfile`
   succeeds in seconds from the local pnpm store.
6. **A worktree instruction is not self-enforcing (real incident).** Every
   bash call runs in a fresh shell whose working directory is the session
   workspace, and the file tools resolve RELATIVE paths against that same
   workspace — so a writer told to work in `/tmp/<worktree>` edits the MAIN
   tree unless every call passes an absolute path (or `workdir`). A writer's
   six-file slice landed in the main tree while its own worktree sat clean
   and commitless, and the other writer's gates kept failing on half-finished
   foreign files; the slice had to be lifted out as a patch and reverted by
   hand. Every worktree brief must state this, and every `edit`/`read`/`write`
   in a worktree session must use absolute paths under that worktree.

The **dispatcher is a writer for this purpose too**. An uncommitted edit of
its own in the shared tree (rules or docs) makes a landing writer's `git
pull --rebase` refuse mid-landing — real incident: a writer had to verify
`behind=0` and push `HEAD:main` directly because the dispatcher's edit sat
unstaged in `AGENTS.md`. Stage, commit and push dispatcher edits in ONE
chained command, and never leave one uncommitted while a writer is gating.

## Host hygiene (load discipline)

Real incident, owner-visible (the host became unusable and DSH had to be
restarted): four writers in flight PLUS a load generator one of them had
written drove the load average to ~106 on this 8-core box and starved
everything. The box is shared with the owner's own tools — it is NOT a test
fixture.

Real incident, SECOND occurrence, owner-directed (ledger row 94): a writer's
bare, UNBOUNDED `vitest run` outlived its turn — the harness restarted
mid-turn and the run kept going, 8 processes and 7 workers, until the
dispatcher reaped it. The owner's instruction, verbatim: **"Second time
something like that happened. Please put a rule up to not use up all
resources."** So the rule below is STRUCTURAL, not a reminder: the bound is
the config default, and it holds for whoever forgets. Binding rules:

1. **At most TWO writers in flight** (this supersedes the "≤ cores" gate
   note above). The dispatcher counts the registry before dispatching, and a
   verified landing frees a slot.
2. **No synthetic load, ever.** No busy-loop scripts, no `yes >/dev/null`
   blocks, no stress harnesses, no N-way suite hammering. A flake is proved
   deterministic by DELAYING its cause (the `89e5d71` method in
   `docs/08-TESTING.md`) and by repeating the suite SEQUENTIALLY — never by
   loading the machine. "Prove it under load" in a brief means "prove the
   race is gone deterministically"; the dispatcher must say exactly that and
   must never invite unbounded parallelism.
3. **Gates are bounded BY DEFAULT — the config is the bound, the env var
   raises it.** `vite.config.ts` defaults `maxWorkers` to
   `DEFAULT_TEST_WORKERS` (2), so the bare `pnpm exec vitest run` — the very
   form behind both incidents — cannot exceed two workers. Raising it is an
   explicit act for a run that owns the machine:
   `CAMPAIGNER_TEST_WORKERS=4 pnpm exec vitest run`.
   MEASURED with an isolated `/proc` CPU sampler that counts only the suite's
   own process tree (one suite at a time), when the default was still 6:
   - `pnpm exec vitest run --maxWorkers=2` → **6 CPU-busy workers, 10 alive**;
   - no flag → the same 6 (that config default at the time);
   - `CAMPAIGNER_TEST_WORKERS=2 pnpm exec vitest run` → **2 busy, 5 alive**.
   Why no flag can work here: `vite.config.ts` declares two `test.projects`
   (`node` + `jsdom`) with `extends: true`, so each project inherits the
   file-level `maxWorkers` and vitest resolves a project's own value ahead of
   the root config that a CLI override lands on. `pnpm test -- --maxWorkers=2`
   is broken twice over — the literal `--` also stops vitest receiving it (a
   single-file filter after `--` ran all 235 files). A mis-set
   `CAMPAIGNER_TEST_WORKERS` fails loudly instead of silently defaulting. One
   suite run at a time per writer, no overnight loops, no background job left
   pumping when a turn ends.
4. **An interrupted turn's processes are the DISPATCHER's to reap.** A turn
   that dies — harness restart, crash, killed session — does NOT kill what it
   started, and a survivor keeps burning the shared box invisibly. After ANY
   restart, resume or interrupted writer, the dispatcher's FIRST action is a
   process audit (`pgrep -af "vitest"`) and it kills the orphans before
   dispatching anything new; a killed suite means the writer's gate must be
   re-run from clean, never assumed. Killing by pattern must not match the
   killer: a command line containing that pattern kills its own shell (real
   incident, row 94 — `pkill -f "vitest run --reporter=dot"` SIGTERMed
   itself), so use a self-excluding pattern (`pgrep -af "vites[t]"`) and kill
   by PID.
5. **Nothing outlives the writer.** Scratch harnesses live under that
   writer's own `/tmp/<worktree>` directory, every process it starts is
   foreground or killed before it reports, and load-generating scripts are
   DELETED rather than left executable.
6. **The dispatcher verifies the host, not just the diff**: `uptime` and a
   process scan (`pgrep -af "vitest|loadgen"`) before dispatching and after
   every landing; it cleans up its own writers' leftovers and reports the
   incident to the owner.

## Subagent hygiene

The session list holds in-flight work only — a short list is a correct
list (stale sessions caused real confusion before: a finished pack agent
was mistaken for pending work, a stopped agent lingered for days).
Retiring is part of the work, not cleanup to do later: the dispatcher
audits the registry (and the branch list) at every landing verification
and whenever the owner asks — an unrun audit is why 57 stale branches were
once found by the owner instead of the agent.

- Delete a probe session as soon as its report is consumed.
- Delete a writer session only after its landing is verified on
  `origin/main` (by commit SHA). Never delete a running writer.
- A BLOCKED writer is deleted once its reasoning is captured where it
  matters (a follow-up brief, a doc line, the owner report) and the
  salvage check below confirms it wrote nothing. "No landing to wait
  for" is not a reason to leave it listed.
- **Retire the branch, not just the worktree.** A verified landing means:
  the session is deleted, `git worktree remove --force` + `git worktree
  prune`, AND the writer's branch is deleted. Local branches: delete.
  Remote branches: shared state — delete only with the owner's explicit
  go-ahead, and record every deleted tip SHA in the report as the
  recovery pointer.
- **Safe-delete test (branches):** a branch is deletable when `git log
  --oneline main..<branch>` is empty. If it is NOT empty, do not delete
  and do not assume loss — the branch may be a superseded iteration whose
  content landed under rewritten history (real case: one commit outside
  `main` whose feature was already in `main` under different commits).
  Verify content (`git diff --stat main...<branch>` + grep for the
  feature in `main`), then delete and report the tip SHA.
- A silent writer (no report, session gone quiet): salvage-check BEFORE
  deleting — `git log` on its branch for unpushed commits, worktree
  status for uncommitted work. Verify against `origin/main`; never assume
  the work landed OR that it is lost. If the branch is empty, re-dispatch
  from a clean tree.
- Prune stale worktree metadata whenever worktrees go missing (temp-dir
  cleanup orphans them: `git worktree prune`).

## Goal rounds vs. waiting (round discipline)

An armed goal's round ticks are NOT work orders. (Under the chief-of-staff
standing rule below, the session's ONE goal stays paused — ticks then never
arrive; this section governs the rare explicitly-armed case.) Real incident
(twice in
one day): with two writers mid-flight, the dispatcher treated successive
round ticks as license to churn — first deleting a writer whose registry
state was RUNNING (violating "never delete a running writer"; it was in a
legitimate deep-verify phase with no commits yet), then narrating
"holding" into every round while running read-only checks, which is
itself churn. Binding rules:

1. **All remaining work delegated ⇒ pause the goal** (`update_goal`
   action `pause`). Round ticks must never trigger status nudges,
   salvage deletes, re-dispatches, or holding commentary. Wake
   conditions are: a writer's landing/BLOCKED report, a runtime failure
   notice, or a direct user message. Nothing else.
2. **[running] means alive.** Clean tree + no commit while the registry
   says running is NORMAL for a deep-verify or long-generation phase —
   never grounds for a nudge, let alone deletion. The salvage protocol
   above applies only after the registry shows the writer NOT running.
3. **Round-budget pressure is never the writer's problem.** If rounds
   run short while work is in flight, `edit` `max_goal_rounds` upward
   and stay paused. Compressing a writer to satisfy a tick is forbidden.
4. **A nudge (`send_message`) is a last resort** for real stagnation
   only: registry idle/ready (not running) with no report across
   checks, or the writer itself reporting being stuck. A nudge may not
   demand intermediate reports — that churns the writer's context.
5. Briefs carry the cadence contract: writers report on LANDING or
   BLOCKED, nothing in between; dispatchers wait in silence.

## Chief of staff (standing rule, owner-directed)

When the owner designates the agent chief of staff — or asks it to
coordinate or delegate — the session runs under this standing rule:

- **One frozen goal.** The session holds exactly ONE goal: the standing
  chief-of-staff objective. On designation, create it once if absent
  (round cap = the configured ceiling) and pause it immediately — the
  designation authorizes exactly those two touches. Afterwards NEVER edit,
  resume, re-scope, or complete it: a paused goal never ticks, and every
  goal update burns the session's shared goal budget (a previous chat died
  at the goal limit from per-task goal churn). Work is driven by wake
  events only: an owner message, a writer's landing/BLOCKED report, or a
  runtime failure notice. A tick that still arrives while work is
  delegated gets silence (rules 2–5 above bind unchanged). Re-arming the
  goal for an autonomous unattended arc requires the owner's explicit
  go-ahead. Task state lives in the session todo list and the subagent
  registry — never in goal revisions.
- **Role.** Intake requests → scope each against `docs/18-ARCHITECTURE.md`
  + the feature spec → delegate implementation to writer subagents with
  complete, self-contained briefs (binding rules, owner intent verbatim,
  pinned design decisions, seams to respect, docs + tests obligations,
  gates, cadence contract) → verify every landing yourself (commit SHA on
  `origin/main`, gates green, specs amended in the same landing) → report
  to the owner. The §Subagent hygiene rules bind the registry side: delete
  probes once their report is consumed; delete writers only after a
  verified landing; retire a BLOCKED writer once its reasoning is
  captured; never a running writer; salvage-check a silent one first; and
  retire the branch with the worktree. Do not implement large changes yourself while a writer can.
