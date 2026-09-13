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

**When the race is an ORDERING rather than a slow write, own the promise
instead of the clock.** Where both sides of the race are fast — a stop recorded
by one async chain and a write already in flight in another — no sleep can force
the ordering, because a sleep chooses no order at all. Hand the test the exact
`await` the root cause names (make the mocked reply a promise the test resolves
BY HAND, or the write a barrier it releases) and the ordering becomes a
statement in the test body: release the reply only after `cancelAll()` has
returned and the failure is on demand, with no timer, no load and no widened
timeout (ledger 115).

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
- **A test that starts REAL orchestration must SETTLE it before teardown — the
  pending continuation's next write otherwise lands on a wiped database and turns a
  green gate RED.** This is the `post-run-extras` gate flake (dispatcher report,
  ledger 97), and it is the one shape in this section that does not fail a test at
  all: a full-suite run at `01b85de` printed **253 files / 2891 tests passed** with
  every individual test green and still exited **1**, because vitest also reported
  `Errors 1 error` — `NotFoundError: PersonaRun not found: e4deb265-…` from inside
  the transaction at `src/db/runRepo.ts:48`, attributed to
  `tests/features/post-run-extras.test.ts` with "the latest test that might've
  caused the error" = `a completed npc run without the statblock extra attaches no
  notice`. Isolated repeats of that single file: **1 of 6** printed the `Errors 1
  error` line, the other 5 were clean, and all 12 tests passed every time — a timing
  signature, not a data bug (it surfaced while the box was loaded 17–23 by another
  session, and the difference the delay makes is the whole story).
  **What the pending continuation WAS.** The `mobPortraits` test creates a FRESH
  encounter, so the `post-run-extras` completion listener hands that encounter to
  the unattended **encounter-map queue**, whose job calls `runEngine.startRun` — and
  `startRun`'s pipeline is FIRE-AND-FORGET (it resolves as soon as the row is
  written), while the queue waits only for a terminal STATUS. MEASURED with a
  temporary probe printed at the end of that test:
  `runs: <mapRunId>:running:other | <smithRunId>:completed:smith`,
  `map queue: queued=0 active=1` — the test returned with the map job in flight. The
  NEXT test's `beforeEach` then ran `clearDatabase()` (deleting `db.runs`) and
  `useEncounterMapQueue.getState().reset()` (aborting the job): the abort reaction's
  `runEngine.cancel` write hit the deleted row — caught by the queue factory, which
  classifies the job cancelled, but it left `cancelRequested` set — the still-live
  pipeline's own catch then wrote `cancelled` to the same vanished row, that
  `NotFoundError` escaped `executeFrom`, and the engine's own failure chain
  `void this.executeFrom(…).catch((error) => void this.fail(runId, error))` called
  `fail`, whose `updateRun(runId, { status: 'failed' })` rejected **with nothing
  awaiting it**. A second probe pinned WHICH write is unhandled: `toastError` had
  been called with the bare `PersonaRun not found: <the map run's id>` — the message
  `fail` toasts before its own write fails — so the unhandled rejection is `fail`'s,
  not the loop's. (The guard did its job: nothing silently substituted a row.)
  **How it is now impossible.** `tests/features/post-run-extras.test.ts` gains ONE
  module-scope `settleStartedQueues()`, called from the file's `afterEach` BEFORE
  the next `clearDatabase()`: it drains BOTH queues the file drives through the
  queues' own `queued`/`active` state — the same seam the app's unattended callers
  wait on (`waitForRunStatus`) — and then PINS the contract that no run row is left
  `running` (`db.runs.where('status').equals('running')`). The file's map-only local
  `queueSettled()` is folded into it, so the mid-test settle points in the
  automatic-battlemap tests assert the same thing, and no assertion was weakened.
  The order is the fix: settle while the rows still exist, then let the next test
  wipe.
  **Reproduction by DELAYING THE CAUSE (the `89e5d71` method), never by loading the
  box** — one file, `CAMPAIGNER_TEST_WORKERS=2`, one process at a time: HEAD as-is
  was green 1/1 (it does not fire unloaded, which is why repetition alone never found
  it); with **250ms added to that test's chat replies** (the map run provably still
  in flight when the test returns) and no cure it was **RED 2/2** — `Errors 1 error`,
  exit 1, 12/12 tests green, the same `runRepo.ts:48` NotFoundError; under the SAME
  delay with the cure it passed (exit 0); with the cure and the injection REMOVED it
  passed **5/5** (4.37–4.66s against a 4.08s baseline, so the settle costs nothing
  measurable). Revert-proofs, both directions: removing the `afterEach` settle call
  under the delivered delay reproduces the red gate on demand, and removing ONLY the
  drain while keeping the `running`-census pin makes the pin fail LOUDLY — 3
  assertion failures naming the still-running run id — instead of degrading into the
  file-level unhandled error. **Nothing was widened to make it quiet:** no
  `ALLOWED_NOISE` entry, no `process.on('unhandledRejection')` swallow, no `catch`
  around a DB write, no `--retry`, and `runRepo`'s row-must-exist guard is
  byte-identical (it is what made the pending write loud in the first place).
  **Generalize it, and note the direction of the cure:** a test that starts real
  orchestration owns settling it, because teardown is exactly where the row the
  pipeline is writing disappears; and prefer the ordering fix over a guard change,
  since a guard that tolerates a vanished row would be the silent fallback AGENTS
  rule 1 forbids. The REAL-APP analogue is deliberately NOT fixed here and is
  recorded in ledger 97: the Runs list lets the owner delete a RUNNING run, so
  `deleteRun` removes the row the pipeline is writing and the same chain would surface
  as the global "Unhandled error in a background task" toast (`lib/globalErrors`) —
  deduced from the chain, NOT measured in the app; that cure belongs in
  `src/llm/runEngine.ts`, owned by another arc.
