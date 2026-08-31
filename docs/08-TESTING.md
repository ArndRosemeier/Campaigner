# 08 — Testing: UI coverage review & error visibility

This doc is the standing answer to two questions:

1. **Which UI elements are (and were) not really covered by tests?** — the
   coverage matrix below.
2. **How do we make UI errors visible without clicking through every screen?**
   — the console-hygiene guard and the route smoke sweep. They turn the whole
   suite into a detector for the class of bugs that only surface as browser
   console noise (Base UI composition warnings, React key/ref/prop warnings,
   silent fallbacks that 00-OVERVIEW forbids) plus a mount of every surface,
   including ones no dedicated test opens.

## The mechanism (how errors become visible without manual clicking)

### 1. Console-hygiene guard — `tests/setup.ts`

Every `console.error` / `console.warn` emitted while a test runs **fails that
test**, with a report of the leaked entries. React and Base UI report broken
composition (the `nativeButton` and function-component-ref warnings fixed in
`88efd5d` and `fb822c0`) exclusively as console warnings in dev — the UI kept
"working". Under the guard, the *first* test that mounts the broken
composition fails; nobody has to open the dialog in a browser.

Rules:

- The guard covers **every** test, so all 248 tests double as noise detectors
  for their flows.
- Allowlist entries (`ALLOWED_NOISE`) are the only escape, and each carries a
  concrete `why`. Adding an entry requires the same discipline as a fallback
  in app code: name the source, show it is intentional and bounded. Current
  entries: react-router v6 future-flag notices, pdfjs `standardFontDataUrl`
  (unfetchable under vitest; text extraction does not use it), and the
  deliberate render-crash noise of `global-errors.test`.
- React `act(...)` warnings are *not* allowlisted. They mean a state update
  fired outside act — fix the test, don't silence it:
  - end flows with `findBy*`/`waitFor` (both act-wrapped),
  - wrap raw DB writes that re-fire live queries in `act(async () => …)`,
  - drain pending cascades with `flushAsyncUpdates()` from
    `tests/helpers/flush.ts` before un-wrapped plain reads.

### 2. Route smoke sweep — `tests/app/ui-smoke.test.tsx`

Twelve tests that render the **real app shell + router** against one seeded
world (a campaign with an artifact of every kind, built-in personas with a
completed run, a ready rulebook with a chunk) and mount every route. Where no
dedicated test exists, the sweep opens the interaction: tree filter, section
collapse, row tooltip, context menu → rename dialog, quick-find on the
workspace, the create-campaign dialog, and the editor for all seven kinds.

It doubles as the regression net for the Base UI composition fixes:

- hovering a tree row must render the summary tooltip (tooltip → context-menu
  trigger ref forwarding), and
- "Link graph" / "Back to workspace" must be the router `<a>` with the right
  `href` (Base UI `nativeButton={false}`).

When you add a route or a shell-level element, extend the sweep — a new
surface mounts nothing-checked until it does.

### jsdom notes (hit these once, then remember them)

- **react-resizable-panels steals pointer focus in jsdom.** Its window-level
  `pointerdown` handler hit-tests with `getBoundingClientRect()` (all zeros in
  jsdom) and focuses a resize handle on any click inside a panel group, so
  `userEvent.type` cannot reach inputs inside the workspace panes. Drive those
  with `fireEvent.change` — real browsers hit-test correctly.
- **Base UI's tooltip popup has no `role="tooltip"`**; assert on its content.
- **`render={<Link/>}` with `nativeButton={false}` renders an `<a>` with
  `role="button"`** — Base UI imposes button semantics on non-native renders
  (`useButton`). Query with `getByRole('button', …)` and pin the `href`.
- Dexie live queries re-fire on timed queues; writes that re-fire queries
  belong inside `act`, stragglers go through `flushAsyncUpdates()`.

## UI coverage matrix (05-UI inventory → tests)

Legend: ✅ dedicated test · 🟡 mounted/landmark only (route sweep or shell
test) · ❌ gap.

