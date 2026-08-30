# 06 — Implementation Plan

Work strictly in order; each task ends with the listed acceptance check and a
git commit. Do not start a task before the previous one's check passes.
Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.

## Milestone 1

### T1 — Project scaffold
- `pnpm create vite` (react-ts), add Tailwind, shadcn/ui init (dark default),
  react-router, zustand, dexie + dexie-react-hooks, zod, minisearch,
  pdfjs-dist, react-markdown, vitest + testing-library, eslint + prettier.
- Scripts: `dev`, `build`, `preview`, `lint`, `typecheck` (`tsc --noEmit`), `test`.
- App shell: top bar, routes with placeholder pages, theme toggle.
- ✅ `pnpm dev` shows shell; all four routes render placeholders; checks pass.

### T2 — Domain + DB layer
- Implement all of `01-DATA-MODEL.md`: `/src/domain` types + zod schemas,
  `/src/db/db.ts`, repos (campaignRepo, artifactRepo incl. revision logic,
  rulebookRepo, chunkRepo, embeddingRepo, personaRepo, runRepo, settingsRepo),
  built-in persona seeding on app start.
- Unit tests: revision increment/cap-50, cascade delete of a campaign,
  persona seeding idempotence (use `fake-indexeddb` in vitest).
- ✅ Tests pass.

### T3 — Campaign picker + workspace shell + artifact editor
- Campaign picker screen; three-pane workspace; campaign tree; full artifact
  editor per `05-UI.md` (all four kinds, autosave + revisions, links,
  stat-block card + form).
- ✅ Manually: create campaign → create/edit/rename/duplicate/delete artifacts
  of every kind; revisions restorable; reload persists everything.

### T4 — Ingestion
- Implement `02-INGESTION.md`: worker, line building, chunker, stat-block
  detector/parser, progress reporting; Rules screen book list + import.
- Unit tests for `buildLines`, `chunkLines`, `parseStatBlock` with fixture
  arrays (no real PDF needed; craft item arrays in tests). One integration
  test with a small generated PDF fixture committed to `/tests/fixtures`.
- ✅ Import a real rulebook PDF; status reaches 'ready'; chunk count > 0.

### T5 — Search
- Implement `03-RETRIEVAL.md`; Rules browser search UI incl. filters, expand,
  Pin to Assistant.
- ✅ Acceptance criteria of 03; keyword-only path works with no key.

### T6 — Settings + OpenRouter client
- Settings screen; `openrouter.ts` with streaming, retries, error types;
  "Test key"; embeddings toggle activates semantic path (verify `both` badges).
- ✅ Acceptance criteria of 03 (embedding part) and key testing.

### T7 — Persona engine + panel
- Implement `04-LLM-PERSONAS.md` run engine + Assistant/Runs tabs.
- Unit tests: engine with a mocked `chat` — happy path, invalid JSON retry,
  needs_review path, cancel, manual approve flow.
- ✅ Acceptance criteria of 04 end-to-end with a real key.

### T8 — Polish pass
- All empty/edge states from 05; keyboard focus sanity; toasts consistent;
  delete-all-data works; README with setup + usage.
- ✅ Full manual walkthrough: new campaign → import book → search → pin →
  NPC Smith manual run → edit artifact → reload → everything intact.

## Milestone 2 (out of scope now — do not build early)

- Export: JSON (single artifact / selection / whole campaign) + zip bundle;
  PDF export via pdfmake (GM notes + player handout templates).
- Remaining personas wired (worldbuilder, faction-designer, plot-architect)
  + persona chaining ("writers' room" pipeline view).
- Continuity Editor persona (checks drafts against existing artifacts).
- Encounter/PlotArc/Session artifact kinds; graph view of links.
- Import of exported JSON; embedding whole-library management UI.

## Non-goals (never in scope unless the user says so)

- Backend/server, accounts, sync between devices.
- OCR for scanned PDFs.
- VTT integrations, dice rolling, live-play tooling.
- Storing original PDF bytes in IndexedDB.
