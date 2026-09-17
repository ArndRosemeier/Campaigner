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

## Reading the owner's reports (transport artifacts)

The owner pastes into an interface that goes through a transport layer with
character limitations, and he has stated that this is currently unfixable on his
side. So: **unusual characters in a report are the PASTE, not a symptom.** A `?`
where the source has `—`, a mangled umlaut, a broken quote or a stray glyph is
the transport layer — do NOT scope work from it and do NOT report it as a defect
of ours (real near-miss: a `—` pasted as `?` was read as a PDF font failure and
nearly cost a slice chasing an encoding bug that does not exist, while the real
signal sat in the same quote).

The mechanism, owner-described (verbatim substance): DSH runs inside a grokbot
instance in the cloud; the owner has remote access to its virtual screen, and
text he copies travels through a translation layer into the grok VM **which
mangles umlauts** on the way. So the mangling is produced before anything of
ours sees the text. The distinction that decides work: a mangled character in
the PASTE is the transport; a mangled character he SEES ON SCREEN in the app or
in a generated PDF is ours, and worth a slice.

Diagnose a genuine encoding or rendering problem only from evidence that is not
the paste: what the owner says he SEES ON SCREEN (one line asking that settles
it when the distinction decides the work), or a rendered artifact we can inspect
ourselves.

## Centralization (rule 4, made mechanical)

Owner-ratified: *"Always try to centralize when you see distributed code pieces
that do basically the same. KISS principle, keep it simple."* Duplication is
invisible when a copy is BORN — nothing fails, and each copy is correct where it
was written — so it is caught by pins, not by discipline. **Four obligations:**

1. **A brief names the seam it extends.** Before dispatching, find how the repo
   already does the thing (grep, then `docs/18` §2) and name that ONE seam in the
   brief. A writer that finds a SECOND mechanism for the same idea reports it in
   its landing report instead of quietly adding a third; folding it in is part of
   the change unless that is genuinely more expensive than the defect, in which
   case the brief or the report says so plainly and leaves a note where the next
   reader will hit it.
2. **A centralization lands with an "exactly one" pin** — a test that goes red
   when a second implementation appears: a source-level pin over the call sites,
   or a DIFFERENTIAL pin running every copy against the same inputs and requiring
   identical output. Real case this exists for: seven copies of the HTML→text
   stripper drifted into two behaviours, one of which stored corrupted text in
   the library, and no test could notice because no test had ever declared there
   was one way to do it. Never centralize by prose alone.
3. **An index entry is checkable, a decision is history.** `docs/18` §2 rows name
   a seam and where it lives — a landing that moves or deletes one updates the
   row in the same commit (binding, same as adding a seam). Docs that RESTATE
   behaviour rot, so the test is the statement instead; docs that record
   DECISIONS never rot, which is why `docs/17` works. Pointers stay honest by
   being updated, never by being remembered.