- **A SECOND load-sensitive observation, RECORDED and NOT diagnosed** (another
  writer's full-suite run on this box at ~12:04, load ~6 with other suites running):
  `tests/features/provenance-display.test.tsx:277` failed with `peek-image` missing.
  That file contains zero `statBlock` references, passes **9/9 in isolation** (the
  observing writer's measurement) and did not recur in two clean full-suite runs
  afterwards, so it reads as a load-timing flake in the peek modal rather than a defect
  in the arc that observed it. **Second observation, same symptom, another arc's
  bounded gate (the blocked-controls arc, `CAMPAIGNER_TEST_WORKERS=2`, full suite:
  `1 failed | 2922 passed`, then 9/9 in isolation twice in a row):** the file and
  the peek modal are untouched by that arc too, so the record stands as "load
  timing in a mounted UI surface, cause still not established" — do not read a
  red gate as a regression of whatever landed next to it before checking this. It was NOT reproduced on demand and NO cause was
  established — recorded with its evidence and nothing more, deliberately not chased
  here, not added to `ALLOWED_NOISE`, and neither that test file nor the peek modal was
  touched. No shared mechanism with the `PersonaRun` continuation above was shown: that
  one is a RUN PIPELINE still writing after `clearDatabase()` (the guard fired and
  nothing awaited the failure chain), while this one is an element assertion in a
  mounted UI surface — the two want different evidence before either is called
  understood.

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
| The module PDF: the module-sourced document, no scaffolding, map plates, GM vs player, loud failures | `modulePdf.test` | ✅ |
| The module PDF's export surface: ONE control on both surfaces, GM/player as an argument, problems reported | `module-pdf-export.test`, `module-canvas.test` | ✅ |
| Rules: import, book menu, delete, search browser, pin, embedding panel | `rules-page.test`, `search-browser.test`, `rules/embedding-panel.test` | ✅ |
| Settings: key, models, personas, language, encounter map defaults, danger zone | `settings-page.test` | ✅ |
| Global error boundary + uncaught-error toasts | `global-errors.test` | ✅ |
| 404 page | `app-shell.test`, `ui-smoke.test` | ✅ |
| Blocked controls state their reason PERCEIVABLY (the shared device): the control stays natively disabled, the reason is associated via `aria-describedby`, the popup opens on hover AND on focus, and a live control carries none of it | `blocked-control.test` | ✅ |
| Canvas header + chat sidebar: a reason per reason-bearing blocked control (preview/open-editor, generating, refine running, streaming proposal, the chat's module-wide block and its live-reply block), each pinned together with the unchanged `toBeDisabled()` state | `blocked-reasons.test` (device), `module-canvas.test` (the AI flows themselves) | ✅ |
| Converted reason sites keep their gate and gain the perceivable reason (`generate-everything`, the entity batch gate, encounter Repopulate/Regenerate everything) | `generate-everything.test`, `entity-classify-new.test`, `images-ui.test` | ✅ |
| A reason is never stated in a `title` beside its wrapper (docs/17 rows 125/127): all SEVEN surfaces that restated it there state it ONLY through the device now, the scan's two-entry known list was DELETED in the same commit that folded the two sites it licensed, and any restated title in `src/**` reds it | `blocked-control-title-scan.test` (SCAN, 2 — strict, no allowance), `module-canvas.test` (the Save control), `canvas-module-actions.test` (Fix + Resume), `entity-classify-new.test` (the batch gate + classify), `generate-everything.test` (both held states), `editor-surfaces.test` + `change-artifact-ui.test` (Repopulate, both held states) | ✅ |
| The DESCRIPTION a held control used to lose survives on the LIVE control: each of the five gated descriptions is asserted byte-identical while the control can act, and its ABSENCE is asserted while the control is held (gated on the FULL held expression, so no held state leaks one) | `canvas-module-actions.test` (Fix + Resume), `entity-classify-new.test` (classify), `generate-everything.test` (live + two held), `editor-surfaces.test` (stocked complex + single), `change-artifact-ui.test` (held by the other run) | ✅ |
| Self-evident blocks are pinned AS self-evident (no reason wrapper): a blank chat input, an already-`Reported` outcome, the Versions menu's clear-all beside its own empty-state paragraph | `blocked-reasons.test` | ✅ |
| The SILENT-block sweep (docs/17 row 99): every control that was disabled with no reason stated anywhere now states one through the shared device, in the gate's own order, and each pin asserts the gate is UNCHANGED (`toBeDisabled()` / `aria-disabled` per the control's own form) together with the reason being present, associated, focusable and openable on hover | `blocked-reasons-writers-room.test` (8 + 3), `blocked-reasons-entity-sweep.test` (stub popover 3 + images 2 + export 1), `spine-checkpoint.test` (4), `module-board-rewrite.test` (1), `rules-page.test` (5), `rules/embedding-panel.test` (2), `bestiary-fetch-section.test` (1), `mob-portraits-section.test` (2), `dice-roller.test` (1) | ✅ |
| Every one of those pins is REVERT-PROVEN, both directions: with the reason reverted to `null` the NAMED pin fails (31/31, one control at a time, files restored byte-identical by `md5`), with the reason replaced by a wrong sentence it fails on the exact text (4 injections), and for a SELF-EVIDENT pin the forbidden wrapper is injected at that control and the pin fails (11), while the controls carrying no wrapper at all are proven by relaxing their gate so the pin's held half is exercised (4) | the above files; the scripts are scratch, the proofs are the measured run log recorded in docs/17 row 99 | ✅ |
| The self-evident judgement is a DECISION, not an omission — pinned AS self-evident: the Writers'-room's at-an-end move buttons and its empty-plan Run chain, the spine checkpoint's at-an-end move buttons, the module board's Apply/Discard while the apply is in flight (Apply's own label reads "Applying…"), the bestiary full-list switch while the listing runs, the mob-portrait section's empty roster, the export dialog's zero selection, the embedding panel's inactive and nothing-to-embed rungs, the dice roller's empty tray, and the stub popover's empty name and "Generating…" | `blocked-reasons-writers-room.test`, `spine-checkpoint.test`, `module-board-rewrite.test`, `bestiary-fetch-section.test`, `mob-portraits-section.test`, `blocked-reasons-entity-sweep.test`, `rules/embedding-panel.test`, `dice-roller.test` | ✅ |
| The blocked-reason pin helpers (`tests/helpers/blocked-reason.ts`): one home for the device's contract (held + `sr-only` text + `aria-describedby` identity + `tabIndex=0` + popup absent before the interaction), ONE helper per held form (native `disabled` vs Base UI `aria-disabled`) and one per self-evident form | `tests/helpers/blocked-reason.ts`, used by the nine files above | ✅ |
| A wiki-link chip's hover tooltip LEADS with the byte-exact source token and keeps what the chip already said as the tail (docs/17 row 100): resolved (with a PADDED token and a `\|display`), unresolved (token AND "not detailed yet"), ambiguous (token AND the ⚠ list), the carrier on the element as `data-wiki-raw`, and the two plausible reconstructions from name+display asserted NOT to be what is carried | `wiki-chip-tooltip.test` (10), `remark-wikilinks.test` (the carrier + `splitWikiText.raw` pins), surface pins in `module-reader.test` (reader) and `canvas-preview-default.test` (canvas preview) | ✅ |
| Surfaces that must NOT grow a raw-token tooltip: a plain `[text](url)` markdown link, a token inside an inline code span, a token inside a fenced code block, and a token nested in markdown link TEXT (all four: no chip, no `title`, no `data-wiki-raw`) | `wiki-chip-tooltip.test` | ✅ |
| The raw-token carrier has NO route into an export: the module definition carries every raw TOKEN free while the display text IS present (and the tokens proven present on the rows first), and a source scan proves `lib/modulePdf` / `lib/pdfExport` / `lib/mdToPdfmake` never import `WikiMarkdown` / `remark-wikilinks` / the carrier constant | `wiki-raw-export.test` | ✅ |
| Every export renders the DISPLAY of a wiki token, never the token (docs/17 row 105): both single-artifact bodies (`GM notes`, handout) print `the gate` for `[[Encounter:Ash Gate\|the gate]]` and `Ash Gate` for `[[Ash Gate]]` byte-exactly, with no `[[`, no target and no `\|` left; a literal that only LOOKS like a token stays literal byte-exact in both templates; the two pipelines are pinned TOGETHER on one body (display present in both, brackets in neither, `mdToPdfmake` unchanged); and the composition is ONE place (a source scan: no direct `wikilinks` import, no `WIKI_LINK_PATTERN` and no `\[\[` regex in `pdfExport`). The image-prompt consumer is pinned as a REASONED EXCLUSION (a model prompt is not a rendering, and the token is the only place the target's NAME survives) | `wiki-raw-export.test` (9), `pdfExport.test` (the `markdownToText` vs `markdownToDisplayText` split pin), `imagePromptDraft.test` (the verbatim-token pin) | ✅ |
| Row 105's pins are REVERT-PROVEN, one revert at a time, each file restored byte-identical (`md5sum -c`): the leak restored in `markdownToDisplayText` → 8 named pins fail (7 in `wiki-raw-export.test` + the split pin in `pdfExport.test`), the GM-notes one printing `expected 'He guards the gate…' / received 'He guards [[Encounter:Ash Gate\|the gate]] …'`; the GM body site alone reverted → 2 fail (its own pin + the parity pin) while the handout pin passes; the handout site alone reverted → the mirror image. NON-VACUITY INJECTIONS: a naive `\[\[\|\]\]` bracket strip (drops the display half) → 7 pins fail including the literal pin; `display ?? name` without the trim → 5 fail on `[[Kael\|  the smith  ]]` | the three files above; the proofs are the measured run log in docs/17 row 105 | ✅ |
| That arc's pins are REVERT-PROVEN and the non-vacuity injection is real: carrier removed → 9 named pins fail across 4 files; a name+display RECONSTRUCTION → 7 pins fail naming both strings; the token appended instead of leading → 6 pins fail; the existing information dropped → 8 pins fail; every file restored byte-identical (`md5sum -c`) between proofs | the four files above; the proofs are the measured run log in docs/17 row 100 | ✅ |

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

### The creature tier (docs/17 row 106, docs/11 D5 second revision)

| Surface | Covered by | State |
| --- | --- | --- |
| The citation resolver: chunk id, content-hash fallback, a THROW on an empty ref, a named origin when the library cannot supply the creature | `creatureRepo.test` (D3) | ✅ |
| The schema conflict: a citation NEXT TO an authored stat block is a named parse error, never a row with two sources of truth | `creatureRepo.test` (D3) | ✅ |
| `castCreatureAsNpc`: created → reused byte-identical → rival refused → authored npc refused → unresolvable creature refused → dangling module refused | `creatureRepo.test` (D4) | ✅ |
| The cast seeds the canonical portrait once and never overwrites an imaged row; no canonical portrait casts to a null cover (normal, not an error) | `creatureRepo.test` (D4) | ✅ |
| The encounter side CANNOT cast: the roster schema drops an attempted `creatureRef` outright (absence of a field, not a runtime guard) | `creatureRepo.test` (D5) | ✅ |
| Reading a citation writes nothing: no chunk, no artifact, no module, no battle | `creatureRepo.test` (D5/D8) | ✅ |
| ONE `missing ref` reason with an optional name, and the predicate every surface reads (`isMissingRefOrigin`) — a property over both directions | `creatureRepo.test` (D9), `missing-refs-banner.test`, `encounter-form.test` | ✅ |
| A library-only mention is NOT detailed: the entity row carries the `bestiary only` marker with the creature named and the remedy stated | `creature-row-resolution.test` | ✅ |
| …and the batch/sweep generate the module's OWN npc for it, creating nothing for the library creature | `creature-row-resolution.test` | ✅ |
| A cast npc's own cover counts as its portrait on BOTH sides (the batch and the sync detector), so no second portrait overwrites the owner's art | `mob-portrait-module-gaps.test` | ✅ |
| The deviation/sweep read the presentation snapshot when their caller has it; the conservative answer is the documented fallback, not a silent disagreement | `mob-portrait-module-gaps.test`, `module-post-generation.test` | ✅ |
| The bestiary spawn dialog CASTS (a real module-owned, module-tagged `npc` row) | `bestiary-roster.test` | ✅ |
| A cast npc is REFUSED by `changeArtifact` (a rename would let the generator cast a second row) and its citation survives every writer | `change-artifact.test` | ✅ |
| A refill writes a cast row's prose and cannot touch its citation or author a stat block onto it | `runEngine-refill.test` | ✅ |
| Dexie v19 → v20: portrait slots re-keyed to the creature identity, citations rewritten onto the library, marked rows retired, the presentation table created, the report persisted — and the repair seam is idempotent (a second run reports zeros) | `migration.test` | ✅ |
| Seeded battles: ONE frozen seed row per IDENTITY (not per instance), `creatureKey` carrying it, a synthetic `artifactId` naming no artifact | `spawn-picker.test`, `battle-token-portrait.test` | ✅ |

### The module-side cast — the generator ASKS for a creature (docs/17 row 107, docs/11 §The module-side cast)

| Surface | Covered by | State |
| --- | --- | --- |
| The contract accepts the `bestiary` slot and REFUSES a malformed one (unnamed creature, unnamed book, non-object) | `moduleGen-cast.test` | ✅ |
| The slot is ADDITIVE: a record without it parses with no key, and the model's `"bestiary": null` reads the same | `moduleGen-cast.test` | ✅ |
| The emitted strict contract carries `bestiary` as a REQUIRED nullable property whose `book` is nullable too (asserted off the shipped schema, not transcribed) | `moduleGen-cast.test` | ✅ |
| The request SURVIVES the name-normalization substitute (carried onto the canonical record by name and by every absorbed variant); two source records asking for different creatures REFUSE loudly | `moduleGen-cast.test` | ✅ |
| Finalize casts through `castCreatureAsNpc`: ONE `npc` artifact with the entity's name, the module's own prose about it and the creature's `creatureRef` — `statBlock` null, no persona run started, no transport reached | `moduleGen-cast.test` | ✅ |
| A SECOND run over the same module REUSES that row (same artifactId, one row) instead of minting a twin | `moduleGen-cast.test` | ✅ |
| An unresolvable creature name FAILS LOUDLY naming the entity and the creature, in the batch's existing `failed[]`, and finalizes NOTHING (no statless twin) | `moduleGen-cast.test` | ✅ |
| An ambiguous name is refused by name with both candidates listed; naming the book in the slot resolves it to that book's chunk; a book that holds no such creature is refused listing what the library has | `moduleGen-cast.test` | ✅ |
| A module with NO slot is untouched — the entity still goes down the persona path | `moduleGen-cast.test` | ✅ |
| The additive prompt measurement: a workspace with an EMPTY library composes the pre-change prompt byte for byte against the golden fixture, the delta with a library is EXACTLY the appended clause, and the field is mentioned nowhere else | `moduleGen-cast.test` | ✅ |
| The encounter GENERATION side cannot express a cast — no `bestiary`/`cast` property anywhere in the Smith draft or the Cartographer brief, and no cast call in `runEngine`/`encounterRoster` (EXTENDS the roster-side data-schema pin in `creatureRepo.test`) | `moduleGen-cast.test`, `creatureRepo.test` | ✅ |
### The module PDF (docs/17 row 108, docs/07 §M3-D)

| Surface | Covered by | State |
| --- | --- | --- |
| The document is read from the MODULE (premise, part plan, `parts` through `splitPartsDocument`), not from a stored document | `modulePdf.test` — "prints the module's own premise, part plan and parts" | ✅ |
| The `==========` separators and `[Part n of total — title]` scaffold labels of a stored document appear NOWHERE in the definition (and the fixture proves they are present in the row's assembled doc first) | `modulePdf.test` — non-vacuity assertion on the assembled text | ✅ |
| A map plate is printed INSIDE its encounter, from `encounter.data.mapImageId`, and the live board's `mapImageId` is the fallback | `modulePdf.test` — one plate at its anchor; one board-fallback case through `ensureBattle`/`patchBattle`/`refreshBattle` | ✅ |
| A battle with NO stored image prints NO plate — and no schematic, no room geometry, no `data.layout` text | `modulePdf.test` — the `layout` fixture carries a room named "Schematic Room" whose name must not print | ✅ |
| Budgets: a map decodes at 4096, a cover at 1024 (asserted on the values that REACHED the codec) | `modulePdf.test` — injected `PdfImageCodec` | ✅ |
| A REAL PDF ends up carrying an image through the REAL path: a genuine 1×1 PNG row renders and the produced bytes contain `/Subtype /Image` | `modulePdf.test` (gate hole D-i) | ✅ |
| The format boundary is LOUD: a WebP data URL (which throws inside pdfmake's measurement pass) is refused by `assertPdfmakeImageDataUrl` at the seam, for both a document node and a caller-built node passed to `generatePdfBlob` | `modulePdf.test` (gate hole D-ii) | ✅ |
| An unreadable image / a missing row / a codec error becomes a NAMED placeholder AND a reported problem; the document still lands | `modulePdf.test` (C3) | ✅ |
| Data renders: location/event `locationType`/`inhabitants`/`pointsOfInterest`/`hooks`; difficulty kickers; two-column stat boxes with PF2e bonuses | `modulePdf.test` (C4) | ✅ |
| Roster origins: `npc-ref` cross-reference, `inline` stat box with NO origin line, `rulebook`'s `(see Bestiary)`, and a name-only entry's named `isMissingRefOrigin` reason | `modulePdf.test` (C5) | ✅ |
| GM vs player from ONE builder: the player document drops gm-only rows, notes, plot arcs, faction methods, encounter tactics/treasure/terrain, PC notes, the part plan and the treasure ledger — while maps stay in both | `modulePdf.test` — the same fixture rendered twice and diffed by what it must NOT contain | ✅ |
| The export surface: ONE control (canvas header + campaign tree module group), GM/player as an ARGUMENT to the ONE renderer, destination acquired before the build, the blob written, problems reported, picker cancel silent | `module-pdf-export.test` | ✅ |
| Exports do not leak the internal token (row 105's rule) and `writerModel` provenance never reaches a document | `wiki-raw-export.test`, `provenance-export.test`, `modulePdf.test` | ✅ |
| Retired-table data is reported, never swallowed: an old export file's `deliverables` rows are counted BEFORE tolerant parsing, and a v20 database's rows are counted by the v21 upgrade | `exportImport.test` ("retired-table import tolerance"), `backup.test`, `migration.test` (v20 → v21) | ✅ |

**UNPROVEN in this environment — stated, not implied** (docs/18 §4 carries the
same list): jsdom has no `createImageBitmap` and no canvas, so
`canvasPdfImageCodec` is never executed by a test — the REAL decode/encode of
JPEG or WebP bytes is unverified. What the suite does instead: it renders a
genuine PNG through the real pdfmake path (bytes asserted) and injects a
`PdfImageCodec` for the budget and failure branches, so the DOCUMENT side is
pinned while the browser codec is verified by inspection only. A future arc that
needs that proof must run it in a browser, not in jsdom.

### The document plan (docs/17 row 109, docs/07 §M3-D)

| Surface | Covered by | State |
| --- | --- | --- |
| The plan SCHEMA accepts a well-formed plan (sections in order, anchors and all) and refuses every malformed shape BY NAME: no sections, an invented role, an audience outside all/gm/player, an empty title, a `source` carrying the wrong key for its type, a non-uuid id, a `planIndex` below the premise key — and a plan that smuggles rendering content (`body`, `style`, `fontSize`) in | `documentPlan.test` (8 schema cases) | ✅ |
| The emitted contract the model is held to is the runtime schema MINUS provenance (no second copy to drift, `.default('')` fields not required of the decoder) | `documentPlan.test`, `modulePlan.test` | ✅ |
| The reference rule refuses a plan naming a missing PART (by position and count), a PREMISE on a module with none, an artifact the module neither owns nor mentions, a non-encounter named as an encounter, and an image the module does not hold — reporting EVERY defect, not just the first | `documentPlan.test` (8 cases) | ✅ |
| Absence reads as `absent`, a stored plan as `valid`, and a corrupt value as `invalid` WITH THE FIELD NAMED — the module row is never bricked by a bad plan | `documentPlan.test` | ✅ |
| The planner seam parses the reply at the BOUNDARY: invalid JSON, a wrong shape (naming `sections.0`), and a plan naming something that does not exist are all LOUD, and NONE of them leaves a plan behind | `modulePlan.test` (mocked `chat`) | ✅ |
| The seam stamps provenance from the reply's own `modelUsed`, refuses a module with no part plan (without calling the model), refuses a SECOND generation through the shared canvas-busy registry, and releases the module + abort handle even after a bad reply | `modulePlan.test` | ✅ |
| The prompt states what the model may and may not decide: the four roles with their meanings, the audience default, the prohibitions ("you do not write, rewrite, summarise or translate any content", "never invent a part index, an artifact id or an image id"), and the inventory it must choose from | `modulePlan.test` (`modulePlanMessages`) | ✅ |
| The renderer prints the plan's sections in the plan's ORDER under the plan's TITLES, and the procedural chapter set does NOT print (the plan replaced the structure) | `modulePdfPlan.test` | ✅ |
| Each of the four roles has ONE distinct treatment (read-aloud fill + style, the labeled "GM note" box, the aside's `noBorders` indent, the plain explanation body), and the role markers are counted so a copy-paste between roles fails | `modulePdfPlan.test` | ✅ |
| An aside is an INSERT: its node carries neither a `pageBreak` nor a `tocItem`, while a chapter carries both | `modulePdfPlan.test` | ✅ |
| Exactly the anchored images print (map plate at its section, cover art inline), an unanchored image prints NOTHING and is NOT a problem, and the module's own cover page still prints the module cover | `modulePdfPlan.test` | ✅ |
| A planned part whose text has not landed prints the LOUD empty-part placeholder + its named problem | `modulePdfPlan.test` | ✅ |
| GM and player come from ONE plan: a `gm` section is absent from the player document, maps stay in BOTH, the treasure ledger drops for players, encounter tactics/terrain never reach the player document, and a plan's explicit `all` on a gm-only-tagged row DOES print it (the override) | `modulePdfPlan.test` | ✅ |
| Back matter completes the plan: an NPC printed as a section is not printed again in the gallery, and an unplanned NPC still is | `modulePdfPlan.test` | ✅ |
| A stale reference is loud in TWO places — a named problem at `the document plan` AND a statement on the document's own page — while the export still lands (`%PDF-`, image embedded) and NOTHING of the plan renders | `modulePdfPlan.test` | ✅ |
| A half-applicable plan is NEVER half-applied: the good sections are dropped with the bad one and the procedural outline prints | `modulePdfPlan.test` | ✅ |
| A schema-invalid stored value falls back loudly (naming `sections.0`); an ABSENT plan is SILENT and byte-for-byte the procedural document | `modulePdfPlan.test` | ✅ |
| Determinism, stated as numbers: two renders of the definition are identical (6359 characters) and two full PDF builds with a pinned `compiledAt` are byte-identical (51271 bytes, first differing byte `-1`), with the image budgets asserted on the values that reached the codec | `modulePdfPlan.test` | ✅ |
| The surface shows absence, a valid plan (order, role, audience, source in the owner's terms, anchor count, and the model) and an invalid plan (with the named reason); it offers NO structural editing — one planning action plus the audience select | `module-plan-dialog.test` | ✅ |
| Regeneration writes through `patchModule` only, hands the seam the module id + pool + abort controller, and a FAILED regeneration toasts by name while the previous plan stays byte-identical on the row | `module-plan-dialog.test` | ✅ |
| A reply that names something absent leaves the field ABSENT — not a partial plan, not an empty object | `module-plan-dialog.test`, `modulePlan.test` | ✅ |
| The AUDIENCE correction rewrites exactly one section's audience and moves nothing else (order, titles, roles, anchors, provenance) | `module-plan-dialog.test` | ✅ |
| Persistence: the plan round-trips through the additive module field AND rides campaign export → cleared database → import whole (same sections, same provenance) | `module-plan-dialog.test` | ✅ |

**NON-VACUITY (injections, each reverted and verified byte-identical).** Twelve
load-bearing lines were reverted one at a time and each killed its named test:
the planned order (`modulePdf.ts` renders the plan reversed), the reference
check (`resolveDocumentPlan` applies an out-of-scope plan), the in-document
fallback statement, the `problems` entry at `the document plan`, the audience
filter (a GM-only section prints for players), the pinned `creationDate` (two
renders stop matching bytes), the image anchors (sections lose their plates),
`readStoredDocumentPlan`'s invalid branch (a corrupt plan reads as absent),
the planner's zod boundary (a wrong shape is accepted), the planner's reference
refusal (an invented id lands), the read-aloud treatment (the role markers stop
being distinct), and the export's module carry (the plan does not survive a
round trip). Each injection was restored from a copy and verified with
`git hash-object` before/after, and none of them was green.

**UNPROVEN** (mirrors docs/17 row 109): the planner is never run against a live
provider — `chat` is mocked at the protocol boundary in every test — so the
QUALITY of a real model's plan is unmeasured; no human has judged a plan's
aesthetics; the plan cannot suppress or reorder the back matter; and the
byte-determinism claim holds per `(module, plan, compiledAt)` (the compile day is
printed on the cover, so tomorrow's build differs on purpose).

### The plan surface in the campaign tree, and the page-hide flush (docs/17 row 111)

| Surface | Covered by | State |
| --- | --- | --- |
| The campaign tree's module-group header mounts the SHARED plan component — asserted on the component's own PROPS (the module row and the artifact pool), not on a button existing | `campaign-tree-plan-control.test` | ✅ |
| The pool is the SAME reach the "Module PDF" control beside it gets (the campaign's rows plus the shared library, in that order) — asserted against the PDF control's own recorded props | `campaign-tree-plan-control.test` | ✅ |
| Clicking it opens the SAME dialog, rendering THIS module's stored plan (its sections, its counted model, its Regenerate label) | `campaign-tree-plan-control.test` | ✅ |
| No second plan surface can be built by copying: the dialog's markup, the `planModuleDocument` call and the `patchModule(module.id, { documentPlan … })` write each live in exactly ONE file under `src/`, and the tree carries none of them | `campaign-tree-plan-control.test` — source scans over `src/**` | ✅ |
| The stale comments (item 2) | **No test, deliberately** — comment-only, and a test that reads a comment's text pins nothing about behaviour. `src/` was grepped instead (49 `deliverable*` lines, 3 corrected) and the result is recorded in docs/17 row 111 | n/a |
| A settled chat turn queued in the debounce is persisted by `pagehide`, and by `visibilitychange` → hidden — with the row asserted UNWRITTEN first and the wait CAPPED BELOW the 600 ms debounce | `page-flush.test` | ✅ |
| A `visibilitychange` to VISIBLE writes nothing while a write IS queued (the gate that keeps a tab switch from being a write) | `page-flush.test` | ✅ |
| `hidden` followed by `pagehide` performs ONE write, and a page with nothing queued writes nothing at all (asserted with a row sentinel, so a write would be visible as changed data and not only as a call count) | `page-flush.test` | ✅ |
| The seam itself: a registered flush runs on `pagehide`, stops running once unregistered; and a second flush through the writer's own entry point writes nothing (the debounce contract survives) | `page-flush.test` | ✅ |
| The DRAFT writer flushes a typed draft on `pagehide` inside the 500 ms window, and writes NOTHING on a later `pagehide`/tab switch once the debounce landed (the pending gate; counted through the settings write seam) | `new-module-draft.test` | ✅ |
| The module BOARD's layout write on page hide | **COVERED by docs/17 row 118** (this row 111 section's "NOT covered, by instruction" was true of row 111's tree, not of HEAD): `features/modules/board/BoardPage.tsx` registers a pending-gated `flushPendingLayout` through `lib/pageFlush`, pinned by `board-page-flush.test` — see §The page-hide seam's third and fourth writers below | ✅ (row 118) |
| The cast count in the module-automation toast (row 107's gap) | **NOT covered, by instruction** — the fix was written, tested and injected on this branch and then dropped whole because `features/modules/post-generation.ts` was occupied by another writer's uncommitted work; the item is queued for a later slice and NO test of it remains here (docs/17 row 111 (4a)) | ❌ |

**NON-VACUITY (injections, each restored byte-identically and verified with
`git hash-object` before/after — every hash matched).** Five load-bearing lines
were injected one at a time, and each killed its named test:

- item 1, injection A — the `<ModulePlanButton>` mount deleted from the tree
  header: **3/3** `campaign-tree-plan-control.test` fail;
- item 1, injection B — the shared component replaced by a FORKED local
  `<button data-testid="module-plan-button">`: **3/3** fail (the props
  assertion, the dialog assertion and the source scans), i.e. the tests really
  do pin the shared component, not a button;
- item 4, injection A — the chat writer's `registerPageFlush` deleted: **4**
  `page-flush.test` fail;
- item 4, injection B — the seam's `visibilityState !== 'hidden'` gate removed:
  **1** fails ("visible is not a write");
- item 4, injection C — the draft writer's pending gate removed (its page-hide
  flush becomes the ungated unmount `flush`): **1** fails (the draft is written
  a second time on a tab switch).

**ONE INJECTION CAME BACK GREEN, and it is the reason the flush pins look the
way they do.** The first version of the chat page-hide test asserted with a 5 s
`waitFor` and PASSED with `registerPageFlush` deleted: the 600 ms debounce
landed the write inside the wait, so the test proved the timer, not the flush.
Every flush pin now asserts the row is unwritten BEFORE the event and caps its
wait below the writer's debounce (400 ms against 600 ms, 300 ms against 500 ms) —
re-run, injection A reds 4 tests. Recorded in docs/18 §4 as a general rule.

Two further injections — the cast toast's `parts` entry removed (2 tests red)
and a fixed singular instead of the count (1 test red) — were measured on this
branch BEFORE the scope change that dropped that slice, and its code and tests
are not in the commit. They are recorded here as the measurements they were,
not as coverage that exists (docs/17 row 111 (4a)). The third measurement that
paragraph used to carry — the board's `registerPageFlush` removed, 1 test red —
was taken against the board's OLD unmount-only flush and its waited pin; it is
superseded by `board-page-flush.test` and by the fresh injections recorded in
§The page-hide seam's third and fourth writers below (docs/17 row 118).

**UNPROVEN.** jsdom has no tab lifecycle: `pagehide`/`visibilitychange` are
dispatched by hand, and no browser was asked to freeze, bfcache or discard a
real tab, so whether an IndexedDB transaction issued from a lifecycle handler
COMMITS before teardown is unmeasured — the pins cover "the write left the
debounce window and was issued", nothing more (docs/17 row 111 (a)/(b)). The
tree's two header controls were asserted at the component/props level and by
source scan, never in a real browser at a narrow pane width, so the header's
layout is not measured (row 111 (c)). Item 2 has no test by design. The cast
count is untested here because it is not in this commit at all; the board's
layout write was in the same position when this section was written and is
covered now — see §The page-hide seam's third and fourth writers below.

### Runs and generations in the background (docs/17 row 110)

The owner's report — *"when i use the app and create a module, then switch to
another browser app, i get the feeling that it gets stalled easily … can we do
something to make the browser still give the app the needed resources?"* — is
one felt problem with three causes, and each cause has its own pins. What jsdom
CANNOT do is stated at the bottom of this section and is the reason the freeze
mitigation is documented rather than measured.

| Surface | Covered by | State |
| --- | --- | --- |
| A module row an interrupted page left at `'generating'` is failed with the NAMED sentence and its unfinished part slots rewind to `'pending'` (finished parts byte-untouched) | `llm/moduleGenReconcile.test` — the row, the message and both part slots asserted; the reconcile is idempotent (a second pass writes NOTHING: the row is compared byte-for-byte) | pinned |
| The liveness guard, BOTH directions: a row a live pass owns in THIS page is never touched, and a row another tab's held generation lock covers is never touched (and IS reconciled once the lock is gone) | `llm/moduleGenReconcile.test` — a REAL held `runParts` pass (`hasLiveModuleGen` true, module still `'generating'`, part still `'generating'` after the reconcile) and a stubbed `navigator.locks.query` | pinned |
| The rewind re-opens the EXISTING recovery path: `generateMissingParts` writes exactly the rewound part, does not re-run the finished one, and the module reaches `'ready'` | `llm/moduleGenReconcile.test` — one part call asserted on the mocked transport | pinned |
| The reader an owner is actually looking at: failed banner + the reported sentence, **Resume module generation** and **Generate missing parts** ENABLED, and no Stop control left to press on a row nobody owns | `features/app-shell-boot-reconcile.test` — rendered through the real router | pinned |
| App START reconciles (a discarded tab reloads and gets no `visibilitychange`), and the boot calls are a MOUNT EFFECT: a re-render (theme toggles) cannot fail a `'running'` run | `features/app-shell-boot-reconcile.test` — the live-run case plus the "a previous page left it running" case (`'failed'` with `Interrupted by reload`, `failureKind: 'cancelled'`) | pinned |
| Stop all counts only work it did: a LIVE forge is cancelled and counted, an unclaimed row is reconciled and counted SEPARATELY, and `stopped === 0` never claims "Nothing was running" while a dead row was reconciled | `features/stop-all-generations.test` — `{ stopped, reconciled }` plus the dead-row case (`cancelModuleGen` NOT called, the row failed) | pinned |
| Every Stop control's four outcomes (cancel a live pass / name the other tab / reconcile an unowned row / say the row already settled) | `llm/moduleGenReconcile.test` (the reconcile path) + `features/module-board-rewrite.test` (the board's Stop reaches `cancelModuleGen` through the same helper) | pinned |
| The watchdog credits a SUSPENDED gap and never bills it: a gap 20× the content-stall limit does not kill a healthy stream (which then completes), and a 120 s gap does not touch the max-duration limit | `llm/openrouter-watchdog-gap.test` — `notePageSuspended`/`notePageResumed` are exactly what the visibility/freeze/pagehide listeners call | pinned |
| A clean socket close after a long silence returns the COMPLETE accumulated text (the post-loop diagnosis reports only a limit the watchdog ARMED) | `llm/openrouter-watchdog-gap.test` — a 10-minute suspension, then a clean close with no `[DONE]` | pinned |
| The limits are credited, never LOOSENED: a dead stream still fails after the resume (`stalled after 2s of silence` on the same numbers) and a keep-alive-only stream still trips `content-stall` | `llm/openrouter-watchdog-gap.test` — both failure directions asserted with the exact messages | pinned |
| `waitForRunStatus` rides the ROW, not a timer: it resolves on a Dexie row change with NO 250 ms timer scheduled while it is pending, sees a status that was already terminal, keeps waiting through non-terminal writes, still rejects with `AbortError` (even over a terminal row) and still reports a row that disappeared | `llm/runWait.test` — 8 pins, the timer one by spying on `setTimeout` and failing on any 250 ms call | pinned |
| The generation lease is advisory, both branches: with no Web Locks API the work still runs (value and errors cross untouched) and `webLocksAvailable()`/`isGenerationLockHeld` answer honestly; with the API present the lock is requested `ifAvailable`, the pass runs inside it, and it is RELEASED on success AND on failure; an unavailable lock still runs the pass | `lib/generationLocks.test` — a stubbed `LockManager` | pinned |
| The background title: `Working:` while running, `✓`/`⚠` only from a verdict, failed > finished > running with `(+N more)`, written ONLY while `document.hidden` and restored to the app title while visible, and a STOP clears the entry instead of inventing a verdict | `lib/backgroundTitle.test` — every transition asserted on `document.title` | pinned |
| A run the old render-body `failRunningRuns()` marked failed mid-flight is live and truthful again at its next step, and completes with no stale verdict | `llm/runEngine.test` — "a mid-flight interruption does not survive into the live or completed row": the run is parked in its draft model call, `failRunningRuns()` is applied to it (exactly what a re-render used to do), and BOTH the live row after the step write and the completed row are asserted verdict-free. Injection-proven for the STEP write's clearing; the completion write's clearing is REDUNDANT today (measured: removing it leaves the suite green) and is asserted as a regression guard, not claimed as a second pin | pinned (one half: guarded, not injection-proven) |
| **UNPROVEN in this environment — stated, not implied:** jsdom can neither FREEZE a page nor THROTTLE its timers, and it has no real tab strip. The tests drive the exact events the browser fires (`visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`) and assert the resulting state, so the LOGIC is pinned while the browser behaviour it answers (a real freeze of a multi-minute forge, a real 1-minute timer throttle on a hidden tab, and the freeze-opt-out effect of holding a Web Lock) is **not** observed by any test here. The freeze mitigation rests on Chromium's published opt-in/opt-out criteria and must be verified in a real browser; a future arc that needs that proof cannot get it from this suite. | docs/18 §4 | stated |

### The refill of a cited creature row (docs/17 row 112, docs/11 §A cited row's REFILL)

The owner's report — *"One other thing that currently fails often is NPC
generation … there seems to be a connection though its not 100% … i do not see
the failures as failed runs. There is a warning message shown briefly with tons
of text … looked like lots of json … This worked before the refactor."* — is one
code path with two defects (a cited row being ASKED for a stat block, and a zod
issue dump standing in for a message), and both are pinned from the row the
cast tier actually creates. Every load-bearing line below carries its own
recorded revert (the injection was applied, the named tests went RED, the file
was restored byte-identically and verified with `git hash-object`).

| Surface | Covered by | State |
| --- | --- | --- |
| The refused pair, by the schema's OWN name: an npc with a `statBlock` beside a `creatureRef` is refused, and the message the owner would read is the refine's wording (never a generic "invalid") | `llm/refill-creature-stats.test` — `npcDataSchema.parse` on the pair, the issue's `path` and its message asserted | pinned |
| A **cited** row's refill is never asked for a stat block: exactly ONE chat call is spent (draft), the statblock step ends `'skipped'` with a reason naming the citation, the prose lands, `creatureRef` is byte-identical and `statBlock` stays `null`, and no failure is toasted | `llm/refill-creature-stats.test` — the refill runs to `'completed'` with the call count asserted, the step's `output.skipped` asserted, and the artifact compared field by field. REVERT-PROVEN: removing the force-off turns this RED — the run ends `'failed'`, which is the owner's own symptom | pinned |
| A **non-cited** refill is UNCHANGED: it still asks for the stat block and still writes the block it produces (and gains no `creatureRef`) | `llm/refill-creature-stats.test` — 2 chat calls, `statBlock.hp` asserted, `creatureRef` asserted absent | pinned (regression guard) |
| A block that arrives ANYWAY (a run persisted before the rule: resumed, or a hand-edited statblock step) is refused BY NAME and writes NOTHING — the refusal names the row and the library creature, says nothing was written, and the artifact is compared byte-identical after the failure | `llm/refill-creature-stats.test` — the run is parked at a pre-written `statblock` step and resumed; the run row's `errorMessage` and the artifact are both asserted. REVERT-PROVEN twice: removing the refusal RED (the composed zod message replaces the named sentence), and silently DROPPING the block instead of refusing also RED (the run completes, which the pin forbids) | pinned |
| The failure SURFACE: the composed sentence is what the run row carries AND what the toast HEADLINE carries, with no `"code"`/issue JSON in either — asserted over a real fail path (an owner-EDITED draft whose detail entry the stored shape refuses), not only as a unit pin | `llm/refill-creature-stats.test` — the run is driven to `'failed'` through `editStep`, and the toast's first argument is compared to the run's `errorMessage`. REVERT-PROVEN: reverting `fail`'s call site RED (the message is the raw `[{…}]` dump) | pinned |
| `composedFailureMessage` composes a sentence for a zod failure — naming the FIELD, digging through union branches (a failed union is ONE issue whose own path is `[]` and whose message is the literal "Invalid input": composing from the top level gives "reply: Invalid input"). A non-zod error passes through VERBATIM | `llm/refill-creature-stats.test` — the unit pin plus the union case above. REVERT-PROVEN: replacing the branch digging with the top-level summary RED | pinned |
| **UNPROVEN in this environment — stated, not implied:** the owner's own failing runs were never available (no run rows, no transcripts), so the reproduction drives the same code path from a crafted cited row rather than replaying his run; the "not 100%" split (a cited row whose draft answered `needsStatBlock: false` succeeds) is INFERRED from the code's branch and not measured against his history; and nothing here renders the persona panel's Runs tab in a browser, so the visibility fix is proven at the ROW level (a failed row carrying the composed sentence, plus that same string as the toast headline) and not by driving the UI to find it. Whether every npc-generation failure he saw was this path is NOT established: a draft parse failure or a refused model reply fails an npc run by other routes and does write a failed run row of its own. | docs/18 §4; docs/17 row 112 | stated |

### Authorship of module text (docs/17 row 113, amending fix-01's consent rule)

| Surface | Covered by | State |
| --- | --- | --- |
| The ONE part-text save seam records the ORIGIN: a write supplying a `writerModel` records `'model'` (and still `edited: true`), a write omitting it records `'human'` while the previously recorded model id is CARRIED forward, and a first hand write stays `''` | `llm/module-edit-origin.test` (3) | ✅ |
| The generated premise normalizes AUTOMATICALLY (rewritten in place, `origin` stays `'model'`, `entityRewriteProposals` stays `null`); a premise the owner wrote is HELD with its proposal and left byte-identical | `llm/module-edit-origin.test` (2) | ✅ |
| The consent rule reads authorship, not `edited`: a canvas-applied MODEL part (`edited: true`, `origin: 'model'`) is rewritten immediately with nothing held, while a hand-written part beside it holds its proposal and the generated part next to it is rewritten | `llm/module-edit-origin.test`, `features/entity-classify-new.test` (the same pair through a REAL chat apply and a REAL hand save) | ✅ |
| The generator's own stamps: a part the parts pass writes is `edited: false` + `origin: 'model'`; the checkpoint keeps `'model'` when the premise is unchanged (clicking through claims nothing) and stamps `'human'` when the owner rewrote it there (the recorded `writerModel` untouched) | `llm/module-edit-origin.test` (3) | ✅ |
| The conservative legacy default: `origin: null` holds on BOTH documents, the accessor table pins `null`/`undefined`/`'human'` as a person's and `'model'` as machine-written, and a PRE-FIELD row (no `origin` key at all) parses to `null` with no Dexie version bump | `llm/module-edit-origin.test` (3) | ✅ |
| The wording never asserts an authorship the row cannot support: the banner names the documents held ("the premise and part 1") and says nothing was changed, the dialog rows name each writer, and the reader/board rewrite alert uses the same label | `features/entity-panel.test`, `features/module-reader.test` | ✅ |
| The floor-repair clause and the panel's problem list say "written outside the generator", never "hand-edited" or "your text" (asserted as ABSENT substrings, not just present ones) | `features/module-problems.test` | ✅ |
| The board's two gestures state the authorship they do not change: Apply keeps the engine's rewrite as `origin: 'model'` with its serving id (never downgraded to the owner's), and Discard restores the previous text WITH the `origin` + `writerModel` captured when the rewrite staged | `features/module-board-rewrite.test` (apply + discard pins, a mocked engine that stamps what the real one stamps) | ✅ |
| The staged entry carries the old authorship: `stageProposal` stores it from the first moment it is readable, and a re-proposal replaces text AND authorship together (a Discard restores what the LAST rewrite replaced) | `features/staged-rewrites.test` | ✅ |
| The banner sentence is derived, not asserted: it names the documents held in plan order, counts the rewrites, says nothing was changed, and contains no authorship claim; the writer labels come from the row (`you` / the model id / "the model" / "written by hand — or before the app recorded authorship") | `features/module-problems.test` | ✅ |
| The generator stamps its OWN premise: a `runSpine` premise is `origin: 'model'` + the serving id, so the next normalization pass rewrites it in place instead of proposing it (the owner's report, end to end) | `llm/module-edit-origin.test` | ✅ |

### The creator's bestiary window (docs/17 row 114, docs/12 §7)

The owner's four refused casts were never a lookup bug: the spine prompt offered
a bestiary slot and showed NO creature it could name. What this matrix covers is
(a) that the window is built from the population the LOOKUP uses, (b) that its
order/cap are §7's, (c) that an empty window offers nothing, and (d) that a name
which still misses gets an actionable refusal without the resolution ever
loosening.

| Surface | Covered by | State |
| --- | --- | --- |
| The window lists a creature from a **`pdf`-imported** book (not just a pack) and from a book still `processing`, and every line names a creature `listLibraryCreatures` returns — so the vocabulary a prompt shows and the lookup that judges the reply cannot disagree | `llm/creatorRoster.test` (2). REVERT-PROVEN: replacing the source with the encounter roster's `origin === 'pack' && status === 'ready'` filter turns 11 pins RED, including the prompt and cast ones | ✅ |
| The window prints the library's OWN spelling of a nested name (the innermost heading — what the cast compares), never `headingPath[0]` | `llm/creatorRoster.test` (1). REVERT-PROVEN: `headingPath[0]` RED | ✅ |
| The §7 window order: level distance to the target through the SHARED comparator, ties by `levelSort` then locale name, `"—"`/unparsable levels LAST (two of them included — no NaN comparator result) | `llm/creatorRoster.test` (4). REVERT-PROVEN: replacing the comparator with level/name ascending RED (3); a fake `Number(level) \\|\\| 0` parser RED on the `—` pin | ✅ |
| The spine's target is the module's `levelMin`/`levelMax` **midpoint**, not one of its edges | `llm/moduleGen-cast.test` (`targets the module's OWN band MIDPOINT` — levels 1–6 ⇒ 3.5, so a level-1/4/7 library must list 4, 1, 7). REVERT-PROVEN: passing a literal `1` as the target RED | ✅ |
| The cap is 300 lines with the `(roster truncated; N more)` note, and a library that fits claims none | `llm/creatorRoster.test` (2, synthetic) + `llm/moduleGen-cast.test` (305 seeded creatures ⇒ 300 lines + `(roster truncated; 5 more)` in the real prompt) | ✅ |
| Determinism: two builds over the same library produce the same lines, in the same order | `llm/creatorRoster.test` (1) | ✅ |
| The composed spine prompt carries the REAL names (one per line, copied as the library spells them), the rule ("copied exactly as it is written there", "never given a level-adapted, renamed or otherwise decorated variant", "NO bestiary slot and write the mob into the scene instead") and the truncation note | `llm/moduleGen-cast.test` (2) | ✅ |
| **Additive discipline**: a workspace with NO bestiary, and a library whose only statblock chunks carry no validated stat block (an EMPTY window), both compose the PRE-CHANGE prompt byte for byte — measured against the pre-style golden fixture — with no clause, no listing and NO slot offered | `llm/moduleGen-cast.test` (2 inherited + 1 new empty-window pin). REVERT-PROVEN: dropping the empty-window guard RED (3 pins) | ✅ |
| A creature named EXACTLY from the window still resolves, casts, and carries the window's own spelling into the citation (the owner's Aunt Agatha path, regression) | `llm/moduleGen-cast.test` (`casts the creature the WINDOW listed`) | ✅ |
| The no-such-creature refusal names the nearest creatures (case/hyphen/umlaut/qualifier-insensitive, bounded to three, deduped, each with its book) and stays SILENT when nothing is close | `llm/moduleGen-cast.test` (1, both halves through `runEntityBatch`) + `llm/creatorRoster.test` (4) + `domain/creatureName.test` (13). REVERT-PROVEN: making the suggestion unconditional RED | ✅ |
| The normalization and similarity measures themselves: case, whitespace, hyphen-vs-space, umlauts and NFKD-invisible ligatures (æ/ø/ß/þ), a trailing `(…)` qualifier, and an empty side scoring 0 (never a division artifact) | `domain/creatureName.test` (13) | ✅ |
| **REGRESSION GUARD — the encounter roster is unchanged by the shared-comparator extraction**: its own 29 pins (order, cap, note, name index, duplicate-book suffix, retry, item/section skipping) stay green with `buildPackRoster` reading `libraryLevelOrder` | `llm/encounter-roster.test` (29, untouched) | ✅ |
| **UNPROVEN — stated, not implied:** no live-provider run observed a model naming a creature from the list (every pin mocks the transport at the protocol boundary), so "the model copies a listed name in production" is intent rather than measurement; the suggestion FLOOR (`0.4`) was calibrated against hand-written cases only — no real library was swept — so a compound-language near miss below it stays silent, which is the designed direction but not a measured one; the window's ORDER cannot be observed in a finished module, only in the composed prompt; and 300 lines is §7's cap inherited for this consumer rather than re-derived | `docs/18 §4`; `docs/12 §7`; `docs/17 row 114` | stated |
| **A run the owner STOPPED is never reported as a failure and never resurrected**: a step reply that lands after `cancelAll()` is discarded before any write, the row keeps `cancelled`, a cancel-path write meeting a deleted row stays silent, and the stopped row keeps its Retry | `features/encounter-map-queue.test.ts` (4 new: the late-reply seam — row stays `cancelled`, no toast; the vanished-row spurious toast; a step DYING after the stop with the row gone; and the contrast — a step that dies with NO stop in play still toasts and still writes its `failed` row) + `llm/runEngine.test.ts` (2 new: the in-flight step does not resurrect a stopped run; the stop does not strand the row's Retry). The pre-existing `cancelAll` pin is byte-unchanged | ✅ REVERT-PROVEN, line by line: restoring `cancel()`'s `cancelRequested.delete` REDs 4 of the 6 with the sightings' own `Encounter step "brief" failed: PersonaRun not found: …`; removing the catch branch's tolerant write REDs the died-after-stop pin; removing `retryStep`'s restart clear REDs the Retry pin; removing `recordCancelled`'s vanished-row tolerance REDs the same pin with an unhandled `NotFoundError` |
| **UNPROVEN — stated, not implied (same row):** two of the fix's guard lines are NOT reached by any pin — the tail check before the completion write, and the intent clears in `executeFrom`'s `finally` and early return (injections removing each stay GREEN), so they are consistency, not coverage; the *victim* of the original flake is not identified (the guards test `:371` and the dequeue test `:416` both return with real orchestration in flight, and only the SHAPE is forced); and a cancel landing AFTER a pipeline has already ended leaves the intent set until the row's next deliberate restart (measured `pipelines=0 intent=1` at a test boundary) | `docs/17 row 115`; `docs/18 §4` | stated |

### Deleting a run while it is generating (docs/17 row 116, docs/18 §4)

The Runs tab offers its delete button for every row whatever the status, so the
owner can delete a run whose step is parked on a model reply. What this matrix
covers is that the delete is a STOP (the same cancel intent ledger 115 landed),
that a row which is not generating is untouched, and that the loudness which
belongs elsewhere is still loud. Every pin FORCES the ordering (docs/08 §own the
promise, not the clock): the brief's reply is a promise the test releases BY
HAND after the delete has landed, so no timer, no load and no widened timeout
decides the outcome.

| Surface | Covered by | State |
| --- | --- | --- |
| **The forcing pin.** The Runs tab's own delete button, clicked while the run's step is parked mid-brief: the row is gone when the gesture completes, the late reply produces NO toast and NO row, and the campaign holds no runs at all | `features/run-delete-running.test.tsx` (`stops the run BEFORE its row goes` — RED before the fix) | ✅ REVERT-PROVEN: removing the `stopRunsBeforeDelete` call from `handleDeleteRun` REDs it with the sightings' own sentence, `expected [ Array(1) ] to deeply equal []` received `"Encounter step \"brief\" failed: PersonaRun not found: <uuid>"`, plus the unhandled `NotFoundError` from `fail`'s write (the row-97 shape) |
| **Every campaign-level wipe stops the runs whose rows it is about to delete** — `deleteCampaign`, `removeAllGeneratedContent`, `deleteCampaignWorkspace`, each parked-then-wiped-then-released | `features/run-delete-running.test.tsx` (2 + `it.each` over the three wipes = 4 pins) | ✅ REVERT-PROVEN one call site at a time: dropping `stopGeneratingRunsForCampaign` from `deleteCampaignWorkspace` REDs 2, from `deleteCampaign` REDs 1, from `removeAllGeneratedContent` REDs 1 |
| **A row that SAYS `running` with no pipeline in this page is still stopped on its way out** (a stale row after a reload, or one another tab drives) — the ROW half of `isGenerating`, not just the engine's controller registry | `features/run-delete-running.test.tsx` (`a row that SAYS running …`, asserts `cancel` was called with the id and the row went `cancelled` first) | ✅ REVERT-PROVEN: reducing `isGenerating` to the controller registry alone REDs this pin |
| **Deleting a FINISHED run is unchanged**: no stop is recorded, no failure toast, the row goes | `features/run-delete-running.test.tsx` (`deleting a FINISHED run is unchanged`, asserts `runEngine.cancel` was NEVER called) | ✅ REVERT-PROVEN: removing the `isGenerating` guard so every id is cancelled REDs it |
| **The contrast stays green**: a step that dies ON ITS OWN — no stop and no delete in play — still toasts AND still writes its `failed` row (AGENTS rule 1; the cure is the gesture, not a quieter `fail`) | `features/run-delete-running.test.tsx` (`a step that dies on its own …`). Green before the fix and after it | ✅ pinned both ways (it is the guard against curing this seam by swallowing) |
| **REGRESSION GUARD — the ledger-115 cancel pins are untouched and stay green**: the late-reply seam, the vanished-row spurious toast, the died-after-stop pin, the genuine-failure contrast, the two run-engine pins, and the pre-existing `cancelAll` pin | `features/encounter-map-queue.test.ts` (11/11) + `llm/runEngine.test.ts` (28/28), both files byte-unchanged by this row | ✅ |
| **UNPROVEN — stated, not implied:** the residual SECOND surface is measured but NOT cured. Probe, three variants, one process: (A) delete the row while the unattended encounter-map queue watches the run → TWO toasts — the pipeline's `Encounter step "brief" failed: PersonaRun not found: <uuid>` and the queue's `Could not generate a map for "…"` (`Run <id> disappeared while waiting for it to finish`), `failed:1`; (B) cancel-then-delete (this row's gesture) → the pipeline's toast is gone, the queue's remains; (C) `cancel()` ONLY, nothing deleted → the queue STILL toasts (`run ended cancelled`), `failed:1`. So the queue's verdict on a run the owner stopped is pre-existing and not delete-specific (`features/modules/encounter-map-queue.ts:135` → `lib/jobQueue.ts:202`), and its pins are in the file this row was told to leave untouched | `docs/17 row 116`; `docs/18 §4` | stated |
| **UNPROVEN — stated, not implied (same row):** two lines are NOT reached by any pin — `isGenerating`'s controller-registry check, and `stopGeneratingRunsForCampaign`'s `status === 'running'` pre-filter (removing each leaves all 8 pins GREEN; the first is defensive, the second only saves reads, and `stopRunsBeforeDelete` re-checks anyway); a run another TAB drives is stopped here by its ROW but its live pipeline cannot be aborted across tabs; and `cancel()`'s own write stays loud if the row vanishes between the read and the write (the gesture then toasts `Could not delete run`, unchanged) | `docs/17 row 116`; `docs/18 §5` | stated |

### A run the owner withdrew (docs/17 row 117, docs/18 §4/§5)

The ledger-116 section above ends with a MEASURED residue: the unattended
encounter-map queue still reported the owner's own stop as a failure. That
residue is CURED by row 117 — the row above is kept as the state of that slice,
not of HEAD. What this matrix covers is that a job whose RUN was withdrawn (the
owner cancelled it, or its row was deleted) settles silently while a run that
failed on its own stays loud, and that the withdrawal is ONE named fact the run
engine owns (`isRunWithdrawn`, `src/llm/runEngine.ts:372`) rather than a fourth
private status comparison. Every pin FORCES the ordering (docs/08 §own the
promise, not the clock): the Cartographer's brief reply is parked on a promise
the test never releases, the job is left WAITING on a run whose row is
`running`, and only then does the test stop or delete it — with NO
`dequeue`/`cancelAll` in play, so the queue's own abort signal is not the seam
under test and the ROW is the only fact available. No timer, no load and no
widened timeout decides any outcome.

| Surface | Covered by | State |
| --- | --- | --- |
| **The forcing pin (variant C): a run the owner CANCELLED under a watching job** — the queue settles with no toast, no retryable `failed` entry, the dock drained, and no map generated | `features/encounter-map-queue.test.ts` (`a run the OWNER cancelled under a watching job …`) | ✅ RED at the base SHA with the sighting's own strings — `toastError` first argument `Could not generate a map for "Stopped by owner"`, second `[Error: run ended cancelled]`, `failed` `[{artifactId…}]` — GREEN after the fix. REVERT-PROVEN line by line: removing the cancel branch's `ctx.withdraw()` REDs it (and the cancel-then-delete pin); making `isRunWithdrawn` return `false` REDs 4; dropping its `'cancelled'` face REDs this pin alone |
| **The forcing pin (variant A): the run ROW DELETED under a watching job** — same silence; the row is asserted GONE and the encounter still unmapped | `features/encounter-map-queue.test.ts` (`a run row DELETED under a watching job …`) | ✅ RED at the base SHA (`Could not generate a map for "Row deleted"` + `[Error: Run <id> disappeared while waiting for it to finish]`, `failed:1`), GREEN after. REVERT-PROVEN: removing the catch branch's `ctx.withdraw()` REDs it; changing the re-read's `isRunWithdrawn(observed)` to a private check REDs it; dropping the predicate's gone-row face REDs it (with the cancel-then-delete pin) |
| **The forcing pin (variant B): cancel-THEN-delete** — the Runs tab's own gesture (ledger 116's cancel-then-delete) is the same withdrawal on both halves | `features/encounter-map-queue.test.ts` (`cancel-then-delete …`) | ✅ RED at the base SHA (`… "Stop then delete"` + `[Error: Run <id> disappeared while waiting for it to finish]`), GREEN after. REVERT-PROVEN by either branch's `ctx.withdraw()` and by either face of the predicate |
| **A withdrawal is spent per JOB, not per key**: the same encounter enqueued again and withdrawn again owes its OWN dock decrement (no stuck 0/1 dock, no permanently silent job) | `features/encounter-map-queue.test.ts` (`a withdrawn job key enqueued AGAIN …`) | ✅ REVERT-PROVEN: removing the enqueue-time `withdrawn.delete` REDs it; it is the pin the other four do not provide for the cleared key |
| **THE CONTRAST — a run that FAILED on its own still toasts and still lands retryable**, so the withdrawal is never a blanket swallow (AGENTS rules 1-2) | `features/encounter-map-queue.test.ts` (`the contrast: a run that FAILED on its own …`, asserting the queue's OWN title `Could not generate a map for "Provider died in queue"` plus `failed:[job]`) | ✅ pinned both ways: GREEN before and after the fix, and the swallow-everything injection (`isRunWithdrawn(run)` → `run.status !== 'completed'`) REDs it together with TWO pre-existing pins (`uses one candidate, continues after failure, and retries only failed jobs`, `a step that dies on its own …`) |
| **A job whose run COMPLETED normally is unchanged** — it maps, it never toasts, it never lands retryable, and the row still reaches `'completed'` | `features/encounter-map-queue.test.ts` (`a job whose run COMPLETED normally is unchanged …`), on top of the three pre-existing completed-run pins | ✅ GREEN before and after |
| **REGRESSION GUARD — the 11 pre-existing pins in that file are byte-unchanged and green**, including `dequeue cancels the in-flight unattended run and drops the job silently`, `cancelAll … settles silently (stop-all seam)` (which also asserts the dock drains) and the two ledger-115 late-write pins | `features/encounter-map-queue.test.ts` (17/17). NONE of the pre-existing pins had to change | ✅ |
| **REGRESSION GUARD — the shared factory did not move its other consumers**: the three other `createJobQueue` queues, `dequeue`'s three callers, `cancelAll`'s only caller, and the two callers FOLDED onto the predicate | `features/entity-image-queue.test.ts` + `features/mob-portrait-queue.test.ts` + `features/cover-image-queue.test.ts` + `features/single-mob-portrait-queue.test.ts` (39), `features/stop-all-generations.test.ts` + `features/run-delete-running.test.tsx` + `features/progress-dock.test.tsx` + `lib/progress.test.ts` + `llm/runEngine.test.ts` (51), `llm/chainRunner.test.ts` (13), `features/entity-batch.integration.test.tsx` + `features/entity-batch-fixed-cast.test.ts` (4), `llm/moduleGen-cast.test.ts` + `features/change-artifact-instruction.test.ts` | ✅ all green, byte-unchanged except the three mock factories that had to expose the REAL predicate (a mock that re-implemented it would judge the fold against a fake) |
| **REVERT-PROVEN, the ten injections that bite, each restored byte-identically (`git hash-object` before/after):** `ctx.withdraw` → no-op **REDs 3**; the counter decrement dropped **REDs 4** (including the PRE-EXISTING `cancelAll` dock-drain pin — the queue's withdrawal and the body's are one path); `isRunWithdrawn` → `false` **REDs 4**; its gone-row face → `run?.status === 'cancelled'` **REDs 2**; its cancelled face → `run === undefined` **REDs 1**; the cancel branch's `ctx.withdraw()` **REDs 2**; the delete branch's **REDs 2**; the row re-read **REDs 1**; the swallow-everything condition **REDs 3**; the enqueue-time clear **REDs 1** | as listed | ✅ 10 RED of 12 injections |
| **UNPROVEN — stated, not implied (same row):** TWO lines are NOT reached by any pin and both injections come back GREEN — the `withdrawn`-set idempotence guard in `withdrawJob` (it protects the concurrent `cancelAll`-during-a-body's-own-unwinding race, which no pin forces) and `processJob`'s aborted-never-settles-as-work return (the encounter-map body always throws after `withdraw()`; it protects a body that RESOLVES after a dequeue, which no pin drives). Also unproven: the three FOLDS are behaviour-identical by construction for a defined row but have no pin of their own (injecting `false` at each folded line leaves `llm/chainRunner.test.ts` 13/13 and the two entity-batch suites 4/4 green — my pins reach the SAME predicate through the map queue); no live-provider or real-browser sighting was reproduced (every pin mocks `chat` at the protocol boundary and drives the queue in jsdom); a DELETED ENCOUNTER (not a deleted run) stays loud by design and was not measured; and no pin asserts the withdrawn run row's final state beyond `'cancelled'`/gone | `docs/17 row 117`; `docs/18 §4/§5` | stated |

### The page-hide seam's third and fourth writers (docs/17 row 118, extending row 111)

Row 111 built `lib/pageFlush` for the two writers that existed then and left the
board open by instruction (row 111 (4b)). Row 118 folds the board's layout write
onto that seam and, in the same sweep, the artifact editor's autosave — the last
two debounced ROW writers in the app that could lose work when the page is taken
away without unmounting.

| Surface | Covered by | State |
| --- | --- | --- |
| A board DRAG whose 600 ms layout write is still inside the window LANDS on `pagehide` — with the `patchModule` call asserted SYNCHRONOUSLY in the same turn as `dispatchEvent`, the row asserted UNWRITTEN first, and the row then read back at the dragged position | `board-page-flush.test` | ✅ |
| …and separately on the hidden `visibilitychange` the seam listens for | `board-page-flush.test` | ✅ |
| A `visibilitychange` → VISIBLE is not a write: nothing is issued AND the queued drag still lands on a later `pagehide` (the gate, not just the silence) | `board-page-flush.test` | ✅ |
| A board with NO pending layout write writes NOTHING on either signal (asserted with a row sentinel — `canvas` stays `null` — so a write is visible as changed data, not only as a call count) | `board-page-flush.test` | ✅ |
| `hidden` then `pagehide` for one drag is ONE write (the pending timer leaves the queue before the write) | `board-page-flush.test` | ✅ |
| The IN-APP unmount flush still lands the pending drag (the regression this change could have moved) | `board-page-flush.test` | ✅ |
| A FAILING page-hide write still reaches the owner: `Could not save the board layout` | `board-page-flush.test` | ✅ |
| The seam still keeps ONE registration list: the only files under `src/**` that add a `pagehide`/`visibilitychange` listener are `src/lib/pageFlush.ts` and `src/lib/pageLiveness.ts` (the suspend/resume CLOCK — an unrelated seam), and `BoardPage.tsx` names neither event; TWO writers (the board's drag and the chat thread's queued turn) each write exactly ONCE on ONE dispatch | `board-page-flush.test` — source scan + a behavioural two-writer pin | ✅ |
| An artifact EDIT inside the 800 ms autosave window LANDS on `pagehide`, and separately on the hidden `visibilitychange`; nothing was written before the event; the row and its revision count are read back | `editor-page-flush.test` | ✅ |
| The editor's autosave gate holds: with nothing pending, neither signal writes (no row write, no revision), asserted through the Dexie table the real save path writes | `editor-page-flush.test` | ✅ |
| ONE save when both signals fire for one edit, and the editor's IN-APP unmount flush still lands the edit | `editor-page-flush.test` | ✅ |
| An editor save that FAILS on the page-hide path still toasts `Autosave failed`, writes no row and fires no revision | `editor-page-flush.test` | ✅ |
| `lib/pageFlush.ts` itself | **UNCHANGED** — byte-identical (`git hash-object` `1d1eef7424e22680db5e0d6b591adca90771ef78` before and after this slice), so the two existing registrations' pins (`page-flush.test`, `new-module-draft.test`) are re-run and green without a contract change | n/a |

**NON-VACUITY (REVERT-PROVEN lines — every injection applied on the new tests,
named by the pins it killed, then restored byte-identically and verified with
`git hash-object` before/after; every hash matched).**

| Injected line | Killed |
| --- | --- |
| `BoardPage`: the `registerPageFlush` call deleted (unmount flush left intact) | **6** of 9 `board-page-flush.test` — both page-hide pins, the visible-gate pin, the one-write pin, the failing-write pin and the two-writer pin |
| `BoardPage`: the pending gate removed (`flushPendingLayout` always writes) | **3** — "writes nothing … when no layout write is pending" (called twice), "writes ONCE when both signals fire" (2 ≠ 1), the two-writer pin (3 ≠ 2) |
| `BoardPage`: the timer dequeue removed (flush writes but leaves the timer queued — idempotence gone) | **4** — the one-write pin, the unmount pin (the timer then writes a second time), the failing-write pin, the two-writer pin |
| `BoardPage`: the cleanup's `flushPendingLayout()` removed (the pre-existing unmount guarantee) | **1** — "still flushes the pending write on unmount" |
| `BoardPage`: the `catch` around `patchModule` removed (no failure report) | **1** — "reports a failing write on the page-hide flush too" (plus an unhandled rejection, which is the point of the catch) |
| `artifact-editor`: the `registerPageFlush` call deleted | **3** — both page-hide pins and the one-save pin |
| `artifact-editor`: the cleanup's `flushPendingEdits()` removed | **1** — "still flushes the pending edit on unmount" |
| `artifact-editor`: `saveDraft`'s `deepEqual(effective, lastSavedRef.current)` early return removed (the pending gate) | **2** — "writes nothing when no edit is pending" and "writes ONCE when both signals fire" |
| `artifact-editor`: `toastError('Autosave failed', error)` removed | **1** — "reports a failing write on the page-hide flush too" |
| FLAW-DETECTOR VERIFICATION (not a revert of shipped code): a SECOND `window.addEventListener('pagehide', …)` added to `BoardPage.tsx` — the exact shape AGENTS rule 4 forbids | **1** — the source-scan pin, reporting `['src/lib/pageFlush.ts', 'src/lib/pageLiveness.ts', 'src/features/modules/board/BoardPage.tsx']` |

**TWO INJECTIONS CAME BACK GREEN, AND BOTH CHANGED THE PINS.** They are the
reason this section exists rather than a claim of coverage.

1. **The editor's page-hide pins passed with its `registerPageFlush` deleted
   (6/6 green).** The waits were bounded by `waitFor(… AUTOSAVE_DELAY_MS + 1000)`,
   so the 800 ms debounce landed the write inside the wait: the pins proved the
   TIMER, not the flush — row 111's own lesson, one writer later. Fixed by
   asserting the write at the EVENT: the editor's row writes are counted through
   `db.artifacts.put`/`db.revisions.put` around the dispatch, after a
   microtask-only drain that advances no timers — so a write that appears there
   can only have come from the flush. Re-injected: **3 red**.
2. **The editor pin for the failing write initially could not fail at all**,
   because the instrument was wrong rather than the code: `vi.mock('@/db/artifactRepo')`
   never reached the component (the `@/db` barrel's namespace re-export is a
   separate frozen module object), and assigning over the barrel's property
   throws `Cannot set property updateArtifact of [object Module] which has only
   a getter`. The pin was green while exercising the REAL, unmocked writer.
   Fixed by watching the Dexie table; re-injected: **1 red**. Recorded as a
   general gotcha in docs/18 §4.
3. **A third measurement limits the seam-model pin**: `vi.spyOn(document,
   'addEventListener')` does NOT intercept the seam's own
   `document.addEventListener('visibilitychange', …)` call — an instrumented
   seam logged `isMock=undefined` while the spy DID record the document's other
   listeners (React Flow's `keydown`/`selectionchange`), and the window spy DOES
   see `pagehide`, so a listener-count pin would have failed on one event and
   passed on the other for reasons that have nothing to do with the seam. The
   model is pinned by the source scan (last row of the matrix above) plus the
   two-writer behavioural pin instead; the count-based attempt was deleted rather
   than left as a false witness.

**UNPROVEN here too.** jsdom cannot freeze a page, throttle its timers, put a
page in bfcache or discard a tab, so `pagehide`/`visibilitychange` are dispatched
by hand and no real mobile Safari / Chrome tab-management run was performed:
whether the transaction issued from a lifecycle handler COMMITS before teardown
stays unmeasured (row 111 (a)/(b)) — the same limit the seam's other two
registrations carry. The editor's page-hide flush sets `saveState` from a
lifecycle event, a React state update that in the app happens outside `act`; the
pins wrap the dispatch in `act` and cover nothing about the unwrapped path. The
board pins assert the write was ISSUED and the row carries the drag — they do not
re-measure `moduleRepo.patchModule`'s read-inside-the-transaction merge against a
concurrent parts write.

### The normalization-failure sentence (docs/17 row 119, docs/18 §4)

The sentence a failed normalization pass shows is ONE seam
(`NORMALIZATION_FAILURE_MESSAGE`, toasted by `recordNormalizationFailure`), and
the classification pass's catch now carries the same cancel guard its sibling
carries. Both halves are pinned here; the wording itself is pinned verbatim by
the four pre-existing assertions, which pass byte-unchanged.

| Surface | Covered by | State |
| --- | --- | --- |
| The four sites that report a failed pass read ONE export: changing `NORMALIZATION_FAILURE_MESSAGE`'s value REDs every verbatim pin (`tests/llm/moduleGen.test.ts:1057`/`:1122`/`:1255`, `tests/features/entity-classify-new.test.tsx:359`) plus the two new sentence assertions | those four files | ✅ |
| A STOP landing while the incremental classification's call is in flight is NOT a normalization failure: the abort PROPAGATES, `entityNamesNormalized` stays `true`, no error is recorded and nothing is toasted — and the pass's own signal really reached `chat` (asserted on `mock.calls[0][1].signal`) | `moduleGen.test.ts` (`:1341`) | ✅ |
| A GENUINE failure with a live (never-aborted) signal still records the error, closes the gate and toasts the ONE shared sentence — the guard excuses a stop, never a provider | `moduleGen.test.ts` (`:1367`) | ✅ |
| The panel's belt toast uses the seam's sentence (the pass mocked to throw, the "Normalize names" control clicked, the toast asserted against the export) | `normalization-failure-wording.test.tsx` (`:106`) | ✅ |
| The sentence is STATED in exactly one file under `src/**` (scan over every `.ts`/`.tsx`, with a file-count non-vacuity check), the panel contains the export's name and NOT the literal, `moduleGen.ts` states it exactly once and goes through its seam at five catches | `normalization-failure-wording.test.tsx` (`:132`) | ✅ |
| The sibling surfaces are deliberately NOT folded and keep their own wording, because each answers a different question: the sweep's refusal (`resume-automation.ts:213`), the disabled batch control's gate reason (`entity-panel.tsx:281`), the row-error label (`entity-panel.tsx:779`) | `module-problems.test.ts` + `module-resume-automation.test.ts` (re-run, unchanged) | ✅ |

**NON-VACUITY (REVERT-PROVEN lines — each injection applied, the killed pins
named, then restored byte-identically and verified with `git hash-object` before
and after; every hash matched).** `src/llm/moduleGen.ts` was
`1f54384e80ba0cb9f8ec74326009afac9240df15`, `entity-panel.tsx`
`3ccc75e6ef3b475b3e12ff6454587277d9753ab4` and `resume-automation.ts`
`fb0291429cbd61070205a45dcb26b839d91be069` at every restore.

| Injected line | Killed |
| --- | --- |
| `moduleGen.ts:2165` — the `isCancel` guard DELETED from the classification's catch | **1** of 68 in `moduleGen.test.ts` — "a STOP mid-pass is not a normalization failure" (it resolved `{classified: [], failed: true}` instead of rejecting) |
| `moduleGen.ts:2152` — the signal DROPPED from the classify call (`{ canonicalNames: recordedNames }`) | **1** — the same pin, now at the `carried` assertion (`undefined` where the controller was expected): the guard alone is not enough, the call must be cancellable |
| `moduleGen.ts:1137` — the shared constant's VALUE changed | **5** in the two files above + **1** of 8 in `entity-classify-new.test.tsx` (the pre-existing panel pin) — proof that all four pinned sites read the fold rather than a private copy |
| A FOURTH copy of the sentence appended to `resume-automation.ts` (a flaw-detector injection, not a revert of shipped code) | **1** — the source scan, reporting two files instead of one |
| `moduleGen.ts:2013` — the full pass's fold REVERTED to the inline literal | **1** — the scan only (its "stated exactly once" split). The 77 behavioural pins stayed GREEN, and that is the honest result: a fold is byte-identical by construction, so no behavioural pin can reach it |
| `entity-panel.tsx:472` — the panel's fold REVERTED to its literal | **1** — the scan only (the file list). The belt pin stayed GREEN for the same reason: a toast spy cannot tell a copy from the shared constant, which is exactly why the fold's own pin is a source scan |

**UNPROVEN here.** No live-provider or real-browser run observes any of it —
every pin mocks `chat` at the protocol boundary. No test drives a Stop into the
classification pass through a real caller, because no caller CAN pass a signal
(that is the reachability finding, docs/17 row 119): the cancelled-pass pin
hands the pass a controller directly, so it proves the pass's behaviour and not
the app's reachability. With no signal the pass still records a same-realm
`AbortError` as a failure, deliberately (the signal is the source of truth, not
the error's type), and no pin covers that branch. The scan is textual: a copy
split across a template literal or a concatenation would not be seen.
### The module-busy copy (docs/17 row 120, docs/18 §2.3/§4/§5)

An audit looking for AGENTS rule 4's shape found the highest site count of
anything in the repo, and it was purely mechanical: ONE condition ("this module
already has a generation running") written out SEVEN times as a toast literal
(`ChatSidebar.tsx:168`/`:251`, `CanvasPage.tsx:856`/`:1156`/`:1245`/`:1283`,
`BoardPage.tsx:197`), THREE times as a private constant all named
`MODULE_GENERATING_REASON` (`CanvasPage.tsx:2180`, `spine-checkpoint.tsx:31`,
`boardNodes.tsx:117` — a fourth copy lived inline in `entity-panel.tsx:377`
until ledger 123 folded it, see §The two deferred folds and the busy message's
own sentence), plus `ModuleBusyError`'s own uuid-bearing message
(`src/llm/moduleGen.ts:123`, reworded by ledger 123 in the same place) reaching
the owner as the toast's DESCRIPTION. The
copy now has ONE seam (`src/features/modules/module-busy.ts`); the two sentences
stay two because they answer two questions for two audiences, and the busy GATE
is untouched (`llm/canvasBusy` + `lib/generationLocks` remain two documented
authorities). Nothing in this section loads the machine: every pin is a single
bounded suite, and the injections are text edits, run one at a time.

| Surface | Covered by | State |
| --- | --- | --- |
| **The two sentences are byte-identical to the literals they replaced, and are deliberately NOT the same string** (a refused ACTION vs a blocked CONTROL) | `features/module-busy.test.ts` (`are byte-identical to the literals the fold replaced`, `stay two DIFFERENT sentences`) — the expected strings are independent copies written in the test, not imported from the module under test | ✅ REVERT-PROVEN: mutating `MODULE_BUSY_TOAST_TITLE` REDs the first pin; mutating `MODULE_GENERATING_REASON` REDs it as well (the distinctness pin still passes, correctly — the point is that a collapse would RED it) |
| **The helper's user-visible outcome: the shared title, and NO uuid-bearing description** — pinned through the REAL toast seam with the REAL error class (`sonner` mocked, `@/lib/toast` NOT mocked) | `features/module-busy.test.ts` (`toasts the shared title, WITHOUT the refusal's own sentence as the detail line`, `drops the description for a directly-toasted busy refusal too`) | ✅ REVERT-PROVEN: deleting the seam's suppression branch REDs both; mismatching `MODULE_BUSY_ERROR_NAME` in `lib/toast.ts` — or `this.name` in `moduleGen.ts` — REDs both. The pin's non-vacuity is the REAL class's NAME since ledger 123 (it used to assert the message CONTAINED the id, which the reword retired); MEASURED that the two pins pass for the NAME: reverting the reword leaves BOTH of them green |
| **All SEVEN folded catch sites route through the helper** — a SOURCE SCAN, and labelled as one: it counts `instanceof ModuleBusyError` branches per file (2 / 4 / 1 / 0 / 0) and requires `toastModuleBusy(` inside each branch | `features/module-busy.test.ts` (`routes every folded busy catch site through toastModuleBusy (SOURCE SCAN)`) | ✅ REVERT-PROVEN: reverting `ChatSidebar.tsx:169`, a `CanvasPage.tsx` chat site, or `BoardPage.tsx:197` to the inline literal REDs it (with the one-source-file pin). A COUNT rather than a lower bound, so a NEW unrouted busy site fails with the file named |
| **The three private constants are gone; their readers import the shared one, and the toast sentence lives in exactly ONE source file** | `features/module-busy.test.ts` (`leaves the toast sentence in exactly ONE source file`, `leaves the blocked-control sentence in exactly ONE source file`) | ✅ REVERT-PROVEN: re-duplicating a same-valued constant in `boardNodes.tsx` or `spine-checkpoint.tsx` REDs the scan. It is an EQUALITY check since ledger 123 — the SUBSET carve-out that tolerated `entity-panel.tsx` was DELETED with the fold that made it unnecessary — so a fourth copy ANYWHERE, including one re-added to `entity-panel.tsx`, REDs it with its path named. MEASURED: reverting that fold to the byte-identical inline literal REDs this pin alone (1 of 26 in the two suites run together) |
| **REGRESSION GUARD — every pre-existing verbatim pin passes UNCHANGED**, including the ones this brief named: `module-board-rewrite.test.tsx:296` (the toast tuple, with the real `ModuleBusyError` object), `blocked-reasons.test.tsx:84`, `spine-checkpoint.test.tsx:87`, `generate-everything.test.tsx:648`/`:657`, `blocked-control.test.tsx:89` | those five files plus `lib/toast.test.ts` — NO pre-existing test file was edited by this slice (13 tests in the three run together, 34 in the other three) | ✅ byte-unchanged and green before and after |
| **REVERT-PROVEN, the 11 injections, each restored byte-identically (`git hash-object` before and after), 9 RED of 11:** `MODULE_BUSY_TOAST_TITLE` reworded **REDs 2** (the constants pin + the board toast pin); `MODULE_GENERATING_REASON` reworded **REDs 3** (`blocked-reasons` + `spine-checkpoint` + the constants pin); `toastModuleBusy`'s body → a different title **REDs 2** (the board toast pin + the toast pin); the seam's suppression branch deleted **REDs 2**; `MODULE_BUSY_ERROR_NAME` mismatched **REDs 2**; the constant re-duplicated in `boardNodes.tsx` **REDs 1**; the same in `spine-checkpoint.tsx` **REDs 1**; the `ChatSidebar:169` / a `CanvasPage` chat site / the `BoardPage:197` call site reverted to the inline literal **REDs 2 each**; the title reworded against every blocked-control suite **REDs 0** (see below) | as listed | ✅ 9 RED of 11 |
| **TWO INJECTIONS CAME BACK GREEN, AND EACH NAMES A LINE THE PINS DO NOT REACH.** (1) Reverting `BoardPage.tsx:197` to its inline literal leaves `module-board-rewrite.test.tsx` **GREEN**: that behavioural pin reaches the ARGS (title, error object) and never the ROUTE — byte-identical args pass whichever way the site is written — which is exactly why the source scan exists and why it says so in its own doc comment. By the same mechanism, re-duplicating a same-valued constant in `spine-checkpoint.tsx` leaves `spine-checkpoint.test.tsx` **GREEN**: a rendering pin verifies the SENTENCE, never the seam. (2) Rewording `MODULE_BUSY_TOAST_TITLE` leaves all four blocked-control suites **GREEN (35 tests)** — `blocked-reasons`, `spine-checkpoint`, `generate-everything`, `blocked-control` — which is the MEASUREMENT behind the §4 gotcha: the toast sentence and the control reason are consumed by disjoint surfaces, i.e. two audiences, not one string used twice (the mirror injection, rewording the REASON, REDs `blocked-reasons` + `spine-checkpoint` and leaves every toast pin green) | `features/module-board-rewrite.test.tsx`, `features/spine-checkpoint.test.tsx`, `features/blocked-reasons.test.tsx`, `features/generate-everything.test.tsx`, `features/blocked-control.test.tsx` | ✅ recorded, not implied |
| **UNPROVEN — stated, not implied:** the four `CanvasPage.tsx` catch sites and the two in `ChatSidebar.tsx` have NO behavioural pin anywhere in the repo, so the SOURCE SCAN is their only guard (a behaviour-driven pin would need a live canvas turn per site); the scan cannot see a copy COMPOSED at runtime (a template string reassembling the sentence — nothing in `src/` does that, and no guard was built); the name-based recognition in `lib/toast.ts` is an implicit cross-layer contract that the TYPE system does not enforce (it is pinned against the real class, so removing `this.name = 'ModuleBusyError'` in `moduleGen.ts` REDs the pin rather than silently re-leaking the uuid); `entity-panel.tsx:377`'s fourth copy was folded by ledger 123, so the sentence is stated in exactly one source file (asserted by equality); `chatChanges.ts:188`, `snapshotChat.ts:556` and `chatController.ts:374` meet the same condition as a NAMED OUTCOME with a longer, different sentence and were NOT measured for folding; and no live-provider or real-browser run was performed (every pin is jsdom with a mocked transport) | `docs/17 row 120`; `docs/18 §2.3/§4/§5` | stated |

### The one way to add an alias (docs/17 row 121, docs/18 §2.1/§4/§5)

"Add this name to an artifact's `aliases`, case-insensitively, without
duplicating" was hand-rolled SIX times (`runEngine.ts:5757`/`:5786`/`:6001`,
`moduleGen.ts:2232`, `stub-popover.tsx:175`, `ModuleReaderPage.tsx:281` at base
`276f41f`) and had drifted into THREE comparison rules, one of them untrimmed on
the stored side. Aliases are the pool `[[wiki links]]` resolve against, so the
drift was a dead link at one surface and a duplicated row at another. The rule is
now ONE pure seam (`src/domain/artifactAlias.ts`: `sameAliasName` +
`mergeAliasNames`) with ONE write path (`artifactRepo.addArtifactAliases`), the
six sites are folded onto it — plus `entity-batch.alignEntityName`'s comparison,
which asks the same question — and two sites that ask a DIFFERENT question are
named as boundaries rather than force-merged (`lib/wikilinks.ts` resolves a link;
`alias-editor.tsx` validates a keystroke). A seventh copy the audit missed
(`campaign-tree.tsx:313-317`) was recorded in docs/18 §5 by that slice and
FOLDED by ledger 123 — see §The two deferred folds and the busy message's own
sentence below, which carries its two behaviour changes, its pins and its
injections. Nothing in
this section loads the machine: every pin is a single bounded suite at
`CAMPAIGNER_TEST_WORKERS=2`, and the injections are text edits run one at a time.

| Surface | Covered by | State |
| --- | --- | --- |
| **The rule table: trim on both sides, case-insensitive, self-name is NOT an alias, no duplicate against the pool OR within one batch, same-reference no-op, stored spelling verbatim** | `domain/artifactAlias.test.ts` (`forgives surrounding whitespace and case on BOTH sides`, `never stores a duplicate — against the pool or within one batch`, `never treats the artifact’s OWN name as an alias (same comparison)`, `returns the SAME list (same reference) when nothing is added…`, `adds a genuinely new name, keeping the caller’s spelling verbatim`) | ✅ REVERT-PROVEN: untrimming the comparison REDs 3 of them; deleting the self-name rule REDs 2; dropping the within-batch dedupe REDs 1 |
| **The write path's row contract: one revision per real add, NOTHING AT ALL when the pool already answers (no revision, no `updatedAt` move), idempotent, concurrent calls merge, a missing row is LOUD** | `db/artifactRepo-alias.test.ts` (6 tests; the no-op pin asserts `currentRevision` AND `updatedAt` AND the revision COUNT are unmoved, because "no write" is the whole point of the seam's same-reference return) | ✅ REVERT-PROVEN: deleting the `aliases === current.aliases` early return REDs 2; hand-rolling the merge as an append REDs 2 more |
| **The `"Kael "` divergence is CLOSED — the reader and the merge now agree** (an existing alias spelled `"Kael the Bold "` already answers the name, so the reader no longer appends a duplicate) | `module-reader.test.tsx` (`does not duplicate an alias that differs only by surrounding whitespace — the reader and the merge AGREE`), driving the REAL reader: unresolved chip → stub popover → the editable Name field → "Use existing entity…" → QuickFind picker → the row write. It asserts both the count (exactly ONE alias answers the name) and that the stored pool EQUALS `mergeAliasNames(existing, [name], ownName)` | ✅ REVERT-PROVEN: reverting the fold REDs this pin (and the scan). MEASURED reachability, stated rather than implied: a chip click alone cannot reach it — the RESOLVER trims (so such a name resolves) and the reader's resolution pool (`useArtifacts` + library, `ModuleReaderPage.tsx:124`) is a SUPERSET of the picker's (`useScopedArtifacts('moduleView')`) — so the pin drives the popover's editable Name field, the one route that reaches `linkExisting` with a name the picked artifact already answers |
| **The prose-only redesign no longer writes the OLD name twice when the pool already carries it** (the old guard asked about the NEW name and appended the OLD one unconditionally) | `encounterRepopulate.test.ts` (`renames without writing the old name TWICE when the pool already carries it (docs/17 row 121)`) | ✅ REVERT-PROVEN: reverting `runEngine.ts:5757-5761` REDs this pin (and the scan) |
| **All EIGHT folded sites route through the seam** — a SOURCE SCAN, labelled as one: per folded file it counts the seam calls (`runEngine` 4 × `mergeAliasNames(` + 2 × `sameAliasName(`, `moduleGen`/`stub-popover`/`ModuleReaderPage` 1 × `addArtifactAliases(`, `entity-batch` 1 + 1, `campaign-tree` 1 + 1) and requires the seam call to be the ONLY alias-pool comparison left in the file | `features/alias-merge-seam.test.ts` (`routes the alias write in <file> through the seam`, one pin per folded file) | ✅ REVERT-PROVEN: reverting ANY of the seven folds REDs its route pin — a COUNT, not a lower bound, so reverting one of the three `runEngine` sites (they sat 15 lines apart with different shapes) fails with the file named |
| **The hand-rolled shapes exist in exactly the documented carve-outs and nowhere else** — the same SCAN, matching a re-stated pool comparison (`aliases.some/filter(…toLowerCase…)`, a bounded 200-character window so the multi-line copies are seen) and a hand-appended pool (`[...aliases, x]` / `[...artifact.aliases, x]`), with a non-vacuity check (the walk must see >200 `src/` files) and a rot check (each carve-out must STILL hold a copy) | `features/alias-merge-seam.test.ts` (`leaves the hand-rolled shapes in exactly the documented boundaries (and nowhere else)`) | ✅ The TWO carve-outs are `lib/wikilinks.ts` (RESOLVER) and `alias-editor.tsx` (FORM validation). `campaign-tree.tsx`'s carve-out was DELETED by ledger 123 together with the fold that made it unnecessary — a subset-shaped carve-out must not outlive its cause, or it silently licenses the shape it was excusing — and the file joined the counted `FOLDED` set instead. Injecting a hand-rolled comparator into any folded file REDs it; MEASURED for the campaign-tree fold: reverting it REDs this pin AND its route pin |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `editor-aliases.test.tsx` 5, `entity-batch.integration.test.tsx` 2, `module-post-generation.test.ts` 18, `module-reader.test.tsx` 29 (of its 30), `runEngine-refill.test.ts` 12, `encounterRepopulate.test.ts` 12 (of its 13), `encounterRun.test.ts` 34, `moduleGen.test.ts` 68, `campaign-tree-rename.test.tsx` 5 | those nine files, run one suite at a time | ✅ byte-unchanged and green. **NONE of them asserted the old divergent behaviour**, so no pin had to be edited or explained away |
| **REVERT-PROVEN, the 12 injections, each applied and restored byte-identically (`git hash-object` before and after, all seven baselines re-verified), 12 RED of 12** — 32 red test results in total | as listed in the table below | ✅ 12/12 |

| Injected line | Killed |
| --- | --- |
| `ModuleReaderPage.tsx` — the fold reverted to the untrimmed `some(...)` + `updateArtifact` | **RED 3** — the reader UI pin + the scan's offender list + its route count |
| `runEngine.ts:5757-5761` — the prose-only guard reverted | **RED 3** — the `TWICE` pin + the scan (offenders + route count 4 → 3) |
| `runEngine.ts:5786-5800` — the encounter refill reverted (both halves) | **RED 2, both scan** — 47 behavioural pins GREEN |
| `runEngine.ts:6001-6005` — the generate-persona refill reverted | **RED 2, both scan** — 12 behavioural pins GREEN |
| `moduleGen.ts:2232-2240` — reverted to the filter + append (import swapped back) | **RED 2, both scan** — 86 behavioural pins GREEN |
| `stub-popover.tsx:175-181` — reverted to `needsAlias` + `updateArtifact` | **RED 2, both scan** — 29 behavioural pins GREEN |
| `entity-batch.ts` — `alignEntityName`'s comparison reverted | **RED 2, both scan** — 2 behavioural pins GREEN |
| `artifactAlias.ts` — the comparison UNTRIMMED (`left.toLowerCase() === right.toLowerCase()`) | **RED 6** — 5 rule/write-path pins + the reader UI pin |
| `artifactAlias.ts` — the self-name rule (`if (sameAliasName(name, artifactName)) continue;`) DELETED | **RED 3** — 2 rule-table pins + the write path's self-name case |
| `artifactAlias.ts` — the within-batch dedupe dropped (`const current = merged ?? existing` → `existing`) | **RED 1** — the rule table's duplicate pin |
| `artifactRepo.ts` — the `aliases === current.aliases` no-op guard DELETED | **RED 2** — "writes NOTHING…" + "is idempotent across two calls" |
| `artifactRepo.ts` — the merge replaced by a hand-rolled `[...current.aliases, ...names]` (flaw detector, not a revert) | **RED 4** — both scan pins + the two write-path pins |
| **FIVE INJECTIONS CAME BACK GREEN BEHAVIOURALLY, AND THEY ARE THE MEASUREMENT BEHIND THE §4 GOTCHA.** Reverting the `runEngine` encounter-refill fold, the `runEngine` generate-persona fold, the `moduleGen` fold, the `stub-popover` fold or the `entity-batch` comparison leaves **176 behavioural pins GREEN** (47 + 12 + 86 + 29 + 2) with only the SCAN going red — a fold is byte-identical by construction, so behaviour cannot see it. The two folds that ARE behaviourally visible are the two that changed a rule (the reader's trim, the prose-only duplicate-append), and each has its own pin and its own RED | `features/alias-merge-seam.test.ts` + the five suites listed above | ✅ recorded, not implied |
| **A promised behaviour change that the code makes UNREACHABLE, measured rather than pinned:** "`moduleGen` stops writing an alias equal to the artifact's own name" cannot happen at HEAD — the pass records a variant only when `canonicalKey !== nameKey` (`moduleGen.ts:2221`, `if (canonicalKey === nameKey) continue;`) and finds the artifact BY that canonical key (`:2224`), so the variant is structurally guaranteed ≠ the artifact's own name under this very comparison. There is no behavioural pin to write; the self-name rule is DEFENCE there, pinned at the rule table and at the write path, and the moduleGen fold is byte-identical | `domain/artifactAlias.test.ts` `never treats the artifact’s OWN name as an alias`; `db/artifactRepo-alias.test.ts` `writes NOTHING when the pool already answers` | stated |
| **UNPROVEN — stated, not implied:** no live-provider and no real-browser run (every pin mocks the transport or drives jsdom); the scan is TEXTUAL and blind to a copy composed at runtime (nothing in `src/` does that); the `moduleGen` self-name skip is unreachable (above); the campaign-tree fold's own self-name rule (the NEW name passed as `artifactName`) is unreachable through the dialog — `handleRename` returns early when the trimmed name equals the old one, so only a case-differing rename could reach it, and no pin drives that (ledger 123); the two extra dedupe consequences (the prose-only duplicate-append and `moduleGen`'s within-batch dedupe) are proved REACHABLE by construction and by their pins, never observed in the owner's real campaign data; and the reader pin drives the popover's editable Name field because a chip click cannot reach that state | `docs/17 row 121`; `docs/18 §2.1/§4/§5` | stated |

### The two deferred folds and the busy message's own sentence (docs/17 row 123, docs/18 §2.1/§2.3/§5)

Three earlier slices each found a piece of debt and each said out loud why it was
not paying it that day: the alias-merge landing found a SEVENTH copy the audit had
missed (`campaign-tree.tsx`'s rename-keep-alias path) and reported it rather than
smuggle a third behaviour change; the busy-message landing found a FOURTH copy of
the blocked-control sentence inside a file a concurrent writer owned and left it
byte-identical; and that same landing stopped `ModuleBusyError`'s uuid reaching a
toast by suppressing the description BY NAME while recording the better fix —
reword the message itself — as a follow-up. Ledger 123 pays all three, one commit
each. Nothing in this section loads the machine: every pin is a single bounded
suite at `CAMPAIGNER_TEST_WORKERS=2`, one at a time, and every injection is a text
edit applied and restored byte-identically (`git hash-object` before and after,
every hash matched).

**One of the three is a real behaviour change, and the other two are folds.** The
campaign-tree piece is the one behaviour CAN see: `sameAliasName` trims both sides
where the dialog compared untrimmed, so a pool alias that differs from the old name
only by surrounding whitespace no longer gets that name written TWICE, and an alias
that spells the NEW name with different surrounding whitespace is absorbed instead
of left behind. The other two pieces unroll NO behavioural pin when reverted —
that is the shape of a fold, measured three times in two days now — so each carries
a SOURCE SCAN, and each scan was TIGHTENED in the same commit as the fold: a
`BOUNDARIES` carve-out deleted and a SUBSET assertion turned into an EQUALITY,
because an allowance that exists only because something was not folded must not
outlive the fold.

| Surface | Covered by | State |
| --- | --- | --- |
| **The seventh copy's two behaviour changes**: the old name is never written TWICE for a pool that already spells it under different whitespace, and an alias that spells the NEW name under different whitespace is absorbed | `features/campaign-tree-rename.test.tsx` (`does not write the old name TWICE when the pool already spells it with surrounding whitespace`, `absorbs an alias that spells the new name with surrounding whitespace`) — real Dexie rows, the rename dialog driven through the campaign tree | ✅ REVERT-PROVEN: reverting the whole fold REDs both (`expected [ 'Old Tower ', 'Old Tower' ] to deeply equal [ 'Old Tower ' ]` / `expected [ 'tower ruins ', 'Old Tower' ] to deeply equal [ 'Old Tower' ]`) and leaves the 5 pre-existing rename pins GREEN |
| **The scan is STRICT about that file now** — the `BOUNDARIES` carve-out is deleted and `campaign-tree.tsx` sits in the counted `FOLDED` set (1 × `mergeAliasNames(`, 1 × `sameAliasName(`) | `features/alias-merge-seam.test.ts` (`leaves the hand-rolled shapes in exactly the documented boundaries (and nowhere else)`, `routes the alias write in features/campaign/components/campaign-tree.tsx through the seam`) | ✅ REVERT-PROVEN: reverting the fold REDs BOTH (`expected [ Array(1) ] to deeply equal []` and `mergeAliasNames( call sites: expected +0 to be 1`) while the five other suites' pins stay green. The carve-out was SUBSET-shaped while it existed, as the landing notes said, and the fold leaves the scan GREEN — the proof the brief asked for, taken by reverting the fold and watching the scan go red |
| **The blocked-control sentence is stated in exactly ONE source file, by EQUALITY** (the SUBSET check and `KNOWN_REMAINING_COPY` are deleted with the fold) | `features/module-busy.test.ts` (`leaves the blocked-control sentence in exactly ONE source file`) | ✅ REVERT-PROVEN: `entity-panel.tsx` reverted to the byte-identical inline literal REDs this pin ALONE (`expected [ …(2) ] to deeply equal [ 'features/modules/module-busy.ts' ]`) with all 19 `generate-everything.test.tsx` pins GREEN — the rule-4 lesson measured again, on a fold whose copy is byte-identical by construction |
| **The panel's own title/reason pin reaches that executing line** — the fold is invisible to behaviour, the VALUE is not | `generate-everything.test.tsx` (`is disabled with the REASON while the module is generating`: the `title` AND the associated reason node) | ✅ REVERT-PROVEN the other way round: changing that one line to a DIFFERENT sentence REDs the pin and leaves the SCAN green. The copy detector and the value detector fail on different edits, which is why both exist |
| **`ModuleBusyError`'s message is a sentence with no row id, ON THE REAL REFUSAL PATH** — the shared registry's second claim (`llm/canvasBusy`), never a hand-built error, and the id asserted structurally (`moduleId`) | `features/module-busy.test.ts` (`states a sentence for the owner, and carries the row id structurally`; the expected sentence is an independent copy in the test) | ✅ REVERT-PROVEN: reverting the reword REDs it (`expected 'Module module-3f2e-91ab-4c77 is alrea…' to be 'This module is already generating — w…'`) and it is the ONLY failure — 1 of 8 |
| **The toast seam's name-matched suppression still works, and its pin now passes for the NAME rather than for the text** | `features/module-busy.test.ts` (both `toastModuleBusy` pins, against the REAL class) + `lib/toast.test.ts` (`passes plain-Error descriptions through byte-identical`, so the seam is not dropping descriptions for everything) | ✅ REVERT-PROVEN: reverting the REWORD leaves BOTH suppression pins GREEN (the proof the brief asked for) while REDing only the new message pin; mismatching `this.name` (`'BusyRefusal'`) REDs all three; deleting the seam's suppression branch REDs both suppression pins |
| **The row id rides STRUCTURALLY and the compiler enforces it** — `readonly moduleId`, with no reader in `src/` today | `pnpm typecheck` (`tsc -b`) | ✅ REVERT-PROVEN: removing the field and its assignment is a LOUD `TS6133: 'moduleId' is declared but its value is never read` plus two `TS2339` in the pin — it cannot be dropped silently, and the field is what replaced the id in the message |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `campaign-tree-rename` 5 → 7, `alias-merge-seam` 7 → 8, `module-busy` 7 → 8, `generate-everything` 19, plus the eleven suites that construct or assert the class (`modulePlan`, `canvasChat`, `canvasRefine`, `moduleGen`, `canvasChatChanges`, `canvas-chat-changes`, `change-artifact`, `module-board-rewrite`, `moduleGen-floor-repair`, `lib/toast`, `module-busy` — 241 tests together) | those files, one bounded run at a time | ✅ green before and after. **ONE pre-existing ASSERTION was edited, and it is named rather than glossed:** `module-busy`'s suppression pin proved its non-vacuity by asserting `busyError.message` CONTAINS the uuid — the reword makes that false by construction, so the pin now asserts the class NAME and the message contract moved into the new pin. **Two pre-existing pins assert the old text as a SUBSTRING and were REPORTED rather than edited:** `modulePlan.test.ts:263` (`.rejects.toThrow(/already generating/i)`) and `canvasChatChanges.test.ts:779` (`.toContain('already generating')`, the chat-card relay path). The reworded sentence deliberately still says the module "is already generating", so both remain true statements and both stay green |
| **UNPROVEN — stated, not implied:** (1) the chat-card surfaces of the reword are established by READING the write sites (`chatController.ts:359` + `:374`, whose own comment states the contract, and `snapshotChat.ts:541`; `canvasChat.ts:2176` → `:2391` for the change-block relay) — no pin renders a busy refusal onto a chat card end to end, so the owner-visible effect there is proved by the code path, not by a screenshot; (2) both text scans are blind to a copy COMPOSED at runtime (a template string reassembling either sentence), the limit rows 120/121 already recorded; (3) the campaign-tree fold's self-name rule (the NEW name passed as `artifactName`) is UNREACHABLE through the dialog — `handleRename` returns early when the trimmed name equals the old one, so only a case-differing rename could reach it, and no pin drives that; (4) the structural `moduleId` has no reader in `src/` today, so only the pin and `tsc` hold it; (5) no live-provider or real-browser run was performed | `docs/17 row 123`; `docs/18 §2.1/§2.3/§4/§5` | stated |

| Injected line | Killed |
| --- | --- |
| `campaign-tree.tsx` — the WHOLE fold reverted to the hand-rolled `some(...)` + `[...target.aliases, target.name]` + `filter(...toLowerCase()...)` | **RED 4** — the offender scan + the counted route pin + BOTH new behavioural pins; the 5 pre-existing rename pins stay green |
| `campaign-tree.tsx` — only the `kept` filter untrimmed (`!sameAliasName(alias, name)` → `alias.toLowerCase() !== name.toLowerCase()`) | **RED 3** — both scan pins + `absorbs an alias that spells the new name with surrounding whitespace`. **GREEN: the "written TWICE" pin**, which is held by the merge call and not by the filter — each half of the fold has its own detector, and the filter's line is reached by only one of them |
| `campaign-tree.tsx` — the `artifactName` argument wrong (`mergeAliasNames(kept, [target.name], target.name)`) | **RED 3, all BEHAVIOURAL** — the two pre-existing rename pins + the `absorbs…` pin (`expected [] to include 'Old Tower'`), with the scan GREEN: the identity of that argument is held by behaviour, not by any scan |
| `entity-panel.tsx` — the fold reverted to the byte-identical inline literal | **RED 1, the scan only** — all 19 `generate-everything` pins GREEN |
| `entity-panel.tsx` — that one line changed to a DIFFERENT sentence (`'The module is busy right now — try again later.'`) | **RED 1** — `is disabled with the REASON while the module is generating`; the scan GREEN |
| `moduleGen.ts` — the reword reverted to ``Module ${moduleId} is already generating`` | **RED 1 of 8** — the new message pin. **GREEN: both suppression pins**, which is the proof that they pass for the NAME and not for the text |
| `moduleGen.ts` — `this.name` mismatched (`'BusyRefusal'`) | **RED 3** — both suppression pins + the class-name assertion |
| `moduleGen.ts` — the structural `moduleId` field and its assignment removed | **RED at `tsc -b`** — `TS6133` (unused ctor parameter) + two `TS2339` in the pin: a typecheck failure, not a test failure, which is the loudest form this one can take |

### The page-hide flush's retry: a test that triggers a fire-and-forget chain OWNS it (docs/17 row 122, docs/18 §4)

The dispatcher found `pnpm lint && pnpm typecheck && vitest run` exiting **1**
while reporting **288 files / 3324 tests green** plus an `Unhandled Errors`
block — `Unhandled Rejection: ReferenceError: window is not defined`, at
`getCurrentEventPriority ← requestUpdateLane ← dispatchSetState ←
src/features/campaign/components/artifact-editor.tsx:251`, originating in
`tests/features/editor-page-flush.test.tsx`. No test failed, because nothing was
wrong with the app: a fire-and-forget flush settled after jsdom was gone. The
pin below is the fix, and it is a TEST-side fix — `src/lib/pageFlush.ts` has no
behaviour change (its contract gained item 4, VOID-RETURNING, in the doc
comment).

**REPRODUCED DETERMINISTICALLY FIRST (the `89e5d71` method, not suite
repetition).** Instrumenting `globalThis.window` with an accessor that RECORDS
the reader reproduced the dispatcher's stack verbatim, in one isolated run of
the target file: the reader was React's `getCurrentEventPriority`, reached from
`dispatchSetState` at `artifact-editor.tsx:251` — the SUCCESS line
`setSaveState('saved')`, not the `setSaveState('error')` the brief suspected.
A second probe (one write deferred by a macrotask, the test ending before it
settled) produced the same unhandled rejection. **MEASURED mechanism:** the
page-hide flush fails against the pin's refusing stub, so `lastSavedRef` does
not move and `saveDraft`'s pending gate stays OPEN; the editor's registration
effect cleanup is `unregister(); flushPendingEdits();`, so the UNMOUNT flush
`cleanup()` runs re-issues the same draft — and vitest runs a FILE's `afterEach`
BEFORE `tests/setup.ts`'s, so the pin's `finally { restore() }` has already put
the REAL writer back. The retry therefore hits real Dexie, settles after
teardown, and its continuation dispatches into a dead React. A probe logging the
seam, the repository and both Dexie tables showed that unmount write arriving
ONCE, from `cleanup()`, after every write the test body itself had awaited.
**NOT (a):** the write never failed in that pin; **it is (c)** (the environment
tearing down mid-write), conditioned on **(b)** (a deferred promise chain
settling after the test finished).

| Surface | Covered by | State |
| --- | --- | --- |
| A failing page-hide write still reaches the owner (`Autosave failed`), writes no row and fires no revision — the pin's existing assertions, unchanged | `editor-page-flush.test` | ✅ byte-unchanged |
| **The retry a FAILED flush leaves queued is SETTLED INSIDE THE TEST**: after the refusal is lifted, the same seam is dispatched again and the revision row reaches 2 within `AUTOSAVE_DELAY_MS + 1000` — the WAIT is what the pin enforces (removing it reds the pin immediately), and `countWrites` is kept as the wrong-reason GUARD against the 800 ms debounce being the cause | `editor-page-flush.test` (`reports a failing write on the page-hide flush too`) | ✅ REVERT-PROVEN (the WAIT: injection I1, 1 red). The retry BLOCK as a whole is not revert-proven IN-FILE — deleting it leaves the file green while re-opening the defect, which is exactly how it reached the full-suite gate; the probe measures it instead (the `updateArtifact` call arrives from `cleanup()`, after the file's `afterEach`) |
| Because the retry LANDS, `lastSavedRef` moves and the gate CLOSES — so the unmount flush `cleanup()` runs is a no-op: no write, no `setState`, nothing left to settle after the environment is gone | `editor-page-flush.test` (the same pin's final assertions: `body === 'Doomed edit'`, `revisionCount === 2`, and the suite's green count unchanged) | ✅ |
| The seam cannot receive a rejecting promise TODAY: all FOUR registrations were MEASURED to return `undefined` (an instrumented seam printed every `flush()` return value across the editor's suite and produced nothing) | the probe measurement recorded in docs/17 row 122 | ✅ measured — and NOT type-enforced: an `async () => {}` argument typechecks clean against `PageFlush` (measured: `tsc --noEmit` on a probe file, exit 0), so the void return is a convention, not a guarantee. No runtime guard exists |

**NON-VACUITY (REVERT-PROVEN lines — each injection applied, the killed pins
named, then restored byte-identically and verified with `git hash-object` before
and after).** `tests/features/editor-page-flush.test.tsx` was
`d406239e4565c9437da9ecd5aeb04710dd25199b` at every restore (verified with
`git hash-object` before and after each injection; the comment above the retry
block was tightened after the injections, so the hash recorded here is the
committed one).

| Injected line | Killed |
| --- | --- |
| The retry block DELETED (back to the pre-fix pin's shape: refused write, toast asserted, assertions after `restore()`, test over) | **0 in-file** — this is the honest result and it is the reason the defect reached a full-suite gate: the pin passes while leaving the unmount retry in flight, and the failure surfaces only as an `Unhandled Errors` block, in ANOTHER run, under teardown timing that a single file does not reproduce. Proved instead by the probe: with the retry removed, the unmount flush's `updateArtifact` call arrives from `cleanup()` AFTER the file's own `afterEach` and after every awaited write — i.e. in flight when the environment goes away |
| The retry's WAIT removed (the second `flushPageHide()` dispatched, then asserted immediately) | **1** — the same pin, at `expected '' to be 'Doomed edit'`: without the wait the write has not settled, which is the whole point of the pin |
| The retry's `countWrites` instrument removed (the wait and the landed-row assertions kept) | **0 — GREEN, and it names a line the pin does not reach.** The write-issued assertion is a GUARD against the 800 ms debounce being the cause of the landed row, not the pin's subject; the landed row is what proves the write settled. Kept because a row that lands for the wrong reason is exactly the failure mode this file's history is made of, but reported as a guard rather than as REVERT-PROVEN coverage |
| The retry's `flushPageHide()` dispatch removed (the wait and the counter kept) | **0 — GREEN, and this one is the interesting one**: with the component still mounted, the 800 ms debounce ALSO lands the write inside the pin's wait bound, so the PIN's own pin — "nothing is in flight at teardown" — is what the test enforces, and the dispatch is the direct trigger rather than the only possible one. The pre-fix tree had neither: no wait, no dispatch, and `cleanup()`'s unmount retry re-issued the write after the file's `afterEach` had restored the real writer. That is why the fix is the WAIT (settling what the test starts), and the dispatch is kept because it reaches the retry through the seam the defect lives on |

**UNPROVEN here too.** No frequency is claimed: the race is timing-dependent by
construction, the dispatcher saw it, the probes reproduce it on demand, and two
FULL pre-fix suite runs on this box came back green (`288/288`, `3324/3324`,
exit 0) — so "how rare" is unknown. A future writer that registers a `Promise`-returning
flush could still leak a rejection the seam cannot see — and that needs no cast:
MEASURED, an `async () => {}` argument is accepted against `PageFlush` with no
diagnostic (`tsc --noEmit`, exit 0), so the compiler does not stand in the way.
No runtime guard was built, because a detector would be a second production
mechanism serving a test-only race; the seam's doc comment names the gap. And the other three writers were audited by
READING their gates (the board nulls `persistTimer` before writing; the draft
writer's page-hide half returns early unless `timerRef.current !== null`), not by
injection — only the editor's flush was driven red.


### A negative DOM assertion on TRANSIENT UI is a flake, not a pin (docs/17 row 124, docs/18 §4)

**The sighting.** A full gate came back `exit 1` with **3345 of 3346 tests
passing**: `FAIL |jsdom| tests/rules-page.test.tsx > rules screen > states why
the import/embed controls are held: the page-wide import, the per-book embed,
the delete icon and both menu items` — `Error: expect(element).not.toBeInTheDocument()`,
`found <div class="z-50 …" data-slot="tooltip-content" data-instant="delay"
data-open="" data-side="bottom">`. A second identical run was green
(3346/3346), and NOTHING about the assertion was wrong: it is a race.

**WHICH tooltip, and WHO opened it (measured, not guessed).** The element was
the reason POPUP of **the very control under assertion** — `…-blocked-reason`
for the same book id, `data-open` (open, not closing) — and
`document.activeElement` was that control's own wrapper,
`SPAN[retry-book-<id>-blocked]` / `SPAN[embed-book-<id>-blocked]`. So it was NOT
a leftover from an earlier test (jsdom `cleanup()` unmounts between tests), NOT
the test's own pointer (the helper's `hover` had not run yet), and NOT the app
rendering a permanent node: **the APP opened it on its own, by putting FOCUS on
the held control.** A Base UI menu places focus on the held item's wrapper as it
opens (`useFocusableWhenDisabled` — the `aria-disabled` item is not natively
focusable, the wrapper's `tabIndex=0` is the tab stop), and `BlockedControl`
opens the reason on focus **by design** (docs/05 §Why a control cannot act), so
one extra async turn is the whole difference between the old synchronous
`not.toBeInTheDocument()` passing and failing. An event trace of the blocking
window (`pointerover`/`focusin`/`pointerdown` in capture phase + a
`MutationObserver` on `body`) showed the `focusin` landing on the wrapper ~2ms
after the assertion ran in a green run, and before it in a red one.

**Is the pin's MEANING right? Yes — this is a test-side race, not an app
finding.** The reason is delivered through `BlockedControl` (the one documented
device), never through a `title` on the disabled control that Chrome would not
show; the wrapper is the trigger, focusable, `aria-describedby`-associated with
the hidden sentence. Nothing in the app had to change — and the burst of "fix the
app" was not taken, because the app's behaviour here is the documented intent.

**Both edges of the popup are the framework's own transitions.** Base UI mounts
the popup while the tooltip is open and removes it when the exit animation
finishes: `internals/useAnimationsFinished` waits one `requestAnimationFrame`
(`frame.request(exec)`) and a microtask, then `flushSync(forceUnmount)` — jsdom
takes exactly that path, because `tests/setup.ts` stubs `Element.getAnimations`
to `[]`. Measured consequence: a popup can also be present-but-CLOSED
(`…-blocked-reason:closed` seen in the document at the NEXT control's assertion)
while its exit frame is still pending.

**REPRODUCED DETERMINISTICALLY by DELAYING THE CAUSE (the `89e5d71` method),
never by loading the box** — one file, `CAMPAIGNER_TEST_WORKERS=2`, one run at a
time:

- pre-fix tree, as-is: **green 10 runs of 10** in isolation (a bare repetition
  never finds this; the full-suite timing is what the dispatcher's gate caught);
- pre-fix tree with **ONE macrotask injected at the exact site** (the helper's
  step immediately before the absence assertion): **RED 3 runs of 3**, with the
  popup of the control under assertion open and `activeElement` = its
  `…-blocked` wrapper;
- pre-fix tree with that delay expressed in-tree as `settleAppFocus()`
  (`flushAsyncUpdates`, the suite's own drain seam) and the fix REVERTED:
  **RED 2 runs of 2** — the same `not.toBeInTheDocument()` signature the
  dispatcher saw, `data-open=""`, `data-slot="tooltip-content"`;
- pre-fix tree with the fix AND that in-tree probe removed: **GREEN 3 runs of
  3** — the measurement that makes the delayed cause the *only* honest proof
  here.

**The fix, ONE seam** (`tests/helpers/blocked-reason.ts → dismissOpenPopup`, so
all nine files that pin a reason go through it): (1) `flushAsyncUpdates()` so
what the app has already scheduled has landed; (2) hand back the two triggers
the app can have used — `user.unhover(trigger)` and
`document.activeElement.blur()`; (3) `await waitFor(() => expect(popup).not.toBeInTheDocument())`.
Step 3 is an await of a REAL transition (not a sleep, not a retry), and it is
also the half that keeps the pin honest: a popup that cannot leave fails LOUDLY
on the timeout instead of the pin passing on a wrapper that opens nothing. The
in-tree `settleAppFocus()` probe stays for the same reason — with the fix
reverted it is what makes the failure deterministic instead of a coin flip.

**REVERT-PROVEN lines** (each injection applied, printed with `grep -n`,
`git diff --stat` checked, then restored **byte-identically** — `git hash-object`
verified identical before and after every one):

| injection | line it hits | result |
|---|---|---|
| `await dismissOpenPopup(...)` → the pre-fix synchronous `expect(...).not.toBeInTheDocument()` | `blocked-reason.ts:91` (inside `assertReason`, the executing path) | **RED 2/2**, the dispatcher's exact signature |
| the drain `await flushAsyncUpdates()` removed from `dismissOpenPopup` | `blocked-reason.ts` step 1 | **GREEN** (10 files, 69+7 tests) — named below |
| the `blur()` removed (drain kept) | `blocked-reason.ts` step 2 | **RED** — the app-opened popup can then never leave |
| the awaited `waitFor(...)` → a synchronous assertion (drain + blur kept) | `blocked-reason.ts` step 3 | **RED** — the exit frame has not run yet |
| an ALWAYS-RENDERED `data-testid="…-blocked-reason"` node injected into `src/components/blocked-control.tsx:93` | the app, not the test | **RED**, and it names the node — the guard still has teeth |

**The GREEN one, named rather than dressed as coverage:** removing the helper's
internal drain leaves every current pin green (`tests/rules-page.test.tsx` 7/7,
plus 9 helper-consumer files, 69/69), because the two call sites where the app's
focus is actually pending pre-drain in-tree (`settleAppFocus`). The line is kept
as step 1 of the seam because it is what makes steps 2–3 deterministic at ANY
call site — without it the dismissal is a race with the app's pending focus, and
every caller would have to remember to drain first (AGENTS rule 4).

**UNPROVEN.** (1) No real-browser measurement: jsdom has no layout and no
hit-testing, so that the popup paints over the control is still pinned as a DOM
contract only (ledger row 98's honest limit, unchanged). (2) The exact scheduler
that places the menu's focus (a `setTimeout(0)` task, measured only as "one
macrotask is enough" — the injected `setTimeout(…, 1)` flipped the tree 3/3) was
not traced into Base UI's internals. (3) Which of the four menu items Base UI
chooses to focus was not determined — only that the held item's wrapper is what
receives it, in both menus where a held item exists. (4) The internal drain has
no failing pin of its own (the green injection above).


### A reason is never stated in a `title` beside its wrapper (docs/17 row 125, docs/18 §2.3/§4)

Seven controls in `src/` stated why they were held in a `title` on the disabled
child of a `BlockedControl` — a surface no browser renders for a natively
`disabled` control and no keyboard reaches. The wrapper already delivers the
reason (hover and focus, plus the `aria-describedby` hidden node), so the
`title` was pure loss and a second place for the sentence to drift: one of the
seven wrote the wrapper's own sentence out again 17 lines away, and one carried
a comment blessing the duplication. Five were named by the audit that opened
this slice; re-verification found two more (`generate-everything`,
`encounter-repopulate`).

**What the pins are.** `tests/features/blocked-control-title-scan.test.ts` is a
labelled SOURCE scan (it reads `src/**` as text and renders nothing). Its
violation list is asserted by EQUALITY against a two-entry known list, so a
sixth offender reds it and fixing a named one reds it too. Two rules catch the
two shapes the defect took: `shape` (a bare identifier or a `??`, where which
half is visible depends on the state and the reason is the invisible one) and
`branch` (a title literal that is also in the wrapper's `reason`). A title that
is only a DESCRIPTION, gated on the control being able to act, is explicitly not
a violation — three surfaces keep theirs that way, and each is pinned in both
directions (byte-identical while live, absent while held). Plus a coverage pin:
the scanner reaches all six named wrappers, and exactly five wrappers in `src/`
carry ANY title — a new one is a deliberate act.

**REVERT-PROVEN, every injection applied, printed back with `grep -n`,
`git diff --stat` checked BEFORE the run, and restored byte-identically
(`git hash-object` identical before and after, all six files touched):**

| injection | line it hits | result |
|---|---|---|
| I1 the canvas-save `title` restored | `CanvasPage.tsx:1710`, the save button | **RED 3** — both scan pins + the module-canvas Save pin |
| I2 the batch `title={batchGateReason}` restored | `entity-panel.tsx:929` | **RED 3** — both scan pins + the batch-gate pin |
| I3 the classify title's REASON branch restored | `entity-panel.tsx:953` | **RED 2** — the scan's `branch` rule + the classify pin |
| I4 the Fix control's `title` back to `derivedBlocked ?? '…'` | `CanvasPage.tsx:1546` | **RED 2** — the scan + its held-state pin |
| I5 the same for Resume | `CanvasPage.tsx:1570` | **RED 2** — the scan + its held-state pin |
| I6 the reason SENTENCE's value changed | `entity-panel.tsx:297` (the `const`) | **RED 1** — the classify pin; scan **GREEN** |
| I7 `module.status === 'generating'` dropped from the gate | `entity-panel.tsx:294` | **RED 1** — the pin's `toBeDisabled()` half |
| I8 the description made UNGATED | `entity-panel.tsx:951` | **RED 1** — the held-state `not.toHaveAttribute('title')`; scan **GREEN** |
| I9 a known-list entry disturbed | `blocked-control-title-scan.test.ts:58` | **RED 1** — the equality assertion |
| I10 the classify DESCRIPTION deleted | `entity-panel.tsx` (the title block) | **RED 2** — the scan's population pin + the live-description pin |
| I12 the Save reason's sentence changed | `CanvasPage.tsx:2271` | **RED 1** — `module-canvas.test` |
| I13 the batch gate reason's sentence changed | `entity-panel.tsx:282` | **RED 2** — `entity-classify-new.test` + `entity-panel.test` |

**The GREEN ones, named rather than dressed as coverage.** (a) The FIRST run of
I3 left the scan **GREEN**: the `branch` rule compares literals against the
`reason={…}` expression, and a reason collapsed into a body `const` puts its
sentence OUTSIDE the span — so a title restating a collapsed reason read as
clean. The scan now resolves a bare-identifier `reason` one level to its `const`
declaration; the re-run of I3 is the RED 2 above. The line the pins did not
reach was the scan's own `reason` resolution, and the measurement is why it
exists. (b) I11 un-collapsing the classify reason (inline ternary, byte-identical
arms, the `const` deleted) → **3 files, 40/40 GREEN**: a FOLD of this kind is
byte-identical by construction and has no behavioural detector — what the pins
reach is the title duplication, not the collapse (the same shape row 123
measured). (c) Under **I2**, `entity-panel.test.tsx` (28 tests) stayed GREEN: no
pin there reads the batch child's `title`; only the scan and the classify file's
batch-gate pin do. (d) Under **I4** the Fix control's LIVE-description pin stayed
GREEN — with the control live, `derivedBlocked ?? '…'` and
`fixBlocked ? undefined : '…'` produce the SAME string, so only the held-state
pin and the scan reach the gating. (e) Under **I6** and **I8** the scan stayed
GREEN: a changed VALUE and an ungated description are not restatements — that
boundary is held by behaviour, not by the scan.

**What the scan cannot do.** It reads `src/**` as text, so a sentence COMPOSED at
runtime is invisible to it, and `reason` identifiers are resolved only ONE level
(a reason named through a second alias is invisible to the `branch` rule); the
`title="…"` literal form is compared by the `branch` rule only. No real-browser
run: jsdom has no rendering, so "Chrome draws no tooltip for a `title` on a
natively disabled control" stays the documented premise, and what is measured
here is that the attribute is GONE. The paragraph above describes the state
ledger 125 LEFT BEHIND — its equality list and the two sites it named are gone
in the section below (docs/17 row 127).


### The two `title` sites the audit missed, cured — and the scan loses its allowance (docs/17 row 127, docs/18 §2.3/§4)

Ledger 125 folded five of the seven wrappers whose disabled child restated the
wrapper's `reason` in a `title`, and deliberately left two of them —
`entity-panel`'s `generate-everything` and `artifact-editor`'s
`encounter-repopulate` — because two pre-existing assertions pinned the very
title to be removed (`generate-everything.test.tsx:646` asserted
`toHaveAttribute('title', <the reason>)`; `:676` asserted that the title contains
`'fix the text first'`). Both sites are folded here and the two-entry
`KNOWN_RESTATED_TITLES` allowance went with them, because an allowance must not
outlive its cause (the lesson rows 123/125 recorded): the scan's violation list
is now asserted to be **EMPTY** against the whole of `src/**`, and the population
of titles inside wrappers is STILL asserted by EQUALITY — so a restated title
reds the scan, and a description quietly disappearing reds it too (measured:
injection I8).

**Per-site decisions, with the text.**

- **`generate-everything`** — `title={generateAllBlocked ?? '<description>'}`
  becomes `title={generateAllHeld ? undefined : '<description>'}`. The FIRST half
  was the wrapper's own `reason` (whose expression is
  `reason={generatingAll ? null : generateAllBlocked}`), so it is REMOVED; the
  description survives BYTE-IDENTICAL and is now gated on the SAME boolean as the
  child's `disabled` (`const generateAllHeld = generateAllBlocked !== null`) —
  one gate expression read twice, AGENTS rule 4, the shape row 125 gave
  `classifyBlocked` and CanvasPage's two gates. Nothing is reworded, moved or
  dropped, and the phrase `'fix the text first'` was never title-only copy: it is
  part of `generateAllBlockedReason()`'s failed-status sentence, and the pin now
  asserts that sentence on the REASON through `expectBlockedReason` (byte-exact,
  therefore stronger than the `toContain` it replaces).
- **`encounter-repopulate`** — `title={repopulateBlocked ? '<the reason
  sentence>' : complex ? '…' : '…'}` becomes
  `title={repopulateHeld ? undefined : complex ? '…' : '…'}`. The roomless-complex
  sentence is REMOVED from the title — it is the wrapper's `reason` verbatim —
  and the two descriptions survive byte-identical. The comment that blessed the
  duplication by name (*"its own sentence, already in the `title`"*) now states
  the rule instead. ONE behaviour change beyond the literal brief, reported
  rather than smuggled: the gate is the FULL held expression
  (`const repopulateHeld = running !== null || repopulateBlocked`), not
  `repopulateBlocked` alone, because before this change the OTHER action's run
  held the control while the child still advertised its description — a `title`
  on a control that cannot act, exactly the defect this arc removes. That state
  carries no description now, and it is pinned (I5 reds when the gate is narrowed
  back, which no other pin in the repo reaches).

**Matrix rows.**

| Surface | Covered by | State |
|---|---|---|
| `generate-everything`: the generating-module reason stated through the device (hidden node + `aria-describedby` + tab stop + the settled popup) with NO `title` while held, and the description byte-identical while LIVE | `generate-everything.test` (2 rewritten pins + 1 live assertion in the work-count pin) | ✅ |
| Repopulate: the roomless-complex reason through the device with NO `title` while held, the description byte-identical on a STOCKED complex and on a single, and NO description while the other action's run holds it | `editor-surfaces.test` (+2), `change-artifact-ui.test` (+1) | ✅ |
| The scan is STRICT: the violation list is EMPTY and the title population by EQUALITY (a title leaving the list reds it as loudly as a new one) | `blocked-control-title-scan.test` (2) | ✅ |

**REVERT-PROVEN, every injection applied to the committed tree, the injected
line printed back with `grep -n`, `git diff --stat` checked BEFORE the run, and
restored byte-identically (`git hash-object` identical before and after, both
files):**

| injection | line it hits | result |
|---|---|---|
| I1 the reason half of the `generate-everything` title restored (`title={generateAllBlocked ?? '<description>'}`) | `entity-panel.tsx:861` | **RED 3** — the scan's `shape` rule + both held-state pins |
| I2 the roomless-complex branch restored in the Repopulate title | `artifact-editor.tsx:755` | **RED 2** — the scan's `branch` rule (the rule that first went blind, row 125's I3) + the held-state pin |
| I4 the description gate INVERTED (`generateAllHeld ? '<description>' : undefined`) | `entity-panel.tsx:861` | **RED 3** — the LIVE-description pin + both held-state pins |
| I5 the Repopulate description gate NARROWED back to `repopulateBlocked` | `artifact-editor.tsx:755` | **RED 1** — the `running === 'everything'` held pin (the only pin that reaches it) |
| I6 the Repopulate description VALUE changed (`'…rooms, layout and map kept'` → `'…layout and map kept'`) | `artifact-editor.tsx:758` | **RED 1** — the live-description pin; scan **GREEN** |
| I7 the one gate expression hardwired (`const generateAllHeld = false`) | `entity-panel.tsx:428` | **RED 2** — both held-state pins |
| I8 the `generate-everything` `title` attribute DELETED outright | `entity-panel.tsx:860-864` | **RED 2** — the scan's title-population equality + the live-description pin |
| I3 a LITERAL restatement of the failed-run reason injected into the held branch of that title | `entity-panel.tsx:862` | scan **GREEN** — the measured blindness below; the two held-state pins RED |

**The GREEN one, named rather than dressed as coverage.** I3 is the scan's own
eyesight measured: the `branch` rule compares LITERALS, and the entity-panel
reason reaches the wrapper through a FUNCTION CALL (`generateAllBlockedReason()`)
whose sentences are therefore nowhere inside the `reason={…}` span — so a title
quoting that sentence verbatim read as clean (2/2 GREEN) while the two
behavioural pins RED. The scan's `shape` rule still guards that control, and it
is the shape this control's defect actually took (I1 reds); closing the gap would
need a scanner that parses ternaries and function bodies, which is not worth its
complexity here. This is row 125's lesson one level deeper — a sentence that
moves outside the span is invisible to a literal comparison — and it is recorded
in docs/18 §4 rather than papered over. (The two other boundaries row 125
measured reproduce here: I6 proves a changed VALUE is behaviour's business, not
the scan's, and both sites' descriptions stay byte-identical.)

**Carried forward, with the pins that reach them.** (1) `images-ui.test.tsx:313`
still describes the roomless-complex reason as asked for *"not only in a `title`"*
— the reason is asserted there through the device and still passes, but its
comment is stale now that the control carries no `title`; it was left untouched
on purpose (that file belongs to the concurrent image slice's neighbourhood and
nothing false is asserted, only narrated). (2) No real-browser run: what is
measured is that the attribute is gone, never what Chrome would have drawn
(row 98's honest limit). (3) The scan's textual limit above (I3).


### The one way to generate ONE image (docs/17 row 126, docs/18 §2.2/§4)

"Assemble the prompt contract → `generateImages(prompt, 1, …)` → refuse an empty
result → EXIF-safe intake" stood in FOUR files byte for byte
(`cover-image-queue.ts:94-103`, `entity-image-queue.ts:87-96`,
`mob-portrait-queue.ts:351-360`, `mob-portrait-cache-queue.ts:197-207` at base
`d6b54fa`), each copy carrying the same explanatory comment, and the refusal
sentence was a literal four times over. **MEASURED, and the reason this is a
slice rather than a tidy-up: `grep -rn 'the image API returned no image'
tests/` found NO pin at all** — the branch that keeps an empty API answer from
becoming a blank cover or portrait was asserted by nothing, in any copy. The
tail is now ONE seam, `src/llm/oneImage.ts → generateOneImage(prompt, { model,
signal })` (contract assembly + n=1 + refusal + intake, returning
`GeneratedOneImage` = the intake result plus the assembled prompt and the
escalation-aware `modelUsed`), and the four sites are one seam call plus their
own storage question. The candidate-count paths (`runEngine.ts:5336` n=2 + pick,
`:4705` `unattended ? 1 : 2`) and the vision-map step (`:4491`: raw
`buildLabeledMapPrompt`, `{ role: 'map' }` intake, reached through
`encounterRunAdapters`) are named boundaries in docs/18 §2.2/§4, not oversights.
Nothing here loads the machine: every pin is a single bounded run at
`CAMPAIGNER_TEST_WORKERS=2`, one at a time, and the injections are text edits.

| Surface | Covered by | State |
| --- | --- | --- |
| **The seam's happy path**: the contract is assembled FROM THE DRAFT, the API is asked for exactly ONE image with the caller's model and signal, the intake receives the API's own blob OBJECT, and the result is exactly the six-field shape every writer spreads | `tests/llm/oneImage-seam.test.ts` (`assembles the prompt contract, asks for exactly ONE image and intakes the returned blob`) | ✅ REVERT-PROVEN: skipping the assembly → RED 1 of 9; `1` → `2` → RED 1; dropping `signal` → RED 1; `generated.modelUsed` → `options.model` → RED 1; un-assembled returned `prompt` → RED 1; zeroed returned `width` → RED 1 |
| **The seam's empty-result refusal, with its message NAMED** — the pin the audit found missing, and the one that stands between an empty API answer and a silently blank cover/portrait | `tests/llm/oneImage-seam.test.ts` (`refuses an empty result LOUDLY, naming the message the four hand-rolled copies each carried`; the thrown `message` is compared for EQUALITY to the literal and to `NO_IMAGE_FROM_API_MESSAGE`, and the intake is asserted NOT called) | ✅ REVERT-PROVEN: DELETING the guard (and casting the blob to satisfy TS) → RED 1 of 9, this pin; rewording the sentence → RED 2 (this pin + the one-holder scan). The refusal is DEFENCE at the seam — `imageGen.ts:237-239` already throws when zero candidates come back — and it is pinned so a future refactor cannot turn it into a blank row |
| **The seam propagates API failures unchanged** (no error handling of its own, no catch-and-continue — AGENTS 1) | `tests/llm/oneImage-seam.test.ts` (`propagates the API failure unchanged`) | ✅ asserted by IDENTITY (`rejects.toBe(failure)`), so a re-wrap fails |
| **A pin that asserts a Blob argument BY VALUE is vacant — MEASURED:** `intakeImage(new Blob(['other']))` left **all 9 pins GREEN**, because two Blobs of different bytes compare deep-equal in vitest (no own enumerable properties). The seam's intake pin now asserts REFERENCE IDENTITY (`expect(intakeImageMock.mock.calls[0]?.[0]).toBe(raw)`, `expect(result.blob).toBe(stored)`) as well as `toHaveBeenCalledWith` | `tests/llm/oneImage-seam.test.ts` (the happy path's two identity assertions); docs/18 §4 | ✅ REVERT-PROVEN **as a hole found BY injection**: before the identity assertions the injection was GREEN 9/9; after them the same injection is RED 1 of 9 |
| **All four folded sites route through the seam** — a SOURCE SCAN, labelled as a scan in its name, counting `generateOneImage(` = 1 per file and requiring `generateImages(`, `intakeImage(`, `assembleImagePrompt(` and the refusal literal to be GONE from each | `tests/llm/oneImage-seam.test.ts` (`scan: routes the one-image tail in <file> through the seam`, one pin per folded file) | ✅ REVERT-PROVEN: reverting ANY of the four folds (restored byte-identically from `HEAD`, `git diff --stat` empty while injected) REDs its route pin — a COUNT, not a lower bound |
| **The hand-rolled shape exists in exactly the documented boundaries and nowhere else** — the same SCAN: a file calling BOTH `generateImages(` and `intakeImage(` must be `llm/runEngine.ts` (the map paths + the adapter indirection) or `llm/oneImage.ts` (the seam itself), with a >200-file non-vacuity check and an allowlist-rot check | `tests/llm/oneImage-seam.test.ts` (`scan: leaves the hand-rolled generate-plus-intake shape in exactly the documented boundaries (and nowhere else)`) | ✅ the rot half is REVERT-PROVEN by renaming the seam's own intake call → RED (the boundary set shrinks to `['llm/runEngine.ts']`) |
| **The refusal sentence is stated in exactly ONE source file** (the seam) — a SCAN, so a fifth wording cannot appear beside it | `tests/llm/oneImage-seam.test.ts` (`scan: states the empty-result sentence in exactly ONE source file, and the seam reads it from there`) | ✅ REVERT-PROVEN: the four wholesale fold reverts each RED it (holders `[llm/oneImage.ts, <reverted file>]`); a reword REDs it (holders `[]`) |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `tests/features/cover-image-queue.test.ts` 11, `tests/features/entity-image-queue.test.ts` 6, `tests/features/mob-portrait-queue.test.ts` 19, `tests/features/mob-portrait-regen.test.ts` 8, `tests/db/mob-portrait-cache.test.ts` 16 | those five files, run one suite at a time | ✅ byte-unchanged and green (60 tests). **NONE of them asserted the fold's shape** — which is the measured point below: they stay green under every one of the four fold reverts |
| **ONE pre-existing assertion DID have to change, and the full gate is what caught it**: `tests/llm/imageTextGuard.test.ts:401` is a fail-closed REGISTRY of every file calling `generateImages(` (so a prompt bypassing the text-render guard fails loudly). The fold legitimately changes its membership — the four queues leave, `llm/oneImage.ts` joins — and the registry's own comment instructs exactly that ("then extend this list"). The pin's MEANING is unchanged; its list is. The sibling registry in the same file (`buildImagePrompt(` call sites) passes UNCHANGED | `tests/llm/imageTextGuard.test.ts` (the one edited list + a comment naming ledger 126) | ✅ reported rather than re-run until green: the failure is deterministic and is a direct consequence of the fold, not a flake (failed 1 of 3359 on the first full-gate run, with the exact membership diff printed) |

**REVERT-PROVEN lines** (each injection applied, printed back with `grep -n`,
diffed against a byte-exact baseline copy, then restored and verified with
`git hash-object` — every baseline hash matched before and after):

| injection | line it hits | result |
|---|---|---|
| `assembleImagePrompt(prompt)` → `prompt.prompt` | `oneImage.ts:93` (the executing line; the seam's own verified line number, not a filter) | **RED 1/9** — the happy path's assembled-prompt assertion |
| the n=1 argument `1` → `2` | `oneImage.ts:94` | **RED 1/9** |
| `signal: options.signal` deleted from the API call | `oneImage.ts:96` | **RED 1/9** |
| the returned `model: generated.modelUsed` → `options.model` | `oneImage.ts:111` | **RED 1/9** |
| the empty-result guard DELETED (`intakeImage(blob as Blob)`) | `oneImage.ts:103` — the guard's own line | **RED 1/9**, the refusal pin |
| the refusal sentence reworded (`…returned nothing`) | `oneImage.ts:55` | **RED 2/9** — the refusal pin + the one-holder scan |
| the returned `prompt: finalPrompt` → `prompt.prompt` | `oneImage.ts:110` | **RED 1/9** |
| the returned `width: intake.width` → `0` | `oneImage.ts:108` | **RED 1/9** |
| the seam's own `intakeImage(blob)` renamed (`intakeImageRenamed`) | `oneImage.ts:104` | **RED 2/9** — the happy path + the allowlist-rot half (`expected [ 'llm/runEngine.ts' ] to deeply equal [ 'llm/oneImage.ts', 'llm/runEngine.ts' ]`) |
| `intakeImage(blob)` → `intakeImage(new Blob(['other'], …))` | `oneImage.ts:104` | **GREEN 9/9 first** — the Blob-equality hole, named above; **RED 1/9** after the identity assertions were added and the injection re-run |
| **the fold reverted WHOLE, one file at a time** (`git show HEAD:<file>`, byte-identical to the base commit) | `cover-image-queue.ts:94-103`, `entity-image-queue.ts:87-96`, `mob-portrait-queue.ts:351-360`, `mob-portrait-cache-queue.ts:197-207` | **RED 3/9 each** (offender scan + that file's route pin + the sentence-holder scan) and **GREEN: 11 / 6 / 27 / 16 pre-existing behavioural pins — 60 in total** |

### The fold is invisible to behaviour — which is why the scan exists

Measured four times, not assumed: reverting each folded tail to its
byte-identical pre-fold block leaves every behavioural pin in the repo GREEN (60
of them across the five suites above) while only the source scan goes red. A
byte-identical fold cannot be detected by behaviour — the seam and the four
copies produce the same calls with the same arguments — so no behavioural pin
can hold this fold, and the scan's name says "scan" so the next reader knows
which instrument is doing the work. The same lesson bit twice in this slice: the
refusal's own pin had to be WRITTEN (nothing pinned it in four copies), and the
intake pin's first form was vacant until an injection proved it (Blob deep
equality, above).

**UNPROVEN.** (1) No live-provider and no real-browser run: every pin mocks
`generateImages` and `intakeImage` at the module boundary, so what is proved is
the WIRING — the seam's integration with the real client (transport, escalation,
EXIF decode) is unchanged and untested here. (2) The empty-result refusal is
unreachable through the real client today (`imageGen.ts:237-239` throws first);
it is pinned as defence, and no pin drives the real client into that state.
(3) The scan is TEXTUAL: it cannot see a copy composed at runtime, and its
needles are call-shaped, so a COMMENT mentioning `generateImages(` in a folded
file would trip it (none does today). (4) The returned `mimeType` and `height`
were not individually injected — they are lines of the same object literal as
the injected `width`, reached by the same `toEqual` assertion. (5)
`runEngine.ts:4491`'s map sentence was deliberately NOT made to adopt the seam's
message; the reasoning (adapter indirection + the consequence it names) lives in
docs/18 §2.2/§4 and ledger 126, and no pin covers that decision either way.

### The one way to say why a run did not finish (docs/17 row 128, docs/18 §2.2/§4/§5)

"This run did not finish, and here is why" was composed FOUR times in THREE
shapes: `run.errorMessage || \`run ended ${run.status}\`` twice in ONE function
(`encounter-map-queue.ts:155` and `:161` at base `d3b8b65`, byte-identical to
each other), the same fact folded into `entity-batch.ts:544-552`'s
`failed.push({ name, message })` (`` `run ended ${outcome.status}` `` when
`errorMessage === ''`), and a DIFFERENT composition in
`encounterRegen.ts:92-96` (`awaitCompletedRun`): `` `${label} ended
${run.status}${run.errorMessage === '' ? '' : `: ${run.errorMessage}`}` `` — a
leg label plus the engine's message as a colon-SUFFIXED detail, where the other
three use the message AS the sentence. So the engine's own authored sentence was
a whole sentence in two places and a detail in a third, and the fallback was
written three ways. The seam is
`runEngine.runNotCompletedReason(run, label = 'run')` (in `src/llm/runEngine.ts`,
beside `isRunWithdrawn` — the file that owns a run's state vocabulary): the
engine's `errorMessage` when it wrote one, `` `${label} ended ${run.status}` ``
otherwise. The three plain sites fold; **`awaitCompletedRun` is the one
documented boundary** (docs/18 §5) and keeps its own leg-labelled sentence,
because the label names WHICH LEG of a chained operation died — a fact the
engine's sentence cannot carry (both legs brief under the same step name) — and
the engine already toasts its own sentence on that path. The withdrawal
PREDICATE is untouched everywhere (`isRunWithdrawn`, ledger 117): this slice
folds the SENTENCE and never the verdict.

| Surface | Covered by | State |
| --- | --- | --- |
| **The seam's own rule table**: an engine-written `errorMessage` IS the sentence (verbatim, no label, no status); an empty one yields the caller's label with `run` as the default; a `'cancelled'` row still HAS a sentence (the seam is not the predicate) | `tests/llm/runNotCompletedReason.test.ts` (3 pins, over real `createPersonaRun` rows — never a cast stub) | ✅ REVERT-PROVEN: making the seam ignore `errorMessage` → RED 1 of 7; defaulting the label to `'the run'` → RED 2 of 7 |
| **The map queue's reason, verbatim at the owner's toast**: the job's own failure carries `Could not generate a map for "<name>"` plus the engine's sentence, compared for EQUALITY against the run row's own `errorMessage` (with a non-empty assertion FIRST, so it cannot pass by both sides being empty) | `tests/features/encounter-map-queue.test.ts` (`the contrast: a run that FAILED on its own …`, extended) | ✅ REVERT-PROVEN: the seam always-fallback injection → RED this pin; reverting the fold itself → GREEN (byte-identical, below) |
| **The map queue's FALLBACK branch**, which no engine path can reach any more (`fail` always composes a message): a hand-written terminal row with `errorMessage: ''` still makes the job fail loudly with `run ended failed` | `tests/features/encounter-map-queue.test.ts` (`a terminal run that carries NO sentence of its own still says why`) — a real job, a real row, `updateRun` as the terminal write | ✅ REVERT-PROVEN: defaulting the label → RED this pin |
| **A batch entity's reason, verbatim** — the engine's sentence alone, and `run ended failed` when the engine wrote nothing | `tests/features/entity-batch-fixed-cast.test.ts` (2 new pins; the engine is faked there but `runNotCompletedReason` is imported from `importOriginal`, so the fold is judged REAL) | ✅ REVERT-PROVEN: defaulting the label → RED the fallback pin; the seam always-fallback → RED the verbatim pin; dropping the export from that file's mock factory → RED both (the pins that reach the line) |
| **The silence still holds at both touched sites** (ledger 117's cure, never re-broken by a reason sentence): a `'cancelled'` row produces NO failure entry and NO toast — at the queue (3 pre-existing pins) and at the batch (1 new pin + the pre-existing integration pin) | `tests/features/encounter-map-queue.test.ts` (856/880/900), `tests/features/entity-batch-fixed-cast.test.ts` (new), `tests/features/stop-orchestration.test.ts:298` | ✅ REVERT-PROVEN **by neutralising the PREDICATE, not the sentence**: disabling the batch's `isRunWithdrawn` arm → RED 2 (the new batch pin + `stop-orchestration`); disabling the queue's → RED 3, including the row-117 silence pin |
| **`awaitCompletedRun`'s boundary, BOTH branches**: `Repopulate ended failed: <the engine's own sentence>` (the label, the status, then the message as a detail) and `Repopulate ended cancelled` (a stopped leg is still REPORTED here — the documented non-silence) | `tests/llm/encounterRepopulate.test.ts` (2 new pins; the first compares against the run row's REAL `errorMessage` so nothing is asserted about a guessed string) | ✅ REVERT-PROVEN: dropping the `: <message>` suffix → RED the failed-leg pin + the scan's boundary pin |
| **The fallback formula is composed in exactly TWO files** — the seam and that one boundary — and the folded files compose NO reason of their own; the queue has exactly 2 seam calls and the batch exactly 1 (a COUNT, so reopening ONE copy is visible) | `tests/llm/runNotCompletedReason.test.ts` (`scan: …`, 4 pins, labelled as scans, with a >200-file non-vacuity check and an allowlist-rot check) | ✅ REVERT-PROVEN: reverting EITHER fold REDs 2 scan pins while every behavioural pin stays green (below) |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `tests/features/encounter-map-queue.test.ts` 17 (incl. all three row-117 silence pins), `tests/features/stop-orchestration.test.ts`, `tests/llm/encounterRepopulate.test.ts` 13, `tests/features/entity-batch-fixed-cast.test.ts` 2, `tests/features/change-artifact-instruction.test.ts`, `tests/llm/moduleGen-cast.test.ts` | those six files, one suite at a time at `CAMPAIGNER_TEST_WORKERS=2` | ✅ byte-unchanged and green — **and NOT ONE of them asserted the fold's shape**, which is why the scan exists (below) |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n`, `git diff --stat` checked BEFORE the run, then
restored from a byte-exact baseline copy and verified with `git hash-object` —
all seven baseline hashes matched before and after; one suite at a time at
`CAMPAIGNER_TEST_WORKERS=2`):

| injection | line it hits | result |
|---|---|---|
| the queue's died-on-its-own throw reverted to `run.errorMessage \|\| \`run ended ${run.status}\`` | `encounter-map-queue.ts:165` | **GREEN: 18/18 queue pins** — a byte-identical fold is invisible to behaviour — and **RED 2 scan pins** (the route count `1 ≠ 2` and the fallback-holders equality) |
| the batch's reason reverted to the hand-rolled ternary | `entity-batch.ts:554` (the composition line; the block is `:552-556`) | **GREEN: 3/3 batch pins** (incl. both new sentence pins) and **RED 2 scan pins** |
| the seam's rule changed to ALWAYS return the fallback | `runEngine.ts:427` | **RED 4** — the rule table, the queue's verbatim pin, the batch's verbatim pin, the scan's value pin |
| the seam made to adopt the boundary's shape (`${label} ended ${status}: ${message}`) | `runEngine.ts:427` | **RED 4**, the same four — so a future "unification" onto the label-suffix shape cannot land silently |
| the default label `'run'` → `'the run'` | `runEngine.ts:426` | **RED 4** — both sites' fallback pins + 2 rule-table pins |
| `runNotCompletedReason` REMOVED from the batch's partial mock factory | `entity-batch-fixed-cast.test.ts:38` | **RED 2** — exactly the two pins that reach the reason line (the withdrawal pin stays green: the predicate answers first) |
| the same export REMOVED from the other two partial factories | `moduleGen-cast.test.ts:73`, `change-artifact-instruction.test.ts:39` | **GREEN 25/25** — those two files only ever fake `'completed'` runs, so their entries are a latent-trap guard, NOT coverage. Named here rather than dressed as a pin |
| the batch's `isRunWithdrawn` arm neutralised (`status === 'cancelled' && errorMessage !== ''`) | `entity-batch.ts:505` | **RED 2** — the new withdrawal pin + `stop-orchestration.test.ts`'s pre-existing integration pin |
| the queue's `isRunWithdrawn(run)` arm neutralised the same way | `encounter-map-queue.ts:149` | **RED 3** — including ledger 117's own silence pin (`a run the OWNER cancelled under a watching job is not a queue failure`) |
| the boundary's `: <message>` suffix dropped | `encounterRegen.ts:124` | **RED 2** — the failed-leg pin + the scan's boundary pin |
| **the withdrawn arm's LABEL changed to a bogus one** (`runNotCompletedReason(run, 'bogus-withdrawn-label')`) | `encounter-map-queue.ts:155` | **GREEN 25/25** — the line the pins do not reach, and cannot: the withdrawn throw exists to STOP the body, its sentence is never reported (the silence is the `ctx.withdraw()` + the predicate), so no behavioural pin can see it. The fold there is held by the scan's COUNT alone |

### The encounter-map offer and the encounter-map work walk ONE rule (docs/17 row 129, docs/18 §2.3/§4)

The entity sidebar's "Generate N encounter maps" button counted the module's
map gaps with an INLINE copy of the filter
`features/modules/post-generation.encountersNeedingMaps` already exported —
character-identical (`artifact.kind === 'encounter' &&
artifact.moduleId === module.id && (artifact.data.layout === null ||
artifact.data.mapImageId === null)`), and the seam already returned the
`{id, name}` pair the panel's job payload built by hand. The panel now calls the
seam; `post-generation.ts`, `encounter-map-queue.ts`, `automation-deviation.ts`
and `src/lib/jobQueue.ts` are untouched. Two decisions were made and both are
written down: the fold itself, and the REFUSAL to fold
`isEncounterMapPending` into the offer (it reads the queue's store, so it would
give the pure sweep and the deviation a global mutable dependency, and a
re-offered encounter is dropped anyway by the enqueue dedupe against
queued + active — the count can over-advertise but cannot double-book).

| Surface | Covered by | State |
| --- | --- | --- |
| **The panel's map count and payload**: four candidate rows — neither half of the gap, a LAYOUT with no image (still work), both halves (not work), and a gap owned by ANOTHER module (not this panel's work) — the label reads `Generate 2 encounter maps` and the enqueue carries exactly those two artifact ids | `tests/features/entity-panel.test.tsx` (`counts the map gaps by the sweep’s own rule, and enqueues exactly those`, NEW) | ✅ REVERT-PROVEN: weakening the seam's rule (`moduleId === module.id` dropped) → RED this pin alone (1 of 29) with the scan GREEN |
| **The ROUTING** — the panel's map list comes from the offer seam and from nothing else, and the gap disjunction is composed in exactly the offer seam and the queue's per-artifact guard | `tests/features/encounter-map-offer-scan.test.ts` (`scan: …`, 2 pins, labelled as scans, with a >200-file non-vacuity check and both rules pinned as values) | ✅ REVERT-PROVEN: reverting the fold WHOLE → RED both scan pins while 29/29 behavioural pins stay GREEN (below) |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `tests/features/entity-panel.test.tsx` 28 pre-existing pins (incl. the `Generate 1 encounter map` pin), `tests/features/automation-deviation.test.ts` 11, `tests/features/module-resume-automation.test.ts` 9 | those three files, one suite at a time at `CAMPAIGNER_TEST_WORKERS=2` | ✅ green — and NOT ONE of them asserted the fold's shape or the panel's number, which is why the scan and the new count pin exist |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n`, `git diff --stat` checked BEFORE the run, then
restored from a byte-exact baseline copy and verified with `git hash-object` —
`entity-panel.tsx` `5f9865dc56a589e4b030916b94f3b756b2cbecfb` and
`post-generation.ts` `a1c972f5746a307b2efce366bc555074bd3633cc` before and
after, both matched; one suite at a time at `CAMPAIGNER_TEST_WORKERS=2`):

| injection | line it hits | result |
|---|---|---|
| **the fold reverted WHOLE** (`git show HEAD:src/features/modules/entity-panel.tsx`) | `entity-panel.tsx:307-312` back, seam call gone | **GREEN: 29/29 `entity-panel` pins** — a byte-identical fold is invisible to behaviour — and **RED 2/2 scan pins** (disjunction holders `[3] vs [2]`, seam calls `+0 ≠ 1`) |
| the seam's rule weakened (`artifact.moduleId === module.id` deleted from `encountersNeedingMaps`) | `post-generation.ts:168` | **RED 1/29** — exactly the new count pin — and **GREEN 2/2 scan pins** |
| a truthiness-shaped copy added beside the seam (`!a.data.layout || !a.data.mapImageId`) | `entity-panel.tsx:324` | **GREEN 29/29 behaviour**, disjunction pin **GREEN**, the `mapImageId` FIELD needle **RED 1/2** |
| **a copy that borrows the queue's own guard** (`artifacts.filter((a) => a.kind === 'encounter' && a.moduleId === module.id && encounterNeedsMap(a))`) | `entity-panel.tsx:325` | **GREEN 2/2 FIRST — every needle missed it** (the shape the scan was not designed for). After the fourth needle (`encounterNeedsMap(` banned in the panel) was added: **RED 1/2**, naming that needle |
| the DECLINED pending filter folded into the emitter line (`.filter((e) => !isEncounterMapPending(module.id, e.id))`) | `entity-panel.tsx:323` | **GREEN 29/29 behaviour** and **RED 1/2 scan** on the pinned emitter VALUE line — the decision is test-visible, not behaviour-held |

**The scan's own limits, MEASURED (docs/18 §4).** The disjunction needle cannot
see the question asked in another shape (a truthiness test), and the two FIELD
needles are what cover that. A copy that arrives through a NAMED predicate
evaded all three needles (injection 4) and needed a fourth. What is still
invisible: a copy that arrives through a FUNCTION CALL in another module which
itself calls `encounterNeedsMap`, and any comment in the panel naming that guard
WITH a call parenthesis (the needle set is comment-blind — this seam's comments
name it without one).

### The one way to build a filename stem (docs/17 row 130, docs/18 §2.3/§4)

"Turn this title into a URL-safe filename stem" was hand-rolled FOUR times —
`lib/exportImport.ts`'s `sanitize`, `lib/pdfExport.ts`'s `pdfFileName`,
`features/campaign/components/export-single-artifact.ts`'s `artifactSlug` and
`features/modules/module-pdf-button.tsx`'s `modulePdfFileName` — the first three
character-identical apart from their names and the fourth differing only in its
fallback (`'module'` where the others said `'artifact'`). They now all call
`lib/fileSlug.fileSlug(name, fallback)`, and every caller passes its fallback
EXPLICITLY so every emitted filename is byte-identical. The SUFFIX stays with
the caller and the two PDF naming ROLES are deliberately NOT merged
(`gm-notes`/`handout` is a TEMPLATE name; `gm`/`player` is an avatar-audience
word). The grep that bounded the work: the `[^a-z0-9]+` → `-` idiom plus the
`^-+|-+$` trim exists at exactly those four sites and nowhere else in `src/`
(`domain/creatureName` maps the same class to a SPACE, `llm/strictSchema` uses a
different alphabet for a schema name, `lib/backup.backupFileName` has no slug).

| Surface | Covered by | State |
| --- | --- | --- |
| **The seam's own rule**: case folding, every punctuation RUN collapsing to ONE dash, leading/trailing dashes trimmed, the ASCII alphabet (a letter outside it can VANISH — `Æther` → `ther`), and the fallback when the input reduces to nothing (default `artifact`) | `tests/lib/fileSlug.test.ts` (2 pins) | ✅ REVERT-PROVEN: deleting `.toLowerCase()` from the seam → RED 3 of this file's value pins plus 5 more in `pdfExport`/`module-pdf-export` |
| **Every caller's emitted filename**: the artifact PDF pair (`grimm-gm-notes.pdf` / `grimm-handout.pdf`), the pre-built export name under a frozen clock (`the-drowned-vault-2026-03-04.json`, `ash-gate-part-2-…zip`, `artifact-2026-03-04.json`), the single-artifact save name (byte-exact, not the old regex) and its FALLBACK (`artifact-<date>.json` — never pinned before), the zip entry (`artifacts/npc/grimm-<id8>.json` and `artifacts/note/artifact-<id8>.json`), and the module PDF pair (`the-drowned-vault-gm.pdf` / `-player.pdf`, pre-existing pins, unchanged) | `tests/lib/fileSlug.test.ts` (2 pins), `tests/lib/exportImport.test.ts` (+1 test, 2 pins tightened from `toContain`/prefix), `tests/features/export-dialog-save-picker.test.tsx` (+1 test, 1 pin tightened from a regex), `tests/features/module-pdf-export.test.tsx` (2 pre-existing pins) | ✅ REVERT-PROVEN: changing ONE caller's fallback (`'artifact'` → `'module'`) → RED exactly the new fallback pin (1 of 8) with the slug suite GREEN — the fallback VALUE is behavioural coverage, not a scan |
| **The ROUTING** — both halves of the idiom live in exactly the seam, every caller's stem comes from it with its own fallback spelled out, no caller names the slug alphabet, and the two PDF suffix roles stay distinct | `tests/lib/fileSlug.test.ts` (`scan: …`, 5 pins, labelled as scans, with a >200-file non-vacuity check and the seam's signature pinned as a value) | ✅ REVERT-PROVEN: reverting all four folds at once → RED 5 scan pins while **66 behavioural pins stay GREEN** (below) |
| **REGRESSION GUARD — every pre-existing pin passes UNCHANGED**: `tests/lib/pdfExport.test.ts` 9 (incl. `grimm-gm-notes.pdf`), `tests/features/module-pdf-export.test.tsx` 6 (incl. `the-drowned-vault-gm.pdf`), `tests/lib/exportImport.test.ts`, `tests/features/export-dialog-save-picker.test.tsx`, `tests/features/export-dialog.test.tsx` | those files, one suite at a time at `CAMPAIGNER_TEST_WORKERS=2` | ✅ green — and NONE of them asserted the fold's shape, which is why the scan exists |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n`, `git diff --stat` checked BEFORE the run, then
restored from a byte-exact baseline copy and verified with `git hash-object` —
`fileSlug.ts` `edf64838294ca612ac1edec39a3664badb6cba1c`,
`exportImport.ts` `5207e0f487d19c9347c3daeb228205cce0b2a56f`,
`pdfExport.ts` `610e7dd435e5dea0593cff1d6dba1d9696f00a85`,
`export-single-artifact.ts` `4b6a341dce32b6256891a4ad944f569697bbcaa3`,
`module-pdf-button.tsx` `3f3aa46ccec80d718ee71079066f91d1fe25a760` — all five
matched after restore; one suite at a time at `CAMPAIGNER_TEST_WORKERS=2`):

| injection | line it hits | result |
|---|---|---|
| **all four folds reverted at once** to their hand-rolled copies | the four call sites | **GREEN: 66 behavioural pins** (5 + 38 + 8 + 9 + 6) — a byte-identical fold is invisible to behaviour — and **RED 5/10 scan pins** (both idiom-holder equalities `[5] vs ['lib/fileSlug.ts']`, and every caller's count `+0 ≠ 3/1/1/1`) |
| the seam's rule changed (`.toLowerCase()` deleted) | `fileSlug.ts:25` | **RED 8 across three files** (`fileSlug` 3, `pdfExport` 3, `module-pdf-export` 2) with every SCAN pin **GREEN** |
| ONE caller's fallback changed (`'artifact'` → `'module'`) | `export-single-artifact.ts:22` | **RED 1/8** — exactly the new fallback pin — slug suite **GREEN 10/10** |
| **an equivalent spelling** (`split(/[^a-z0-9]+/).filter(Boolean).join('-') \|\| 'artifact'`) REPLACING the call | `export-single-artifact.ts:22` | **RED 1/10 on the seam-call COUNT alone**; BOTH idiom needles **GREEN (blind)**, behaviour **GREEN 8/8** |
| the same copy ADDED beside a surviving seam call (count unchanged) | `export-single-artifact.ts:21` | **RED 1/10 on the ALPHABET needle** (`must not name the slug alphabet itself`), behaviour **GREEN 8/8** — the needle added in this commit for exactly this shape |

**The scan's own limits, MEASURED (docs/18 §4).** The idiom needles quote a
SPELLING, so an equivalent spelling evades them (injection 4a: only the
per-caller count red). Adding the copy beside a surviving call evades the count
too, which is what the alphabet needle is for (4b). Still invisible: a spelling
that names a DIFFERENT class for the same alphabet (`[^A-Za-z0-9]`, `\W`), and a
hand-rolled slug in a NEW caller — the needle list is per-caller, so a fifth
caller inherits nothing.

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
uses at most TWO workers, and the config is the bound: `vite.config.ts`
defaults `maxWorkers` to `DEFAULT_TEST_WORKERS` (2, ledger row 94) in the file
AND in each `test.projects` entry, so a bare `pnpm exec vitest run` cannot
exceed it and a CLI `--maxWorkers=N` cannot raise or lower it (it lands on the
root config, which each project's own value overrides).
`CAMPAIGNER_TEST_WORKERS=<n> pnpm exec vitest run` is the one explicit way to
raise it for a run that owns the machine, and a mis-set value fails loudly
rather than silently defaulting. The default test timeout is 20 seconds.
`b84d074` had raised the old worker count from four to six (the suite is
file-parallel and was leaving half the machine idle); row 94 superseded that
with the bound above, after a bare unbounded run twice outlived its writer —
and because jsdom plus PDF/image workers otherwise starve event loops on
constrained CI/agent VMs.
