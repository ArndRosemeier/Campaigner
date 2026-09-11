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
- **A destructive-confirm dialog is settled before the test navigates or
  reads raw stores.** Confirming closes the AlertDialog, and Base UI unmounts
  the popup on an exit timer: while that exit is pending the popup is still
  in the document (`data-closed`), and its teardown updates —
  AlertDialogRoot → DialogPortal → DialogBackdrop → DialogPopup — plus the
  destructive write's liveQuery cascade all land on the timed queue. Any bare
  `await` in that window (a Dexie read, a store probe, a navigation
  assertion) turns the queue outside act; under parallel-worker load the gap
  widens and the guard fails the test with a burst of "An update to
  AlertDialogRoot inside a test was not wrapped in act" entries (observed:
  `clear-workspace.test.tsx`, 36 entries in one report, green in isolation).
  Cure, in this order: `waitFor` the dialog's testid to be absent
  (`queryByTestId(...)` → `not.toBeInTheDocument()`) right after the confirm
  click, then run the raw reads inside `actDrained` — precedent
  `entity-panel`'s orphan-sweep dialog (`07a84bd`), and the clear-workspace /
  remove-all-generated confirms. The same applies while a confirm is simply
  OPEN (open-dialog path above), and to a test that ends while the confirm is
  still closing — end it with the settle plus a drain, not a bare assert.
