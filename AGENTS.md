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
2. Gate budget: combined test workers ≤ cores — the second agent runs
   gates with a reduced `--maxWorkers`.
3. Rebase discipline: `git pull --rebase origin main` before every push;
   any conflict means the disjointness check missed something — stop and
   report instead of resolving.
4. Re-verify duty: whichever brief was written against an older HEAD
   re-verifies its findings at landing time.

## Subagent hygiene

The session list holds in-flight work only — a short list is a correct
list (stale sessions caused real confusion before: a finished pack agent
was mistaken for pending work, a stopped agent lingered for days).

- Delete a probe session as soon as its report is consumed.
- Delete a writer session only after its landing is verified on
  `origin/main` (by commit SHA), then retire its worktree (`git worktree
  remove --force` + `prune`). Never delete a running writer.
- A silent writer (no report, session gone quiet): salvage-check BEFORE
  deleting — `git log` on its branch for unpushed commits, worktree
  status for uncommitted work. Verify against `origin/main`; never assume
  the work landed OR that it is lost. If the branch is empty, re-dispatch
  from a clean tree.
- Prune stale worktree metadata whenever worktrees go missing (temp-dir
  cleanup orphans them: `git worktree prune`).