4. **A discovery that spans more than one code piece starts with the seam
   question, and the answer is WRITTEN DOWN** (owner-directed, verbatim:
   *"Whenever something gets discovered where fixing it would affect more than
   one code piece, the first examination needs to be if this can be
   centralized. I do know that vibe coding has exactly this decentralization
   problem and we need active measures to counter it whenever its detected."*).
   The moment a defect, a rule or a change is found to touch more than one
   site — or the same idea is found written twice — the FIRST examination is
   whether ONE seam can carry it, never how to fix each copy. This binds every
   actor: the dispatcher, every writer, and work done with no brief at all. It
   is not a silent intention: every brief and every landing report carries ONE
   greppable line —
   `COPIES: n→1 — <the seam that now carries it>` when copies are folded, or
   `COPIES: 1 — checked, no duplication (grepped: <what>)` when the change
   really is single-site. A brief without that line is incomplete and is sent
   back; a landing without it is not verified. Two real failures this exists
   for: the same rule landing at three separate surfaces, one slice each, and
   **seven identical `isRecord` helpers** (one per pack adapter) that no test
   could see until a task happened to grep the right word.
   The generic detector is **LANDED** (docs/17 row 172, extended to the test
   tree by row 212 and closed across the two trees by row 215):
   `tests/architecture/no-duplicate-implementations.test.ts`
   scans every named function body under `src/**/*.ts(x)` AND under
   `tests/**/*.ts(x)` except `tests/fixtures/**` (captured upstream documents
   and prompt goldens repeat legitimately) through the TypeScript parser,
   normalizes it (comments stripped, formatting collapsed, the function's own
   and parameter names blanked so a rename cannot hide a copy) and requires each
   2+-site population to equal ITS OWN inventory exactly —
   `tests/architecture/duplicateImplementationsBaseline.json` for `src/` and
   `tests/architecture/duplicateImplementationsTestsBaseline.json` for the test
   tree (136 groups / 390 sites at row 212; both scopes at the same floor, and
   `tests/fixtures/**` is the ONLY exclusion, pinned as data). A THIRD pin runs
   over the UNION of the two trees — `scanRepo({ roots: ['src', 'tests'],
   exclude: ['tests/fixtures'] })` — and declares the cross-tree population
   (groups holding at least one `src/` site AND one `tests/` site) in
   `tests/architecture/duplicateImplementationsCrossTreeBaseline.json`: a body
   written in `src/` and re-implemented in a test is a single site in each
   scoped scan and so invisible to both, and the union pin is what makes it red
   naming both sites. That population is EMPTY at row 215 — the one measured
   entry (the `publicationSourceLine` pair re-implemented as the
   `source-line.test.ts` reference expectation) was FOLDED onto the exported
   seam, and the pin's non-vacuity arm proves a synthetic cross-tree pair still
   reds.
   The floor is **75 normalized characters** — the largest floor that
   still sees the seven-copy `isRecord` case this rule was born from, so the
   floor is MEASURED, not guessed (a 120-char floor cannot see it). A NEW copy
   reds naming every site; a FOLDED copy reds as a stale entry until its baseline
   line is deleted, so a blessing cannot outlive the duplication. It catches
   identical copies, not paraphrases, and cannot see bodies under the floor
   (`settledDetail`, 3 sites at 74 characters, is recorded in `docs/18` §5) — a
   tripwire, not a proof; obligation 2's per-idea pin still closes each fold.

## Workflow

- Start every task at `docs/18-ARCHITECTURE.md` (the seam index: layer map,
  "the one way to do X", gotchas, known debt), then read the feature spec for
  the area you are touching.
- The PROCESS itself — the roles, the board and its record vocabulary, the gate,
  the verification doctrine, the brief template and the porting checklist — is
  described self-containedly in `docs/22-DEVELOPMENT-PROCESS.md`. Read it when
  you are new to this workflow, and take it with you when starting another
  project.
- Any arc that adds or changes a seam, convention, gotcha or known-debt entry
  amends `docs/18-ARCHITECTURE.md` in the same docs commit as its feature
  spec — an unamended seam is treated as missing.
- Gate before every push — in TWO TIERS (`docs/17` row 232, owner-directed
  2026-09-17: *"its actually ok to push unverified code as long as it compiles
  and as long as the verified code goes in a few minutes later… i am the only
  user of this app at the moment."*):
  1. **The COMPILE tier blocks the push.**
     `GATE_TESTS=0 bash scripts/gate.sh` — typecheck (+ lint if asked).
     MEASURED 27s. It exists because the deploy job runs `pnpm build` =
     `tsc -b && vite build`, so a **type error** is what breaks a deploy: the
     workflow fails and the live site silently keeps the previous bundle. Lint is
     NOT deploy-critical (nothing in CI runs it), which is why it is opt-in
     (`GATE_CHECKS=all`, ~2m) rather than the default. Exit 2 = compiles/clean —
     a result that did NOT run the suite and must never be reported as "the gate
     passed".
     **A BUILD-CONFIG DIFF ALSO RUNS THE BUILD.** A change touching
     `vite.config.ts`, `tsconfig*.json`, `package.json`, the lockfile,
     `index.html` or `public/` can pass `tsc -b` and still break `vite build` —
     and the owner's own requirement is that the pushed build stays testable
     (verbatim: *"no compile errors before push, thats really needed because i
     need to be able to still test the app"*). The compile tier detects that diff
     and runs `pnpm build` as well; `GATE_BUILD=0` skips it deliberately and
     loudly. Do not weaken this to save time: a broken build is the one failure
     the owner cannot work around.
  2. **The FULL gate does not block; it follows.** `bash scripts/gate.sh` (the
     ONE way the suite runs, §Host hygiene 7) is started in the BACKGROUND right
     after the push, in the SAME session, and its result is OWNED: a green result
     is recorded on the board; a RED one is fixed forward IMMEDIATELY, before any
     other change lands — never stacked behind a second unverified commit. The
     writer's own landing report still carries a FULL green gate on its slice;
     this tier covers the integrated tree. A background run's log MUST go to the
     workspace (the gate's default `GATE_LOGDIR`), never `/tmp` — `/tmp` is
     private per call here, so a `/tmp` log dies with the process and a red
     result becomes undiagnosable.
  **The honest cost, recorded rather than glossed:** `origin/main` can carry an
  UNVERIFIED commit for the ~10 minutes the full tier runs. That is acceptable
  ONLY because the app has ONE user (the owner) and a red result is fixed
  forward within minutes. If a second user ever exists, or `main` gains a second
  consumer, this reverts to gate-then-push — the trade is a single-user app,
  not a general permission.
  **Keep the gate's RAW output** — write it to a file under the workspace (never
  `/tmp`, see above) and keep it until the landing is verified; never pipe the
  run through `tail`/`head`. Real incident
  (2026-xx, a landing's gate): one test failed, the writer had piped the run
  through `tail -10`, and both the failing test's NAME and its
  `Expected`/`Received` block were destroyed. The surviving tail ended on a
  *context* line two lines BELOW the real assertion, so the loss not only hid
  the received value but actively misattributed the failure to the wrong line —
  it cost a full separate investigation to recover. A red run whose evidence was
  discarded cannot be diagnosed.
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

1. **File disjointness applies to `src/` — and CANNOT hold for the docs.** Every
   landing amends `docs/08`, `docs/17` (and usually `docs/18`), so two concurrent
   writers WILL conflict there. Real incident: two writers landed on the same
   day, both numbered their ledger row **136**, and each wrote "docs/17 row 136"
   into its own docs/08 section, docs/18 entry, code comment and test file. Two
   rules follow:
   - **The dispatcher assigns the ledger row number in every brief** (read
     `docs/17` for the next free number at brief time), so two briefs cannot
     claim the same one.
   - A writer that still hits a docs conflict resolves it as a mechanical
     UNION, then: renumbers ITS OWN row and every reference to it, touches
     NOTHING of the other landing's row or references, proves that with
     `git diff --name-only <other landing> <its commit>` naming no file from the
     other slice, and re-gates the FULL suite on the rebased tree before
     pushing. Never resolve a semantic difference inside another writer's slice.
2. Gate budget: combined test workers ≤ cores. `vite.config.ts` already
   defaults `maxWorkers` to `DEFAULT_TEST_WORKERS` (2) and the CLI
   `--maxWorkers` flag does NOT bind here (§Host hygiene 3), so a bare
   `pnpm exec vitest run` is bounded as it stands; lower it further only via
   `CAMPAIGNER_TEST_WORKERS`.
3. Rebase discipline: `git pull --rebase origin main` before every push. A
   conflict in the shared DOCS is expected, not a missed disjointness check
   (item 1) — resolve it by that rule, renumber, re-gate and push. A conflict
   anywhere else means the disjointness check missed something: stop and
   report instead of resolving.
4. Re-verify duty: whichever brief was written against an older HEAD
   re-verifies its findings at landing time.
5. **Worktree setup (verified recipe — REWRITTEN 2026-09-17 for this harness).**
   Put the worktree INSIDE the repo, under `<repo>/worktrees/<slice>`. The old
   `/tmp/<slice>` recipe is IMPOSSIBLE here and was measured to be: `/tmp` is a
   per-call, READ-ONLY tmpfs (`mount` from a second bash call shows
   `tmpfs on /tmp ... (ro)`), so a worktree created in one call does not exist for
   the next — a writer following the old recipe would edit the MAIN tree and
   destroy the parallel-writer guarantee. Outside-the-repo is impossible too: the
   workspace's PARENT is read-only. In-repo is the only writable location, so
   `eslint.config.js` ignores `worktrees` (an unignored in-repo worktree would be
   swept into the main tree's `eslint .` run — the hazard the old warning named,
   now handled at the source instead of by moving the worktree). `worktrees/` is
   gitignored, so the main tree stays clean. Symlinking the main tree's
   `node_modules` still does NOT work — 28 test files fail with `Denied ID
   …/pdfjs-dist/legacy/build/pdf.worker.mjs?url` from Vite's `server.fs.allow`
   while lint and typecheck still pass, so it reads as a real regression.
   `pnpm install --offline` fails with `ERR_PNPM_NO_OFFLINE_META`; a plain
   `pnpm install --frozen-lockfile` succeeds in seconds from the local pnpm
   store. The gate and the suite lock both resolve correctly from inside a
   worktree (verified: `git rev-parse --git-common-dir` is the SAME absolute path
   from the main tree and from a worktree, which is what makes the lock one lock
   across writers — see the lock derivation in `scripts/gate.sh`).
6. **A worktree instruction is not self-enforcing (real incident).** Every
   bash call runs in a fresh shell whose working directory is the session
   workspace, and the file tools resolve RELATIVE paths against that same
   workspace — so a writer told to work in `<repo>/worktrees/<slice>` edits the MAIN
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

## The environment this runs in (owner-described)

- **The box is a grokbot instance in the cloud**, and grokbot is its admin while
  the owner works through a remote view of its virtual screen.
- **The owner runs ANOTHER, SEPARATE DSH project in parallel in this same
  harness** (owner-corrected: the extra agents belong to that project, NOT to
  grokbot — an earlier version of this note said otherwise and was wrong). They
  share the box, the user account and the memory. **Named and observed:** that
  project is `CivGlm` (`/home/box/Harness/CivGlm`, a monorepo with
  `packages/core` and `packages/web`), and it runs BOTH vitest (`packages/core/test/…`,
  caught at six workers with no ceiling) and Playwright
  (`packages/web/node_modules/.bin/../@playwright/test/cli.js test --workers=1`),
  which is memory-heavy in its own right. So a suite you did not start is not
  yours: decide ownership by the worktree path in its COMMAND LINE (`cwd` is
  unreadable for subagent processes — measured), reap only your own, and WAIT
  for the rest (§Host hygiene 7) — never reap a peer project's gate.
  Their runs are outside our rules, and the OOM killer takes whatever is
  largest, which is the harness BOTH projects live in: the discipline below
  protects the other project's sessions as much as ours.
- **A push to `main` DEPLOYS** (GitHub to the owner's own server), and he then
  tests it in Chrome on Windows. So `main` is not a staging area: a red or
  half-finished landing is user-visible within minutes of the push, which is why
  the gate runs before every push and why an unverified landing is never
  "probably fine".
- Starving this box does not merely slow a build — it costs the owner his
  remote screen and can kill the harness itself (§Host hygiene 7).

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
7. **A GATE IS A LOCK, AND EVERY RUN CARRIES A MEMORY CEILING.** Third
   occurrence, owner-visible (the kernel OOM-killed `dsh` itself and the
   owner had to restart the harness): the dispatcher ran the full suite
   plus two PDF-rendering suites as an UNATTENDED background job with no
   ceiling, and the OOM killer took the largest process on the box — which
   is DSH. **Understand the failure mode this time: an OOM-killed `dsh`
   process is indistinguishable from a writer dying silently with an empty
   report** (three writers died that way on one slice before the mechanism
   was recognised), so memory pressure destroys WORK, not merely desktop
   responsiveness.
   - **One suite at a time in the whole session — and make the check a real
     LOCK, not a snapshot.** `pgrep` is only a diagnostic: two of our agents
     can look in the same instant, both see "free", and both start. Acquire an
     atomic lock instead (`mkdir` succeeds or it does not), and keep `pgrep`
     for the foreign suites we cannot lock out (the owner's other DSH project):
     `L=/tmp/campaigner-suite.lock; mkdir "$L" 2>/dev/null || exit 9;
     printf '%s %s %s\n' "$$" "$(date +%s)" "$PWD" > "$L/owner";
     trap 'rm -rf "$L"' EXIT`
     A lock whose owner file is older than 30 minutes AND with no `vites[t]`
     process alive is STALE (a killed run): remove it and say so. Keep the
     `pgrep` check in its OWN call — a combined one-liner self-matches, because
     its own command line contains the literal word it greps for, and then
     reports BUSY forever (hit for real while writing this rule).
   - **Every run carries a heap ceiling**, so the kernel is never asked to
     choose: `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1 pnpm exec vitest run`
   - **THE GATE IS `scripts/gate.sh` — locked, hard-capped, chunked.** Owner
     directive (verbatim): *"please make sure that you restrict the mem use to
     not more than 4gb or so since you are not the only worker here."* The
     script takes the atomic lock and refuses to start while ANY other suite runs
     (ours or the peer project's). It runs vitest as at most **TWO concurrent
     path chunks** — each ONE worker in its OWN process group (`setsid`), a fresh
     process per chunk, because the growth that fills this box is OFF-heap and no
     heap cap can stop it. `tests/features` is split round-robin into
     `tests_features_a` / `tests_features_b` so the two long tails overlap, and
     `GATE_PARALLEL_CHUNKS=1 bash scripts/gate.sh` forces sequential. It samples
     the COMBINED RSS of every live chunk group every second and kills them all at
     `GATE_RSS_CAP_MB` (default 3000 MB) or when available memory drops below
     `GATE_AVAIL_FLOOR_MB` (default 2500 MB); a kill is VOID, is re-run
     sequentially and is never counted, and a combined peak that merely
     APPROACHES the cap (`GATE_PARALLEL_FALLBACK_MB`, 90%) falls back to
     sequential BEFORE the kill line. It prints each chunk's wall time and PEAK
     RSS with the summed counts, and checks on every run that the union of its
     chunk lists is exactly the test files under `tests/`, none twice. The diff
     base is `origin/main` (three-dot) plus the working tree: the chunks a diff
     touches run FIRST, so a red surfaces in ~1–2 minutes instead of ~12; vitest
     is skipped ENTIRELY only for a **docs-only** diff (lint and typecheck still
     run), and a diff touching test files ALONE runs only the chunks containing
     them. EVERY other diff runs the full set — there is no other skipping,
     because a gate that guesses at coverage is the failure mode this refuses.
     `GATE_PLAN_ONLY=1` prints the plan and runs nothing (how the mapping above is
     reviewable without a 7-minute run). `vite.config.ts` caps each worker's heap
     at 1536 MB as the structural half, which binds a bare run too. **Do not
     hand-roll a gate.**
   - **Ad-hoc PDF-rendering verification** (`pdfLayout`, pdfjs, pdfmake —
     injection runs, single-file checks) goes in the FOREGROUND in bounded
     chunks: a `-t`-filtered run is seconds, not minutes. The 600 s
     foreground cap is a reason to chunk such a run, never a reason to hide
     it in a long unattended background job. **The LANDING GATE (full
     suite) is the one exception** — it cannot fit the cap, so it runs as a
     background job ONLY under the ceiling, ONLY holding the lock, ONLY
     when the dispatcher stays in-session to watch it (the harm was an
     unwatched run the dispatcher could not react to, not background jobs
     as such).
   - **The ceiling is the second line of defence, not the primary one.**
     `--max-old-space-size` bounds a V8 heap, while the PDF-rendering
     suites also hold `ArrayBuffer` memory outside it — so the bound that
     actually keeps the box alive is **one worker, one suite at a time**.
   - **A killed run's result is VOID**, never evidence: re-run it under the
     lock before claiming anything from it.
   - **An INJECTION holds the tree only while its run is LIVE, and it is restored
     by a `trap`.** Real incident, the dispatcher's own: an injection was applied
     in the shared main tree BEFORE waiting for the lock, so reversed code sat
     uncommitted there for ~20 minutes while two writers gated and committed — one
     of them found it, reported it and stayed out of it (the correct move, and the
     only reason nothing broke); a writer that ran `git add -A` would have
     committed the injection. So: **take the lock FIRST, then inject, then run,
     then restore in a `trap`** so a killed job cannot leave it behind. Never wait
     while injected, and treat a dirty shared tree observed by a writer as a
     DISPATCHER defect, reported rather than resolved.
   - **A DIFFERENTIAL'S ARMS MUST BE SHOWN TO DIFFER.** Print the changed file's
     hash for EVERY arm, and treat two arms with identical output as a VOID probe
     (the injection did not change what ran) — never as evidence against a
     landing. Real incident, the dispatcher's own (2026-09-15, board row 178): its
     probe script broke the cure in the SAME step as the delay, so the "cure
     intact" arm actually measured bypassed bytes; the two arms came back
     identical, the dispatcher read that as falsifying a writer's fix and reopened
     a slice whose own full gate had already passed — the writer's reconciliation
     (hash-printed arms, a 4× delay range, warnings inside the raw windows) was
     right and the probe was void. Identical arms are the TELL, not the result.
   - **Ownership is the WORKTREE PATH IN THE COMMAND LINE — not `cwd`, and
     never a pattern kill.** Measured: `readlink /proc/<pid>/cwd` returns EMPTY
     for processes owned by subagent sessions, so the cwd test silently matches
     nothing (a kill attempt written that way did nothing at all while a suite
     kept growing). What does identify a run is its argv: a writer's suite names
     its own worktree (`… /tmp/campaigner-<slice>/node_modules/.bin/../vitest/vitest.mjs`).
     Kill BY PID, matched on a pattern BUILT AT RUNTIME so the killer's own
     command line cannot match it (row 94: a pattern kill SIGTERMed its own
     shell). Foreign suites — the owner's other DSH project — are waited for, not
     reaped. An interrupted writer's waiting loop is an ORPHAN and is the
     dispatcher's to reap (it will otherwise start a suite nobody is watching).

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
- **A writer that cannot finish must COMMIT, not merely stop.** Uncommitted
  work dies with the session. Real incident (one slice, back-to-back): two
  writers failed with EMPTY reports — no message, no BLOCKED — the first
  leaving an uncommitted draft that survived only because its worktree was
  still on disk, the second preserved only because it had committed its
  work-in-progress on its branch before dying. Every brief therefore
  requires: if you cannot finish, commit the coherent partial state on your
  branch and report BLOCKED. A branch commit survives a silent death; an
  uncommitted tree may not. The dispatcher, for its part, verifies a
  recovered branch as if it were a fresh landing — a dead writer's commit
  has never been gated by a live report.
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
coordinate or delegate — the session runs under this standing rule. The role is
built to be DISPOSABLE: assume this session can die at any moment and keep
everything it knows on disk — `docs/20-ORCHESTRATION.md` (the board), `docs/17`
(decisions), committed branches (work). The predecessor session died of a
compaction/context failure (2026-09-14); this section is the answer to that
death, not a description of a job.

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
- **1 · Session start — reconcile before anything else.** In this order:
  (a) read `docs/20-ORCHESTRATION.md` — in-flight writers, unlanded branches,
  the owner's decision queue; (b) run `bash scripts/board.sh`: the board is
  prose about state, so it is CHECKED, never believed; (c) compare its writer
  records against the live registry (`list_subagents`) and the host (`uptime`,
  orphan `vites[t]`, suite lock); (d) fix the board where it lied, report ONE
  line, then wait for a request. No dispatch before this pass. **Reconcile
  against `origin/main`, never local `main`** — real error: row 167 read as
  "unlanded" for hours while it was pushed, deployed, and 5 commits ahead of a
  stale local `main`.
- **2 · The loop.** intake (restate the intent behind the literal ask; if the
  mechanism is wrong, say so once with its evidence — §critique the
  instruction) → scope against `docs/18-ARCHITECTURE.md` + the feature spec →
  brief (the ONE seam it extends, the ledger row YOU assign at brief time from
  `docs/17`, worktree, gate, cadence contract, "commit the coherent partial
  state or report BLOCKED at every green milestone") → dispatch (≤2 writers in
  flight, separate `/tmp` worktrees, ABSOLUTE paths) → verify every landing
  YOURSELF (SHA on `origin/main`, own gate with raw output kept, own injection
  WATCHED RED against a NAMED pin, docs amended in the same landing) → retire
  (session, worktree, branch — §Subagent hygiene; a recovered or silent
  writer's branch is verified as a FRESH landing) → update the board in the
  same commit as the landing → report. Do not implement large changes yourself
  while a writer can.
- **3 · Death insurance.** The board is true BEFORE a report reaches the owner;
  a writer's partial work is COMMITTED on its branch, never left uncommitted; a
  silent writer is salvage-checked (`git log` on its branch + worktree status)
  before anything is deleted. If this session cannot finish, its last act is a
  board update and a commit — not an apology.
- **4 · Context budget.** Evidence goes into docs, never into the thread: quote
  numbers instead of pasting logs, keep briefs self-contained (never "as
  discussed"), keep reports short. The predecessor's 35 MB session log is what
  hoarding looks like, and a session too large to compact is a session that
  cannot be recovered (the compaction patch in `docs/20` Guards is the second
  line of defence, not the first).
- **5 · Disposability.** A fresh session must be able to act within minutes from
  the board + `docs/17` + `git worktree list` / `git branch -a`. The owner may
  restart this session at any time: that is a handover, not a loss. While all
  work is delegated the goal stays paused and the session waits in silence
  (§Goal rounds vs. waiting).