- **A disabled-until-live-query confirm action is waited for, never clicked
  blind.** The other half of the same class, and the one that fails with a
  *missing call* rather than noise: the action is `disabled` until its live
  census/count resolves (`remove-kind-dialog`'s `disabled={removing ||
  census === null || census === undefined || census.artifacts === 0}`).
  `findByTestId(dialog)` / `findByRole('alertdialog')` resolve on the dialog's
  FIRST PAINT — routinely before that query lands — and a `user.click` on a
  disabled button is a silent no-op, so the seam under test is never called and
  the assertion times out with **zero** calls (observed:
  `campaign-tree-remove-all.test.tsx > surfaces a failing seam through
  toastError`, 1 of 5 full-suite runs; the test clicked the confirm action
  straight after `findByTestId`). Measured window on an unloaded machine: 10 of
  20 consecutive runs saw the action disabled at first sight, opening 13–23ms
  later; with only the census delayed 300ms the un-cured test failed 6/6 with
  zero `toastError` calls and 6/6 passed with the wait added. Cure: `await
  waitFor(() => { expect(action).not.toBeDisabled(); })` before the click —
  or `findByRole('button', { name })` on the settled label when the branch
  itself is under test. The gate is deliberate design and must NOT be weakened
  in the component; the wait belongs in the test. If the confirm stays OPEN
  after the click (a FAILING pass toasts without closing it), its raw reads
  still need `actDrained` per the open-dialog rule above.

- **A prefill that can arrive mid-interaction is reproduced by HOLDING THE
  WRITE, never by holding the read.** The New Module draft's prefill is applied
  by an effect, so the load-sensitive failure is an ordering one: the settings
  value landing in the same React commit as the user's keystrokes
  (`tests/features/new-module-draft.test.tsx` holds the stored-draft READ open
  and releases it inside one `act` with the first keystroke — measured failing
  6/6 on the shipped code, green after the fix, and the pin fails 3/3 without
  it). The OTHER half of the same feature — a reopen prefilling a snapshot older
  than the draft it just saved — is reproduced by delaying the settings WRITE
  instead, because that is the race the app actually runs: the close's flush
  needs a DB round trip, so the reopen reads the row before the write lands. Two
  traps found the hard way, both now in docs/18 §4: (a) a mock that wraps a
  Dexie read in an extra `await` makes the live query stop reacting ENTIRELY
  (its querier is never called again, so the test measures a test artifact and
  cannot pass whatever the product does); (b) the harness keeps the dialog
  mounted across close/reopen, so the form still holds the previous open's
  values and a stale prefill is visible as a WIPE rather than an empty field.
  Assert the settled value with `waitFor`, never the first frame after the
  reopen, and never a fixed sleep.

### 1a. Race cures — the index (docs/18 §4 carries the same seams)

What the entries above and below have in common is a rule, not a bag of tricks.
A test may only assert a state the product GUARANTEES at that point; if the
guarantee holds only while the machine is fast enough, the test is racing a
clock and will fail on someone else's gate instead of its own.

**The order of work is fixed.** Reproduce first: make the suspected cause
DETERMINISTIC by DELAYING it (the `89e5d71` method — inject the delay at the
read or the write your root cause names, and the failure appears on demand),
then show the test failing on the CURRENT head, and only then cure — by waiting
for the settled state the product actually has, never with a fixed sleep, never
with a widened timeout (a fixed sleep hides the race behind a number; a widened
timeout only makes the failure rarer). Then prove BOTH directions: with the cause
delayed the un-cured test fails and the cured one passes, repeatably. A flake
that will not reproduce is reported as unreproduced — not grounds for a
speculative edit.

**How the failures in this section were originally seen, and how they are proved
now.** They surfaced while four writers gated this repo concurrently on one
8-core box — a condition we deliberately no longer create: `AGENTS.md` §Host
hygiene forbids synthetic load and N-way suite hammering, because that is what
drove the shared host to a load average of ~106 and starved the owner's tools.
"The box is not a test fixture." So the evidence recorded here is the
delay-injection reproduction plus SEQUENTIAL repetition of the affected files;
a single green run at the default worker bound is not evidence for this class, and
neither is a green run produced by loading the machine.

- **A debounced write is pinned by GATING THE WRITE, not by racing its window.**
  `canvas-chat-thread.test.tsx > writes the thread after each settled turn`
  asserted `expect(row?.chatThread).toHaveLength(0)` after two chat turns, to
  pin that the thread is persisted on the debounce and not immediately. It held
  only while BOTH turns settled inside `CHAT_PERSIST_DEBOUNCE_MS` (600ms):
  `scheduleChatPersist` arms ONE timer per module and a later turn REUSES the
  pending timer instead of restarting it, so the window is measured from the
  FIRST settled turn. Measured with an instrumented probe on this head
  (unloaded): turn 1 scheduled the write at +483ms, turn 2 settled at +1571ms —
  the write had already landed the first turn's two messages, and the assertion
  read 2 entries instead of 0. On a fast machine the two turns land inside the
  window and it passes, which is why it read as a phantom regression in whoever's
  slice happened to be gating. This is a TEST-side race and the product was NOT
  changed: persisting on the first settled turn and refreshing on the next is the
  debounce working, and a human who pauses mid-conversation is not owed an
  unwritten thread. Cure: `armWriteGate()` holds the next `scheduleChatPersist`
  behind a promise that the test releases only AFTER the row read, so "nothing
  persisted yet" is asserted while the write provably has not been scheduled.
  Revert-proof by DELAY: with the gate disabled and a 900ms pause between the two
  turns (longer than the window — the delayed cause made concrete) the test fails
  6/6 with `to have a length of +0 but got 2`, and passes 6/6 with only the cure
  added; six sequential runs each way, one process at a time.
  Two traps found while curing it. (a) Holding the DB READ cannot gate this
  write: the pending write is performed by a TIMER, which a held read hands the
  event loop (measured: the held read still returned the written 2-entry row).
  Holding a read is the right tool for a write the code under test AWAITS (the
  prefill entry above), not for a write a timer performs. (b) Fake timers cannot
  be used either: fake-indexeddb's own request queue rides `setTimeout`, so
  `vi.useFakeTimers()` wedges the database and the test times out — and
  `vi.useFakeTimers()` does not intercept a timer created before it was called
  (both measured).
- **A raw read that sits where an awaited write's cascade lands needs
  `actDrained`; the `act` warning it produces is the console guard doing its job,
  not a product bug.** `new-module-draft.test.tsx > persists the newest edit after
  the debounce window` failed in a concurrent gate with "An update to
  NewModuleDialogContent inside a test was not wrapped in act(...)". The dialog
  holds the stored draft in a `useLiveQuery`, so the debounced settings WRITE
  re-emits that query and re-renders the mounted dialog. `readSettings()` is a
  single Dexie `get`: a row that is already cached resolves with no event-loop
  turn at all, so the write lands harmlessly after the read — and the moment the
  read is slow enough, the write arrives DURING it, with no act scope anywhere,
  which is the warning. Reproduced at the exact site by delaying that read (the
  only change): with the read held 700ms the un-cured test failed 2/2 with the
  act warning while the cured one passed 2/2, and with NO delay the same un-cured
  test passed 2/2 — the delay is the whole difference. Cure: the settings reads in
  this file that sit where the debounced write (or a reopen's flushed write, or a
  campaign switch's unmount flush) can land run inside `actDrained`; assertions
  are unchanged in strength. One comment in the file records the inverse result
  so it is not "fixed" by mistake: a raw read INSIDE an `async` `waitFor`
  callback is NOT a leak site, because RTL's `asyncWrapper` disables the act
  environment for the whole `waitFor`.
  The same shape to look for everywhere: a bare `await` of a
  `get*`/`list*`/`read*` repo call with a write in flight from the same flow. It
  is invisible on an idle machine, which is why a green local run proves nothing
  about it.
- **A dialog's confirm/decline closes on an exit TIMER, and the write it fires
  cascades on the same queue: settle the close, then drain every raw read.**
  `entity-panel.test.tsx > applies stored proposals to the documents current text
  on confirm` failed with **36** leaked entries and `> drops the proposals on
  decline — nothing is rewritten` with 1, all of them "An update to `DialogRoot` /
  `DialogPortal` / `DialogBackdrop` inside a test was not wrapped in act(...)" —
  Base UI's popup teardown (the shape `0466dc9` and `07a84bd` already cured
  elsewhere in this file). Both tests clicked `entity-proposals-apply` /
  `-decline`, which closes the dialog at once and lets the write run
  fire-and-forget, and then read raw rows immediately: the popup's exit timers
  and the row write's live-query cascade landed inside those bare awaits. The
  same shape leaked `module-canvas.test.tsx > after a successful save the header
  goes back to the passive "Saved" state` ("An update to **CanvasPage** ...") —
  a save, then a bare row read. Reproduced at the exact site by delaying the
  post-click row read: **50ms** of delay was already enough — the un-cured test
  failed 2/2 with the SAME 36 entries the gate had reported, 250ms the same, and
  with no delay it passed 2/2 (the delay is the whole difference); the cured
  sequence passed 3/3 at 50ms and 250ms. Cure, in the documented order: `waitFor`
  the closed dialog's testid to be ABSENT, then run every raw row read through
  `actDrained` (`getModule`, `listModuleVersions`, and module-canvas's post-save
  read). No assertion changed and no product file was touched.
- **The write that feeds a mounted live query is DRAINED, not awaited bare — the
  cascade lands wherever the next bare `await` is, and the open dialog's own
  internals ride along with it.** This is the unidentified flake two independent
  full-suite runs reported as `1 failed | 2726 passed` (236 files) with the
  failing test's name lost to output truncation. It is
  `canvas-module-actions.test.tsx > "Resume automatic module creation" on the
  canvas > is a no-op with an honest notice when the confirmation is stale`, and
  the failure text the truncation ate is
  `Error: Console noise leaked into canvas-module-actions.test.tsx > is a no-op
  with an honest notice when the confirmation is stale (36 entries)`, whose first
  six entries are "An update to `AlertDialogRoot` / `DialogPortal` /
  `DialogBackdrop` / `DialogPopup` inside a test was not wrapped in act(...)"
  under `CanvasPage.tsx:134`. The test opens the resume confirm and then lands the
  work "by other means" with a bare `await saveModule(...)`. That write re-emits
  `useModule`'s live query, and the setState that follows is `CanvasPage` itself —
  instrumenting `tests/setup.ts` for one run to print a stack at the warning shows
  `dexie-react-hooks … observable.subscribe … next` → `scheduleUpdateOnFiber` →
  `CanvasPage` — after which the re-render wakes the open dialog's Base UI
  internals and they schedule updates of their own. On an idle machine the whole
  cascade lands inside the act-wrapped `user.click` that follows; the moment the
  host is busy enough for it to land in the bare await instead, the guard fails
  the test. Green in isolation 3/3 before the cure, which is why repetition alone
  never found it — the delay is the whole difference. Reproduced at the exact site
  by delaying the cause (one extra bare await right after the write): the un-cured
  test failed **9/9** (8 runs with the single `CanvasPage` entry, 1 with 37
  entries carrying the four dialog components) and the cured one passed **9/9**
  under the same injection; cure = the write goes through `actDrained`. Assertions
  unchanged, no product file touched.

Two shapes that were tested and RULED OUT, so they are not "fixed" by mistake:
- a raw Dexie read inside an `async` `waitFor` callback is deliberately exempt
  (see above) — `entity-panel`'s orphan-sweep tests read that way and are fine;
- delaying the SWEEP's write by up to 400ms produced no warning, because the
  `waitFor` wrapper drains a macrotask before restoring the act environment. The
  leak lives in the reads AFTER a resolved `waitFor`, not in the write;
- in the stale-confirmation test above, nothing BEFORE the write is a site: the
  raw `getModule` read two lines earlier and the trailing raw
  `listArtifactsByCampaign` read were each given 250ms of delay on their own and
  left the test green 4/4 — nothing is pending before the write, and the
  `waitFor` before the trailing read has already drained the close. The delay
  that does fail (9/9) is the one placed between the write and the act-wrapped
  click, i.e. inside the write's own cascade window; draining that write removes
  the cascade, so no other bare await in this test needs a wrapper. The drain
  belongs on the step that CAUSES the cascade, not on every await in the test (a
  cure that wraps everything is a cure that hides the next cause).

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
