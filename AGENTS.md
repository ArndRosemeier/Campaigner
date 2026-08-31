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

- Gate before every commit: `pnpm lint && pnpm typecheck && pnpm test`.
- Commit style: subject + root-cause body + test count. Author identity is
  set per-commit via
  `git -c user.name='Campaigner Dev' -c user.email='dev@campaigner.local' commit`.
- One logical task per commit; push to `origin/main` after committing.
