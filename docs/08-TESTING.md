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
  (unfetchable under vitest; text extraction does not use it), the
  deliberate render-crash noise of `global-errors.test`, and pdfjs `Indexing
  all PDF objects` in `ingestFiles.test` (the ingest-failure test deliberately
  feeds a truncated PDF; pdfjs's xref-recovery warning is the trace of the loud
  failure under test). The formerly-allowlisted act-timing entries
  (`persona-run-ui`, `onboarding-wizard`) are GONE — their sources were
  root-fixed with `actDrained` and the entries were removed (zero allowlisted
  act-timing noise; the guard stays strict).
- React `act(...)` warnings are *not* allowlisted. They mean a state update
  fired outside act — fix the test, don't silence it:
  - end flows with `findBy*`/`waitFor` (both act-wrapped),
  - wrap raw DB writes that re-fire live queries in `act(async () => …)`,
  - drain pending cascades with `flushAsyncUpdates()` from
    `tests/helpers/flush.ts` before un-wrapped plain reads,
  - run raw awaited steps (DB reads) that sit between act-wrapped steps
    inside act — `actDrained()` from `tests/helpers/flush.ts` wraps the step
    and drains before exiting. A bare `await someDexieRead()` while the tree
    is mounted re-opens the leak window: during the raw await the event loop
    turns fake-indexeddb's timed queue, and a liveQuery that (re)subscribed
    there — e.g. a token's image query resubscribed by a late-landing
    artifacts cascade — emits outside act. This was the intermittent flake in
    `battle-surface.test.tsx > selection card` ("tap shows the card…"):
    fixed by moving `tapToken`'s battle-row read into `actDrained`, zero
    assertion changes. Do NOT wrap paired `fireEvent` pointer sequences in
    one spanning act — each `fireEvent` flushes its own render and
    down→up gesture pairing reads that state; a spanning act defers the
    commit and strands the gesture gate. The same wrapper migrated the
    formerly-allowlisted persona-run-ui and onboarding-wizard act-timing
    entries: the panel's raw run-row reads between engine writes and the
    wizard's raw `readSettings()` calls between settings writes are wrapped,
    and the tests end with a drain so the post-act cascade tail
    (auto-open status write, dialog exit transitions) stays inside act.