| Surface (05-UI §) | Covered by | State |
|---|---|---|
| Top bar: nav links, campaign switcher, theme toggle, language select | `app-shell.test` | ✅ |
| Top bar: ▶ Play button | `play-page.test` | ✅ |
| Help button + dialog | `help.test` | ✅ |
| Campaign picker: cards, create dialog, delete confirm | `campaign-picker.test` | ✅ |
| Campaign tree: rows, selection, `+` buttons, delete confirm | `workspace.test` | ✅ |
| Campaign tree: filter, collapse, row tooltip, context menu, rename dialog, Link graph | `ui-smoke.test` | ✅ (was ❌) |
| Workspace: three resizable panes, welcome center | `workspace.test`, `ui-smoke.test` | ✅ |
| Editor: name autosave, revision creation, empty-name guard | `editor-autosave.test`, `m2kinds.test` | ✅ |
| Editor: revision dropdown → snapshot dialog → **restore** | `editor-surfaces.test` | ✅ (was ❌) |
| Editor: markdown **preview toggle** | `editor-surfaces.test` | ✅ (was ❌) |
| Editor: tag editor chips | `editor-surfaces.test` | ✅ (was 🟡) |
| Editor: kind forms (npc/location/faction/encounter/plotarc/session) | `editor-autosave` (npc), `encounter-form` (encounter), `m2kinds` (session), `ui-smoke` (all kinds mount) | 🟡 forms beyond encounter/session |
| Editor: **stat block card + edit toggle** | card/form UI `editor-surfaces.test`, resolve pipeline `encounter-form` | ✅ (was ❌) |
| Editor: links section rows (combobox add/remove, dangling targets) | `editor-surfaces.test` | ✅ (was 🟡) |
| Editor: images section, cover, lightbox | `images-ui.test` | ✅ |
| Editor: **export dialog** / single-artifact export UI | `export-dialog.test` (through the picker ⋮ menu) | ✅ (was ❌) |
| Editor: **monster source** UI | resolve pipeline `encounterResolve.test` | ❌ UI controls |
| Persona panel: assistant tab, disabled-without-key hint | `workspace.test` | ✅ |
| Persona panel: run lifecycle UI (pause actions, edit rescue, retry, cancel, completed link) | `persona-run-ui.test` (mocked chat) | ✅ (was ❌) |
| Persona panel: runs list + delete | `workspace.test` | ✅ |
| Writers' room: step plan, badges, live tail | `module-forge.test` | ✅ |
| Quick-find (Ctrl+K): artifact pick, rule preview/pin | `play-page.test`, `deliverables-page.test`, `ui-smoke.test` | ✅ |
| Graph page: layout, click-through | `graphLayout.test` | ✅ |
| Play page: focus, context grid, scenes, quick log | `play-page.test` | ✅ |
| Deliverables: outline editing, seed-from-forge | `deliverables-page.test` | ✅ |
| Rules: import, book menu, delete, search browser, pin, embedding panel | `rules-page.test`, `search-browser.test`, `rules/embedding-panel.test` | ✅ |
| Settings: key, models, personas, language, danger zone | `settings-page.test` | ✅ |
| Global error boundary + uncaught-error toasts | `global-errors.test` | ✅ |
| 404 page | `app-shell.test`, `ui-smoke.test` | ✅ |

### Remaining gaps

1. **Monster source UI** (`monster-source.tsx`) — the source selector, NPC
   combobox and inline-stats dialog are mounted (editor tests render the
   encounter form) and the resolve pipeline is repo-tested
   (`encounterResolve.test`), but the controls themselves are not driven by a
   test. Next task when touching M3-B: add `tests/features/monster-source.test.tsx`,
   then hook the surface into the sweep only if it needs a shell.

### Bugs the coverage work already caught (fixed in the same change)

Writing these tests surfaced three real defects that no user had hit yet —
exactly the class the review was after:

- **The export dialog was unreachable.** The picker card menu downloaded
  JSON directly instead of opening the M2 dialog, leaving the dialog (and
  the zip-bundle path) dead code. The menu now opens the dialog
  ("Export campaign…"; help content updated).
- **The dialog opened with nothing selected.** Its selection state was
  initialized from an async live-query prop in `useState`'s initializer, so
  by the time the user opened the dialog the preselection was empty and
  "Export" was disabled. It now preselects every artifact on each open.
- **Rejected-draft rescue via the UI** — manual autonomy keeps the raw reply
  for editing; the edit → "Save & continue" path is now pinned so the
  finalize guard against placeholder output can't regress silently.

## Gate

`pnpm lint && pnpm typecheck && pnpm test` — the test step now fails on any
console noise in any flow, on any route that stopped mounting, and on any
regression of the Base UI composition patterns the sweep pins.
