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
`boardNodes.tsx:117` — a fourth copy survives inline in `entity-panel.tsx:377`,
carved out in §5), plus `ModuleBusyError`'s own uuid-bearing message
(`src/llm/moduleGen.ts:123`) reaching the owner as the toast's DESCRIPTION. The
copy now has ONE seam (`src/features/modules/module-busy.ts`); the two sentences
stay two because they answer two questions for two audiences, and the busy GATE
is untouched (`llm/canvasBusy` + `lib/generationLocks` remain two documented
authorities). Nothing in this section loads the machine: every pin is a single
bounded suite, and the injections are text edits, run one at a time.

| Surface | Covered by | State |
| --- | --- | --- |
| **The two sentences are byte-identical to the literals they replaced, and are deliberately NOT the same string** (a refused ACTION vs a blocked CONTROL) | `features/module-busy.test.ts` (`are byte-identical to the literals the fold replaced`, `stay two DIFFERENT sentences`) — the expected strings are independent copies written in the test, not imported from the module under test | ✅ REVERT-PROVEN: mutating `MODULE_BUSY_TOAST_TITLE` REDs the first pin; mutating `MODULE_GENERATING_REASON` REDs it as well (the distinctness pin still passes, correctly — the point is that a collapse would RED it) |
| **The helper's user-visible outcome: the shared title, and NO uuid-bearing description** — pinned through the REAL toast seam with the REAL error class (`sonner` mocked, `@/lib/toast` NOT mocked) | `features/module-busy.test.ts` (`toasts the shared title, WITHOUT the uuid-bearing error message as the detail line`, `drops the uuid for a directly-toasted busy refusal too`) | ✅ REVERT-PROVEN: deleting the seam's suppression branch REDs both; mismatching `MODULE_BUSY_ERROR_NAME` in `lib/toast.ts` REDs both. The pin is non-vacuous by construction — it asserts `busyError.message` CONTAINS the id first, so the seam has something to leak |
| **All SEVEN folded catch sites route through the helper** — a SOURCE SCAN, and labelled as one: it counts `instanceof ModuleBusyError` branches per file (2 / 4 / 1 / 0 / 0) and requires `toastModuleBusy(` inside each branch | `features/module-busy.test.ts` (`routes every folded busy catch site through toastModuleBusy (SOURCE SCAN)`) | ✅ REVERT-PROVEN: reverting `ChatSidebar.tsx:169`, a `CanvasPage.tsx` chat site, or `BoardPage.tsx:197` to the inline literal REDs it (with the one-source-file pin). A COUNT rather than a lower bound, so a NEW unrouted busy site fails with the file named |
| **The three private constants are gone; their readers import the shared one, and the toast sentence lives in exactly ONE source file** | `features/module-busy.test.ts` (`leaves the toast sentence in exactly ONE source file`, `leaves the blocked-control sentence only in the fold plus the documented carve-out`) | ✅ REVERT-PROVEN: re-duplicating a same-valued constant in `boardNodes.tsx` or `spine-checkpoint.tsx` REDs the carve-out pin. The carve-out is a SUBSET check, so folding `entity-panel.tsx` later cannot turn this slice's pin red |
| **REGRESSION GUARD — every pre-existing verbatim pin passes UNCHANGED**, including the ones this brief named: `module-board-rewrite.test.tsx:296` (the toast tuple, with the real `ModuleBusyError` object), `blocked-reasons.test.tsx:84`, `spine-checkpoint.test.tsx:87`, `generate-everything.test.tsx:648`/`:657`, `blocked-control.test.tsx:89` | those five files plus `lib/toast.test.ts` — NO pre-existing test file was edited by this slice (13 tests in the three run together, 34 in the other three) | ✅ byte-unchanged and green before and after |
| **REVERT-PROVEN, the 11 injections, each restored byte-identically (`git hash-object` before and after), 9 RED of 11:** `MODULE_BUSY_TOAST_TITLE` reworded **REDs 2** (the constants pin + the board toast pin); `MODULE_GENERATING_REASON` reworded **REDs 3** (`blocked-reasons` + `spine-checkpoint` + the constants pin); `toastModuleBusy`'s body → a different title **REDs 2** (the board toast pin + the toast pin); the seam's suppression branch deleted **REDs 2**; `MODULE_BUSY_ERROR_NAME` mismatched **REDs 2**; the constant re-duplicated in `boardNodes.tsx` **REDs 1**; the same in `spine-checkpoint.tsx` **REDs 1**; the `ChatSidebar:169` / a `CanvasPage` chat site / the `BoardPage:197` call site reverted to the inline literal **REDs 2 each**; the title reworded against every blocked-control suite **REDs 0** (see below) | as listed | ✅ 9 RED of 11 |
| **TWO INJECTIONS CAME BACK GREEN, AND EACH NAMES A LINE THE PINS DO NOT REACH.** (1) Reverting `BoardPage.tsx:197` to its inline literal leaves `module-board-rewrite.test.tsx` **GREEN**: that behavioural pin reaches the ARGS (title, error object) and never the ROUTE — byte-identical args pass whichever way the site is written — which is exactly why the source scan exists and why it says so in its own doc comment. By the same mechanism, re-duplicating a same-valued constant in `spine-checkpoint.tsx` leaves `spine-checkpoint.test.tsx` **GREEN**: a rendering pin verifies the SENTENCE, never the seam. (2) Rewording `MODULE_BUSY_TOAST_TITLE` leaves all four blocked-control suites **GREEN (35 tests)** — `blocked-reasons`, `spine-checkpoint`, `generate-everything`, `blocked-control` — which is the MEASUREMENT behind the §4 gotcha: the toast sentence and the control reason are consumed by disjoint surfaces, i.e. two audiences, not one string used twice (the mirror injection, rewording the REASON, REDs `blocked-reasons` + `spine-checkpoint` and leaves every toast pin green) | `features/module-board-rewrite.test.tsx`, `features/spine-checkpoint.test.tsx`, `features/blocked-reasons.test.tsx`, `features/generate-everything.test.tsx`, `features/blocked-control.test.tsx` | ✅ recorded, not implied |
| **UNPROVEN — stated, not implied:** the four `CanvasPage.tsx` catch sites and the two in `ChatSidebar.tsx` have NO behavioural pin anywhere in the repo, so the SOURCE SCAN is their only guard (a behaviour-driven pin would need a live canvas turn per site); the scan cannot see a copy COMPOSED at runtime (a template string reassembling the sentence — nothing in `src/` does that, and no guard was built); the name-based recognition in `lib/toast.ts` is an implicit cross-layer contract that the TYPE system does not enforce (it is pinned against the real class, so removing `this.name = 'ModuleBusyError'` in `moduleGen.ts` REDs the pin rather than silently re-leaking the uuid); `entity-panel.tsx:377` is a known remaining copy, deliberately byte-identical (concurrent slice, docs/18 §5); `chatChanges.ts:188`, `snapshotChat.ts:556` and `chatController.ts:374` meet the same condition as a NAMED OUTCOME with a longer, different sentence and were NOT measured for folding; and no live-provider or real-browser run was performed (every pin is jsdom with a mocked transport) | `docs/17 row 120`; `docs/18 §2.3/§4/§5` | stated |

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