- **Base UI dialogs add timed updates of their own**: opening schedules a
  transition-reset `requestAnimationFrame` (DialogRoot's state) and closing
  unmounts the popup on a timer. Under an open dialog, raw awaited reads need
  `actDrained` too — this was bestiary-roster's intermittent "An update to
  DialogRoot inside a test was not wrapped in act" (SpawnModulePicker) and
  the same class behind the onboarding-wizard entries. The full-suite proof
  runs surfaced the long tail of the same window: shared read helpers are
  the best cure point (battle-surface's `currentBattle` actDrains for every
  caller), and a fixture that rewrites exported rows must respect schema
  invariants across the whole row (backup's random-order personas).

### 2. Route smoke sweep — `tests/app/ui-smoke.test.tsx`

Twelve tests that render the **real app shell + router** against one seeded
world (a campaign with an artifact of every kind, built-in personas with a
completed run, a ready rulebook with a chunk) and mount every route. Where no
dedicated test exists, the sweep opens the interaction: tree filter, section
collapse, row tooltip, context menu → rename dialog, quick-find on the
workspace, the create-campaign dialog, and the editor for all eight kinds.

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
  belong inside `act`, stragglers go through `flushAsyncUpdates()`. Raw
  awaited reads between act-wrapped steps open the same leak window — wrap
  them in `actDrained()` (§Console guard). Under an open Base UI dialog the
  window is wider: the dialog's own transition-reset rAF / unmount timers
  land on the queue too.

## UI coverage matrix (05-UI inventory → tests)

Legend: ✅ dedicated test · 🟡 mounted/landmark only (route sweep or shell
test) · ❌ gap.

| Surface (05-UI §) | Covered by | State |
|---|---|---|
| Top bar: nav links, campaign switcher, theme/language, no retired Play action | `app-shell.test`, `ui-smoke.test` | ✅ |
| Help button + dialog | `help.test` | ✅ |
| Campaign picker: cards, create dialog, delete confirm | `campaign-picker.test` | ✅ |
| Campaign picker: import dep-summary dialog (abort imports nothing, import-anyway lands `missing ref`) + Rules deep-link | `campaign-picker.test` (import dependencies) | ✅ |
| Campaign banner: missing-refs banner on campaign routes (hidden when clean / off-route) | `missing-refs-banner.test` | ✅ |
| Import dependency matrix: L0 present / L1 drift / L2 fuzzy / missing, unmet refs block, pins advisory | `exportDependencies.test`, `exportImport.test` (enforcement: abort writes zero rows, anyway lands `missing ref`, L1, zip policy) | ✅ |
| Campaign tree: rows, selection, `+` buttons, delete confirm | `workspace.test` | ✅ |
| Ownership scopes: persisted toggles, module groups, Library group, publish/adopt confirms | `tree-scope.test`, `artifactRepo.test`, `moduleRepo.test` | ✅ |
| Campaign tree: filter, collapse, row tooltip, context menu, rename dialog, Link graph | `ui-smoke.test` | ✅ |
| Workspace: three resizable panes, welcome center | `workspace.test`, `ui-smoke.test` | ✅ |
| Editor: name autosave, revision creation, empty-name guard | `editor-autosave.test`, `m2kinds.test` | ✅ |
| Editor: revision dropdown → snapshot dialog → **restore** | `editor-surfaces.test` | ✅ (was ❌) |
| Editor: markdown **preview toggle** | `editor-surfaces.test` | ✅ (was ❌) |
| Editor: tag editor chips | `editor-surfaces.test` | ✅ (was 🟡) |
| Editor: surviving kind forms (pc/npc/location/faction/note/encounter/plotarc) | `editor-autosave`, `encounter-form`, `m2kinds`, `ui-smoke` | 🟡 forms beyond npc/encounter |
| Editor: **stat block card + edit toggle** | card/form UI `editor-surfaces.test`, resolve pipeline `encounter-form` | ✅ (was ❌) |
| Editor: links section rows (combobox add/remove, dangling targets) | `editor-surfaces.test` | ✅ (was 🟡) |
| Editor: images, cover/lightbox, encounter generator handoff | `images-ui.test` | ✅ |
| Editor: **export dialog** / single-artifact export UI | `export-dialog.test` (through the picker ⋮ menu) | ✅ (was ❌) |
| Editor: **monster source** UI | resolve pipeline `encounterResolve.test` | ❌ UI controls |
| Persona panel: assistant tab, disabled-without-key hint | `workspace.test` | ✅ |
| Persona panel: run lifecycle, global targets/badge, image ownership, Cartographer layout review | `persona-run-ui.test`, `imageRun.test`, `runEngine.test`, `encounterCartographer.test` | ✅ |
| Persona panel: runs list + delete | `workspace.test` | ✅ |
| Writers' room: step plan, badges, live tail | `module-forge.test` | ✅ |
| Quick-find (Ctrl+K): scoped artifacts, Library labels, module navigation, rule preview/pin | `quickfind-modules.test`, `quickfind-topbar.test`, `ui-smoke.test` | ✅ |
| Graph page: layout, click-through | `graphLayout.test` | ✅ |
| Module reader as play view: battle link and encounter-row seed action | `module-reader.test`, `entity-panel.test` | ✅ |
| Table surface: module route, player-safe DOM, drag/tap, HP ownership, initiative, stage reset, layout-cell grid metrics | `battle-surface.test` | ✅ |
| Battle engine goldens: HP split, initiative, veils, legacy/layout snapping, staging ground | `battle-engine.test` | ✅ |
| Battle persistence: module lifecycle, v10→v11 clearing, v11→v12 layout defaults | `battleRepo.test`, `moduleRepo.test`, `migration.test` | ✅ |
| Battle seeding: roster expansion, room placement/veils, entry-room PCs, map fallback | `battleSeed.test`, `entity-panel.test` | ✅ |
| Encounter layout engine: packing ladder, structural validation, doors, placement, veils, schematic | `encounterMap.test` | ✅ |
| Dungeon preset: fixed ×2 grid tiers, room-count independence, staging re-tiering, run/artifact/Settings round-trip, v14→v15 backfill, Preset select + Dungeon caption | `encounterMap.test`, `encounterCartographer.test`, `migration.test`, `settings-page.test`, `images-ui.test` | ✅ |
| Encounter clients: input references, exact aspect (the verify machinery was removed — docs/11 D14) | `image-caps.test`, `imageAspect.test` | ✅ |
| Encounter module queue: one-candidate auto, continue-on-failure, failed-only retry | `encounter-map-queue.test`, `entity-panel.test` | ✅ |
| Play retirement: `/play` 404, no session kind, one-time v11 notice | `ui-smoke.test`, `m2kinds.test`, `migration-notice.test` | ✅ |
| Deliverables: outline editing, owned module seeding, explicit-only globals | `deliverables-page.test`, `seed-from-module.test`, `modulePdf.test` | ✅ |
| Rules: import, book menu, delete, search browser, pin, embedding panel | `rules-page.test`, `search-browser.test`, `rules/embedding-panel.test` | ✅ |
| Settings: key, models, personas, language, encounter map defaults, danger zone | `settings-page.test` | ✅ |
| Global error boundary + uncaught-error toasts | `global-errors.test` | ✅ |
| 404 page | `app-shell.test`, `ui-smoke.test` | ✅ |

### Module Designer entities (08-MODULE-DESIGNER M4-C, fix-01)

| Surface | Covered by | State |
| --- | --- | --- |
| Name-normalization pass: verdict validation, mechanical application (link rewrites, alias adds, `entityKinds` REPLACEMENT with `absorbed` variants), proposals for hand-edited text/premise, failure recorded + toasted | `moduleGen.test`, `entityNormalization.test`, `wikilinks.test` | ✅ |
| Batch generation gate: buttons disabled with visible reason until `entityNamesNormalized`, failed-pass banner + Retry | `entity-panel.test` | ✅ |
| Consent review: proposals banner, confirm dialog applies rewrites to the documents' current text, decline drops them (proposals cleared either way) | `entity-panel.test` | ✅ |
| Stub popover verdict: canonical resolution defaults to alias-linking; standalone stub/generate requires the inline two-step confirm | `module-reader.test` (verdict link, confirm arms, create-stub, no-re-ask paths) | ✅ |
| Spine checkpoint: normalized entities line with absorbed variants | `spine-checkpoint.test` | ✅ |
| Names the text picks up later: chat-introduced name → records → the kind's batch button back with its count; the same for a manual part edit and for a generation path whose own pass never ran (cancelled parts run) | `entity-classify-new.test` (real chat-save, part-text-save and `runParts` seams) | ✅ |
| Incremental classification engine: new names only, existing records byte-identical, second run makes no model call, variant folded onto a recorded canonical (no duplicate record), invalid reply twice → error recorded + gate closed + no record, refuses while the flag is false, second module untouched, snapshot only when it writes | `moduleGen.test` (incremental describe) | ✅ |
| Unclassified-name derivation (exact/case-insensitive, skips resolved names and pending proposals), append-only record merge (cap throws loudly), proposal union/dedupe | `entityNormalization.test` | ✅ |
| The record gate holds: a name with no record has NO button (counts exclude it), and only the record unlocks the kind's button | `entity-classify-new.test`, `entity-panel.test` | ✅ |

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

`pnpm lint && pnpm typecheck && pnpm test` — the test step fails on console
noise, routes that stop mounting, and Base UI composition regressions. Vitest
uses at most six workers and a 20-second default test timeout (raised from
four in `b84d074` — the suite is file-parallel and was leaving half the
machine idle; jsdom plus PDF/image workers otherwise starve event loops on
constrained CI/agent VMs).
