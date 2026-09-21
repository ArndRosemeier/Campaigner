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
    assertion changes. The SAME window, found a second time in
    `board-page-flush.test.tsx`: its two flush tests ended in a bare
    `await persistedPart0(...)` after the write's `waitFor`, and the row that
    flush wrote reaches React through `useModule`'s liveQuery — measured
    landing **5.8ms after the wait returned**, RED 2/7 with the cause delayed
    and 9/9 green alone (docs/17 row 153, and the rule docs/18 §4 already
    states). Do NOT wrap paired `fireEvent` pointer sequences in
    one spanning act — each `fireEvent` flushes its own render and
    down→up gesture pairing reads that state; a spanning act defers the
    commit and strands the gesture gate. The same wrapper migrated the
    formerly-allowlisted persona-run-ui and onboarding-wizard act-timing
    entries: the panel's raw run-row reads between engine writes and the
    wizard's raw `readSettings()` calls between settings writes are wrapped,
    and the tests end with a drain so the post-act cascade tail
    (auto-open status write, dialog exit transitions) stays inside act.
  - **A third occurrence, and the one that proves an `afterEach` drain is NOT
    the cure (docs/17 row 178).** `creature-portrait-agreement.test.tsx`
    reddened inside the `tests/features` chunk with
    `An update to BattleSurface inside a test was not wrapped in act(...)`
    and passes 5/5 isolated; a prior landing (row 165) had wrapped that file's
    `afterEach` settle in `act`, which settles only what is still pending
    AFTER the body — the leaking delivery fires DURING it. The captured stack
    names the exact source: `warnIfUpdatesNotWrappedWithActDEV →
    dispatchReducerAction → useLiveQuery`'s subscriber (`dexie-react-hooks`),
    i.e. a Dexie liveQuery delivery to the MOUNTED board landing in a bare
    `await` in the test body. **The reproduction is a delay injection, not
    load:** 120 ms (and the pair repeated at 80 ms) added to
    `db/artifactRepo.getAnyArtifact` — a read the board's provenance
    liveQuery awaits, whose delivery the test does NOT wait for — reds the
    file 2/5 and 3/5 respectively with the guard's exact warning, every
    assertion still green; the recorded test is among the 80 ms reds. A delay
    on a delivery the test DOES wait for (the portrait re-read) stayed green,
    because RTL's `waitFor` runs with the act environment disabled and
    absorbs it — so the window is specifically the un-awaited straggler.
    **Cure:** the file's two SHARED read helpers (`moduleSidePortrait`,
    `modulePortraitGaps`) wrap their bodies in `actDrained`, and its two
    post-mount writes (`campaignImage`, `setCreatureCover`) do the same — the
    shared-helper cure point this section already names, so every caller is
    covered once. Cured: 5/5 green at both delay levels and 5/5 clean
    isolated. No assertion moved, nothing is skipped, and the guard is
    untouched; the row-165 `act`-wrapped `afterEach` drain stays as the tail
    settle only.
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
  **AMENDED by row 192: that cure is WRITE-PATH ONLY.** The same test has a SECOND
  leak path the write drain never touches, and the record below is what the gate was
  still reddening on after this cure landed.
- **…AND THE SAME TEST'S DIALOG CLOSE IS A SECOND PATH — Base UI unmounts the
  popup on one animation frame outside act, and the post-click turn is the site (row
  192).** The `actDrained` write above is still load-bearing (re-measured on
  `9d03eeb`: the docs' own injection — one bare `setTimeout(0)` await after the write
  — reds the un-cured write form **3/3** with a single `CanvasPage` entry, and the
  drained form is **green 3/3**), but it is not the whole leak. The test then
  CLICKS the confirm action, and Base UI settles that close on its OWN schedule:
  `CanvasPage.tsx:1389` `handleResumeAutomation` calls `setResumeOpen(false)`; Base
  UI's `useOpenStateTransitions` enables `useOpenChangeComplete`, whose
  `useAnimationsFinished` (`node_modules/@base-ui/react/internals/useAnimationsFinished.mjs`)
  requests ONE `AnimationFrame`, resolves the `Element.prototype.getAnimations` stub
  (`tests/setup.ts`) to `[]`, and calls `ReactDOM.flushSync(forceUnmount)` — which
  sets `mounted` false and updates the store, re-rendering `AlertDialogRoot` /
  `DialogPortal` / `DialogBackdrop` / `DialogPopup` ~16 ms after the click, outside
  every act window the write drain opened. **Reproduced deterministically by
  DELAYING THE CAUSE at that site** (one file, `CAMPAIGNER_TEST_WORKERS=1`, raw logs
  kept, every arm's file hash printed): a bare `await new Promise(r => setTimeout(r,
  200))` inserted immediately after the confirm click reds the current tree **3/3
  with exactly 36 entries** and exactly the recorded component set — 2×
  `AlertDialogRoot`, 2× `DialogPortal`, 1× `DialogBackdrop`, 1× `DialogPopup`
  (hash `afba2a05…`; one of the three runs instead carried 44 entries on `CanvasPage`
  from the handler continuation, i.e. the same window catching the other pending
  update). The recorded flake is on demand. **The adjacent sites are NOT sites and
  were re-measured as such:** a bare delay at the pre-write `getModule` read (the
  dialog OPEN's transition frame) is **green 3/3**, and a delay at the trailing
  `listArtifactsByCampaign` read is **green 4/4** (the close frame lands inside the
  toast `waitFor`, whose act-free window absorbs it there) — so the leak is neither
  the write nor the open, it is the close, and the bare window to close is the one
  right after the click. **The cure:** `await waitFor(() => expect(screen.queryByTestId('canvas-resume-automation-dialog')).toBeNull())`
  immediately after the confirm click — the SAME dialog-absent barrier §"A dialog's
  confirm/decline closes on an exit TIMER" already prescribes. `DialogPortal`
  returns null the moment Base UI's `mounted` goes false, so the wait ends precisely
  on the rAF unmount, and RTL's `waitFor` deliberately disables the act environment
  for its whole window, so that frame's `flushSync` is absorbed rather than reported.
  **Differential, hashes printed, identical injection before the toast `waitFor`:**
  un-cured **RED 2/2 whole-file warm** (36 entries, the recorded components; hash
  `afba2a05…`) and **RED 3/3 single-test**; cured **GREEN 2/2 warm** (hash
  `a0b29584…`) and **GREEN 3/3 single-test**; cured with no injection **GREEN 3/3**;
  un-cured with no injection **GREEN 2/2** (the race is latent, which is why only an
  injection sees it). **Nothing was widened to make it quiet:** no `src/` change, no
  `tests/setup.ts` change, no `ALLOWED_NOISE` entry, no assertion weakened; the
  `actDrained` write, `flushAsyncUpdates` and the file's other tests are untouched.
  **THE SAME CLASS ELSEWHERE, NAMED RATHER THAN LEFT SILENT:** the same act() family
  in this one file also red a gate on `rewrites the named part through the repair
  seam, snapshots first, and the control disappears` (`/tmp/apptables-logs/gate-baseline.log`,
  one `CanvasPage` entry — the WRITE cascade landing in a bare `getModule` after a
  `waitFor`, which is the §1 rule, not this close path), and a scan of
  `tests/features/*` for the row-196 shape (assert an async live-query value
  immediately after an element appears) found the one real sibling already fixed by
  row 196 (`tests/features/model-picker.test.tsx`) plus 53 raw candidates that were
  sampled: each renders its asserted value only once the async data is present
  (the closest, `tests/images-ui.test.tsx:232` persona/target selects, is protected
  by an always-mounted panel, an earlier wait and the preselect effect).
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
- **A barrier must cover the FIELD the test asserts, not merely the row's
  existence** (docs/17 row 132). `creature-row-resolution.test.tsx`'s
  Library-only-npc test waited for the batch's row to EXIST and then asserted its
  `module:<title>` tag — but the rename that makes the row observable happens per
  TARGET (`entity-batch.ts:639`), while the tag is stamped only after the whole
  target pool drains (`:691-703`), so the barrier returned ~2 ms early and the
  tag assertion raced rev 3 (~1 failure in 3417 under load, 0 unloaded). Proved
  by DELAYING the stamp loop 300 ms: RED 4/4 un-cured, GREEN 3/3 cured, GREEN 3/3
  with the delay removed. The full mechanism, the alternative that was declined
  and the `tail` forensics lesson are in §A barrier must cover the FIELD it
  asserts.

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

- **sonner's toast swipe handler calls `setPointerCapture` on pointerdown**
  (`node_modules/sonner/dist/index.mjs:750`) BEFORE it checks whether the
  target is a button, and jsdom implements no pointer-capture API at all — so
  ANY `userEvent.click` on a rendered toast (its close button included) throws
  `TypeError: event.target.setPointerCapture is not a function` three times and
  exits the run non-zero **while every assertion passes**: a trap, not a
  failure. `tests/setup.ts` stubs `Element.prototype.setPointerCapture` as a
  no-op, which is the honest "no pointer capture, no layout" answer. Only the
  method sonner actually calls is stubbed; add `releasePointerCapture` /
  `hasPointerCapture` the same way if something starts calling them (nothing in
  sonner or `src/` does today).
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
- **A negative `waitFor` proves nothing unless something makes it wait for the
  READ — reproduced by DELAYING THE CAUSE (the `89e5d71` method), docs/17 row
  272.** `missing-refs-banner.test.tsx`'s two "stays hidden" pins asserted
  `waitFor(() => expect(queryByTestId('missing-refs-banner')).toBeNull())`,
  which passes on its FIRST tick — before the banner's `useLiveQuery` has run at
  all — so the pin was vacuous AND the query's settled setState landed outside
  `act`. The full gate red-carded the `GLOBAL library NPC` pin once inside a
  63-file chunk; it did NOT reproduce in isolation at any MACROtask delay
  (0/5/20/50ms injected in the banner's own live query), because those let the
  update land after unmount. ONE injected MICROTASK (`await Promise.resolve()`)
  makes it deterministic: the PRE-fix test fails on that NAMED pin, and the
  cured test is green 4/4 under the SAME injection — the raw resolve await
  wrapped in `actDrained()`, and the hidden-campaign pin draining through
  `flushAsyncUpdates()` — with every arm's component hash printed and restored
  byte-identically (`.gate-logs/row272/`). Loading the box was never used.

## UI coverage matrix (05-UI inventory → tests)

Legend: ✅ dedicated test · 🟡 mounted/landmark only (route sweep or shell
test) · ❌ gap.

| Surface (05-UI §) | Covered by | State |
|---|---|---|
| Top bar: nav links, campaign switcher, theme/language, no retired Play action | `app-shell.test`, `ui-smoke.test` | ✅ |
| Idea Board (`/idea-board`): app-level route needing no campaign, literal plain-text document, refinement sidebar, copy button, Previous drafts | `idea-board.test` (docs/17 row 173) | ✅ |
| Help button + dialog | `help.test` | ✅ |
| Campaign picker: cards, create dialog, delete confirm | `campaign-picker.test` | ✅ |
| Campaign picker: import dep-summary dialog (abort imports nothing, import-anyway lands `missing ref`) + Rules deep-link | `campaign-picker.test` (import dependencies) | ✅ |
| Campaign banner: missing-refs banner on campaign routes (hidden when clean / off-route); NAMES the creatures it is missing (deduped, ordered, bounded with an exact `(+N more)`), names the pack when the citation recorded one, and states `The pack was not recorded when this citation was written.` when it did not — never a guess | `missing-refs-banner.test` (docs/17 row 155) | ✅ |
| Encounter roster row: the rulebook stat-block search dialog writes a citation carrying the chunk, hash, creature name AND the book it came from | `monster-source-citation.test` (NEW, docs/17 row 155) | ✅ |
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
| **Structured text renders as PARAGRAPHS in the app AND the PDF**: a blank line is a paragraph break and a single newline a line break, both consumers drawing the ONE rule's own blocks, on a stored row no migration touched (docs/17 row 146) | `text-blocks.test` (12 pins, NEW) | ✅ |
| **The single-artifact GM export's own stat-block prose draws the ONE rule's blocks too**: a multi-paragraph appearance/trait body prints as separate pdfmake nodes, a single-block value is byte-identical to the pre-fold node, and the other label/value rows are untouched (docs/17 row 220) | `text-blocks.test` (+4 pins), `pdfExport.test` (10, unchanged) | ✅ |
| **An in-place refill names its target and refuses a returned name that belongs to another artifact** (docs/17 row 226): the draft prompt carries the entity lane's verbatim-name sentence for the TARGET, a mock reply answering as a co-mentioned neighbour does NOT become an alias, the neighbour's row is untouched, and the refusal is loud on the run notice and a toast | `runEngine-refill.test` (NEW reported-case pin), `artifactRepo-alias.test` (5 NEW guard pins) | ✅ |
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
| **A markdown table renders as a REAL table in the app** (docs/17 row 158, docs/18 §2.3): `<table>` semantics inside its own horizontal-overflow wrapper, in a part's body on the real READER page and behind the artifact editor's Preview toggle, with the cell text in order and no pipe-mush left anywhere | `wiki-markdown-tables.test` (2 surface pins + 13 behavioural pins through the shared renderer + 2 source scans) | ✅ |
| **An encounter sidebar row opens the shared EncounterCard** without changing the module URL; its roster is rendered there, while explicit Open in workspace and independent Run battle / Open battle remain available (docs/17 row 179; the run-battle button OPENS any existing battle unchanged, docs/17 row 240) | `module-reader.test`, `reader-encounter-roster.test` (reader/prose-card parity, name-only and missing refs, treasure, no inline roster) | ✅ |
| Module reader header nav — **Board + Chat + Contents**, with exactly ONE canvas destination: the **Chat** entry (`canvasChatPath`, i.e. the canvas with `?chat=open`), the plain-canvas **Canvas** control retired by owner request and gone by test id AND by accessible name (docs/17 row 138); beside them the module's ONE export control, **Module PDF** (docs/17 row 185), an ACTION (a real `<button>`, no `href`) so the one-canvas-destination count stays true | `canvas-chat-thread.test` (the one-canvas-destination count pin + the live Chat routing pin); `module-reader.test` (the header mounts `module-pdf-menu` and opening it offers EXACTLY the two audiences, `GM document` / `Player document`); `architecture/module-pdf-seam.test` (the two audience labels declared in exactly ONE file under `src/`, and `<ModulePdfButton>` mounted from exactly the three module surfaces with the reader importing the shared component — so a copied menu or a fourth fork reds by file) | ✅ |
| Table surface: module route, player-safe DOM, drag/tap, HP ownership, initiative, stage reset, layout-cell grid metrics | `battle-surface.test` | ✅ |
| Battle engine goldens: HP split, initiative, veils, legacy/layout snapping, staging ground | `battle-engine.test` | ✅ |
| Battle persistence: module lifecycle, v10→v11 clearing, v11→v12 layout defaults | `battleRepo.test`, `moduleRepo.test`, `migration.test` | ✅ |
| Battle seeding: roster expansion, room placement/veils, entry-room PCs, map fallback | `battleSeed.test`, `entity-panel.test` | ✅ |
| A CAST creature (`creatureRef`, no stored block) in an encounter resolves in battle — the DERIVED stats are frozen under the artifact id, `statless` stays empty, and the fighter-stats lookup returns them (docs/17 row 239) | `battleSeed.test` (`resolves a CAST creature (creatureRef) instead of badging it statless`) | ✅ REVERT-PROVEN (stashing the freeze reds it `expected [] to deeply equal [ObjectContaining{…}]`) |
| Encounter layout engine: packing ladder, structural validation, doors, placement, veils, schematic | `encounterMap.test` | ✅ |
| Dungeon preset: fixed ×2 grid tiers, room-count independence, staging re-tiering, run/artifact/Settings round-trip, v14→v15 backfill, Preset select + Dungeon caption | `encounterMap.test`, `encounterCartographer.test`, `migration.test`, `settings-page.test`, `images-ui.test` | ✅ |
| Encounter clients: input references, exact aspect (the verify machinery was removed — docs/11 D14) | `image-caps.test`, `imageAspect.test` | ✅ |
| Encounter module queue: one-candidate auto, continue-on-failure, failed-only retry | `encounter-map-queue.test`, `entity-panel.test` | ✅ |
| Play retirement: `/play` 404, no session kind, one-time v11 notice | `ui-smoke.test`, `m2kinds.test`, `migration-notice.test` | ✅ |
| The module PDF: the module-sourced document, no scaffolding, map plates, GM vs player, loud failures | `modulePdf.test` | ✅ |
| The module PDF's export surface: ONE control on all THREE module surfaces (canvas header, campaign tree's module group, module reader header — docs/17 row 185), GM/player as an argument, problems reported | `module-pdf-export.test`, `module-canvas.test`, `module-reader.test`, `architecture/module-pdf-seam.test` | ✅ |
| **The module PDF's PAGE MODEL**: main column + sidebar, sections that flow, the placement ladder (beside / continued / its own page), the verbatim contract and a CONTENT-PRESERVATION differential over three real documents (docs/17 row 148) | `pdfLayout.test` (19 pins, NEW) + the 6 updated assertions in `modulePdf.test`/`modulePdfPlan.test` | ✅ |
| **The module PDF's CONTENTS page carries REAL page numbers** (docs/17 row 156, docs/19 §7): the number printed in the Contents equals the page the section's heading really prints on, for all 21 + 7 + 7 sections of the three fixture documents — read back off the RENDERED PDF with pdfjs, not off a definition | `pdfLayout.test` (4 new pins: the rendered-page equality with a measured numbers table, the entry count/order, the PDF's own link annotations, the page-model shape and determinism under the pinned `compiledAt`) | ✅ |
| **An artifact's own image prints WHEREVER the artifact is described** (docs/17 row 187, docs/19 §2/§4): a planned section whose artifact carries a cover prints it with the plan anchoring NOTHING, an encounter's own map plate does too, a `read-aloud`/`aside` section still prints its artifact's picture while its mechanics stay suppressed, the NPC gallery prints portraits, a plan anchor naming the artifact's own picture is not printed twice, a row with no image prints none, and an image that exists but was not preloaded is LOUD (named problem + alert box) | `modulePdfPlan.test` (`18 → 22`: 5 new pins, one of them replacing the old “prints exactly the images the plan anchored” pin), `pdfLayout.test` (`36 → 37`: the large fixture, planned with every anchor removed), `modulePdf.test` (the procedural loud placeholders and the no-map/no-schematic pins, unchanged) | ✅ |
| Rules: import, book menu, delete, search browser, pin, embedding panel | `rules-page.test`, `search-browser.test`, `rules/embedding-panel.test` | ✅ |
| Settings: key, models, personas, language, encounter map defaults, danger zone | `settings-page.test` | ✅ |
| **The ONE model-picking widget** (docs/17 rows 193/199) — two variants (field: label + free-form input + browse; trigger: the compact button), one shared panel; both offer the account list through the ONE option seam, honour free-form entry, and are LOUD with no key / on a failed fetch; recents render in stored order only where the instance edits the GLOBAL chat model, and a choose records through the ONE seam only there | `model-widget.test` (13 pins, NEW), `model-picker.test` (row 193's 5, unchanged), `settings-page.test` (the placement on the REAL Settings page), `feature-shell-and-editor.test` (`onboarding-wizard.test.tsx`'s key-step field writes `defaultChatModel`), `architecture/one-model-option-source.test` (the whole mount population + `recentModels` placement + `recordRecentChatModel` callers) | ✅ |
| Top bar: the **GLOBAL chat-model picker** beside Settings (docs/17 rows 193/198) — the current `defaultChatModel` on its trigger, the **Recently used** group in stored recency order (never re-sorted), free-form entry for an unlisted id, the ONE account model-id option source, and LOUD no-key / failed-fetch states; the group means "the global model was in play", recorded on EVERY path that uses it and on no other tier | `model-picker.test` (5 pins), `recent-chat-models.test` (the ordering rule), `settingsRepo.test` (the recording write, incl. concurrent recorders), `runEngine.test` (a run records the global default; a persona override does not), `moduleGen.test` / `modulePlan.test` / `canvasRefine.test` / `canvasChat.test` / `ideaBoard-recording.test` (one pin per added global path, plus the non-global board/session exclusions), `architecture/global-chat-model-recording.test` (the whole resolution population + each record/exclude decision), `architecture/one-model-option-source.test` | ✅ |
| Global error boundary + uncaught-error toasts | `global-errors.test` | ✅ |
| A PERSISTENT error notice carries a real dismiss control, and dismissing it destroys no evidence (docs/05 §Error surfaces rule, docs/17 row 136) | `toast-persistent-dismiss.test.tsx` (4 pins, NEW: the real `Toaster` + the real seam, the same through `toastErrorPersistent`, the transient case unchanged, and the console record byte-identical after the click) + `toast.test.ts` (the seam's options) | ✅ |
| 404 page | `app-shell.test`, `ui-smoke.test` | ✅ |
| Blocked controls state their reason PERCEIVABLY (the shared device): the control stays natively disabled, the reason is associated via `aria-describedby`, the popup opens on hover AND on focus, and a live control carries none of it | `blocked-control.test` | ✅ |
| Canvas header + chat sidebar: a reason per reason-bearing blocked control (preview/open-editor, generating, refine running, streaming proposal, the chat's module-wide block and its live-reply block), each pinned together with the unchanged `toBeDisabled()` state | `blocked-reasons.test` (device), `module-canvas.test` (the AI flows themselves) | ✅ |
| Converted reason sites keep their gate and gain the perceivable reason (`generate-everything`, the entity batch gate, encounter Repopulate/Regenerate everything) | `generate-everything.test`, `entity-classify-new.test`, `images-ui.test` | ✅ |
| A reason is never stated in a `title` beside its wrapper (docs/17 rows 125/127): all SEVEN surfaces that restated it there state it ONLY through the device now, the scan's two-entry known list was DELETED in the same commit that folded the two sites it licensed, and any restated title in `src/**` reds it | `blocked-control-title-scan.test` (SCAN, 2 — strict, no allowance), `module-canvas.test` (the Save control), `canvas-module-actions.test` (Fix + Resume), `entity-classify-new.test` (the batch gate + classify), `generate-everything.test` (both held states), `editor-surfaces.test` + `change-artifact-ui.test` (Repopulate, both held states) | ✅ |
| The DESCRIPTION a held control used to lose survives on the LIVE control: each of the five gated descriptions is asserted byte-identical while the control can act, and its ABSENCE is asserted while the control is held (gated on the FULL held expression, so no held state leaks one) | `canvas-module-actions.test` (Fix + Resume), `entity-classify-new.test` (classify), `generate-everything.test` (live + two held), `editor-surfaces.test` (stocked complex + single), `change-artifact-ui.test` (held by the other run) | ✅ |
| **The canvas chat's applier and turn controller are ONE implementation each** (docs/17 row 150): a 310-case DIFFERENTIAL runs the editor view and the preview string over the same inputs and requires identical document text / `docChanged` / `lastApplied` / every outcome field, and a SOURCE SCAN holds both declarations to one file | `canvas-chat-apply-differential.test` (6, NEW), `canvas-chat-turn-parity.test` (10, NEW) | ✅ |
| **A chat turn's WRITE PATH is pinned on BOTH surfaces**: the machine-write signature (`origin: 'model'` + `writerModel` = the `modelUsed` that served the reply) and EXACTLY ONE durable `moduleVersions` snapshot per turn, asserted by COUNT | `canvas-chat-turn-parity.test` (NEW) | ✅ |
| **A failed chat turn returns the document its own refusal promises** (docs/17 row 150): the applied edits are still in it and `docChanged` says so, on the editor AND the preview surface, each with its own sentence | `canvas-chat-turn-parity.test` (NEW) | ✅ |
| The `'no parts to chat about — generate the module first'` sentence is declared EXACTLY once under `src/` and pinned as the FULL anchored sentence (the pin used to be a prefix regex) | `llm/canvasChat.test` (60) | ✅ |
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

| Prompt scaffolding echoed back as CONTENT is refused at the boundary that would persist it (docs/17 row 142): the three markers in the owner's report are caught at the entity finalize, at the module part write and at the spine parse, each naming the marker AND the field with nothing persisted; the literals come from ONE source shared with the composers; and ordinary prose that merely uses the same words stays green | `scaffoldingEcho.test` (30, NEW) | ✅ |
| The HTML→text stripper is ONE ingest seam for all seven pack adapters (docs/17 row 143): 17 shared sample cases × the 3 declared styles pinned to exact bytes (10 declared divergent, 7 the styles must AGREE on), the divergence asserted as the KNOWN `LANDING 2:` residue — AMENDED BY REFERENCE, docs/17 row 149: those two divergence pins are FLIPPED to the repaired bytes and the residue moves to the RETIRED `at-label-last` behaviour, 28 pins → 41; a source scan that finds no second stripper among the directory's ten files and all seven call sites passing their declared style, and the STORED bytes of one real fixture per group — because those bytes ARE the content hash | `html-to-text.test` (28, NEW; the pre-existing table pin in `pf2e-journal.test` and `packFetch.test` stays green through the seam) | ✅ |
| The two CORRUPTED HTML→text behaviours are FIXED, per lane, on fixture evidence (docs/17 row 149): the `@`-notation brace rule is ONE shared helper, `AT_LABEL_LAST_LINE_BREAKS` is deleted, and the two PF2e description lanes moved to the block-and-table style — pinned as 41 pins in `html-to-text.test`: the 17-case differential over THREE behaviours (two live styles + the retired notation), the two named real fixtures asserted byte-exactly with their FLIPPED values (`anointing-oil` → `Enfeebled 1`; `steel-shield` → `Hardness \| HP \| BT` then `5 \| 20 \| 10`), the retired behaviour asserted as still reachable, and **every lane's emitted text hashed per lane with its pre-row-149 digest beside it**, so an UNCHANGED lane is asserted as unchanged (`foundry-pf2e`, `-journal`, `-conditions`, `-rules`) and a CHANGED lane is named (`foundry-pf2e-equipment` 2 of 11 entries, `foundry-dnd5e-srd` 1 of 13, `foundry-dnd5e-equipment` 1 of 7) | `html-to-text.test` (41, was 28); `rules-page.test` (the re-import sentence renders on the shared pack-import report) | ✅ |
| The `where` label has ONE home and ONE declared second spelling (docs/17 row 145): a 4-case differential drives the home (`mentionView.whereLabel`), the STORED `ExpansionExcerpt.source` of `llm/campaignGrounding` and the `db/orphanSweep` refusal reason over the same inputs, requiring the two same-convention copies to be IDENTICAL and declaring the third as `prose === label.toLowerCase()` — plus a source scan proving `function whereLabel` is declared in exactly the two declared files | `mention-where-label.test` (17, NEW) | ✅ |
| A DEAD duplicate stays deleted (docs/17 row 145): `rosterCreatureKey` — a superseded third spelling of the roster-side creature identity with zero callers — is absent from every `src/` and `tests/` file, while the LIVE spelling (`battleSeed.creatureKeyForEntry`, including the `'none'` arm that passes `null`) is intact | `creature-identity-spelling.test` (3, NEW) | ✅ |
| The wiki-token grammar is ONE source with TWO flag variants (docs/17 row 145): a differential drives a token-bearing sample through the export consumer (`stripWikiLinks`) and the PDF consumer (`parseInline`), the vanished-link case (`plain **bold** [[Ash Gate]] and [[Kael]] and [[Pier]].`) is pinned through `mdToPdfmakeContent` itself (`Kael` must survive), and a source scan proves no second `\[\[` token regex exists outside the two declared sites | `wiki-token-grammar.test` (25, NEW) | ✅ |
| The pack document STREAM comes from ONE ingest seam, and the two dnd5e YAML bodies can no longer disagree (docs/17 row 147): the rule pinned directly (a comment-only file → a LOUD `<file>: no YAML document`; a bare `---`/`null`/`# c\n---\n# c2` → a RETURNED `[null]` counted as a skip; whitespace-only → `file is empty`; unparseable → `invalid YAML:` with its `cause` kept), the JSON family's own invariant asserted as "never an empty array for a non-empty input", the ACCOUNTING asserted through the REAL adapters (`entries`/`items`/`sections`/`skipped`/`failures` together, one `---` document = exactly 1 skip and 0 failures in BOTH dnd5e lanes), and a source scan that leaves `JSON.parse`, `loadAll`, `from 'js-yaml'` and `function parseDocs` in `text.ts` and NOWHERE else among the directory's ten files | `parse-docs.test` (15, NEW) | ✅ |
| The `Source:` line is ONE rule across FOUR sites, with its one real difference DECLARED rather than unified (docs/17 row 147): a differential drives the three prefixed sites (`pf2e-conditions.publicationSourceLine` exported, the same rule reached through the REAL `pf2e-rules` adapter, and the inline rule inside the REAL `domain/itemData.formatItemText`) plus the raw `extras['Source']` form over title-only / license-only / both / neither / null / absent, requiring the prefixed three to be byte-identical and the raw form to equal them minus the `Source: ` prefix — then re-runs the real fixtures (`pf2e-conditions/{blinded,frightened}.json`, the four `pf2e-rules/*.json`, `pf2e-equipment/longsword.json`+`anointing-oil.json`) through the real adapters | `source-line.test` (7, NEW) | ✅ |
| An entity-intent paragraph is scaffolding the echo detector can SEE (docs/17 rows 141/145): the two literals moved into `llm/promptScaffolding`, an intent-bearing brief is detected on both markers, and a note containing a QUOTE is detected too (the case a slotted marker would silently miss) | `scaffoldingEcho.test` (30 → 34) | ✅ |

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
| The kind ownership boundary (docs/17 row 140): a `location`/`event`/`faction` brief carries the OPPOSITION-boundary paragraph LAST and still carries the module text it was handed; `npc`/`encounter`/`note` and every kind-less caller are BYTE-IDENTICAL; and the PRODUCTION seam (`runEntityBatch`) actually passes its kind | `kindOwnershipBoundary.test` (14, NEW) | ✅ |
| The entity INTENT record field (docs/17 row 141): additive/optional with ONE spelling of absence (key absent, `null`, `''`, whitespace), a LOUD cap at 400 (never a truncation), the spine reply's `null`/missing/present round-trip, the note carried across name normalization (and two different notes refused by name), and the ONE reader `entityIntentFor` | `entity-intent.test` (15, NEW) | ✅ |
| The intent PARAGRAPH in the brief: exact composition and position (after the ownership boundary, before `Additional instruction: …`), and a record with NO note producing the pre-field brief BYTE FOR BYTE | `entity-intent-brief.test` (11, NEW) | ✅ |
| The intent reaches the WORKER: the batch hands the record's note to the engine's brief, a neighbour with no note stays clean, and the CHANGE/refill lane (`changeArtifact` → `runEntityBatch`) carries it as well | `entity-intent-batch.test` (5, NEW) | ✅ |
| The spine ASKS for the note in the app's own voice (system message, bound from the same constant), the emitted contract makes `intent` REQUIRED-nullable, and the STYLE-COMPOSED prompt is untouched (every `promptStyles` classic fixture still green) | `moduleGen.test` (the spine-contract pins, extended) | ✅ |

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
| Finalize casts through `castCreatureAsNpc`: ONE `npc` artifact with the entity's name, the module's own prose about it and the creature's `creatureRef` — `statBlock` null and no authored stat block, with the description run (always spent since docs/17 row 135) aimed AT that row and reaching no transport in this file (its engine is faked) | `moduleGen-cast.test` | ✅ |
| EVERY NPC the module's text produced gets an AUTHORED description through the cited row's refill: the entity's own persona run TARGETS the cast row (statblock step `'skipped'` before any model call, citation byte-identical, `statBlock` null, prose authored), the module's own paragraph rides the brief as CONTEXT — asserted on the transport payload — and a failed description run is reported while the cast stands (docs/17 rows 133/135) | `entity-batch-cast-description.test` (7, real engine + faked transport), `moduleGen-cast.test` (3 rewritten, +0), `module-post-generation.test` (+4, the `batchTargets` fact) | ✅ |
| A batch target IS a wiki-link of the module text (`namesOfKind` = `extractWikiLinks(moduleDocumentText)`): a recorded name the text never wrote is not work, an aliased `[[Name\|alias]]` contributes the TARGET name, and a name with an authored detailed row is not a target — the fact that makes the deleted floor's "never mentioned" case unreachable (docs/17 row 135) | `module-post-generation.test` (4, pure), `entity-batch-cast-description.test` (the end-to-end seal) | ✅ |
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
| Roster references: `npc-ref` cross-reference (with its page destination), `inline` stat box with NO origin line, a `rulebook` citation printing its REAL resolved origin (the dead `(see Bestiary)` constant is gone) plus **the cited chunk's own numbers**, and a name-only entry's named `isMissingRefOrigin` reason | `modulePdf.test` (C5), `domain/encounterReference.test`, `lib/roster-reference-parity.test`, `pdfExport.test` (docs/17 row 144, §A cited mob's reference and numbers) | ✅ |
| A cited mob's numbers reach BOTH books through ONE formatter and ONE box — differential over the two real documents, and a source scan for a second implementation | `lib/roster-reference-parity.test` | ✅ |
| The differential is a real EQUALITY, not two one-sided containments: the reference is EXTRACTED from each rendered book on its own and compared, with a non-vacuity guard on both sides — a decoration added to ONE exporter reds the file (MEASURED, docs/17 row 146) | `lib/roster-reference-parity.test` (`a cited mob's reference is byte-identical…`, tightened) | ✅ |
| GM vs player from ONE builder: the player document drops gm-only rows, notes, plot arcs, faction methods, encounter tactics/treasure/terrain, PC notes, the part plan and the treasure ledger — while maps stay in both | `modulePdf.test` — the same fixture rendered twice and diffed by what it must NOT contain | ✅ |
| **The treasure ledger carries BOTH sources** — the encounter's own `treasure` line AND one labelled row (`<encounter> · <mob> ×count`) per roster entry that carries something, with no row for a mob that carries nothing and no ledger at all when nothing anywhere stores treasure (docs/17 row 159) | `lib/per-mob-treasure.test` (5 pins, one an exact `toEqual` on the ledger's header and rows) | ✅ |
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

### The document's page model — main column, sidebar, own pages (docs/17 row 148, docs/19 §3–§5)

The owner judges the EXPORTED PDF (*"PDF is still completely one dimensional
flowing, no sidebars and nothing interesting happening at all."*), so the pins
below are about the document's SHAPE, and one of them is a differential over real
fixtures — this is a layout rewrite, which is exactly where content goes missing
without any existing pin noticing.

| Surface | Covered by | State |
| --- | --- | --- |
| **Nothing is lost.** Every TEXT RUN the pre-layout renderer produced is still produced, in all three fixture documents | `pdfLayout.test` — a multiset differential of runs, BEFORE vs AFTER, non-vacuous on both sides (>50 runs each). The BEFORE column is `pdfLayoutBaseline.json`, captured by the SAME extractor at the base commit in a second worktree at `origin/main`, so it is a measurement of the renderer that shipped, not a hand-written list | ✅ |
| **Only the layout's own signposts are NEW** — at this landing the added runs were EXACTLY the own-page pointer sentences, and nothing else in the document was rewritten. **Row 151 extended this same `toEqual` with the navigation's own lines and renamed it** (`adds exactly the page model's own pointers and the navigation's own lines, and nothing else`); the equality itself was never weakened | `pdfLayout.test` (`adds exactly the page model's own pointers and the navigation's own lines, and nothing else` — an `toEqual` on the added-run list, so an extra run is a failure even though nothing was lost) | ✅ |
| A report of both sides' counts (runs and distinct strings) is asserted, so a silent shrink is visible as a number and not only as a red | `pdfLayout.test` (`reports the content counts on both sides`) — 217/156 → 220/159, 163/128 → 165/130, 53/48 → 53/48 | ✅ |
| **§3 geometry**: a companion page is `{columns: [{width: 294.8, stack}, {width: 170.1, stack, style: 'detail', fontSize: 9.5}], columnGap: 17, pageBreak: 'before'}`, and `pageMargins` is 56.7 on all four sides | `pdfLayout.test` (2) — read off the built definition, and the three widths are asserted to sum to the content width | ✅ |
| **The sidebar carries the MECHANICS and the main column the TEXT** — a faction's `Goals`/`Methods` fields are in the sidebar of the page that names it and are asserted ABSENT from that page's main column, so the two columns cannot be one column rendered twice | `pdfLayout.test` (`prints the artifact's mechanics in the sidebar and its text in the main column`) | ✅ |
| **§3 sections flow**: no heading carries a `pageBreak` any more (the PAGE does), and two planned sections share one page's main column | `pdfLayout.test` (`flows sections: the break belongs to the page, never to a heading`) — every heading node in the definition is checked, and the two sections that were a page each are asserted on ONE page | ✅ |
| **§4/§5 the ladder as a RULE**: `beside` → `beside-continued` (≤2 sidebar budgets) → `adjacent`; `OWN_PAGE_KINDS` = encounter/event; ANY block with an image is `adjacent` whatever its kind; a `beside`-tier kind stays `beside` | `pdfLayout.test` (2) — the shipped `detailPlacement` called directly, including the boundary cases one point either side of the budget | ✅ |
| **§5 step 2 (continuation)**: a companion that outgrows one sidebar stops with `CONTINUE IN THE SIDEBAR OF THE NEXT PAGE`, opens the NEXT page's sidebar with `CONTINUED`, and every field is on one of the two pages — the paginator is driven directly with a real overflow | `pdfLayout.test` (`continues a companion on the NEXT page's sidebar and never truncates it`) | ✅ |
| **§5 step 3 (own page)**: an encounter's own page is a full-width `stack` (NOT a two-column node), its plate uses the whole content box (`"fit":[481.9,660]`), it is the node IMMEDIATELY AFTER the page whose TEXT column carries the pointer sentence (docs/17 row 186 moved it out of the sidebar), and that page names the chapter | `pdfLayout.test` (`gives an own-page artifact its own full-width page, right after its text`) | ✅ |
| **§3's degenerate case**: no two-column page is rendered with a side that holds no REAL content (docs/17 row 186 — the old form forbade only an EMPTY sidebar array), a page with no companion is a full-width stack, the small module renders whole, and a document whose only block has no companion paginates to one page with no columns at all | `pdfLayout.test` (3) — the last one drives `paginateDocument` directly | ✅ |
| **The verbatim contract**: a body's blank line is a paragraph break (two runs) while a SINGLE newline inside a field stays inside ONE run (`'Melee: +3 to hit, 4 damage.\nReach 5 ft.'` is present and NEITHER half is present alone), and every stat-block section label reaches the page | `pdfLayout.test` (`prints a body's paragraphs and line breaks exactly as the text carries them`) — asserted from the row's own text, so a reflow or a truncation fails even though the row itself is untouched | ✅ |
| **Nothing is materialized**: building a full planned document moves no stored byte — the artifact rows and the module row are byte-identical afterwards, and the artifacts/modules/revisions counts are unmoved (no Dexie version, no schema change, so a module generated before this change renders under the new layout on its next export) | `pdfLayout.test` (`keeps the builder pure`) | ✅ |
| **Completeness binds the PLAN** (the owner's answer to docs/19 §10 question 2): every artifact the plan places whose text refers to it prints, pinned on the SECTION HEADINGS rather than on the names — a name also appears as a bold wiki-link run in the premise, so a name-only pin would stay green while the whole section went missing | `pdfLayout.test` (`keeps EVERY artifact the plan places whose text refers to it`) | ✅ |
| **An artifact nothing refers to is DROPPED — and is not silent** (the owner's answer to §10 question 3, a departure from §4's proposal): it is absent from the document (neither its section title nor its body appears), AND the document states the omission on its own page AND the export's `problems` names the same site with the same wording. Both directions are pinned on one fixture | `pdfLayout.test` (`drops an artifact nothing refers to, and says so on the page AND in the problems`) — a third fixture, `pdfLayoutOmissionFixture`, owned-but-unmentioned | ✅ |
| **The limit of that rule is pinned too**: the procedural outline has no plan record to attribute an omission to, so it still prints every row it scopes, with no `problems` entry | `pdfLayout.test` (`still prints an owned row nothing refers to in the PROCEDURAL outline`) — the SAME fixture, built without a plan | ✅ |
| The pre-existing module-PDF pins still hold across the rewrite, with the assertions that measure a page-dependent number UPDATED in place | `modulePdf.test` (1 assertion: the plate's `fit` width 515 → 481.9, the full content box), `modulePdfPlan.test` (5: the same `fit`, an aside's page-break window RE-EXPRESSED structurally — the enclosing PAGE node carries the break, not the aside — and the two deterministic-byte measurements, definition characters 6359 → 6973 → 8095 → 8131 → **8030** and PDF bytes 51271 → 51183 → 59215 → **59233**, the row-186 re-measurements named in that section below) | ✅ |
| The whole PDF neighbourhood, re-run after every step of the rewrite | 8 files / 101 tests: `pdfLayout`, `modulePdf`, `modulePdfPlan`, `pdfExport`, `provenance-export`, `wiki-raw-export`, `roster-reference-parity`, `module-pdf-export` | ✅ |

**Every assertion that moved is listed above** (1 + 5), and NOTHING was weakened:
the aside's old pin asserted the break inside a 60-character window of the aside,
which the new page-level break makes meaningless, so it was re-expressed as
"the enclosing page node carries `pageBreak: 'before'`" — a stricter statement
about the same fact. No `toEqual` became a `toContain`, and no assertion was
deleted. **What no existing pin could see, before this landing:** every pre-change
pin is a `toContain` on a single string in the definition, and a layout rewrite
that MOVES content leaves all of them true — a page that lost its sidebar, or a
companion that fell off the document, would have kept the entire suite green. That
is the hole the differential above closes.

**REVERT-PROVEN** (each injection printed with the same-file `diff -u` against an
OUT-OF-TREE copy BEFORE the run, restored from that copy, and re-hashed with
`git hash-object` — `pdfPageModel.ts` `af8480a02c625a8b539a9f2c9b6f8dfd1a590b7a`
and `modulePdf.ts` `de0e91af059c77e260deb9d7c60c776386f4cca1`, identical before and
after every one of the five):

| injection | what it does | RED |
|---|---|---|
| **I1** `pageNodes` stops emitting `columns` — every page becomes one full-width stack (the pre-change layout, "all artifacts back to the main flow") | the whole page model is bypassed while every string stays in the definition | **4** — the two §3 geometry pins, the sidebar-carries-the-mechanics pin, the small-module page pin, plus the flowing-sections pin |
| **I2** the sidebar takes `block.detail.slice(0, 1)` instead of the whole companion | the sidebar SWALLOWS an artifact's fields — content silently lost | **3** — the content-preservation differential, the counts report, and the sidebar-contents pin |
| **I3** the continuation is armed AFTER the page is flushed instead of before | §5 step 2 puts the `(continued)` head on the page after the next one | **1** — exactly the continuation pin |
| **I4** `omitted` is always empty | the owner's decision 3 is dropped: an unreferenced row prints again | **1** — exactly the omission pin |
| **I5** every planned artifact section is filtered out of the printed document | a layout change starts dropping whole sections | **5** — the differential, the added-runs pin, the counts report, the flowing-sections pin, and the completeness pin (which is why that pin is on the headings: it was GREEN under this injection while it pinned names) |

**UPDATED by docs/17 row 156 — a PDF pin CAN now read the rendered page.** The
sentence below was true when it was written and is no longer the whole truth:
`generatePdfBlob` produces the real PDF in jsdom and pdfjs reads every page's
text layer back (`openPdfDocument` → `getPage(n).getTextContent()`, items
carrying their own string and their own type size), which is how the Contents'
page numbers are pinned against the pages they name — see the row-156 section
below for the technique and its limits. What is still NOT visible this way is
anything that is not TEXT or an annotation — colours, how a page looks, and the
WIDTH of a column as a number. **A text item's own x IS visible, though** (each
`TextItem` carries its `transform`, and row 186 reads `transform[4]` to prove
which column a line was laid out in — the one-sided page's text starts at
`PAGE_MARGIN`, not at the sidebar's offset), so page-level placement geometry is
pinnable on the rendered page even though pdfmake's measurement is not. **What a
test cannot prove:** jsdom asserts the pdfmake DEFINITION, never a
rendered page — pdfmake's own column and pagination behaviour is unverified here,
and the definition is the only artifact the suite ever sees. So the following is
NOT proven by anything above: that pdfmake keeps a `columns` row on one page
rather than splitting it (the reason pages are emitted as explicit nodes with
`pageBreak: 'before'` is that `LayoutBuilder.processColumns` desyncs a too-tall
column from its sibling — read in `node_modules/pdfmake/src`, not measured here);
that the arithmetic estimator agrees with pdfmake's real text measurement, which
is why it is tuned deliberately wide (it errs toward promoting a block to its own
page rather than toward an overflow); that the sidebar's 9.5 pt reaches every
descendant (the style STACK is pinned as a property on the column, which is
pdfmake's documented inheritance, not a rendered observation); and that the
result LOOKS like a document with a sidebar. **The one thing only the owner can
check** is the real PDF: that each page carrying an artifact shows a narrow
right-hand sidebar with the artifact's mechanics at a smaller size beside the main
text, and that an encounter or a map-bearing location sits on its own full-width
page immediately after the page whose sidebar points at it, with no column
spilling onto the following page.

### The one-sided page and the marker seam (docs/17 row 186, docs/19 §3/§5)

The owner reads the EXPORTED PDF, so these pins are about the pages he holds.
His three sentences are the felt problem (*"Some pages have just a sidebar,
nothing else. Makes no sense. If there is nothing else, of course the sidebar can
use all room."* / *"Similar problem with main area. If there IS no sidebar, use
all room"* / *"Some pages just say \"x has its own page, following this one\".
Which is comical. A whole empty page to announce the following."*), and mid-flight
he CONFIRMED the second direction is real — *"Yes, there was a page where the main
content was there and narrow without a side bar."* — which is why the mechanism
was ENUMERATED rather than assumed to be the mirror of the empty-main case.

| Surface | Covered by | State |
| --- | --- | --- |
| **A page whose sidebar carries no REAL companion content is ONE full-width stack.** The sidebar held only the 8 pt uppercase pointer, so `pageNodes` read it as a sidebar and confined the main text to 104 mm. Asserted by NODE SHAPE (no `columns` array at all) on the owner's CONFIRMED page (`large-planned` p3: the real `Before the Gate` + `The Dockyards` text in the main column) AND on the procedural chapter page (heading + pointer), with `realNodes` proving the pointer rode the text column rather than being dropped | `pdfLayout.test` (`renders a page whose sidebar carries no REAL companion content as ONE full-width stack`) | ✅ |
| **No two-column page has a side that holds no real content, and no page's whole content is marker sentences** — over ALL FIVE fixture documents (the three baseline ones + the repeat + the omission), so a future paginator change cannot reintroduce either direction on any of them. Non-vacuous: genuine two-column pages are counted and must exist | `pdfLayout.test` (`never gives a page a two-column frame with no real content on a side, and never prints a page of markers alone`) | ✅ |
| **The boundary that makes "never a marker-only page" absolute**: two `adjacent` blocks back to back leave `main` empty when the second block pushes its pointer, so without the marker-only boundary in `flush` the pointer would flush as a sheet of its own. The paginator is driven DIRECTLY, and the pin requires exactly the two own pages with both companions intact and both pointers dropped | `pdfLayout.test` (`never emits a page whose whole content is the own-page announcement (two own-page artifacts in a row)`) | ✅ |
| **A companion-only page (an empty main column) KEEPS its detail and prints full width** (rule (d)): the `beside-continued` carry page has an empty main column, so nothing may be dropped to make the page nicer and it must not be drawn as an empty 104 mm column beside a 60 mm companion. Pinned at BOTH levels — the paginator is driven directly with ONE overflowing companion as the LAST block (the carry page's `main` is empty and its real sidebar holds the whole tail), and a FIFTH fixture (`pdfLayoutCarryFixture`: a plan whose LAST section is an npc that outgrows one sidebar) proves the definition renders that page as ONE full-width `stack` carrying the stat block's own sections | `pdfLayout.test` (2: `keeps a companion-only page (an empty main column) instead of dropping its detail` + `prints a companion-only page as ONE full-width stack, never as an empty column beside a populated one`); `tests/lib/pdfLayoutFixtures.ts` (`pdfLayoutCarryFixture`/`pdfLayoutCarryPlan`) | ✅ |
| **Nothing is lost and the comical page is gone**: the repeat fixture's first own page still carries the encounter's roster stat block, the later reference's page carries the §10.1 link back, no page is markers alone, and the document is 5 pages (was 6 — the dropped page is the pointer-only sheet) | `pdfLayout.test` (`keeps the own-page artifact's details AND prints no page that is only the announcement`) | ✅ |
| **RENDERED geometry, not only the definition**: read back with pdfjs in BOTH documents that carry the pointer, with the kicker's letter spacing stripped; no rendered page's whole text layer IS the announcement, and the announcement item's own x (`TextItem.transform[4]`) is `PAGE_MARGIN`, not the sidebar offset `PAGE_MARGIN + MAIN_COLUMN_WIDTH + COLUMN_GUTTER` | `pdfLayout.test` (`prints the announcement on a page that carries other text, at the page margin rather than the sidebar offset`) | ✅ |
| **The marker/real question is answered in ONE place**: `pdfPageModel.marker()` is the ONE constructor for `ownPageNote`/`continuedNote`/`earlierDetailNote` and brands the node, and `isMarkerContent()` is the ONE test — asked by the paginator and by `modulePdf.pageNodes`, neither of which ever matches a sentence. The brand is a Symbol, so the definition's JSON and every byte-determinism pin are byte-identical | `src/lib/pdfPageModel.ts` (`MARKER`/`isMarkerContent`), `src/lib/modulePdf.ts` (`pageNodes`) — the two callers are the whole population | ✅ |
| The §5 step-3 own-page pin UPDATED in place (the page before the own page is now the ONE full-width stack carrying the pointer in its TEXT column), and `never renders an empty sidebar` renamed to `never renders a two-column page with a side that holds no real content` (the old form passed a marker-only sidebar while squeezing the text). Nothing deleted or weakened | `pdfLayout.test` (2) | ✅ |
| The byte-determinism pins re-measured: planned definition 8131 → **8030** characters (the columns frame's 101 characters removed from the fixture's one chapter-plus-pointer page; the Symbol brand adds none) and rendered PDF bytes 59215 → **59233**. The load-bearing halves (`second === first`, `firstDiff: -1`) are UNCHANGED | `modulePdfPlan.test` (2) | ✅ |

**THE ENUMERATION THAT NAMED THE MECHANISM** (the pre-fix form, measured with
the probe, so the owner's report is not an assumption). Every page of all five
fixture documents was classified by node shape and by whether its sidebar holds
REAL content or only markers:

| document | page | main column | sidebar | shape | note |
| --- | --- | --- | --- | --- | --- |
| `large-procedural` | 7, 9, 11 | 1 real node (the chapter heading) | 1 marker, nothing else | `columns` | the pointer owns the sidebar |
| `large-planned` | **3** | **6 real nodes** (`Before the Gate` + `The Dockyards`) | **1 marker, nothing else** | `columns` | **the owner's confirmed page: main content present, narrow, no sidebar a reader would call one** |
| `repeat-planned` | 3 | 3 real nodes | 1 marker, nothing else | `columns` | |
| `repeat-planned` | 5 | EMPTY | 1 marker, nothing else | `columns` | the whole-sheet announcement (the same document is 5 pages after the fix) |

Two hypotheses from the mid-flight evidence were CHECKED and are ELIMINATED, not
guessed: **no page anywhere has a non-empty sidebar that renders nothing** (an
empty stack, an empty string node or a dropped marker — the sidebar nodes all
carry the pointer's text), and **no page has a genuinely EMPTY sidebar ARRAY
together with a narrow main** (which would contradict `pageNodes`' own full-width
branch and mean a page built outside it — impossible since row 156, when every
page became a `pageNodes` output).

**REVERT-PROVEN** (each injection applied to the exact executing line, the
modified file's hash PRINTED for every arm, restored from an out-of-tree copy and
re-hashed — `pdfPageModel.ts` `1e8883daaab0437e7fae0244d5cff8fcf849ec64`,
`modulePdf.ts` `83b652fa781d25e874f6ade0219c43ff51eb6979`, identical before and
after every arm; an arm whose output was identical to the baseline is recorded as
VOID, never as evidence):

| arm | injection | red |
| --- | --- | --- |
| **A** | none — the fixed tree, on `pdfLayout.test.ts` | **0 — 36/36 green** |
| **B** | the pre-fix one-sided-page mechanism: `pageNodes` decides on `page.sidebar.length === 0` again AND the pointer goes back into the sidebar (`pdfPageModel` `87d6948d…`, `modulePdf` `732d3bbb…`) | **6** — the two row-186 shape pins, the rule-(d) companion-only pin, the renamed degenerate pin, the §5 step-3 own-page pin and the rendered-geometry pin, with `large-procedural page 7: a two-column page with no real sidebar: expected 0 to be greater than 0` |
| **C (VOID, recorded)** | remove the marker-only `flush` boundary ONLY | **0 — GREEN (33/33 at the time), and it is VOID**: the marker-only COMPANION check already suppresses the pointer for a later reference, so nothing changed. The probe measured the same output, which is the tell the rules name |
| **C′ (corrected)** | remove the marker-only `flush` boundary only, with the new direct paginator pin present (`pdfPageModel` `67d09e1c…`) | **1** — `never emits a page whose whole content is the own-page announcement (two own-page artifacts in a row)`: `expected [ …(4) ] to have a length of 2 but got 4` |
| **D** | the pre-fix pointer-before-break ORDER: the pointer is pushed into the sidebar for an `adjacent` block and the boundary is removed (`pdfPageModel` `713b50ac…`) | **3** — the row-186 page-shape pin (`repeat-planned page 5: a page whose only content is marker sentences`), the repeat-fixture pin (`6` pages where `5` is required) and the direct paginator pin |

**WHAT THESE PINS CANNOT PROVE.** The rendered pin reads TEXT and its x, not the
page's visual weight: it cannot say that the remaining chapter-plus-pointer page
READS well (the recorded deviation), only that the pointer is in the text column
at the page margin. The pixmap, the colours and pdfmake's own column measurement
remain unverified in jsdom (see the row-148 section above), so the owner's eye is
still the last check on how the fixed pages LOOK.

### An artifact's own image prints wherever the artifact is described (docs/17 row 187, docs/19 §2)

The owner, reading an exported module PDF, verbatim: *"Most of the images in the
module are not actually used. It maybe does not need to use ALL images, but i
would at least expect NPCs and locations when they are described anyways."* —
and, asked directly: *"yes to images where they belong"*.

**THE MEASURED CAUSE.** The document has TWO block builders and they disagreed
about images. The PROCEDURAL path printed an artifact's own cover
(`artifactBlock` → `artifactDetail(…, { covers: true })` → `artifactCoverContent`)
and every encounter's map plate, while the PLANNED path — every real export since
docs/17 row 139, because the export always plans — built its companion with
`roleDetail(role, artifact, state)`, which returned `dataSections +
artifactLinksContent` ONLY. The section printed the images the LLM's plan
happened to anchor and nothing else, and `hasImage` was `section.images.length >
0`. So an NPC's or a location's own picture appeared only when the model happened
to anchor that id in that section — a REGRESSION in behaviour introduced by the
planned path, not a missing feature.

| Surface | Covered by | State |
| --- | --- | --- |
| **The regression pin**: a PLANNED section whose artifact carries a cover prints that image with the plan anchoring NO image for it. The fixture's `The Old Tower` section anchors `[coverImageId]`; re-planned with every section's `images: []`, `COVER_MARKER` is still in the definition (and the plan's own anchor, when present, is not printed twice — the artwork is the row's) | `modulePdfPlan.test` (`prints an artifact’s OWN image wherever it is described, and the plan’s anchors as EXTRAS`) | ✅ |
| **An encounter's own map plate prints in the planned path too** — the same unanchored plan carries `MAP_MARKER` and the plate's own `"fit":[481.9,660]` (the cover art keeps `"fit":[450,320]`) | `modulePdfPlan.test` (same pin); `pdfLayout.test` (`prints the artifact’s OWN cover and map plate in a PLANNED document with no anchors at all`) | ✅ |
| **The NPC gallery prints a portrait**: the fixture's `Unplanned Bystander` is an NPC the plan gives NO section, so the gallery is the only place she is described — and the page carrying her heading is the page carrying her `coverImageId`. The old `covers: false` (“no cover thumbnails (unchanged)”) was a FALSE claim | `modulePdfPlan.test` (`prints the NPC gallery’s portrait — the gallery is where an NPC is described`) | ✅ |
| **A role governs the mechanics, never the picture**: a plan whose ONLY section is the location with role `read-aloud` (and, separately, `aside`) prints `COVER_MARKER`, keeps its role treatment (`"style":"readAloud"`), and still carries NONE of the location's stored fields (`Inhabitants:` absent). This is ALSO the completeness guard above the §10.1 record: a section with no mechanics must not claim the row, or a later section's mechanics would print nowhere | `modulePdfPlan.test` (`still prints the artifact’s own image in a read-aloud or aside section`) | ✅ |
| **A plan anchor that is NOT the section's own picture still prints — the anchors stay meaningful as EXTRAS**: the NPC section deliberately anchors the LOCATION's cover, and the cover count goes 1 → 2 (and back to 1 when that one anchor is removed), so the second copy is really the anchor and not a duplicated own image | `modulePdfPlan.test` (`still prints a plan anchor the section does NOT own`) | ✅ |
| **A row with no image prints no image and no placeholder**; an image that EXISTS but is not in the preloaded set is LOUD: the planned document carries the alert box naming the site (`has a cover image that could not be embedded` / `it was not in the preloaded image set`) and the export's `problems` names `the cover of “Old Tower”` — never a silent drop. The count of image nodes in the unanchored fixture is exactly the three rows that own an image | `modulePdfPlan.test` (`is LOUD when a planned section’s own image exists but is not in the preloaded set`) | ✅ |
| **The preloader is the same decision as the renderer.** `buildModulePdf` used to narrow the preload to `resolveDocumentPlan`'s ANCHORED ids (plus the module cover), which is the defect's other half: the planned path preloaded exactly what it failed to print. It now preloads `imageInventories` — every scoped artifact's own images and the module cover — the set the renderer draws from in BOTH paths | `modulePdfPlan.test` (`pins the images at the budgets their own sites print at`, unchanged and green with the portrait now requested; the byte pins below) | ✅ |
| The differential's CONTENT-PRESERVATION sides are untouched: images are not text runs, so the pre-layout baseline (`pdfLayoutBaseline.json`) stays green and its loss side is still `toEqual([])`. The large fixture's plan anchored the location's cover and the encounter's map, which the row-based rule now dedups — no text run moves in either direction | `pdfLayout.test` (`loses not one text run…`, `adds exactly the page model’s own pointers and the navigation’s own lines, and nothing else`, the counts pin) | ✅ |
| The measured byte-determinism constants moved because the planned book now really carries the three images: definition characters 8030 → **8308** (the gallery portrait's image node, +278), rendered PDF bytes 59233 → **60505** (embedded XObjects instead of the loud “not in the preloaded set” alert). The load-bearing halves (`second === first`, `firstDiff: -1`) are UNCHANGED | `modulePdfPlan.test` (2) | ✅ |

**REVERT-PROVEN** (each injection applied to the exact executing line, the
modified file's hash PRINTED for every arm, restored from an out-of-tree copy and
re-hashed — the fixed tree is `modulePdf.ts`
`11930d4cf7dda003eecb7ded95657079ff60af3a`, identical before and after every arm;
no two arms produced the same file, so no arm is VOID):

| arm | injection | red |
| --- | --- | --- |
| **A** | none — the fixed tree, on `modulePdfPlan.test.ts` + `pdfLayout.test.ts` | **0 — 59/59 green** |
| **B** | the PLANNED path reverted to `roleDetail` alone (`{ artwork: [], mechanics: dataSections + artifactLinksContent }`, i.e. plan-only images; hash `b7f9fc6d…`) | **8** — the own-image pin, the extras pin, the read-aloud/aside pin, the LOUD pin, the large-fixture planned-image pin, PLUS three pins that measure the document as a whole (`renders GM and player from ONE plan`'s map assertion, and the two byte-determinism constants, whose numbers a plan-only document no longer matches) |
| **C** | the NPC gallery back to `covers: false` (hash `0c0ac8bd…`) | **4** — the gallery-portrait pin, the own-image pin's portrait count, and the two byte-determinism constants |
| **D** | `artifactCoverContent`'s unembeddable branch replaced by a SILENT `return []` (no problem, no alert box; hash `538b5984…`) | **1** — exactly the LOUD pin, with the alert box and the `the cover of “Old Tower”` problem gone |

**WHAT THESE PINS CANNOT PROVE.** jsdom asserts DEFINITIONS, never a rendered
page: the pins prove the right image NODE is in the document (and, for the
gallery portrait, on the row's own page), not how the picture LOOKS or whether
pdfmake scales a portrait inside the ≤45% column the way the eye expects (the
rendered-image evidence in the repo remains `modulePdf.test`'s `/Subtype /Image`
pin for the procedural path). No test proves a live model anchors sensible extras;
and no test can prove an image that fails to DECODE for a row the plan dropped is
a failure the owner wants reported — the preloader now loads the whole scoped set,
so such a failure is LOUD by the same rule as every other image failure (AGENTS
rule 2).

**THE LANDING GATE** (`bash scripts/gate.sh`, one run on the REBASED tree, raw log
kept, exit 0): GATE GREEN **319 files / 4120 tests**,
`chunk arithmetic: 319 of 319 test files covered`, lint 0 errors, typecheck
clean, combined peak RSS **2338 MB of the 3000 MB cap**, voided chunks 0 —
**+5 tests** over the rebased base's 319/4115 (row 184's landing), and
`tests/lib/mob-spells-pdf.test.ts` (row 184's PDF spell pin) stayed green
through the mechanical union recorded in docs/17 row 187.

### A section's ONE sidebar companion — the row it introduces beside its own text (docs/17 row 188, docs/19 §4/§5)

The owner, verbatim: *"Ideally important NPCs should be introduced in a sidebar
where the story introduces them. I understand that the sidebar can get crowded
though, thats where an LLM needs to make an intelligent judgement call."*

**THE INTENT IS A DIVISION OF LABOUR**, and the pins measure both halves: the
PLANNER decides WHICH introductions earn a scarce sidebar (the judgement call),
and the RENDERER decides WHERE the block fits (the existing §5 ladder). The
measured gap before this row: a section named exactly ONE `source`, and its DETAIL
companion was derived from that SAME source, so an NPC's profile could only print
where the NPC's OWN prose ran — never beside a PART's story text.

| Surface | Covered by | State |
| --- | --- | --- |
| **The schema accepts a companion and materializes NO key for absence**: `.nullish()` (never a default), so a plan stored before the field existed re-serializes unchanged and `'companion' in section` is false | `documentPlan.test` (`accepts a companion and materializes NO key for a section that has none (docs/17 row 188)`) | ✅ |
| **An unknown companion id is a NAMED failure of the whole plan** (`it names companion <id>, which this module neither owns nor mentions`) — never a silent skip, never a guess | `documentPlan.test` (`reports an UNKNOWN companion id by name — a failure of the WHOLE plan, never a skip (docs/17 row 188)`) | ✅ |
| **An encounter may not be a companion**, refused with its reason (roster/tactics/treasure/map are §4 own-page material and `detailPlacement` reads the section's source kind); a companion that IS the section's own source is refused too | `documentPlan.test` (2 pins: `refuses an ENCOUNTER as a companion, stating the reason`, `refuses a companion that IS the section’s own source`) | ✅ |
| **The prompt the model sees delegates the scarcity judgement** — `THE SIDEBAR IS SCARCE`, `That judgement call is YOURS`, the two refusals, "the renderer MOVES a heavy companion … never dropped, shortened or clipped", and the reply shape `"companion": { "artifactId": string } \| null` | `modulePlan.test` (`delegates the sidebar judgement to the planner`) | ✅ |
| **THE OWNER-VISIBLE OUTCOME**: a PART-sourced section naming an NPC companion prints the part's story in the MAIN column and the NPC's profile (`Vexra` / `Appearance: Hooded` / `Personality: Cold`) in the SAME page's SIDEBAR, and the row is not described again by the NPC gallery (her appearance run occurs exactly once) | `modulePdfPlan.test` (`prints an introduced NPC’s profile in a PART-sourced section’s sidebar`) | ✅ |
| **Additive for an artifact-sourced section**: the location keeps its own mechanics (`Inhabitants:` … `gulls and one ghost`) AND gains the companion (`Hooded`) | `modulePdfPlan.test` (`keeps an artifact-sourced section’s own mechanics AND gains its companion`) | ✅ |
| **THE STORED-PLAN COMPATIBILITY / BYTE-DETERMINISM PIN**: a plan with no `companion` key parses unchanged (no key materialized) and produces the SAME measured definition the byte-identity pin states (8308 characters) | `modulePdfPlan.test` (`renders a stored plan with NO companion byte-identically, and materializes no key`) | ✅ |
| **§10.1 governs a repeated COMPANION**: one NPC introduced by TWO part-sourced sections prints ONCE, the later section carries the link back LINKED to `node-plan-0`, the wiki-link to the NPC jumps to the introducing section, and the gallery has no `node-<npc.id>` anchor | `pdfLayout.test` (`prints a companion named by TWO sections ONCE, and the later one carries the §10.1 link back`) | ✅ |
| **The plan surface SHOWS the companion** (`Sidebar companion: Vexra · npc`) — a decision nobody can see is a decision nobody can correct | `module-plan-dialog.test` (`shows the ONE companion a section introduces in its sidebar`) | ✅ |

**REVERT-PROVEN**, five arms, every changed file's hash PRINTED (`git hash-object`),
NO two arms identical (no VOID arm), the fixed tree restored by `trap` from an
out-of-tree copy and re-hashed identical after every arm (`modulePdf.ts`
`9d567fd088acd0cc79d510243fb3ba597c83050d`, `documentPlan.ts`
`ca62944884dab370796176815c7f0d1d7826a050`) — the five changed test files run
together, `119 passed (119)` at arm A:

| arm | injection | hash | red |
| --- | --- | --- | --- |
| **A** | none — the fixed tree | `modulePdf` `9d567fd0…`, `documentPlan` `ca629448…` | **0 — 119/119 green** |
| **B** | the companion ignored by the renderer (`if (companion !== null)` → `if (false && companion !== null)`, so the introduced row's detail is never composed) | `febee76b…` | **3** — the part+NPC-sidebar pin (pin 3), the companion-twice once-rule pin (pin 5) and the additive pin |
| **C** | §10.1's once-rule bypassed (`companionOnce` returns the detail instead of `earlierDetailMarker`) | `c710d57e…` | **3** — the companion-twice pin (pin 5), the pre-existing §10.1 pin, and `prints the own-page artifact’s details AND prints no page that is only the announcement` (reprinting a companion moves the pages) |
| **D** | an unknown companion id becomes a SILENT SKIP (`if (row === undefined) continue;`) | `5d3261f1…` | **1** — exactly the unknown-id pin (pin 1) |
| **E** | the schema materializes a key for absence (`.nullish()` → `.nullish().default(null)`) | `445bdb48…` | **2** — the schema no-key pin and the stored-plan byte-identity pin (pin 4) |

**WHAT A TEST CANNOT PROVE.** jsdom asserts DEFINITIONS, never a rendered page:
the pins prove the profile NODE is in the section's SIDEBAR column and on the page
carrying the part's heading, not how it LOOKS or whether pdfmake wraps the
companion's name heading inside the 60 mm column as the eye expects. No test can
prove a live model picks SENSIBLE introductions to companion — that judgement is
the model's by the owner's own delegation; the app can only SHOW the decision
(`module-plan-dialog`), refuse an illegal one by name, and never clip the result.
And the `event` asymmetry (an encounter is refused as a companion, an event is
not) is a DECISION, not a proof: an event's stored detail is flow content the §5
ladder places by measurement and its own art still triggers §4's own-page arm
through `hasImage`.

**THE LANDING GATE** (`bash scripts/gate.sh`, one run on the fixed tree, raw log
kept, exit 0): GATE GREEN **319 files / 4130 tests**, `chunk arithmetic: 319 of 319
test files covered`, lint 0 errors, typecheck clean, combined peak RSS **2360 MB of
the 3000 MB cap**, voided chunks 0 — **+10 tests** over the base's 319/4120 (row
187's landing), exactly the new pins (4 in `documentPlan.test.ts`, 3 in
`modulePdfPlan.test.ts`, 1 each in `pdfLayout.test.ts`, `modulePlan.test.ts` and
`module-plan-dialog.test.tsx`), with no new test file.

### §7 navigation — links everywhere, back-references, one companion with a link back (docs/17 row 151, docs/19 §7/§10)

**The slice this section documents was recovered from a writer killed mid-run by
the OOM killer**, and its draft did not compile (three half-finished edits; row
151 names each one). Everything below is measured on the repaired tree.

| Surface | Covered by | State |
| --- | --- | --- |
| **§7 bullet 1**: every `[[wiki-link]]` of the module's own text (premise, parts, artifact bodies) is an internal link to where that row prints — pinned on the DESTINATION (`node-<location.id>`), not on “a link exists”, because a link that jumps elsewhere is exactly the defect the bullet forbids; the target node is separately pinned to print the row's own name | `pdfLayout.test` (`links the document's own wiki-links to where that row PRINTS, by the row's own destination`) | ✅ |
| **A name the document does not print stays a plain bold run** — `[[Marek]]` is LINKED in the procedural document (he prints) and has NO link in the planned document (the plan gives him no section and he is not an NPC). An absence and a presence on ONE name, so neither half can pass vacuously; pdfmake throws on a dangling `linkToDestination` | `pdfLayout.test` (`leaves a name this document does NOT print as plain bold text (never a dangling link)`) | ✅ |
| **No document emits a link to a destination it does not carry** — every `linkToDestination` in FIVE definitions names an `id` the same definition carries, including BOTH player documents (§7's fourth bullet: the audience split stays) and the small module. This is the pdfmake contract a definition-level suite cannot observe as a throw | `pdfLayout.test` (`never emits a link to a destination the same document does not carry, in any audience`) | ✅ |
| **§7 bullet 3**: an artifact section states where it is referred to from — the line decodes to `[{Premise → node-premise}, {The Dockyards → node-part-0}]` in READING order, and is asserted to sit on the ROW'S OWN page | `pdfLayout.test` (`states where an artifact is referred to from, as internal links to those places`) | ✅ |
| **A row the text never names states NOTHING** (no empty `Referenced from:`, which would be a claim the text does not support) — the omission fixture's owned orphan, beside its sibling that does state one | `pdfLayout.test` (`states NOTHING for a row the document's own text never names`) | ✅ |
| **§10.1 — the owner's “ONCE, with a link back”**, pinned in BOTH directions on a FOURTH fixture (one encounter named by TWO plan sections; an encounter because §4 sends that kind to its own page, so the two references land on two SEPARATE pages and a pin can tell them apart): the first section's page carries the mechanics and NOT the pointer, the later one the pointer and NOT the mechanics, the pointer's only link is the FIRST section's anchor, and over the whole document each half appears EXACTLY once | `pdfLayout.test` (`prints the companion at the FIRST reference and the link back at the later one`) | ✅ |
| The differential's added-runs equality, updated deliberately and exactly (see the table below for the numbers) | `pdfLayout.test` (the `toEqual` named above) | ✅ |
| The pre-existing deterministic-byte pins still hold, with their “and states the number” half moved: planned definition 6973 → 8095 characters, rendered PDF 51183 → 59215 bytes. The load-bearing halves (`second === first`, `firstDiff: -1`) are UNCHANGED | `modulePdfPlan.test` (2) | ✅ |
| **§7's second bullet (a TOC with PAGE NUMBERS) is NOT built** — the `chapters` TOC prints without them, exactly as docs/19 §7 says; the builder is definition-only and knows no page | nothing — stated so it is not mistaken for done | ❌ not built |
| The whole PDF neighbourhood, re-run after every step | 14 files / 179 tests: `pdfLayout`, `modulePdf`, `modulePdfPlan`, `pdfExport`, `provenance-export`, `wiki-raw-export`, `roster-reference-parity`, `fileSlug`, `text-blocks`, `mdToPdfmake`, `wiki-token-grammar`, `cover-storage`, `module-pdf-export`, `entity-intent-brief` | ✅ |

**THE DIFFERENTIAL'S NUMBERS, before → after** (same extractor both sides; the
BEFORE column is the pre-layout renderer's baseline in `pdfLayoutBaseline.json`):

| document | runs (pre-layout) | runs (row 148) | runs (row 151) | strings (row 151) |
| --- | --- | --- | --- | --- |
| large-procedural | 217 | 220 | **244** | 159 → **161** |
| large-planned | 163 | 165 | **183** | 130 → **132** |
| small-procedural | 53 | 53 | **57** | 48 → **49** |

**The ADDED runs are one back-reference line per artifact section that is referred
to from somewhere** — `Referenced from: ` + one LINKED run per place + a ` · `
separator (large-procedural has 8 such lines, four of which name two places) — and
the only two new STRINGS are `Referenced from: ` and ` · `, because every place
LABEL already printed as a heading. **The list's ORDER is the DIFF's, not the
document's, and the recovered draft got exactly that wrong:** `missingRuns`
consumes the BEFORE multiset greedily as it walks the after document, so an added
run whose text the pre-layout document also printed elsewhere is credited to
whichever occurrence the walk reaches first (`A Word on the Tide` is a heading in
both documents, so both of its added instances land at the END of
`large-planned`'s list). The assertion keeps the measured order and says so.

**ASSERTIONS CHANGED: 5, all counted, none weakened** (no `toEqual` became a
`toContain`, nothing deleted):

| # | file | assertion | before → after |
| --- | --- | --- | --- |
| 1 | `pdfLayout.test` | the added-runs `toEqual` | list extended with the navigation's runs, order corrected to the measured one |
| 2 | `pdfLayout.test` | that pin's NAME | `adds exactly the page model's own pointers, and nothing else` → `adds exactly the page model's own pointers and the navigation's own lines, and nothing else` |
| 3 | `pdfLayout.test` | the counts `toEqual` | 220/159, 165/130, 53/48 → 244/161, 183/132, 57/49 (the BEFORE column is unchanged: 217/156, 163/128, 53/48) |
| 4 | `modulePdfPlan.test` | planned definition characters | 6973 → 8095 |
| 5 | `modulePdfPlan.test` | rendered PDF bytes | 51183 → 59215 |

**NEW PINS, BY NAME** (6, all in `pdfLayout.test.ts`, which went 19 → 25):
`links the document's own wiki-links to where that row PRINTS, by the row's own
destination`; `leaves a name this document does NOT print as plain bold text
(never a dangling link)`; `never emits a link to a destination the same document
does not carry, in any audience`; `states where an artifact is referred to from,
as internal links to those places`; `states NOTHING for a row the document's own
text never names`; `prints the companion at the FIRST reference and the link back
at the later one`.

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back, `git diff --stat` taken before the run, restored from an OUT-OF-TREE copy
— never `git checkout --` — and re-hashed with `git hash-object`, identical
before and after every one: `modulePdf.ts`
`7f8dbee2187ae774d96d3852d55d37086b7092f9`, `pdfPageModel.ts`
`35f6661c19bf3711e5505dfe5c1cb2e9fdef18f2`):

| injection | what it does | RED / GREEN |
| --- | --- | --- |
| **I1** `earlierDetailMarker` drops the destination — the pointer prints as plain text, no link | the link back is gone while the sentence stays | **1 / 24** — exactly the §10.1 pin: `expected [] to deeply equal [{text: ‘THE DETAILS OF “THE BELL AMBUSH” PRINT EARLIER IN THIS DOCUMENT.’, destination: ‘node-plan-1’}]` |
| **I2** `companionOnce` links EVERY reference back instead of printing the companion | the non-vacuity direction the rule exists for | **7 / 18** — the §10.1 pin, AND the content-preservation differential (the mechanics print NOWHERE: `loses not one text run of the pre-layout renderer` reds with 136 missing runs), the added-runs equality, the counts report, the sidebar-mechanics pin, the own-page pin and the verbatim pin |
| **I3** `referencedFromContent` returns nothing — §7's back-reference line is never emitted | the whole bullet-3 rule is dropped | **4 / 21** — the added-runs equality, the counts report, the back-reference pin and the states-nothing pin |
| **I4** `artifactProse` drops ONE artifact's body while the page model is untouched | a body goes missing with the layout intact | **3 / 22** — the loss differential (`expected [ ‘The tower watches the ford.’, …(1) ] to deeply equal []`), the counts report and the verbatim pin. **The added-runs equality stayed GREEN** — which is exactly why the loss side exists: a differential that only counted ADDITIONS would have called a dropped body a clean document |

**WHAT THE PINS CANNOT PROVE.** jsdom asserts pdfmake DEFINITIONS, never a
rendered page. Three specific gaps: **(a)** the pdfmake link contract is checked
STRUCTURALLY — the suite proves every `linkToDestination` names an `id` the same
definition carries (the documented condition), and cannot observe what pdfmake
does when it holds, nor that a viewer follows it. **(b)** The pointer's VISUAL
consequence is unverified: when two referencing sections of a FLOWING kind land on
one page's sidebar, the companion and the pointer print in the same sidebar stack
(measured while building the fixture — it is why the §10.1 fixture uses an
encounter, which §4 sends to its own page), and whether that read is confusing is
a judgement this suite cannot make. **(c)** The double reference itself is the
FIXTURE's, not the planner's: `documentPlanIssues` permits a duplicate section and
whether a real plan makes one is a property of the model. **The one thing only the
owner can check in a real PDF:** follow one `[[wiki-link]]` in the premise and see
that it jumps to where that row prints; read the `Referenced from:` line at the
bottom of a row's own section and check the places it names are where that row is
actually talked about; and if a plan ever names one row twice, confirm the second
section shows the kicker sentence “THE DETAILS OF ‘X’ PRINT EARLIER IN THIS
DOCUMENT.” as a LINK, with the stat block printed ONCE, at the first of the two.

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
| **ONE press exports the PLANNED book**: the export entry point plans (exactly ONE model call through the ordinary transport seam), stores the plan on the row with the app's provenance, and the definition it hands the PDF generator is the PLAN's document — the procedural outline did not print (docs/17 row 139) | `module-pdf-auto-plan.test` | ✅ |
| **Every export plans — the stored plan is NOT a cache**: an export on a module that already holds a valid, fresh plan still calls the planner exactly once, and the stored plan is REPLACED by the new sections + the new `plannedByModel`/`plannedAt` | `module-pdf-auto-plan.test` | ✅ |
| **A planning failure is loud and never mistakable for success**: `toastError` with the planner's own cause, the failure named in the export's problems toast, NO success toast, the file still written, and the document stating on its own page which book it printed instead (the LAST STORED plan, else the procedural outline) — with NOTHING fabricated on the row | `module-pdf-auto-plan.test` | ✅ |
| The planning call reports through the shared progress seam while it is in flight (label + `Planning the document…`), and the job is gone when the export ends | `module-pdf-auto-plan.test` | ✅ |
| The export's WIRING: one planning call per press before rendering, and a failed planning reaches the renderer as `planFailure` while the export still lands | `module-pdf-export.test` | ✅ |
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
| The window is **SCOPED to the campaign's game system** (docs/17 row 207): a Pathfinder 2e campaign is offered NONE of the dnd5e-only creatures and the dnd5e mirror holds, while an UNSCOPED call still lists both (the non-vacuity half) | `llm/creatorRoster.test` (2 + the mirror). REVERT-PROVEN: dropping the `system` argument from the pool read REDs both |
| The UI surfaces stay **UNSCOPED on purpose** (docs/17 row 207 — the owner's decision): ONE bestiary browser lists a dnd5e AND a pf2e book's creatures, and the wiki-link pool resolves a creature of either system | `bestiary/roster.test` (1), `llm/creatorRoster.test` (1). REVERT-PROVEN: filtering either by a campaign system REDs it |
| The module's **PARTS rule excerpts** are scoped to the campaign's game system, and a same-system library's prompt is BYTE-IDENTICAL whether or not a foreign-system book is installed (docs/17 row 207) | `llm/moduleGen.test` (2, real retrieval + prompt byte comparison; an unscoped read of the same query is asserted to see BOTH markers). REVERT-PROVEN: removing `system` from `ruleExcerptSection` REDs the retrieval pin |
| The **CAST** refuses a cross-system citation loudly BY NAME (docs/17 row 207): the entity, the creature AND the system appear in the sentence, the same-system cast resolves in both directions, and an unscoped caller keeps the pre-207 pool — never a silent drop, never a substituted stat block | `features/entity-batch-creature-book.test` (3). REVERT-PROVEN: the throw replaced by a silent drop REDs the refusal pin |
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

### A batch failure is reported through ONE seam (docs/17 row 131, docs/18 §2.3/§4)

The owner ran module generation and got `4 of 10 npcs failed to generate` —
*"the error was a lot longer, vanished quickly though"* — and asked for it to be
*"a lot more expressive … and put it in the console"*. MEASURED before touching
anything: (a) `toastError` passes no `duration`, so sonner's `TOAST_LIFETIME`
(4000 ms) dismissed the batch's only record; (b) nothing on that path reached
`console.error`; (c) the count conflated a designed cast-creature refusal, a run
that did not complete, an interruption by page reload and a setup throw. The
cure is `features/modules/entity-batch-report.reportEntityBatchFailures` — ONE
call that raises a structured console entry (`[campaigner] <kind> batch: N of M
failed`) AND a PERSISTENT toast — fed by `EntityBatchFailure`'s new
`kind`/`runId`/`status`/`failureKind`/`errorMessage`/`raw`. The copy answers the
owner's real question (is my generator broken?) by stating each class
separately, while a batch of plain run failures keeps the old sentence byte for
byte.

The record is TWO entries per failure and TWO per batch, deliberately: the
pasteable line is a SINGLE string argument (a row that also carries an object
argument renders a devtools-specific, truncated preview into whatever gets
copied — the line is the deliverable), and the live object follows under its own
distinct tag (`[campaigner] entity-batch detail …`) so the line to copy can
never be confused with the object to expand. Every line is produced from the
object the console shows, so the two renderings cannot disagree.

| Surface | Covered by | State |
| --- | --- | --- |
| **The console payload, per path**: the greppable headline, the batch context, and per failure the name, WHICH path (`refused`/`interrupted`/`run-not-completed`/`setup-error`), the run id, the terminal status, the run's OWN `failureKind` + `errorMessage`, the engine's sentence, the raw value (by IDENTITY for the run row and a thrown error), and a ZodError's issues as objects | `tests/features/entity-batch-failure-report.test.ts` (7 pins; the REAL `lib/toast`/`lib/zodErrorSummary` run, only `sonner` is faked, and the console value itself is asserted) | ✅ REVERT-PROVEN: dropping the run id from the payload → RED 2/12 (the run path AND the refusal path); wiring the `setup-error` counter to the wrong bucket → RED 2/12 once the counter pin existed (and GREEN before it — below) |
| **The toast**: the byte-identical legacy sentence when every failure is a run failure, the class breakdown when it is not, each refusal naming the way out, an interruption named as NOT a generator failure with its way out, and NO "see the Runs tab" when no run failed | `tests/features/entity-batch-failure-report.test.ts` (5 pins) + `tests/features/entity-panel.test.tsx` (3 pre-existing pins, retargeted) | ✅ REVERT-PROVEN: raising the summary through `toastError` again → RED **6 across 3 files** (the duration pin `expected undefined to deeply equal { duration: Infinity }`, the legacy-sentence pin, the scan's rule-2 pin and the 3 panel pins) |
| **The DECISION it rests on**: the report is PERSISTENT (`duration: Infinity`), never sonner's 4-second default | `tests/features/entity-batch-failure-report.test.ts` (`is PERSISTENT: …`) — judged through the real `lib/toast` because a mocked seam could not see the options object at all | ✅ REVERT-PROVEN by the injection above (the same run reds this pin first) |
| **The notification's EXIT** (docs/17 row 136): the persistent notice carries sonner's close button (per toast, from the seam) and is removable by ONE activation found by accessible name, while the per-failure console record survives the dismissal byte-identical with the console call count unchanged | `tests/lib/toast-persistent-dismiss.test.tsx` (NEW — the real `Toaster` is mounted and the real seam is driven, so this is the only place the rendered control is judged; the row's `sonner`-mocked pins can see the option but never the control) | ✅ REVERT-PROVEN: `closeButton: true` → `false` on both branches (`src/lib/toast.ts:108,110`) → **RED 3/4 in that file** (plus the two option-object pins in `toast.test.ts`) with the TRANSIENT pin GREEN; the injected GLOBAL alternative (`components/ui/sonner.tsx:22`) → RED 1, exactly the transient pin |
| **An interruption is its own class**, carrying the row's `failureKind: 'cancelled'` beside `status: 'failed'` — the pair that separates "the page reloaded" from "the generator failed" | `tests/features/entity-batch-fixed-cast.test.ts` (`a run the PAGE killed is its OWN class…`, NEW) + the seam's payload pin | ✅ REVERT-PROVEN: classifying every failed run as `run-not-completed` → RED 1/9 in that file, every other suite GREEN |
| **A designed CAST is not a failure** (row 117's rule at this surface): the cast path reports NOTHING, runs no model call, and lands a row carrying `creatureRef` | `tests/features/creature-row-resolution.test.tsx` (`a designed CAST is a SUCCESS…`, NEW, driven through the panel button with a recorded `bestiary` slot) | ✅ REVERT-PROVEN: pushing a failure onto `failed` at the cast arm → RED 1/7 (the panel's own catch surfaces it because the file's `@/lib/toast` mock has no `toastErrorPersistent`) |
| **The record exists EVEN WHEN THE BATCH NEVER REACHES ITS END REPORT** (the owner's refinement: *"the root problem is simply not recorded"*) — `runEntityBatch` called on its own, with no caller reporting, writes one record per failure as it happens, carrying entity, path, run id, terminal status, sentence and the batch context | `tests/features/entity-batch-fixed-cast.test.ts` (`the failure is WRITTEN DOWN when it happens …`, NEW; a console spy replaces the guard's wrapper) | ✅ REVERT-PROVEN: appending around the funnel → RED the scan's one-push pin; polluting the pasteable line with the object argument → RED this pin AND the seam's single-argument pin |
| **The pasteable TEXT form**: `[campaigner] entity-batch failure {…}` per failure and `[campaigner] entity-batch summary {…}` per batch, each a SINGLE string argument, each carrying every discriminating field, the summary line deep-equal to the summary object, and an unserializable value producing a line that says so instead of throwing | `tests/features/entity-batch-failure-report.test.ts` (4 pins) | ✅ REVERT-PROVEN: building the summary line from a different object → RED 1 (the deep-equality pin); giving the pasteable line a second argument → RED 2 (here and in the batch suite); restoring the `kind` collision → RED 3 across two files |
| **The ROUTING** — exactly the two call sites go through the seam, the count sentence is composed in exactly ONE file, no call site re-states it, ONE funnel appends to the batch's failure list (and writes it down), the seam's per-failure entry point has exactly one caller, the tags are distinct and the seam raises BOTH surfaces (never console-only) | `tests/features/entity-batch-failure-report-scan.test.ts` (`scan`, 7 pins, labelled as scans, >200-file non-vacuity check, allowlist-rot check) | ✅ REVERT-PROVEN: each fold re-inlined at its own call site REDs 3 scan pins while the SWEEP's behavioural suites stay GREEN; a failure arm appending around the funnel REDs the one-push pin (below) |
| **REGRESSION GUARD — the pre-existing pins**: 296 files / 3395 tests at `origin/main` @ `9944fcc` before the change, and 298 files / 3417 tests after it, `CAMPAIGNER_TEST_WORKERS=2 pnpm exec vitest run` exit 0 | the full gate | ⚠️ FIVE pre-existing pins could NOT pass unchanged, and both reasons are MEASURED rather than assumed: `toEqual` fails on an extra DEFINED property (2 pins in `entity-batch-fixed-cast.test.ts` asserting the failure record) and `toHaveBeenCalledWith('msg')` fails when the call carries a second argument (3 pins in `entity-panel.test.tsx`). Both were updated to STRICTER assertions (the full record; the persistent helper), never loosened, and both are attributed in the report |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n`, `git diff --stat` checked BEFORE the run, then
restored from a byte-exact baseline copy and verified with `git hash-object` —
`entity-batch.ts` `8db7636f2d01770eae2fce17c51b2f8ef9245f86`,
`entity-batch-report.ts` `f525dc6dbcd889185fe18c93128b17c342939c41`,
`entity-panel.tsx` `98ecccbd3dc2200422273bf4642257e444fc6c77`,
`post-generation.ts` `d560f465ba178ac380d78a31ccfb09c0626e458d` — all four
matched after restore; one suite at a time at `CAMPAIGNER_TEST_WORKERS=2`):

| injection | line it hits | result |
|---|---|---|
| **I1a — the SWEEP's fold reverted** to its hand-rolled copy (the pre-change shape, `${kind}s`) | `post-generation.ts:321` | **scan RED 3/5** (the seam-call-set equality, the one-composer equality, the needle loop) while **32 behavioural pins stayed GREEN** (`module-post-generation` + the seam suite) — a byte-identical fold is invisible to behaviour |
| **I1b — the PANEL's fold reverted** the same way | `entity-panel.tsx:756` | **RED 6**: the same 3 scan pins PLUS the 3 panel summary pins (those assert the persistent helper, which the reverted copy does not use) |
| **I2 — the run's identity dropped** (`runId: failure.runId ?? null` → `runId: null`) | `entity-batch-report.ts:70` | **RED 2/12** (the run-path pin and the refusal pin), scan **GREEN** — the payload's EVIDENCE is held behaviourally |
| **I3 — the summary raised through the TRANSIENT helper** again | `entity-batch-report.ts:207` | **RED 6 across 3 files** (the duration pin, the legacy-sentence pin, the scan's rule-2 pin, the 3 panel pins) |
| **I4 — every failed run classified `run-not-completed`** (the interruption class conflated away) | `entity-batch.ts:645` | **RED 1/9** in `entity-batch-fixed-cast.test.ts`; the seam, scan and panel suites **GREEN** |
| **I5 — the `setup-error` counter wired to the `run-not-completed` bucket** BEFORE the counter pins existed | `entity-batch-report.ts:122` | **GREEN 55/55 across 4 files — the one line of this change NO pin reached**; the class counters were carried in the payload and asserted nowhere |
| **I5b — the same injection AFTER pinning every class counter** in the two payload tests | same line | **RED 2/12** — the blind line is now covered, which is why the counters are pinned |
| **I6a — the OLD copy ADDED BESIDE the surviving seam call** (call set unchanged, plain spelling) | `post-generation.ts:328` | **scan RED 2/5** (the one-composer equality + the needle loop); the seam-call-set pin stayed **GREEN**, which is exactly why the needles exist |
| **I6b — the SAME sentence rebuilt from pieces beside the surviving call** (`['failed','to','generate'].join(' ')`, `${kind}s`, `String.fromCharCode(59)`, `'see the '+'Runs '+'tab'`) | `post-generation.ts:328` | **GREEN 35/35 across 3 files — the MEASURED hole** (below) |
| **I7 — a designed CAST pushed onto `failed`** as well as `cast` | `entity-batch.ts:527` | **RED 1/7** — exactly the new "a designed CAST is a SUCCESS" pin |
| **I8 — one failure arm appends AROUND the funnel** (`recordFailure` → `failed.push`) | `entity-batch.ts:677` | **scan RED 1/7** (the one-`failed.push` pin: `expected [ 'failed.push(', 'failed.push(' ] to have a length of 1`) and the batch suite **GREEN 9/9** — the append still happens, only the RECORD is lost, which is precisely the failure mode the pin exists for |
| **I9 — the pasteable line given a SECOND argument** (the object appended to the same call) | `entity-batch-report.ts:284` | **RED 2** — the seam's single-string-argument pin and the batch suite's moment-of-failure pin; the faithfulness property is held in two files on purpose |
| **I10 — the summary line built from a DIFFERENT object** than the payload the console shows | `entity-batch-report.ts:302` | **RED 1** (`expected { campaign: …, failed: 2 } to deeply equal { campaign: …, …(9) }`) — the line and the object cannot drift |
| **I11 — the batch kind and the failure kind collide under `kind`** again | `entity-batch-report.ts:120` | **RED 3** across two files (`expected undefined to be 'npc'` three times) — the two-meaning key is caught, and it was NOT caught before the pins existed (the collision was found by writing the pin) |

**The scan's own limits, MEASURED (docs/18 §4).** A needle list quotes a
SPELLING, so the attack the scan was NOT designed for (I6b) walked straight
through it: rebuilding every fragment of the sentence — the phrase, the plural,
the joiner, the tail — left the scan GREEN 5/5 and all 35 behavioural pins
GREEN, because the call set, the sentence-holder scan and the four needles all
read the SOURCE TEXT of a copy that no longer contains any of those strings.
What still catches I6b is nothing in this suite: the hole is stated here so the
next reader does not read "5 scan pins" as "the fold cannot be reopened". The
same measurement decided which needles exist: a `.join('; ')` needle was tried
FIRST and reddened on healthy code in both files (`entity-panel.tsx:678`,
`post-generation.ts:453`) — a needle that fires on correct code gets deleted, so
the defect shape is caught by naming the sentence's own tail (`see the Runs
tab`) instead. The needle loop also short-circuits on the first match, so a
red run names one needle and not the others; the per-needle count is not what
the pins assert. The needle list is comment-BLIND, which is why
`entity-batch.ts`'s historical quote of the old toast is a KNOWN holder in the
one-composer pin ("2 of 5 npcs failed to generate" inside a doc comment) rather
than a surprise red.

### A barrier must cover the FIELD it asserts (docs/17 row 132, docs/18 §4)

`tests/features/creature-row-resolution.test.tsx`'s "lands a module-owned npc of
the exact name for a LIBRARY-only name" failed once in a full-suite run — one
failure in 3417 tests, and 0 in the eight sequential unloaded runs the read-only
probe took (0 in two more here). The failing assertion was the row's
`module:Ember Crypt` tag. The cause was NOT the app: the test's barrier covered a
state the product reaches BEFORE the field the test asserts.

**The mechanism, at the base commit `0425eb4`.** Per target, the batch starts a
run, waits for it, then aligns the row's name to the exact entity name —
`features/modules/entity-batch.ts:639` calls `alignEntityName` (`:94`), whose
`artifactRepo.updateArtifact` (`:111`) is the write that makes the row
observable with the right `name`, `moduleId`, no `creatureRef` and the right
`summary` (rev 2). The `module:<title>` compatibility tag is stamped only AFTER
`mapConcurrency`/`mapWithConcurrency` has drained the WHOLE target pool, in the
post-batch loop at `:691-703` (`getArtifact` `:696`, the idempotence test `:697`,
`stampModuleOwnership` `:698`) (rev 3). Between rev 2 and rev 3 the row is
visible without its tag. The test's barrier (`:465-471` at the base commit,
`:477-484` once the cure's comment lines were added above it) asserted only that
ONE row of that name exists, so it was satisfied by rev 2 — and the tag
assertion that followed raced rev 3. Measured gap rev2→rev3
unloaded: ~2 ms against `waitFor`'s 50 ms poll interval, hence ~1 in 3417 under
load and 0 unloaded.

**The delay experiment, both directions** (the `89e5d71` method; one suite at a
time, `CAMPAIGNER_TEST_WORKERS=2`, output kept in full). Injected immediately
before `const artifact = await artifactRepo.getArtifact(artifactId);` in the
post-batch stamp loop:

```ts
await new Promise((r) => setTimeout(r, 300));
```

- **UNFIXED + delay → RED 4/4** (four sequential runs), all four
  `AssertionError: expected [ 'undead' ] to include 'module:Ember Crypt'` at
  `tests/features/creature-row-resolution.test.tsx:477:22`. That is the SAME
  assertion the cure leaves at `:490` (the cure moved nothing — it added lines
  above it), and `:477` is where every line reference in this section's forensics
  note comes from. 300 ms and not the probe's 3000 ms on purpose: a delay longer
  than `waitFor`'s 1000 ms default timeout reds the test by TIMEOUT, which proves
  nothing about where the barrier stops.
- **FIXED + the SAME delay still injected → GREEN 3/3** (7/7 tests). That is the
  proof the barrier now covers rev 3 rather than merely ending later.
- **Injection REMOVED → GREEN 3/3** (`git checkout --` on the file;
  `git hash-object src/features/modules/entity-batch.ts` =
  `645bb743d67bc1417feba04e1961e1bffbe0cb02` before and after, and `git diff`
  empty for it).
- **Control, unfixed and WITHOUT the injection → GREEN 2/2.** The race is latent,
  which is exactly why it was invisible until the cause was delayed — a green run
  is not evidence for this class in either direction.

**The cure.** The tag assertion moved INSIDE the barrier (`:482`), the pattern
`tests/features/entity-panel.test.tsx:765-771` already uses on this same batch —
a barrier must cover the FIELD being asserted, not merely the row's existence.
Waiting on the batch's completion signal instead was considered and declined: it
would pin the assertion to a UI proxy for "the pool drained" (the panel's own
label), a SECOND fact that can drift from the stamp loop, while asserting the tag
inside the wait is a direct read of the asserted field and needs nothing new. The
assertion stays at `:490` as well — it is the pin, and it can no longer race.
`flushAsyncUpdates` (`:509`) and `actDrained` are NOT part of this cure: they
drain pending React updates, and no amount of draining makes the stamp happen
sooner.

**The app is NOT changed, and the intermediate state is benign — do not "fix"
it.** The tag is a compatibility marker whose only readers are the batch's own
idempotence check (`entity-batch.ts:697`) and the cast re-stamp
(`db/creatureRepo.ts:580`); no UI surface filters on it. A row that is
module-owned from birth (`placementModuleId`, `entity-batch.ts:587-589`) and
tagged a few milliseconds later is the designed revision order, and stamping
earlier would buy an extra revision (or a differently-timed write) to satisfy a
test. If that ordering ever matters to a product surface it is a design question
with its own ledger row, never a test cure.

**The same shape at the cast test (`:571-578`) is SAFE, measured rather than
assumed, and was left untouched.** `db/creatureRepo.castCreatureAsNpc` writes
`tags: [moduleTag]` (`:595`), `moduleId` (`:596`) and `data.creatureRef` (`:605`)
in ONE `createArtifact` call — one transaction — so the row's existence and the
`creatureRef` that test asserts (`:581`) become observable together, and the cast
arm runs before any run is started (`entity-batch.ts:522-543`). Confirmed by the
injection above: that pin stayed GREEN in all four RED runs.

**The forensics lesson, which cost a separate investigation.** The original
sighting's evidence was destroyed by piping the gate through `tail -10`, and the
surviving tail MISATTRIBUTED the failure: **a gate tail that ends on a code-frame
line N can be an N−2 failure, because vitest prints context lines.** A real
`:479` failure prints its caret under 479 and continues to `:481`; the observed
tail ended at `:479` and was a `:477` failure. This run reproduces that exact
shape: the RED above ends its frame at `479|` with the caret under `477|` and
prints nothing beyond — indistinguishable, in a `tail`, from a `:479` failure
whose context line happened to be last. Hence `AGENTS.md` §Workflow: write the
gate's raw output to a file and keep it; never pipe it through `tail`/`head`.

### EVERY NPC the module's text produced gets an AUTHORED description (docs/17 rows 133/135, docs/18 §2)

The owner's report is that an NPC the module's TEXT names (*"even if its just a
zombie"*) gets a portrait and nothing else; his ruling on the fix reverses part
of row 133, verbatim: *"An NPC is named if its a wikilink in the module text.
Because that link IS the name."* / *"Author a description anyway."* Row 133 had
made the description conditional on a text measurement — the seam
`lib/wikilinks.describesEntity` and its floor `ENTITY_DESCRIPTION_FLOOR = 40`,
asked over the module's paragraphs and over the row's own body. Both the seam and
the floor are DELETED, and both early returns are gone: the cast keeps everything
(the citation is the identity, the numbers stay the library's, the portrait cache
still supplies the image), the module's mention rides the brief as CONTEXT, and
the PROSE is always authored through the cited row's existing refill. **The fact
that makes the deletion safe:** `batchTargets` is
`namesOfKind(module, kind).filter(… !hasDetailedEntity(…))` and `namesOfKind` is
`extractWikiLinks(moduleDocumentText(module))` — every target is BY CONSTRUCTION
a wiki-link of the module text, so the floor's "the text never mentions her" case
was UNREACHABLE, and the no-clobber guard is replaced by the target set (a name
with an authored, detailed row is not a target at all).

| fact pinned | where |
|---|---|
| **A batch target IS a wiki-link of the module text** — a name the spine RECORDED but the text never wrote is not work and cannot be a target; the target set is exactly the text's links of the recorded kind; an ALIASED `[[Name\|alias]]` contributes the TARGET name, never the epithet the text renders | `tests/features/module-post-generation.test.ts` (`batchTargets — a target IS a wiki-link of the module text`, 4 pins, NEW, pure) |
| **The DESCRIBED side is now the same case as the thin side** (the owner-ruled inversion): real prose about her → exactly ONE run, and the row's `body` IS the authored text, not the module's paragraph — while the module's own sentence is asserted to have reached the run on the TRANSPORT PAYLOAD ("the brief carries it as CONTEXT") | `tests/features/entity-batch-cast-description.test.ts` (2 pins, NEW) |
| **A row that carries a description can never be re-targeted**: after the description lands, `batchTargets` is empty for that name, and the batch fed exactly that set spends nothing and rewrites nothing — the guarantee that replaced row 133's no-clobber guard, pinned end to end | `tests/features/entity-batch-cast-description.test.ts` (NEW) |
| **The ALIASED link**, through the REAL engine: `[[Aunt Agatha\|Müllerin]]` — the name nowhere in the rendered prose (asserted with `stripWikiLinks`) — still produces an authored description, and the raw token reaches the run | `tests/features/entity-batch-cast-description.test.ts` (NEW) |
| **The THIN+eval side, end to end through the REAL engine** (only `@/llm/openrouter`'s chat, `@/search` and `@/lib/toast` are faked): a bullet that only names her → the entity stays in `cast`, `generated` is empty, `failed` is empty, the row's `body` is the AUTHORED text with appearance/personality written, the citation's `chunkId`/`creatureName`/`contentHash` all intact, `statBlock` null, the module's name unchanged with the model's invented epithet landing as an ALIAS, **exactly ONE transport call** (the statblock step is `'skipped'` with a reason naming the library creature before any model call), and no toast | `tests/features/entity-batch-cast-description.test.ts` |
| **A failed description is LOUD and the cast stands**: a failing transport → one `failed[]` record (`kind` `run-not-completed`, the run id, the terminal status, `errorMessage`, the raw run row), the console record parsed out of the batch's ONE funnel, the row keeps its citation and its thin `body` — the case a name appears in BOTH `cast` and `failed`; the completion-without-a-result anomaly carries its OWN sentence, and the run's class mapping (`failureKind: 'cancelled'` → `interrupted`, status `failed`) is pinned BESIDE it | `tests/features/entity-batch-cast-description.test.ts` + `tests/llm/moduleGen-cast.test.ts` |
| **A withdrawn run is silent at this arm too** (the owner's Stop, not a failure): no `failed` entry, no toast, the cast still listed | `tests/llm/moduleGen-cast.test.ts` |
| **The run is aimed AT the cast row**: `targetArtifactId` is the cast row's id, `placementModuleId` absent, and the brief carries the module's paragraph as CONTEXT — including the reused-row case (an EARLIER cast's row is refilled, never twinned) | `tests/llm/moduleGen-cast.test.ts` (3 pins, REWRITTEN — their premise was the deleted floor) |
| **The INVERSION at the panel**: a designed cast is still a SUCCESS (nothing reported), its barrier now waits for the AUTHORED body and asserts exactly ONE transport call — it previously stopped at the row's birth and passed on a race | `tests/features/creature-row-resolution.test.tsx` (REWRITTEN) |
| **The DELETED seam stays deleted** — `describesEntity` / `ENTITY_DESCRIPTION_FLOOR` appear nowhere under `src/` or `tests/` (one exclusion, by exact path: the scan file itself, whose header names what it buries), and the cast branch holds no `return` between its guard and the authoring `startRun` (comments stripped, with slice-sanity assertions) — **labelled as a scan: it cannot see a DEAD CONDITION**, which is why the behaviour is pinned through the real engine above | `tests/features/entity-batch-cast-description.test.ts` (`the deleted description seam stays deleted (source scan)`) |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n` and `git diff --stat` checked BEFORE the run, then
restored from a byte-exact OUT-OF-TREE copy and re-verified with `git hash-object`
— `entity-batch.ts` `c194c69a6e93b55662f711c19cc1c190b52eda67`,
`post-generation.ts` `d560f465ba178ac380d78a31ccfb09c0626e458d`,
`wikilinks.ts` `5bafcc7f0f3f430a0deba2a9c7839e6809f00b02`, all re-hashed after
every restore; one suite group at a time at `CAMPAIGNER_TEST_WORKERS=2`, raw
output kept):

| injection | line it hits | result |
|---|---|---|
| **I1 the authoring run removed** — the pre-rule behaviour, `return` immediately after the cast | `entity-batch.ts:627` | **RED 14 across 3 files**: both thin end-to-end pins, the material/context pin, the INVERSION pin, the aliased pin, the re-target seal, the failure-funnel pin, the scan, and 6 `moduleGen-cast`/`creature-row-resolution` pins — with the **withdrawal pin GREEN** (no run exists to be stopped: a withdrawal pin cannot see an arm that never runs) |
| **I2 the `hasDetailedEntity` filter deleted** from the target set (the data-loss guard) | `post-generation.ts:142` | **RED 4**, every one of them a pin asserting the target-set seal (the end-to-end seal here and in `moduleGen-cast`). The 4 PURE `batchTargets` pins stayed GREEN: they pin the wiki-link derivation, not the filter — which is why the filter is pinned end to end and not only in the pure seam |
| **I3 `namesOfKind` reads the RECORDED names instead of the text's links** (a hand-picked list) | `post-generation.ts:111-113` | **RED 2**, exactly the two pins that hold the load-bearing fact; the aliased and kind pins stayed GREEN (they do not discriminate) |
| **I4 the context anchor moved to the DISPLAY text** (a name-string search over what a reader sees) | `wikilinks.ts:300` | **RED 3**: the new aliased end-to-end pin AND the two pre-existing `surroundingParagraphs` pins (*"matches on token names only, never on display text"*) — the anchor rule was already pinned in the unit seam; the new pin measures it end to end |
| **I5 a DEAD, unreferenced `describesEntity` re-added** to `lib/wikilinks.ts` (zero callers in `src/`) | `wikilinks.ts:307` | **RED 1, and it is ONLY the scan: 72/72 behavioural pins GREEN** — the measured proof that the scan is load-bearing, and that a dead condition is invisible to behaviour |
| **I6 the empty-context fallback dropped** (`prose: { body: context }` — an empty body where no module text mentions her) | `entity-batch.ts:623` | **GREEN, 63/63** — names the ONE line no pin reaches. It is unreachable for a real batch target (every target is a wiki-link of the module text — the fact pinned above), which is exactly why row 133's *"the text NEVER mentions her"* pin was DELETED rather than replaced: nothing can reach that state |

**Verified again at LANDING, by the dispatcher — because this slice's author never
reported.** Two writers worked this slice and both died with an EMPTY report (no
message, no BLOCKED): the second died AFTER committing, which is the only reason
the slice exists at all (the first left an uncommitted draft, recoverable only
because its worktree was still on disk). The author's own gate and injections
above are its record; the landing was then proved independently. The gate was
re-run on the committed tree — exit 0, **301 files / 3452 tests**, identical to
the author's own numbers — plus two dispatcher injections (baseline copy kept
OUT of tree; `entity-batch.ts` `c194c69a…` re-hashed after each restore):

| injection | line it hits | result |
|---|---|---|
| `if (true) return;` inserted before the cast arm's `runEngine.startRun({` (the pre-rule behaviour) | `entity-batch.ts:658` | **RED 5**: the owner-ruling pin, the material/context pin, the row-135 INVERSION, the aliased-link pin, the re-target seal |
| `contextParagraphs` emptied (the module's text stops reaching the brief) | `entity-batch.ts:584` (its ONLY occurrence) | **RED 2**: the material/context pin and the failure-funnel pin |

**One inaccurate record, measured and corrected here.** This section first named
`entity-batch.ts` `3f38aa0d…` as the restored hash; the landed file (and the tree
at every point after the author's final edit) hashes `c194c69a…`, so the recorded
value was STALE — taken before the author's last edit to that file. `post-generation.ts`
(`d560f465…`) and `wikilinks.ts` (`5bafcc7f…`) were correct. A hash in a
REVERT-PROVEN line is what a later reader uses to prove a file is unchanged:
a stale one silently defeats that check, which is why it is corrected rather than
left.

**The test-count arithmetic, measured.** The DELETED floor block held **7** pins,
not the 6 row 133 recorded (`tests/lib/wikilinks.test.ts`, 46 → 39). The
rewritten `entity-batch-cast-description.test.ts` goes 6 → 7 (three old pins
removed: the described side, the no-clobber guard, the never-mentioned case; four
added: the inversion, the transport-context pin, the aliased link, the
re-target seal). `module-post-generation.test.ts` goes 18 → 22 (the 4 new
`batchTargets` pins). `moduleGen-cast.test.ts` (27) and
`creature-row-resolution.test.tsx` (7) are unchanged in COUNT — three and one of
their pins respectively were REWRITTEN, not added. Net **3454 → 3452 (−2)** over
**301 files (unchanged)**: −7 +1 +4.

**Their premises were the deleted floor, so they could not stay as they were —
named, with the measurement.** (1) *"an entity the module's prose already
describes spends nothing and keeps the module's paragraph"* → INVERTED, as the
owner directed: one run, authored prose. (2) `moduleGen-cast`'s *"the module's OWN
prose decides: … is not given a second, invented description"* → retitled and
rewritten to the run being spent against the earlier cast's row. (3) The same
file's *"ONE npc artifact carries the entity's prose …"* and *"a SECOND run reuses
that row"* asserted `startRunMock` was never called → now assert the run, its
`targetArtifactId` and the empty target set. (4)
`creature-row-resolution`'s *"a designed CAST is a SUCCESS"* asserted `chatMock`
was NEVER called — a claim that had been passing on a RACE (its barrier stopped
at the row's birth, before the description run reached the transport) and that
row 133's ledger had cited as measured proof the floor was low enough. It now
waits for the authored body and asserts exactly ONE call.

### A cited npc's borrowed numbers (docs/17 row 134, docs/11 §A cited row's REFILL, docs/18 §2/§4)

A cast creature npc has no stat block of its own by design (`npcDataSchema`
refuses a `creatureRef` beside an authored block by name) — its numbers are the
library creature's, DERIVED at read time. They were rendered on the encounter
panel and the battle board and NOWHERE the row's own details surface could be
seen, which is the second half of the owner's *"No text, no stat block,
nothing"*: `NpcForm` drew nothing and offered an "Add stat block" button that
the cited-row refill refuses before any model call. The fix folds the two
spellings of the derivation into ONE rule and draws it with ONE read-only
component.

| fact pinned | where |
|---|---|
| **The editor shows the LIBRARY creature's real numbers, labelled as borrowed**: AC 14 / HP 22 / the action line from the seeded chunk (not "something rendered"), the `Borrowed from the library` badge, the disclosed origin `NPC: Aunt Agatha (stats from Bestiary p.4)`, ZERO controls inside the card, NO "Add stat block" button, and the row left UNWRITTEN (`statBlock` still null, the citation byte-identical) after the whole render | `tests/features/cast-row-borrowed-stats.test.tsx` (`renders the library creature's real numbers, labelled as borrowed, with no authored-block affordance`, NEW) |
| **The read-only card carries the same numbers and the same label** — the module reader's peek modal / session-mode card mount, so the row is not "a portrait and nothing else" on the reading side either | `tests/features/cast-row-borrowed-stats.test.tsx` (NEW) |
| **A non-cited npc is UNCHANGED, both shapes**: an authored block still renders with its Edit/Remove controls and no borrowed card; an npc with neither citation nor block still offers "Add stat block" | `tests/features/cast-row-borrowed-stats.test.tsx` (2 pins, NEW) |
| **A missing library creature is LOUD and NAMED, never blank** (AGENTS 1/2): after the cited chunk is deleted the panel renders the destructive notice with the shared `missing ref (Bog Zombie)` reason, no stat text at all, and still no authored-block affordance | `tests/features/cast-row-borrowed-stats.test.tsx` (NEW) |
| **A citation carrying neither key is an ERROR at the derived rule**, surfaced in place (the read THROWS, the panel says so) — the `creatureRefIsEmpty` refusal the repo-level resolver always made, now reachable by both readers of a cited row | `tests/features/cast-row-borrowed-stats.test.tsx` (NEW) |
| **The encounter reader answers the IDENTICAL label and values** for a roster entry linked to the cast row (`NPC: Aunt Agatha (stats from Bestiary p.4)`, HP 22) and the IDENTICAL creature-naming when the library row is gone (`missing ref (Bog Zombie)`) — the fold's whole point, checked on both readers rather than on one | `tests/features/cast-row-borrowed-stats.test.tsx` (2 pins, NEW) |
| **The refused pair stays unconstructible and unwritable**: `npcDataSchema` refuses citation + authored block by name (and accepts the citation with a null block), and `updateArtifact` REJECTS a hand-written pair, leaving the stored row's block null with its citation intact | `tests/features/cast-row-borrowed-stats.test.tsx` (2 pins, NEW; the schema refine itself is also pinned in `tests/db/creatureRepo.test.ts`) |
| **The kept-unchanged half of the owner's own rule**: the cited-row refill's step-off (the statblock step `'skipped'` with its reason before any model call, the citation byte-identical, `statBlock` null) | `tests/llm/refill-creature-stats.test.ts` (6 pins, PRE-EXISTING, passing unchanged) |
| **The ROUTING** — the derived-stats label is composed in `domain/encounterResolve.ts` ALONE (its definition plus exactly ONE call), the repo-wired read makes exactly one call of the domain rule and composes no label of its own, the derivation has exactly three holders in `src/`, and both surfaces MOUNT the one renderer rather than a `StatBlockCard` of their own | `tests/features/cast-row-borrowed-stats-scan.test.ts` (`scan: …`, 2 pins, NEW, labelled as scans, with a >200-file non-vacuity check) |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n` and `git diff --stat` checked BEFORE the run, one
suite at a time at `CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's
scratch, then restored from an OUT-OF-TREE copy and verified with
`git hash-object` — `kind-forms.tsx`
`2d718da4a9cdf7bb98320b0a1e40cc0b725008aa`, `borrowed-stats.tsx`
`d38306580f46fbda5bc17675a008c52b9eb29c91`, `artifact-cards.tsx`
`4ba8cb241cf6f03dcda8152e9a1a9b86dd41a0e1`, `encounterResolve.ts`
`d982b8abf97b885232f0f50faacfbac2c7a0a944`, `creatureRepo.ts`
`0b8d0b44076c9d2a660ddd27ff477888e0a3a3ae`, all five matching after every
restore; `git checkout --` restores HEAD and would have destroyed this unfiled
work, so the backup was taken first):

| injection | line it hits | result |
|---|---|---|
| the `NpcForm` mount dead-ened (the pre-fix editor behaviour) | `kind-forms.tsx:171` | **RED 3** (the editor's ready, missing-creature and empty-citation pins); the CARD pin, both encounter pins, both non-cited pins and the scan **GREEN** — the two mounts are genuinely separate |
| the cited-row guard on the "Add stat block" button deleted | `kind-forms.tsx:137` | **RED 2** (the two pins asserting the button is absent); every other pin GREEN |
| the `creatureRefIsEmpty` refusal deleted from the derived rule | `encounterResolve.ts:213-217` | **RED 1** (the empty-citation pin, which then renders the named missing-ref notice); the missing-creature pin correctly stayed GREEN |
| the creature name no longer stamped into the missing label | `encounterResolve.ts:220` | **RED 2**, one per reader (the editor and the encounter panel); `encounterResolve.test.ts` 17/17 GREEN because its four `missing ref (…)` pins are `rulebook` sources that already resolved their own name |
| **the FOLD reverted** — `creatureRepo.resolveDerivedNpcStats` re-inlines the whole rule (plus the reintroduced `derivedStatOrigin` import) | `creatureRepo.ts:185-190` | **RED 2, and ONLY the two scan pins: all 49 behavioural pins stayed GREEN** (`creatureRepo` + `encounterResolve` + the new behaviour files) — the repo's next measured instance of the rule stated above (the sibling folds' `77, 176, 60, 18` and the four image queues), and the reason the scan exists |
| the `NpcCard` mount dead-ened | `artifact-cards.tsx:80` | **RED 1** (the card pin) with the SCAN **GREEN** — an honest limit of a textual scan (the mount text is still in the file), and the reason the behavioural card pin is kept |
| the loading-state copy reworded | `borrowed-stats.tsx:74` | **GREEN, 12/12** — names the ONE line no pin reaches: the transient "Reading <name>'s stats from the library…" state every pin awaits PAST |

**UNPROVEN.** (1) Nothing is observed in a real browser or against a live
library: every pin renders through jsdom with `fake-indexeddb`, so "the owner
sees the numbers" is read off the DOM. (2) The panel reads the derivation ONCE
per mount through an effect (not a Dexie live query), so a library change made
while the editor is open does not repaint until it remounts — a KISS choice, not
a measured absence of need. (3) The `missing ref` state is surfaced IN PLACE
only, never toasted: it is a persistent data state that renders every time the
surface opens (the louder of the two options the brief allowed), and no pin
measures that a toast would have been worse.

### A persistent notice carries a real dismiss control (docs/17 row 136, docs/18 §2.3/§4)

The owner's report, verbatim: *"One small bug: That error message is still on my
screen and the little closer it has does not close it."* MEASURED before touching
anything (base `1ae0b3f`): `lib/toast.toastErrorPersistent` raised
`toast.error(message, { duration: Infinity })`; `grep -rn "closeButton" src/`
returned ZERO hits and sonner draws its close button only when
`toast.closeButton ?? toaster.closeButton` is truthy
(`node_modules/sonner/dist/index.mjs:521-526`, conditional at `:842`) — so a
persistent notice had no exit at all, and the "little closer" the owner clicked
is the app's error ICON (`OctagonXIcon`, an octagon with an X), drawn from the
`icons={{ error: … }}` map and not a button. The pins below mount the REAL
`Toaster` (`components/ui/sonner.tsx`) and drive the REAL seam (docs/05 §Error
surfaces rule), because the defect lived in the options object the seam builds
AND in what the mounted Toaster rendered — a mocked `sonner` (which
`tests/lib/toast.test.ts` keeps for the humanization pins) cannot see either.

| fact pinned | where |
|---|---|
| **A persistent notice is DISMISSIBLE and it is the REAL Toaster**: the notice `reportEntityBatchFailures` raises is found by `getByRole('button', { name: /^close toast$/i })`, and one activation REMOVES it from the DOM | `tests/lib/toast-persistent-dismiss.test.tsx` (`the real Toaster renders a reachable close control…`, NEW) |
| **The control comes from the SEAM, not from one caller**: `toastErrorPersistent` called directly (the global-error surface's helper) is dismissible the same way | `tests/lib/toast-persistent-dismiss.test.tsx` (NEW) |
| **The fix does not travel**: a transient `toastError` renders NO close control and keeps its description — a closer on a 4-second toast is a different slice, not this one | `tests/lib/toast-persistent-dismiss.test.tsx` (NEW) |
| **Dismissing never means "evidence gone"**: after the click, the per-failure console record (the pasteable `[campaigner] entity-batch failure {…}` line) is byte-identical, the console call COUNT is unchanged, and the record still carries the reason + the `runId` that finds the failed row in the Runs tab — the record is the batch's, not the toast's | `tests/lib/toast-persistent-dismiss.test.tsx` (NEW; the record's own fields stay pinned in `tests/features/entity-batch-failure-report.test.ts`) |
| **The seam's option object**: `closeButton: true` on BOTH branches of `toastErrorPersistent`, absent from every transient helper | `tests/lib/toast.test.ts` (2 pins gained the flag; the transient `toastError` pins assert their options by deep equality and already exclude it) |
| **FOUR PRE-EXISTING PINS COULD NOT STAY UNCHANGED** — each asserts the seam's options object by DEEP EQUALITY, each failed with the SAME `+ "closeButton": true` in its Received diff and nothing else, and each now ASSERTS the flag (a tightening: the duration, the byte-exact copy and the absence of a description are all still pinned) | `tests/lib/toast.test.ts` `keeps plain-Error descriptions byte-identical`; `tests/features/entity-batch-failure-report.test.ts` `is PERSISTENT: …` and `keeps the sentence this app has ALWAYS raised…`; `tests/lib/globalErrors.test.ts` `still pins a message when the failure carries no Error object`. The two `expect.objectContaining({ duration: Infinity, description })` pins in `globalErrors.test.ts` passed untouched |
| **The ROUTING**: `grep -rn "closeButton" src/` matches `lib/toast.ts` ONLY (the seam's doc and its two option objects `:108`/`:110`) — nothing on the `<Toaster>`, so a second dismiss mechanism cannot appear beside the seam's | behaviour-only, no scan pin: the `grep` above is recorded here instead, because a one-line source scan would be the only thing it asserts (docs/17 row 136) |

**REVERT-PROVEN lines** (each injection applied to the exact executing line,
printed back with `grep -n` and `git diff --stat` checked BEFORE the run, one
suite at a time at `CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's
scratch, then restored from an OUT-OF-TREE copy and verified with
`git hash-object` — `src/lib/toast.ts` `dd621acf345a110e23f136d4bf92ddf430417b7a`,
`src/components/ui/sonner.tsx` `9dd2975fe4d9f5a6195f6abfd84aafd3cc5e2a1c`, both
matching after restore; `git checkout --` restores HEAD and would have destroyed
this unfiled work, so the backup was taken first):

| injection | line it hits | result |
|---|---|---|
| the dismiss flag reverted on BOTH branches (`closeButton: true` → `false`) | `src/lib/toast.ts:108` and `:110` (the two `toast.error` options objects; both execute — the no-detail branch is what `reportEntityBatchFailures` takes) | **RED 5** — all three new persistent pins (`Unable to find an accessible element with the role "button" and name /^close toast$/i`) plus both option-object pins — with **the FIVE transient pins GREEN**: the measured proof the fix is scoped to persistent notices |
| **the DECLINED design injected instead**: a global `closeButton` on the `Sonner` element | `src/components/ui/sonner.tsx:22` | **RED 1, exactly the new transient pin** (`a 4-second toastError carries no close control`), every persistent pin **GREEN** — the global flag fixes the owner's bug too, and this is the pin that says why it is still the wrong design |
| the pre-fix tree, before any change (the owner's report as a pin) | `src/lib/toast.ts:68` (the seam with no flag) | **RED 3/4** in `tests/lib/toast-persistent-dismiss.test.tsx`, every failure the same `Unable to find an accessible element`, and the rendered toast's accessible roles are `region` / `list` / `listitem` with NO `button` — i.e. the DOM held nothing that could dismiss it. The fourth pin (transient) was GREEN then and is GREEN now |

Aiming note for the next writer: **the flag lives in the options object the seam
passes, so a pin that mocks `sonner` can only see the FLAG, never the rendered
control.** The defect was the rendered control, which is why the new file mounts
the real Toaster; keep both, and aim any future injection at `toast.ts:108/:110`
(both branches execute) rather than at the `if (detail === undefined)` line,
which no injection needs to touch.

**UNPROVEN.** (1) Nothing is observed in a real browser: every pin renders
through jsdom, so "the owner now finds the closer" is read off the accessibility
tree plus sonner's shipped CSS (an out-of-flow 20px circle with its own
background and border at the toast's corner, `sonner/dist/styles.css:223-242`),
never from a screen. (2) The double-X judgement (the decorative
`OctagonXIcon` beside a real X closer) is a design call from those measurements,
NOT a measured absence of confusion — if the owner mis-clicks the icon again,
the next smallest remedy is the labelled "Dismiss" action docs/17 row 136
declines today. (3) The failed-run-row half of "the evidence survives" is
asserted only through the `runId`/`errorMessage` the record carries — the Runs
tab's own rendering is pinned elsewhere and is not re-driven here.

### The clean-cut notice reaches the owner, and the report outlives the mount (docs/17 rows 278/280, docs/18 §2.3)

The row-278 landing pinned the PURGE (`tests/db/clean-cut.test.ts`, through the
real `version(31)` upgrade) and the SENTENCE (`formatCleanCut`), but nothing
pinned the WIRING — no test anywhere asserted that a stored report ever becomes
something the owner can read. The owner's only real run found the gap: the purge
ran, the report was written inside the same `versionchange` transaction, and he
still never saw it. The gap's failure mode is SILENCE, which is the class AGENTS
rules 1–2 forbid, so the missing pin is the defect.

The new family mounts the REAL app shell (`RouterProvider` over
`createAppRouter()`, fake-indexeddb, `clearDatabase()` per test) rather than the
effect in isolation, because the defect was an INTERACTION: the same condition
that raises the notice (`AppShell`'s clean-cut mount effect) auto-opens the
first-run wizard from its OWN effect, and the notice was a 4-second `toastInfo`
whose report was nulled in the same turn.

| fact pinned | where |
|---|---|
| **The notice is the PERSISTENT seam, and the report SURVIVES the mount**: the sentence is found, sonner's own closer is reachable by ROLE + accessible name, and `readSettings().cleanCut` still equals the stored report | `tests/app/clean-cut-notice.test.tsx` (`says what was removed and KEEPS the report until the owner acknowledges the notice`, NEW) |
| **Acknowledgement is the ONLY thing that clears it**: activating the closer removes the notice AND nulls the row — the write rides the ONE settings write (`updateSettings`) | same file, same pin (the second half) |
| **A report the owner never saw is RE-SAID**: unmount + remount on the same browser shows the sentence again with the row intact | `tests/app/clean-cut-notice.test.tsx` (`re-says an unacknowledged report on the NEXT launch…`, NEW) |
| **The wizard cannot swallow it**: with onboarding `'fresh'` and zero campaigns, the wizard auto-opens AND the notice is delivered with a reachable closer; the wizard's own `settings` write (`Don't show again` → `dismissed`, through the merging `updateSettings`) neither clears nor consumes the report | `tests/app/clean-cut-notice.test.tsx` (`delivers the notice with the wizard OPEN…`, NEW) |
| **The control**: no report ⇒ no notice, no closer, and nothing cleared — so the assertions above cannot pass vacuously | `tests/app/clean-cut-notice.test.tsx` (`says nothing and writes nothing when there was no clean cut`, NEW) |
| **ONE persistent-notice mechanism** (AGENTS rule 4, obligation 2): `duration` / `Infinity` and `closeButton` / `true` are each spelled exactly once under `src/` (in `lib/toast.ts`'s `persistentNotice`), and exactly TWO entry points call that builder — a second hand-written persistent notice reds by file | `tests/architecture/one-persistent-toast.test.ts` (NEW, AST source scan) |

**REVERT-PROVEN, three arms, every arm's sha256 printed, no two arms identical,
each restored byte-identically from an out-of-tree copy** (`.gate-logs/row280-writer/`):

| injection | sha256 before → after | result |
|---|---|---|
| **ARM 1 — the durability half reverted**: `AppShell` clears `settings.cleanCut` on the way past (`void updateSettings({ cleanCut: null })` right after raising the notice), exactly the pre-280 behaviour while keeping the persistent seam | `src/app/layout/AppShell.tsx` `89fd2b40…` → `3a1d8303…` → `89fd2b40…` | **RED 3** — every pin that reads the row, each `AssertionError: expected null to deeply equal { campaignsPurged: 3, …(10) }` — with the non-vacuity control **GREEN** |
| **ARM 2 — the persistence half reverted**: the mount effect raises `toastInfo(...)` (transient) instead of `toastInfoPersistent(...)` — the exact cure reverted, and the fog the wizard hid behind | `src/app/layout/AppShell.tsx` `89fd2b40…` → `5deff085…` → `89fd2b40…` | **RED 2**, both `Unable to find an accessible element with the role "button" and name /^close toast$/i` — the notice-appears half and the **wizard** half — with the re-say pin and the control **GREEN** (the row survives, but nothing can acknowledge it) |
| **ARM 3 — a SECOND persistent notice born beside the seam** | `src/lib/progress.ts` `d7d11410…` → `3b27a5ea…` → `d7d11410…` | **RED 1**, `expected [ 'src/lib/progress.ts', …(1) ] to deeply equal [ 'src/lib/toast.ts' ]` — the scan names the copy by file |

**A DEFECTIVE ARM, RECORDED RATHER THAN QUIETLY RE-RUN** (the docs/18 §4
"identical arms are a VOID probe" rule, applied to a different mistake): the
first ARM 2 attempt swapped only the CALL (`toastInfoPersistent(...)` →
`toastInfo(...)`) and left the import naming `toastInfoPersistent`, so the effect
threw a `ReferenceError` into its own `.catch` and no notice was raised at all.
It reddened the pins for the WRONG reason (`Unable to find an element with the
text` — the sentence was never raised, instead of "raised but transient"). It was
re-injected with the import restored and re-run; only the second result is
evidence.

**UNPROVEN.** (1) jsdom has no layout, so the STACKING claim in `AppShell`'s
comment — sonner's `z-index: 999999999` over the dialog's `z-50` — is read off
the shipped CSS, not measured; what the pins measure is that the notice is in the
DOM, carries a reachable closer by role, is not `aria-hidden`/`inert`, and is not
inside the dialog. (2) The wizard's own dismissal is driven with a real user
click, but the owner's actual first-run path (a modal he reads for minutes) is
not reproducible in jsdom — the persistence, not the layout, is what the cure
guarantees. (3) A failed acknowledgement write (`updateSettings` rejecting) is
NOT pinned: the `.catch(toastError)` keeps the row in place by construction, and
forcing that path would require mocking the settings repo the whole family drives
for real.

### The roster path never builds the refused pair (docs/17 row 137, docs/11 §A cited row's REFILL, docs/18 §4)

The owner reported ONE of two encounters failing, with the identical error on a
fresh retry: *"Refused by a data check: data.creatureRef: an npc carries either
an authored stat block or a library creatureRef to derive one from, never both"*.
It was deterministic because the parse precedes the write, and it was OURS:
finalize's reuse branch (`runEngine.materializeMonsterNpc`) filled a stat-less
same-named row with the model's inline block — and a CAST CREATURE row is
stat-less BY CONSTRUCTION — while the fixed-cast brief had ORDERED the model to
embed that block inline, never telling it `creatureRef` exists. The branch now
LINKS the cast row and writes nothing (`isCastCreatureNpc`), so the roster reads
the library's numbers through the derived rule the previous slice pinned. Pins
live in `tests/llm/finalize-cast-glue.test.ts` (6, NEW), driven through the REAL
engine with only the transport faked, on a fixture mirroring the owner's own
scene — the campaign «Ein delikates Problem», the module «New Module», the
encounter «Tod im Seitenrohr» and an ALIASED link to the cast member
(`[[Dreizehnter Ablauf|Dreizehnten Ablauf]]`).

| fact pinned | where |
|---|---|
| **The ORDER the model obeyed is produced by production code**: the aliased link is found through its TARGET name (the encounter's own wiki-linked name never joins its own cast), and the brief carries *"use these stats as-is — embed them as this monster's complete inline `statBlock`"* plus the LIBRARY creature's own block | `tests/llm/finalize-cast-glue.test.ts` (`finds the ALIASED cast member and ORDERS the library block inline`, NEW) |
| **THE FORCING PIN**: a roster monster whose name a cast row already answers COMPLETES the run (RED before the guard, with the owner's own sentence in the run row), the persisted roster entry is an `npc-ref` to that row, and the row is byte-identical afterwards (`toEqual` on the whole artifact; `creatureRef` byte-identical, `statBlock` still null) — the write that built the refused pair is gone | `tests/llm/finalize-cast-glue.test.ts` (`LINKS the cast row and writes NOTHING onto it…`, NEW) |
| **Nothing is lost**: the roster entry's `npc-ref` arm resolves to the LIBRARY's real numbers with the disclosed origin `NPC: Dreizehnter Ablauf (stats from Bestiary p.132)` — the block the model embedded WAS the library's own block | same pin (through `resolveMonsterEntryWithRepos`, the repo-wired reader) |
| **The blast radius is covered too**: with NO fixed cast in the brief at all — an ordinary caller whose model-authored block happens to match a campaign-wide cast row by name — the row is still linked and untouched | `tests/llm/finalize-cast-glue.test.ts` (`LINKS a cast row the model named on its own…`, NEW) |
| **A monster with NO same-named row still MATERIALIZES a new npc artifact carrying its block** (module-owned, no citation, exactly one such row) | `tests/llm/finalize-cast-glue.test.ts` (NEW) |
| **A same-named ORDINARY (non-cited) stat-less npc row still RECEIVES the block**, with no twin minted — the pre-existing reuse behaviour is untouched | `tests/llm/finalize-cast-glue.test.ts` (NEW) |
| **The schema refusal is still a live backstop**: a pair constructed by other means (`updateArtifact` with an authored block on the cited row) is refused with the named sentence and the row is left byte-identical | `tests/llm/finalize-cast-glue.test.ts` (NEW; the refine itself is also pinned in `tests/db/creatureRepo.test.ts`) |

**REVERT-PROVEN** (the injection applied to the exact executing line, printed
back with `grep -n` and `git diff --stat` checked BEFORE the run, one suite at a
time at `CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's scratch,
then restored from an OUT-OF-TREE copy and verified with `git hash-object` —
`src/llm/runEngine.ts` `f08f8b3345a41454be220cfcf3a9e74f5ee2603b` before and
after; `git checkout --` restores HEAD and would have destroyed this uncommitted
work, so the backup was taken first):

| injection | line it hits | result |
|---|---|---|
| the new guard disabled (`if (isCastCreatureNpc(existing))` → `if (false && isCastCreatureNpc(existing))`) | `runEngine.ts:1413` (the fixed file) | **RED 2 — exactly the two forcing pins**, each with the owner's own sentence back in the run row (`status failed, failureKind invalid-output: Refused by a data check: data.creatureRef: … Nothing was written.`), and **all 158 tests in the 11 neighbouring suites GREEN** (`finalize-cast-glue`'s other 4 pins, `encounterRun`, `fixedCast`, `refill-creature-stats`, `moduleGen-cast`, `encounterRepopulate`, `creatureRepo`, `cast-row-borrowed-stats` + its scan, `entity-batch-fixed-cast`, `creature-row-resolution`, `bestiary-roster`) — the measured proof that the guard is the only line carrying this behaviour and that the neighbours did not move |

**RED BEFORE / GREEN AFTER, kept.** At the base commit the two forcing pins were
RED with `the run produced no artifact (status failed, failureKind
invalid-output: Refused by a data check: data.creatureRef: …)` and the other 4
pins were GREEN (the neighbours and the backstop were never broken); after the
guard the file is 6/6.

**UNPROVEN.** (1) No live-provider run: every pin mocks the transport at the
protocol boundary. (2) The owner's own run row was not replayed — the
reproduction drives the same code path from a crafted campaign mirroring his
scene shape, and "the sibling encounter had no cast row to collide with" is
inferred from `fixedCastForEncounter` rather than measured on his data. (3) A
model-authored block that DIFFERS from the library's (the no-fixed-cast case) is
discarded in favour of the row's citation with no advisory: a deliberate
precedence, not a measured absence of owner surprise.

### The reader header has ONE canvas entry (docs/17 row 138, docs/05 §Module canvas, docs/08-MODULE-DESIGNER §Module canvas chat)

The owner reported the reader header's **Canvas** and **Chat** buttons doing
"exactly the same" and asked to retire the Canvas one. Measured at base
`1ec1164`: `ModuleReaderPage.tsx:463-474` was Canvas →
`canvasPath(campaignId, moduleId)`, `:475-487` was Chat →
`canvasChatPath(campaignId, moduleId)`, and `canvasChatPath`
(`src/app/routes.ts:104-118`) is `canvasPath` plus ONE query parameter —
`?chat=open`. ONE destination, one sidebar PRESET of difference; the plain
arrival opens the sidebar by default anyway (ledger 57/58). The Canvas button,
its comment, `SquarePenIcon` and the file's `canvasPath` import are gone; the
reader nav is **Board + Chat + Contents**. `canvasPath` itself is untouched and
still used by `ModulesListPage.tsx:267` (the row's canvas icon), so the plain
canvas keeps its entry and no destination is lost.

**NO PRE-EXISTING PIN WAS DELETED, measured rather than assumed:**
`grep -rn "canvas-header-link" --include=*.ts --include=*.tsx .` returned
exactly ONE line in the whole tree — the source line being removed — and the
two grep hits for `chat-header-link`/`board-header-link` under `tests/` are the
`canvas-chat-thread` Chat pin (kept, still green, it is the surviving-button
half of the pair) and nothing else. There was therefore no pin about the
duplication to delete and no assertion to loosen; the durable half is the NEW
pin.

| fact pinned | where |
|---|---|
| The reader header holds exactly ONE control whose destination is the module canvas: the controls are enumerated BY ROLE (both `button` and `link` — the header's nav controls are anchors carrying `role="button"`), filtered by the `href` they point at, and the count is 1 — so a re-added Canvas control fails it whatever test id or label it carries | `tests/features/canvas-chat-thread.test.tsx` (`the reader header holds exactly ONE canvas destination — the Chat entry (owner request, ledger 138)`, NEW) |
| …and that one is the **Chat** entry: its `href` is byte-equal to `canvasChatPath` (the canvas with `?chat=open`), its accessible name is `Chat`, and the retired control is gone by test id AND by accessible name | same pin |
| The reader nav that remains is **Board + Chat + Contents**: `Board` still routes to `boardPath`, and the contents toggle is still there | same pin |
| The surviving Chat entry still ROUTES there end to end (click → `/m/<id>/canvas` + `chat=open` + the sidebar mounted) | `tests/features/canvas-chat-thread.test.tsx` (`a reader-header Chat entry routes to the canvas with the chat open`, PRE-EXISTING, unchanged) |

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `grep -n` and `git diff --stat` checked BEFORE the run, one suite at a
time at `CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's scratch,
then restored from an OUT-OF-TREE copy and verified with `git hash-object` —
`src/features/modules/ModuleReaderPage.tsx` `2cac05debf8c812dfceb5f47757874e8c07846f1`
before and after BOTH injections; `git checkout --` restores HEAD and would have
destroyed this uncommitted work, so the backup was taken first):

| injection | line it hits | result |
|---|---|---|
| **I1 — the removed control put BACK** (the whole Canvas `Button` with `data-testid="canvas-header-link"` and its `canvasPath` target re-added beside Chat, `canvasPath` re-imported) | `ModuleReaderPage.tsx:462` (the injected marker line, printed back) | **RED 1 of 9 — exactly the new pin**: `expected [ <a role="button" …(5)></a>, …(1) ] to have a length of 1 but got 2`, with the pre-existing Chat routing pin GREEN (the duplication comes back, the surviving button does not move) |
| **I2 — the retained button pointed at the plain canvas** (`canvasChatPath(campaignId, moduleId)` → `canvasPath(campaignId, moduleId)` at the Chat button, `canvasPath` re-imported) | `ModuleReaderPage.tsx:471` (the injected marker line, printed back) | **RED 2 of 9 — the new pin** (`Expected the element to have attribute: href="…/canvas?chat=open"` / `Received: href="…/canvas"`) **and the pre-existing routing pin** (`expected '' to contain 'chat=open'`) — i.e. the pin catches a same-destination/target swap, not only a duplicate, and it is not a restatement of the routing pin |

**WHAT THIS SLICE COULD NOT PROVE.** (1) No real-browser or owner-sighting run:
every pin is jsdom, and "the reader nav is less confusing now" is the owner's
report plus the measurement of ONE destination, not a usability measurement.
(2) The retired control's absence is pinned by test id and by accessible name,
so a future third entry carrying a DIFFERENT label and test id would be caught
only by the destination count — which is why the count, not the name, is the
primary assertion. (3) The consequence the change carries is stated and NOT
pinned: the reader header's only canvas entry now forces the chat sidebar open
(deliberate, ledger 57), and no pin asserts what a reader does about it —
the remedy (the list row's Canvas icon, the sidebar's own toggle) is documented
in docs/05 §Module canvas rather than measured.

### One press exports the planned book — the plan is not a step (docs/17 row 139)

The owner, verbatim: *"i just noticed this document plan button. Bad design to
put one functionality behind 2 buttons that need to be pressed sequentially. And
i do want to have that automatic."* — and, on the design the first brief
proposed instead: *"I dont think we need a cache. Chances to do 2 reports on the
same module thats unchanged are VERY slim."*

| What is pinned | Where | State |
|---|---|---|
| **The owner's complaint, end to end**: on a module with NO stored plan, ONE press of the export item calls the planner exactly once (through the real `llm/modulePlan` seam, only `chat` faked), writes the plan onto the module row with `plannedByModel`/`plannedAt` from the app, and the definition handed to the PDF generator is the PLAN's document — the procedural outline's `Premise`/`Part plan` chapters do NOT print, and the export reports success | `module-pdf-auto-plan.test` | ✅ |
| **Not a cache**: a module that already holds a valid plan with its own provenance (`vendor/previous`) still gets exactly ONE planning call, and the row is REPLACED — new section titles, new `plannedByModel`, a strictly later `plannedAt`; the OLD title is nowhere in the book | `module-pdf-auto-plan.test` | ✅ |
| **Failure is loud in three places, and the outcome is distinguishable from success**: `toastError('Could not plan the document — exporting without a fresh plan', <the Error>)`, the same failure in the export's problems toast, no success toast, the file still written, and a statement ON the document page (*"…the automatic planning step for this export failed — vendor/planner-1 returned no content"*); the row keeps NO plan (nothing fabricated) | `module-pdf-auto-plan.test` | ✅ |
| **The escape hatch**: with a valid stored plan and a FAILING call, the export prints the LAST STORED plan (its titles are in the book), states *"LAST STORED document plan"* rather than claiming the outline, and leaves the row's plan byte-identical (a failed call writes nothing) | `module-pdf-auto-plan.test` | ✅ |
| **The progress surface**: observed from INSIDE the planning call — the shared progress seam holds one job (`Exporting The Drowned Vault` / `Planning the document…`) at that instant, and holds none when the export ends | `module-pdf-auto-plan.test` | ✅ |
| **The wiring**: one planning call per press, made BEFORE the renderer, with the module's id; a failed planning is handed to the renderer as `planFailure` while the write still happens | `module-pdf-export.test` (+1 pin) | ✅ |

**RED BEFORE, kept.** The whole new file was run against the base commit
`18eb3c4` (pristine worktree, only `chat` faked, same file): `Test Files 1
failed (1)`, `Tests 5 failed | 1 passed (6)`. The FIRST pin — the owner's
complaint — failed at its first assertion with `expected "vi.fn()" to be called
1 times, but got 0 times`: at the base NOTHING planned on export, so the plan
row stayed empty and the procedural outline printed (the base behaviour the
pre-existing pin *"is SILENT when there is no plan at all"* describes). The 4
failure-path/cache pins failed for the same reason (no call, no plan, no
progress job), and the one GREEN test is the fixture's non-vacuity check.

**REVERT-PROVEN** (the injection applied to the exact executing line, `:100`
printed back, `git diff --stat src/features/modules/module-pdf-button.tsx` = 56
insertions / 3 deletions — the slice's own diff — checked BEFORE the run, raw
output in `/tmp/injection2.txt`):

| Injected | The executing line | Result |
|---|---|---|
| **the plan-before-render step DISABLED** (`planned = await planAndStoreModuleDocument({ moduleId: module.id, artifacts, turn });` → `planned = module;` + `await Promise.resolve();`) | `src/features/modules/module-pdf-button.tsx:100` | **RED 6 of 79, all six of them the new pins**: the 5 in `module-pdf-auto-plan.test.tsx` (single press plans/stores/prints the planned book; every export plans — the stored plan is replaced; the progress job while planning; the loud failure with the on-page statement; the LAST-STORED-plan escape hatch) and the wired one in `module-pdf-export.test.tsx` (`plans once per export before rendering, and hands a FAILED plan to the renderer`). **GREEN: 73**, including every pre-existing pin in `modulePdfPlan` (18 — the renderer still executes a stored plan), `modulePdf` (the module document + real-PDF builds), `modulePlan` (14: the planner seam plus its 3 new write pins), `module-plan-dialog` (10, the surface) and `campaign-tree-plan-control` (3, the one-dialog/one-write scans), plus `module-pdf-export`'s other 6 pins (GM/player audiences, destination-before-build, problem toasts, failed save, cancelled picker) |
| **the file's own byte-identity** | — | restored from an OUT-OF-TREE backup: `git hash-object` before = `857b2bb44ce2715e4407c41169cc245f821f942f`, after = `857b2bb44ce2715e4407c41169cc245f821f942f`, and `grep -c INJECTION` = 0 |

**TWO PRE-EXISTING PINS THIS SLICE HAD TO AMEND, NAMED** (both are pins about
the ONE plan write, which the fold below moved — neither was loosened):
`campaign-tree-plan-control.test.tsx`'s *"the tree carries no second plan
surface: one import, one dialog, one regeneration path"* scanned for the literal
`await planModuleDocument({` in the dialog; since the dialog now calls the new
`planAndStoreModuleDocument`, the scan was re-aimed at its new truth and
STRENGTHENED: the planner is called from exactly ONE file
(`src/llm/modulePlan.ts`, so a caller that bypasses the persisting seam fails)
and the plan WRITE (`{ documentPlan: plan }`) lives in exactly that file.
`module-plan-dialog.test.tsx`'s *"writes the planned plan to the MODULE ROW (the
only write site)"* asserted the row turned `valid` after Generate — which it did
by calling the unmocked `patchModule` itself — and it is now
*"hands the ONE plan+persist seam the id, the pool and a turn — and writes
NOTHING itself"*, which is the same claim moved to where it now belongs: the
stub resolves WITHOUT writing and the row must stay `absent`, so a surface that
wrote a plan itself fails. The write itself is pinned where it now lives, by
three NEW pins in `tests/llm/modulePlan.test.ts` (`planAndStoreModuleDocument`
persists + returns the patched row; it REPLACES a stored plan on a second call;
a refused reply writes NOTHING and the previous plan survives).

### What an entity detail OWNS is keyed by KIND (docs/17 row 140, docs/08-MODULE-DESIGNER §M4-C, docs/18 §2.2/§4)

The owner reported that location details were describing the mobs at the place
and giving GM advice on running the fight there — *"Thats not what Location
Details are for. We have Encounters for that."* The cause was structural: ONE
brief for all six kinds with no location contract, and the one prompt clause
written for it (`builtins.ts`, `fe1d365`) lived in a seed-once STORED row that no
existing install ever receives. The rule now lives in CODE, keyed by kind, at the
seam every entity detail passes through: `buildEntityBrief`'s `kind` parameter
selects `OWNERSHIP_BOUNDARY_BY_KIND` (an exhaustive `Record<StubKind, string |
null>`), appended as the brief's LAST paragraph for `location`, `event` and
`faction` only.

| fact pinned | where |
|---|---|
| **The boundary is IN the location brief and is LAST**, naming every clause the owner's report needs: the opposition belongs to the encounter artifact, point at where it is fought by the module's own wiki-link name, no tactics / no encounter-handling advice / no GM guidance on running the fight, `inhabitants` means people and factions and never monsters, the encounter-POV field vocabulary ("If the party acts", "Secrets", "Outcome") is refused by name, the reason ("one fact, one owner") and the module prose's own clause are both present | `tests/llm/kindOwnershipBoundary.test.ts` (`a LOCATION brief carries the boundary — and still carries the encounter scene it was handed`, NEW) |
| **The context paragraphs are NOT filtered to achieve it**: the whole encounter scene block arrives byte-for-byte inside the same brief (docs/17 row 140 — the fix is about ownership, never about what the worker may read) | same pin |
| **`event` is byte-identical to `location`** (its draft contract IS the location's) — one constant, so a reword cannot drift them apart | `tests/llm/kindOwnershipBoundary.test.ts` (`an EVENT brief carries the SAME bytes…`, NEW; plus the constant-equality assertion in `the OTHER three kinds append exactly their paragraph`) |
| **`faction` has its OWN boundary**: its fields are what the faction wants/operates/controls, the "order of battle" is the encounter's material, no preferred tactics — and the location-only `inhabitants` clause stays OUT of a faction brief | `tests/llm/kindOwnershipBoundary.test.ts` (`a FACTION brief carries its own boundary…`, NEW) |
| **The boundary does not break the change seam's instruction**: a location brief with an instruction carries the boundary and still ENDS with the one `Additional instruction: …` paragraph | `tests/llm/kindOwnershipBoundary.test.ts` (`renders the boundary LAST, and the change instruction still rides after it`, NEW) |
| **`npc`, `encounter` and `note` are BYTE-IDENTICAL with and without their kind** (`toBe` against the kind-less brief, not `toContain`), the encounter's scene framing and the standing instructions unmoved, and an OMITTED kind is the same bytes as `npc` — the property every pre-existing caller relies on | `tests/llm/kindOwnershipBoundary.test.ts` (3 `it.each` pins + `an omitted kind is the same bytes as \`npc\`…`, NEW) |
| **The PRODUCTION seam passes its kind** (a pure brief-side change would ship nothing): `runEntityBatch` for `location`, `event` and `faction` hands the engine a brief carrying the boundary AND the module text; for `npc` and `encounter` the brief carries no boundary and keeps its own context label (`Where it is mentioned:` / `The scene this encounter must stage…`) | `tests/llm/kindOwnershipBoundary.test.ts` (2 `it.each` families, 5 pins, NEW — the engine is faked, the brief STRING is the assertion target, exactly as `entity-batch-fixed-cast.test` does at this seam) |

**NO PRE-EXISTING PIN NEEDED A NEW BYTE — measured, not assumed.** At the changed
tree the whole PRE-EXISTING suite is GREEN (`303 files / 3463 tests`, 0 failures
at `CAMPAIGNER_TEST_WORKERS=2`), because no pre-existing test passed a kind, so
no `location`/`event`/`faction` brief was byte-pinned anywhere before this slice;
`buildEntityBrief`'s direct callers in tests all omitted the parameter and keep
their bytes. The ONE pre-existing test file touched is
`tests/features/change-artifact-instruction.test.ts`, whose two brief-builder
calls gained the new positional `'npc'` argument — its `npc` bytes and its
"instruction is appended last" assertion are unchanged, so nothing was loosened.

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back and `git diff --stat` checked BEFORE the run, one suite at a time at
`CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's scratch, then
restored from an OUT-OF-TREE copy and verified with `git hash-object` —
`src/features/modules/persona-request.ts`
`1c703ed304fc5cbdc18d8519659401925c334c2f` before and after, plus
`src/features/modules/entity-batch.ts` `b8b93aa1e99882d16e0d96daf4ddf0a95e49dafe`
for I2; `git checkout --` restores HEAD and would have destroyed this uncommitted
work, so the backups were taken first. **CORRECTED by the dispatcher at landing
verification:** these two hashes (and I2's line number below) were recorded
BEFORE the ledger-row renumbering (139 → 140), which edits a comment in each of
these files — so as first written they identified the pre-renumbering blobs, not
the landed ones, and I2's argument sits at `entity-batch.ts:601` in the landed
file. Both injections were re-run against the LANDED blobs and reproduced their
results exactly (I1 RED 8 / GREEN 6, I2 RED 3 / GREEN 11), each restoring
byte-identically to the hash above):

| injection | line it hits | result |
|---|---|---|
| **I1 — the boundary disabled for the three kinds** (`location`/`event`/`faction` set to `null` in `OWNERSHIP_BOUNDARY_BY_KIND`) | `persona-request.ts:116-118` (the injected lines, printed back) | **RED 8 / GREEN 6.** RED: the 5 location/event/faction pins and the 3 `location`/`event`/`faction` BATCH pins. GREEN, i.e. the npc/encounter/note pins NEVER NOTICE: the 3 byte-identity pins, the omitted-kind pin, and BOTH `npc`/`encounter` batch pins |
| **I2 — the kind NOT passed by the production seam** (the `kind,` argument removed from the `buildEntityBrief` call in `entity-batch.ts`) | `entity-batch.ts:593` (the injected lines, printed back) | **RED 3 / GREEN 11.** RED: EXACTLY the three batch pins. GREEN: every unit pin AND both `npc`/`encounter` batch pins — the plumbing carries its own forcing pin, so I1 and I2 are not the same proof |

**UNPROVEN.** No test can show that a model OBEYS the paragraph. Every pin here is
a byte pin on a composed string plus a plumbing pin at the seam; the behavioural
claim rests on the owner's next regeneration (docs/17 row 140 states exactly what
to look for). A model that ignores the paragraph produces the old output and no
test fails.

### Entity intent — the author's note that steers a detail worker (docs/17 row 141, docs/08-MODULE-DESIGNER §M4-C, docs/18 §2.2/§4)

The owner asked for *"an optional hint parameter in the link to steer detail
building"*, was shown that a name is not merely gathered from the module text but
RECORDED as an entity, and answered *"Then that is the right place."* The note
therefore lives on the entity RECORD (`moduleEntityKindSchema.intent`), is written
by the spine planner for the names it invents, and reaches the detail worker as
one paragraph of `buildEntityBrief`, immediately before the `Additional
instruction: …` paragraph and after the kind's ownership boundary.

| fact pinned | where |
|---|---|
| **The field is as additive as a field can be**: a record written before it parses with NO `intent` key at all, and `null`, `''` and a whitespace-only note ALL read as absent — ONE spelling of absence downstream, nothing backfilled, no default materialized | `tests/domain/entity-intent.test.ts` (4 pins, NEW) |
| **The cap is LOUD and NAMED, never a truncation**: exactly 400 characters pass; 401 fail the zod boundary with the path `intent` and a message naming the field, the limit and the remedy — and the same failure lands on the SPINE REPLY (`entities.0.intent` through `parseSpineEntities`), which is the path a production run takes (one escalated repair retry, then the run fails loudly) | `tests/domain/entity-intent.test.ts` (`the cap is enforced by the schema, not by a truncation` + `an over-long intent in a reply fails the spine parse LOUDLY, by field and limit`, NEW) |
| **A spine reply may spell absence as `null`** (the strict subset cannot omit a key) and a present note round-trips through the spine call's parse | `tests/domain/entity-intent.test.ts` (2 pins, NEW) |
| **The note SURVIVES name normalization**, which replaces `module.entityKinds` a moment after the planner records it: the canonical record gains the source record's note, an ABSORBED variant still hands its note to the canonical it resolved to, a source with no note leaves the record untouched BY IDENTITY, the same note on two variants is one note, and two DIFFERENT notes are refused loudly by name (never picked) | `tests/domain/entity-intent.test.ts` (5 pins, NEW) |
| **ONE reader**: `entityIntentFor` matches case-insensitively, trims, and returns `null` for an unknown name, a `''` note and a whitespace-only note | `tests/domain/entity-intent.test.ts` (2 pins, NEW) |
| **The brief's exact composition**: deleting exactly the intent paragraph plus the blank line it brought from the WITH-note brief reproduces the no-note brief character for character (so the REST of the brief did not move); the paragraph sits AFTER `What this artifact OWNS — one fact, one owner:` and BEFORE the `Additional instruction: …` one, which still ends the brief | `tests/features/entity-intent-brief.test.tsx` (2 pins, NEW) |
| **The paragraph's words are the SPEC's**, transcribed in the test rather than imported, so a reworded hierarchy sentence fails the pin | same pin (the literal) |
| **A kind that owns its boundary (`npc`) still gets the paragraph**, in the same position | `tests/features/entity-intent-brief.test.tsx` (NEW) |
| **BYTE-IDENTICAL when there is no note**: key absent, `null`, `''` and whitespace all `toBe` the brief built by hand with no intent, and no empty paragraph ever appears (no `\n\n\n`) | `tests/features/entity-intent-brief.test.tsx` (2 pins, NEW) |
| **The pre-existing byte pins are UNCHANGED and GREEN**: `kindOwnershipBoundary.test.ts` (14) and `persona-request.test.ts` assert exactly the no-note briefs this landing must not move — as do `change-artifact-instruction.test.ts` and `moduleGen-cast.test.ts` | those four files, untouched, in the gate |
| **The note is ABSENT from every reader-facing surface**, with the fixture proved NON-VACUOUS in the same pins (the note IS on the row and DOES reach the brief, so the silence means "never reads the field") | `tests/features/entity-intent-brief.test.tsx` (5 pins, NEW): `moduleDocumentText` + `assembleModulePartsDocument` (the text every export wiki-strips), the `WikiMarkdown` READER render (chips + raw-token tooltips, with the chip asserted present), `buildModuleDefinition` JSON (the module PDF document model), and the entity PANEL's own rows (`useModuleEntities` — no note field exists to print) |
| **The batch hands the record's note to the worker**, and the note is read PER ENTITY (a neighbour with no note keeps a clean brief) | `tests/features/entity-intent-batch.test.ts` (3 pins, NEW; the engine is faked, the brief STRING is the assertion target, as `entity-batch-fixed-cast.test` does at this seam) |
| **The CHANGE/refill lane receives it too** — the seam the owner will use to see the difference. It is covered BY CONSTRUCTION (the lane re-enters `runEntityBatch` with the module row, `change-artifact.ts:353`) AND by two explicit pins that drive the REAL `changeArtifact` seam: with a note the brief carries the paragraph, without one it carries the pre-change bytes | `tests/features/entity-intent-batch.test.ts` (2 pins, NEW) |
| **The spine call ASKS for the note** in the app's own voice, and the emitted contract makes `intent` REQUIRED-nullable — while the STYLE-COMPOSED user prompt contains no `"intent"` at all, which is why every classic fixture under `tests/fixtures/promptStyles/` is untouched | `tests/llm/moduleGen.test.ts` (the spine-contract pins, EXTENDED in place: same test, same emitted-schema assertions, plus the intent ones) |

**THE PLACEMENT OF THE REQUEST IS A MEASURED DECISION, not a style preference.**
The clause rides the spine call's SYSTEM message (`moduleGen.SPINE_ENTITY_INTENT`)
and not a `contract.*` value, because the spine fixtures keep their original
"byte-identical to the pre-styles builders" meaning (docs/18 §4): a contract-value
clause would re-render the composed spine prompt for every existing module and
retire that provenance, and it would sit inside the owner's EDITABLE style, where
an app contract must not live. The pin that keeps it honest is the negative half —
`expect(userContent).not.toContain('"intent"')` — with
`promptStyles-classic-identity.test.ts` green and all eleven fixtures byte-unchanged.

**NO PRE-EXISTING PIN NEEDED NEW BYTES — measured, not assumed.** The whole
pre-existing suite is GREEN at the changed tree with the two named brief-pin files
untouched; the only pre-existing test file EDITED is `tests/llm/moduleGen.test.ts`,
whose spine-contract test gained assertions about the emitted schema, the system
message and the absence from the composed prompt (a tightening: every assertion it
already had is still there, and the top-level property list it asserts is
unchanged).

**REVERT-PROVEN** (each injection applied to the exact executing line, printed back
with `grep -n` and `git diff --stat` checked BEFORE the run, one suite at a time at
`CAMPAIGNER_TEST_WORKERS=2`, raw output kept in the slice's scratch, then restored
from an OUT-OF-TREE copy and verified with `git hash-object` —
`src/domain/module.ts` `598dd732102c9aac5cce2c275ac7008e73117a22` and
`src/features/modules/persona-request.ts`
`dc9fed3b3f002280a539553c3694be4802ccbf5a` before and after; `git checkout --`
restores HEAD and would have destroyed this uncommitted work, so the backups were
taken first):

| injection | line it hits | result |
|---|---|---|
| **I1 — the record's note read as ABSENT** (`entityIntentFor` returns `null`): the ONE place the note is READ | `domain/module.ts:659` (`return null; // INJECTION I1`, printed back) | **RED 7 / GREEN 76** over the 7 files run (3 new + the 4 pre-existing brief-pin files). RED: the `entityIntentFor` read pin, both batch pins that expect the note, the change-lane pin, both exact-composition pins and the non-vacuity pin. GREEN: **every pre-existing brief pin** — `kindOwnershipBoundary` (14), `persona-request`, `change-artifact-instruction`, `moduleGen-cast` — i.e. the no-note bytes never notice |
| **I2 — the paragraph itself disabled** (`intentParagraph` returns `null`): the brief's own emission | `features/modules/persona-request.ts:147` (`return null; // INJECTION I2`, printed back) | **RED 7 / GREEN 76**, and the RED set differs from I1's by exactly one pin (the direct-call `npc` pin, which passes the note positionally and never touches the record reader). GREEN: the same four pre-existing files plus the domain record file — so BOTH ends of the wiring (the read and the paragraph) are forced by a pin of their own |

**UNPROVEN, stated plainly (docs/17 row 141 says what to look for).** No test can
show that a model OBEYS the intent paragraph: every pin is a byte pin on a composed
string plus a plumbing pin at the seam, so a model that ignores the note produces
the old output and no test fails. No test can show that the spine RELIABLY fills the
field either — every run in the suite mocks the transport, so "the planner, prompted
in production, writes a useful intent" is unmeasured (the same limitation row 107
recorded for the bestiary slot). The absence pin covers the surfaces that exist
TODAY; it does not render the full `EntityPanel` (its row type `EntityEntry` is
pinned to carry no note field instead), and slice B — the owner-editable field — is
NOT built and must extend that pin when it lands.

### Entity level hints — the module writer's structured level reaches the generators (docs/17 row 197, docs/08-MODULE-DESIGNER §M4-C, docs/18 §2.2)

The owner introduced *"a level 7 gnome"* in his module premise and *"the NPC generator
that then made the entity created the gnome at level 1"*, then asked for *"a hint for
the entity generators"*. The measured cause: the NPC stat-block lane recovered a level
only by REGEX over the brief (`runEngine.runStatblock`, `/level\s*(\d{1,2})/i`), so a
level stated in the module's own prose was lost at the entity boundary. The channel is
the entity RECORD (`moduleEntityKindSchema.levelHint`, beside `intent`), read by the
batch into TWO structured places: the detail brief's own paragraph and the run's
`entityLevelHint`.

| fact pinned | where |
|---|---|
| **The field is as additive as `intent`**: a record written before it parses with NO `levelHint` key, and `null`/`''` read as absent; a numeric string is coerced (meaning-preserving) | `tests/domain/entity-level-hint.test.ts` (NEW) |
| **MALFORMED is LOUD by field, never a clamp**: 0, 21, 3.5, `'seven'`, `true`, `{}` each fail the zod boundary with the path `levelHint`, and a reply value of 99 fails `parseSpineEntities` at `entities.0.levelHint` — the path a production run takes (one escalated repair, then the run fails) | `tests/domain/entity-level-hint.test.ts` (NEW) |
| **The hint SURVIVES name normalization**, which replaces `module.entityKinds` a moment after the planner records it: a variant-keyed hint rides onto the canonical record, a no-hint source leaves the record's shape untouched, and TWO DIFFERENT levels for one canonical are refused loudly by name | `tests/domain/entity-level-hint.test.ts` (NEW) |
| **ONE reader and ONE comparison**: `entityLevelHintFor` matches through `sameAliasName`, and a differential requires `entityKindFor`, `bestiarySlotForEntity`, `entityIntentFor` and `entityLevelHintFor` to answer for exactly the same case/composition spellings of a name | `tests/domain/entity-level-hint.test.ts` (the differential pin, NEW) |
| **The unmatched derivation is the SAME comparison the kind lookup asks** (`unmatchedEntityLevelHints` over wiki-link mentions) | `tests/domain/entity-level-hint.test.ts` (NEW) |
| **The WRITER is asked, and told WHY**: the spine system message contains `"levelHint"`, the 1..20 range, `"SURVIVES into the entity the generators build"` and `"levelHint": null`; the emitted strict schema carries `levelHint` REQUIRED-nullable; the style-composed user prompt contains no `"levelHint"` (so the classic fixtures are untouched) | `tests/llm/moduleGen.test.ts` (the spine-contract test, EXTENDED in place) |
| **The brief's paragraph is the SPEC's**, renders immediately after the party-level line it overrides, and omitting the hint (or spelling it `null`) is BYTE-IDENTICAL to the pre-field brief | `tests/features/persona-request.test.ts` (EXTENDED) and `tests/llm/module-gen-and-provenance.test.ts` (the scaffolding marker pair + the no-hint absence pin) |
| **The batch threads the hint as STRUCTURED input**: the brief carries the paragraph AND `startRun` receives `entityLevelHint: 7`; a neighbour with no hint gets NEITHER (no paragraph, no run-input key) | `tests/features/entity-level-hint-batch.test.ts` (NEW; engine faked, the brief string and the run INPUT are the assertion targets) |
| **An UNMATCHED hint is a LOUD named issue** and never invents an entity: exactly one toast naming the recorded name and level, the pasteable `[campaigner] entity level hint unmatched` console record, and no brief built for the orphaned name | `tests/features/entity-level-hint-batch.test.ts` (NEW) |
| **The hint's level WINS over a conflicting `level N` sentence in the brief**, read as a TYPED run input; the reply's divergent printed level produces a step notice naming BOTH levels (the NPC lane's honest-deviation route) | `tests/llm/runEngine.test.ts` (EXTENDED) |
| **The no-hint stat-block prompt is byte-identical**: the pre-existing `at level 3, grounded in the rule excerpts.` sentence, with no hint clause and no deviation notice | `tests/llm/runEngine.test.ts` (EXTENDED) |
| **The hint is VISIBLE read-only**: the entity panel row carries an `entity-level-hint` badge (`data-level="7"`) for the hinted record and NO badge for its neighbour | `tests/features/entity-panel.test.tsx` (EXTENDED) |
| **The run row carries it for resume/retry**: a pre-field row parses with `entityLevelHint: null`, and `createRun`+`getRun` round-trip the value | `tests/db/runRepo.test.ts` (EXTENDED) |

**INJECTION-PROVEN, every arm's file hash printed with `git hash-object`, each
restored from HEAD inside a `trap`, one suite at a time under a single held suite
lock (`/tmp/campaigner-entity-hints-diff.sh`, raw logs in
`/tmp/campaigner-entity-hints-diff/`). No arm was VOID — every injected hash
differs from its baseline and every injection reds a NAMED pin.**

| arm | injected file (hash before → injected → after) | observed |
|---|---|---|
| **A — baseline** | `src/llm/runEngine.ts` `0447ac33e0f46251190fa853e1a2cea58a255c7d`; `src/features/modules/entity-batch.ts` `b5378a172873dfc13e477921080636afa97c6ea3` | GREEN: pin 1 (1), the batch file (5), the domain file (18) |
| **B — the stat-block path ignores the structured hint** (`const levelHint = briefLevel`) | runEngine `0447ac33…` → `ca9f3012ce10987d80f5824e51efc4a5b5e152f4` → `0447ac33…` | **RED 1**: `the structured level hint WINS …` — `expected 'Fill the StatBlock for "Grix" at leve…' to contain 'at level 7'` |
| **C — the unmatched-hint check removed** (`reportUnmatchedEntityLevelHints(module)` → a no-op) | entity-batch `b5378a17…` → `33cf257d1d65ec611cb449680baf6536752bf106` → `b5378a17…` | **RED 1**: `reports the recording name and level, and never invents an entity for it` — `expected "vi.fn()" to be called 1 times, but got 0 times` |
| **D — the hint dropped before the batch** (`? entityLevelHintFor(…)` → `? null`) | entity-batch `b5378a17…` → `55cd6c5a47e28085b531d915d489c9dd5337a089` → `b5378a17…` | **RED 2**: `a target whose record carries a hint gets the paragraph AND the run input field` (`expected 'Detail the entity "Kael the Grey" …' to contain "The module fixes this entity's level…"`) and `is read per ENTITY …` (`expected undefined to be 7`) |

### The recorded level reaches a TARGETED refill through the engine (docs/17 row 206, docs/18 §2.2 row 193 amended)

Row 197 delivered the module writer's level to the generators through the ENTITY
RECORD, but the owner regenerated a module-owned NPC whose record says 7 and got
level 13 with NO warning and an unfiltered spell vocabulary. The measured cause is
a MISSING COPY, not a wrong one: the artifact editor's "Regenerate with AI"
rebuilt `StartRunInput` from scratch, so `entityLevelHint` never reached
`runStatblock`; the level clause came out empty, the deviation guard was keyed on
the same absent field (hence the silence), and `mobCasterLevel('')` applied no rank
cap. The cure is ONE engine seam, not a per-caller patch: `targetModuleGrounding`
(already computed for every targeted generate run) now carries the record's level,
and `runStatblock` resolves `input.entityLevelHint ?? context.moduleGrounding?.entityLevelHint`.
The same slice closes the fallback's second fragility (`buildEntityBrief`'s
generated party-level line used to be regexable as the ENTITY's level) and makes a
module-owned entity with NO recorded level LOUD on the existing `notice` seam.

| fact pinned | where |
|---|---|
| **The regression pin**: a TARGETED refill of a module-owned npc (record 7) whose brief contains NO level and whose run input carries NO `entityLevelHint` → the stat-block prompt contains `at level 7` and the author instruction, AND the resolved level reached the vocabulary cap (`pf2eCantripRankFor(7)` = 4: the rank-3 spell is offered, the rank-6 spell is NOT) | `tests/llm/runEngine.test.ts` (NEW) |
| **The deviation notice names BOTH levels** when that run's reply prints 13 (`fixed this entity at level 7` / `written at level "13"`) — keyed on the RESOLVED level, so a grounding-borne hint is guarded like a run-input one | `tests/llm/runEngine.test.ts` (NEW) |
| **The party-line trap**: a brief containing only `Party of 4 adventurers at level 13.` builds NO level clause (the phrase still rides the prompt as part of the brief); the fallback reads `roomBudget.withoutPartyLevelLines(input.brief)` | `tests/llm/runEngine.test.ts` (NEW) |
| **The loud absence**: a module-owned target whose record fixes NO level and whose run input carries none produces the named `records no level for this entity` notice AND the run completes (the block is kept, never a failed generation) | `tests/llm/runEngine.test.ts` (NEW) |
| **Resume/compatibility**: a stored retrieve-step grounding whose `moduleGrounding` lacks the new field parses, the run completes, and the legacy brief regex supplies the level — nothing a pre-206 store never wrote is read | `tests/llm/runEngine.test.ts` (NEW) |
| **ONE seam owns the resolution** (AGENTS rule 4): source scan — `input.entityLevelHint ?? recordedLevel` at exactly one site, `withoutPartyLevelLines` defined once (`llm/roomBudget`) and called once (the statblock fallback), and NO `.exec(input.brief)` reader anywhere in `src/` | `tests/architecture/one-level-resolution.test.ts` (NEW) |
| **The entity-batch paths are unchanged**: their brief bytes with a hint and their `startRun` input stay exactly as row 197 pinned them (the hint is applied once; `input` wins over the grounding) | `tests/features/entity-level-hint-batch.test.ts` (5/5) + `tests/features/persona-request.test.ts`, byte-unchanged |

**INJECTION-PROVEN, every arm's file hash printed with `git hash-object`, each arm
restored from HEAD inside a `trap`, the suite lock held BEFORE injecting, one suite
at a time (`/tmp/campaigner-level-hint-scratch/diff.sh`, raw logs in
`/tmp/campaigner-level-hint-scratch/diff/`). No arm was VOID — every injected hash
differs from the baseline and every injection reds a NAMED pin.**

| arm | injected file (hash before → injected → after) | observed |
|---|---|---|
| **A — baseline** | `src/llm/runEngine.ts` `5b68a7c59a2e65b4ae64a61cedd3cfe586a4805d` | GREEN: 2 files / 39 tests |
| **B — the grounding read removed** (`const recordedLevel = context.moduleGrounding?.entityLevelHint` → `undefined`) | runEngine `5b68a7c5…` → `6a28a148692f135d327883eb65facc80b8294e1a` → `5b68a7c5…` | **RED 1**: `a TARGETED refill of a module-owned npc resolves the recorded level …` — the prompt loses `at level 7` and the rank-6 spell is offered (the cap went null) |
| **C — the fallback allowed to read the party line again** (`withoutPartyLevelLines(input.brief)` → `input.brief`) | runEngine `5b68a7c5…` → `5af0a2034926458ec9d36825437e698e767048e0` → `5b68a7c5…` | **RED 2**: the party-line pin (`at level 13, grounded` appears) and the source scan (the exclusion call is gone) |
| **D — the loud-absence notice removed** (`moduleLevelHintAbsenceNotice(…)` → `null`) | runEngine `5b68a7c5…` → `9ed70f3ab505d50e5bb6136c20f094b0e2e8c379` → `5b68a7c5…` | **RED 2**: the loud-absence pin and the stored-grounding compatibility pin (which asserts the absence is now LOUD on a pre-206 store) |

**SUPERSEDED IN PART by docs/17 row 247** — the loud-absence NOTICE and the deviation
NOTICE above are DELETED (a sentence beside the wrong number was the owner's defect): a
module-owned entity with no EXACT level is now BOUNDED by its module's band, and a reply
that leaves the resolved level (or the band) is repaired once and then REJECTED. The
party-line exclusion and the ONE-seam resolution introduced here are unchanged and still
pinned; `one-level-resolution.test.ts` now names the four-source precedence expression and
the ONE `level N` reader (`roomBudget.firstLevelInText`). The row-247 matrix:

| arm | injected file (sha256 before → injected → after) | observed |
|---|---|---|
| **A — baseline** | `src/llm/runEngine.ts` `0a27e1f2ab8194e39b82de9b60482d116bd8cfd510480cf285f6b9191c884e7c` | GREEN: 2 files / 54 tests |
| **B — the fix removed**: `resolvedLevel` cut back to the recorded hint only, `levelIssue` forced `null`, the `needsStatBlock` veto restored, and the party line back in the prompt | runEngine `0a27e1f2…` → `075e3cb155e2799bb8d66fdbbe8f50797a3a0961425ffaf2764882f576336276` → `0a27e1f2…` | **RED 7**, every acceptance pin by name: the premise-level mob (`at level 5` missing, then `'3'` vs `'5'`), the explicit redo (no clause, no regeneration), the deviating reply (run completed instead of failed), the resolved-hint bind + the grounded refill (`'13'` vs `'7'`), the party line back in the prompt, and the band-bounded module; the ORDINARY-refill file stayed GREEN in BOTH arms (the must-not-break arm) |

Raw log: `.gate-logs/row247-full.out` (the full gate) and
`revert-proof-row247.log` (this differential), both in the worktree.

### A mob has ONE level — the block is the truth, the hint is an intent, and the premise is not a level source (docs/17 row 282, docs/18 §2.2 rows 200/203 + §5)

Row 247's premise half is REVERSED here, on the owner's ruling: the premise is a
campaign story introduction, so `roomBudget.moduleStatedLevel` now reads
STRUCTURE only (the mentioning part's level by name, else an EXACT band) and
`moduleGen.normalizeAndSave` stamps no module-wide level on a RANGE-band module.
The chip reads the MINTED block through the ONE reader
(`llm/encounterRoster.mobLevelText` / `mobLevelFor`), shows the hint only as
labelled intent (`target level N`) and names a disagreement; `runStatblock`'s
chain head is the minted block (`const recordedLevel = mintedBlockLevel ??
storedHint`), the disagreement rides the step's EXISTING `notice`, and the
generated entity-hint paragraph is stripped from that step's prompt
(`withoutEntityLevelHintLines`). The reader's two measured false positives are
closed: no crossing a LINE BREAK, and no abutting digits for a non-CJK word.

| fact pinned | where |
|---|---|
| **The chip reads the BLOCK**: a minted level-1 block beside a stored hint of 7 renders `entity-level-block` `level 1` AND the intent badge `target level 7` whose title names both numbers ("the block wins"); a block with no hint renders ONLY the block; an agreeing hint adds no second badge | `tests/features/entity-panel.test.tsx` (3 arms) |
| **No block ⇒ labelled intent, never a bare level**: the exact text is `target level 7` and no `entity-level-block` exists | `tests/features/entity-panel.test.tsx` |
| **The MINTED block outranks a contradicting stored hint at generation**: the prompt says `at level 1` and carries the `'block'` clause, the stored 7's paragraph is GONE from that prompt, the persisted block stays level 1, and the step `notice` reads "The module records level 7 … but its stat block is level 1 … the recorded level was not used"; the CONTROL arm (same hint, NO block) keeps the paragraph and resolves 7 | `tests/llm/runEngine.test.ts` |
| **The PREMISE is not a level source**: a 1–3 RANGE module whose premise says `level 5` and whose mentioning part states 1 resolves 1, the prompt never says `at level 5`, and a reply at 3 is repaired once then REJECTED | `tests/llm/runEngine.test.ts` |
| **A RANGE module stamps NO module-wide level**, while an EXACT band IS recorded and never overwrites the planner's own per-entity `levelHint` | `tests/llm/moduleGen.test.ts` (2 arms) |
| **Structure only in the derivation**: the premise's `Stufe 5` still READS as 5 through `firstLevelInText` and is NOT a level source; an exact band resolves; an exact band is not overridden by louder premise prose | `tests/llm/level-language.test.ts` |
| **The two hardened boundaries**: `Stufe\n7` / `Stufe\r\n7` / `Stufe\u000b7` → `undefined`, while TAB and NBSP still separate; `Stufe7` / `level5` / `уровень7` → `undefined`, while `Stufe 7`, `レベル7` and `等级7` resolve | `tests/llm/level-language.test.ts` |
| **ONE reader for a mob's level** (AGENTS rule 4): source scan — `mobLevelText`/`mobLevelFor` defined once in `llm/encounterRoster`, called by the chip, the stat-block card and the engine; `const recordedLevel = mintedBlockLevel ?? storedHint` and the `resolvedLevel` expression each at exactly one site; `withoutEntityLevelHintLines` defined once and called once | `tests/architecture/one-level-resolution.test.ts` |

**REVERT-PROVEN, five arms, every arm's sha256 printed, every file restored
byte-identically from `.gate-logs/row282-writer/`, no two arms identical (raw
logs `.gate-logs/row282-inject-i…v.log`; all five were run from the WORKTREE at
default workers, one file cohort per arm):**

| arm | injected file (sha256 before → injected → after) | observed |
|---|---|---|
| **i — the chip ignores the block** (`mobLevelFor(entry.artifact)` → `undefined`) | `entity-panel.tsx` `e0ebeb33…` → `fb3428f3…` → `e0ebeb33…` | **RED 2**: `reads the MINTED BLOCK as the fact …` and `shows ONLY the block when the hint agrees with it` |
| **ii — the bare-level wording restored** (`target level {hint}` → `level {hint}`) | `entity-panel.tsx` `e0ebeb33…` → `194866df…` → `e0ebeb33…` | **RED 1**: `expected 'level 7' to be 'target level 7'` |
| **iii — the disagreement dropped from the notice list** | `runEngine.ts` `75bcf166…` → `88e4052a…` → `75bcf166…` | **RED 1**: the block-wins pin, on `expected '' to contain 'The module records level 7…'` (the prompt arms stayed GREEN — the notice is the pin, not the clause) |
| **iv — the premise source restored in `moduleStatedLevel`** | `roomBudget.ts` `e5110421…` → `c6e1d3c3…` → `e5110421…` | **RED 2**: `reads the module's stated level from STRUCTURE only …` and `records NO levelHint from the PREMISE on a RANGE-band module` |
| **v — the pattern reverted to `\s*` + `*`** | `language.ts` `6858be83…` → `dacbd81f…` → `6858be83…` | **RED 1**: `hardens the two measured reader false positives` |


### The refill names its target, and a foreign returned name is refused (docs/17 row 226, docs/18 §2.1/§2.2)

The owner regenerated «Hilde Marben» from the artifact editor and got *"this NPC
is also known as \"Fennwick Morsgrimm\""* — a completely different NPC — with the
content rewritten to fit Fennwick. The measured mechanism is one chain: the
refill's brief was NAME-LESS, the deliberate co-mention grounding injected the
neighbour's module prose, the model answered `name: "Fennwick Morsgrimm"`, and
`runFinalize` turned that returned name into an alias of the TARGET row with no
cross-artifact check. The cure is the entity lane's own mechanism — the target's
name stated VERBATIM in the prompt, through the ONE composer
`promptScaffolding.entityNameVerbatimSentence`, read off the target row the
engine already loads (`targetModuleGrounding.targetName`, the row-206 shape) —
plus a safety net at ONE repository seam: `artifactRepo.foreignAliasNames` is
the ONE lookup for "does this name already answer for a different artifact?",
every alias write asks it, and a refused name is never stored but IS spoken.

| fact pinned | where |
|---|---|
| **THE REPORTED CASE, end to end**: two NPCs co-mentioned in one module paragraph; the target refilled with the panel's generic brief; the mocked reply answers as the neighbour → the draft prompt carries `entityNameVerbatimSentence('Hilde Marben')` and the registered verbatim-name marker, the grounding really injected BOTH blocks (`expansionExcerpts`), the stored row keeps its name while `summary`/`body`/`data` are the reply's, `aliases` does NOT contain the neighbour, the neighbour's row is byte-untouched, and the `finalize` notice AND a toast both say it was NOT attached | `tests/llm/runEngine-refill.test.ts` (NEW `describe`, 1 pin) |
| **The non-foreign arm is UNCHANGED** (the row's pre-existing pin): a model name that is a VARIANT of the target still becomes an alias, exactly as before — the old assertion is kept byte-for-byte, only its comment now says which arm it pins | `tests/llm/runEngine-refill.test.ts` (the existing first pin) |
| **The repository guard**: another artifact's NAME and another artifact's ALIAS are both refused and reported (`refused`), the requested row writes NOTHING (no revision, no `updatedAt` move), the owner row is byte-untouched, a mixed batch attaches its accepted half, a name nothing else answers still attaches (non-vacuity), and the exported lookup answers directly | `tests/db/artifactRepo-alias.test.ts` (5 NEW pins + the outcome shape on the 6 pre-existing ones) |
| **The outcome shape**: `addArtifactAliases` returns `AliasWriteOutcome { artifact, refused }`; a caller that ignores `refused` cannot be silently wrong because the row was not written either | `tests/db/artifactRepo-alias.test.ts` |
| **EXACTLY ONE foreign-name lookup** (AGENTS §Centralization 2): `foreignAliasNames` is DEFINED once (`db/artifactRepo.ts`) and the only files that ASK it are the write seam plus the two combined-patch writers (`llm/runEngine.ts`, `features/modules/entity-batch.ts`); `aliasCollisionSentence` is defined once (`domain/artifactAlias.ts`) — a future hand-rolled "does another artifact answer this name?" reds by file | `tests/features/alias-merge-seam.test.ts` (NEW source-scan pin) |

**The brief's own characterization of the old pin is corrected here**: it does
NOT "pin the defect" — it pins a legitimate variant-name alias and never
exercised the discriminating input (another artifact's name). It is therefore
SPLIT, not deleted: the kept arm + the new foreign arm.

**TWO PRE-EXISTING FIXTURES WERE CORRECTED, named before/after — the guard was
not weakened; the fixtures encoded the ambiguity it refuses.** `tests/features/
entity-panel.test.tsx`'s `respondToBatch` returned ONE invented name
(`Watcher of the Crypt`) for EVERY entity of a multi-entity batch, so two
artifacts answered one name and the guard refused the second; the mock now
derives a per-entity name from the brief's own `Detail the entity "…"` line
(`Kael the Watcher`), and the single assertion that named the old constant
(`kael.aliases` contains) now names `Kael the Watcher`. `tests/features/
generate-everything.test.tsx`'s `DRAFT` mock likewise returned one constant
`Drafted` for every entity; it is now `draftedReply(messages)`, deriving
`${entity} the Drafted`. No assertion was weakened — each still requires the
produced artifact to keep the model's invented name as an alias; only the
invented name's SUBJECT changed (before: one constant shared by all entities,
which is itself the collision).

The REVERT-PROVEN arms, every arm's `git hash-object` printed, each restored
from an OUT-OF-TREE copy (never `git checkout HEAD --`), the gate runner holding
the suite lock, raw logs in
`/tmp/campaigner-npc-scratch/armlogs/` (the arm runner lives in
`/tmp/campaigner-npc-scratch/`). Baseline engine
`8ab66e53717a97252a0da5ddd7d19e379de24f92`, artifactRepo
`2465d4c87030ae950e44223558a45d7ecd5a9929`; every INJECTED hash differs from the
baseline (no VOID probe) and every arm restored to the baseline hash.

| arm | injected file (hash before → injected → after) | observed |
|---|---|---|
| **A — baseline** | engine `8ab66e53…`, artifactRepo `2465d4c8…` | **GREEN 2 files / 24 tests**, lint 0 errors, typecheck clean |
| **B — the NAME ANCHOR removed** (`entityNameVerbatimSentence(context.moduleGrounding.targetName)` → `entityNameVerbatimSentence('NAME-ANCHOR-REMOVED')`) | runEngine `8ab66e53…` → `343f17e74393c90aab77463553a7b943fd894585` → `8ab66e53…` | **RED 1 / 12**: the reported-case pin — `expected 'Campaign: Emberfall…' to contain 'The artifact "name" field must be exa…'`; lint 0, typecheck clean. (A FIRST attempt replaced the expression with a literal `null`, which ALSO left the import unused: its red was confounded by a lint+typecheck failure and is recorded as such — the clean re-run is the evidence.) |
| **C — the FOREIGN-NAME GUARD removed at the reported refill** (the `foreignAliasNames` call answered `[]`, restoring the pre-slice merge) | runEngine `8ab66e53…` → `58097f465a078019c403bf25ffe2060bb3ded37e` → `8ab66e53…` | **RED 1 / 12**: the reported-case pin — `expected [ 'Fennwick Morsgrimm' ] to not include 'Fennwick Morsgrimm'` (the foreign alias came back) |
| **D — the guard made to compare by SUBSTRING** (`sameAliasName` → `…trim().toLowerCase().includes(…)`) | artifactRepo `2465d4c8…` → `83a54839258ac7df893863a630f415934b9d7b87` → `2465d4c8…` | **RED 1 / 10**: the precision pin — `expected [ { name: 'Fennwick', … } ] to deeply equal []`, i.e. the guard's exact comparable-name precision IS pinned |

### Prompt scaffolding echoed back into a document (docs/17 row 142, docs/18 §2.2/§4)

The owner found OUR OWN brief printed in a generated artifact — *"The artifact
\"name\" field must be exactly \"Nisselkraut\" — verbatim, with no epithets,
titles, or additions (put those in the body). Do not invent unrelated
sub-plots; make this entity serve the module text. Campaign grounding (derived
from wiki-links): -"*. Those are three of the sentences WE send: two paragraphs
of `buildEntityBrief` and `campaignGrounding.GROUNDING_SECTION_HEADER`. A model
echoed its instructions and no seam had ever compared generated text against the
prompt that produced it, so the echo validated as a normal draft and finalize
wrote it into the artifact the owner reads. The fix is a MECHANICAL detector
(the strings are ours, so membership is decidable — no classifier, docs/18 §4),
ONE source for the literals (compose and detect read the same constants, AGENTS
rule 4), and a LOUD failure at every boundary that would persist reader-visible
text — never a strip, never a placeholder.

Its own function is one seam: `generatedTextHygiene.generatedTextScanForFields`
carries escape debris (its historic scope) AND this echo, so a boundary cannot
silently lose half the check — and it returns `{ issues, reasons }`, naming which
of the two classes fired (docs/17 row 152, whose pins are in the next section).

| fact pinned | where |
|---|---|
| **The three markers the OWNER reported are caught at the REAL finalize seam**, each naming the marker and `draft.body`, with no artifact created and no result link — plus the two further brief literals (the module-premise label and the row-140 ownership boundary) through the same `it.each` | `tests/llm/scaffoldingEcho.test.ts` (5 pins, NEW) |
| **The MODULE path passes the SAME seam**: `parseSpine` throws on a spine `premise` that echoes the scaffolding (naming `spine.premise` — the throw lands in the spine's existing one-repair turn, which is the bounded retry), and a module PART whose prose echoes it is written `failed` with the marker named and its markdown NEVER stored | `tests/llm/scaffoldingEcho.test.ts` (2 pins, NEW) |
| **The literals are ONE source** — the pin that fails if a composer's label and the detector's marker diverge: the composed brief is ITSELF detected, against the exact expected label set (a composer that stops reading a shared constant reds it) | `tests/llm/scaffoldingEcho.test.ts` (`the brief we SEND is itself scaffolding…`, NEW) |
| **Every shared literal is DETECTED on its own** (12 pins, `it.each` over the constants the composers render): a marker that could not fire is a marker nobody would notice going dead | same file (`every shared literal is DETECTED on its own…`, NEW) |
| **The marker set is the owner's own bytes**: the constants the reporters quoted are pinned byte-exact, so the detector cannot be watching something the model was never sent | same file (`the literals the OWNER saw are markers, byte-exact`, NEW) |
| **FULL literal, never a fragment** — a truncated run of a marker's own words does not fire | same file (`matches the FULL literal…`, NEW) |
| **NO FALSE POSITIVES**: ordinary prose about the same subjects (\"The GM should not invent new factions…\", \"Do not invent unrelated sub-plots for the party to chase…\", \"Where it is mentioned twice…\", \"The party is level 3…\") yields NOTHING | same file (`a generically similar sentence…`, NEW — GREEN, the brief's rule 4) |
| **Identity leaves are out of scope BY OWNER, not by key**: `documentTextFields` keeps `body`, `monsters[].notes`, the stat-block `traits`/`actions`/`reactions`/`legendary` entry NAMES and `pointsOfInterest[].name`, while the walked record's own `name`, a roster creature's `name`, a spell name and `aliases`/`tags`/`suggestedTags`/`id` stay out | same file (`identity fields are NOT this seam's business: the OWNER decides…`, amended by docs/17 row 218) |
| **The brief is BYTE-IDENTICAL to the base commit** after the literals moved: three argument sets (context-free, encounter, location with its ownership boundary) compared against a FROZEN `JSON.stringify` of the BASE module's own output at `d94d4e9` | same file (3 pins, NEW) |
| **SCAN — no boundary may call the debris half directly** (it would drop the scaffolding half): `debrisIssuesForFields(` appears only in its own definition and in the aggregate, over `src/**`; and the six boundaries that persist reader-visible text all call the aggregate | same file (2 SCAN pins, NEW) |

**REVERT-PROVEN** (I1, applied to the exact executing line, printed back and
`git diff --stat` checked BEFORE the run; the clean-set run of the same 13 files
was `230 tests`, 0 failures (the three entity-intent test files row 141
landed concurrently are IN that set); one suite at a time at `CAMPAIGNER_TEST_WORKERS=2`,
raw output kept in the slice's scratch, then restored from an OUT-OF-TREE copy —
NEVER `git checkout --`, which restores HEAD and would have destroyed this
uncommitted work):

| injection | line it hits | result |
|---|---|---|
| **I1 — the DETECTOR DISABLED** (`for (const marker of SCAFFOLDING_MARKERS.slice(0, 0))` — the loop reads no marker, nothing else touched) | `src/llm/promptScaffolding.ts:249` (the injected line, printed back) | **RED 21 / GREEN 209.** RED: EXACTLY the pins that assert detection — the one-source pin, the other-brief-shapes pin, the 12 per-literal detection pins, the 5 entity `it.each` pins, the spine pin, the part pin. GREEN: all **200 OTHER tests in the same run** — escape-debris finalize and module part, the brief byte pins, the 14 row-140 boundary pins, canvas refine, canvas chat changes, the module plan, module canvas, the encoding-hygiene unit tests, and the three entity-intent files row 141 landed concurrently — so the check disturbs NO unrelated pin; plus the 9 pins in the new file that do not assert detection (the byte-exact literals, the fragment pin, the false-positive pin, the identity-field pin, the three frozen-byte pins and the two SCAN pins — the SCANs read source TEXT, so a behaviour injection cannot red them, by design) |

Restored byte-identically and proved with `git hash-object`
(`src/llm/promptScaffolding.ts` `7fbdcbcecb0b2d37f6db5637c5947f964364938e` before
and after).

**UNPROVEN.** No test can show that a MODEL STOPS ECHOING — the seam catches the
echo, it does not prevent it, and whether the failure rate on real runs is
tolerable is something only the owner's runs can show (docs/17 row 142 says what
to do if it is not). Also NOT pinned: the module spine/part PROMPT's own section
labels are not in the marker set, so an echo of one of those reaches the seam
undetected — and the same is true of the intent paragraph docs/17 row 141 just
landed, whose two literals would have to MOVE into `llm/promptScaffolding`
before they could be markers (importing them from the feature would be an import
cycle); and a USER hand-edit that pastes one of these sentences is rejected
exactly like a model echo — the accepted cost of not being able to tell a
deliberate paste from the defect (the escape-debris seam has the same property).

### The echo detector's document field set is decided by the leaf OWNER (docs/17 row 218, docs/18 §2.2)

The seam above reads the READER-VISIBLE leaves only (`documentTextFields`), and
that exclusion was by last dotted key SEGMENT — so `name` was dropped wherever it
appeared. One of those `name`s is not an identity at all:
`stat-block.tsx:187` renders `{item.name}.` for every `traits`/`actions`/
`reactions`/`legendary` entry (`domain/statblockFields.namedTextSchema.name`),
and a location's `pointsOfInterest[].name` renders as a heading in the app and
both PDFs. A scaffolding sentence or an escape-debris token echoed into one of
those reached the reader unchecked. The fix is ONE path predicate,
`generatedTextHygiene.identityLeaf`: `aliases`/`tags`/`suggestedTags`/`id` are
identity wherever they appear; a `name` is identity only when its owner is the
walked record itself (`<base>.name` — the wiki-link target) or a
`IDENTITY_NAME_OWNERS` collection (`monsters`, `spells` — creature identity and
library-resolution keys); every other `name` is prose and is scanned BY DEFAULT.
Artifact/module names deliberately stay excluded: their contract is the
verbatim-name rule, not prose.

| fact pinned | where |
|---|---|
| **The SAME scaffolding sentence is silent in an artifact NAME and the ISSUE in an action NAME**, naming `draft.actions[0].name` — the whole slice in one assertion, and the pin a bare-segment filter cannot satisfy (it drops both) | `tests/llm/module-gen-and-provenance.test.ts` (`the SAME scaffolding sentence…`) |
| **The exact field list of one shaped value**: `draft.body`, `draft.monsters[0].notes`, `draft.pointsOfInterest[0].name`/`.description` and `draft.actions[0].name`/`.text` IN; `draft.name`, `aliases`, `tags`, `suggestedTags`, `id` and `draft.monsters[0].name` OUT | same file (`identity fields are NOT this seam's business: the OWNER decides…`, amended) |
| **NO false positive** in the other direction: artifact/module `name`, `aliases`, `tags`, `suggestedTags` and `id` each carrying a marker yield NO issue and NO reason (the exclusion cannot be "fixed" by scanning everything) | same file (`every metadata key carrying a marker stays SILENT`) |
| **Non-vacuity**: an ordinary action name (`Multiattack`) yields nothing | same file (`an ORDINARY action name stays silent`) |
| **The debris class too**: a named-text NAME carrying `Flussm?fcndung` is named (`statBlock.traits[0].name`) when the boundary feeds both halves the document set — the `parseSpine` pattern, where a dropped name was invisible to the debris half as well | same file (`a named-text NAME carrying escape debris is named too`) |
| **End to end through the REAL boundary**: a `runEngine` run whose statblock `actions[0].name` echoes the brief rejects finalize, names `statBlock.actions[0].name`, records `reasons: ['scaffolding-echo']` and persists no artifact | same file (`rejects a STAT BLOCK whose action NAME echoes the brief…`) |

**REVERT-PROVEN, four arms, every injected file's hash PRINTED with
`git hash-object`, no two arms identical; the lock held before each injection
and the tree restored from HEAD in a `trap`.** A: baseline GREEN (101 tests in
the file). B: `identityLeaf` reverted to the pre-slice bare-segment filter
(`new Set(['name','aliases','tags','suggestedTags','id']).has(lastPathSegment(path))`)
→ the integration pin, the debris pin, the same-sentence pin and the exact-list
pin RED. C: the identity arm removed (`identityLeaf` returns false) → the
metadata-silence pin RED. D: the integration pin's action name mutated back to
ordinary prose → the integration pin RED (the field really flows through the
boundary, not only through the unit).

**WHAT WAS DELIBERATELY NOT WIDENED.** Artifact/module names (the verbatim-name
rule owns them; a name is never a sentence), `monsters[].name` (the existing
identity pin declares it, and it becomes the materialized NPC artifact's name),
and `spells[].name` (a key into the imported spell library that `domain/mobSpells`
already refuses loudly when unknown). And no new source scan: the duplicate-body
tripwire (docs/17 row 212) scans `tests/**` too, so a copied helper body would be
a NEW baselined duplicate — the unit assertion over `documentTextFields`' output
is the cheaper, honest pin (docs/17 row 218's own note).

### The ingest stat-block reader refuses an unstated number (docs/17 row 290, docs/18 §2/§5, docs/02 §Step 3)

`src/ingest/statblock.ts` read an anchor-dense PDF span into a stat block and
then FILLED what the source had not stated (`ac ?? 10`, `hp ?? 1`, all six
abilities `?? 10`), so an invented AC/HP/array was persisted on the chunk and
cited into encounters. The reader now returns `null` unless the text itself
stated **AC, HP and all six abilities** — the numbers `domain/statblock.StatBlock`
REQUIRES — and `speed`/`CR`/`level` stay optional. `src/ingest/chunker.ts` mints
a `statblock` chunk ONLY for a successful parse; a refused span's lines go
through the new ONE `appendToSection` and stay in the surrounding prose chunk.
The old admission bar (`coreFounds`) is deleted with the defaults it fed.

| fact pinned | where |
|---|---|
| **The refusals** — a text with AC+HP but no ability line is `null` (the exact case the old defaults turned into six `10`s); a text stating only SOME abilities is `null`; a text missing AC is `null`; a text missing HP is `null` | `tests/ingest/statblock.test.ts` (`REFUSES a block with no ability line…`, `REFUSES a block that states only SOME abilities`, `REFUSES a block with no AC, and one with no HP…`) |
| **A complete read is UNCHANGED** — the 5e fixture is asserted as an EXACT whole-object equality (every field, `extras.CR` included), so a regression in any single field reds the pin rather than passing on the fields no test happened to name | `tests/ingest/statblock.test.ts` (`reads a COMPLETE block into the exact same shape as before`) |
| **The optional fields stay optional** — a block with AC/HP/abilities and no speed/CR/level parses, with `speed: ''`, `level: ''` and `extras: {}` (the shape's own blank, not a fabricated value) | `tests/ingest/statblock.test.ts` (`keeps speed, CR and level OPTIONAL…`) |
| **The caller mints NOTHING for a refused span** — no chunk has `chunkType === 'statblock'`; the span's text is inside a `section` chunk with the heading path in force and finite pages | `tests/ingest/chunker.test.ts` (`mints NO statblock chunk for a span the source did not complete`) |
| **The span stays INSIDE the surrounding prose** — prose before and after the refused span land in ONE section chunk with it, rather than a chunk of its own | `tests/ingest/chunker.test.ts` (`keeps a refused span INSIDE the surrounding prose chunk…`) |
| **The walk continues PAST the refusal** — a later complete block under its own heading is still detected and parsed (AC 13), and the refused span's text is still present | `tests/ingest/chunker.test.ts` (`walks PAST a refused span and still reads a later complete block`) |
| **The real fixture still reads** — the committed `sample-rulebook.pdf` yields its complete statblock chunk (AC 17 / HP 66 / STR 14) | `tests/ingest/pipeline.test.ts` (pre-existing, green through the change) |

**THE PINS WERE RED-PROVEN BY INJECTION** (`python3 .gate-logs/row290/inject.py`,
raw logs `.gate-logs/row290/<arm>-*.log`; `tsc -b` exit 0 on EVERY injected tree
— NOT a lone `tsc --noEmit -p tsconfig.app.json`, which does not cover
`tests/**`; sha256 printed before and after every arm; all restored
BYTE-IDENTICALLY). **A** `ac ?? 10` restored → RED 1 (the no-AC arm). **B**
`hp ?? 1` restored → RED 1 (the no-HP arm). **C** the six `abilities.* ?? 10`
restored → RED 5 (both ability refusal arms AND all three chunker arms). **D**
the caller minting a chunk on refusal (the pre-290 shape) → RED 3 (the three
chunker arms) with every statblock arm GREEN on the same tree — the split that
proves the caller pins see the caller and not the parser. **E** the CR capture
deleted → RED 3 (the exact-whole-shape pin plus both complete-block pins). **F**
`speed ?? '30 ft.'` → RED 1 (the optional-fields pin). **THE FIXTURE RESIDUAL IS
MEASURED, NOT GUESSED:** the ONE committed real PDF fixture detects 1 stat-block
span and 1 parses completely — **0 of 1 refuses** — so the refusal arms are
synthetic and the fixture count is stated as measured (docs/18 §5).

### One HTML→text seam for the ingest layer (docs/17 row 143, docs/18 §2.2)

> **AMENDED BY REFERENCE (docs/17 row 149, landing 2).** Everything below is the
> record of the FOLD. Its two premises are now history: the fold was
> byte-preserving, and the corruption was declared rather than repaired. Row 149
> repaired the two corrupted behaviours and paid the consequence the owner had
> already accepted — see §*Landing 2* below for the pins that flipped, and
> docs/12 §5 for the re-import instruction a user meets. Read the two together:
> the row-143 pins named `LANDING 2:` are the ones row 149 flipped.


Seven pack adapters each carried their own HTML→text stripper. Nothing failed
when a copy was born — every copy was correct where it was written — so the
duplication was invisible until the copies were run against shared inputs: two
block conventions and THREE inline-notation dialects, and 17 of 39 description
blobs differing across the repo's own fixtures. Nothing could notice, because no
test had ever declared there was one way to do it. The owner saw the smell
(*"7 copies of that stripper code? Or... slight variations? That smells like
something needs to be centralized."*) and asked for the centralization; this
landing is the fold, NOT the fix.

**Why the fold is byte-preserving, and why that is not timidity.** The text a
stripper returns becomes `PackEntry.text` → the stored chunk `text` →
`contentHash = sha256Hex(text)`. `resolveMonsterEntry` resolves a citation by
uuid and then by EXACT hash, and a bundle export treats an unresolvable citation
as BLOCKING (`MissingDependenciesError`). A changed byte therefore strands
stored citations on the next re-import, with no heal path — docs/11's L1 is
deferred and no contentHash re-stamp migration exists. So the divergences are
DECLARED, not repaired.

Its own function is one seam: `htmlToText(html, style)` in
`src/ingest/packs/text.ts`, with the styles declared as data in that same
file and named for what they DO — at the fold, `AT_LABEL_LAST_LINE_BREAKS`
(PF2e item/creature), `BRACKET_LINKS_LINE_BREAKS` (dnd5e item/creature),
`AT_BRACE_LABEL_BLOCK_AND_TABLE` (PF2e rules text); **row 149 deleted the
first and moved its two lanes onto the third, leaving TWO declared styles and
eight call sites** (nine since the spells arc's heightening capture, ledger
181 — a second call to the SAME seam; see §*Landing 2* below). A new adapter
picks a declared style by name.

| fact pinned | where |
|---|---|
| **The shared sample table, all three styles, exact bytes** — 17 cases, `it.each`, of which **10 are declared divergent** and **7 are the cases the styles must AGREE on** (plain `<p>`, nested `<p>`, `<br>`-only, `<hr>`-only, entities, whitespace runs, a real-shaped PF2e ability), so a future style cannot quietly detach one of them | `tests/ingest/packs/html-to-text.test.ts` (17 pins, NEW) |
| **The four declared differences, each NAMED as landing 2's** — the `@`+brace residue (`Enfeebled{Enfeebled 1}` vs `Enfeebled 1`), group A's table collapse (`HardnessHPBT52010` vs `Hardness \| HP \| BT \| 5 \| 20 \| 10`), the table-aware style's own measured quirk (**a whole row survives as ONE line** — the cell separator's `\s*` swallows the `</tr>` newline the old copies' comments claimed was a row break), and the third notation dialect (`[[…]]{L}` / `[[…\|l]]` / `&reference[…]`, literal text in every other style) | same file (4 pins, NEW) |
| **SCAN — no second HTML→text stripper exists, and no site keeps a body of its own**: every stripper shape (`<[^>]+>`, `&nbsp;`, `@(\w+)\[`, `<br\s*\/?>`) appears in `text.ts` and NOWHERE else among the directory's ten files; all seven adapters import the seam and pass their declared style, with an EXACT call count (2 for `pf2e-foundry`, so reverting ONE of its two sites cannot hide behind the other); exactly three `export const …: HtmlToTextStyle` declarations exist, and no adapter file even mentions `blockAware` | same file (3 SCAN pins, NEW) |
| **The STORED bytes of a real fixture, one per group** — full `text` equality, never `toContain`, because the surrounding bytes are what the hash signs: `pf2e-equipment/anointing-oil.json` (the brace residue) and `steel-shield.json` (the table collapse) through the equipment lane, and `pf2e-journal/gm-screen.json` (the table rows whole) through the journal lane | same file (3 pins, NEW) |
| **The pre-existing structural pin stays green THROUGH the seam**: `Difficulty \| XP Budget \| Character Adjustment` and `Trivial \| 40 or less \| 10 or less`, asserted both as the fragments the old pin uses and as the whole section text | `tests/ingest/packs/pf2e-journal.test.ts` (untouched, green), re-pinned whole in the new file |
| **NO EXISTING PIN COVERED THE PARAGRAPH CONVENTION OR ANY COPY'S WHOLE OUTPUT** (verified, not assumed): the stripped description is asserted in exactly two pre-existing places, both `toContain` fragments; the one whole-`text` pin that touches a stripper (`pf2e-foundry.test.ts:123`) exercises an EMPTY description. The absence is the whole reason the drift was invisible — and it is also why a behaviour-only pin could never have caught it | `tests/ingest/packs/*` (measurement, no new pin) |

**How the fold was proven behaviour-free — the strongest evidence available,
and it is not a test.** The seven pre-refactor bodies were extracted VERBATIM out
of tree from the base commit (every line after the renamed declaration compared
byte-for-byte against `git show 214b86d:<path>`; all seven
`body-verbatim=true`), and:

1. **Adapter level, pre vs post.** All seven adapters were driven over ALL their
   fixtures (41 emitted `text`s across seven lanes) BEFORE the refactor and
   after it. The two dumps are **byte-identical**
   (`sha256 5a0b4ff4e8a1637134044c02a1db1b5cad0c5919dd29f3430bc3193bbe2480ba`
   both times). This is the evidence that matters, because it is exactly the
   bytes `contentHash` signs.
2. **Seam level, all seven sites.** The NEW seam, at each site's declared style,
   was compared against the FROZEN pre-refactor body for that site over the
   shared sample: **7 sites × 17 cases, 0 mismatches.**
3. The new real-fixture pins then assert the STORED bytes those dumps contained,
   so the proof is now a permanent pin rather than a scratch measurement.

| injection | line it hits | result |
|---|---|---|
| **I1 — the block/table branch DISABLED** (`if (blockAware)` → `if (false && blockAware)`) | `src/ingest/packs/text.ts:183` (the injected line, printed back; diffed against an out-of-tree copy BEFORE the run) | **RED 9 / GREEN 195** of the same 204. RED: the `flat table`, `budget table` and `block closers` sample cases, the two `LANDING 2` / one-line-row divergence pins, the `gm-screen.json` fixture pin, and the three PRE-EXISTING pins that reach a table (`pf2e-journal.test` ×2, `packFetch.test` ×1) — so the table rule is visible to behaviour because a REAL fixture asserts it |
| **I2 — the brace pre-pass DELETED** from `case 'at-brace-label'` (`return resolveAtLabelLast(html)`) | `src/ingest/packs/text.ts:156` | **RED 3 / GREEN 201.** RED: the `brace form` and `real-shaped pf2e ability` sample cases and the `LANDING 2: a @-notation brace label survives VERBATIM…` pin — **and NOT ONE PRE-EXISTING PIN.** The brace rule had ZERO behavioural coverage (the only `@UUID[…]{…}` form in any fixture is the group-A `anointing-oil.json` one; `frightened.json` has none). This is the measurement behind the source scan's existence |

Each injection was restored from an OUT-OF-TREE copy — NEVER `git checkout --`,
which restores HEAD and would have destroyed the uncommitted refactor — and
proved byte-identical with `git hash-object`
(`bdc3f1eae7fd47395d79fbe8536db5afb835496a` before and after), then the same
15 files / 204 tests re-run GREEN.

**UNPROVEN.** No test can show that a future adapter author will not write copy
eight: the source scan is a GUARD over a finite shape list, not a proof. A
stripper built from shapes nobody has ever used would slip past it — which is
why the scan also asserts the INVERSE (the seam's own shapes may appear in
`text.ts` and nowhere else in the directory), so copy eight fails the moment it
reuses a shape anyone has ever needed. And the OWNER-VISIBLE cost that landing 2
pays is unmeasured here: how many stored citations will read `missing ref` on
the next re-import of the PF2e item packs needs a real database, so landing 2
inherits "this is the accepted cost" as a DECISION, not as a number.


### A cited mob's reference and numbers — one formatter, both books (docs/17 row 144, docs/11 §What a roster row PRINTS, docs/18 §2.1/§2.3)

The owner, reading the exported module PDF: *"Encounters do not have their mobs
detailed. Makes it hard for the GM who needs to find references for mobs."* His
three answers: his roster lines read `Zombie ×4 — (see Bestiary)`; *"Keep the jump,
and list the encounter's mobs below its row in the reader's entity panel."* (a
SEPARATE slice — the reader half is still open); *"Print the numbers for cited mobs
too."* The defect was a reference the renderer already COMPUTED and then threw away
(`rosterOriginRun` used the resolved origin only for its missing-ref check and
printed the constant `' (see Bestiary)'` — a chapter the module PDF has never had),
and a single-artifact export that printed no reference at all.

| fact pinned | where |
|---|---|
| **A `rulebook` citation prints its REAL origin**: `— Bestiary p.132` for an ingested book and `— Monster Core: Cave Fisher` for a pack (the two `creatureOriginLabel` shapes), never the dead constant | `tests/domain/encounterReference.test.ts` (2 pins, NEW: `prints the REAL origin of a cited creature, not a constant`, `prints a pack citation's creature name`) |
| **The constant is PROVEN GONE**, not merely unused: a source scan over the domain seam and both exporters (comments stripped, so the prose that explains the removal does not satisfy it) finds no `see Bestiary` anywhere, with a non-vacuity check that the rule itself is still implemented | `tests/lib/roster-reference-parity.test.ts` (`the dead "(see Bestiary)" constant is gone from every source`, NEW) |
| **EXACTLY ONE implementation** (AGENTS rule 4: never centralize by prose): the formatter is the only source that spells the reference vocabulary, no exporter carries a copy, and both name `rosterReferenceFor` + `rosterStatBlockFor` — plus the single-artifact export renders `modulePdf.statBoxContent` rather than growing a second stat renderer | `tests/lib/roster-reference-parity.test.ts` (`no source composes a reference without the shared formatter`, `both exporters call the shared rule and the shared box`, NEW) |
| **The two books agree, differentially**: the SAME encounter row is built into the module definition AND the single-artifact GM definition over the same resolution, and both print the identical formatted reference (`Cave Fisher ×1 — Bestiary p.132`) and the identical no-citation statement — so a caller that formats its own line cannot pass | `tests/lib/roster-reference-parity.test.ts` (`a cited mob's reference is byte-identical in the module book and the GM export`, NEW) |
| **A cited mob PRINTS ITS NUMBERS** (owner answer 3): the chunk's own `AC`/`HP` values and its `traits`/`actions` reach the row's box in BOTH books, with the resolved origin printed ON the box (`Numbers from Bestiary p.132`) | `tests/lib/roster-reference-parity.test.ts` (`both exporters print the cited chunk's NUMBERS, with the source on the box`), `tests/lib/modulePdf.test.ts` (`prints a cited mob's OWN numbers, with the source on the box (owner decision 3)`, NEW), `tests/lib/pdfExport.test.ts` (`prints a cited mob's reference AND its numbers in the GM export`, NEW) |
| **The box carries REACTIONS, LEGENDARY and `extras`** — the three sections the module box dropped while the single-artifact exporter printed two of them: one box, both the `inline` and the cited path, so a PF2e-style block is usable at the table | `tests/lib/roster-reference-parity.test.ts` (`the shared box carries every section a PF2e-style block needs`, `a box with no source prints no attribution line`, NEW) |
| **A citation whose chunk carries no parseable block stays LOUD**: `statBlock: null` (a legitimate best-effort ingest outcome) prints the NAMED `missing ref (Cave Fisher)` line and **NO box at all** — asserted as an ABSENCE (`not.toContain('Numbers from')`, `not.toContain('44 (8d8)')`), so a placeholder or an empty box fails the pin | `tests/lib/modulePdf.test.ts` (`prints NO box for a citation whose chunk carries no parseable block`), `tests/domain/encounterReference.test.ts` (`prints NO block for a citation whose chunk carries no parseable block`), `tests/lib/roster-reference-parity.test.ts` (the same, in both books) |
| **A citation nothing can satisfy still reads as it did** — the named reason, unchanged, through `isMissingRefOrigin` (never a `=== 'missing ref'` comparison) | `tests/domain/encounterReference.test.ts` (`keeps a citation nothing can satisfy NAMED, in the same words as before`), `tests/lib/modulePdf.test.ts` (`states each roster origin through the ONE rule (C5)`, updated) |
| **An unresolved citation never becomes a claim**: a `rulebook` entry the pre-pass did not resolve prints `unresolved citation: …` LOUDLY instead of a citation-shaped line the document cannot honour (the replaced constant's exact failure mode) | `tests/domain/encounterReference.test.ts` (`never claims a citation it could not resolve`, NEW); the renderer's colour rule is covered by the existing `modulePdf.test` C5 pins |
| **`npc-ref` is UNCHANGED** where it already worked: `— see Vexra` with a real `linkToDestination`, and the named `missing ref (Vexra)` when the row is gone — `link` is only ever produced for a row the document prints | `tests/domain/encounterReference.test.ts` (`cross-references an npc-ref whose row prints…`), `tests/lib/modulePdf.test.ts` (C5, updated) |
| **`inline` and `none` are UNCHANGED except for the shared box**: no reference line for `inline` (never a "no stats" line contradicting the box beneath), the same no-citation statement for `none` | `tests/domain/encounterReference.test.ts` (2 pins), `tests/lib/modulePdf.test.ts` (`a roster entry with no citation and no resolution says what is true about it`, unchanged) |
| **The async pre-pass really feeds the renderer, end to end**: `buildModulePdf` resolves a cited roster row ITSELF (a real rulebook + statblock chunk in the DB) and the produced document carries `Bestiary p.132`, the chunk's reactions and the box attribution; the single-artifact entry point is driven through its `generate` seam so a definition builder wired to nothing cannot pass | `tests/lib/modulePdf.test.ts` (`resolves a cited roster row itself, end to end through buildModulePdf`), `tests/lib/pdfExport.test.ts` (the same pin, via `exportArtifactPdf`'s generator seam) |
| **NOTHING is materialized**: after resolving and rendering a cited encounter, the roster's own JSON is byte-identical (the export reads the citation, it never rewrites it) — the storage rule of docs/11/§12 is untouched | `tests/lib/roster-reference-parity.test.ts` (`nothing is materialized: neither exporter writes a chunk or a citation`) |
| **The pre-existing pins are UNCHANGED and GREEN**: the module PDF's other roster pins, the provenance pin (no `writerModel` in either document), `wiki-raw-export`, and `modulePdfPlan` all pass untouched | those files, in the gate |

**REVERT-PROVEN** (each injection made on the working tree, the RED set recorded,
the file restored from an OUT-OF-TREE copy and re-hashed with `git hash-object`;
`git diff --stat` printed before every run):

| injection | what it does | RED | GREEN (unchanged) |
|---|---|---|---|
| **I1** `domain/encounterResolve.ts:337` — the `rulebook` arm returns `plainReference('(see Bestiary)')` again | restores the pre-142 constant | 7: `encounterReference.test` ×2 (`prints the REAL origin…`, `prints a pack citation's creature name`), `modulePdf.test` ×2 (C5, `resolves a cited roster row itself…`), `pdfExport.test` ×1 (the GM-export pin), `roster-reference-parity.test` ×2 (the differential, and the constant-gone scan) | 62 tests, incl. every `npc-ref`/`inline`/`none`/missing-ref pin, provenance and `wiki-raw-export` |
| **I2** `domain/encounterResolve.ts:367` — `rosterStatBlockFor`'s `rulebook` arm returns `null` (the pre-142 behaviour: no box for a cited mob) | removes the cited mob's numbers | 5: `modulePdf.test` ×2, `pdfExport.test` ×1, `encounterReference.test` ×1, `roster-reference-parity.test` ×1 | 64 tests — every reference pin stays GREEN, which is the point: the two rules are independent and separately pinned |
| **I3** `lib/pdfExport.ts:132` — the single-artifact export's reference is `''` (the pre-142 line) | disconnects the shared formatter in ONE caller | 3: `pdfExport.test` ×1, `roster-reference-parity.test` ×2 (the differential and the statless-block differential) | 66 tests — incl. the MODULE book's reference and numbers, so the pin identifies the caller, not the rule |
| **I4** `lib/pdfExport.ts:479` — `roster` is `[]`, the async pre-pass disconnected | drops the resolution the definition is built from | 1: `pdfExport.test` ×1 (the end-to-end pin, which is why it drives the public entry point rather than the builder) | 68 tests |

**What these pins CANNOT prove**, stated rather than implied: (a) that the
OWNER'S EXISTING modules look right — his stored modules carry their citations
unchanged (that is the point: nothing was written), so a module generated before
this change renders the numbers only on its NEXT export, and no test can assert
what his table will see; (b) that a real PDF's TEXT matches the printed runs — the
pins read the pdfmake DEFINITION, and the layout/rendering of a wide stat box (a
page break inside it, a long `extras` entry) is unverified; (c) that the library a
real campaign ingests produces a page-accurate origin — `pageStart` is the chunk's
own field and its accuracy is the ingest's concern, not this renderer's; (d) the
READER half of the owner's answer 2 (the jump and the entity panel listing), which
is a separate slice and untested here by design.

### The duplication audit's cheap half (docs/17 row 145, docs/18 §2.2/§2.3/§4/§5, docs/14 §2)

An owner-directed audit ran every candidate copy of five duplicated ideas against
SHARED INPUTS before anything was touched. Three of the five were byte-identical
copies that nothing failed on, because no test had ever declared there was one
way to do the thing. This landing is the cheap half, and its shape follows the
audit rather than the word "centralize": ONE copy FOLDED (with its stored bytes
pinned), ONE duplicate DELETED (it had zero callers), ONE grammar given a
non-global COMPANION rather than a shared constant, ONE marker gap closed by
MOVING two constants, and ONE finding REPORTED instead of half-built.

| fact pinned | where |
|---|---|
| **The `where` label differential** — 4 cases (`premise`, `part-0`, `part-1`, `part-11`) driven through the home (`mentionView.whereLabel`), the STORED `ExpansionExcerpt.source` of `llm/campaignGrounding` and the `db/orphanSweep` refusal reason. The two same-convention copies must be IDENTICAL; the third is DECLARED (`prose === label.toLowerCase()`) as one relation, not two unrelated tables | `tests/features/mention-where-label.test.ts` (17, NEW) |
| **SCAN — `function whereLabel` is declared in exactly the two declared files** (the home and the deliberately-lowercase `db/orphanSweep` copy), no `llm/` file declares one, `llm/campaignGrounding` imports the home AND builds its `source` from it, and the sweep's carve-out still holds its copy with the LOUD guard instead of the values it used to invent | same file (3 SCAN pins, NEW) |
| **The deleted duplicate's ABSENCE** — `rosterCreatureKey` appears in no `src/` or `tests/` file (the scan's own file is the one declared exclusion), `db/creatureImages` no longer names the two identity helpers at all, and the LIVE spelling `battleSeed.creatureKeyForEntry` keeps all three arms including the `'none'` → `null` one the dead copy disagreed on | `tests/db/creature-identity-spelling.test.ts` (3, NEW) |
| **The wiki-token differential** — 8 token-bearing strings (well-formed, padded, aliased, two lookalikes that must stay LITERAL) through the export consumer (`stripWikiLinks`) and the PDF consumer (`parseInline`): identical rendered text AND identical link names | `tests/lib/wiki-token-grammar.test.ts` (25, NEW) |
| **The vanished-link case, pinned through the REAL PDF entry** — `plain **bold** [[Ash Gate]] and [[Kael]] and [[Pier]].` must render all three names, and `mdToPdfmakeContent` (what `lib/modulePdf` calls) must contain all three with no `[[` left; a second pin re-runs the loop with the GLOBAL pattern to record the measured loss (`['Ash Gate', 'Pier']`) as the reason the code is shaped this way | same file (3 pins, NEW) |
| **SCAN — the grammar is written down ONCE** — every `\[\[`-bearing non-comment line in `src/` is counted per file and must equal the two declared sites (`lib/wikilinks.ts` = 1, the ingest dnd5e DOCUMENT dialect `ingest/packs/text.ts` = 2, a different grammar), with a rot check that each declared carve-out still holds its regex; `lib/mdToPdfmake` must contain zero and must import the companion | same file (3 SCAN pins, NEW) |
| **The intent paragraph is DETECTED** — a brief carrying an intent is caught on both of the moved literals, and a note containing a QUOTE is caught too (the case the slotted-marker shape would silently miss, which is why two LITERAL markers were used) | `tests/llm/scaffoldingEcho.test.ts` (30 → 34) |
| **The rendered intent paragraph is BYTE-IDENTICAL after the constants moved** — row 141's pins are green UNCHANGED, including the test that transcribes the paragraph verbatim rather than importing it and the pins asserting a note-less brief is byte-identical | `tests/features/entity-intent-brief.test.tsx` (11, UNTOUCHED), `tests/features/entity-intent-batch.test.ts` (5, UNTOUCHED), `tests/features/persona-request.test.ts`, `tests/llm/kindOwnershipBoundary.test.ts` |
| **The stored-output byte proof for the fold** — the pins that already covered the STORED `source` stay green unchanged, and I1b shows they notice a changed label | `tests/llm/campaignGrounding.test.ts:294,311`, `tests/llm/runEngine-grounding-expansion.test.ts:249` |

| injection | line it hits | result |
|---|---|---|
| **I1 — the FOLD REVERTED** (the private byte-identical copy re-declared in `llm/campaignGrounding`, the import removed) | `src/llm/campaignGrounding.ts:15-20` (printed back; `git diff --stat` read BEFORE the run) | **RED 1 / GREEN 51** of the same 52. RED: ONLY the new source-scan pin. GREEN: all 16 behavioural differential pins AND every pre-existing stored-output pin — the measured proof that behaviour alone can NEVER see a byte-identical copy, which is why the scan exists |
| **I1b — the STORED label changed** (off-by-one in `campaignGrounding`'s `source`) | `src/llm/campaignGrounding.ts:327` | **RED 6 / GREEN 43** of 49. RED: the three new STORED-source differential pins (`part-0/1/11`; the `premise` arm is unmoved), the source-scan pin, and TWO PRE-EXISTING pins in `campaignGrounding.test.ts` (`sums shared-edge weight across the documents the entities share`, `renders part provenance with the reader numbering (planIndex + 1)`) — so the stored bytes really are held |
| **I2 — the DELETED duplicate re-added** | `src/db/creatureImages.ts` (appended, printed back) | **RED 1 / GREEN 55** of 56. RED: the absence pin, and nothing else — no fixture and no live behaviour notices, which is the deletion's own claim stated as a measurement |
| **I3 — the OBVIOUS-but-WRONG fold** (the shared GLOBAL `WIKI_LINK_PATTERN` used by the looping `pushWithWiki`) | `src/lib/mdToPdfmake.ts:3,57` | **RED 6 / GREEN 95** of 101. RED: the two new differential agreement pins for multi-token strings, both vanished-link pins, the new source pin, and a PRE-EXISTING pin (`wiki-raw-export.test`'s `the two pipelines agree: one body, the display in both, brackets in neither`, which reports the raw token `[[ Ash Gate |the gate]]` inside the rendered module definition). The new differential's own failure reads `expected 'a the gate and [[Pier]]' to be 'a the gate and Pier'`. GREEN: every single-token `mdToPdfmake` pin, all of `wikilinks.test`, `modulePdf.test` and the rest of the new file — **a single-token test can never catch this**, which is the whole point |
| **I4 — the two intent MARKERS removed** from `SCAFFOLDING_MARKERS` | `src/llm/promptScaffolding.ts:253` | **RED 4 / GREEN 71** of 75. RED: exactly the four intent pins (the two new `it.each` literals plus the intent-bearing and quoted-note pins). GREEN: every other marker pin, `escapeDebris`, `persona-request`, the kind-boundary file and row 141's 16 intent pins — so the marker set's other members do not notice, and the constants move is independent of the detection |

Every injection was restored from an OUT-OF-TREE copy in
`/tmp/campaigner-sweep-backup/` — NEVER `git checkout --`, which restores HEAD
and would have destroyed the uncommitted landing — and proved byte-identical
with `git hash-object`: `campaignGrounding.ts`
`901c47668d80b7cfe64bb1176c41bbcaf0b205b5`, `mdToPdfmake.ts`
`5c129ce89ce99dc6a38d4cf770cd3e90d409e8fe`, `promptScaffolding.ts`
`e2074a87fb5d40a7041d75743f1f70e9e5788421`, `creatureImages.ts`
`739d24b8902329ca37ef4232bdbb5c5e6c29fede` — before the injection and after the
restore.

**UNPROVEN, stated as such.** Every scan here is a GUARD over shapes someone has
used, not a proof: no test can show that a future author will not declare a
fourth `whereLabel`, a third `\[\[` regex, or a fifth identity spelling —
reverting one of them is what the injections above measure, and writing a NEW
one in a shape nobody has used slips past a textual scan. The scans read source
TEXT, which is why they are blind to a copy computed through an intermediate
variable. And **item 5 of the audit is no longer open**: it was deferred here
(docs/17 row 145) because naming the real class needed one recorded at every
`finishStep(..., 'rejected')` site plus a persisted-shape change, and it is
FIXED by docs/17 row 152 through ONE seam (`llm/rejectionReason`) — the section
three headings below owns its pins. The count this paragraph used to repeat
("EIGHT sites") was a miscount in the deferral: there are SEVEN, and `:2813` is
`runRetrieve`'s done-step write (measured at both bases, `214b86d` and
`81fb394`).

### The reader's encounter mobs, and ONE rule for structured text (docs/17 row 146, docs/11 §What a roster row PRINTS, docs/18 §2.3)

The owner's answer, verbatim: *"Keep the jump, and list the encounter's mobs below
its row in the reader's entity panel."* — and what he reads when he gets there:
*"big text blobs without any paragraph… walls of text, no formatting at all,
describing monsters."* Three commits, in this order: **(A)** a differential pin
that was one-sided-blind, **(B)** the reader half of row 144, **(C)** ONE
text→blocks renderer for the app and the PDF.

**A — tightening a pin that could not see a one-sided change.** The pin at
`lib/roster-reference-parity.test.ts` was NAMED *"a cited mob's reference is
byte-identical in the module book and the GM export"* while asserting
`toContain(' — Bestiary p.132')` **separately per book**: a decoration added to
ONE exporter satisfied both. MEASURED — appending `' [mob]'` to the reference in
`lib/pdfExport.ts` left 4 files / 55 tests green, the file under the pin among
them. The pin now EXTRACTS the roster row from each rendered document on its own
(`rosterRowRuns` → `printedReference`, the row's own text after its
`Name ×count` label, the GM export's trailing `: <notes>` element removed) and
compares the two extractions with `toBe`, keeping every containment assertion
that pins the reference's own SHAPE.

| fact pinned | where |
|---|---|
| **The two books print the SAME reference, as an EQUALITY over two independent extractions** — the cited row and the name-only row, each read out of its own rendered document and compared with `toBe`; a one-sided decoration fails | `lib/roster-reference-parity.test` (`a cited mob's reference is byte-identical in the module book and the GM export`, extended) |
| **Non-vacuity, both sides** — each book must have PRINTED the row and a reference ON it (found by name, starting with the formatter's own ` — ` separator and longer than it), so an empty or absent extraction cannot make the equality pass; the extracted strings are additionally anchored to the words the seed's chunk carries, so a formatter answering the same wrong string in both books still fails | the same pin |
| **The shape pins are KEPT**: the per-book `toContain(' — Bestiary p.132')`, the no-citation statement, the formatted line `Cave Fisher ×1 — Bestiary p.132`, and the "no dead `(see Bestiary)` constant" assertions are untouched | the same pin |
| **No behaviour changed**: the tightening is test-only — `git diff --stat` for commit A names one test file and the docs | the commit itself |

**REVERT-PROVEN** (injection made on the working tree, `git diff --stat` printed
before the run, the file restored from an OUT-OF-TREE copy and re-hashed with
`git hash-object` — `3ba9af22c38d226c1221a3bb562569f4d037bb5e` before and after):

| injection | what it does | RED | GREEN (unchanged) |
|---|---|---|---|
| **A-I1** `lib/pdfExport.ts` — the single-artifact export's reference becomes `rosterReferenceFor(monster, resolved).printed + ' [mob]'` | decorates ONE exporter's line | **BEFORE the tightening: 0** (4 files / 55 tests green — the blindness this commit exists for). **AFTER: 1** — `roster-reference-parity.test` › *a cited mob's reference is byte-identical in the module book and the GM export*, `expected ' — Bestiary p.132' to be ' — Bestiary p.132 [mob]'` | 54 tests in the same run, including every containment pin above and the whole of `pdfExport.test`/`modulePdf.test`/`encounterReference.test` — which is exactly why the containment assertions were not enough |

**What this pin still CANNOT prove**: that the two books agree on anything OTHER
than the reference — the extraction reads the row's own printed text, so a
renderer could still decorate the notes, the box or the page and pass; and the
extraction is written against the two renderers' current row SHAPE (a text array
whose runs start with the row label), so a structural rewrite of a roster row has
to update it — it would then fail LOUDLY (the row is not found → `null` → the
non-vacuity guard reds) rather than silently compare nothing.

**B — the reader half: the encounter's mobs below its row.** The owner's answer,
verbatim: *"Keep the jump, and list the encounter's mobs below its row in the
reader's entity panel."* The jump is UNTOUCHED — `ModuleReaderPage`'s `onOpenCard`
still navigates an encounter click straight to the workspace, and
`RunBattleButton` still runs/resumes the battle — and the block below the row
mounts the ONE in-app roster panel, `MonsterStatblocksPanel`, which renders
`domain/encounterResolve.rosterReferenceFor` / `rosterStatBlockFor` (docs/17 row
144's seam). The reader composes no reference and resolves nothing itself; every
roster entry is listed, `none` included, and an unresolvable citation keeps the
named `missing ref (<creature>)` line with no box.

| fact pinned | where |
|---|---|
| **The mobs appear under the encounter's row, with the reference the BOOKS print** (`— Bestiary p.132`, the formatter's own line) and the cited chunk's OWN numbers (the trait, the reaction, the AC value), for the roster's cited entry | `features/reader-encounter-roster.test.tsx` (`lists every mob with its reference and numbers, and the jump still works`) — driven through the REAL reader (app router at the module path), not the component in isolation |
| **EVERY entry is listed**, in roster order, `none` included, whose line is the formatter's no-citation statement — the panel used to DROP a name-only mob | the same pin (`data-name` order asserted) |
| **The jump is unchanged**: pressing the encounter row lands on `artifactPath(campaignId, encounterId)` with no peek modal | the same pin (the click happens AFTER the list was asserted, so the test proves both halves coexist) |
| **A citation nothing can resolve stays LOUD, by name, with NO box**: `— missing ref (Cave Fisher)` on the row and an ABSENCE assertion on the box (`queryByText('AC')`, the trait text), so an empty or invented block fails | `features/reader-encounter-roster.test.tsx` (`keeps a citation nothing can resolve LOUD, by name, with no box`) |
| **EXACTLY ONE reference in the app** (AGENTS rule 4, made mechanical): `entity-panel.tsx` mounts the shared panel and holds NO `rosterReferenceFor`/`rosterStatBlockFor`/`resolveMonsterEntr` and none of the reference vocabulary; the panel holds the two domain calls and no copy of the sentences, no `Bestiary p.` and no `${entry.origin}` template | `features/reader-encounter-roster.test.tsx` (`EXACTLY ONE roster reference implementation in the app`, 2 source pins, comments stripped) |
| **The panel's mount points stay explicit**: `kind-forms.EncounterForm`, `play/artifact-cards.EncounterCard` and the reader all pass the `npc-ref` target pool as a REQUIRED prop, so a surface cannot silently claim a cross-reference it cannot make | the same source pins + the pre-existing `features/encounter-form.test.tsx` pin, retargeted to the formatter's own line |
| **REGRESSION GUARD — the pre-existing panel pin could not pass unchanged, and the change is stated rather than hidden**: `encounter-form.test.tsx` asserted the panel's hand-built origin badge (`findByText('NPC: Vexra')`), which the formatter's own line (`— see Vexra`) replaces; the assertion was RETARGETED to the shared line (never loosened), and the row's box assertion (the linked NPC's numbers) still passes | `features/encounter-form.test.tsx` (17 tests green) |

**REVERT-PROVEN** (each injection printed with `git diff --stat` BEFORE its run,
the file restored from an OUT-OF-TREE copy and re-hashed with `git hash-object`,
every hash identical before and after: `entity-panel.tsx`
`72d240dd6aa2d03028f32f40df45bd59137c6091`, `monster-source.tsx`
`9800044fe334a677c341934247aad25e8260b03e`):

| injection | what it does | RED | GREEN (unchanged) |
|---|---|---|---|
| **B-I1** the reader's `entity-encounter-mobs` block is deleted from `entity-panel.tsx` | removes the whole feature from the reader | **3** — both behaviour pins (the mobs never appear; the row's list block is absent) and the `entity-panel.tsx` source pin | the panel-side source pin (the panel still renders the rule) and all of `module-reader.test.tsx` / `entity-panel.test.tsx` — which is exactly why the new pins are the ones that hold this behaviour |
| **B-I2** the panel's reference becomes `reference.printed + ' [mob]'` in `monster-source.tsx` | the app decorates the line the books print | **2** — both behaviour pins, `expected " — Bestiary p.132" / received " — Bestiary p.132 [mob]"`. MEASURED and instructive: the FIRST draft of these pins used `toHaveTextContent` — a SUBSTRING match — and this injection stayed GREEN (3 files / 50 tests), the same one-sided blindness commit A tightened in the books; the pins now compare `textContent` EXACTLY | both source pins (the decorator still calls the formatter) — the differential against the books lives in `roster-reference-parity.test.ts` and is pinned there |

**What these pins still CANNOT prove**: that a real browser lays the block out
under the row (jsdom asserts the DOM structure and the click behaviour, not
geometry); that a future surface mounting the panel passes a MEANINGFUL `targets`
pool (the prop is required, so the choice is explicit — but `[]` is type-correct);
and that an `npc-ref` row's numbers match the books, because the app deliberately
shows them where the books print `see <name>` (docs/11 states the one-arm
difference, and it is NOT covered by a differential pin).

**C — ONE plain-text→blocks renderer for the app and the PDF.** The owner reads
*"big text blobs without any paragraph… walls of text, no formatting at all,
describing monsters."* Two renderers collapsed the model's structure, each in its
own way: `StatBlockCard` printed a field inside a `<span>` (HTML turns every
newline into a space) and the PDF put a whole body in ONE run (pdfmake prints a
blank line as an empty line). ONE rule now decides where the blocks ARE —
`lib/textBlocks.textBlocks`, with `blockText(block)` as the run form — and each
renderer only decides how to DRAW a block:
`components/text-blocks.TextBlocks` (`whitespace-pre-line`, one element per block,
block-level after the first) and `lib/modulePdf.labeledSection` (one run per
block). Because `labeledSection` feeds `statBoxContent` — the box BOTH exporters
share — a roster mob's sections and every prose field of the module book gain the
paragraphs at once. **A single-block body is byte-identical to what it printed
before** (one node: the label run, then the body run), which is why no existing
definition or assertion moved.

| fact pinned | where |
|---|---|
| **The rule, and its two behaviours are DISTINCT**: a blank line (however many, whitespace-only lines included) separates blocks; a single newline stays INSIDE one block as a line break; `\r\n` is normalised; whitespace-only text carries no block; trailing spaces are dropped and indentation kept | `lib/text-blocks.test.tsx` (5 rule pins, NEW) |
| **The app draws the rule's own blocks**: one element per block (`text-block`), the second and later ones block-level, `whitespace-pre-line` carrying the line breaks — asserted as `toEqual(textBlocks(fixture).map(blockText))`, so the consumer can only follow the rule | `lib/text-blocks.test.tsx` (`the reader renders one element per block, the second one block-level`) |
| **The PDF draws the rule's own blocks**: one run per block in document order, the whole body NEVER in one run, the single newline INSIDE its run (`"text":"…\n…"`) | `lib/text-blocks.test.tsx` (`the PDF prints one run per block…`) |
| **Nothing is lost and the order holds**: every section's LABEL run survives (`Grasping Antennae: `, `Mandible: `, `Reactive Snap: `, `Skitter Away: `, `Perception: `) and their relative order is asserted (`extras` in the labeled column before the named sections, then traits → actions → reactions → legendary) | `lib/text-blocks.test.tsx` (`every section still prints, in the same order, after the block change`) |
| **A row generated BEFORE the change heals**: a stored npc row with a `\n\n` inside its trait text (the bytes a pre-change generator wrote — asserted byte-exact) is READ through `getArtifact` and renders as paragraphs in the app and as two runs in the PDF, and the row's JSON is IDENTICAL before and after the render — no write, no content hash, no citation, no migration | `lib/text-blocks.test.tsx` (`a row generated BEFORE the change renders with paragraphs after it`) |
| **EXACTLY ONE implementation** (AGENTS rule 4, made mechanical): `export function textBlocks` exists in exactly one file; the files that reach the rule are exactly the REGISTERED four (the rule, the presenter, `modulePdf`, `stat-block`) — a new consumer must edit the pin deliberately; neither consumer splits text on a blank line or holds a paragraph regex; the presenter holds no `.split(` at all | `lib/text-blocks.test.tsx` (`EXACTLY ONE text→blocks implementation`, 3 source pins, comments stripped) |
| **The single-artifact GM export draws the SAME blocks (docs/17 row 220)**: a multi-paragraph `appearance` and a multi-paragraph trait body print as SEPARATE nodes (the label on the first, the later blocks `margin: [110,0,0,0]`), and NO single run carries the blob; a SINGLE-block value is `toEqual` the byte-identical pre-fold `columns` node; the other label/value rows keep their one-column shape (the label literal appears exactly once) and an empty/null field still prints NO row | `lib/text-blocks.test.tsx` (`the single-artifact GM export draws the SAME blocks`, 4 pins) |
| **REGRESSION GUARD — the PDF definition pins did not move**: 15 files / 199 tests in the PDF and stat-block neighbourhood, including every `modulePdf`/`modulePdfPlan`/`pdfExport` definition dump, green with the single-block body byte-identical | that run, kept in the landing's raw output |

**REVERT-PROVEN** (each injection printed with `git diff --stat` (or `diff -u` for
the NEW seam file) BEFORE its run, every file restored from an OUT-OF-TREE copy
and re-hashed with `git hash-object`, identical before and after —
`modulePdf.ts` `505e76fc10f5d42d3fca4c479c6d0ca2d9b54ae7`, `textBlocks.ts`
`92433baa8a704dc27ae2c6591d368c954b0d483b`, `stat-block.tsx`
`f64ccff5791bde4e468928ea22ccc2ee229429f2`):

| injection | what it does | RED | GREEN (unchanged) |
|---|---|---|---|
| **C-I1** `modulePdf.labeledSection`'s body becomes one block again (`[{ lines: [body] }]`) | the PDF consumer stops using the rule — the wall of text returns | **5** — the PDF run pin, the section-order pin, the stored-row pin and BOTH source pins (the rule is no longer reached by `modulePdf`) | **44**, including every `modulePdf.test` definition pin — MEASURED proof that those pins never looked at paragraph structure (they assert single-paragraph content) |
| **C-I2** `StatBlockCard`'s named entry goes back to `{item.text}` | the app consumer stops using the rule | **2** — the reader render pin and the stored-row pin | **18**, including `stat-block-abilities.test` and the whole reader-roster file (which asserts the trait's NAME, not its paragraph structure) |
| **C-I3** the RULE itself promotes a single newline to a paragraph break (`if (line.trim() !== '') blocks.push({lines: [line.trimEnd()]})`) | the exact wrong rule this seam exists to prevent | **4** — 3 rule pins (block count, `\r\n` normalisation, trailing space) and the stored-row pin | **36**, including BOTH consumer pins — which is the design, and it is honest: the consumers' pins are AGREEMENT pins (`toEqual(rule's answer)`), so they follow the rule and cannot judge it; the rule's own behaviour is held by the rule pins alone |

**What these pins still CANNOT prove**: that pdfmake LAYS a `\n` out as a line
break in a real PDF page (jsdom asserts the definition's runs, never a rendered
page — the box is pinned as DATA, so a pdfmake behaviour change would need a real
render to notice); that a future component will not re-implement the block
splitter (the source pin is a GUARD over the four registered files, not a proof —
a consumer that splits text and never names the seam is caught only by the
`.split(`/regex checks inside those files); and that a future consumer will not re-implement the
block splitter (the source pin is a GUARD over the FIVE registered files, not a
proof). `lib/pdfExport`'s OWN `statBlockSection`/`labelValue` rows — the
single-artifact export's stat block for a pc/npc — were the last path outside
the rule and are FOLDED (docs/17 row 220): no definition dump moved, because no
existing fixture carried a multi-paragraph value, so the fold's own pins carry
the multi-block case.

**Row 220's own revert-proof, four arms, all hashes printed (`src/lib/pdfExport.ts`
`33b08bb11444d7b50f426692945385692caf658d`), one lock held across every arm, each
restored from an OUT-OF-TREE copy:**

| arm | injection | RED | GREEN |
|---|---|---|---|
| **A** | none (the landed fold) | — | **2 files / 26 tests** |
| **B** | the fold reverted to the one-run blob (`blocks.join('\n\n')`) | **1** — pin 1 (the multi-paragraph appearance) | 25 |
| **C-original** | `if (rest.length === 0)` → `if (false)` | **VOID — 0** (identical output: removing the early return changes nothing when `rest` is empty, so the probe was discarded, never read as evidence) | 26 |
| **C2** | every value answered as the multi-block shape (continuation margin changed) | **1** — pin 2 (the byte-identical single-block node) | 25 |
| **C3** | the `columns` head gains a `margin` | **1** — pin 2, by a second, mechanically different move | 25 |
| **D** | the seam bypassed by a local `splitBlob` in `pdfExport` | **2** — BOTH source pins (the registered population loses the file; the no-local-split arm catches `.split(`) | 24 |

### One document-parser seam for the ingest layer (docs/17 row 147, docs/18 §2.2/§5)

`parseDocs` was spelled SEVEN times in THREE bodies across the seven pack
adapters — five byte-identical JSON/NDJSON bodies and two YAML bodies — and the
two YAML bodies **DISAGREED**:

| input | `dnd5e-foundry.ts` (`loadAll` raw) | `dnd5e-equipment.ts` (filter nulls → throw) |
|---|---|---|
| `'# comment only'` | `[]` — **no throw** | THROW `no YAML document` |
| `'---\n'` / `'null\n'` | `[null]` — no throw | THROW |
| `'   \n'` | THROW `file is empty` | THROW `file is empty` |
| unparseable | THROW `invalid YAML: …` | THROW `not valid YAML: …` |

Through the one per-file door (`packImport.ts:198-203`, which pushes
`parsed.failures` and nothing else) the comment-only file made the foundry
adapter contribute `{entries: 0, skipped: 0, failures: []}` — the file was
accounted **NOWHERE**, no failure, no skip, no surface, while the import
reported a clean book. That is the AGENTS rule 1 shape, and **nothing pinned
it**: the divergence lived in the branch no test reached.

**The rule adopted is the JSON family's own invariant**, which its five copies
had always held: every non-empty input either yields at least one document or
throws. Made true for YAML it has two halves, and the second is the one that is
easy to get wrong — a stream that yields NO document at all is a LOUD file-level
failure (`<file>: no YAML document`), and a document that parses to `null` is
RETURNED and counted as a SKIP. So the nulls are not filtered
(`docs.filter((doc) => doc != null)` *is* the defect, not a tidy-up) and the only
new throw is `docs.length === 0`. The divergent branch was the unpinned one and
it was resolved toward the branch that FAILS LOUDLY rather than toward the one
that happened to have a test.

One message wording was chosen and exactly one existing test literal changed:
`invalid YAML` (it mirrors the sibling JSON family's `is not valid JSON:`, it
distinguishes a parse failure from the stream-level `no YAML document`, and a
pre-existing assertion already named it), so
`dnd5e-equipment.test.ts`'s `.rejects.toThrow('not valid YAML')` became
`'invalid YAML'`. That file's foundry sibling was NAMED "not valid YAML" while
its assertion said `invalid YAML`; the name now matches the sentence.

The seam lives in `src/ingest/packs/text.ts`, the module whose header row 143
wrote to host these next occupants: `parseJsonDocs(text, fileName)` (whole-file
JSON, else NDJSON one document per line) and `parseYamlDocs(text, fileName)`
(`loadAll`, one document per `---`), both `(text, fileName)` exactly as the
copies were, with the byte-identical bodies moved VERBATIM so every message,
every `{ cause }` and the NDJSON line-number convention survive. `js-yaml` is
now imported by `text.ts` and by no adapter.

| fact pinned | where |
|---|---|
| **THE RULE, directly**: a comment-only file is a loud `<file>: no YAML document`; a bare `---`, an explicit `null`, `---\n~` and `# c\n---\n# c2` each RETURN `[null]`; a real document followed by `---` keeps BOTH in order; whitespace-only → `file is empty`; unparseable → `invalid YAML:` with its `cause` preserved | `tests/ingest/packs/parse-docs.test.ts` (NEW) |
| **THE JSON INVARIANT at the seam**: whole-file JSON, NDJSON, top-level `42` / `[]` / `null`, and the failure sides (empty → `file is empty`; `{"a": 1}\nnot json` → `line 2 is not valid JSON`), plus one table asserting "**never an empty array for a non-empty input**" over 17 shape/parser pairs | same file |
| **THE ACCOUNTING, through the REAL adapters** — because "accounted nowhere" is the actual defect, not the throw: `foundry-dnd5e-srd` on `'# comment only'` REJECTS instead of resolving `{entries: 0, skipped: 0, failures: []}`; the same bytes produce the SAME sentence through BOTH dnd5e lanes; a bare `---` and an explicit `null` are exactly `skipped: 1, failures: []` with `entries`/`items`/`sections` all empty in BOTH lanes (the counters TOGETHER, so a document moved into `failures` cannot hide); and a real `longsword.yml` + `---` + a non-item document is `1 item, 2 skipped, 0 failures` | same file |
| **SCAN — no second document parser exists**: `JSON.parse`, `loadAll`, `from 'js-yaml'` and `function parseDocs` appear in `text.ts` and NOWHERE else among the directory's ten files; each helper is defined EXACTLY once; all seven call sites import their declared helper and call it EXACTLY once, with exactly one document-parsing call per adapter; the registry's seven adapter ids are cross-checked against the site table, so an EIGHTH adapter fails here rather than being missed | same file (4 SCAN pins) |
| **THE DIVERGENCE, kept as the record**: the comment-only file is driven through both real dnd5e adapters in one test whose expected value is the two IDENTICAL sentences — with the pre-fix behaviour (`NO THROW — accounted nowhere`) written down as the reason the pin exists | same file |
| **THE `Source:` LINE — a differential over FOUR sites** (docs/17 row 147, docs/18 §2.2): the exported rule, the same rule reached through the REAL `pf2e-rules` adapter, the inline rule through the REAL `formatItemText`, and the raw `extras['Source']` form, all driven over title-only / license-only / both / neither / `null` / absent — the prefixed three byte-identical on every input, the raw form REQUIRED to equal them minus the `Source: ` prefix, and the prefix proven to be the ONLY difference | `tests/ingest/packs/source-line.test.ts` (7, NEW) |
| **THE `Source:` LINE on the REAL corpus**: `pf2e-conditions/{blinded,frightened}.json`, the four `pf2e-rules/*.json` and `pf2e-equipment/{longsword,anointing-oil}.json` each carry exactly ONE `Source: ` line, as the section's/item's own last line, byte-equal to the seam's output — and the creature lane's `extras.Source` is asserted **ABSENT** on `pf2e/wolf.json`, which is the honest statement that no pf2e creature fixture carries a `publication` block | same file |
| **The row-143 SOURCE SCAN** had to move one assertion: it pinned each adapter's `./text` import as a whole-line literal, and row 147 adds a helper name to those very import statements. It now asserts the claim name-by-name (`'import { htmlToText, '` + `"} from './text';"` + the style name), so a REMOVED import still fails while an ADDED helper does not — and the parser half is owned by `parse-docs.test.ts` | `tests/ingest/packs/html-to-text.test.ts` (amended, with the reason in a comment) |
| **THE ARRAY-JSON HOLE is RECORDED, not fixed** (docs/17 row 147, docs/18 §5): a top-level array JSON is ONE document to all five JSON lanes, so it is one counted skip and the book fails with `no valid creature entries in the pack selection (1 skipped, 0 failed)` where the same creatures as NDJSON import fine. It is NOT a duplication (all five copies always agreed) and it is UNTESTED today: exactly one test feeds an array JSON at all (`pf2e-foundry.test.ts:27`) and it asserts only that no fetch happened | docs/18 §5 (measurement, no new pin) |

**How the fold was proven behaviour-free.** The seven retired bodies were
extracted verbatim from the base commit and compared against the new helpers'
bodies character for character, and the message set was enumerated after the
move: the only message that CHANGED anywhere in the seven lanes is the
equipment lane's `not valid YAML` → `invalid YAML`, which is exactly the one
test literal the landing changed. Every other existing assertion — the NDJSON
line numbering, `file is empty`, the `<file>: ` prefixing, the `document N: `
per-entry failures — is byte-identical and stayed green untouched.

| injection | line it hits | measured result |
|---|---|---|
| **A — the silent drop RE-INTRODUCED**: `return docs;` → `return docs.filter((doc) => doc != null);` in `parseYamlDocs` | `src/ingest/packs/text.ts`, immediately after the `docs.length === 0` check | **RED: 1 file / 4 tests failed, 222 passed (226)** — `returns a document that parses to null, so the adapter counts a SKIP`; `never returns an empty array for a non-empty input — the invariant, stated directly`; `a bare \`---\` document is ONE counted skip in BOTH dnd5e lanes — not a failure, not nothing`; `counts each null document of a real stream, in order, alongside the real ones`. Restored → **GREEN: 17 files / 226 passed** |
| **B — the empty-stream check DELETED**: `if (docs.length === 0) throw new Error(...)` removed, so `loadAll`'s `[]` flows back out to the adapter | `src/ingest/packs/text.ts` | **RED: 1 file / 5 tests failed, 221 passed (226)** — `fails a YAML stream that yields NO document at all, loudly and by name`; the invariant table; `foundry-dnd5e-srd records the file-level failure instead of a silent empty result`; `the same file is a loud failure through BOTH dnd5e lanes, with identical wording`; `a comment-only file is a FAILURE in both lanes today, where they used to disagree`. Restored → **GREEN: 17 files / 226 passed** |
| **C1 — the not-taken fold REVERTED, byte-identically**: the live private rule in `pf2e-rules.ts` re-declared with identical output | `src/ingest/packs/pf2e-rules.ts` | **GREEN: 17 files / 226 passed (0 red)** — the EXPECTED, HONEST result: a byte-identical revert is invisible to every behavioural pin, and this landing took no fold for a source scan to notice. It is the reason the differential exists rather than a source scan: see C2. Restored → GREEN |
| **C2 — the same copy DRIFTS**: the rules copy's separator becomes ` — ` instead of ` (…)`, so its output stops matching the seam's | `src/ingest/packs/pf2e-rules.ts` | **RED: 3 files / 7 tests failed, 219 passed (226)** — named in `source-line.test.ts` (`the three PREFIXED sites agree with each other on all six edge shapes`; `the two publicationSourceLine copies are byte-identical for EVERY input tested`; `conditions, rules and equipment carry the SAME rendered line for one publication`), in `pf2e-rules.test.ts` (3 real-fixture pins) and in `packFetch.test.ts` (1). Restored → **GREEN: 17 files / 226 passed** |

Every injection was restored from an OUT-OF-TREE copy — NEVER `git checkout --`,
which restores HEAD and would have destroyed the uncommitted refactor — and
proved byte-identical with `git hash-object` plus `md5sum -c` against that copy
after every run; the four files' hashes are identical pre-injection and
post-restore, and the `src/` diff returns to exactly the refactor. (The first
attempt at C added a SECOND declaration instead of replacing the live one: a
`SyntaxError` that failed all 11 importing files, which proves nothing about the
pins — recorded here because a green-looking module-load failure is exactly the
kind of measurement that lies. It was re-run as C1/C2 above.)

**UNPROVEN, stated as such.** A textual scan is a GUARD over shapes someone has
used, not a proof: an eighth document parser written in a shape nobody has used
slips past it, and a copy computed through an INTERMEDIATE VARIABLE (a `parse`
bound to whichever helper a branch picked, then called) is invisible to a scan
that looks for the two helper NAMES. A THIRD dialect is legitimate and expected
— a TOML lane is a new document dialect and belongs in `text.ts` beside these
two rather than in an adapter. The `Source:` differential cannot show that a
fifth spelling will not be written either; what it proves is that the FOUR that
exist cannot drift apart unnoticed on the fixtures and edges it drives — and C1
shows the limit from the other side, since a byte-identical fifth copy would be
invisible to it too. The raw `extras['Source']` form (site 4) has no real
fixture carrying a `publication` block for the creature lane, so its real-data
path rests on the transcription plus the declared prefix relation, not on a pf2e
creature fixture.

### A top-level array is a document STREAM, and the document-record rule is ONE predicate (docs/17 row 171, docs/18 §2.2/§5)

The ingest document seam (`packs/text.parseJsonDocs` / `parseYamlDocs`, row 147)
tried `JSON.parse(whole file)` FIRST, so a top-level JSON array became ONE
document — the array itself — which every adapter skipped as a shape it did not
know. The import then failed with a FALSE reason for a file whose documents were
all there, wrapped: `no valid creature entries in the pack selection (1 skipped,
0 failed)`, while the same two creatures as NDJSON imported fine.

Row 171 makes a top-level array a document STREAM, unwrapped ONE level in the
seam, for BOTH formats. YAML needed the same fix rather than a declaration:
MEASURED with the repo's own js-yaml, `loadAll('- a\n- b\n')` returns ONE
document, `[['a', 'b']]`. The boundaries are pinned as data: one level only (an
array of arrays yields the inner arrays, which the predicate rejects); a
document's own array FIELDS untouched; the NDJSON arm does not unwrap (its top
level is the line stream). An EMPTY top-level array throws `<file>: top-level
array holds no documents` — returning `[]` would account the file NOWHERE, which
the seam's own invariant forbids.

The RULE "this parsed value is a document" was seven byte-identical private
`isRecord` copies; row 171 folds them into the exported
`text.isDocumentRecord`, which all seven lanes import.

| fact pinned | where |
|---|---|
| **THE UNWRAP RULE, directly**: a top-level JSON array yields N documents; a top-level YAML sequence yields N documents; exactly ONE level (nested arrays stay documents); a document's own array FIELD survives intact; an array line of an NDJSON stream is NOT unwrapped; an empty top-level array throws by name in both formats | `tests/ingest/packs/parse-docs.test.ts` |
| **THE OUTCOME, through the REAL adapters** (the user-visible defect was never the parse, it was `entries: 0, skipped: 1`): `foundry-pf2e` on `encodeJson([baseNpc(), folderDoc()])` imports the creature and skips exactly the folder; the same two as NDJSON are identical; a single document is unchanged and its `items[]`-derived action is present; two wrapped folders are `skipped: 2`; an array of arrays is `skipped: 2`; `foundry-dnd5e-equipment` maps BOTH items of a top-level YAML sequence | same file, plus `pf2e-foundry.test.ts` (the network test now asserts the array parse outcome) |
| **SCAN — the predicate and the unwrap belong to the seam ONLY**: no file but `text.ts` contains `function isRecord`, `isRecord(` or `Array.isArray`; the predicate is defined exactly once; the seam carries three `Array.isArray` sites (non-vacuity); exactly the seven lanes import `isDocumentRecord` from `./text` and call it | same file (2 SCAN pins) |
| **The row-147 seam-import scan, amended**: it pinned `'import { htmlToText, '` as a line prefix, and row 171's added predicate pushed the JSON lanes' import past Prettier's 100-column width, so it wraps. The scan now parses the import's NAME list and requires `htmlToText` + the declared style; the claim is unchanged and the check is stronger | `tests/ingest/packs/html-to-text.test.ts` (amended, with the reason in a comment) |

**INJECTIONS — three, raw logs `/tmp/arraydocs-logs/`, restored from
out-of-tree copies with `git hash-object` identical before and after:**

| injection | line it hits | measured result |
|---|---|---|
| **A — the JSON unwrap REVERTED**: `return whole;` → `return [whole];` | `src/ingest/packs/text.ts`, `parseJsonDocs` | **RED 6 / GREEN 35 (41)** over `parse-docs.test.ts` + `pf2e-foundry.test.ts`: the JSON seam pins, the through-adapter array pin, the network test's outcome assertions and the JSON invariant. The YAML pins stayed GREEN — the per-format isolation the mirror fix needs |
| **B — `isRecord` copied back into one lane** (definition revived, call switched) | `src/ingest/packs/pf2e-journal.ts` | **RED 1 / GREEN 28 (29)**: ONLY the source scan, naming all three offenders (`function isRecord`, `isRecord(`, `Array.isArray`) |
| **C — the empty-array throws made `return []`** (both arms) | `src/ingest/packs/text.ts`, `parseJsonDocs` + `parseYamlDocs` | **RED 3 / GREEN 26 (29)**: the invariant table, the loud-throw pin, and the "sits inside the invariant" pin |

**GATE.** The landing gate (`bash scripts/gate.sh`, raw log
`/tmp/arraydocs-logs/gate.log`, chunk logs `/tmp/gate-3966685/`) printed **GATE
GREEN, exit 0: 333 files / 3955 tests** against the baseline `381aa6e` (**333
files / 3941 tests** — this slice is **+14 tests, +0 files**),
`chunk arithmetic: 333 of 333 test files covered`, lint 0 errors, typecheck
clean, no `Errors:` line, peak RSS **1227 MB of the 3000 MB cap**; chunks
`tests_lib 32/369 (858MB)`, `tests_llm 70/1152 (896MB)`, `tests_db 32/366
(676MB)`, `tests_domain 22/309 (648MB)`, `tests_features 135/1329 (1227MB)`,
`tests_remainder 42/430 (1150MB)`. The first twelve invocations exited **9** —
another writer's `tests/features` chunk held the machine — so the gate WAITED
and retried rather than reaping anything; the green run is attempt 13.
**COPIES: 7→1 — `src/ingest/packs/text.ts` (`isDocumentRecord`).**

**WHAT THESE PINS CANNOT PROVE.** The scan is textual and comment-blind: a
predicate or unwrap composed at runtime, or reached through an intermediate
helper in another module, is invisible to it (docs/18 §4). The seam pin states
the rule; it cannot prove a REAL third-party pack file is array-shaped — no
fixture corpus is, and the through-adapter pin uses the repo's own fixture
builders. And nothing proves the dnd5e YAML corpus ever ships a top-level
sequence: the mirror is a fix chosen because `loadAll` measurably yields one
array document for a sequence, not because a real dnd5e file was seen in that
shape.

**What row 148's pins still cannot prove** (kept beside the other
limitations, and stated in full in the page-model section above): the page model
is asserted as a pdfmake DEFINITION, so the LAYOUT itself — that pdfmake keeps a
`columns` row on one page, that the arithmetic fit estimator agrees with
pdfmake's real measurement, and that the printed page reads as main column +
sidebar — is verified by inspection and by the owner's own eyes on the exported
file, never by a test in this suite. The estimator is therefore tuned
deliberately wide: when it is wrong it promotes a block to a page of its own,
which is visible and harmless, rather than overflowing a column, which is not.

### Landing 2 of the HTML→text arc — the corruption repaired, every pin flipped on purpose (docs/17 row 149, docs/18 §2.2/§5)

Row 143 folded the seven strippers BYTE-PRESERVING and DECLARED the corruption
as current behaviour, with `LANDING 2:` in the pin names so that a repair
without the re-import story would go red on purpose. This is landing 2: the
brace residue (`Enfeebled{Enfeebled 1}`) and the table collapse
(`HardnessHPBT52010`) are gone from what an import STORES, the owner's recorded
decision sets the consequence (citations bound to the old bytes read the named
`missing ref (<creature>)`; the user re-imports the pack and re-picks the
creature; no rebind tool, no migration, no re-stamp), and the pins flipped
rather than being deleted.

**The seam change is a DECLARATION change** (`src/ingest/packs/text.ts`): the
brace rule `@Type[…]{Label}` → `Label` became ONE helper (`resolveBraceLabels`)
that BOTH live notations apply; the two PF2e description lanes moved to the
declared `@`-notation block-and-table style; and `AT_LABEL_LAST_LINE_BREAKS` was
DELETED (its repaired behaviour would have been byte-identical to
`AT_BRACE_LABEL_BLOCK_AND_TABLE`, and two names for one behaviour is the
divergence the module exists to end). `at-label-last` survives in the enum,
declared by no adapter, so the OLD bytes stay statable.

| fact pinned | where |
|---|---|
| **The differential table over THREE behaviours, exact bytes** — the 17 cases now run the two live styles PLUS the retired `at-label-last`, still 10 declared-divergent / 7 that must agree, and the two live styles' disagreements are the two notation dialects (`[[…]]` resolves only in `bracket-links`) | `tests/ingest/packs/html-to-text.test.ts` (the `SHARED_SAMPLE` `it.each`) |
| **The RETIRED behaviour is asserted, not described** — the old bytes are reachable in-tree, and two pins run the retired rule over the REAL fixtures' own `system.description.value` (`anointing-oil.json` → `Enfeebled{Enfeebled 1}`; `steel-shield.json` → `HardnessHPBT52010`), beside the declared style's repaired output | same file, `FAILED REVERT — the retired behaviour still produces the pre-row-149 bytes` (2 pins) |
| **The two named real fixtures, BYTE-EXACT, with flipped values** — full `text` equality, never `toContain`: those bytes ARE the content hash. `anointing-oil.json` → `…is Enfeebled 1 until the contact…`; `steel-shield.json` → `Hardness \| HP \| BT` then `5 \| 20 \| 10` on the next line (the fixture carries `<thead>`/`<tbody>`, which is what keeps the two rows apart; the sample's bare `<table>` still runs them together — the `\s*` swallow is real and pinned both ways) | same file (2 pins, flipped) |
| **The dnd5e residue is named, in ITS dialect** — `bag-of-beans.yml` stores `nonmagical item` (was `phbagPouch000000{nonmagical item}`) and `saber-toothed-tiger.yml` stores `claw` (was `7GCnVtakQo6iZyn7{claw}`); the two residues the landing did NOT fix (`@Embed[…]` in bag-of-beans, `&Reference[prone]` in the tiger) are asserted as present, so the day they are fixed these are the assertions that change | same file (2 pins, NEW) |
| **EVERY lane's emitted text, hashed, with its PRE-row-149 digest beside it** — one `sha256` per adapter over all its fixtures' `name\0text\0` stream, so an UNCHANGED lane is asserted as unchanged (only a lane that must not move can pass) and a CHANGED lane is NAMED: `foundry-pf2e`, `-journal`, `-conditions` and `-rules` identical before/after; `foundry-pf2e-equipment` (2 of 11 entries), `foundry-dnd5e-srd` (1 of 13) and `foundry-dnd5e-equipment` (1 of 7) changed by decision | same file (7 pins, NEW) |
| **The dialects cannot be merged by accident** — a pin asserts the dnd5e prelude resolves nothing under `at-brace-label` and that the shared brace rule is the ONLY overlap | same file (1 pin, NEW) |
| **The retirement is enforced at the source** — no adapter names `AT_LABEL_LAST_LINE_BREAKS` or `at-label-last`; exactly TWO `export const …: HtmlToTextStyle` declarations exist; and the retired notation must stay in `text.ts` (a future landing that deletes it must REPLACE the old-bytes proof, not lose it) | same file (3 SCAN pins, extended) |
| **The re-import instruction is where a user meets it** — the shared pack-import report renders `pack-import-rereimport-note` naming the two steps, on the component every import surface reuses | `tests/rules-page.test.tsx` (the manual `/rules` import path drives a real import and reads the report) |

**EVERY flipped assertion, by name, with before → after.** No pin was weakened
(no `toEqual` became `toContain`) and none was deleted; row 143's 28 pins all
survive, flipped in place or twinned with the retired-behaviour assertion beside
them. 41 pins now (was 28):

1. `LANDING 2: a @-notation brace label survives VERBATIM in the line-breaks-only styles`
   → `ROW 149: a @-notation brace label resolves to its LABEL in both live styles — and the retired rule still shows the old bytes`.
   `Enfeebled{Enfeebled 1}` → `Enfeebled 1` for BOTH former line-breaks-only
   styles, with `Enfeebled{Enfeebled 1}` kept as the RETIRED assertion.
2. `LANDING 2: a table collapses to concatenated cells in the line-breaks-only styles`
   → `ROW 149: an @-notation table keeps its cells, and the dnd5e dialect is NOT changed (no dnd5e fixture carries table markup)`.
   `HardnessHPBT52010` → `Hardness \| HP \| BT \| 5 \| 20 \| 10` for the
   `@`-notation style; the collapse stays asserted for `BRACKET_LINKS_LINE_BREAKS`
   as the DECISION (zero `<table>`/`<td>`/`<tr>` in all 20 dnd5e fixtures).
3. `anointing-oil.json stores the KNOWN brace residue (group A, landing 2)`
   → `anointing-oil.json stores the RESOLVED brace label (row 149 flipped the value, kept it byte-exact)`.
   Same full-string `toBe`; the sentence now reads `…is Enfeebled 1 until the contact is broken…`.
4. `steel-shield.json stores the KNOWN table collapse (group A, landing 2)`
   → `steel-shield.json stores the table as rows of cells (row 149 flipped the value, kept it byte-exact)`.
   Same full-string `toBe`; `HardnessHPBT52010` → two lines, `Hardness \| HP \| BT` and `5 \| 20 \| 10`.
5. The sample case `brace form` and `real-shaped pf2e ability` (two of the
   `it.each` rows) changed EXPECTED BYTES for the two line-breaks-only styles,
   from the residue to the label — the differential rows the two named pins above
   are built on. `pipe form`, `label bracket form`, `bare bracket form`, `label
   brace bracket form`, `reference form`, `budget table`, `block closers`,
   `blank-line runs` are UNCHANGED: the dnd5e dialect's own bytes and every
   agreement case are what they were.
6. `gm-screen.json stores the table rows whole (group B)` — UNCHANGED bytes, and
   re-asserted (the block-and-table lane must not move).
7. The SOURCE SCAN's `declares exactly three styles` → `declares exactly two
   styles, and every one of them is used by a site above`, with the retired name
   now asserted ABSENT from every adapter; its call-site table is unchanged in
   shape but every `pf2e-*` entry now names
   `AT_BRACE_LABEL_BLOCK_AND_TABLE`, and the call sites (nine, after ledger
   181's heightening capture in `pf2e-rules`) are summed as one
   number as well as per file.

**REVERT-PROVEN — three injections, each on the exact executing line, printed
back, `git diff --stat` taken BEFORE the run, restored from an OUT-OF-TREE copy
(NEVER `git checkout --`) and proved byte-identical with `git hash-object`:**

| injection | line it hits | result |
|---|---|---|
| **A — ONE LANE'S DECLARATION reverted to the old style** (the retired constant reintroduced in `text.ts`, `pf2e-equipment.ts` pointed at it) | `src/ingest/packs/pf2e-equipment.ts` (the `htmlToText(...)` call) + the constant in `text.ts` | **RED 6 / GREEN 35.** RED: `anointing-oil.json stores the RESOLVED brace label…`, `steel-shield.json stores the table as rows of cells…`, the `foundry-pf2e-equipment` lane digest, and the three source-scan pins. **`foundry-pf2e`'s digest pin and every other lane stayed GREEN** — the proof is PER-LANE, which is the whole point of deciding lane by lane |
| **B — the brace rule DELETED** (`resolveBraceLabels` → `return html;`) | `src/ingest/packs/text.ts` (inside `resolveBraceLabels`) | **RED 10 / GREEN 31.** RED: `brace form`, `real-shaped pf2e ability`, `ROW 149: a @-notation brace label…`, all three brace-carrying fixture pins (`anointing-oil`, `bag-of-beans`, `saber-toothed-tiger`), the three affected lane digests and one FAILED-REVERT pin |
| **C — block awareness DROPPED** (`if (blockAware)` → `if (false && blockAware)`) | `src/ingest/packs/text.ts` (the branch itself) | **RED 10 / GREEN 31.** RED: `flat table`, `budget table`, `block closers`, both flipped table pins, `steel-shield.json` + `gm-screen.json` fixture pins, the two affected lane digests and the `steel-shield` FAILED-REVERT pin |

Each was restored and verified with `git hash-object`
`31d1318f58f95c8bd6f7567af8dda31b7bc3fbba` (`src/ingest/packs/text.ts`) and
`f74a51ed7aee8b38821f4d71f4c4d9be202c4ba9`
(`src/ingest/packs/pf2e-equipment.ts`) identical before and after, then the same
41 pins re-run GREEN.

**What row 149's pins still cannot prove.** How many citations in a REAL library
will read `missing ref` needs his database: it is the accepted cost (row 143's
decision), not a measured number, and no number is invented here. The source
scan remains a bounded GUARD, not a proof, against a ninth stripper. And the
per-lane digests prove that a lane's bytes DID or DID NOT move — they cannot
prove the new bytes are RIGHT for a document the fixtures do not contain (a real
PF2e table without `<thead>`/`<tbody>`, for instance, still runs its rows
together on one line, which the sample pin states as the measured `\s*`
swallow).

### The three notation residues drop BY RULE (docs/17 row 170, docs/18 §2.2/§5)

Row 149 repaired the brace/table corruption and RECORDED three notation
residues in the stored text of real fixtures rather than bundling them: each
needed a rule the shared `@`-notation seam did not have. This landing adds the
three rules — in `src/ingest/packs/text.ts`, the ONE seam — and FLIPS the pins
that asserted the residues as current behaviour.

**The three rules, each written beside the rule it changes, with its before →
after.** Nothing is dropped silently: each drop is what the stated rule says
it is.

| residue (fixture) | rule added | stored before → after |
|---|---|---|
| `@Embed[Compendium.dnd5e.tables24.RollTable.dmgBagOfBeansEff rollable caption=false]` (`dnd5e-equipment/bag-of-beans.yml`) | the bracket content is read BALANCED (`bracketGroup`), and `@Embed`'s inner is `<target> <option>…`: the first whitespace-delimited token is the target, the option list is dropped **by rule** (the options configure how the embed renders and carry no prose). The split is scoped to the `@Embed` KIND | `dmgBagOfBeansEff rollable caption=false` → `dmgBagOfBeansEff` |
| `&Reference[prone]` (`dnd5e/saber-toothed-tiger.yml`) | the dnd5e prelude's `&(amp;)?reference[…]` rule gains the `i` flag — a rule fix, not a declaration change (the reference key is not case-bearing) | `&Reference[prone]` → `prone` |
| `@Damage[(ceil(@item.level/2))[persistent,acid]]` (`pf2e-rules/acid-splash.json`) | the same balanced scan keeps a `@Damage` formula VERBATIM and drops the damage-TYPE sets **by rule** (machine descriptors, not prose); a shorthand inside the formula (`@item.level`) stays as the source wrote it | `level/2))[persistent,acid]` → `(ceil(@item.level/2))` |

The `@Embed` scoping is a pinned DECISION, not an implementation detail: two
real UUID targets CONTAIN a space (`Item.Peaceful Rest` in `anointing-oil.json`,
`Item.Effect: Aid` in `aid.json`), so a whitespace split applied to every
`@`-notation would store `Peaceful` / `Effect:`. The differential row
`space inside a uuid target` is that non-regression pin; the `anointing-oil`
whole-`text` pin and the `foundry-pf2e-equipment` lane digest hold it too.

| fact pinned | where |
|---|---|
| **The rules as differential rows, exact bytes** — `embed argument list`, `nested-bracket damage formula` and `space inside a uuid target` (all three behaviours agree: these are `@`-grammar rules, not a dialect), plus `uppercase reference form` (a declared divergence: the prelude is dnd5e-only). 17 → 21 cases, 10/7 → 11/10 declared-divergent/agreeing | `tests/ingest/packs/html-to-text.test.ts` (the `SHARED_SAMPLE` `it.each`) |
| **One fixture pin per residue, through the real adapter** — `bag-of-beans.yml` asserts `…(click to expand)dmgBagOfBeansEff\n` and that `rollable caption=false` is ABSENT (the old assertion FLIPPED); `saber-toothed-tiger.yml` asserts `or be knocked prone.` and that `&Reference[prone]` is ABSENT (FLIPPED); `acid-splash.json` asserts `the target also takes (ceil(@item.level/2)) damage.` and that `level/2))[persistent,acid]` is ABSENT — this residue had NO pin before | same file (3 pins; 2 flipped, 1 NEW) |
| **Every lane's emitted text, hashed** — the three residue carriers move ONE entry each (`foundry-dnd5e-equipment`, `foundry-dnd5e-srd` and `foundry-pf2e-rules`, the only lane row 149 declared unchanged that moves here); `foundry-pf2e`, `-journal`, `-conditions` and `-equipment` are asserted byte-identical to their pre-row-149 digest, so their bytes moved in NEITHER landing | same file (the `LANES` `it.each`) |

**REVERT-PROVEN — three injections, one per rule, each on the exact executing
line, `git diff --stat` printed back BEFORE its run, restored from an
OUT-OF-TREE copy `/tmp/notation-logs/text.ts.orig` (NEVER `git checkout --`)
and proved byte-identical with `git hash-object`
`d2b9b769ab00c1b9cc6e9f840c92da67a677cd00`; raw logs in `/tmp/notation-logs/`.
Each red set is exactly its OWN residue, so the proof is PER-RULE:**

| injection | line it hits | result |
|---|---|---|
| **A — the `@Embed` rule disabled** (`if (false && kind === EMBED_KIND)`) | `src/ingest/packs/text.ts` (`resolveAtTarget`) | **RED 3 / GREEN 43**: `embed argument list`, the `bag-of-beans` fixture pin and the `foundry-dnd5e-equipment` lane digest |
| **B — the `@Damage` rule disabled** (`if (false && kind === DAMAGE_KIND)`) | same | **RED 3 / GREEN 43**: `nested-bracket damage formula`, the `acid-splash` pin and the `foundry-pf2e-rules` lane digest |
| **C — the `&reference[…]` `gi` flag reverted to `g`** | `src/ingest/packs/text.ts` (the prelude) | **RED 3 / GREEN 43**: `uppercase reference form`, the `saber-toothed-tiger` pin and the `foundry-dnd5e-srd` lane digest |

**WATCHED RED BEFORE GREEN, both directions.** The two OLD residue assertions
(`toContain('dmgBagOfBeansEff rollable caption=false')`,
`toContain('&Reference[prone]')`) were run FIRST, against the fixed code, and
both went RED (raw log `/tmp/notation-logs/flip-proof.log`) — "the pin flipped"
is a watched event, not a claim. The nested-bracket residue had no old pin to
watch; its injection (B) is the red proof.

**What this landing's pins cannot prove.** The new rules are measured against
the three REAL fixtures only; a real `@Embed`/`@Damage` document the fixtures do
not contain (a multi-instance `@Damage[a[…],b[…]]`, for instance) is decided by
the same rule but not measured. And the ONE survivor in this family is declared,
not fixed: the SYNTHETIC `&reference[x]{Ruling}` differential case
(`reference form`) still stores `x{Ruling}`, because the prelude replaces the
link with its target before the brace rule runs — no fixture carries that shape,
so it stays recorded (docs/18 §5).

**GATE — RAW NUMBERS.** `bash scripts/gate.sh` from the worktree, raw log
`/tmp/notation-logs/gate.log`, chunk logs `/tmp/gate-3919225/`:
**GATE GREEN, exit 0 — 333 files / 3935 tests**, `chunk arithmetic: 333 of 333
test files covered`, lint **0 errors**, typecheck clean, **no `Errors:` line**,
peak RSS **1263 MB of the 3000 MB cap**; chunks `tests_lib 32/369 (859MB)`,
`tests_llm 70/1146 (902MB)`, `tests_db 32/366 (694MB)`,
`tests_domain 22/309 (700MB)`, `tests_features 135/1329 (1263MB)`,
`tests_remainder 42/416 (1140MB)`. Baseline at `df104e3` was **333 files / 3930
tests**, so this slice adds **+0 files / +5 tests** (`html-to-text.test.ts`
41 → 46: four differential rows and one new fixture pin), with no existing
assertion weakened, no test skipped, and no `Errors:` line.

### The duplicate-body tripwire — ONE test answers "is this implemented twice?" (docs/17 row 172, docs/18 §3/§5)

The owner's demand, verbatim: *"Whenever something gets discovered where
fixing it would affect more than one code piece, the first examination needs
to be if this can be centralized. I do know that vibe coding has exactly this
decentralization problem and we need active measures to counter it whenever
its detected."* `AGENTS.md` §Centralization obligation 4 names this generic
detector as the measure it owed, and the real case is seven byte-identical
`isRecord` helpers — one per pack adapter — that no test could see until a task
happened to grep for them.

**The mechanism, and why it is a test rather than a script.**
`tests/architecture/no-duplicate-implementations.test.ts` reads every
`src/**/*.ts` and `*.tsx` file, extracts NAMED function/method bodies through
the TypeScript compiler API (function declarations, `const f = () => …`,
`const f = function …`, class/object methods, class-property arrows and
get/set accessors — a regex extractor breaks on nested braces and template
literals, so none is used), normalizes each body, and FAILS when one normalized
body occurs at 2+ sites — in one file or across files. Living in the suite
means it runs in every gate. The `src/` scope excludes NOTHING; the test-tree
scope — `tests/**` except `tests/fixtures/**` — is the section below
(docs/17 row 212).

**Normalization, exactly.** (1) comments are stripped — the token stream is the
PARSER's own child tree (`node.getChildren()`), in which comments are trivia and
never appear; (2) all formatting whitespace is collapsed — the body is
re-emitted as its parser token stream joined with single spaces. Whitespace
INSIDE a string/template/regex literal is data and is kept verbatim; a JSX text
run's indentation is collapsed to single spaces. A bare `scanner.scan()` loop is
deliberately NOT used: measured at base `7b390de`, it mis-tokenizes a template's
`${…}` tail and a JSX text run containing a stray quote (735 of 2651 bodies hit
an unterminated token), which silently skips comment stripping and whitespace
collapse for the rest of the body; (3) the function's OWN name and its PARAMETER
names are blanked to `$`, but only in value/reference position — property keys
(`obj.name`), object-literal keys (`{ name: value }`), shorthand keys
(`{ name }`) and declaration names are NOT blanked. So a copy that renamed the
function and its parameters is caught, while `artifact.name` and
`entry.title` remain two different functions.

**The floor = 75 normalized characters, and the brief's one flaw.** The brief's
starting point (about 120 characters / 4+ statements) CANNOT see the
seven-copy `isRecord`, whose normalized body is exactly 75 characters and one
statement — so the detector would be blind to its own motivating case, and the
seven baseline entries the brief requires could not exist. 75 is the LARGEST
floor that keeps the motivating case. The ladder, MEASURED at base `7b390de`
(2651 named bodies in 390 files): **floor 75 = 16 groups / 46 sites**, floor 70
= 19, floor 65 = 22, floor 60 = 25 (the brief's ~25 stop line), floor 40 = 29,
floor 120 = 9 groups with `isRecord` MISSING. The test's doc comment states the
floor, the ladder and this argument, so the next reader can argue with it. One
known copy sits just under the floor: the three `settledDetail` image-queue
bodies normalize to **74** characters and are therefore NOT compared — a floor
decision for the next reader, named rather than left as a silent gap.

**The captured population (16 groups / 46 sites at base `7b390de`)** — every
group is blessed BY NAME in `tests/architecture/duplicateImplementationsBaseline.json`
with a `file:function` site list and a written reason. The notable groups:

| group | sites | baseline reason (short) |
|---|---|---|
| `isRecord` | 7 — one per pack adapter | the owner-named case; folded by the peer slice row 171 (in flight when captured); the CoS deletes the line if that landed |
| `parseFile` | 7 — one per pack adapter | same family; row 171's neighbourhood owns the fold |
| `titleCase` / `publicationSourceLine` | 3 / 2 | pack adapters copy them; fold on the pack-text seam |
| `workerCount` | 3 | the image-queue trio (`mob-portrait-queue`, `cover-image-queue`, `entity-image-queue`) copies the settings→worker-count read; their `settledDetail` siblings normalize to 74 chars and sit just under the floor |
| `MissingBoard` / `MissingCanvas` / `MissingModule` | 3 | one missing-entity panel written three times |
| `Field` | 2 | local label wrapper (`kind-forms.tsx`, `stat-block.tsx`) |
| `getChunkByContentHash` | 2 | `creatureRepo` / `monsterResolve` spell the same lookup |
| `on` | 3 | the same emitter add/delete in three runner/engine classes |
| `levelDistance` / `duplicatedAcrossBooks` | 2 + 2 | `encounterItems` / `encounterRoster` copies |
| `extensionOf` | 2 | `packFetch` / `packImport` copy it |
| same-file pairs | 4 groups | `createModule`/`saveModule`, `onFetchProgress`/`onProgress`, `captureStageSnapshot`/`cloneStageSnapshot`, and `getArtifactStatBlock` defined twice in `runEngine.ts` |

| fact pinned | where |
|---|---|
| **Non-vacuity: a copy that renamed the function and its parameters is ONE implementation** — the pin can see the thing it polices | `tests/architecture/no-duplicate-implementations.test.ts` (`synthetic.ts` bodies) |
| **A near miss stays two functions** — `artifact.name` vs `entry.title` is not collapsed by the name-blanking | same |
| **The floor is real** — two identical bodies below 75 normalized characters are not compared | same |
| **The real `src/` population EQUALS the baseline exactly** — a new duplicate reds naming every `file:function:line` and the hash; a folded/renamed/moved baselined copy reds its stale entry | same (`scanRepo`) |

**REVERT-PROVEN — two injections, baseline-only, each watched RED and restored
from an out-of-tree copy (`/tmp/dup-baseline-backup2.json`; raw logs
`/tmp/dup-inject-new2.log`, `/tmp/dup-inject-stale2.log`).** Both branches of the
pin are watched, not assumed:

| injection | result |
|---|---|
| **A — the seven-site `isRecord` baseline entry deleted** | **RED 1 / GREEN 3 (4)**: `NEW DUPLICATE — shared normalized body 601a24cbc975d090 (75 chars) is implemented at 7 sites:` followed by all seven `src/ingest/packs/…:isRecord:<line>` sites |
| **B — a synthetic stale entry (`00000000deadbeef`) appended** | **RED 1 / GREEN 3 (4)**: `STALE BASELINE ENTRY — 00000000deadbeef […] no longer matches any duplicate group` |

**What the tripwire cannot see, stated plainly.** It catches identical copies,
not paraphrases: two implementations of one idea that differ by more than names
and token whitespace (reordered statements, a different local variable, `===`
for `!==`, string quote style, a different helper) are NOT caught, bodies below
the floor are not compared, and anonymous callbacks and computed/numeric-only
names are not extracted. It is a tripwire, not a proof; the §Centralization
line plus obligation 2 remain the enforcement for paraphrases.

**GATE — RAW NUMBERS.** `bash scripts/gate.sh` from the worktree, raw log
`/tmp/dupgateB-1.log`, chunk logs `/tmp/gate-4020602/`: **GATE GREEN, exit 0 —
334 files / 3945 tests**, `chunk arithmetic: 334 of 334 test files covered`,
lint **0 errors**, typecheck clean, **no `Errors:` line**, peak RSS **1230 MB of
the 3000 MB cap**; chunks `tests_lib 32/369 (832MB)`, `tests_llm 70/1152
(871MB)`, `tests_db 32/366 (674MB)`, `tests_domain 22/309 (723MB)`,
`tests_features 135/1329 (1230MB)`, `tests_remainder 43/420 (1179MB)`. Baseline
at `7b390de` was **333 files / 3941 tests**, so this slice adds **+1 file / +4
tests**, with no existing assertion weakened, no test skipped, and no `Errors:`
line. **ONE RED RUN IS RECORDED HONESTLY:** the FIRST full gate
(`/tmp/dupgate-25.log`) failed
`tests/features/creature-portrait-agreement.test.tsx` on the console-hygiene
act() guard (an `Update to BattleSurface … was not wrapped in act(...)` under
load) — a file this slice does not touch; it passed 5/5 in isolation
(`/tmp/dup-flake-check.log`) and the re-gate above was green, so it is a
load-timing flake, not this landing.

### The tripwire now covers the TEST tree — ONE detector, TWO inventories (docs/17 row 212, docs/18 §3/§5)

Row 172's file doc comment left `tests/` out of scope because "fixtures
legitimately repeat". That reason covers exactly `tests/fixtures/**` — captured
upstream documents and prompt goldens — and NOT the test files themselves,
where a copy-pasted helper or factory is the same defect one layer up. Row 212
extends the ONE detector to that tree instead of writing a second one.

**The one seam, nothing new.** `collectNamedFunctions`, `groupFunctions` and
`NORMALIZED_FLOOR = 75` are BYTE-UNCHANGED. `scanRepo` gains ONE scope
parameter: `ScanScope { roots, exclude? }`, with `SRC_SCOPE = { roots: ['src'] }`
as the default (so `scanRepo()` keeps its exported behaviour and the `src/`
pin) and `TESTS_SCOPE = { roots: ['tests'], exclude: ['tests/fixtures'] }`.
`scopedFiles(scope)` exposes the file list so the scope and its exclusion are
asserted as DATA. The exact-equality assertion is ONE exported
`populationProblems(current, baseline, baselinePath)`; BOTH inventories call
it — a second copy of that comparison is the very defect the file exists for.

**Two inventories, same schema.** `duplicateImplementationsBaseline.json` (the
`src/` population) is CONTENT-UNCHANGED;
`tests/architecture/duplicateImplementationsTestsBaseline.json` (NEW) holds the
test-tree population in the same `{ note, scope, groups: [{ hash, reason,
sites }] }` shape, every entry with a written reason. The scope line and the
fixture exclusion are in that header and are asserted by the test.

**The measured capture, and why the floor did NOT move.** At base `b712e8e`,
over 346 in-scope test files: floor 75 = **136 groups / 390 sites** — far above
the ~40 that would have kept the slice small. The ladder was printed and the
floor was held anyway: DOWN only adds noise (70 = 139, 65 = 142, 60 = 146,
40 = 158), and UP would have to reach about 400 (160 = 98, 200 = 85, 300 = 53,
400 = 33 groups) to look manageable — a floor that HIDES cheap folds: the
synchronous `walk` readdir scanner copied into EIGHT test files normalizes to
349 characters, `completedWith` to 105, `removeEventListener` to 102 and the
8-site `stripComments` to 84. Blessing those under a raised floor would be the
exact move AGENTS §Centralization obligation 4 forbids, so 75 is kept for BOTH
scopes and the inventory declares them instead. **Nothing was folded in this
slice.**

**The inventory, classified.** The dominant FOLD candidates (each naming a
seam in its reason): `renderAppAt` ×20 jsdom tests, `sourceFiles` ×12 plus its
synchronous `walk`/`srcFiles` twins ×8/×8 (source-scan helpers),
`stripComments` ×8, an identical dnd5e level-1 `statBlock` fixture ×6,
`sendChat` ×5, `briefs` ×5, the `mockChatReply` families ×4, and the
`textOf`/`deferred`/pack-dependency/canvas-seed families. The LEGITIMATE
family is per-test inline scenario data (campaign/module/persona seeds and mock
LLM reply strings) where each test deliberately owns its numbers.

| fact pinned | where |
|---|---|
| **The `src/` population still equals the UNCHANGED `src/` baseline exactly** (15 groups / 39 sites today; the 16-group capture predates row 171's `isRecord` fold) — the shared `populationProblems` call, not a re-implementation | `tests/architecture/no-duplicate-implementations.test.ts` |
| **The test-tree population equals the NEW inventory exactly** — a NEW copy in a test reds `NEW DUPLICATE` naming every `file:function:line` and the shared hash | same (the new `src/`-style pin over `TESTS_SCOPE`) |
| **The shared comparison's three arms** — `NEW DUPLICATE`, `BASELINE SITE MISMATCH`, `STALE BASELINE ENTRY` (naming the inventory line to delete) are pinned on synthetic inputs, so the test-tree inventory has the SAME stale-entry behaviour as the `src/` one | same (the shared-helper `describe`) |
| **`tests/fixtures/**` is excluded, everything else under `tests/` is not** — the scanned file list contains `tests/setup.ts`, `tests/helpers/**` and the detector, and a temp-seeded three-copy tree reports 2 sites with the exclusion and 3 WITHOUT it (the arms differ) | same (the scope pins) |
| **Non-vacuity** — a renamed pair under a `tests/`-shaped temp root is detected, and the landed inventory is non-empty (136 groups) | same |
| **The scope and the exclusion are asserted from the test-tree inventory header as data**, never left to prose in a comment | same (the header pin reading the JSON) |
| **`NORMALIZED_FLOOR` is still exactly ONE declaration, at 75** | same (a source scan of the detector file) |

**WATCHED RED — the differential arms, every changed file's blob hash printed,
the tree restored from HEAD by a `trap` (`git checkout HEAD -- <path>`; never a
bare `git checkout -- <path>`, which restores the index).** No arm is VOID: each
changed file's hash DIFFERS from arm A's on the arms that change it, and the
whole run held `/tmp/campaigner-suite.lock` (acquired by WAITING for a peer
writer's suite first — never reaped). Raw logs under `/tmp/dupe-diff/` and
`/tmp/dupe-diff-run.log`:

| arm | change | hash printed | result |
|---|---|---|---|
| **A** | none — the landed tree | detector `81970045554b13e2d91a57c2aab7f52f1de13001`, tests inventory `ea6403f17d8040975ad1d7d99e092a30fb54bc3d`, `fileSlug.test.ts` `3ab32e2ff1f065b117164312dc32c7e6f4029943` | **GREEN 13/13** |
| **B** | a real named helper (`expectSelfEvidentBlock`, 12 lines) pasted into `tests/lib/fileSlug.test.ts` | `1da011bb543845d8a1d7a5ac1266200aa6881039` (≠ A) | **RED 1 / GREEN 12**: `NEW DUPLICATE — shared normalized body a1283dce9118b20a (356 chars) is implemented at 2 sites:`, naming `tests/helpers/blocked-reason.ts:expectSelfEvidentBlock:135` and `tests/lib/fileSlug.test.ts:expectHeldBlock:199` |
| **C** | the same copy as a NEW file under `tests/fixtures/` | fixture `ffb4a699c4bcc4bbaa31bc09efcf70d59ffe952b`; target back to A's `3ab32e2…` | **GREEN 13/13** — the exclusion holds |
| **D** | a baselined tests entry deleted (`04f9773b75c70119`) | inventory `1226066675d636596b49bedba355e320c5113000` (≠ A) | **RED 1 / GREEN 12**: `NEW DUPLICATE … 04f9773b75c70119 (105 chars) …` naming both `completedWith` sites |
| **E** | a synthetic stale entry (`00000000deadbeef`) appended | inventory `79f19471865c6479a101446cdaa07c6978d8be1c` (≠ A) | **RED 1 / GREEN 12**: `STALE BASELINE ENTRY — 00000000deadbeef […]`, naming the inventory line to delete |
| **F** | restored from HEAD by the `trap` | detector `8197004…`, inventory `ea6403f…`, target `3ab32e2…` — all EQUAL arm A; `git status` clean and the fixture file gone | — |

**GATE — RAW NUMBERS.** `bash scripts/gate.sh` from the worktree, raw log
`/tmp/dupe-gate.log`, chunk logs `/tmp/gate-1947113`: **GATE GREEN, exit 0 —
339 files / 4410 tests**, `chunk arithmetic: 339 of 339 test files covered`,
lint **0 errors**, typecheck clean, no `Errors:` line, combined peak RSS
**2324 MB of the 3000 MB cap** (single-chunk peak 1240 MB, wall 465 s, voided
chunks 0); chunks `tests_lib 33/389 (910MB)`, `tests_remainder 56/515 (1165MB)`,
`tests_db 37/386 (716MB)`, `tests_llm 62/1239 (916MB)`,
`tests_domain 30/447 (659MB)`, `tests_features_a 61/652 (1240MB)`,
`tests_features_b 60/782 (1227MB)`. Baseline at `b712e8e` (row 211) was **339
files / 4401 tests**, so this slice adds **+0 files / +9 tests** (the detector
file 4 → 13; the new test-tree inventory is JSON, not a test file), with no
existing assertion weakened, no test skipped, and no `Errors:` line.

### The tripwire now sees a copy that SPANS the two trees — ONE union pin, a THIRD inventory (docs/17 row 215, docs/18 §3/§5)

Row 212 made each tree's population countable and, in doing so, made the one
class that SPANS them uncountable: a body written in `src/` and re-implemented
in a test is ONE site in each scoped scan, so neither reaches the 2-site floor
and NEITHER inventory can see it. That is the drift class that matters most — a
test asserting against its own copy of production logic keeps passing while the
production function moves. Row 215 extends the SAME detector over the union
instead of writing a second one.

**The one seam extended, nothing new.** `scanRepo`, `groupFunctions`,
`NORMALIZED_FLOOR = 75` and `populationProblems` are unchanged; the file gains
`UNION_SCOPE = { roots: ['src', 'tests'], exclude: ['tests/fixtures'] }` and ONE
filter, `crossTreeGroups(groups, scope)` — the groups holding at least one site
under EACH resolved root, classified by the scope's OWN roots so the temp-seeded
arms reuse it. The third inventory
`tests/architecture/duplicateImplementationsCrossTreeBaseline.json` uses the SAME
`{ note, scope, groups }` schema and the SAME helper.

**The measured finding, re-derived at base `82b3fc3`.** Scoped `src/` = 15
groups / 39 sites, scoped `tests/` = 136 groups / 390 sites, and the union
`scanRepo({ roots: ['src','tests'], exclude: ['tests/fixtures'] })` = **151
groups / 430 sites** with exactly **1 cross-tree group**: hash
`39d1cc194600176d`, **310 normalized characters**, at
`src/ingest/packs/pf2e-conditions.ts:publicationSourceLine:69`,
`src/ingest/packs/pf2e-rules.ts:publicationSourceLine:123` and
`tests/ingest/packs/source-line.test.ts:expected:136`.

**FOLD, not declare.** `source-line.test.ts`'s `expected` was a byte-identical
transcription of `publicationSourceLine` — an already-EXPORTED, already-IMPORTED
symbol in the same file — and its comment claims no independence, while the
header justifies transcription only for sites 3 and 4 and only because "there is
no exported symbol to import". Under the brief's own criterion that is a
convenience copy, so it was folded to `const expected = publicationSourceLine`.
The honest cost: site 1's half of the edge matrix becomes a self-comparison; the
differential's real power is sites 2 and 3 (driven through their REAL adapters)
and the literal real-fixture expectations. The landed union is **151 groups /
429 sites with 0 cross-tree groups**, and the declaration is EMPTY — a claim the
pin asserts, not a blank file. The two scoped inventories are BYTE-IDENTICAL
before and after (`git hash-object`:
`66313f19227063cd5c4e58f6d0ea3d69b1b47fab` for `src/`,
`ea6403f17d8040975ad1d7d99e092a30fb54bc3d` for the test tree) — a TEST-side fold
cannot move the `src/` pair, and that test site was never a group in the scoped
scan.

**The fixture exclusion is a GUARD, not currently load-bearing — measured, and
the brief's premise was wrong.** `tests/fixtures/**` holds ZERO `.ts`/`.tsx`
files (67 files, all data), so the union population is byte-identical with and
without the exclusion (151 groups / 429 sites / 0 cross-tree). It stays as the
declared scope; the existing temp-seeded arm proves it works the day a `.ts`
file lands there.

| fact pinned | where |
|---|---|
| **The cross-tree population EQUALS the declared inventory exactly** — a new body implemented under `src/` AND under `tests/` reds `NEW DUPLICATE` naming every `file:function:line` and the shared hash | `tests/architecture/no-duplicate-implementations.test.ts` (`crossTreeGroups(scanRepo(UNION_SCOPE))` through the shared `populationProblems`) |
| **The declared population is EMPTY, as a FACT** — `groups: []`, asserted from the JSON beside the union scope, the `tests/fixtures/**` exclusion and floor 75 in its header | same (the header-as-data pin reading the JSON) |
| **Non-vacuity** — a temp-seeded `src/`-shaped + `tests/`-shaped pair is DETECTED, and the two scoped halves on the SAME temp root see ZERO groups (the gap itself as data); the empty declaration's `NEW DUPLICATE` arm still fires and names both sites | same |
| **The union scope covers BOTH trees and excludes `tests/fixtures/**`** — the file list contains `src/lib/fileSlug.ts`, the detector and `tests/setup.ts`, and no fixture file | same (`scopedFiles(UNION_SCOPE)`) |
| **The union pin is a THIRD call of the one machinery** — one scanner, one normalizer, one floor, one comparison; no second mechanism | same (`UNION_SCOPE`/`crossTreeGroups` over the unchanged `scanRepo`/`populationProblems`) |

**WATCHED RED — every changed file's blob hash PRINTED, the lock held BEFORE
injecting, the tree restored by a `trap` (`git checkout HEAD -- <path>` for the
tracked target and an out-of-tree copy for the untracked new inventory; a bare
`git checkout -- <path>` was never used).** No arm is VOID: each changed file's
hash DIFFERS from arm A's on the arms that change it. Raw logs under
`/tmp/cross-tree-diff/`.

| arm | change | hash printed | result |
|---|---|---|---|
| **A** | none — the landed tree | detector `7542b8177d12e92a756b21abda91d9bdfe107c87`, cross-tree inventory `e446f42fa8f6ca0e56cf84757a81bb2a4cb9899e`, `fileSlug.test.ts` `3ab32e2ff1f065b117164312dc32c7e6f4029943` | **GREEN 18/18** |
| **B** | a REAL body (`src/lib/fileSlug.ts:fileSlug`) pasted into `tests/lib/fileSlug.test.ts` | `fileSlug.test.ts` `ab9750fd2a4205e35fbff9a705066e11a44e38ee` (≠ A) | **RED 1 / GREEN 17 (18)**: `NEW DUPLICATE — shared normalized body 74db1eb74d6c7135 (111 chars) is implemented at 2 sites:` naming `src/lib/fileSlug.ts:fileSlug:21` and `tests/lib/fileSlug.test.ts:copiedFileSlug:199`; the two SCOPED pins stayed GREEN — the gap itself |
| **C** | a synthetic stale entry appended to the cross-tree inventory | inventory `dbaa5d108048e294f5f97547a6cd64ffa9dfe778` (≠ A) | **RED 2 / GREEN 16 (18)**: `STALE BASELINE ENTRY — 00000000deadbeef …`, plus the empty-declaration fact (`groups: []`) — the declaration has teeth the other way too |
| **P** | `source-line.test.ts` restored to HEAD (hash `ac109dd1526c638b66afcd707de012c64929a09e`) so the REAL cross-tree entry exists again | source-line differs from A's `0eccb180e4aa2bdfa43984981324c24083c60872` | **RED 1 / GREEN 18 (19)** on the real tree: `NEW DUPLICATE — shared normalized body 39d1cc194600176d (310 chars) is implemented at 3 sites:` with all three sites named; the pre-fold union measured **151 / 430 / 1** |
| **D** | the union scan WITHOUT the `tests/fixtures/**` exclusion | no file changed (scope-only measurement) | **NO FLOOD**: identical to the excluded scan (151 groups / 429 sites / 0 cross-tree), because `tests/fixtures/**` holds zero `.ts`/`.tsx` files |
| **F** | restored by the `trap` | detector `7542b817…`, inventory `e446f42…`, `fileSlug.test.ts` `3ab32e2…` — all EQUAL arm A; `git status` shows only the intended modifications | — |

**GATE — RAW NUMBERS.** `bash scripts/gate.sh` from the worktree, raw log
`/tmp/cross-tree-regate-28.log`, chunk logs `/tmp/gate-2045817`: **GATE GREEN,
exit 0 — 340 files / 4424 tests**, `chunk arithmetic: 340 of 340 test files
covered`, lint **0 errors**, typecheck clean, no `Errors:` line, combined peak
RSS **2381 MB of the 3000 MB cap** (single-chunk peak 1227 MB, wall 461 s,
voided chunks 0); chunks `tests_lib 33/389 (902MB)`, `tests_remainder 57/522
(1185MB)`, `tests_db 37/386 (709MB)`, `tests_llm 62/1239 (904MB)`,
`tests_domain 30/447 (624MB)`, `tests_features_a 61/652 (1216MB)`,
`tests_features_b 60/789 (1227MB)`. The FIRST gate ran pre-rebase on this
slice's functional tree at base `82b3fc3` (raw log `/tmp/cross-tree-gate-1.log`,
chunk logs `/tmp/gate-2022965`: 339 files / 4415 tests, combined peak 2305 MB,
wall 463 s) and the rebased re-gate above folds in row 213's concurrent landing
(+1 file / +9 tests). Against `82b3fc3` (339 files / 4410 tests) this slice
itself adds **+0 files / +5 tests** (the detector file 13 → 18;
the cross-tree inventory is JSON, not a test file), with no existing assertion
weakened, no test skipped, and no `Errors:` line.

### The canvas chat's two copies become ONE applier and ONE turn controller (docs/17 row 150, docs/18 §2.3)

`snapshotChat.ts` carried byte-identical copies of two neighbouring modules, measured
at base `a07a5af`:

| copy | size | divergence |
|---|---|---|
| `chatApply.ts`'s `applyChatCommandsToDocument` | **166 / 192 code lines verbatim (86%)**, three blocks of 45 normalized lines byte-identical | **0 divergences** — a 3000-case differential fuzz plus 5 hand-built cases found identical document text, outcome fields and error messages |
| `chatController.ts`'s `runChatTurn` | **266 / 306 verbatim (87%)** | **DIVERGED** on the failure paths: the editor returned the LIVE document (edits included, `chatController.ts:357,378`), the preview returned the PRE-TURN document with `docChanged: false` (`snapshotChat.ts:539,559`) — contradicting its own refusal at `:448` ("the edits are still in the preview, switch to Edit and use Save to retry") |

Zero divergence is why the apply pair was pure SIZE RISK: nothing fails when a copy is
born, and nothing would fail the day one side is edited. The turn pair had already
drifted, and a user-visible sentence (`'no parts to chat about — generate the module
first'`) was spelled **three times** with only a prefix-regex pin.

**The shape landed (three commits).** `chatApply.applyChatCommands({ commands, partPlan,
handle })` is THE applier, over an injected `ChatDocumentHandle` (`read()` /
`replaceRanges(ranges, insert)` = ONE user action per call). `editorChatHandle(view)`
dispatches ONE CodeMirror transaction per command; `stringChatHandle(doc)` splices
backwards from the end. `applyChatCommandsToDocument` and `applyChatCommandsToSnapshot`
are handle + core and nothing else (the preview entry point is re-exported by
`snapshotChat.ts`). The byte-identical `failedOutcome`/`appliedOutcome` builders and the
twice-declared `MAX_CARD_SNIPPET = 280` moved in beside it. `chatTurn.runCanvasChatTurn`
is THE turn (send → stream → apply → split-save → thread persist → every loud surface);
`chatController.runChatTurn` and `snapshotChat.runSnapshotChatTurn` are wrappers passing
a handle plus a `ChatTurnSurface`. The three-spelling sentence now lives once, at
`llm/canvasChat.NO_PARTS_MESSAGE` (beside the engine guard that raises it — a cycle-free
home, since both controllers already import that module).

**The failure-path decision.** A failed (or aborted) turn returns `handle.read()` — the
document that still carries whatever was applied — with `docChanged` reporting it, on
BOTH surfaces. The refusal text is a promise about where the user's edits ARE, and the
reading the owner is TOLD (the preview's own copy) is that they are still there; the
pre-turn return discarded exactly what the copy promised. The page's consequence is its
existing one for a document holding unsaved text (a split-save whose parts partly failed
already returns `docChanged: true` and is mirrored), never a new silent discard.

| fact pinned | where |
|---|---|
| **THE DIFFERENTIAL** (the obligation pin): 310 cases — 10 hand-built (one replace, replace-all across parts, per-command re-resolution, zero matches, multi-match without `all`, empty search, empty-part label-anchor fill, scaffolding echo, a replace that fakes the scaffolding so the NEXT split throws, empty command list) + 300 fuzz cases from a FIXED seed `mulberry32(0x5eed150)` — run through BOTH entry points and compared on document text, `docChanged`, `lastApplied` and every outcome field (ids excluded: they are a counter), including the PARTIAL document a mid-batch throw leaves behind and the thrown error itself | `tests/features/canvas-chat-apply-differential.test.tsx` (NEW) |
| **THE COUNT** — `expect(HAND_BUILT).toHaveLength(10)`, `expect(FUZZ).toHaveLength(300)`, `expect(CASES).toHaveLength(310)` — so a generator that silently empties out cannot turn the differential into a no-op, plus a non-vacuity pin: the table really applies (>50), really fails (>20), really throws (>0) and really leaves PARTIAL edits on a throw (>0) | same file |
| **The two PUBLIC entry points are held to their handles** (`applyChatCommandsToDocument` ≡ `editorChatHandle` + core; `applyChatCommandsToSnapshot` ≡ `stringChatHandle` + core) over the whole table | same file |
| **THE SOURCE SCAN (applier)**: the declarations (`applyChatCommands`, both entry points, both outcome builders, `MAX_CARD_SNIPPET`, `ChatDocumentHandle`) exist in exactly ONE canvas file, `snapshotChat.ts` declares none of them, and `resolveCanvasEditAcrossParts` has exactly ONE caller outside `llm/canvasChat.ts` | same file |
| **THE SOURCE SCAN (turn)**: `runCanvasChatTurn`, `historyFor`, `ensureFollowUpMessage`, `followUpRafRef`, the details-round-trip sentence and the module-gone sentence exist in exactly ONE canvas file; the two wrapper modules carry none of the flow and both call the controller | `tests/features/canvas-chat-turn-parity.test.ts` (NEW) |
| **AUTHORSHIP ON BOTH CALLERS**: after a chat turn that applied edits in two parts, each part row reads `origin: 'model'` AND `writerModel` = the `modelUsed` that served the reply; non-vacuity asserted first (the seed's parts read `origin: null`, `writerModel: ''`), so the pin proves the turn wrote the signature | same file |
| **VERSIONING ON BOTH CALLERS, BY COUNT**: `countModuleVersions(moduleId)` is 0 before and **exactly 1** after a turn whose one batch changed two parts — a "some snapshot exists" assertion would pass on the twice-snapshot defect; plus a turn with NO commands takes ZERO snapshots | same file |
| **THE FAILURE PATH, BOTH SURFACES**: with the module row deleted inside the model call, the returned doc CONTAINS the applied edit, `docChanged` is true, `lastApplied` is null, and the card's error is that surface's own sentence ("…still in the editor, use Save to retry" / "…still in the preview, switch to Edit and use Save to retry") — the pre-fix preview returned the pre-turn doc with `docChanged: false`; a transport failure with NOTHING applied still returns the untouched document | same file |
| **THE SENTENCE, FULL AND ANCHORED**: `rejects.toThrow(/^no parts to chat about — generate the module first$/)` (was the PREFIX regex `/no parts to chat about/`, which could not notice a reworded tail) | `tests/llm/canvasChat.test.ts` |
| **THE SENTENCE, DECLARED ONCE**: a source walk over `src/**/*.ts(x)` (non-vacuity: >200 files) finds the literal in exactly ONE file, `src/llm/canvasChat.ts`, and asserts both former copies read `NO_PARTS_MESSAGE` instead | same file |

**REVERT-PROVEN (each injection printed back, `git diff --stat` before the run, the file
restored from an OUT-OF-TREE copy and `git hash-object` identical after).**

| injection | file | result |
|---|---|---|
| **A — the DELETED preview copy re-introduced verbatim** as `src/features/modules/canvas/secondApplier.ts` (its outcome builders, `MAX_CARD_SNIPPET` and `applyChatCommandsToSnapshot` restored from commit `3e8481b`) | new file | **RED 2 / GREEN 4** — the two SOURCE-SCAN pins (declarations exactly once; one ladder caller) fail naming `secondApplier.ts`. The DIFFERENTIAL stays GREEN, and that is the honest expected result: a byte-identical copy nobody calls is invisible to behaviour, which is exactly why the source pin exists |
| **B — two transactions per command** (`for (const range of ranges) view.dispatch(…)` instead of one `dispatch({ changes })` in `editorChatHandle`) | `src/features/modules/canvas/chatApply.ts` | **RED 2 / GREEN 19** — `canvas-chat.test.tsx`'s "an applied replace-all rides ONE transaction (one undo step)" (`undo(view)` leaves `Mist here.`) plus the multi-part `all="true"` pin (sequential offsets corrupt the second range) |
| **C — `writerModel` dropped** from the turn's split-save call | `src/features/modules/canvas/chatTurn.ts` | **RED 2 / GREEN 8** — BOTH authorship pins, with `part 0 origin: expected 'human' to be 'model'`: the machine-write signature's absence stamps model text as the reader's, silently |
| **D — the durable snapshot taken TWICE** in `saveWholeModuleDocument` | `src/features/modules/canvas/saveDoc.ts` | **RED 2 / GREEN 8** — both count pins with `expected 2 to be 1` (the editor surface AND the preview surface) |

**REGRESSION GUARD.** No pre-existing assertion was WEAKENED, and none was deleted
without a replacement. TWO were changed deliberately, both named with before/after:

1. **Tightened** — `tests/llm/canvasChat.test.ts`, the no-planned-parts pin:
   before `.rejects.toThrow(/no parts to chat about/)` (a PREFIX, so a reworded tail
   could not fail it), after
   `.rejects.toThrow(/^no parts to chat about — generate the module first$/)` (full,
   anchored).
2. **Moved with the boundary** — `tests/llm/scaffoldingEcho.test.ts`'s source scan
   ("the boundaries that persist reader-visible text all call the aggregate") listed
   `src/features/modules/canvas/snapshotChat.ts` as "the same, snapshot route". That
   file no longer IS a boundary — it is a wrapper with no apply logic, so the entry
   became a dead requirement (the full-suite gate caught it: RED 1, `scaffoldingEcho`
   `expected 'import type { Id } …' to contain 'generatedTextIssuesForFields('` — the
   needle it quotes is today spelled `generatedTextScanForFields(`, docs/17 row 152;
   the failure text is left verbatim as the record of that run). The
   entry is REMOVED and replaced, in the same test, by a ROUTING pin: each chat
   surface must hand ITS document to the one applier (`chatController.ts` →
   `editorChatHandle(`, `snapshotChat.ts` → `stringChatHandle(`) **and must not call
   the aggregate itself**. The guarantee is unchanged — every route still reaches the
   aggregate through `chatApply.ts` — and it is now asserted in the direction the fold
   created, instead of against a file that no longer holds the code.

The eight affected suites (both turn controllers, the applier units, the preview
units, the llm chat suite, `entity-classify-new`) run **146 tests green**, before and
after the fold; `canvas-preview-default.test.tsx`'s 8 snapshot units (including the
split-parity pin) and `canvas-chat.test.tsx`'s 5 raw-view units are untouched.

**WHAT THE PINS CANNOT PROVE.** The fuzz has a FIXED seed and a bounded (300) case
count, so it covers the shapes its generator can spell and cannot cover an unimagined
input shape. A byte-identical second copy is invisible to EVERY behavioural pin here
(injection A demonstrates it) — the source scan is a GUARD over the shapes and names
that exist today, not a proof of uniqueness, and a copy assembled at runtime or written
in another language slips past it. Nothing proves a future author will not re-copy the
controller into a third file. The differential proves the two HANDLES cannot drift on
the inputs it drives; it says nothing about whether a third applier would agree.

### A rejected step says WHY it was refused (docs/17 row 152, docs/18 §2.2)

The engine's auto-autonomy failure sentence said *"the model reply could not be
parsed into the required JSON shape after one automatic retry"* for EVERY
rejection class it saw — the scaffolding echo of row 142 (nothing to do with
JSON), an unresolvable monster stat source, a stat block that printed signed
ability modifiers, a brief that ignored the room-shape contract, text carrying
half-formed unicode escapes. A rejected step carried only `{ raw, issues }`, so
there was no class to name; this landing records ONE where each refusal is
DECIDED (`llm/rejectionReason`), composes the sentence from it in ONE place, and
keeps the sentence that was already truthful byte-identical.

| fact pinned | where |
|---|---|
| **One sentence per class**, each transcribed independently of the composer and each asserting that NO OTHER class's clause appears in it: `invalid-json` (the pre-152 literal, BYTE FOR BYTE, with and without issues), `unresolved-source`, `ability-convention`, `brief-contract`, `escape-debris`, `scaffolding-echo` | `tests/llm/rejectionReason.test.ts` (6 pins, NEW) |
| **The exhaustive record** — `Object.keys(REJECTION_CLAUSES)` equals the union, no two classes share a clause, and every class's sentence carries its own clause and no other's. The clause table is a `Record<RejectionReason, string>`, so a class added to the union without a sentence is a COMPILE error; the pin re-states it at run time | same file (2 pins, NEW) |
| **A refused output cannot be built without a class** — `rejectedStepOutput(raw, issues, [])` throws; a value outside the union is read as absent, never invented | same file (2 pins, NEW) |
| **SCAN — the class is recorded at the site that refuses**: the engine's `'rejected',` statuses (7, with the `PromiseRejectedResult` guard subtracted) EQUAL its `rejectedStepOutput(` calls (7), no site hand-rolls `{ raw, issues }`, and each of the five classes is attached by name at its own line | same file (2 SCAN pins, NEW) |
| **SCAN — the sentence is composed in ONE place**: the historic clause `could not be parsed into the required` appears in `llm/rejectionReason.ts` and in no other file under `src/`, and the engine calls `rejectedStepSentence(name, outcome.step)` instead of writing it | same file (1 SCAN pin, NEW) |
| **A LEGACY row (no class) tells the truth** — with issues it reads *"this run row records no rejection class (it predates the engine recording them) — the issues it stored are the reason"*, with none *"…and no issues either"*, and neither contains `JSON`; a stored value outside the union reads the same way | same file (3 pins, NEW) |
| **The seven deciding sites, END TO END** — each refuses through the REAL pipeline (mocked chat, fake-indexeddb) and the run's own `errorMessage` is asserted against the class's clause (never against the composer's answer): draft JSON + stat-block JSON (`invalid-json`), signed abilities (`ability-convention`), escape debris (`escape-debris`), scaffolding echo (`scaffolding-echo`), encounter source (`unresolved-source`), encounter room shape (`brief-contract`) — plus the encounter brief that never parses staying `invalid-json`, because the split is decided per BRANCH | same file (8 pins, NEW) |
| **The scan's classes, beside its issues** — `generatedTextScanForFields` returns `{ issues, reasons }` with the debris half contributing `escape-debris`, the echo half `scaffolding-echo`, and BOTH present when both fire (the reason the stored field is a list) | `tests/llm/scaffoldingEcho.test.ts` (needle updated; its own class pins live in the new file, driven end to end) |

| injection | line it hits | result |
|---|---|---|
| **(a) the class DROPPED from ONE deciding site** — the finalize hygiene site reverted to a hand-built `{ raw: JSON.stringify(draft), issues: hygiene.issues }` (`git diff --stat` read BEFORE the run: `src/llm/runEngine.ts \| 2 +-`) | `src/llm/runEngine.ts:5666` (printed back) | **RED 4 / GREEN 20** of the 24. RED: `escape debris … → escape-debris` (printing `expected [] to deeply equal [ 'escape-debris' ]`) and `our own prompt scaffolding echoed into the finalized draft → scaffolding-echo`, plus the two source-scan pins (the 7-vs-6 count). GREEN: every OTHER class's pin, so the proof is PER-SITE |
| **(b) the composer defaults EVERY class to the JSON sentence** — `reasons.map((reason) => REJECTION_CLAUSES[reason]).join(' and ')` → `REJECTION_CLAUSES['invalid-json']` (`git diff --stat` read BEFORE the run: `src/llm/rejectionReason.ts \| 2 +-`) | `src/llm/rejectionReason.ts:168` (printed back) | **RED 11 / GREEN 13** of the 24. RED: all five non-JSON sentence pins, the exhaustive-record pin and all five non-JSON engine pins. GREEN: the `invalid-json` pins stay GREEN — the byte-identical unit pin and the draft engine pin — and so do all four legacy pins. **That asymmetry IS the landing**: the truthful class is untouched, the lying ones red |

Both injections were restored from an OUT-OF-TREE copy
(`/tmp/campaigner-reject-backup/`, never `git checkout --`) and proved
byte-identical with `git hash-object`: `runEngine.ts`
`41d7003ef28508f128462ab78fce2b45948f92a0` and `rejectionReason.ts`
`75afce31e7f950f6ca89ce8db0f606dc3c28b95a` — before the injection and after the
restore. The restored tree re-ran the same file plus
`tests/llm/scaffoldingEcho.test.ts` and `tests/llm/runNotCompletedReason.test.ts`
GREEN (65 tests).

**UNPROVEN, stated as such.** No test can show that a FUTURE rejection site will
pass a class at all: `rejectedStepOutput` makes one a required argument and the
count scan reds a site that bypasses the constructor, but a site passing the
WRONG class compiles and passes — the wiring proof is the eight engine pins, not
a type. Both scan pins read source TEXT, so a class computed through an
intermediate variable is invisible to them. And nothing here measures whether the
owner finds the new sentences BETTER: it measures that they are true.

### The page-hide flush tests settle the row update they cause (docs/17 row 153, docs/18 §4)

`tests/features/board-page-flush.test.tsx` was the ONE file the console-hygiene
guard tripped, and only under concurrent load: RED twice in multi-writer and
foreign-suite runs, **9/9 green** when run alone, never red under a single-worker
gate. A page-hide flush issues a real `patchModule` write; the row it writes
reaches React through the module's liveQuery (`useModule`), and RTL's `waitFor`
runs with the act environment DISABLED and drains exactly ONE macrotask before
restoring it. The two flush tests then ended in a BARE `await persistedPart0(...)`,
which restored the act window while that delivery was still in flight — the class
docs/18 §4 already states (*"a DB write into a tree whose live queries are mounted
(`useModule` etc.) is drained, not awaited bare"*). This landing is that rule
APPLIED, not a new convention.

| fact pinned | where |
|---|---|
| **The settle is the ROW CARRYING THE DRAG'S DESTINATION**, asserted INSIDE the wait (`x > 500`, `y > 500`) — where the old shape read the canvas once AFTER the wait and asserted only `not.toBeNull()`. The wait's timeout is unchanged, so the condition got stronger rather than the window wider | `tests/features/board-page-flush.test.tsx` (`lands on pagehide, inside the debounce window`, `lands on visibilitychange → hidden`) |
| **The update the flush causes is drained inside act** before the test ends, through the ONE seam (`tests/helpers/flush.ts` `flushAsyncUpdates` — this file's existing import; no new helper, no second mechanism) | same two tests |
| **The write is still INSIDE the debounce window** — the timing pin is unchanged and still asserted (`Date.now() - started` below `BOARD_PERSIST_DEBOUNCE_MS`), and so is the one-write-per-signal count | `lands on pagehide …` |
| **Nothing about the guard moved**: `tests/setup.ts` is byte-identical, `ALLOWED_NOISE` gains no entry, and the suite still holds ZERO act-timing allowances | `tests/setup.ts` (unchanged) |

| injection | line it hits | result |
|---|---|---|
| **(a) the read the cause names DELAYED 20ms** — `getModule` gains a `setTimeout` before its `db.modules.get` (`git diff --stat` read BEFORE the run: `src/db/moduleRepo.ts \| 5 +++++`) | `src/db/moduleRepo.ts:38` (printed back) | un-cured **RED 2 failed / 7 passed** (exit 1): the two flush tests, each with three act-warning entries naming `BoardPage` and `@xyflow`'s `MarkerDefinitions` — the same subjects the recorded foreign run carries |
| **(b) the same injection at 60ms** | same line | un-cured **RED 2/7**, cured **GREEN 9/9**: the pair repeats at a second delay level, so the reproduction is not tuned to one number |
| **(c) the injection REMOVED, cure in place** | — | **GREEN 9/9 three sequential runs**; the file counts 9 tests before and after (nothing deleted, renamed, skipped or relaxed) |

Both injections were restored from an OUT-OF-TREE copy (`/tmp/flake-inj/w153/`,
never `git checkout --`) and proved byte-identical by `sha1`:
`moduleRepo.ts` `38f28675ce1a80971e1cb82ff1cd19c4b6d6cbcc`,
`BoardPage.tsx` `3d0c40f56ead5e2e9bb467bb234741d514ada14b` and
`tests/setup.ts` `3be889fdea60582ad669bcf5300a5de9848a0b09` — before the
injection and after the restore.

**SETTLED, NOT DISCARDED — measured, not assumed.** With the 20ms delay the
row's delivery to React lands at `5609.9`, INSIDE the drain's `5585.0 → 5610.5`
window, so the update is delivered while the board is mounted; that is the
difference between settling it and stopping the test earlier. The un-cured twin
of the same run puts that delivery **5.8ms AFTER** the test's last wait
(dispatch `5875.2` → `waitFor` returned `5898.1` → first warning `5903.9`),
i.e. inside the bare read. The fold ALONE — the asserted settle without the
drain — also passes with the cause delayed (measured), so the drain is the
explicit settle rather than the lever that makes the test pass.

**UNPROVEN, stated as such.** No test here can show that another load pattern
will not surface a DIFFERENT leak in this file: the guard remains the detector
and this landing removes only the window the recorded failure actually used. The
drain is BOUNDED (20 rounds — the seam's default), not a proof that no delivery
can outrun it; what makes the tail structural rather than hopeful is RTL's own
`cleanup()`, which wraps `root.unmount()` in `act`
(`@testing-library/react@16.3.3` `pure.js`), so a delivery that outruns the
drain is absorbed by the unmount instead of being silenced by an allowance — an
allowance would be the forbidden move. And a green run on an idle box is not
evidence for this class: the delay-injection pair is.

### A baseline captured from a DATE-STAMPED document is a midnight time bomb (docs/17 row 154, docs/18 §4)

The content-preservation differential in `tests/lib/pdfLayout.test.ts` compares
the document's runs against `tests/lib/pdfLayoutBaseline.json` — and the cover of
that document prints the day it was compiled (`lib/modulePdf.ts`: `Compiled with
Campaigner · ${compiledDay}`, from `compiledAt ?? new Date()`). The baseline was
captured from the ambient clock, so it carries the capture day and the
differential is green on that day and RED at the next midnight — measured on an
IDENTICAL commit: a gate at 23:43 green, the same commit's gate at 00:0x red with
exactly two failures (`Compiled with Campaigner · 2026-09-13` missing from the
after side, `… · 2026-09-14` added to it). No flake, no load: a clock. The class
in one line: **a test that captures a document which stamps the time, without
pinning the time it stamps, tests the calendar.**

| fact pinned | where |
|---|---|
| **The compared documents are built under a PINNED clock** — the renderer's own documented input `compiledAt` (the same seam the byte-determinism pins use), fixed at the day the baseline was captured, so the differential is about the document and not about the day it ran | `tests/lib/pdfLayout.test.ts` (`BASELINE_COMPILED_AT`, passed by `documents()` to all three builds) |
| **The comparison is UNCHANGED in strictness**: the loss side is still `missingRuns(...).toEqual([])`, the additions side still an exact `toEqual`, and the footer run stays in the baseline BY TEXT (a renderer that stopped stamping the date still fails) — no run deleted, no assertion dropped, no tolerance widened | the two differential tests, byte-identical apart from the document that is built |
| **The product still stamps the REAL day**: with no `compiledAt`, the renderer prints the clock's date, pinned with the clock moved to a day that is not today (`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`, scoped to the build and restored in a `finally`, so no async work of that test runs under it) | `tests/lib/modulePdf.test.ts` (`prints cover, ToC, premise, … (GM)`, the cover assertion) |

| direction (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`) | clock | result |
|---|---|---|
| current head, no cure | system date `2026-09-14` (baseline's day is `2026-09-13`) | **RED 2 failed / 23 passed (25)**, exit 1: `expected [ Array(1) ] to deeply equal []` → `"Compiled with Campaigner · 2026-09-13"`, and the added-runs equality gaining `"Compiled with Campaigner · 2026-09-14"` |
| current head, no cure | system time faked to `2031-02-03` | **RED 2/23**: the same two tests, now carrying `2031-02-03` — the ambient clock IS the cause, shown independently of today's date |
| cure in place | system time faked to `2031-02-03` | **GREEN 25/25**, exit 0 — the differential no longer reads the ambient clock |
| cure removed again, clock still faked | `2031-02-03` | **RED 2/23** again, the same two failures: the clock read is what the cure removes |

The baseline was **NOT regenerated and is byte-identical**: it is a capture of the
PRE-layout renderer at the layout's base commit, which cannot be re-derived from
the current tree, and the date pinned in the test is exactly the date the capture
already carries (`2026-09-13`), so the captured runs match with no edit. Pinning
a *different* date would have required regenerating a baseline that no longer
exists in this tree — the record that survives is the test's own constant, and it
names the day.

**UNPROVEN, stated as such.** That no OTHER comparison in this repo is
date-dependent: this landing cures the one that was measured red, and nothing here
scans for the class (the sweep would be a separate slice). That the faked-clock
pin in `modulePdf.test.ts` would catch a renderer that stamped a WRONG-but-stable
date — it catches a constant, a missing date and a clock that stopped being read,
not a date computed from the wrong field.

### A strand names its PACK and its creatures, and every citation records the book it came from (docs/17 row 155, docs/12 §8, docs/11 §Content identity at citation birth, docs/18 §2)

The owner imported a campaign on another computer and the banner told him only
HOW MUCH was missing (*"4 encounter entries across 2 encounters cite stat blocks
missing from this library"*) plus a link to a generic Rules page: *"the user has
no idea which of the many packs he needs to install."* The trace found the data
was already there twice over — the creature name rides the `missing ref
(<creature>)` label, and the pack title is read by `creatureOriginLabel` where
citations are BORN — so this slice surfaces what existed and stamps the one
field that was discarded. Two seams, both extended, neither replaced:

- `domain/encounterResolve.missingRefReason(citationName, bookTitle)` builds the
  LABEL and the structured `MissingRef {creature, bookTitle}` TOGETHER, and
  `ResolvedMonster.missingRef` carries it, so a surface reads a field instead of
  parsing `missing ref (Zombie)`;
- `domain/encounterResolve.contentIdentityFor(hash, heading, entryName,
  bookTitle?)` is THE citation-birth constructor and now stamps the book too,
  OMITTED when unknown. All FOUR writers pass it: `runEngine.rulebookSourceFor`,
  the editor's rulebook-link dialog, `spawn-picker-logic.buildMobPickEntry`, and
  `entity-batch.libraryCitationForEntity`, which had been a hand-written copy of
  the citation shape and therefore missed the stamp.

| fact pinned | where |
|---|---|
| **The banner names the creatures it is missing, deduped and in a deterministic order** — the badge's own name, read from `missingRef.creature`, never parsed out of the label | `tests/features/missing-refs-banner.test.tsx` (`names the creature AND the pack a citation recorded`, `deduplicates and orders the names deterministically`) |
| **A pack is named when the citation recorded one and NEVER invented when it did not** — the fallback sentence is asserted verbatim AND the absence of `«` in that shape | the same file (`names the creatures and INVENTS NO PACK when the citation recorded none`); `tests/features/missing-refs-banner.test.tsx`'s `missingRefsSummary` block (`says the pack was not recorded when NO strand knows one`) |
| **The creature list is BOUNDED and the remainder is EXACT** — both sides of the cap (`MISSING_REF_NAME_CAP` names with no remainder, one more WITH `(+1 more)`), plus a 6-strand banner asserting `Missing: Alpha, Bravo, Charlie, Delta (+2 more).` and that the unlisted name is absent | the same file (`bounds the name list and states the remainder exactly`, `lists exactly MISSING_REF_NAME_CAP names with no remainder, and one more WITH it`) |
| **A stranded entry is never silently dropped, named or not** — a roster entry whose name is empty is still COUNTED and stated (`1 of them names no creature.`) | the same file (`never drops a strand it cannot name — the count includes it and says so`) |
| **The pack a strand shows is the SAME identity `creatureOriginLabel` prints** — the differential: one book row, its label as a badge, its stamp on a stranded citation, both compared through the same title | the same file (`names the SAME pack identity the origin label prints for that book`), with `citationBookTitle`/`rulebookDisplayTitle` pinned against each other in `tests/db/encounterResolve.test.ts` |
| **A citation written through EACH birth site carries its chunk's book title** — one behavioural pin per site, the editor's driven through the real search dialog over a real ready book | `tests/llm/runEngine.test.ts` (`stamps the cited chunk hash, creature name AND the pack it came from…`), `tests/features/monster-source-citation.test.tsx` (NEW), `tests/features/spawn-picker.test.tsx` (`buildMobPickEntry stamps content identity at citation birth`), `tests/features/entity-batch-cast-description.test.ts` (`expectCitation`) |
| **A birth site with NO book stamps nothing rather than a placeholder** — a vanished chunk stays uuid-only with no `bookTitle`; a deleted book row omits the field entirely | `tests/llm/runEngine.test.ts` (`omits the pack when the cited book row is gone`), `tests/features/spawn-picker.test.tsx` (the vanished-chunk pin), `tests/db/encounterResolve.test.ts` (`OMITS the book title when none is known`) |
| **The import heals the book from the manifest, and the healed strand NAMES its pack while still unresolvable** — the banner's own contract read through the resolver on an imported encounter | `tests/lib/exportImport.test.ts` (`old-export import stamps manifest hashes…`, `names the pack of a strand it CANNOT resolve`) |
| **The label and the structured reason are ONE fact** — `origin` and `missingRef` asserted together, on the resolver itself and on a citation that stamped no book | `tests/db/encounterResolve.test.ts` (`reports WHAT is missing structurally…`, `reports NO pack for a citation written before the stamp`) |

| injection (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`, each printed back and restored byte-identical from an OUT-OF-TREE copy by `git hash-object`) | result |
|---|---|
| (a) drop the creature names from the sentence (`creatureSentence = ''` in `missing-refs-summary.ts`) | **RED 7 failed / 10 passed (17)**, exit 1 — the names pins, the cap pins, the dedup pin, the non-vacuity pin and both pack-shape pins that assert the name list |
| (b) invent a pack when none is recorded (`The missing pack is «Bestiary».` in place of the fallback) | **RED 2 failed / 15 passed (17)**, exit 1 — `names the creatures and INVENTS NO PACK…` on the exact received sentence (`… Missing: Zombie. The missing pack is «Bestiary». …`) and the pure `says the pack was not recorded…` pin |
| (c) drop the stamp from ONE call site (`buildMobPickEntry` passes no `bookTitle`) | **RED 1 failed / 49 passed (50) across 4 files**: `spawn-picker.test`'s pin fails (`expected undefined to be 'Core Bestiary'`), while `runEngine.test`, `monster-source-citation.test` and `entity-batch-cast-description.test` stay **GREEN** — the other three birth sites are covered independently |

**UNPROVEN, stated as such.** That a pack FILE's published title matches the
title of the library row it produced: nothing here compares the stamp against
the pack source — only the library's own book rows are comparable, and the drift
pin asserts exactly that much (`citationBookTitle(book) ===
rulebookDisplayTitle(book)`). Whether the Rules page could serve a per-pack
deep link: measured as ABSENT (`RulesPage` reads no query parameters and offers
no per-pack filter seam), which is why the link stays `/rules` — the landing
states that rather than building a filtered view. And how many stored citations
predate the stamp is unmeasurable here: it needs the real database, so an
already-imported campaign may read the honest `The pack was not recorded when
this citation was written.` (the owner accepted that, docs/17 row 155).

### A markdown table is a real table, and no pipe line is deleted (docs/17 row 157)

The module book's markdown renderer deleted tables instead of rendering them —
and not by choosing to skip them: `mdToPdfmake.sanitizeLine` turned ANY line that
opened and closed with a pipe into the EMPTY STRING, and the parser read an empty
line as a paragraph break. Measured: a table row inside a list item printed an
**empty bullet**, `## | a | b |` printed an **empty heading**, and the defect
report's own reproduction (two prose lines with a three-line table between them)
printed the prose and nothing between it — no problem, no placeholder, no toast.
That is a `docs/07` "documented limit" REVERSED rather than a bug fixed, so the
records change deliberately: the pin that asserted the deletion now asserts the
row PRINTS (same input, opposite claim, and it additionally asserts the cell text
is present so a dropping parser cannot pass), and docs/07 keeps the old sentence
with the reversal recorded under it.

The whole change is ONE seam extended — `lib/mdToPdfmake`'s `MdBlock` union gains
a `table` kind (rows → cells → inline runs) and `mdToPdfmakeContent` renders a
real pdfmake table. No second parser, no second renderer, and `lib/textBlocks`
and `lib/markdown.markdownToText` are untouched (text-only surfaces: the
single-artifact export still prints pipes as text, deliberately out of scope).

| fact pinned | where |
|---|---|
| **The reversed pin: the same input that used to produce NO block now produces a `table` block with `c`, `d` in it** — and the cell text is asserted as a substring beside the structural `toEqual`, so neither half can pass vacuously | `tests/lib/mdToPdfmake.test.ts` (`strips HTML tags, and renders a table row instead of deleting it (the row-157 reversal)`) |
| **Header detection and reading order** — `\| Item \| Value \|` + `\| --- \| --- \|` + two body rows parse to `header: [[Item],[Value]]` and the two rows in the text's own order; and a **delimiter-FIRST** table parses HEADERLESS (`header: null`) rather than inventing a header from its first data row | same file (`reads the header row, the delimiter row and the body rows in the text's own order`, `renders a delimiter-FIRST table without a header, never inventing one from its first row`) |
| **A ragged row loses nothing**: fewer cells than the header → the row keeps its cells and gains an empty one (asserted at BOTH levels — the parsed block keeps `[{Silver bell}]`, and the pdfmake body is `[{Silver bell}, {text: ''}]`) | same file (`pads a ragged row with empty cells instead of dropping it`) |
| **A row WIDER than the header widens the table**: three columns for a three-cell body row, the header padded to three, and `e` still present — a renderer sizing from the header alone would drop it | same file (`widens the table for a row carrying MORE cells than the header, keeping every cell`) |
| **An escaped pipe is content, not a separator**: `\| 1 \\\| 2 \| Either \|` is TWO cells and the first reads `1 \| 2` | same file (`keeps an escaped pipe inside one cell`) |
| **A pipe line with NO delimiter row prints as the text it is** — and the defect's own reproduction is asserted run by run: three paragraphs, the middle one the literal pipe line (it used to vanish) | same file (`prints a pipe line with NO delimiter row as literal text, never deletes it`, `never lets a malformed pipe block disappear: it lands in the definition as text`) |
| **A lone delimiter row is text too** (a headerless table with no rows would render a node that prints nothing) | same file (`prints a LONE delimiter row as literal text too …`) |
| **A table as the FIRST block and as the LAST block** both parse (the parser consumes rows by index, so the end-of-input flush cannot eat one) | same file (`reads a table as the FIRST block and as the LAST block`) |
| **A table written under a bullet** closes the list (the bullet keeps its own text) and prints as a real table right after it — the empty bullet is gone, in BOTH directions of the old defect: a nested table, and a bullet whose whole text is a pipe line | same file (`renders a table written under a bullet as its own table, and the bullet keeps its own text`, `prints a bullet whose whole text is a pipe line, instead of the empty bullet it used to be`) |
| **A heading written with pipes keeps them** instead of becoming an empty heading | same file (`keeps the pipes of a heading written with them, instead of emptying the heading`) |
| **The pdfmake node itself**: `headerRows: 1` (so pdfmake repeats the header across a page break), one `'*'` width per column, the header cells bold + shaded, and a layout of FUNCTIONS (the page model's `estimateHeight` calls those paddings — a named layout would measure as padding-free) | same file (`maps a table to a REAL pdfmake table: a header row marked for repetition, equal widths, every cell`) |
| **Every call site of the seam renders it**: one table driven through the module book's three doors — `premiseContent`, `partTextContent`, `artifactProse` — each found as a real `table` node with the exact cell objects, with the raw markup (`\| Premise label \| Value \|`) asserted ABSENT from the document's text | `tests/lib/modulePdf.test.ts` (`prints a markdown table at EVERY call site of the ONE markdown seam, as a real table (docs/17 row 157)`) |
| **EXACTLY ONE pipe grammar and ONE renderer (AGENTS §Centralization 2)**: a source scan over `src/` with a >200-file non-vacuity check, a declared-sites map and a rot check — the escaped-pipe spelling lives in `wikilinks.ts` (its own grammar) and `mdToPdfmake.ts` (`PIPE_ROW`), and `mdToPdfmakeContent(` is reached from exactly three statements in `modulePdf.ts` and nowhere else | same file (`no second pipe-row grammar exists outside the declared sites`, `the markdown→pdfmake renderer is reached through its declared callers and no others`) |
| **The content-preservation differential covers the new kind**: the small fixture's part carries a table, so the added-runs equality (still an exact `toEqual`) gains exactly four strings in `small-procedural` — `Item`, `Value`, `Silver bell`, `40 gp` — and the counts equality moves 57/49 → **61/53** there and NOWHERE else; the loss side is unchanged | `tests/lib/pdfLayout.test.ts` (`adds exactly the page model's own pointers and the navigation's own lines, and nothing else`, `reports the content counts on both sides, so a silent shrink is visible`) |

| injection (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`, each printed back with `git diff --stat`, restored from an OUT-OF-TREE copy — never `git checkout --` — and proved by `git hash-object` identical before and after) | result |
|---|---|
| **(a) drop a cell's text** (`rowCells(row, false)` empties the first cell of every body row) | **RED 6 failed / 66 passed (72)**, exit 1, across the three suites — `pads a ragged row…` with `expected … [ { "text": "" }, { "text": "" } ]` where the cell text belonged; `widens the table…`; `maps a table to a REAL pdfmake table…`; the document call-site pin; and BOTH differential pins (the counts report falling to `"strings": 52` is the differential catching ONE lost cell) |
| **(b) the pre-157 behaviour restored** (the pipe deletion back inside `sanitizeLine` AND `readTable` never consulted — the defect as it shipped) | **RED 18 failed / 54 passed (72)** — every table pin, the malformed pin, both source pins (the restored regex is a SECOND escaped-pipe site, so the scan catches the old shape too) and both differential pins, whose `small-procedural` numbers fall to **57 runs / 49 strings**: the pre-slice content, exactly. **The LOSS side stayed GREEN**, correctly: the baseline never contained those cells — which is why the additions side is an equality and not "at least" |
| **(c) the loss injection** — one artifact BODY dropped (`artifactProse` returns nothing for the small fixture's location) with the page model untouched | **RED 2 failed / 23 passed (25)** in `pdfLayout.test.ts`: the LOSS side reds with `expected [ "Nothing has crossed it in years." ] to deeply equal []` plus the counts report, **while the added-runs equality stayed GREEN** — the same asymmetry docs/17 row 151's I4 recorded, and the reason the loss assertion must never be weakened |

**UNPROVEN, stated as such.** jsdom asserts pdfmake DEFINITIONS, never a rendered
page: nothing here proves a table LOOKS right. (1) Column widths and wrapping are
unverified — every column is `'*'`, so a 9-column table and a 2-column table are
equally "correct" at the definition level, and whether the numbers columns want
narrower cells or right alignment is a real-PDF judgement. (2) A table crossing a
page break is measured by `estimateHeight`'s deliberately over-stating arithmetic
(docs/19 §3), so its real break point and the real `headerRows: 1` repetition are
pdfmake's behaviour, asserted here only as a definition. (3) A table written under
a bullet prints as a block AFTER the list, which is the honest reading of a
line-based parser but is not GFM's nested-table shape. (4) The app DID
not render tables when this landed, and that was recorded as the owner's decision
to make — **docs/17 row 158 is that answer and CLOSES it**: the owner answered
*"Yes — render tables in the app as well."*, so `components/wiki-markdown.WikiMarkdown`
now carries `remark-gfm` and the app renders tables too (its own section below
names where the two grammars disagree). The rest of this sentence stands as the
state at row 157 — while
`lib/markdown.markdownToText` keeps printing pipes as text in the single-artifact
GM-notes export, also out of scope. (5) The `problems` surface gained NOTHING on
purpose: every pipe line now lands somewhere (a table, or literal text at the
shape it was written as), so there is no table failure to report — a ragged row is
padded, not refused, and reporting it would report a non-failure as one.

### The APP renders markdown tables too (docs/17 row 158, docs/18 §2.3)

Row 157 made a markdown table a real table in the module PDF and recorded, in
its own section above, that the app still showed the same text as literal
`| … |` pipe-mush because the app's renderer is a different renderer by design.
The owner was asked directly and answered *"Yes — render tables in the app as
well."*, so the two surfaces disagreeing became a defect instead of a preserved
choice. The whole change is ONE dependency wired into ONE existing component:
`remark-gfm@4.0.1` (a direct dependency, additive in the lockfile) is prepended
to `WikiMarkdown`'s remark pipeline, and `table` is mapped to a component that
renders a real `<table>` inside its own horizontal-overflow wrapper — so the
module reader, the peek modal, the editor preview and the board cards all get
tables from one change (they are four callers, not four renderers).

Where the app's GFM grammar and the PDF's line parser genuinely DIFFER, each
difference is named and pinned rather than engineered away (row 158 lists all
five): GFM has no headerless table at all (a delimiter-first pipe block is
TEXT in the app, a headerless table in the PDF), GFM TRUNCATES a row wider than
its header while the PDF widens the table, and a table under a bullet is nested
in the list item only when the lines are INDENTED into it. What both grammars
must agree on — and do — is the rule the row-157 arc was really about: **no pipe
block disappears**. `lib/markdown.markdownToText` (the single-artifact GM-notes
export's syntax stripper) and `lib/textBlocks` stay untouched.

| fact pinned | where |
|---|---|
| **A real `<table>` with the header row and the body rows in the text's own order** — a `<thead>` from the delimiter's header, a `<tbody>` from every other row | `tests/features/wiki-markdown-tables.test.tsx` (`renders a real <table> with the header row and the body rows in the text's own order`) |
| **The non-vacuity pin: the OLD mush cannot pass** — three shapes (plain, ragged, aligned), each asserted to be a real `<table>` whose RENDERED TEXT contains no `\|` and no `---`; a renderer that "prints the rows nicely" as text fails it | same file (`the OLD mush cannot pass: no table pin is satisfiable by the literal pipes`) |
| **The overflow wrapper exists AND is a wrapper** — `overflow-x-auto` present, the table its first element child, exactly one wrapper, the table's parent the wrapper (a wrapper around nothing scrolls nothing) | same file (`wraps the table in its own horizontal-overflow container, and the table is its CHILD`) |
| **GFM's own extra: the delimiter row's column alignment** reaches the cells as an inline `text-align` (the table element's own `text-left` class must not decide it) | same file (`maps the delimiter row's column ALIGNMENT onto the cells (GFM's own extra)`) |
| **An escaped pipe is content** — `\| x \| y \| z \|` is TWO cells and the first reads `x \| y` | same file (`keeps an escaped pipe inside ONE cell, instead of splitting the row on it`) |
| **A ragged row, both halves**: a SHORT row is padded with empty cells (the rule the PDF shares), while a row WIDER than the header has its excess cells DROPPED — GFM's spec, the PDF's recorded divergence, asserted rather than glossed | same file (`pads a short row to the header's width, and DROPS a cell beyond it — GFM's rule, the PDF's divergence recorded`) |
| **A pipe line with NO delimiter row is text, never deleted** — including prose that merely contains pipes (`a \| b \| c`) | same file (`prints a pipe line with NO delimiter row as the text it is, never deletes it`) |
| **A lone delimiter row is text too** (GFM has no headerless table, so a delimiter-first block renders as the literal lines) | same file (`prints a LONE delimiter row as literal text too (GFM has no headerless table at all)`) |
| **A CHIP INSIDE A TABLE CELL — the highest-risk interaction** — a resolved `[[Ash Gate]]` in a header cell and a padded `[[ Ash Gate \|the gate]]` in a body cell both render as real chips carrying `data-wiki-name`, `data-wiki-artifact-id` and the byte-exact `data-wiki-raw` carrier (tooltip still leads with the token), and the row keeps its other cell | same file (`renders a resolved chip INSIDE a table cell — header cell and body cell — with its byte-exact token`) |
| **An unresolved token in a cell chips as unresolved** — never rendered as its raw `[[…]]` | same file (`renders an UNRESOLVED chip inside a cell as a chip too, never as its raw token`) |
| **THE AUTHORING RULE, pinned from BOTH sides**: a padded token in a cell must escape its pipe, because an UNESCAPED pipe splits the token across two cells (and GFM then drops the row's tail cell, `40 gp`, the row being wider than its header) — and the SAME markdown through `parseMarkdown` (the PDF seam) splits it into three cells too, so this is the two grammars' shared rule and not an app quirk | same file (`an UNESCAPED pipe in a padded token splits it across cells — and GFM then drops the row's tail cell (pinned, not glossed)`) |
| **A table under a bullet, both directions**: INDENTED into the list item is a real table nested in the `<li>` with the bullet's own text kept; UNINDENTED is GFM's lazy continuation of the bullet's paragraph (the PDF flushes a table after the list) — a recorded divergence, and the text is there either way | same file (`reads an INDENTED table under a bullet as a real table INSIDE the list item`, `reads an UNINDENTED pipe block under a bullet as the bullet's own text …`) |
| **The canvas preview's source map survives in a cell**: with `sourceOffsets` the table is the same real table with the same text, and each cell's text run is wrapped in its own `data-md-from`/`data-md-to` span (`Item`, `Value`, `Silver bell`, `40 gp` in order) | same file (`renders the same real table with the same cell text, with the cell runs wrapped`) |
| **THE REAL SURFACE — the module reader**: a seeded module whose part text carries the row-157 defect's own table between two prose lines renders a real table inside the wrapper in `part-body`, cell text in order, the prose on BOTH sides intact, the chip beside it still chipping, and NOT ONE `\|` anywhere in the section's rendered text | same file (`renders a real table with an overflow wrapper in a part’s body, and no pipe-mush anywhere in the section`) — driven through `createAppRouter` + `modulePath`, not the pure component |
| **THE REAL SURFACE — the editor preview**: `MarkdownBody` shows the markup as TEXT in edit mode (that is what an editor is for) and a real table inside the wrapper once Preview is on | same file (`renders a real table (with the wrapper) only once Preview is on`) |
| **EXACTLY ONE app-side table renderer (AGENTS §Centralization 2)**: a source scan over `src/` with a >200-file non-vacuity check finds exactly ONE `from 'remark-gfm'` import (the shared renderer, asserted to really USE it), and a `<table>` element only in the two declared sites — `wiki-markdown.tsx` (the markdown renderer) and `lab/LabeledDungeonView.tsx` (the lab's synthetic grid) — with comment lines skipped and a rot check, so a second pipeline or a second table renderer reds | same file (`\`remark-gfm\` is wired into exactly ONE src file — the shared renderer`, `no src file renders a table element outside the declared sites`) |
| **The pre-existing chip and source-map suites stay green**: the reader-parity pin (a table-less document's rendered HTML byte-identical with no wrapper and no attributes) and every chip pin run unchanged | `tests/features/wiki-source-map.test.tsx`, `tests/features/wiki-chip-tooltip.test.tsx`, `tests/lib/remark-wikilinks.test.tsx` (unchanged, re-run in the gate and under the injections) |

| injection (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`, each printed back with `git diff --stat` before its run and `diff -u` against the OUT-OF-TREE copy, restored FROM that copy — never `git checkout --` — and proved by `git hash-object` identical before and after: `wiki-markdown.tsx` `53b0ff7d2fb1db2c92719d89c06ef7a05863be83`, `remark-wikilinks.ts` `d384e5a45b85d22f37582931ce36261d534215db`) | result |
|---|---|
| **(a) remove the table plugin** (`remarkGfm` dropped from BOTH pipeline forms) | **RED 13 failed / 5 passed (18)**, exit 1 — every table pin, both chip-in-cell pins, all three surface pins and the source-map pin red (`no <table> rendered; text was "… \| Item \| Value \| …"`), and the five GREEN are exactly the pins that must not depend on GFM: the three never-delete pins and the two source scans |
| **(b) remove the table component mapping** (`table: WikiTable` deleted — the table still parses, it just renders bare) | **RED 3 failed / 15 passed (18)** — the wrapper pin, the reader-surface pin and the editor-preview pin, all with `expected null not to be null`, while every REAL-TABLE pin stays GREEN: the wrapper is behavioural coverage, not a restatement of `<table>` |
| **(c) make `remarkWikiLinks` skip a `tableCell`** (the plugin stops descending into cells) | **RED 2 failed / 40 passed across three files** — exactly the two chips-in-cell pins, with the pre-existing chip suites (`wiki-chip-tooltip.test.tsx`, `tests/lib/remark-wikilinks.test.tsx`) and every table pin GREEN. **The first attempt at this injection was TOO SHALLOW and reds nothing**: skipping only the `tableCell` node's own text transform leaves the recursion into its children intact, which is why the shipped injection moves the guard onto the RECURSION — recorded because a pin only the honest injection reds is the point |

**REVERT-PROVEN (one injection at a time, the RED set recorded above).** The
table grammar is one plugin import and one component mapping: dropping either
one reds a disjoint set of pins, so both halves are covered by behaviour rather
than by a restatement. The chips-in-cell pin is proven load-bearing on its own
(2 RED, 40 GREEN across three files), so it is not decoration beside the
untouched chip pins.

**UNPROVEN, stated as such.** jsdom does not lay out, so nothing here proves a
table LOOKS right: (1) real column widths and cell WRAPPING are unverified —
`w-full border-collapse` gives the browser's own auto layout, and whether a
4-column table stays readable in the reader's column is a judgement on screen;
(2) `overflow-x-auto` is asserted as a DEFINITION (the class and the nesting),
never as a scroll that happened: whether a wide table actually scrolls inside
the reader's column on a narrow viewport, and whether it needs a `min-w` to do
so, is the owner's to see; (3) the borders, the shaded header and the padding
are asserted only as class strings, so how they read against the reader's dark
theme is unverified; (4) GFM's other extensions (strikethrough, autolink
literals, task-list checkboxes, footnotes) are ON as a consequence of the one
dependency, and their appearance in a real module's prose has never been read by
the owner — the reader-parity pin only proves a document with NONE of those
constructs renders byte-identically.
### Per-mob treasure reaches the ledger (docs/17 row 159, docs/11 §Room keys, docs/18 §2.3)

A roster entry's `treasure` was authored in the encounter editor, stored on
`MonsterEntry.treasure`, frozen onto every seeded token and printed GM-only on
the token card and in the canvas chat's details block — and the module PDF's
treasure ledger read the ENCOUNTER's own `treasure` field and nothing else. The
net effect was worse than an omission: an encounter whose own field was empty was
skipped by the ledger WHOLE, so a GM who typed "Pouch: 5 gp, a silver bell" on
every Bandit got a token card, an editor field, a chat line — and an EMPTY
treasure ledger, no per-mob line in the encounter section, and nothing in the
reader. Nothing warned him (help and guide advertised "the treasure ledger"
without bounding it), and no pin named the ledger's rows at all.

The fix is ONE seam extended, never a second mechanism: `domain/encounterResolve`
gains `rosterTreasureFor(entry)`, which answers both "does this mob carry
anything" (`null`) and "what is the one printed line" (`{ text, printed }`, the
`Treasure: ` label composed in `TREASURE_LABEL`). All four roster-printing
surfaces render it — the module book's encounter section (a `muted` line under
the mob's name, GM-only), its ledger (`treasureLedger`, one labelled row per
carrying mob), the single-artifact GM export (`rosterRows`, a NODE of its own so
the pinned reference string stays intact), and the reader's roster row
(`data-testid="roster-treasure"`). The encounter's own field keeps its own line
everywhere; the two sources are never merged.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| The ledger's ROWS: the encounter's own line, then one labelled row per carrying mob in roster order — an EXACT `toEqual` on the header AND the rows | `lib/per-mob-treasure.test` (`prints ONE row per source …`) | ✅ |
| An encounter whose ONLY treasure is on its roster produces a ledger (the fix's essence — this document had NO ledger before) | `lib/per-mob-treasure.test` (`produces a ledger for an encounter whose ONLY treasure is on its roster`) | ✅ |
| A mob that carries nothing: no ledger row, no line in its own encounter-section block, and no label over a blank (only ONE bare `Treasure: ` run exists — the encounter's own labeled section, whose value is the run beside it) | `lib/per-mob-treasure.test` (both pins above) | ✅ |
| An encounter with no treasure anywhere still produces NO ledger (no chapter node, no kicker, no table), with non-vacuity: that document really prints the encounter and its mob | `lib/per-mob-treasure.test` (`produces NO ledger when no printed encounter stores treasure anywhere`) | ✅ |
| The PLAYER document carries none of it — no ledger, no mob line, not even the encounter-level line — while the encounters themselves still print | `lib/per-mob-treasure.test` (`carries none of it into the PLAYER document`) | ✅ |
| The module book's encounter section prints the mob's line under THAT mob, and the encounter's own line stays separate and unmerged | `lib/per-mob-treasure.test` (`prints the mob's treasure in the encounter section, under the mob it belongs to`) | ✅ |
| **ONE formatter, both books**: the line is EXTRACTED from each document on its own (the row found by its own `Name ×count` label, the treasure read from its sibling) and the two are compared — with non-vacuity on both sides, `null` for the empty mob in BOTH, and no ledger in the single-artifact export | `lib/roster-reference-parity.test` (`a mob's TREASURE is the same line in both books …`) | ✅ |
| **ONE formatter, the app too**: the reader's rendered span is compared with the line the module BOOK prints for the same mob, each read from its own surface, never from the rule both call | `features/reader-encounter-roster.test.tsx` (`shows what a mob carries, in the book's own words …`) | ✅ |
| **EXACTLY ONE label and ONE emptiness rule** (AGENTS §Centralization 2): the label lives in the domain module alone, and `modulePdf`, `pdfExport` and `monster-source` read no roster entry's raw field for printing | `lib/roster-reference-parity.test.ts` (`the roster TREASURE goes through its own ONE rule …`), `features/reader-encounter-roster.test.tsx` (`the panel prints a mob's TREASURE through the domain rule too`) | ✅ |

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run, restored from an OUT-OF-TREE copy —
`/tmp/tres-backup`, never `git checkout --` — and proved by `git hash-object`
identical before and after: `modulePdf.ts`
`c5bbdebcf65bd7c7f480d577f0be27f2cb87a500`, `monster-source.tsx`
`1480580930a1cb0f93866948ef423f8c47f94ea9`; raw logs kept):

| injection (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) the per-mob ledger rows dropped** (`if (treasure !== null) continue;` at the roster loop in `treasureLedger`) | **RED 3 failed / 13 passed (16)** across the two lib files: the exact-rows `toEqual`, the only-roster-treasure non-vacuity pin, and the parity file's labelled-row assertion |
| **(b) the audience guard removed** (`const treasure = rosterTreasureFor(monster);` in the encounter section — per-mob treasure reaches the player book) | **RED 1 failed / 4 passed (5)**, exactly the player pin, whose `Expected`/`Received` block shows `Treasure: Pouch: 5 gp, a silver bell` sitting in the PLAYER document's text |
| **(c) the reader made to diverge** (its own span rendering `Carried: {monster.treasure}` with its own emptiness check) | **RED 2 failed / 4 passed (6)**: the reader-vs-book equality reds with `expected 'Carried: Pouch: 5 gp, a silver bell' to be 'Treasure: Pouch: 5 gp, a silver bell'`, AND the source scan reds on the raw-field read — the drift caught on both sides |

**NUMBERS** (bounded gate, `CAMPAIGNER_TEST_WORKERS=1`, raw log kept). The
baseline was re-derived twice: directly at `b5a917d` **324 files / 3807 tests,
exit 0**, and again at the REBASED base `bfbaece` **325 files / 3825 tests**
(row 158 landed mid-slice and its own gate states +1 file / +18 tests). This
landing gates on the rebased tree at **326 files / 3834 tests, exit 0** — +1
file, +9 tests over the base, the nine pins below, no existing assertion
edited, no test skipped, `Errors:` absent. The FULL suite was re-run after the
rebase, because the rebased tree is not the tree the first green run covered.

**UNPROVEN, stated as such.** jsdom asserts pdfmake DEFINITIONS and DOM, never a
rendered page. Nothing here proves the ledger LOOKS right: whether a multi-line
mob treasure wraps inside its table cell, where the ledger's table breaks across
a page, or whether a long carrier label (`Pier Ambush · Cultist ×4`) leaves the
`Treasure` column enough width — every ledger column is `'*'`, so a long label
and a long loot list share the row equally, and that share is the owner's
judgement in a real PDF. Three things only he can check: (1) an encounter with
BOTH an encounter-level line and per-mob lines — that the two row kinds read as
distinct back matter; (2) a mob whose treasure is three or more lines; (3) a
ledger long enough to cross a page, where a mob row at the top of a continuation
page is readable only because its label repeats the encounter. **And the honest
LIMIT of the feature itself:** the ledger holds only what was authored on the
encounter's and its mobs' `treasure` fields — a published pack's own carried
items are never parsed into them, and the layout's per-room `keyTreasure` is a
play-time key card, not a ledger source. That enrichment is a separate, unbuilt
arc the owner has declined; the help and guide sentences state the bound instead
of implying otherwise.

### The bestiary slot's book disambiguates and never vetoes (docs/17 row 161, docs/11 §Module-side cast, docs/18 §2)

`entity-batch.libraryCitationForEntity` contradicted its own comment. The
comment said the ambiguity failure was for a name two creatures share "and the
slot named no book, or named a book that holds no such creature"; the code
applied that rule to EVERY case. It filtered the same-named candidates by the
named book's title and THREW `that book holds no creature of that name` when
nothing matched — even at `sameName.length === 1`, where the library holds
exactly one creature of that name and there is nothing to disambiguate.

The owner hit it repeatedly generating a module: «Plague Zombie» from
«Monsterkern» refused with *"the library has Plague Zombie (Pathfinder Monster
Core)"*; «Commoner», «Mayor» and «Farmer» from «NSC-Galerie» refused against
*"Pathfinder NPC Core"*. His modules are authored in GERMAN, so the model
localises the pack titles it was shown ("Monsterkern" = Monster Core,
"NSC-Galerie" = NPC Gallery) while the library's own titles are English — and
the refusal NAMED the very creature it refused to use, which is the proof that
the data was there and the veto was the only obstacle. The `book` value is a
hint the prompt asks for (*"add \"book\" … only when the library holds several
creatures of that name"*), and the code treated it as a key.

The fix is the same function, four rules, no new mechanism: (1) no creature of
that name → the EXISTING loud failure byte-identical, nearest-name suggestions
included; (2) exactly one → RESOLVE IT, whatever book the slot named, the book
not read at all on that arm; (3) two or more → a named book matching EXACTLY ONE
candidate resolves it, otherwise the existing loud ambiguity failure listing
every candidate WITH the book it really comes from — never a silent pick; (4) NO
fuzzy matching on the name, because the same pool is the VOCABULARY the spine
prompt carries (docs/17 row 114), so a fuzzy match would silently cast a
different creature than the module asked for. The citation still stamps the
LIBRARY's title (`citationBookTitleFor`), never the model's string, so `missing
ref` reporting keeps naming a pack that exists.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| A UNIQUE creature name with a book the library does not have — including a LOCALISED title («Monsterkern», «NSC-Galerie») — resolves, and the citation records the LIBRARY's real `bookTitle` | `features/entity-batch-creature-book.test` (`the owner's case: «Plague Zombie» from «Monsterkern» …`, `the owner's second shape: «Farmer» from «NSC-Galerie» …`, `a book the library does not have AT ALL resolves too …`) | ✅ |
| A unique name with NO book resolves exactly as before (the old behaviour is not merely preserved, it is a pinned arm) | `features/entity-batch-creature-book.test` (`a slot with NO book resolves the unique name as it always did`) | ✅ |
| The owner's case END TO END: the spine writes the slot, the batch casts, the row is born through `castCreatureAsNpc`, and the stamped `creatureRef.bookTitle` is the LIBRARY's — never «Monsterkern» | `llm/moduleGen-cast.test` (`the owner's case: a LOCALISED book title on a UNIQUE creature RESOLVES …`) | ✅ |
| An AMBIGUOUS name (two books hold it) with a book matching exactly one candidate resolves THAT one, and stamps that book | `features/entity-batch-creature-book.test` (`the book resolves the one candidate it matches …`) | ✅ |
| An ambiguous name whose book matches NONE of the candidates refuses loudly, listing every candidate with its real book; the same with NO book refuses too — never a silent pick | `features/entity-batch-creature-book.test` (both ambiguity pins), `llm/moduleGen-cast.test` (`a NON-matching book on an AMBIGUOUS name is refused …`) | ✅ |
| **NON-VACUITY: an unknown name still fails, and «nearest» never casts.** «Butcher» against a library holding Poacher/Teacher/Bounty Hunter throws with the nearest names IN THE MESSAGE; a foreign book cannot resurrect an unknown name; with nothing close the sentence is the pre-114 bytes exactly | `features/entity-batch-creature-book.test` (all three pins in `a name the library does not hold still fails …`) | ✅ |
| The name match stays EXACT: a one-edit near miss refuses | `features/entity-batch-creature-book.test` (`the name match stays EXACT …`) | ✅ |
| **ONE creature lookup** (AGENTS §Centralization 2): `listLibraryCreatures`'s call sites are exactly `db/creatureRepo` / `llm/creatorRoster` / `entity-batch` (real calls only, comments excluded), and `libraryCitationForEntity` is DEFINED in one file — the doc index row naming it is checked in the same pin | `features/entity-batch-creature-book.test` (both source pins) | ✅ |

**Pins, by name** (13 new in `tests/features/entity-batch-creature-book.test.ts`,
11 behavioural + 2 source; one pre-existing pin REVERSED in place and one ADDED
in `tests/llm/moduleGen-cast.test.ts`):

1. `the owner's case: «Plague Zombie» from «Monsterkern», and the citation records the LIBRARY's book`
2. `the owner's second shape: «Farmer» from «NSC-Galerie» against «Pathfinder NPC Core»`
3. `a book the library does not have AT ALL resolves too — the title is a hint, not a key`
4. `a slot with NO book resolves the unique name as it always did`
5. `the name match stays EXACT: a one-edit near miss still refuses (a fuzzy match casts another creature)`
6. `the book resolves the one candidate it matches, and the citation names THAT book`
7. `a book that matches NO candidate refuses LOUDLY, listing every candidate WITH its book`
8. `an ambiguous name with NO book refuses — never a silent pick`
9. `«Butcher» — the NON-VACUITY pin: the nearest creatures are MESSAGE ONLY and never resolve`
10. `an unknown name with a FOREIGN book still fails — a book cannot resurrect a name`
11. `an unknown name with nothing close stays quiet — the pre-114 sentence byte for byte`
12. `the library pool has exactly these readers — a SECOND creature lookup goes red here`
13. `the slot→citation resolution is defined in ONE place and named in the seam index`

and in `tests/llm/moduleGen-cast.test.ts`: `a book that holds no such creature
is refused by name, listing what the library has` is REVERSED (it asserted the
defect) into `the owner's case: a LOCALISED book title on a UNIQUE creature
RESOLVES, stamped with the LIBRARY's book`, plus the new
`a NON-matching book on an AMBIGUOUS name is refused, listing the candidates and
their real books`. No assertion was weakened, none deleted outside that one
deliberate reversal, and none skipped.

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run, restored from an OUT-OF-TREE copy —
`/tmp/creature-injection-backup/entity-batch.ts`, never `git checkout --` — and
proved by `git hash-object` identical before and after:
`795f6047c0633df5b5e41c5f9e11655d231a904d`; raw logs kept at
`/tmp/creature-logs/injection-a.txt` and `injection-b.txt`):

| injection (one file at a time, `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) the unconditional book filter restored** (the unique-name arm re-runs the old veto: a named book that matches no candidate throws `that book holds no creature of that name`) | **RED 4 failed / 37 passed (41)**: exactly the four resolve pins — the three «Monsterkern»/«NSC-Galerie»/unknown-book pins in the new file and the owner's case end to end in `moduleGen-cast` |
| **(b) resolve by NEAREST instead of exact** (an empty exact match falls back to `nearestLibraryCreatures(...)[0]`) | **RED 4 failed / 37 passed (41)**: the «Butcher» non-vacuity pin (its own failure text: `expected a refusal for «Butcher», but it RESOLVED to chunk 622e0786-…`), the foreign-book unknown-name pin, the one-edit near-miss pin, and `moduleGen-cast`'s pre-existing row-114 near-miss pin |

**NUMBERS** (the bounded landing gate — `NODE_OPTIONS=--max-old-space-size=2048
CAMPAIGNER_TEST_WORKERS=1`, raw log kept at
`/tmp/creature-logs/gate-full-final.txt`). The baseline at this slice's base
(`6f31f7e`) is **326 files / 3838 tests**; the rebased base (`5c9c8fd`, whose two
intervening commits touch `AGENTS.md` only, a file no test reads) is
suite-identical. This landing gates on the frozen rebased tree at **327 files /
3852 tests, exit 0** — **+1 file, +14 tests**: the 13 pins in the new file plus
the one ADDED in `moduleGen-cast` (the pin reversed in place counts once). `pnpm
lint` carries its ONE pre-existing warning at
`src/features/campaign/components/artifact-editor.tsx:258` (not this slice's),
`pnpm typecheck` is clean, and the run printed no `Errors:` line. The full suite
ran ONCE on the rebased tree; the only edit afterwards is this numbers sentence,
which no test reads.

**UNPROVEN, stated as such.** (a) **No pin shows a real model writing a
localised title.** The fixture string «Monsterkern» STANDS IN for the owner's
report: a live provider's vocabulary is not reproducible in a test, so what is
measured is the only thing that can be — that such a string, arriving in a
slot, resolves instead of vetoing a cast whose answer is unique. (b) **The
ambiguity path is exercised with a seed, not with a real two-book library**: two
same-named chunks are inserted into fake-indexeddb by the test, so "two books
are installed" is simulated rather than imported. (c) **A real ambiguous module
run still refuses in practice**: the spine window lists creature NAMES only, so
a model has no way to know the library's book titles — putting the titles into
the window would change the emitted prompt bytes and is a separate, unratified
decision (docs/17 row 161, §Considered and not taken). **SUPERSEDED the same day
by docs/17 row 163, which took that decision: the window now prints each
creature's pack title, so the untested half is no longer "the model cannot know
a title" but "the model copies the one it is shown" — see §What the window SHOWS
is what the cast compares below.** (d) **No Dexie or
schema change is involved at all** (the change is control flow inside one
function), so there is nothing to migrate and nothing to verify about stored
rows.

### The gate is a script (memory is capped, not requested)

Run `scripts/gate.sh` — never a hand-rolled `vitest run`. Its chunks are DISJOINT
(six test directories plus an explicit remainder list, with `tests/features`
split in two) and it prints `chunk arithmetic: N of M test files covered`,
failing when they disagree: a path filter matches its own subdirectories, so the
first version ran most of the suite twice, and a file that falls between chunks
must be a defect rather than a saving. It holds the atomic suite lock, refuses to
start while any other suite is running, runs vitest as at most TWO concurrent
PATH CHUNKS — each with ONE worker, each in its OWN process group (`setsid`) —
and samples the COMBINED RSS of every live chunk every second, killing them all
above 3000 MB RSS or below 2500 MB available memory. It prints each chunk's wall
time and PEAK RSS with the summed counts. `vite.config.ts` caps every worker's
heap at 1536 MB, which binds even a bare `pnpm exec vitest run`. A chunk the
watchdog killed is VOID, never evidence: it is re-run sequentially and never
counted, and if the combined peak only APPROACHES the cap the gate falls back to
sequential before the kill line (docs/17 row 175).

Why both halves: the growth that fills this box is OFF-heap (`pdfjs` holds
`ArrayBuffer`s, which no `--max-old-space-size` bounds) and 339 test files in a
single process accumulate it. Owner directive, verbatim: *"please make sure that
you restrict the mem use to not more than 4gb or so since you are not the only
worker here."*

**Measured on the `9b925e3` tree (docs/17 row 175):** the vitest chunks cost
**706.6 s** sequentially and **397 s** two at a time; the whole gate is **473 s
(7 m 53 s, the 76 s of lint + typecheck included)** against the ~12 min the
chunks alone used to take, with the summed counts UNCHANGED at **339 files /
3978 tests**. The combined peak of the two concurrent chunks is **2295 MB of the
3000 MB cap**, which is why the soft fallback sits at 2700 MB. The per-chunk table
and the `isolate: false` NO are in row 175.

### Tests that share one background belong in one file (docs/17 row 176)

Five small `tests/features` files that mount the SAME background — `fake-indexeddb`
+ `clearDatabase()` + `flushAsyncUpdates()`, and **no `vi.mock`** — now run as ONE
file, `tests/features/workspace-artifact-surfaces.test.tsx` (32 tests, one
`describe` per original file, every test name and all 116 `expect()` sites
intact). Measured in one vitest process, vitest's own Duration breakdown:
**23.80 s → 16.14 s** (import 8.45→4.75, environment 2.78→0.61, setup 0.62→0.16,
tests 11.29→10.47, transform 2.95→2.97), i.e. **1.92 s saved per removed file**;
the 3× sequential canary was 32/32 green each (14.55 / 14.63 / 15.34 s). The
convention, with its hard rules:

- **Same background, or don't merge.** Files belong together only when they
  import the same helper/fixture modules and mount the same provider/Dexie
  snapshot. A merge whose files need `vi.resetModules()` to get along is NOT a
  shared background — the reset is the counter-example, not a fix.
- **Mocks must MATCH.** No `vi.mock` at all is ideal; files whose mock
  target-SETS differ must NOT merge. This is the measured failure mode: the
  `--no-isolate` trial reddened deterministically (the same 10 of 14 act-heavy
  files, `vi.fn()` mocks not applied) because those files shared one module
  registry — and a merge shares one registry by construction (docs/17 row 175).
- **The console guard's file scope moves on merge.** `tests/setup.ts` matches
  `ALLOWED_NOISE` against `ctx.task.file.name`, so a merged file loses every
  original's file-scoped allowance. Check before merging: a merged test that
  starts failing on console noise is usually a file-scoped entry that no longer
  matches.
- **Act()-heavy files are excluded for now** — `board-*`, `canvas-*`, `chat-*`,
  `battle-*`, `creature-portrait-*`, `module-reader*`, `persona-run-ui*`
  (20 files in `tests/features`). That family is what the `--no-isolate` trial
  reddened.
- **Stop at ~120 tests per merged file.** Past that a failure can no longer be
  found by name and the file stops being navigable; split the cluster into two
  merges instead.
- **Verify one-way leaks, don't hide them.** `export-dialog`'s tests mutate
  `URL.createObjectURL` / `HTMLAnchorElement.prototype.click` directly (not
  restorable by `vi.restoreAllMocks()`), so its `describe` sits mid-file on
  purpose — the following describes have to survive the leak, and they do.

Inventory at the pilot's base (`bbb10ea`): `tests/features` 137 files — 103 import
`clearDatabase`, 53 import the flush helpers, 52 carry no `vi.mock`, 11 carry no
mock AND both helpers; `tests/llm` 71 files — 23 carry no `vi.mock`. The measured
per-file framework baselines are **1.6 s/file** (features), **0.9 s/file** (llm)
and **1.1 s/file** (remainder). The full inventory, the pilot's numbers, the
canary and the sweep recommendation are docs/17 row 176. The landing gate on the
merged tree was GREEN: **335 files / 3978 tests** (the test count is UNCHANGED
from the 339/3978 baseline — five files became one, nothing weakened or
skipped), lint 0 errors, typecheck clean, no `Errors:` line, combined peak
2277 MB of the 3000 MB cap.

### The sweep: mock-carrying clusters, and the stop conditions that are MEASURED (docs/17 row 177)

Row 176 ran the pilot on the safest possible cluster (five files, NO `vi.mock`)
and left the mock-carrying clusters to the sweep. The sweep merged **39 files
into six** across `tests/llm` (2) and `tests/features` (4) — every one of them a
group of ≥5 files with an IDENTICAL `vi.mock` target-set (or no mock at all),
the same helper/fixture imports and the same Dexie mount, with no file-scoped
`ALLOWED_NOISE` reliance, no act()-heavy family member, and under the
~120-test cap. The accounting rule that makes "nothing was lost" checkable, run
per cluster: from `git show 55be755:<original>` and from the merged file,
extract the `it(`/`test(` names and the `expect(` site count — **both must be
identical**. In all six clusters the test-name SET was identical and the
`expect(` counts matched exactly (389 tests / 1728 assertion sites moved). The
merged file keeps the originals findable: one `describe('<original
basename>', …)` per original and a header naming every source path, so grepping
an old filename still lands on the merged file.

The pilot's rules stand. The sweep added FIVE measured stop conditions, each
found by a red gate rather than by reasoning:

- **A merged file shares ONE mock instance per mocked module, so
  per-`describe` teardown is NOT enough.** Each original owned its own `chat` /
  `toast` mock; in one file they share one `vi.fn()`. Two `tests/llm` tests went
  red on call counts (5 and 3 where 2 was asserted) because a previous
  `describe`'s `mockImplementation` answered a later test's `...Once` queue
  overflow and because call history carried across describes. Every merged file
  whose originals mock carries a FILE-LEVEL `beforeEach(() => {
  vi.resetAllMocks(); })`; each `describe`'s own hooks then install what it
  needs, because outer hooks run before inner ones.
- **The environment split is a HARD STOP.** `vite.config.ts`'s two
  `test.projects` (node + jsdom) are disjoint by file: a file listed in
  `nodeTestGlobs` can never share a merged file with a default-jsdom file,
  whatever their mock sets. This is why the brief's
  `@/domain/artifact,@/llm/openrouter,@/search` llm cluster was not merged: its
  fourth member `encounterRun` is node-env while the other four are jsdom (and
  four files is below the ≥5 floor anyway).
- **A file whose tests leave async background continuations cannot merge with
  files that assert call counts.** `moduleGen-auto-spine` passed all its own
  tests but, merged ahead of `moduleGen-conflict-structure`, left background
  generation in flight that reached the later `describe`'s `chat` mock —
  measured 3 calls where the original file counted 2. That is the sweep's own
  stop condition (the merge CAUSED the leak), so it was SPLIT OUT and stays a
  file of its own rather than relying on placement.
- **A cluster the brief lists can still violate the brief's own ≥5 rule.** Two
  of the named llm clusters (`toast+openrouter+search` and
  `domain/artifact+openrouter+search`) have exactly 4 files; with the ≥5 floor
  binding, they do not merge (a 4-file merge is a smaller win than the pilot,
  not a rule-compliant one).
- **Direct-global mutators go LAST.** `cover-art` (`URL.createObjectURL` /
  `revokeObjectURL`) and `spawn-picker`
  (`HTMLElement.prototype.offsetWidth/offsetHeight`) mutate process-wide state
  that no `afterEach` restores, so their `describe`s sit at the END of their
  merged files — every other describe runs before the stub exists.

The honest limit, stated not hidden: the ~1.6 s/features and ~0.9 s/llm per-file
figures are the framework cost a merge removes; a merge does not shorten the
ASSERTION time (the `tests` component is unchanged), it does not prove the
saving is linear (a bigger file has a bigger `tests` component and the framework
share shrinks), and one cluster's green canary does not prove another cluster's
adjacency is safe. The merged-file mapping, the accounting table, the 3×
canary, the measured gate delta and every EXCLUDED cluster with its reason are
docs/17 row 177.

### What the window SHOWS is what the cast compares (docs/17 row 163, docs/12 §5, docs/18 §2/§4)

Row 161 made the bestiary slot's `book` a DISAMBIGUATOR instead of a veto, which
fixed the UNIQUE creature name. It left the genuinely ambiguous one unusable,
because the prompt's vocabulary (`llm/creatorRoster`, row 114) listed creature
NAMES ONLY — a model filling `"book"` had to invent a title, and a module
authored in German invented a TRANSLATION of one («Monsterkern», «NSC-Galerie»)
that matches no candidate in the library and therefore narrows nothing. The
owner's decision, verbatim: *"Yes — show each creature's pack title in the
vocabulary."*

Every window line is now `Name — Pack Title` (`CREATOR_ROSTER_TITLE_SEPARATOR`,
rendered by `creatorRosterLine` — ONE definition of the shape). The title is the
book row's OWN title, read through the SAME stamping read a citation uses
(`domain/encounterResolve.citationBookTitle`), one read per BOOK the window
covers and only for the window's lines. A creature whose library records no
title — its book row is gone — prints its NAME ALONE: no separator, no empty
dash, no `Unknown`, and specifically NOT the LABEL reading's `Rulebook`
stand-in, which is a value a model would copy as if it were a pack.

Three rules follow, and all three are pinned. The NAME is the half the lookup
compares, so the emitted rule says the name is the part before the separator —
a model that copied a whole line would name nothing, which the row-114 cast pin
demonstrates by feeding the window's own line into the cast. The TITLE is the
half the cast compares against the slot's `book`, so a title copied out of a
line must narrow an ambiguous name (the differential pin). And a line without a
title is a FACT about the library, not a gap to fill.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| Every window line carries the creature's REAL pack title, in the `Name — Pack Title` shape, in window order | `llm/creatorRoster.test` (`prints "Name — Pack Title" for each creature, in window order`) | ✅ |
| The titles add the separator plus the book's own title and NOTHING else; the name list's order and content are otherwise unchanged (nothing silently dropped to pay for the titles) | `llm/creatorRoster.test` (`adds the pack title and NOTHING else to a line — the name list is untouched`, `costs the separator plus the book's own title per line, and nothing else`) | ✅ |
| A creature whose library records no title prints its NAME ALONE — no separator, no empty dash, no stand-in, no `Unknown`/`none`; a window mixing titled and untitled lines invents nothing | `llm/creatorRoster.test` (both pins in `a creature whose library records no pack title prints its NAME ALONE`) | ✅ |
| The title comes from the ONE stamping read (`citationBookTitle`), never the LABEL reading's `Rulebook` stand-in, and the window does not re-read the chunk table it pooled | `llm/creatorRoster.test` (`reads the title through the ONE stamping read, never the LABEL stand-in` — a source pin over CALLS, so the doc comment naming the forbidden reader does not satisfy it) | ✅ |
| ONE rulebook read per BOOK the window covers, never one per line | `llm/creatorRoster.test` (`reads ONE book per book, not one per line — two books behind five lines cost two reads`) | ✅ |
| **DIFFERENTIAL: a title COPIED out of a line narrows an ambiguous name to exactly the creature that line lists, and the citation stamps that same string** | `llm/creatorRoster.test` (`a title COPIED from a line narrows an ambiguous name to the creature that line lists`) | ✅ |
| **NON-VACUITY: a window built WITHOUT titles cannot satisfy the title pins** (the same entries, built through the titles-free arm, are bare names) | `llm/creatorRoster.test` (`a window built WITHOUT titles cannot satisfy the title pins (non-vacuity)`) | ✅ |
| The EMITTED clause says where a real title comes from, that it is copied rather than translated, and that a line with no title records none — pinned over the clause TEXT and tied to the window's own separator constant | `llm/moduleGen-cast.test` (`the emitted clause and the window it governs agree about the pack-title shape`) | ✅ |
| The prompt a spine run actually carries shows both creatures WITH their titles, and the row-114 cast pin reads the NAME half and finds the title half on the stamped citation | `llm/moduleGen-cast.test` (`carries the ACTUAL creature names, the rule that governs them and the truncation note`, `casts the creature the WINDOW listed, by the name the window printed`) | ✅ |
| The settings preview renders both line shapes (a titled line and a name-alone line) through the SAME clause builder a run uses | `features/prompt-styles-section.test` (mounts the preview, which composes from `bestiaryVocabularyBlock`) | ✅ |
| An EMPTY library still composes the pre-change prompt byte for byte — the whole change is additive | `llm/moduleGen-cast.test` (`offers NO slot and composes the pre-change prompt when the window is EMPTY` + the `spine-classic-default` golden) | ✅ |

**Pins, by name** (9 new in `tests/llm/creatorRoster.test.ts`, 1 new in
`tests/llm/moduleGen-cast.test.ts`; 12 pre-existing pins re-baselined to the new
line shape — none deleted, none weakened, none skipped):

1. `prints "Name — Pack Title" for each creature, in window order`
2. `adds the pack title and NOTHING else to a line — the name list is untouched`
3. `reads ONE book per book, not one per line — two books behind five lines cost two reads`
4. `prints no separator, no empty dash and no stand-in when the book row is gone`
5. `mixes titled and untitled lines in one window without inventing anything`
6. `reads the title through the ONE stamping read, never the LABEL stand-in (source pin)`
7. `costs the separator plus the book's own title per line, and nothing else` (the budget pin, measured over the owner's documented library)
8. `a window built WITHOUT titles cannot satisfy the title pins (non-vacuity)`
9. `a title COPIED from a line narrows an ambiguous name to the creature that line lists`

and in `tests/llm/moduleGen-cast.test.ts`:
`the emitted clause and the window it governs agree about the pack-title shape`.

The re-baselined pins are the row-114 line assertions (order, ties, `—`-level
last, fractional levels, the 300-line cap, determinism, the `processing` book,
the nested-heading name) plus `moduleGen-cast`'s vocabulary/header/midpoint
pins: each one now expects the line WITH its pack title, and the cast pin splits
the line on the separator.

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run, restored from an OUT-OF-TREE copy —
`/tmp/injection-163/backup/creatorRoster.ts`, never `git checkout --` — and
proved by `git hash-object` identical before and after:
`730c62051d3142ddd4b9704de44f72da92fdfcdf`; raw logs kept at
`/tmp/titles-logs/injection-a.txt` and `injection-b.txt`):

| injection (one file at a time, `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) the title dropped from the window** (`creatorRosterLine` returns the bare name) | **RED 16 failed / 36 passed (52)**: the four title pins, the source pin, the differential copy pin, the budget pin — whose expectation is derived from the ENTRIES and the library's titles rather than read back off the lines it measures, because that first derivation AGREED with this arm (recorded, and the reason it was fixed) — plus every re-baselined line pin (order, ties, `—` level, fractions, cap, determinism, the nested heading, the `processing` book) and `moduleGen-cast`'s vocabulary/header/midpoint/cast pins |
| **(b) an unknown title printed as `Name — `** (`creatorRosterLine` always appends the separator) | **RED 5 failed / 47 passed (52)**: the no-placeholder pin on BOTH its arms — its own failure text is `expected [ 'Zombie — ' ] to deeply equal [ 'Zombie' ]` — the mixed-window pin, the non-vacuity pin (`expected [ 'Creature 0000 — ', …(2) ]`), `adds the pack title and NOTHING else`, and the budget pin |

**NUMBERS** (THE bounded landing gate — `scripts/gate.sh`, the ONE gate since the
owner's 4 GB directive; raw log kept at `/tmp/titles-logs/gate-final.txt`,
per-chunk logs in `/tmp/titles-logs/gate-final/`). Base: `46cdd41` (the gate
script, its `src`-chunk fix and the docs commits above `57dd763`; no test file is
touched by any of them, so the suite is identical to the brief's `e2b9e64`
baseline of **327 files / 3852 tests**). The script's own summary, verbatim:
`tests_lib: Test Files 31 passed (31) Tests 357 passed (357) ok (peak 798MB)`,
`tests_llm: 70 passed (70) 1146 passed (1146) ok (peak 774MB)`, `tests_db: 30 /
351 ok (peak 567MB)`, `tests_domain: 21 / 290 ok (peak 568MB)`, `tests_features:
133 / 1307 ok (peak 1088MB)`, `tests: 327 passed (327) 3862 passed (3862) ok
(peak 1091MB)`, `peak RSS of any single chunk: 1091MB (cap 3000MB)`,
`GATE GREEN`. Its `tests` chunk IS the complete suite (every test in this repo
lives under `tests/` — `find src -name '*.test.*'` = **0**, which is why
`46cdd41` dropped that chunk from the list): **327 files / 3862 tests** against
the base's 327 / 3852 = **+0 files, +10 tests**, exactly the 9 new pins in
`tests/llm/creatorRoster.test.ts` plus the 1 in
`tests/llm/moduleGen-cast.test.ts`. `lint errors: 0` (`pnpm lint` carries its ONE
pre-existing warning at
`src/features/campaign/components/artifact-editor.tsx:258`, not this slice's) and
`pnpm typecheck` is clean. No `Errors:` line, no watchdog kill, no VOID chunk,
no chunk above 1091 MB. **One honest note about the chunk list**: the
per-subdirectory chunks are SUBSETS of the `tests` chunk, so "summed counts"
double-count ~285 of the 327 files — the suite's true size is the `tests` chunk's
own, which is what is quoted as this landing's numbers. (An earlier run of the
same gate read `GATE RED` only because its then-present `src` chunk exits 1 with
`No test files found`; that was a bug in the script, fixed by `46cdd41`, and no
test in this slice ever failed in it.)

**UNPROVEN, stated as such.** (a) **No pin can show a real model COPYING the
printed title instead of inventing one.** Every pin mocks the transport at the
protocol boundary, so the INTENT ("the model copies a line's title") is not
measurable here; what is measured is that the string the window prints is the
string the cast accepts, end to end through `libraryCitationForEntity`. Whether
a real German module now fills `"book"` with `Pathfinder Monster Core` rather
than «Monsterkern» is the owner's to observe in a live run. (b) **The title read
is exercised against fake-indexeddb**, so "the library records no title" is
simulated by deleting a book row rather than by a real workspace whose pack was
uninstalled — the reachable state is the same one the citation's content-hash
fallback exists for. (c) **The MEASURED cost uses the owner's real pack TITLES
and his documented pack COUNTS (docs/16 §4) but not his actual creature names**:
the growth is name-length-independent (a title is appended to whatever the name
was), so the per-line figure is exact while the corpus it is summed over is the
documented one. (d) **The legend shape's cost is arithmetic, not a measurement**
of the built alternative — it is reported as a proposal, not landed.

### A rule that only holds in English is not a rule (docs/17 row 162, docs/00 §Global conventions, docs/18 §2.1)
The owner authors modules in German on purpose — *"Honestly i think its good that
i do german modules, otherwise some bugs would just not be found. This should
really work in any language."* — and the defect class he hit is the one where
English input hides the bug BY CONSTRUCTION. Two of this slice's three defects
were of exactly that shape, and neither had ever been pinned:
1. `src/lib/markdown.ts`'s emphasis rule was `/(?<![\w])\*([^*\n]+)\*(?![\w])/g`.
   `\w` is ASCII-only in JavaScript, so the rule asked "is the neighbouring
   character a LATIN-ASCII letter" where the author of the text meant "is it a
   LETTER". A literal asterisk after a word ending in `ß` or an accented letter
   was therefore read as an emphasis DELIMITER and the pair was eaten out of the
   text: `Ein Gruß* aus Wien, und ein Spaß* für alle.` printed without its two
   asterisks, `René* und André* sind da.` printed `René und André sind da.`,
   while the English line of the same shape kept both markers all along. The
   same function's fence rule (`^```[a-z]*`) leaked the info string of a fence
   written any other way (`\`\`\`JS` printed the text `JS` to a reader).
2. Nothing in the app compared two names in Unicode CANONICAL form. `Müller`
   typed on a Mac is `u` + U+0308 (NFD); written by a model or a Windows editor
   it is U+00FC (NFC). They are the same NAME in Unicode's equivalence relation
   and different STRINGS, so every `===` on names — the wiki resolver, the alias
   pool, the creature cast — silently failed for one of the two authors: a
   phantom chip, a duplicated alias, a refused creature.
The fix is ONE primitive and no new mechanism. `domain/artifactAlias.comparableName`
is now THE comparable form of any user-visible name (`normalize('NFC')` — canonical
equivalence, NOT diacritic folding — plus `trim()` plus `toLowerCase()`);
`sameAliasName` and `creatureName.sameCreatureName` are built on it, and
`lib/wikilinks.ts`'s THIRTEEN hand-rolled `toLowerCase` comparisons are seam calls
now (resolution equality, the token-dedupe key, and the three substring readers,
which normalize BOTH sides — a one-sided normalization would have turned a
resolution into an empty brief context, silently). The markdown seam's emphasis
rule is `/(?<![\p{L}\p{N}_])\*([^*\n]+)\*(?![\p{L}\p{N}_])/gu`: `\w`'s
Unicode spelling, which picks out exactly the same characters on ASCII input.
### One creature identity, one portrait reading (docs/17 row 165, docs/11 §D5 second revision, docs/18 §2/§4)
The owner reported a mob with **no portrait on the battle map** although the same
mob shows its portrait on the module surface — a module-level creature with core
stats and a library portrait, "a named zombie" — and, separately, that the
module generator's *generate encounter mob images* setting was on while the
"generate everything" affordance was **absent** even though mobs miss images.
**The dispatched hypothesis was tested first and falsified for his shape.** The
brief suspected one of `db/battleSeed`'s three identity arms minting a key the
portrait row does not sit under. A probe over the real app answers the same
string on both sides — `token.creatureKey` and the key the campaign's
presentation row is under are both `chunk:<the cited chunk>` — so no arm
explains him.
**The proven cause: the battle board never asked the portrait question at all.**
`features/play/battle/BattleSurface.TokenView` drew its art from
`artifactById.get(token.artifactId)?.coverImageId` — the token's ARTIFACT — and
the creature tier (docs/17 row 106) leaves a cited creature with **no artifact**:
its `artifactId` is the synthetic seed-row id that names nothing (pinned, in
prose, by `tests/features/battle-token-portrait.test.tsx` while its own docblock
claimed the board resolves the portrait "through `creatureCoverImageId`" — the
intent was recorded and never implemented). So the three symptoms are ONE defect:
the board asked the ARTIFACT question while the batch, the module gap detector,
the battle card and the seeder all ask the IDENTITY question — the batch and the
detector correctly reported the creature as imaged (nothing enqueued, no
"Generate everything"), and the board drew initials.
**Two key divergences were real too**, and the collapse closes them: a citation
the library HEALED by its content hash seeded `chunk:<the resolved row>` while
the batch's router named `chunk:<the cited uuid>`, and a `creatureRef` carrying
only a content hash seeded `chunk:<the resolved row>` while the router named
`content:<the cast row's name>` (both measured, both now pinned).

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| The German emphasis defect, with the English line of the same shape as the differential that shows the old rule was English-only | `lib/unicodeTextHygiene.test` (`keeps a literal * after a word-final ß …`) | ✅ REVERT-PROVEN (injection a) |
| The same for a word-final accented letter (`René*`) | `lib/unicodeTextHygiene.test` (`keeps a literal * after a word-final accented letter too`) | ✅ REVERT-PROVEN (injection a) |
| A real emphasis pair written in German is STILL stripped (the fix is not a disable) | `lib/unicodeTextHygiene.test` (`still strips a real emphasis pair written in German`) | ✅ |
| **The fix cannot change English behaviour** — a bounded-exhaustive differential (alphabet `['a',' ','*','1','_']`, 3 905 strings up to length 5) plus ordinary English documents, against a verbatim copy of the pre-slice function | `lib/unicodeTextHygiene.test` (`is byte-identical to its pre-slice self on ASCII input`) | ✅ (green before and after — the claim is equivalence, not change) |
| The ONE deliberate English-behaviour change of the slice, named rather than hidden: a fence info string is stripped however it is spelled (`\`\`\`JS` → `x`, was `JS\nx`) | `lib/unicodeTextHygiene.test` (`strips a code fence info string however it is spelled`) | ✅ REVERT-PROVEN (injection a) |
| A German sentence with umlauts, `ß` and `« »` survives the markdown→plain-text stripper byte for byte, and a token renders its German display | `lib/unicodeTextHygiene.test` (`(a) survives …`) | ✅ |
| Non-ASCII names and displays survive the wiki-token parse (`[[Müller\|der Müller]]`, `[[Straße]]`) | `lib/unicodeTextHygiene.test` (`(b) survives the wiki-token parse …`) | ✅ |
| **NFC vs NFD: a DECOMPOSED token resolves against a COMPOSED artifact, and the reverse** — the Mac-authored case | `lib/unicodeTextHygiene.test` (`(c) resolves a DECOMPOSED token …`), `domain/artifactAlias.test` (`treats the same name in NFC and NFD as the same name, and nothing more`), `domain/creatureName.test` (the renamed strictness pin) | ✅ REVERT-PROVEN (injection b) |
| The two compositions are ONE name wherever a name is a KEY — the alias merge refuses a name that is the artifact's own name in the other composition, and the counting/context readers agree with resolution in both directions | `lib/unicodeTextHygiene.test` (`(d) treats the two compositions as ONE name …`), `domain/artifactAlias.test` (`returns the SAME list (same reference) …`) | ✅ REVERT-PROVEN (injection b) |
| **EXACTLY ONE comparable form** (AGENTS §Centralization 2): the resolver routes through the seam, counted (`sameAliasName(` ×4, `comparableName(` ×9), and it keeps neither the hand-rolled comparison nor a hand-appended pool | `features/alias-merge-seam.test` (`routes the alias write in lib/wikilinks.ts through the seam`) | ✅ |
| **EXACTLY ONE ASCII-only text regex population**: every line in `src/` holding `\w`/`\b`/`[a-z]`/`[A-Z]`/`[0-9]`/`charCodeAt`/`fromCharCode`/`toLocaleLowerCase` (comments skipped) must be one of 17 declared files / 35 declared lines, each with a reason; the map cannot rot and neither can the reasons | `lib/unicodeTextHygiene.test` (`declares exactly the ASCII-only text regexes that exist, and no more`) | ✅ |
| The locale-aware case fold is absent from `src/` code — the hazard, not the improvement (Turkish `I` → `ı`) | `lib/unicodeTextHygiene.test` (`never folds case with the locale …`) | ✅ (zero-tolerance: no declared site) |
**Pin table**
| Pin | File | What it would catch |
| --- | --- | --- |
| `keeps a literal * after a word-final ß …` | `tests/lib/unicodeTextHygiene.test.ts` | the ASCII-only emphasis rule coming back; **the pin that was watched RED before the fix** |
| `is byte-identical to its pre-slice self on ASCII input` | same | any loosening of the Unicode class beyond `\w` (a fix that changed English rendering would pass the German pins and fail here) |
| `declares exactly the ASCII-only text regexes that exist, and no more` | same | a NINTH ASCII-only text regex being born anywhere in `src/`; a declared site disappearing (rot); a reason without a site or a site without a reason |
| `never folds case with the locale …` | same | `toLocaleLowerCase` used for matching (a name that resolves on one machine only) |
| `(c)` / `(d)` / the two domain pins | `tests/lib/unicodeTextHygiene.test.ts`, `tests/domain/artifactAlias.test.ts`, `tests/domain/creatureName.test.ts` | the comparable form losing `normalize('NFC')` (injection b reds all five) |
| `routes the alias write in lib/wikilinks.ts through the seam` | `tests/features/alias-merge-seam.test.ts` | the resolver re-inlining one of its thirteen comparisons (behaviour stays green — this is the only pin that can see it) |
**REVERT-PROVEN lines** (each injection applied to the exact executing line,
`git diff --stat` printed back BEFORE its run, restored from an OUT-OF-TREE copy —
`/tmp/lang-backup`, never `git checkout --` — and proved with `git hash-object`
identical before and after: `src/lib/markdown.ts`
`e4139409a5ad6bf880e363759c19d6248421e5c3`, `src/domain/artifactAlias.ts`
`df2c63e2489e742178e302f5f8fc269297a9a8bd`; raw logs in `/tmp/lang-logs/`):
| injection (one file at a time, `CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) the pre-fix file restored** (the ASCII `\w` emphasis rule and the `[a-z]` fence tag back in `src/lib/markdown.ts`) | **RED 4 / GREEN 7 (11)**: `expected 'Ein Gruß aus Wien, und ein Spaß für alle.' to be 'Ein Gruß* aus Wien, und ein Spaß* für alle.'`, `expected 'René und André sind da.' to be 'René* und André* sind da.'`, `expected 'JS\nx' to be 'x'`, and the source scan (the seam no longer holds the Unicode pattern). This run was also the pin's FIRST-EVER run — the fix was written while two foreign suites held the box, so the pin was watched RED against the pre-fix bytes |
| **(b) the comparable form bypassed** (`comparableName` returns `name.trim().toLowerCase()`, no `normalize('NFC')`) | **RED 5 / GREEN 36 (41)** across the three touched files, every red an NFC/NFD pin: `(c) resolves a DECOMPOSED token …`, `(d) treats the two compositions as ONE name …` (`expected [ 'Siegel der Müller' ] to be []`), `treats the same name in NFC and NFD …`, `returns the SAME list (same reference) …` (`expected [ 'The Alchemist', 'Müller' ] to be [ 'The Alchemist' ]`), `matches on canonical composition, trim + case-fold only …` |
**TWO OF THE SLICE'S OWN PINS WERE WRONG ON THEIR FIRST RUN, and the RED
injection is what caught them** (recorded because a pin that cannot fail is
worse than no pin): the ß pin's first sentence put the `*` after `Siegel`, a word
ending in an ASCII letter, so it PASSED on the pre-fix code and proved nothing;
and the locale pin read RAW file text, so it went red on the seam's own doc
comment explaining why `toLocaleLowerCase` is forbidden. Both are fixed, and the
second cost an assertion in the scan as well (`expect(seam).not.toContain('(?<!\w)')`
→ `expect(asciiShapeLines(seam)).toEqual([])`, because the seam's comment NAMES
the rule it replaced) — the same comment-vs-code distinction the scan declares.
**NUMBERS** (bounded gate, `CAMPAIGNER_TEST_WORKERS=1`, raw log kept):
The baseline is the one the brief states, **326 files / 3838 tests at
`6f31f7e`**, and it was RE-DERIVED rather than inherited: the only diff between
that commit and this slice's base `5c9c8fd` is `AGENTS.md` (30 added lines;
`git diff --name-status 6f31f7e..HEAD` names no test and no source file), so the
suite is unchanged between them. The delta this slice adds is measured from the
test DECLARATIONS in the touched files, which is what it is: `+11` the new file,
`+1` `tests/domain/artifactAlias.test.ts` (7→8), `+1` the `FOLDED` entry in
`tests/features/alias-merge-seam.test.ts` (8→9), `0` in
`tests/domain/creatureName.test.ts` (13→13, a renamed pin with two assertions
added) — **+1 file / +13 tests** — with no existing assertion weakened, no test
skipped and no `Errors:` line.
**NUMBERS — the landing gate, `./scripts/gate.sh` (locked, chunked, watchdog;
logs `/tmp/lang-logs/gate-landing2/`), on the REBASED tree and printed **GATE
GREEN, exit 0**.** Per chunk, exactly as the script printed them (the chunks are
DISJOINT since `5de1c36` and the script proves it: `chunk arithmetic: 328 of 328
test files covered`): `tests_lib 32 files / 368 tests (peak 836 MB)`;
`tests_llm 70 / 1146 (872 MB)`; `tests_db 30 / 351 (659 MB)`;
`tests_domain 21 / 291 (667 MB)`; `tests_features 133 / 1308 (1203 MB)`;
`tests_remainder 42 / 411 (1156 MB)` — summing to **328 files / 3875 tests**,
with `lint errors: 0`, typecheck clean, no `Errors:` line in any chunk log, and
**peak RSS of any single chunk 1203 MB against the 3000 MB cap** — the number
that answers the owner's 4 GB directive ("you are not the only worker here").
**The arithmetic, closed in both directions against the baseline the brief
states — 326 files / 3838 tests at `6f31f7e`, RE-DERIVED and CONFIRMED.**
`git diff --name-status 6f31f7e..HEAD` names only `AGENTS.md`, so the suite is
unchanged between that commit and this slice's base. Files: `326 + 1 (row 161's
new test file) + 0 (row 163 added none) + 1 (this slice) = 328` ✓. Tests: `3838
+ 14 (row 161's) + 10 (row 163's, its own section below) + 13 (this slice's) =
3875` ✓. **This slice is +1 file / +13 tests** (`+11` the new file, `+1`
`tests/domain/artifactAlias.test.ts` 7→8, `+1` the `FOLDED` entry in
`tests/features/alias-merge-seam.test.ts` 8→9, `0` in
`tests/domain/creatureName.test.ts` — one pin RENAMED with two assertions added,
nothing weakened, no test skipped).
**Two docs conflicts, both resolved as mechanical UNIONs, both proved.**
`main` moved three times while this slice was in flight (row 161 `e2b9e64`, row
163 `dcf1332`, and the two gate-script fixes `46cdd41`/`5de1c36`), so `docs/08`
and `docs/18` conflicted. Each resolution took the OTHER landings' text
byte-for-byte and re-inserted this row's own text beside it:
`git diff --name-only e2b9e64 c88eaf9` and `git diff --name-only dcf1332 HEAD`
name only `docs/08`, `docs/17` and `docs/18` — **no `src/` or `tests/` file of
another slice, ever**. In `docs/18` the conflict block spanned two adjacent
rows: the "creatures it may name" row is row 163's amendment (taken from theirs)
and the "cast refusal" row was byte-identical on both sides except this row's
addition (taken from ours). The full suite was re-run on the rebased tree
because **the rebased tree is not the tree the previous green run covered**, and
one test really does read a doc at runtime (`docs/18-ARCHITECTURE.md`, from
`tests/features/entity-batch-creature-book.test.ts`) — so a docs edit is not
assumed invisible here, it is re-gated.
**A GATE DEFECT THIS SLICE FOUND AND REPORTED RATHER THAN WORKED AROUND, now
fixed on `main`.** The first landing-gate run came back RED with every single
TEST green: `scripts/gate.sh`'s default chunk list ended in `src`, and this repo
has ZERO test files under `src/` (`find src -name '*.test.ts*' | wc -l` = 0), so
that chunk exited 1 with `No test files found` and set the status for the whole
run — every writer's gate would have read RED for a reason unrelated to their
tree. It was reported instead of bypassed: `src` was dropped from the list
(`46cdd41`), and the first list's OVERLAP was found and fixed too (`5de1c36`,
"the first list ran most of the suite twice" — measured here as the `tests`
chunk reporting all 328 files while the directory chunks reported their own
subsets; the disjoint run above is the one quoted).
**A GATE RUN THAT MEASURED THE WRONG TREE, AND ONE THE KERNEL KILLED — both
VOID, both recorded.** One full-suite invocation of this slice ran WITHOUT its
worktree as the working directory and therefore measured
`/home/box/Harness/Campaigner` — the main tree, mid-flight for another writer's
slice (docs/17 row 161) — returning `327 files / 3852 tests`. `RUN v4.1.11
/home/box/Harness/Campaigner` in its log is the tell, and it is the same class as
AGENTS §Parallel writers item 6 ("a worktree instruction is not self-enforcing").
Another re-run was OOM-KILLED (`oom-kill:…task=node (vitest 3)` in `dmesg`; load
average 22 from CivGlm's playwright + chrome-headless), and a killed run's result
is void, never evidence (AGENTS §Host hygiene 7) — hence the chunked gate above,
which waited for the lock and for the peer suites (measured waits: 240 s, 1420 s,
1880 s, 920 s) rather than taking either.
**WHAT NO TEST HERE CAN PROVE.** Every German sentence in these pins is authored
by us: nothing proves that a real LLM writing German emits the strings the
fixtures do, and the field failure this slice cannot see — a model producing a
name in a composition or a spelling the comparable form does not fold (`ß`
written `ss`, a name in a script with no canonical decomposition) — is beyond any
fixture. The source scan proves a SHAPE is absent from `src/`; it can never prove
a declared site is semantically safe, which is why each one carries a reason a
reader must re-check when the site changes. And the language audit's findings
stay OPEN: the module book's structural labels (24+ English literals in
`lib/modulePdf.ts`), `domain/encounterResolve.TREASURE_LABEL = 'Treasure: '`
composed onto model-written German prose, the blank-row name defaults
(`DEFAULT_ARTIFACT_NAMES`, `defaultModuleTitle()`), and `runEngine`'s
`` `roster entry ${i}` `` battle-token placeholder — all English, none of them
fixed here, because localizing the renderer is an i18n arc of its own rather than
a small change — **and the OWNER HAS RULED ON IT, verbatim: "Not now — leave
the labels English."** The labels are therefore English DELIBERATELY, not by
oversight; a reader who finds one inside a German document should read docs/17
row 162, not open a slice.
### The bestiary cast inherits the comparable form, and the survivor is declared (docs/17 row 166, docs/11 §Module-side cast, docs/18 §2.1)
Row 162 established ONE comparable form for names and folded thirteen
comparisons in `lib/wikilinks.ts`; it also RECORDED, without fixing, the one
hand-rolled comparison left in `src/` — `features/modules/entity-batch.ts`'s
`libraryCitationForEntity`, whose pool filter was
`creature.name.trim().toLowerCase() === wanted.toLowerCase()`. That file belonged
to row 161 in flight, so the gap was written down and lived. It was the same
defect class as row 162's: a hand-rolled `toLowerCase` comparison does NOT fold
Unicode canonical composition, so a DECOMPOSED creature name in a bestiary slot
(`Wächter` typed on a Mac: `a` + U+0308) missed a COMPOSED library name (U+00E4)
— the same string to a reader, different bytes — and the cast refused a creature
the library holds, naming it in the refusal as the nearest creature it holds.
The fix is a fold, not a mechanism: `sameCreatureName(creature.name, wanted)`,
which is `domain/artifactAlias.comparableName` (canonical composition + trim +
case fold). The sweep found **22 hand-rolled NAME comparisons across 11 files**
and folded all of them; the seam's own scan now declares the population so the
next one is born red rather than surviving unlisted. Three of them were folded
WIDER than the comparison, because a partial fold there neutralizes itself — a
comparable-form equality answered through a still-lowercased map key simply
misses the entry and reads as fixed while behaving as before.
**Matrix**
| Surface | Covered by | State |
| --- | --- | --- |
| **A DECOMPOSED slot creature name resolves a COMPOSED library name** — the exact failing case, in the seam that resolves the cast | `features/creature-name-fold.test` (`a DECOMPOSED slot name resolves a COMPOSED library name (THE FAILING CASE)`) | ✅ REVERT-PROVEN (injection a) |
| The reverse: a COMPOSED slot name resolves a DECOMPOSED library name (the bug is symmetric; a one-directional fold would look fixed from one side) | same (`and the reverse: …`) | ✅ REVERT-PROVEN (injection a) |
| The AMBIGUOUS arm resolves across compositions too, and the slot's book still narrows to one candidate | same (`the ambiguous arm resolves across compositions too, and the book still narrows`) | ✅ REVERT-PROVEN (injection a) |
| Trimming is part of the comparable form (a padded slot name resolves) | same (`trimming is part of the comparable form …`) | ✅ REVERT-PROVEN (injection a) |
| **The exactness boundary: NFC yes, DIACRITIC folding NO** — `Schläger` and `Schlager` stay two names, so the fix cannot be "strip accents" | same (`a DIACRITIC difference is still two names (NFC yes, diacritic folding NO)`) | ✅ REVERT-PROVEN (injection b) |
| The LOOSE normalization is not what resolves: a trailing `(…)` qualifier still refuses (`Zombie (variant)` vs a library holding `Zombie`) | same (`the LOOSE normalization is NOT what this resolves through: a trailing qualifier still refuses`) | ✅ REVERT-PROVEN (injection b) |
| Row 161's exactness pin stays true: a one-edit near miss still refuses | same (`a one-edit near miss still refuses (row 161's exactness pin, unchanged)`) and `features/entity-batch-creature-book.test` | ✅ (green before and after) |
| The new pins are NOT vacuous: the two fixture spellings really are one name in two compositions and only composition differs | same (`the fixtures really are two spellings of one name, and only composition differs`) | ✅ |
| **EXACTLY ONE name comparison population**: every hand-rolled NAME equality in `src/` (comments skipped) is one of the declared `BOUNDARIES`, and the shape still recognises the original spelling of the defect it was written for | `features/alias-merge-seam.test` (`declares every hand-rolled NAME comparison in src/ — the population, not a sample`, `leaves the hand-rolled shapes in exactly the documented boundaries (and nowhere else)`) | ✅ REVERT-PROVEN (injection a) |
| **The folded file is NAMED in the seam's accounting** — `entity-batch.ts` carries `sameCreatureName(` ×1, and eight more folded files carry counted needles, so reverting any single fold reds a count | `features/alias-merge-seam.test` (`routes the alias write in features/modules/entity-batch.ts through the seam`, +7 more) | ✅ REVERT-PROVEN (injections a and b) |
**Pin table**
| Pin | File | What it would catch |
| --- | --- | --- |
| `a DECOMPOSED slot name resolves a COMPOSED library name (THE FAILING CASE)` | `tests/features/creature-name-fold.test.ts` | the bestiary lookup losing canonical composition again — the row-161 refusal naming the creature it refuses; **the pin watched RED against the pre-slice comparison (injection a)** |
| `and the reverse: a COMPOSED slot name resolves a DECOMPOSED library name` | same | a one-sided normalization (folding the library side only), which would pass the pin above |
| `a DIACRITIC difference is still two names (NFC yes, diacritic folding NO)` | same | the comparison being made LOOSER than the seam (NFKD + mark strip) — a silent WRONG CAST, not a refusal (injection b resolves `Schlager` to `Schläger`) |
| `the LOOSE normalization is NOT what this resolves through: a trailing qualifier still refuses` | same | someone routing the lookup through `normalizeCreatureName` (the message-only loose form, which strips `(…)` and hyphens) |
| `the fixtures really are two spellings of one name, and only composition differs` | same | a fixture that quietly became two equal strings (or two DIFFERENT names), which would leave every pin above green and meaningless |
| `declares every hand-rolled NAME comparison in src/ — the population, not a sample` | `tests/features/alias-merge-seam.test.ts` | the shape drifting into matching nothing (a green offenders pin that proves nothing) or matching something else; a NEW hand-rolled name comparison anywhere in `src/`; a declared boundary going stale |
| `routes the alias write in <file> through the seam` — 14 files, each with counted needles | same | reverting ONE fold, which no behavioural pin can see (the two spellings agree on every ASCII input) |
**REVERT-PROVEN lines** (each injection applied to the exact executing line,
`git diff --stat` printed back BEFORE its run, restored from an OUT-OF-TREE copy
(`/tmp/namefold-backup/entity-batch.ts`, never `git checkout --`) and proved with
`git hash-object` identical before and after:
`5cfd2f60c58d38a6ac55c97fe996231474cf8655`; raw logs in `/tmp/namefold-logs/`):
| injection (one file, `CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) the hand-rolled comparison restored** (`creature.name.trim().toLowerCase() === wanted.toLowerCase()` back in `src/features/modules/entity-batch.ts`) | **RED 7 / GREEN 18 (25)**: the four composition pins red, and the failure is the row-161 refusal itself — `Error: bestiary cast: the entity «Der Torwächter» asks to borrow the stats of «Wächter», but this workspace's library holds no creature of that name … — the nearest creatures this library holds: Wächter (Pathfinder Monster Core)`; plus `features/modules/entity-batch.ts: sameCreatureName( call sites: expected +0 to be 1`, the offenders pin (`expected [ 'features/modules/entity-batch.ts' ] to deeply equal []`) and the population pin. This was the new pins' own FIRST red run, so the failing case was watched failing rather than assumed |
| **(b) the comparison made LOOSER than the seam** (`normalizeCreatureName(creature.name) === normalizeCreatureName(wanted)` — NFKD + accent strip, the loose message-only form) | **RED 3 / GREEN 22 (25)**: `a DIACRITIC difference is still two names` reds with `Error: expected a refusal for «Schlager», but it RESOLVED to chunk 73e16cdc-…` and the loose-form pin reds with `expected a refusal for «Zombie (variant)», but it RESOLVED to chunk 8450b37c-…` — a silently WRONG CAST, the defect row 114's contract exists to prevent — plus the count pin. The asymmetry with (a) is the point: (a) reds the composition pins, (b) reds the exactness pins, so neither half of the rule is proved by the other's evidence |
**NUMBERS — the landing gate, `./scripts/gate.sh` (locked, chunked, watchdog;
logs `/tmp/namefold-logs/gate-landing-6/`), printed **GATE GREEN, exit 0**.**
Per chunk, exactly as the script printed them (disjoint chunks, and the script
proves it: `chunk arithmetic: 329 of 329 test files covered`): `tests_lib 32
files / 368 tests (peak 794 MB)`; `tests_llm 70 / 1146 (769 MB)`; `tests_db
30 / 351 (599 MB)`; `tests_domain 21 / 291 (611 MB)`; `tests_features 134 /
1324 (1113 MB)`; `tests_remainder 42 / 411 (1013 MB)` — summing to **329 files
/ 3891 tests**, with `lint errors: 0`, typecheck clean, no `Errors:` line in any
chunk log, and **peak RSS of any single chunk 1113 MB against the 3000 MB cap**.
**The arithmetic, against the baseline the brief states — 328 files / 3875 tests
at `16ae0d3`, RE-DERIVED from that summary rather than inherited.** This slice
adds `+8` (`tests/features/creature-name-fold.test.ts`, NEW) and `+8`
(`tests/features/alias-merge-seam.test.ts` 9 → 17), measured in the gate itself
as `tests_features` moving from row 162's `133 / 1308` to `134 / 1324`:
**+1 file / +16 tests**, with no existing assertion weakened, no test skipped and
no `Errors:` line.
**THE GATE WAITED SIX TIMES AND REAPED NOTHING, which is the rule rather than a
detail.** Attempts 1–5 exited 9: once because `CivGlm` (the owner's other DSH
project) was running Playwright on this box, and four times because the `mkdir`
lock was held — by `PID 3412213`, whose owner file names
`/home/box/Harness/Campaigner`, i.e. the SATURATING writer of docs/17 row 165
gating in the MAIN tree, not this worktree. A foreign suite is waited for and
never reaped (AGENTS §Host hygiene 7); attempt 6 took the lock and ran the whole
gate under the 3000 MB cap with availability never below ~10.7 GB.
**ONE EDIT AFTER THE GATE, and why it cannot invalidate it.** A double space in
the docs/18 paragraph this slice amends was fixed after the gate summary above
was captured. Exactly ONE test in the suite reads a doc at runtime
(`tests/features/entity-batch-creature-book.test.ts` reads
`docs/18-ARCHITECTURE.md` and asserts it names
`entity-batch.libraryCitationForEntity`), and that file was re-run under the
lock after the edit (`./scripts/gate.sh
tests/features/entity-batch-creature-book.test.ts`, logs
`/tmp/namefold-logs/gate-doccheck/`). This section's own prose in `docs/08` is
read by no test at all. The rule row 162 established still holds: a docs edit is
not assumed invisible here, it is re-gated.
**WHAT NO TEST HERE CAN PROVE.** That a real Mac-authored module produces these
bytes: every name in these pins is a string WE composed, from the same in-memory
text, and a genuine NFD name arrives from a file an author typed on his own
machine — no fixture can be that. What IS measured is the only thing that can
be: that a name differing ONLY by Unicode composition resolves instead of
refusing. If the fold regressed, the owner would see row 161's refusal sentence
naming a creature his library plainly holds, from a module whose own text spells
the name correctly on screen. The source scan is textual and comment-blind by
construction (comment lines are skipped, deliberately: the seam's own doc
comments NAME the forbidden spelling); a comparison built through an
intermediate variable is invisible to it; and the KEY-INDEX spelling
(`const key = name.trim().toLowerCase()` used as an index key — ~40 sites across
15 files) stays OPEN by decision, named in docs/18 §2.1 rather than folded here,
because those keys are not all name identities and one of them is a persisted
portrait identity (`domain/creature.contentCreatureKey`). `db/mobPortraitCache.ts`'s
`isCanonicalCitation` is declared in the scan as a SURVIVOR, not a boundary: it
is the portrait path docs/17 row 165 owns, in flight in another worktree, and
folding it here would race that landing.
| **DIFFERENTIAL: for the same creature, the portrait the module side resolves equals the portrait the battle token renders** — the pin that would have caught the owner's case (a "the token has a portrait" pin could not: the creature WAS imaged) | `features/creature-portrait-agreement.test` (`the owner's case: a module-level creature with core stats and a library portrait`) | ✅ |
| A cast creature whose portrait is the campaign presentation row renders it (the `npc-ref` shape) | `features/creature-portrait-agreement.test` (`a cast creature whose portrait is the campaign presentation row renders it too (npc-ref)`) | ✅ |
| A cast creature whose OWN cover carries the portrait still renders that cover — what its module card renders (unchanged path, pinned against regression) | `features/creature-portrait-agreement.test` (`a cast creature whose OWN cover carries the portrait renders that cover`) | ✅ |
| An invented mob renders the campaign portrait keyed on its own content identity | `features/creature-portrait-agreement.test` (`an invented mob renders the portrait keyed on its own content`) | ✅ |
| **The affordance and the board state the same fact, BOTH directions**: no portrait ⇒ the board shows initials AND the module-side deviation counts the encounter; the portrait lands ⇒ the token renders it AND the count returns to empty | `features/creature-portrait-agreement.test` (`a missing portrait is WORK and the board shows initials; the batch then fills both`) | ✅ |
| Every roster shape (rulebook, invented, `none`, cast `npc-ref`, hand-authored `npc-ref`) seeds exactly the key the portrait route names | `db/creature-identity-one-rule.test` (`a library citation, an invented mob, a cast creature and an authored npc agree`) | ✅ |
| The statless arm and the statful arm key the SAME citation identically (the arm that used to disagree) | `db/creature-identity-one-rule.test` (`a statless row carries the SAME key as the statful row of the same citation`) | ✅ |
| A healed citation keys on the citation the roster row names — the key the batch writes the portrait under | `db/creature-identity-one-rule.test` (`a HEALED citation keys on the citation the roster row names — the same key the batch writes under`) | ✅ |
| A `creatureRef` with only a content hash keys on its own row, on both sides | `db/creature-identity-one-rule.test` (`a cast creature whose citation carries only a content hash keys on its own row, both sides`) | ✅ |
| **"EXACTLY ONE": no creature key is constructed outside the identity seam** — a source scan over `src/db/battleSeed.ts` and `features/campaign/mob-portrait-participants.ts` (the two files that used to spell their own rules) | `db/creature-identity-spelling.test` (`the LIVE roster-side spelling is ONE seam, and no key is born outside it`) | ✅ |
| The retired dead reader is gone with it (`documentCoverImageId`, no caller left once the reading returns the row's `imageId`) | `db/creature-identity-spelling.test` (`the presentation-row table lost its dead reader with the same commit`) | ✅ |
| The battle card's Generate-vs-Regenerate state reads the SAME resolution the token renders (a cast row with its own cover no longer offers "Generate" for art the queue would decline) | `features/battle-token-portrait.test` (both action pins, re-run unchanged) | ✅ |
**Pins, by name** (9 new: 4 in `tests/db/creature-identity-one-rule.test.ts`,
5 in `tests/features/creature-portrait-agreement.test.tsx`; 2 re-based in
`tests/db/creature-identity-spelling.test.ts` — its three-arm source pin replaced
by the ONE-seam scan, plus the dead-reader pin; NO pin deleted, none weakened,
none skipped):
1. `the owner's case: a module-level creature with core stats and a library portrait`
2. `a cast creature whose portrait is the campaign presentation row renders it too (npc-ref)`
3. `a cast creature whose OWN cover carries the portrait renders that cover (unchanged path)`
4. `an invented mob renders the portrait keyed on its own content`
5. `a missing portrait is WORK and the board shows initials; the batch then fills both`
6. `a library citation, an invented mob, a cast creature and an authored npc agree`
7. `a statless row carries the SAME key as the statful row of the same citation`
8. `a HEALED citation keys on the citation the roster row names — the same key the batch writes under`
9. `a cast creature whose citation carries only a content hash keys on its own row, both sides`
The rendering pins read the IMAGE ID a surface resolved (`useImageUrl` is mapped
to `url:<imageId>`), not a blob URL: jsdom cannot produce object URLs, and the
defect lived in WHICH id was resolved — the fact under test — rather than in the
plumbing that renders it.
**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run, restored from an OUT-OF-TREE copy —
`/tmp/injection-165/backup/battleSeed.ts` and
`/tmp/injection-165/backup/mob-portrait-participants.ts`, never
`git checkout --` — and proved by `git hash-object` identical before and after:
`04a1b033d80d501a1ebc20ea7395cd289119ed56` and
`55b7ed5b23a6cef732044f6c812af31c04b115d9`; raw logs kept under
`/tmp/injection-165/logs/`):
| injection (one file at a time, `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **(a) ONE arm computes a divergent key** (the seeder's rulebook arm stamps `…-divergent` on the identity it hands its tokens) | **RED 5 failed / 4 passed (9)** across the two pin files: the identity differential (`a library citation, an invented mob, a cast creature and an authored npc agree`), both further arm pins (`a statless row carries the SAME key…`, `a HEALED citation keys on the citation…`) and the two board pins that depend on the key finding the portrait (`the owner's case…`, `a missing portrait is WORK and the board shows initials; the batch then fills both`) |
| **(b) the predicate ignores the identity key** (the module gap detector is handed an EMPTY presentation snapshot) | **RED 5 failed / 25 passed (30)** in `tests/features/creature-portrait-agreement.test.tsx` (4 of its 5) + `tests/features/mob-portrait-module-gaps.test.ts` (the pre-existing `yields no work at all once every participant is imaged (no over-offering)`); `tests/features/generate-everything.test.tsx` stayed GREEN because its fixture carries no presentation row at all. **The asymmetry is the point**: every failure is the PRESENT direction (a portrait exists ⇒ no work) — `the owner's case: …`, `a cast creature whose portrait is the campaign presentation row renders it too (npc-ref)`, `an invented mob renders the portrait keyed on its own content`, the post-fill half of `a missing portrait is WORK and the board shows initials; the batch then fills both`, and the module-level no-over-offer pin — while the MISSING direction keeps reporting work, which is exactly why a pin that only asked "does it offer work?" could not have caught the owner's case |

**NUMBERS** (THE bounded landing gate — `scripts/gate.sh`, the ONE gate since the
owner's 4 GB directive; raw log kept at `/tmp/gate-165-summary.txt`, per-chunk
logs in `/tmp/gate-165/`). Baseline re-derived at this landing's base
`5de1c36`: **327 files / 3862 tests**. The script's own summary, verbatim:

```
GATE GREEN, exit 0
chunk arithmetic: 331 of 331 test files covered
3901 tests passed, 0 failed, no `Errors:` line
peak RSS of any single chunk: 1219MB (cap 3000MB)
```

*(Transcribed by the dispatcher from this landing's recorded verification on
`38c8424` — the writer died before filling this block and the placeholder was
left standing. The arithmetic cross-checks against the next landing: 331 + 1
file / 3901 + 18 tests = the 332 files / 3919 tests measured at `5348293`.)*

**UNPROVEN, stated as such.** (a) **A real module run in the app is the owner's
to check.** The probes exercise the real seeding, the real row reads and the
real surface over fake-indexeddb; what no test here can show is his own German
module on screen. What he should look for: the token on the battle map showing
the same portrait the module surface shows for that mob, and — with a portrait
genuinely missing — the "Generate everything" affordance counting the encounter.
(b) **The healed-citation and chunk-less-`creatureRef` shapes are simulated**
(by deleting the chunk a citation names while keeping its bytes under a fresh
row, and by rewriting a cast row's `creatureRef` to its hash-only form) rather
than produced by a real re-ingest or a real export/import round trip. (c) **The
portrait QUEUE still grounds a healed citation's job on the CITED chunk id**
(`MobPortraitJob.chunkId` comes from the route, which carries the citation), so
such a job fails LOUDLY ("the creature's stat-block chunk no longer exists")
instead of writing a portrait — pre-existing, loud, and out of this row's scope;
named here rather than discovered later. (d) **What the board shows is asserted
as the image ID a surface RESOLVED**, not as rendered pixels: jsdom produces no
object URLs, so the blob plumbing below `useImageUrl` is out of reach — the
defect lived in the resolved id, which is what the pins read.

### The key-index class is classified: eight declared key spaces, not one helper (docs/17 row 167, docs/18 §2.1)

Row 166 folded the last hand-rolled name COMPARISONS and named what it left: the
KEY-INDEX spelling (`const key = name.trim().toLowerCase()` used as a map/set
key), ~40 sites across 15 files, explicitly "its own slice" because the keys are
not all name identities. That slice began with a death: the first writer died
silently with the work UNCOMMITTED, the dispatcher committed the WIP verbatim
(`19a2d35` — 17 files, no tests, no docs, unverified), and this writer continued
from that commit under the recovered-landing rule: nothing in it was true
because it was committed. The audit verdict, in one line each — KEPT: the fold
of 20 sites across 13 files (verified producer/consumer agreement for every
map) and the space declarations in `domain/artifactAlias`'s header; CORRECTED:
`promptStyleRepo.freeCopyName`'s half-fold (set keyed comparable, lookups
`.toLowerCase()` — a legal copy threw a spurious `already exists` clash),
`campaignGrounding`'s fold REVERTED (its values become detection regexes;
folding composition dropped a real spelling), and row 166's own FOLDED counts
left red by the WIP (re-derived 5/7/5 with arithmetic); DISCARDED: the WIP's
placement of `campaignGrounding` inside `WRITTEN_LINK_NAME_KEY`.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **The eight spaces are DECLARED and COUNTED**: `PACK_POOL_NAME_KEY`, `MODULE_NAME_KEY`, `WRITTEN_LINK_NAME_KEY`, `LIBRARY_CREATURE_NAME_KEY`, `IMPORT_IDENTITY_KEY`, `PRINTED_NAME_DEDUPE_KEY`, `PROMPT_STYLE_NAME_KEY`, `CREATURE_CONTENT_IDENTITY_KEY` — each with named consumers, each held by space-specific counted needles (comment-blind; reverting one site reds) | `domain/name-key-spaces.test` (`every declared space still routes its sites through the ONE comparable form, counted`, `the accounting is NON-VACUOUS …`) | ✅ REVERT-PROVEN (injections a and b) |
| **The hand-rolled KEY shape survives only in declared anti-spaces**: a `src/`-wide population scan for `const key = name.trim().toLowerCase()`-class lines (comments skipped), 16 declared files each with a reason, staleness-checked both ways | same (`the hand-rolled KEY spelling survives only in the declared anti-spaces, each with a reason`) | ✅ REVERT-PROVEN (injection b reds the offenders pin) |
| **PACK_POOL**: a DECOMPOSED `sourceName` resolves a COMPOSED roster entry through the REAL level lookup (`rosterNameIndex` → `resolveBriefMonsterLevels`, the answer is the level, not `undefined`) | same (`a DECOMPOSED sourceName resolves a COMPOSED roster entry through the real level lookup`) | ✅ REVERT-PROVEN (injection a) |
| **PACK_POOL exactness**: `Schläger` and `Schlager` stay TWO pool entries (NFC yes, diacritic folding NO — the key form of row 166's rule) | same (`two creatures that differ ONLY by diacritic stay TWO pool entries …`) | ✅ REVERT-PROVEN (injection b) |
| **MODULE**: a room's assignment survives a recomposition of the same roster name; a DIFFERENT name never inherits the room (the remap is identity, not similarity) | same (`a room's assignment survives a recomposition …`, `a DIFFERENT name never inherits the room …`) | ✅ (green before and after; the loose-key failure mode is injection b's) |
| **WRITTEN_LINK**: the composed and decomposed spelling of one written token are ONE phantom node, counted once per occurrence (`buildWikiGraph`: one node `name:wächter`, mention count 2) | same (`the composed and the decomposed spelling of one written token are ONE phantom node …`) | ✅ |
| **LIBRARY_CREATURE**: two rows of the same creature collapse across a DECOMPOSED wanted name (`nearestLibraryCreatures`: two in, one out — the dedupe, not the scoring) | same (`two rows of the same creature collapse across a DECOMPOSED wanted name`) | ✅ |
| **IMPORT_IDENTITY**: a manifest title composed against a decomposed local title is still matched, not missing (`analyzeDependencies` → `version-drift`; a hand-rolled title key would invent a `missing` dependency) | same (`a manifest title composed against a decomposed local title is still matched, not missing`) | ✅ |
| **PRINTED_NAME_DEDUPE**: the missing-refs sentence prints one creature once across compositions (2 entries / 2 encounters, ONE `Wächter`) | same (`the missing-refs sentence prints one creature once across compositions`) | ✅ |
| **ALIAS_FORM (the anti-space, BOTH halves)**: the declared `name.toLowerCase()` spelling is held by a direct revert pin; a COMPOSED prose mention is still detected when the alias is DECOMPOSED (THE FAILING CASE); the decomposed alias detects its own prose; the longest spelling still wins its form | same (`keeps its declared spelling …`, `a COMPOSED prose mention is still detected …`, `and the decomposed alias spelling detects its own prose too …`, `and the longest spelling still wins its form …`) | ✅ REVERT-PROVEN (injection c) |
| **PROMPT_STYLE**: duplicating a style whose composition differs from an existing copy lands on "(copy 2)", not a spurious `already exists` clash — through the REAL Dexie-backed `duplicatePromptStyle` | same (`duplicating a style whose composition differs …`) | ✅ (the clash throw is the watched-RED behaviour of the corrected half-fold) |
| **CREATURE_CONTENT_IDENTITY (the persisted decision, held not flipped)**: composition changes the persisted key; trim and case still fold; `undefined`/`null` stat blocks collapse | same (`composition changes the persisted key (NOT folded — the owner's migration decision) …`) | ✅ (deliberately NOT injected — the pin HOLDS the owner decision; flipping it is a migration) |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `every declared space still routes its sites through the ONE comparable form, counted` | `tests/domain/name-key-spaces.test.ts` | reverting ONE fold of ~20 — invisible to behaviour on ASCII input; also a NEW call appearing in a counted file (a new key-index copy is born red with its path named) |
| `the hand-rolled KEY spelling survives only in the declared anti-spaces, each with a reason` | same | a new hand-rolled KEY anywhere in `src/`; a stale boundary entry that no longer carries the shape (licenses nothing); the scan going blind (shape non-vacuity + tree non-vacuity) |
| `a DECOMPOSED sourceName resolves a COMPOSED roster entry through the real level lookup` | same | a consumer-side revert (injection a: the room reads loud-unverified for no reason) — the row-166 trap in its consumer form |
| `two creatures that differ ONLY by diacritic stay TWO pool entries (NFC yes, diacritic folding NO)` | same | the key being made LOOSER than its space (injection b: `Schläger`/`Schlager` collapse — a silently wrong resolution) |
| `a room's assignment survives a recomposition of the same roster name` / `a DIFFERENT name never inherits the room` | same | one side of the room reconciliation keyed by a hand-rolled fold; a similarity-based remap |
| `the composed and the decomposed spelling of one written token are ONE phantom node, counted once per occurrence` | same | the written-token identity splitting into two to-do entries in the reader's problem list |
| `two rows of the same creature collapse across a DECOMPOSED wanted name` | same | the suggestion dedupe re-splitting by composition (two identical suggestions) |
| `a manifest title composed against a decomposed local title is still matched, not missing` | same | the L1 verdict inventing a `missing` dependency the library actually satisfies |
| `the missing-refs sentence prints one creature once across compositions` | same | the banner printing the same creature twice as if it were two |
| `keeps its declared spelling: the form key case-folds and does NOT composition-fold` | same | someone "completing" the ALIAS_FORM anti-space onto `comparableName` — the exact fold this slice reverted |
| `a COMPOSED prose mention is still detected when the artifact also carries the alias DECOMPOSED` | same | the grounding pick losing a real spelling — detection going blind (`expected [] to deeply equal [ 'Wächter' ]`, watched RED) |
| `duplicating a style whose composition differs from an existing copy lands on "(copy 2)", not a clash` | same | the free-copy lookups drifting back to `.toLowerCase()` — a legal copy throws a spurious clash |
| `composition changes the persisted key (NOT folded — the owner's migration decision), while trim and case still fold` | same | the persisted identity's bytes changing by accident — that is a migration (re-keyed rows, re-stamped tokens), the owner's decision |

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run — non-empty — restored from an
OUT-OF-TREE copy (`/tmp/keys-backup/`, never `git checkout --`) and proved with
`git hash-object` identical before and after; raw logs kept in
`/tmp/keys-logs/`. Two process notes recorded honestly: injection (b)'s FIRST
attempt aborted BEFORE injecting (its uniqueness assert fired — the target
spelling appears twice in the file), so its `git diff --stat` printed empty and
that green run was VOID as injection evidence; it was redone with a unique
anchor. Injection (c)'s first restore reverted this writer's own uncommitted
comment edit (the backup predated it), so (c) was redone from the committed
state):

| injection (one file, `./scripts/gate.sh tests/domain/name-key-spaces.test.ts`) | result |
|---|---|
| **(a) the hand-rolled key restored in the PACK_POOL consumer** (`lookups.rosterChunkByName[monster.sourceName.trim().toLowerCase()]` back in `roomBudget.resolveBriefMonsterLevels`; file hash `bf776416f1aafb3a15b73a0f1c1cf623b5a1c0dc` before/after) | **RED 2 / GREEN 15 (17)**: `a DECOMPOSED sourceName resolves a COMPOSED roster entry through the real level lookup` reds with `expected [ undefined ] to deeply equal [ '2' ]` (the room reads loud-unverified for no reason), and the accounting reds (`llm/roomBudget.ts: rosterChunkByName[comparableName(: expected +0 to be 1`) |
| **(b) the PACK_POOL key made LOOSER than its space** (`entry.name.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase()` in `encounterRoster.rosterNameIndex` — the loose accent-stripping fold; file hash `26b6f9693adb4420fdcfd88b2c95156a70d201d8`) | **RED 4 / GREEN 13 (17)**: the exactness pin reds with `expected 1 to be 2` (the two diacritic creatures collapsed to ONE pool entry), the key itself reds accent-stripped (`expected [ 'wachter' ] to deeply equal [ 'wächter' ]`), plus the accounting count and the offenders pin (the NFKD spelling itself carries the trimmed KEY shape). The asymmetry with (a) is the point: (a) reds the consumer+composition pin, (b) reds the exactness pins |
| **(c) the WIP's ALIAS_FORM fold re-applied** (`const key = comparableName(name);` + the import back in `llm/campaignGrounding.ts`; file hash `06f6a6bb0a05b1b665d18d13b0d08bbbb92741a5`) | **RED 2 / GREEN 16 (18)**: the revert pin reds (`expected … to contain 'const key = name.toLowerCase();'`) AND the behaviour pin reds with `expected [] to deeply equal [ 'Wächter' ]` — grounding detection literally went blind to the composed prose mention. This is the evidence that the WIP's fold here was a defect, not an unfinished one |

**NUMBERS — the landing gate, `./scripts/gate.sh` on the REBASED tree (row 165
landed first; the rebase took its commits with no conflict and this slice's
pins re-verified against the NEW code), printed **GATE GREEN, exit 0**; logs
`/tmp/keys-logs/gate-landing.log` + `/tmp/gate-3624398/`. Per chunk, exactly as
the script printed them: `tests_lib 32 files / 368 tests (peak 813 MB)`;
`tests_llm 70 / 1146 (871 MB)`; `tests_db 31 / 356 (676 MB)`; `tests_domain 22
/ 309 (684 MB)`; `tests_features 135 / 1329 (1240 MB)`; `tests_remainder 42 /
411 (1173 MB)` — summing to **332 files / 3919 tests**, with
`chunk arithmetic: 332 of 332 test files covered`, `lint errors: 0`, typecheck
clean, no `Errors:` line in any chunk log, and **peak RSS of any single chunk
1240 MB against the 3000 MB cap**.

**The arithmetic, against the brief's baseline — 329 files / 3891 tests at
`57def3f`, RE-DERIVED from the chunk numbers row 166 recorded rather than
inherited.** Row 165's landed tests add `+2 files / +10 tests` (`tests_db` 30→31
files, 351→356 tests — its `creature-identity-one-rule` NEW 4 plus the
re-based `creature-identity-spelling` 3→4; `tests_features` 134→135 files,
1324→1329 — its `creature-portrait-agreement` NEW 5), measured against THIS
gate's own chunks. This slice adds `+1 file / +18 tests`
(`tests/domain/name-key-spaces.test.ts`, NEW 18; `tests_domain` 21→22 files,
291→309). **+3 files / +28 tests**, with no existing assertion weakened, no test
skipped and no `Errors:` line.

**One writer-process defect, recorded because it is the kind that misleads a
later reader:** two gate attempts in this slice ran from the MAIN tree by
mistake (the harness's fresh-shell cwd is the session workspace, not the
worktree — every worktree call needs the explicit workdir or an in-command
`cd`). Both were harmless and both are VOID as evidence: one listed this slice's
new file as `(absent)` (it does not exist in the main tree) and one ran two
pre-existing files against MAIN's own code. The gate's lock discipline held in
both; no write occurred; every number quoted above comes from the worktree runs
(`cd /tmp/campaigner-keys` inside the command or the explicit workdir).

### The persisted creature key is folded, and its stored bytes are migrated (docs/17 row 168, docs/18 §2.1)

`contentCreatureKey` minted ``content:${JSON.stringify([name.trim().toLowerCase(), statBlock ?? null])}``
— no Unicode canonical fold — and that STRING is an existing identity: a UNIQUE
`mobPortraits.creatureKey`, a `creatureImages` composite index, and every battle
key (docs/17 row 167 recorded the finding and parked the fix at the owner's
door; the owner ratified it). A Mac-authored (NFD) spelling and a precomposed
(NFC) one therefore minted DIFFERENT keys — two portrait slots for one creature,
and "one creature, one look" (docs/11 D6) broken silently.

The mint now folds the name through `comparableName` (NFC + trim + case-fold —
THE comparable form, no second helper) and **the stored bytes are migrated**:
Dexie version 22 re-keys `mobPortraits` and `creatureImages` rows and every
`creatureKey` inside `battles` rows through `foldCreatureKey`, the ONE
migration/import seam beside the mint. `lib/exportImport` calls the SAME seam,
so a pre-migration export imported post-migration cannot reintroduce legacy
bytes.

**A gap in the brief, found and closed.** The brief named "battle tokens" as the
third carrier. A `battles` row carries the same identity in THREE places —
`board.tokens`, the SAVED STAGE SNAPSHOT's `stage.tokens` (Reset restores them
onto the board) and `seedFighters[].creatureKey` (the spawn path dedupes by it,
`db/battleSeed`). Folding only the board tokens would leave the row disagreeing
with itself and let a legacy spelling seed a duplicate fighter, so all three are
folded in BOTH the migration and the import.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **The persisted identity folds**: composition no longer changes `contentCreatureKey`'s bytes, trim and case still fold, `undefined`/`null` stat blocks collapse | `tests/domain/name-key-spaces.test.ts` (`composition no longer changes the persisted key (docs/17 row 168) …`) | ✅ REVERT-PROVEN (injection a) |
| **The accounting holds the fold**: the `CREATURE_CONTENT_IDENTITY_KEY` needles are `comparableName(name)` and `comparableName(storedName)`, ×1 each, comment-blind | same (`every declared space still routes its sites through the ONE comparable form, counted`) | ✅ REVERT-PROVEN (injection a) |
| **The boundary list is honest**: `domain/creature.ts` left `BOUNDARIES` (its old spelling is gone), and the staleness check now runs over 15 declared files | same (`the hand-rolled KEY spelling survives only in the declared anti-spaces, each with a reason`) | ✅ REVERT-PROVEN (injection a) |
| **The seam folds an EXISTING key**: composed and decomposed mints fold to themselves, it is idempotent, a legacy decomposed key lands on the new mint, an already-NFC legacy key is byte-identical before/after, `chunk:`/`artifact:`/other keys pass unchanged, and a `content:` key that does not parse THROWS | `tests/db/creature-key-fold.test.ts` (5 seam pins) | ✅ REVERT-PROVEN (injection a) |
| **The migration re-keys stored bytes**: a v21 DB seeded with decomposed `mobPortraits`, `creatureImages` and battle keys opens at v22 with each found under the folded key, `chunk:` bytes untouched, the per-population counts reported, and the row still schema-valid | same (`re-keys decomposed rows and battle keys, reports the counts, and leaves chunk: bytes alone`) | ✅ REVERT-PROVEN (injection b) |
| **A duel of compositions merges loud**: the newer `updatedAt` wins (a composed portrait over a decomposed row AND a decomposed presentation row over a composed one, in ONE fixture), the merge is counted and the dropped key + imageId recorded; an equal-`updatedAt` tie goes to the row already under the composed key | same (`keeps the NEWER updatedAt …`, `breaks an updatedAt TIE …`) | ✅ REVERT-PROVEN (injection b) |
| **An unfoldable key fails LOUD**: an unparseable `content:` key rejects the upgrade instead of being silently kept — and the upgrade never runs part-way silently | same (`fails LOUDLY when a content: key cannot be folded — never silently kept`) | ✅ REVERT-PROVEN (injection b: with the fold skipped, no throw fired and the pin red) |
| **A pre-migration export is folded on import**: the presentation row, BOTH token carriers and the seed fighters are re-keyed through the same seam, and no legacy byte survives in the restored campaign | `tests/lib/exportImport.test.ts` (`folds a PRE-MIGRATION export's creature keys onto the comparable form`) | ✅ REVERT-PROVEN (injections c and c2) |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `composition no longer changes the persisted key (docs/17 row 168), while trim and case still fold` | `tests/domain/name-key-spaces.test.ts` | the NFC fold being reverted from the mint — the exact state row 167 held on purpose (injection a) |
| `every declared space still routes its sites through the ONE comparable form, counted` | same | a mint or seam site drifting back to the hand-rolled spelling (`comparableName(name): expected +0 to be 1`, injection a) |
| `the hand-rolled KEY spelling survives only in the declared anti-spaces, each with a reason` | same | `domain/creature.ts` regaining the old shape without a declared reason (injection a: `expected [ 'domain/creature.ts' ] to deeply equal []`) |
| `folds a key minted from composed OR decomposed input to itself` / `is idempotent, and folds a legacy decomposed key onto the new mint` | `tests/db/creature-key-fold.test.ts` | the seam disagreeing with the mint — a migration that would not be a no-op for newly minted rows (injection a) |
| `a content: key minted from an ALREADY-NFC name is byte-identical before and after the fold` | same | a fold that changes bytes it should not — that is what makes the migration a no-op for typical data |
| `returns chunk:, artifact: and every other key space UNCHANGED` | same | the seam rewriting an id key (`chunk:`/`artifact:`) as if it were a name |
| `throws LOUDLY for a content: key it cannot parse — never silently keeps it` | same | a `catch`-and-continue seam leaving corrupt bytes in the index (AGENTS rule 1) |
| `re-keys decomposed rows and battle keys, reports the counts, and leaves chunk: bytes alone` | same | the migration not running, not folding every carrier, or dropping/altering a non-content key (injection b) |
| `keeps the NEWER updatedAt when a creature exists under BOTH compositions, and records the drop` | same | a dual-composition creature silently losing its newer portrait, or the merge going uncounted (injection b) |
| `breaks an updatedAt TIE toward the row already stored under the folded key (deterministic)` | same | non-deterministic tie-breaking (the pre-fold `creatureImages` read used arbitrary UUID order) |
| `fails LOUDLY when a content: key cannot be folded — never silently kept` | same | the upgrade swallowing an unparseable key and leaving legacy bytes behind (injection b) |
| `folds a PRE-MIGRATION export's creature keys onto the comparable form (docs/17 row 168)` | `tests/lib/exportImport.test.ts` | import reintroducing legacy bytes for the presentation row, a token carrier or a seed fighter (injections c and c2) |

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run — non-empty — restored from an
OUT-OF-TREE copy under `/tmp/fold-inject/` (never `git checkout --`) and proved
with `git hash-object` identical before and after; raw logs kept under
`/tmp/fold-inject/`):

| injection | result |
|---|---|
| **(a) the unfolded mint restored** (`const folded = name.trim().toLowerCase();` in `contentCreatureKey`; `git diff --stat` `src/domain/creature.ts 1 +-`; file hash `a32e185a356f18af82579cdf95072cd5ac2417fe` before/after) | **RED 8 / GREEN 60 (68)** over `name-key-spaces` + `creature-key-fold` + `exportImport`: the FLIPPED pin reds (`expected 'content:["wächter",null]' to be 'content:["wächter",null]'`), the accounting reds (`CREATURE_CONTENT_IDENTITY_KEY: domain/creature.ts: comparableName(name): expected +0 to be 1`), the boundary scan reds (`expected [ 'domain/creature.ts' ] to deeply equal []`), and the seam, migration and import pins red |
| **(b) the migration skips the fold** (`groupCreatureRowsByFoldedKey` keys by the raw stored key AND `foldCreatureKeyCarriers` returns the carrier's own key; `git diff --stat` `src/db/db.ts 2 +-`; file hash `a026f437906f8c2ba1c3fd21d81b9a38394f29f6` before/after) | **RED 4 / GREEN 6 (10)** in `tests/db/creature-key-fold.test.ts`: the re-key pin reds (`expected undefined to be defined`), both collision pins red (`expected [ { …(5) }, { …(5) } ] to have a length of 1 but got 2`), and the loud-failure pin reds (`expected null to be an instance of Error` — with the walk no longer folding, the unparseable key was never parsed) |
| **(c) every import fold removed** (the presentation row, both token carriers and the seed fighters pass through verbatim; `git diff --stat` `src/lib/exportImport.ts 4 +-`; file hash `c6987e2359da0b95c4369b6d79cbc53b6ca6a47f` before/after) | **RED 1 / GREEN 39 (40)** in `tests/lib/exportImport.test.ts`: `expected 'content:["wächter",null]' to be 'content:["wächter",null]'` |
| **(c2) ONLY the token and seed-fighter import folds removed** (the presentation-row fold left intact, so the first assertion passes and the failure moves into the battle carriers) | **RED 1 / GREEN 39 (40)** at `tests/lib/exportImport.test.ts:715` — the board-token assertion, proving the token/seed carriers are pinned independently of the presentation row |

**NUMBERS — the landing gate, `bash scripts/gate.sh` on the docs-complete tree,
printed GATE GREEN, exit 0; raw log `/tmp/fold-gate.log` + per-chunk logs
`/tmp/gate-3814309/`.** Per chunk, exactly as the script printed them:
`tests_lib 32 files / 369 tests (peak 838 MB)`; `tests_llm 70 / 1146 (876 MB)`;
`tests_db 32 / 366 (666 MB)`; `tests_domain 22 / 309 (702 MB)`; `tests_features
135 / 1329 (1245 MB)`; `tests_remainder 42 / 411 (1174 MB)` — summing to **333
files / 3930 tests**, with `chunk arithmetic: 333 of 333 test files covered`,
`lint errors: 0`, typecheck clean, no `Errors:` line in any chunk log, and
**peak RSS of any single chunk 1245 MB against the 3000 MB cap**.

**The arithmetic, against the brief's baseline — 332 files / 3919 tests at
`2acec2e`.** This slice adds `+1 file / +10 tests`
(`tests/db/creature-key-fold.test.ts`, NEW) and `+1 test`
(`tests/lib/exportImport.test.ts` 39→40), and moves `tests/db/migration.test.ts`'s
three `db.verno` assertions from 21 to 22 — a NECESSARY consequence of the
version bump, equally exact, not a weakened assertion. No existing assertion was
weakened, no test skipped, no `Errors:` line.

### The planner's toolkit — real content under one loud cap (docs/17 row 169, docs/19 §6)

The document planner (`llm/modulePlan.planModuleDocument`) stays ONE strict
JSON-contract call. Since row 169 that call carries real CONTENT instead of one
line per row: the module's own text through the shared
`domain.moduleDocumentText` reader, the wiki-graph link map through the ONE
`domain.wikiGraph.buildWikiGraph` derivation, and every scoped row's real stored
fields through the CANVAS CHAT's own renderer — the new shared
`canvasChat.renderStoredArtifactSection`, which `resolveRequestDraft` also now
routes through, so ONE implementation of "render a stored row for a prompt"
exists (AGENTS rule 4). A hard character cap
(`MODULE_PLAN_CONTENT_BUDGET_CHARS`) with the chat's own `[TRUNCATED — …]` /
`[BLOCK FULL — …]` markers means nothing is trimmed silently, and a row whose
stored fields are all empty is named, never dropped. **The plan contract, its
validation, its one write (`planAndStoreModuleDocument`) and the PDF renderer
(`lib/modulePdf`) are untouched.**

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **The module's own text reaches the one call**: the built message carries `moduleDocumentText(module)` (premise + every part), not a premise+synopsis digest | `tests/llm/modulePlan.test.ts` (`carries the module’s own text and a row’s real stored prose past the old 160-char excerpt`) | ✅ REVERT-PROVEN (injection a) |
| **A row's REAL stored fields reach the one call**: the full stored prose, past the old 160-char excerpt, under the row's `=== ARTIFACT <id> … ===` heading | same | ✅ REVERT-PROVEN (injection a) |
| **What a document links to comes from the ONE graph seam**: `buildWikiGraph`'s per-document mentions, a resolved name carrying its kind + id, an unresolved name named as having no row | same (`lists what each document links to from the reader’s own wiki graph`) | ✅ |
| **A row that stores nothing is NAMED, not dropped** | same (`names a row whose stored fields are all empty instead of dropping it quietly`) | ✅ |
| **Over budget the block is LOUD**: a `[BLOCK FULL]` marker names the overflowing row and every row after it, and the cap number | same (`warns LOUDLY and names every row the content cap left out`) | ✅ REVERT-PROVEN (injections a and b) |
| **A single over-cap section is `[TRUNCATED]` with its name, and a fitting block carries NO marker** | same (`assembleModulePlanContent — the loud content cap`, 2 pins) | ✅ REVERT-PROVEN (injection b) |
| **Every pre-existing planner/plan pin stays green** (the two `modulePlanMessages` calls gain `await` + the required `pool`; no assertion weakened) | `modulePlan` 14 → 20; `module-pdf-export`, `module-plan-dialog`, `campaign-tree-plan-control`, `scaffoldingEcho`, `canvasChatDetails` | ✅ |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `carries the module’s own text and a row’s real stored prose past the old 160-char excerpt` | `tests/llm/modulePlan.test.ts` | a re-capped one-line excerpt (the old defect) — injection a |
| `lists what each document links to from the reader’s own wiki graph` | same | the link map no longer coming from `buildWikiGraph`, or naming a resolved row without its id |
| `names a row whose stored fields are all empty instead of dropping it quietly` | same | a row silently dropped because `artifactDetailLines` was empty |
| `warns LOUDLY and names every row the content cap left out` | same | a SILENT trim — injection b |
| `marks a single over-cap block TRUNCATED and names what it cut` | same | a first section cut without the `[TRUNCATED]` marker — injection b |
| `adds NO marker when everything fits` | same | a marker added to a block that fits (the marker must mean something) |

**REVERT-PROVEN** (each injection applied to the exact executing line, printed
back with `git diff --stat` BEFORE its run — non-empty — restored from an
OUT-OF-TREE copy `/tmp/plan-inject/modulePlan.ts` (never `git checkout --`) and
proved with `git hash-object` identical before and after; raw logs
`/tmp/plan-logs/`):

| injection | result |
|---|---|
| **(a) the row detail re-capped to a 160-char `oneLine`** (`text: lines.length === 0 ? emptyArtifactLine(artifact) : section,` → `text: oneLine(lines.length === 0 ? emptyArtifactLine(artifact) : section, 160),`; `git diff --stat` printed back non-empty BEFORE the run — the full slice diff, `281 insertions`; file hash `4e4a11650f41dece23fb8280c96977b0fb592f72` identical before and after) | **RED 2 / GREEN 18 (20)**: the content pin reds (`expected 'THE MODULE\nTitle: Beneath the Docks\…' to contain 'The ford is watched from the tower. T…'`, i.e. `THE-FAR-END-OF-THE-ROW` is gone) AND the cap pin reds (a 160-char row fits, so `[BLOCK FULL` never fires). **The new pins' first-ever red run — the failing case was WATCHED failing, not assumed.** |
| **(b) `assembleModulePlanContent`'s markers deleted** (the `if (truncated !== null)` and `if (dropped.length > 0)` blocks removed, so the cap trims silently; `git diff --stat` printed back non-empty BEFORE the run) | **RED 2 / GREEN 18 (20)**: the cap pin reds (`expected … to contain '[BLOCK FULL'`) and the assembler truncation pin reds (`expected '=== HUGE ===\nyyy…' to contain '[TRUNCATED'`). Lint also reports the now-unused marker constants (2 errors) — the injection is not a code shape we would ship, which is the point. |

**NUMBERS — the landing gate, `bash scripts/gate.sh` on the code+tests tree,
printed GATE GREEN, exit 0; raw log `/tmp/plan-gate.log` + per-chunk logs
`/tmp/plan-gate/`.** Per chunk, exactly as the script printed them:
`tests_lib 32 files / 369 tests (peak 825 MB)`; `tests_llm 70 / 1152 (873 MB)`;
`tests_db 32 / 366 (701 MB)`; `tests_domain 22 / 309 (681 MB)`;
`tests_features 135 / 1329 (1247 MB)`; `tests_remainder 42 / 411 (1140 MB)` —
summing to **333 files / 3936 tests**, with `chunk arithmetic: 333 of 333 test
files covered`, `lint errors: 0`, typecheck clean, no `Errors:` line in any
chunk log, and **peak RSS of any single chunk 1247 MB against the 3000 MB cap**.

**The arithmetic, against the brief's baseline — 333 files / 3930 tests at
`df104e3`.** This slice adds **+0 files / +6 tests**
(`tests/llm/modulePlan.test.ts` 14 → 20: four behaviour pins and two assembler
pins). No existing assertion was weakened, no test skipped, no `Errors:` line.

**MEASURED PROMPT COST** (method: the built message's total system+user
characters ÷ 4, labelled rough). The representative fixture (premise + 4 parts
× ~2,000 chars + 4 stored rows) goes from **4,638 chars ≈ 1,160 tokens**
(pre-slice) to **17,690 chars ≈ 4,423 tokens** — **+13,052 chars ≈ +3,263
tokens**. A large fixture (8 parts × ~4,500 chars + 10 rows) measures **51,308
chars ≈ 12,827 tokens** and DOES hit the cap (module text `[TRUNCATED]`, rows
`[BLOCK FULL]`ed) where the pre-slice builder measured 6,231 chars ≈ 1,558
tokens — the old prompt could not grow because every row was a single line. No
existing assertion was weakened, no test skipped, no `Errors:` line.

### The Idea Board is a standalone surface, and its text is never taken from the owner (docs/17 row 173, docs/21, docs/18 §2.1/§2.2/§2.3)

The board is the first surface whose AUTHORED text is not campaign data, so its
pins are about ownership of the text rather than generation outcomes. Four
files, each with one job:

- `tests/features/idea-board.test.tsx` (5) drives the REAL page with the
  CodeMirror editor replaced by a textarea through the same `value`/`onChange`
  contract (jsdom does not render CM6's content the way a browser does, and the
  contract under test is the page's, not the editor's). It pins the two rules
  that protect the owner's words: **typing during a request survives and is what
  gets snapshotted when a suggestion is accepted** (type → send → type again →
  resolve → accept → assert the suggestion landed and `Restore this draft`
  brings back the mid-request text), and **a stopped or failed turn keeps the
  INSTRUCTION while applying nothing** (the user turn is recorded before the
  call; no reply is recorded, no proposal appears). It also pins a failed SAVE
  keeping the draft in place with `Retry saving` clearing the error, and both
  clipboard arms — success and an unavailable clipboard — through the mocked
  seam. Wiki-links are typed and asserted LITERAL (`Original [[literal]]`): the
  board resolves nothing, which is the whole difference from the module canvas.
- `tests/db/ideaBoard.test.ts` (4) is the storage boundary: ONE board across
  concurrent `getIdeaBoard()` calls, a conflicting save refused by name (the
  compare-and-swap), two stored rows REFUSED rather than picked or discarded, an
  invalid write rejected with the stored text intact, and the backup round-trip
  — including a CORRUPTED board failing the restore BEFORE the wipe (the stored
  text survives it) and a pre-v23 zip restoring with an empty board.
- `tests/llm/ideaBoard.test.ts` (6, node project) is the contract boundary. It
  asserts the emitted strict schema is expressible at all (`{kind:'schema',
  name:'idea-board'}` with exactly `reply`/`document` — a `StrictSchemaError`
  would leave the transport uncalled and red the same assertion), that the
  request is grounded on the owner's document and instruction under that
  contract, that an unset board model falls back to `settings.defaultChatModel`
  while an explicit one wins, and the three loud refusals: whitespace-only
  replacement, escape debris (the real `Flussm?fcndung` shape), and a reply that
  is not the contracted JSON.
- `tests/architecture/clipboard-seam.test.ts` (1) is the exactly-one pin: the
  ONLY file under `src/` containing `.writeText(` is `lib/clipboard.ts`, and
  `persona-panel.tsx`'s two folded call sites still call `copyText` — so a third
  hand-rolled clipboard write reds instead of drifting.

### The encounter budget policy — one resolved value, three selectable modes (docs/17 row 180, docs/11 D12 amendment, docs/18 §2)

The owner's request ("make that policy selectable during module creation with
a sensitive default") is pinned at four levels, each with the injectable
failure it catches:

- `tests/domain/encounterBudget.test.ts` (NEW, 5): exactly three policy
  values; `defaultEncounterBudgetPolicy` gives `pathfinder2e` →
  `'pf2e-budget'` and every other system → `'system'`; a recorded value
  resolves verbatim while a legacy/absent/null one reads `'system'`; the row
  round-trips through the repo. **Injected RED:** making the resolver ignore
  the row (always `'system'`) reds the differential pin below, not this one.
- `tests/llm/module-gen-spine-and-styles.test.ts`: `createModuleAndRun` with
  no explicit choice for a pf2e campaign stamps `'pf2e-budget'` on the row, an
  explicit `'verbatim'` wins, and a dnd5e campaign records `'system'` — the
  creation path, not the dialog's local state.
- `tests/llm/encounterRepopulate.test.ts` (the DIFFERENTIAL): the SAME
  repopulation brief against the SAME 4-room layout, owned by a `'verbatim'`
  module vs a `'pf2e-budget'` module, produces DIFFERENT instruction bytes
  (no numbers + "design a concrete monster roster" vs `fill grade is 100%` +
  the existing room names/targetLevels) and a DIFFERENT verdict (one chat call
  accepted with the "not deterministically budget-checked" advisory vs TWO
  calls where the under-strength rooms are repairable and ship the under +
  approximation advisories). A second pin drives the repopulate from the
  module ROW (an explicit `'verbatim'` module stays verbatim on a pf2e
  campaign). **Injected RED, watched:** forcing `resolveEncounterBudgetPolicy`
  to `'system'` fails exactly this test (`budget.prompt` loses `fill grade is
  100%`).
- `tests/llm/encounterCartographer.test.ts` (the amended pin, docs/17 row 180
  keeping its old bytes): the legacy no-module pf2e row still renders NO
  stocking clause (byte-identical to before the policy existed), while the SAME
  brief under a `'pf2e-budget'` module renders the append directive, the fill
  grade numbers and the approximation clause.
- `tests/llm/roomBudget.test.ts`: the pf2e band is Campaigner's own
  `2 × party level`, measurably different from the dnd5e `T + 2`; an
  under-strength complex room is repairable under `'pf2e-budget'` and
  advisory-only under the dnd5e band; a `'verbatim'` budget computes no
  expectation and returns the always-on advisory.
- `tests/llm/structuredPartyLevel.test.ts`: the roster WINDOW and the
  Cartographer's party-level resolver AGREE — a part-mentioned encounter with a
  contradicting `levelHint` orders the bestiary window by the PART level
  (`encounterPartyLevel`), so the two resolvers cannot diverge again.
  **Injected RED, watched:** restoring hint-first order fails this test AND
  the pre-existing part-level pin (2 red of 13).

### The encounter party level is the PART's exact level (docs/17 row 291, docs/18 §2/§5)

The owner's decision — a module part has an EXACT level, and the part an
encounter is mentioned in IS the level the fight is made for — is pinned at
three levels: the archived source scan, the behavioural arms, and the refusal.

| fact pinned | where |
|---|---|
| **The pattern and the midpoint are GONE, and the level has ONE seam**: `parseRosterTargetLevel` absent in any spelling; the `(module.levelMin + module.levelMax) / 2` fallback absent from the four encounter-path files (scoped — `llm/moduleGen`'s bestiary-window midpoint is a different question and is named as deliberately unmoved); `levelHint: z.string()` declared EXACTLY once (the deprecated domain key); NO `data.levelHint` read anywhere in `src/`; `encounterPartyLevel` defined once in `roomBudget` and called only by `runEngine`; `partLevelMentionFor` defined once with the editor form as its only title consumer | `tests/architecture/one-level-resolution.test.ts` (the row-291 arm) |
| **The three sizing callers agree**: the part's exact level drives the generated party line, the per-room stocking numbers, the roster WINDOW's order, AND the room `targetLevel` stamping, while the row's `partyLevel` (5) loses to the mentioning part (3) in every one of them | `tests/llm/structuredPartyLevel.test.ts` (the stamped-room arm + the window/line arms) |
| **The no-part case**: the owner's STRUCTURED `partyLevel` is what sizes the fight and what the model is told; with it unset the run FAILS BY NAME on its own `errorMessage` (a stored `levelHint: '9'` is NOT read) | `tests/llm/structuredPartyLevel.test.ts` (two arms) + `tests/llm/encounterRun.test.ts` (the Smith lane's refusal) |
| **An OLD stored row still loads**: the deprecated `levelHint` round-trips through `encounterDataSchema` with no error state, `partyLevel` stays unset, and the seam resolves NOTHING from it | `tests/llm/structuredPartyLevel.test.ts` |
| **The MODEL stops writing a level**: the reply contract's parse strips both `levelHint` and `partyLevel`, and the strict JSON schema the reply is bound to has no `levelHint` key | `tests/llm/structuredPartyLevel.test.ts` + `tests/llm/strictSchema.test.ts` (the amended key list) |
| **The part is NAMED with its level** (the editor's read-only source) | `tests/llm/structuredPartyLevel.test.ts` (`partLevelMentionFor`) |
| **The create dialog refuses without a number** and the field reaches the run input | `tests/features/persona-run-ui.test.tsx` (the shared `startRun` helper sets `encounter-party-level`; the panel's guard is the loud surface) |

**Defect pins updated deliberately and NAMED** (each asserted the free-text /
pattern / midpoint behaviour and would otherwise have blessed the defect):
`tests/llm/encounter-roster.test.ts`'s `parseRosterTargetLevel` family (the
regex's five parses) → replaced by an absence arm;
`tests/llm/structuredPartyLevel.test.ts`'s "no mention falls back byte-identical
to the levelHint chain" → the owner-set arm plus a refusal arm;
`tests/llm/encounterRepopulate.test.ts`'s "keeps the row's own level …
warns loudly" (the stored-string keep + the level-drift notice) → the structured
row, with the level-drift sentence asserted ABSENT;
`tests/llm/encounterRun.test.ts`'s `levelHint`-variants / midpoint / ascending
trio → the owner-set order arm, a PART-sourced order arm and the loud-refusal
arm; `tests/llm/strictSchema.test.ts`'s draft key list; the two
`tests/fixtures/mobSpells/*` prompt goldens (regenerated for the contract
change). Every other encounter fixture in the tree had its numeric
`levelHint: 'N'` translated to `partyLevel: N` — a mechanical, behaviour-
preserving migration recorded here so it is not mistaken for a semantic change.

### The module difficulty setting — a SIBLING of the budget policy (docs/17 row 190, docs/11 D12 amendment, docs/18 §2)

The owner's request ("a difficulty setting in the module creation dialog, 5
steps, middle = normal, to adjust a module for group strength") is pinned at
five levels plus a source scan, each naming row 190:

- `tests/domain/moduleDifficulty.test.ts` (NEW): exactly five steps with
  `'normal'` the middle one; the label map covers every step; the documented
  ladder is monotone, 1 at the middle and halving/doubling at the ends; the
  resolver reads a recorded value verbatim and a legacy/absent/null row as
  `'normal'`; `createModule` stamps an explicit choice and records `null` when
  none was made; the row round-trips through the repo (no migration).
- `tests/llm/roomBudget.test.ts` — the COMPATIBILITY pin: a legacy row resolves
  normal and `roomBudgetBandUpperFor` returns the pre-change standard number for
  BOTH scales (7 at T=5 dnd5e, 10 pf2e) with `expectedRoomThreat` equal to the
  old value. The DIFFERENTIAL: the five steps produce
  `[3.5, 5.25, 7, 10.5, 14]` (dnd5e) and `[5, 7.5, 10, 15, 20]` (pf2e) through
  the ONE seam, `checkRoomBudget` flips ok/over with the scaled band, and the
  fill-grade expectation scales both ways. The `'verbatim'` pin: no expectation
  and no stocking number exist, and the clause carries a direction with NO digit
  — the multiplier applies only where numbers are computed at all.
- `tests/llm/structuredPartyLevel.test.ts` — the prompt the model actually sees
  (the file's existing `briefPrompt` idiom): a `'much-harder'` module row makes
  the real Cartographer brief carry `MODULE DIFFICULTY`, `Much harder`, the
  scaled `(targetLevel + 2) × 2` and the SCALED stocking numbers (`roughly 8
  creature-levels` where normal says 4.0).
- `tests/features/new-module-draft.test.tsx` — the dialog's existing harness:
  exactly five buttons labelled from the domain map, `Normal` `aria-pressed` by
  default, an untouched control stores NO draft choice, the chosen step reaches
  `createModuleAndRun`'s input (and the real `createModule` stamps the row), and
  the choice survives a close/reopen in the draft.
- `tests/architecture/module-difficulty-seam.test.ts` (NEW, source scan): the
  resolver is DEFINED once and called only through it — ONE run-time budget
  resolver (`RunEngine.runEncounterBudget`, docs/17 row 228 folded the old
  three budget sites onto it) plus (docs/17 row 195) the two UI read sites that
  must show the value they act at (the encounter editor's difficulty control and
  the module restock button's read-only badge); `MODULE_DIFFICULTY_MULTIPLIERS`
  is declared once; `difficultyBudgetMultiplier` is applied only in
  `roomBudget.ts` — a second resolver or a hand-spelled multiplier reds by file
  and count. The same file's second scan (added by row 195) holds the five-step
  rendering to ONE component: only `module-difficulty-control.tsx` may walk
  `MODULE_DIFFICULTIES`, and exactly the dialog and the artifact editor may
  mount it — a copied step renderer reds by file. Row 228's third scan holds the
  ONE level sentence (`adventurers at level`, only `roomBudget.ts`) and the ONE
  difficulty clause (`MODULE DIFFICULTY (`, only `roomBudget.ts`), so a second
  composer reds by file.

**Injected RED, watched (four arms, each file hash printed by `git
hash-object`, no two arms identical):** B the multiplier forced to 1
(`0.5/0.75/1/1.5/2` → all 1) reds pin 3 (the differential ladder and the
verdict flip); C `resolveModuleDifficulty` returning the first step reds pin 2
(the legacy row no longer reads normal and the numbers move); D the dialog's
default step changed to the top step reds pin 4 (the default `aria-pressed` and
the untouched-draft assertion). A baseline is green.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
sizes a room to the stated multiplier (that is judgement, and it remains the
model's); no test proves the ladder feels right at a table (it proves the
numbers and their monotonicity); and no test proves a stored module row gained a
difficulty — there is deliberately no migration, and a legacy row resolving to
normal IS the compatibility the pin asserts.

### Difficulty after creation — the shared control and the module restock sweep (docs/17 row 195, docs/11 D18 amendment, docs/18 §2)

The owner's scope choice ("the difficulty selector beside Repopulate, PLUS a
module-level action that restocks every encounter at the new difficulty") is
pinned at four levels, each naming row 195:

- `tests/features/change-artifact-ui.test.tsx` — the editor's own harness with a
  MODULE-OWNED encounter: the shared control renders beside
  `encounter-repopulate` showing the module's CURRENT difficulty (`Harder`
  pressed); a press writes the REAL Dexie row (`getModule(...).difficulty ===
  'much-harder'`) through `patchModule` — a mocked repo would prove nothing; a
  module with no recorded field reads `Normal` (the compat reading); a
  campaign-level encounter states `encounter-module-difficulty-none` instead of a
  dead control.
- `tests/features/module-restock.test.tsx` (NEW) — the sweep's contract over a
  seeded module, with the repopulate seam mocked (the run-level behaviour is
  pinned in `tests/llm/encounterRepopulate.test.ts`): it visits EVERY
  module-owned encounter and never another module's or a campaign-level one; it
  runs SEQUENTIALLY (a max-concurrency counter must stay 1 — a `Promise.all`
  reds), holds `claimModuleGeneration` for the whole sweep (and releases it),
  reports through the dock (`module-restock:<id>`), CONTINUES past a failure but
  raises `toastErrorPersistent` naming the failed encounter and its reason plus
  the pasteable `[campaigner] module-restock summary` record, ends on a Stop
  epoch bump with the honest "the rest were not touched" and NO failure entry
  (including a cancelled run, which is a stop, not a failure), and says so when
  the module has no encounters. The same file renders `ModuleRestockButton` to
  pin the read-only difficulty badge (a legacy row shows `Normal`) and that a
  press runs the real sweep.
- `tests/features/portrait-queues.test.ts` (the row-196 describe) — the
  INTEGRATION pin for the owner's outcome: the REAL sweep starts a real
  roster-only Cartographer repopulate with a NEW creature identity, and the
  row-196 completion trigger must leave the fresh roster illustrated
  (`planMobPortraitBatch(...).missing === []`, `imaged` non-empty). Reverting
  the row-196 trigger or failing to route the sweep through the existing
  repopulate seam reds it; nothing else in the test enqueues a portrait.
- `tests/architecture/module-difficulty-seam.test.ts` — the "exactly one"
  source scan described in the section above (one five-step renderer, two
  mounts) plus the updated resolver call-site population.

**Injected RED, watched (each changed file's hash printed by `git hash-object`,
no two arms identical):** B the per-encounter sweep call removed → the
count/summary pin reds (nothing restocked, no success toast); C the
difficulty write removed from the editor control → the real-DB pin reds (the
row keeps its old value); D a failing encounter swallowed silently (no
`failed` entry) → the loud-failure pin reds (no persistent toast, no named
record). A baseline is green.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
sizes the restocked fights to the module's difficulty — the engine reads the row
and scales the budget, and the model's obedience is judgement; the sweep's
duration is N sequential LLM runs, so the pins use mocks or a mocked transport
and prove wiring, ordering and reporting, not latency; and a stop is pinned by
the epoch seam, not by clicking a real browser Stop.

### The repopulate level/difficulty INPUT — the prompt states it, the row keeps it (docs/17 row 228, docs/11 D18 amendment, docs/18 §2)

The owner's report ("a level 1 encounter … set it to normal and hit
repopulate … That gave me 2 level 9!! mobs") is OUR defect, not the model's,
and it is pinned at four levels, each naming row 228:

- `tests/llm/encounterRepopulate.test.ts` — pin 1: the SINGLE-room Smith draft
  prompt for a module-owned target must contain `partyLevelLine(1)` and
  `moduleDifficultyGuidanceFor(budget)` VERBATIM, plus `Much harder` and the
  scaled `(targetLevel + 2) × 2` band. Watch RED: removing the two prompt lines
  reds it (arm B) — a re-spelled second sentence also fails the verbatim
  containment.
- the same file — pin 2 (the REPORTED CASE): a level-1 single-room encounter
  WITH a layout (the pre-existing singles fixture carried `layout: null`, so the
  budget check was skipped — the fixture gap the probe named), stored
  `levelHint: '1'`/`difficulty: 'normal'`, repopulated with a reply claiming
  level 9 and fielding two level-9 creatures. The roster still LANDS (the
  warn-and-accept D14 behaviour), the row keeps `levelHint: '1'` and
  `difficulty: 'normal'`, the target-less room is stamped 1, and
  `data.budgetAdvisory` carries BOTH the over-band sentence (`a band of at most
  3 for target level 1`) AND the drift sentence (`the encounter's OWN level is
  kept`). Watch RED: writing the reply's level/difficulty back reds it (arm C).
- the same file — pin 3 (the lane that must NOT move): a FRESH Smith encounter
  run (no target) with a reply claiming `levelHint: '9'`/`difficulty: 'deadly'`
  lands those values on the new row. Watch RED: forcing the fresh-create lane
  through the preserve rule's empty-stored branch blanks them (arm D). The
  existing warn-and-accept pin (`tests/llm/encounterRun.test.ts`, the in-place
  fill reconciliation at `:1970-2080` — a level-10 Ogre accepted against a
  level-5 target with the advisory) stays GREEN, byte-unchanged.
- `tests/architecture/module-difficulty-seam.test.ts` — the resolver call-site
  population updated honestly (`RUN_ENGINE` 3 → 1: `RunEngine.runEncounterBudget`
  folds the Cartographer brief, the roster-only repopulate finalize and the
  in-place fill, and the single-room draft reads it too), plus a NEW composer
  scan: the ONE level sentence (`adventurers at level`) and the ONE difficulty
  clause (`MODULE DIFFICULTY (`) may appear only in `roomBudget.ts`.

**Injected RED, watched (each changed file's hash printed by `git hash-object`,
no two arms identical; a baseline green):** B the two prompt lines removed →
pin 1 reds; C the persisted `levelHint`/`difficulty` taken from the reply again
→ pin 2 reds; D the fresh-create lane forced through the preserve rule's
empty-stored branch → pin 3 reds.

**NOT changed:** the complex branch's behaviour, the budget maths, the
difficulty ladder, the pool ordering/limit, the warning's threshold, or its
warn-and-accept character (D14). A REFUSAL for an over-band single-room roster
is recorded in docs/17 row 228 as a RECOMMENDATION awaiting an owner decision,
because it collides with D14 ("the user is the judge; regenerate is the
correction").

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
obeys the stated level and difficulty (that is judgement and remains the
model's — the cure is the prompt, the advisory is the safety net); no test
proves the level-9 reply is impossible, only that it can no longer arrive
un-stated nor rewrite the row; and no test proves the warning's threshold feels
right at a table.

**Gate** (`bash scripts/gate.sh`, raw log `/tmp/gate-restock-level-228.log`):
**GATE GREEN, exit 0 — 344 files / 4481 tests** (`chunk arithmetic: 344 of 344
test files covered`), lint 0 errors, typecheck clean, combined peak RSS
**2114 MB** of the 3000 MB cap (single-chunk peak 1151 MB), wall 426 s. This
slice adds **+4 tests** (3 in `encounterRepopulate.test.ts`, 1 in the
architecture scan) and no test file.

### The spells arc's structured payload — DATA only (docs/17 row 181, docs/12 §15.4, docs/18 §2.1)

The PF2e rules lane already parsed spell documents as TEXT; this arc adds the
structured `spellData` payload and a `spell` chunk type beside the identical
bytes. The pins, and the injected failure each one catches:

- `tests/ingest/packs/pf2e-rules.test.ts` (extended): the REAL Acid Splash
  fixture through the real adapter asserts EVERY payload field (`rank: 0` —
  the source stores the cantrip at level 1, so the trait normalization is
  explicit; `cantrip: true` from the trait; `traditions`, `traits`, `rarity`,
  all four cast facts, `publication` with its OGL license, the source
  `system.heightening` object deep-equal to the fixture's, and the FOUR fixed
  heightening notes — 3rd/5th/7th/9th — verbatim in document order). Two
  synthetic documents pin the other heightening shapes in the same real lane:
  `<strong>Heightened (+1)</strong>` yields ONE `increment` note, and a
  `Heightened (special)` heading (matched by NONE of the three shapes — the
  third arrived with row 221) lands in `heighteningUnparsed` as the HTML→text
  seam's PLAIN PROSE: HTML-stripped and `@UUID[…]`-free, still LOUD, never a
  silent drop (AMENDED by row 221, which used to store the raw line). The same
  file's
  import pin asserts the four documents land
  `['section','section','spell','section']` with the lane count unchanged,
  that non-spell chunks carry no `spellData` key, and that the feat's
  `entry.spell` is `undefined`. **Injected RED, watched:** dropping the
  traditions mapping (`spellTraditionSchema.array().parse([])`) reds the
  payload pin by name (`expected [] to deeply equal [ 'arcane', 'primal' ]`)
  in both the adapter and the DB query test.
- `tests/ingest/packs/pf2e-rules.test.ts` — the TEXT COMPAT PIN: per-fixture
  sha256 of the emitted text against the bytes MEASURED at the arc base
  (`c07e625`), quoted in the test. The text IS the stored `contentHash`, so a
  moved byte invalidates stored citations; the pre-existing all-lane digest
  pin (`html-to-text.test.ts`) holds the same fact for the whole adapter.
  **Injected RED, watched:** perturbing the summary line reds it.
- `tests/domain/spellData.test.ts` (NEW): the schema round-trip, the
  traditions enum validated against `['arcane','divine','occult','primal']`
  (an unknown tradition THROWS), the optional-list/cast defaults, a missing or
  negative rank refused, and the chunk contract — a pre-arc `section` row
  without `spellData` parses to `undefined` and is NOT a spell, a `spell` row
  round-trips its payload, and the legacy chunk types still parse.
- `tests/db/spellChunks.test.ts` (NEW): a REAL import through the default Dexie
  deps persists a `chunkType: 'spell'` row that the indexed
  `where('chunkType').equals('spell')` list query finds (heading path + payload
  asserted), while the feat stays out of that query; a hand-written pre-arc
  `section` row (through the ONE `putChunks` door) stays readable and is NOT
  in the spell list — the no-migration/no-guessing statement as a test.
- `tests/llm/encounter-roster.test.ts` (extended): a structured `spell` chunk
  in a same-system pack book is SKIPPED by `collectPackRoster` — without that
  arm the roster's "no validated stat block" throw would fail every encounter
  run the moment a rules pack is re-imported. **Injected RED, watched:**
  removing `'spell'` from the skip guard reds this test.
- `tests/ingest/packs/html-to-text.test.ts` (the pre-existing SOURCE SCAN,
  AMENDED not weakened): the scan's exact per-file `htmlToText` call count for
  `pf2e-rules.ts` moves 1 → 2 and the summed total 8 → 9, because
  `parseHeighteningEntries` strips each heightening note's segment with the
  SAME seam — still ONE stripper, used twice. (Row 221 later added a THIRD
  call in that file — the unparsed fallback's per-line strip, taking the file
  to 3 and the total to 12 — which the scan now declares; still ONE seam, and
  a call in any OTHER shape or file would still red it.)

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove an
existing on-disk library gained structured spells — it cannot, because there
is deliberately NO migration; the row stays an honest `section` until the
rules pack is RE-IMPORTED. No test here touches UI (list/filter/chip/detail is
a separate follow-up slice), and no test can prove a dnd5e campaign has spells:
that adapter still skips them, which is a fact the follow-up surface must
state per system rather than render as an empty list.

### The spell list — chips, rank order, the licence line, and the ONE chunk read (docs/17 row 182, docs/05 §Routes, docs/12 §15.4, docs/18 §2.1/§2.3)

The spell UI half of the spells arc: a campaign-scoped page over the `spell`
chunks row 181 landed, with wiki-style chips, a detail card, rank ordering and
a tradition filter. Every pin below was watched RED against a deliberate
injection before it was trusted (the injections are listed with each file).

- `tests/features/spell-rows.test.ts` (NEW — the pure builder, run in the NODE
  project: the file is added to `vite.config.ts`'s `nodeTestGlobs`, or it
  would silently pay the jsdom cost in the wrong project). It pins the rank
  order (`[3, 0-cantrip, 1, 1, 10]` → cantrip first, then rank, then name),
  the loud `data-error` for a `spell` chunk with a null payload (message
  matched, row kept, pinned first), the name-less arm, the non-spell chunk
  being ignored, the origin label, and both label helpers
  (`spellRankLabel` — a cantrip prints `Cantrip`, and `spellHeighteningLabel`
  — `Heightened (3rd)` / `(11th)` / `(22nd)` / `(+1)`, computing no cast rank).
  The tradition filter is pinned as a MULTI-select UNION: an empty selection
  keeps every row, `['primal']` keeps only primal-carrying rows, a second
  selection REPLACES the first, a data error is always visible, and a
  spell of no tradition is kept by no selection — the honest arm, not a
  fallback.
- `tests/features/spells-page.test.tsx` (NEW, jsdom): a real Dexie library
  through the real router. (a) A Pathfinder 2e campaign with a READY dnd5e
  pack book present renders only the PF2e spell — the dnd5e name is absent
  from the DOM, not merely filtered. (b) The rendered chip order is
  `Ignition, Alpha, Zeta` (cantrip first), and the corrupt row renders
  `spell-data-error` with the re-import message while the count says
  `3 spells` + `1 data error`. (c) The tradition checkboxes narrow the list
  (union) and an all-miss selection shows `spells-filter-empty`. (d) Clicking
  a chip opens `spell-detail-card` with the cantrip wording, traditions,
  traits, cast facts, the `Heightened (3rd)` entry and its prose verbatim,
  the unparsed line LOUD, and the `Source: Pathfinder Core Rulebook (OGL)`
  line. (g) The per-system empty states: dnd5e says
  `Spells are not imported for D&D 5e`, and a PF2e campaign with no ready
  rules text says `No spells imported for Pathfinder 2e` with the remedy
  link's href `/rules`.
- `tests/db/chunk-type-read-seam.test.ts` (NEW — a SOURCE SCAN, node): the
  `where('chunkType')` query appears EXACTLY once in `src/`, in
  `chunkRepo.listChunksByType`; the two former sites (`creatureRepo`,
  `use-library-creatures`) are asserted to call the seam. Non-vacuity: the
  walk must see >300 `src/**` files. Comments are stripped before counting
  (the seam's own docstring names the shape it replaces).
- `tests/architecture/one-chip-element.test.ts` (NEW — a SOURCE SCAN, node):
  `CHIP_BASE` and the kind-colour vocabulary each appear in exactly one file
  (`src/components/chip.tsx`); `wiki-markdown.tsx` and `SpellsPage.tsx` both
  import `Chip`; `wiki-markdown` no longer contains the base class.
- Amended pins, each watched RED first: `tests/app-shell.test.tsx` (the
  campaign-tab exact array gains `Spells` at the end — RED as
  `expected [Modules, Workspace, Graph]`, received with `Spells` — plus a new
  `campaignIdFromPath('/c/x/spells') === 'x'` pin, which reds when the route
  is omitted from that function and the campaign bar goes campaign-less);
  `tests/features/quickfind-modules.test.tsx` (the Go-to label list gains
  `Spells` between `Graph` and `Rules`); `tests/search-browser.test.tsx` (the
  Rules type filter now offers `Spells` — the regression row 181 reported).
- **The injections, watched RED and kept in the raw logs:** the combined
  injection removed the `Spells` tab, the Go-to entry, the Rules filter
  entry, the `campaignIdFromPath` line, the book-id intersection, both
  empty-state branches, the `description` prop, the row sort, the
  corrupt-payload arm, the tradition filter, and re-spelled the raw chunk
  query and the chip base class. Every one of the 18 new/changed pins failed
  BY NAME in that run (15 behavioural arms + 3 source-scan arms), which is what
  makes the pins evidence rather than decoration.

**WHAT THESE PINS DO NOT PROVE:** no test can prove a library imported before
row 181 gained `spell` chunks (it did not — re-import the rules pack); the
system scoping is proven for dnd5e and Pathfinder 2e, not for a future system;
the card's description is the stored chunk text, so a test proves the licence
line REACHES the screen, not that a person finds the card readable; and the
next slice (a spell cast at a rank) reads the heightening data this slice only
displays — no cast-rank value is computed or asserted anywhere here.
### The heightening computation — ONE pure rule (docs/17 row 183, docs/12 §15.4, docs/18 §2)

Row 181 captured the heightening DATA; this arc computes with it. The ONE rule
is `domain/spellHeightening.spellAtRank`; these pins, and the injected failure
each catches:

- `tests/domain/spellHeightening.test.ts` (NEW; added to `nodeTestGlobs`): every
  arm on synthetic payloads — `fixed` selecting the HIGHEST listed layer `<=`
  rank (never the lowest) with a layer's `damage` a COMPLETE replacement and
  `area`/`target`/`duration` replaced when stated, an unconsumed layer key
  reported; the cantrip auto ranks for caster levels 1..20 (`ceil(level/2)`,
  clamped to 1..10) with `castRank` ignored loudly; the interval floor with a
  reported `stepRemainder` (a `(+2)` spell 1 rank up gains nothing); the
  per-step area add and its no-base-area warning; the cantrip RULES base rank 1
  (the ignition cell: caster level 5 → TWO steps → `4d4`, never `5d4`); the
  prose-only arm returning the applicable note VERBATIM with the marker and no
  numbers; `heighteningUnparsed` echoed into `unparsed` AND `warnings`; and the
  loud refusals (absent payload, rank below the spell's own, non-integer rank,
  corrupt interval, unknown type, interval deltas with no base damage entry).
  Every assertion pins a FORMULA STRING — never a rolled or evaluated number.
- `tests/domain/spellHeightening.test.ts` — the combiner: same-die counts add
  (`6d6 + 2×2d6` → `10d6`), mixed dice and flats stay separate (`1d6 + 1d4 + 4`),
  dice are ordered by first appearance and the flat total last, zero steps leave
  the base untouched, and an unreadable term (`@item.level`) THROWS instead of
  being guessed.
- `tests/ingest/packs/pf2e-rules-heightening.test.ts` (NEW): the three REAL
  `v14-dev` documents through the real adapter AND the real rule — Acid Splash
  (fixed) at caster levels 1/5/7/9/13/17/20 giving `1d6`/`2d6`/`2d6`/`3d6`/`4d6`/
  `5d6`/`5d6` with the splash track, Fireball (interval, base `6d6`, pinned
  delta `2d6`) at ranks 3/4/5 giving `6d6`/`8d6`/`10d6` with the measured
  `{type:'interval', interval:1, area:0, damage:{'0':'2d6'}}` object deep-equalled,
  and Ignition (cantrip interval, base `2d4`, delta `1d4`) at caster levels
  1/5/9 giving `2d4`/`4d4`/`6d4`. The two new fixtures are the fetched upstream
  documents, byte-for-byte.
- Row 181's pins were AMENDED, not weakened, for the two payload fields the
  computation needs: `tests/ingest/packs/pf2e-rules.test.ts`'s exact payload
  deep-equal now carries the fixture's own `damage` record and `area: null`, and
  `tests/domain/spellData.test.ts`'s round-trip/default pins carry
  `damage: {}`/`area: null`.

**Injected RED, watched (raw gate logs kept):** making `fixed` select the LOWEST
listed layer reds the domain selection pins AND the real Acid Splash cell by
name; reverting the cantrip interval origin to `spell.rank` (0) reds the
ignition cell at `5d4` vs `4d4`; dropping same-die addition in the combiner reds
the `10d6` string. A green gate over a pin nobody broke is not evidence.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove the imported
corpus covers every heightening shape a future pack prints — an unknown shape
THROWS loudly rather than silently falling back to base, which is the honest
failure mode, not coverage. No test can prove the Paizo rules text and the
Foundry reference implementation agree on an edge nobody fetched: the floor rule
is pinned to the reference implementation's OWN expression
(`Math.floor((castRank - this.baseRank) / heightening.interval)`), quoted from
the fetched source, not asserted from memory. No test here renders a chip (the
mob-spells UI is the follow-up slice) and no test can prove a model chooses a
legal rank for the mob. And no test can prove an existing library recomputes
heightening until its rules pack is re-imported — row 181's no-migration
decision still stands.

### The third heightening shape + the readable fallback (docs/17 row 221, docs/12 §15.4, docs/18 §2.1/§2.3)

The owner read raw `<p><strong>Heightened</strong> … @UUID[…]` in the summon
undead spell. The source is legitimate Foundry data; the parser knew only the
two parenthesised headings and the fallback stored the raw line. The pins, and
the injected failure each one catches:

- `tests/fixtures/spells/summon-undead.json` (NEW) is the fetched
  `packs/pf2e/spells/spells/rank-1/summon-undead.json` @ `v14-dev`
  byte-for-byte — sha256
  `ac16988320dfd9e6ea2157d1f9ea89a9dd1c452b537389d6f1f496a0495757f4`, 1,494 B —
  recorded in the test file and ASSERTED there, so a drifted fixture REDS by
  name. Its sibling `rank-1/summon-animal.json`
  (`69245404394b1ee414781cadb1c54678dd08d0a357422b39e541115ed60b82a5`, 1,475 B)
  was fetched only to show the shape is a FAMILY.
- `tests/ingest/packs/pf2e-rules-heightening.test.ts` (extended; **pin 1**):
  the real fixture maps to exactly ONE `{kind:'note', text:'As listed in the
  summon trait.'}` with `heightening: null`, `damage: {}` and
  `heighteningUnparsed: []`, and the note's text contains neither `<` nor
  `@UUID[`. A regex without the optional parenthetical (the pre-slice parser)
  REDS this: the entry is `[]` and the raw line lands in `heighteningUnparsed`.
- `tests/ingest/packs/pf2e-rules.test.ts` (amended; **pin 2**): a synthetic
  `Heightened (special)` line carrying an `@UUID[…]` stores
  `['Heightened (special) As listed in the summon trait.']` — the mention is
  found on the RAW line, the STORED line is the ONE HTML→text seam's prose.
  Reverting the fallback to the raw line REDS it.
- `tests/domain/spellHeightening.test.ts` (extended; **pin 5**): a notes-only
  entry computes NOTHING at cast ranks 3/4/10 — `damage` unchanged,
  `appliedSteps`/`stepRemainder` `null`, `valuesSource: 'base'`,
  `source: 'prose-only'`, `PROSE_ONLY_MARKER` in `warnings`, the note text in
  `notes`. Making a note contribute a step number REDS it (`+0` vs `null`).
- `tests/domain/spellData.test.ts` / `tests/features/spell-rows.test.ts`
  (amended): the schema accepts the three kinds (and still refuses a `note`
  with no `text`), and `spellHeighteningLabel` prints the bare `Heightened` for
  a note while the fixed/increment labels are byte-identical.
- `tests/ingest/packs/html-to-text.test.ts` (amended): the declared call sites
  move `pf2e-rules.ts` 2 → 3 and the summed total 11 → 12 — the fallback's
  per-line strip is the SAME seam, so the "one stripper" claim is restated as
  data rather than relaxed (a fourth call, or a call in any other file, still
  reds).

**Injected RED, watched (raw logs kept; every injected file's `git hash-object`
printed; each arm restored from HEAD under the suite lock):** arm A baseline
GREEN; arm B the bare shape removed from the regex → pin 1 red
(`expected [] to deeply equal [ { kind: 'note', … } ]`); arm C the fallback
left raw → pin 2 red (the raw HTML line is the stored string); arm D a note
made to contribute a step number → pin 5 red (`expected +0 to be null`). No
two arms produced identical output. **PDF caveat (the concurrent row-220
writer):** no PDF/layout dump moved — `pdfLayout`, `modulePdf`, `pdfExport`
and `mob-spells-pdf` pass and `tests/lib/pdfLayoutBaseline.json` is untouched.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** the owner's own imported
pack lives in his browser and is not reachable by a test, and all 1,994
upstream spell documents were not fetched — a heading shape outside the three
is still possible, and its honest outcome is the unchanged LOUD unparsed entry
(now readable). No test proves that every other corpus shape is covered; only
the three known ones are. And an already-imported library keeps its stored
`heighteningUnparsed` bytes until the rules pack is RE-IMPORTED: there is no
migration and no render-time stripper, by design.

### Mob spells on an AI-authored stat block (docs/17 row 184, docs/11 §Mob spells, docs/18 §2.1/§2.2/§2.3)

Row 183 computed the values; this arc puts them on a MOB. The pins are grouped by
the seam they defend, and each names the injected failure it was watched against:

- `tests/domain/mobSpells.test.ts` (NEW; added to `nodeTestGlobs`): the ONE
  resolver over the REAL `v14-dev` Fireball/Ignition payloads — a lowercase
  assignment resolving through `comparableName` (so the pin reds on a hand-rolled
  comparison), NO cast rank meaning the spell's own rank (Fireball at rank 3,
  `6d6`), Fireball at rank 5 = `appliedSteps: 2` and `10d6`, the cantrip
  DIFFERENTIAL at caster levels 5 and 9 (rank 3 / `4d4` and rank 5 / `6d4`, with
  `castRank: null` and `cantripAuto: true` asserted so a caller-side rank cannot
  pass), a level-less cantrip as a loud issue with `result: null` and NO number,
  an invented name as a stored unresolved chip plus the two-half
  `mobSpellIssues` sentence, a prose-only spell returning the note verbatim behind
  `PROSE_ONLY_MARKER` with `valuesSource: 'base'`, the interval remainder and
  `unparsed-heightening` lines surfacing in the detail, the legacy
  `undefined`/`null`/`[]` arms resolving to NO chips, `mobCasterLevel` over
  `"5"`/`"12"`/`"-1"`/`"0"`/`"1/2"`/`"—"`/`"CR 5"`, and the bounded vocabulary
  (cantrips always, ranks filtered to `maxCastableRank`, a deterministic window
  with an honest `total`).
- `tests/llm/mob-spells.test.ts` (NEW; jsdom, because it drives the engine through
  `waitFor` like the other `runEngine` pins): the REAL run path with a mocked
  chat — the statblock prompt carries the section header and `Fireball — Rank 3`
  / `Ignition — Cantrip` (the grounding half), the stored `npc` row carries the
  assignment verbatim, the chip model equals `spellAtRank` at the cast rank, an
  INVENTED name spends the repair turn and then lands as a stored entry with the
  step's raw `spellIssues` AND a `notice` naming the spell and the mob, a second
  reply that names a real spell repairs cleanly with no issues left, and a LEGACY
  block (`spells` absent) stores `undefined` with the rest of the block intact.
- `tests/features/mob-spell-chips.test.tsx` (NEW; jsdom): the rendered chips
  through the real `StatBlockCard` and a real Dexie corpus — the resolved chip's
  `title` carrying `cast at rank 5: 10d6 fire`, the UNRESOLVED chip still showing
  its name and `data-spell-unresolved`, the loud issue box naming spell and mob,
  the cantrip title (`cast at rank 3`, `4d4 fire`), the prose-only title, and the
  legacy/empty block rendering NO `mob-spells` section at all.
- `tests/lib/mob-spells-pdf.test.ts` (NEW; added to `nodeTestGlobs`): the module
  PDF's captured definition contains `cast at rank 5: 10d6 fire` and
  `heightening: interval` through the shared pre-pass, and a direct
  `buildModulePdfDocument` call with no corpus prints the loud `resolved none`
  line — the no-silent-drop arm.
- `tests/architecture/one-spell-chip.test.ts` (NEW; node): the resolved-tone
  literal is declared in `components/spell-chip.tsx` and nowhere else, the chip is
  built on the SHARED `Chip` + `CHIP_UNRESOLVED`, and both the spell list and the
  mob chips import `SpellChip` (the stat block imports `MobSpellChips`).
- AMENDED, not weakened: `tests/architecture/one-chip-element.test.ts`'s
  "both consumers" arm now asserts the spell list reaches `Chip` THROUGH
  `SpellChip` (and still forbids the base class in the page); and
  `tests/llm/module-gen-and-provenance.test.ts`'s one-source list gains the two
  new scaffolding literals (`MOB_SPELL_SECTION_HEADER`,
  `MOB_SPELL_REPAIR_LEAD_IN`), each asserted to be DETECTED on its own.
- `tests/db/spellRepo.test.ts` (NEW; node, `tests/db/**` already in
  `nodeTestGlobs`): the corpus read's OWN scope — a ready PF2E book and a ready
  dnd5e book that BOTH carry `spell` chunks, with `loadSpellChunksFor` required to
  return only its own system's rows (both directions), the not-ready book's chunk
  dropped, and the two derivations (`loadSpellIndexesFor`, `statBlockSystems`)
  covered so a wrong system there cannot leak one layer up. Added because the
  dispatcher's arm D (`readyBookIds(system)` → `readyBookIds()`) changed
  `db/spellRepo.ts`'s bytes and left ALL FIVE other test files green: an unpinned
  seam is prose, not a rule. Injected RED for all three arms: the system
  restriction dropped (2 red), the index built from another system's corpus
  (1 red), `statBlockSystems` collecting nothing (2 red).
- `tests/db/ready-book-seam.test.ts` (NEW; node, `tests/db/**` already in
  `nodeTestGlobs`): the ready-book rule's behaviour — `listReadyRulebooks()`
  returns every ready book in `listRulebooks` order and filters by system, and
  `readyBookIds` equals its ids (a DIFFERENTIAL, not a second filter) — plus a
  SOURCE SCAN on the filter's own predicate (`(book) => book.status === 'ready'`),
  which the two folded component copies spelled verbatim and which a single
  book's status badge (the Rules page) deliberately does not match. Injected RED:
  re-adding the filter to `SpawnPicker` reds the scan by file.
- `vite.config.ts`: `nodeTestGlobs` gains `mobSpells` (domain) and
  `mob-spells-pdf` (lib); the run-path and rendering pins stay jsdom on purpose.

**Injected RED, watched (raw logs kept under the writer's `/tmp` worktree):**
dropping the corpus read's system restriction, building a per-system index from another system's corpus, and emptying `statBlockSystems` each red `tests/db/spellRepo.test.ts`;
re-spelling the ready-book filter in `SpawnPicker` reds the seam scan by file;
returning `[]` from `statblockSpellIssues` (the library check bypassed) reds the
invented-name pin AND the one-repair pin; withholding `casterLevel` from the rule
reds both cantrip pins; `continue`-ing past an unresolved name reds three pins
across two files; forcing the unresolved chip's testid to the resolved one reds
two component pins; ignoring the assignment's cast rank reds six pins across three
files; and removing `spells` from `statBlockSchema` reds six pins. Every arm was
restored byte-identically (diffed against the backups) before the gate.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove a live model
will only name imported spells — it proves the vocabulary was RENDERED, that every
returned name is CHECKED and that an invented one is LOUD; no test can prove the
300-line prompt window contains the spell a given mob should have (the window is
bounded and its truncation is stated in the prompt); no test can prove an
on-disk library holds structured spells at all — row 181's no-migration decision
stands, and until the rules pack is re-imported every assigned name resolves to
nothing and is loud, which is the honest outcome; and no test proves the printed
page reads well to a person — it proves the bytes.

### A library creature's own spells reach the mob chips (docs/17 row 189, docs/12 §5/§9, docs/11 §Mob spells)

Row 184 built the field, the ONE resolver and the ONE chip; this arc makes an
IMPORTED creature CARRY the data, so the renderer needed no change. The pins:

- `tests/fixtures/packs/pf2e/ghost-mage.json` (NEW): the REAL upstream document,
  BYTE-FOR-BYTE — `foundryvtt/pf2e` @ `v14-dev`,
  `packs/pf2e/pathfinder-monster-core/ghost-mage.json`, sha256
  `b1202c2fa6e9e8f1e70073f25b94778f7b01a463ef860876441e106298cc3401` (57,959
  bytes). A level-10 caster with ONE `spellcastingEntry` container, 14 embedded
  `spell` items (5 cantrips) and carried gear. Nothing was invented and nothing
  was trimmed: the real bytes are the fixture. The earlier gap ("no PF2e caster
  fixture exists in the repo") is closed with the upstream document itself.
- `tests/ingest/packs/pf2e-foundry.test.ts` (extended): the REAL fixture's
  `statBlock.spells` is the exact source-order list of all 14 items — names
  verbatim, `castRank` = the source's OWN `location.heightenedLevel ??
  system.level.value` (the upstream `SpellPF2e.rank` expression: "Dispel Magic"
  is `level.value: 2` but heightened to **3**, which the printed stat block
  lists), cantrips with NO cast rank, and the `spellcastingEntry` container
  absent (pin 1); a `baseNpc` and the real `wolf.json` both OMIT the `spells`
  key entirely (no own property), with the rest of the block unchanged (pin 2);
  a synthetic lower-case name at rank 4 and a cantrip at stored level 1 are
  stamped VERBATIM (`{ name: 'arcane-eye', castRank: 4 }`, `{ name:
  'Detect Magic' }`) — a normalize, a rank default or an invention reds it
  (pin 3); a synthetic heightened entry (`level 2` + `heightenedLevel 4`) is
  stamped at 4, a plain entry at its own level, and a cantrip's stored
  heightened field is IGNORED (pin 3b — the correction of the brief's rank
  field, proven against the upstream `SpellPF2e.rank` getter); a
  `spellcastingEntry` container and a carried `consumable` embedding a `spell`
  object are both ignored; and a `spell`-typed item with no level fails the
  creature LOUDLY (a named per-creature failure, not a silent drop).
- `tests/features/mob-spell-chips.test.tsx` (extended): the END-TO-END outcome
  the owner asked for — the REAL `ghost-mage.json` through the REAL bestiary
  adapter, its `statBlock` rendered by the SAME `StatBlockCard` harness as row
  184: a seeded `Blindness` resolves at the item's own rank 3, a seeded
  `Detect Magic` auto-heightens from the mob's level 10 to rank 5 with the
  `cantrip, auto-heightened` note (the importer stamped NO rank, so the rule owns
  it), and an UNSEEDED `Hallucination` renders `spell-chip-unresolved` with the
  loud issue box naming both the spell and «Ghost Mage» (pin 4, no second
  harness).
- `tests/architecture/one-cantrip-signal.test.ts` (NEW; node — the
  `tests/architecture/**` glob is already in `nodeTestGlobs`): the SOURCE SCAN
  that holds the PF2e cantrip signal to exactly ONE site, `spellTraitsAreCantrip`
  in `src/domain/spellData.ts`; it reds a hand-spelled `.includes('cantrip')` in
  either adapter by file and count, and asserts both PF2e lanes import the
  predicate (the fold obligation's pin).
- AMENDED, not weakened: `tests/ingest/packs/html-to-text.test.ts`'s
  `foundry-pf2e` lane digest — the lane now hashes TWO fixtures instead of one
  (no byte of `wolf.json` moved), so `entries` 1 → 2 and the `after` digest is
  the newly measured `da9f9eb3…e94b8f0`, with the row-189 record written beside
  the row-149/170 records.

**Injected RED, watched (raw logs kept under the writer's `/tmp` worktree; every
arm's file hash printed):** removing the spell-item branch reds the real-fixture
pin and the verbatim pin (the `spells` key vanishes); giving a cantrip a
`castRank` reds the real-fixture pin (cantrips are asserted rank-less) and the
verbatim pin; lower-casing a stamped name reds the verbatim pin; reading
`system.level.value` alone, i.e. dropping the `heightenedLevel` arm, reds the
real-fixture pin (Dispel Magic 3 → 2) and the rank-source pin. In the fold,
re-adding a `.includes('cantrip')` outside `domain/spellData.ts` reds the SOURCE
SCAN by file.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove the owner's
on-disk library already carries structured spells — this arc adds NO migration
and NO index, so a pre-arc bestiary book needs a RE-IMPORT (row 181's decision
stands); the fixture is one real caster, so it cannot prove every future pack
shape a caster prints (an unknown/malformed `spell` item fails LOUDLY rather
than being guessed); and no test can prove a person finds the chips readable —
it proves the bytes. **A NAMED, MEASURED GAP:** upstream's `SpellPF2e.rank`
auto-heightens a FOCUS spell too, but a focus item may state no rank at all
(Lawbringer Warpriest, level 5, "Athletic Rush": `level.value: 1`, no
`heightenedLevel`, entry `autoHeightenLevel: null`; upstream rank 3). The
importer correctly stamps only the source's STATED rank and derives nothing, and
`domain/mobSpells.mobSpellChips`'s auto-heightening arm is cantrip-only today,
so a focus chip can print the base rank — the fix belongs in that resolver,
which this brief forbids touching, and it is a follow-up for its own row, not a
claim of this one. **docs/17 row 191 LANDED that follow-up** (the importer
stops claiming a focus rank and `spellAtRank` derives it with its own
`focus-auto` provenance — see the row-191 section below).

### A focus spell auto-heightens (docs/17 row 191, docs/12 §5/§9, docs/11 §Mob spells, docs/18 §2)

Row 189 recorded the measured gap: upstream's `SpellPF2e.rank` auto-heightens a
FOCUS spell exactly like a cantrip and IGNORES its `heightenedLevel`, but the
importer claimed a rank and the rule's auto arm was cantrip-only. This arc
lands the two-layer fix. The pins:

- `tests/fixtures/packs/pf2e/lawbringer-warpriest.json` (NEW): the REAL
  upstream document, BYTE-FOR-BYTE — `foundryvtt/pf2e` @ `v14-dev`,
  `packs/pf2e/pathfinder-monster-core/lawbringer-warpriest.json`, sha256
  `d6daa2f0d5856e2eae767a64626d65dfc6d1fa477c89b4301a6659becca16cd4` (66,187
  bytes). A level-5 caster with TWO `spellcastingEntry` containers (both
  `autoHeightenLevel.value: null`), 12 embedded `spell` items and carried gear;
  "Athletic Rush" is the `focus`-trait item (`level.value: 1`, no
  `heightenedLevel`). Nothing was invented or trimmed.
- `tests/fixtures/spells/athletic-rush.json` (NEW): the focus SPELL document,
  also BYTE-FOR-BYTE — `packs/pf2e/spells/focus/athletic-rush.json`, sha256
  `f672e99b18aff88aabea8b33953a0c0d04c7dfcc8210b0ee4d4194af7637ed18` (1,482
  bytes). BOTH are required: the chip resolves the NAME against this library
  corpus, so an end-to-end pin needs the creature AND the spell.
- `tests/domain/spellHeightening.test.ts` (extended): the FOCUS arm's
  precedence, each arm its own pin — `clamp(ceil(casterLevel / 2), 1, 10)` with
  no fixed rank (level 5 → 3, level 9 → 5, `source: 'focus-auto'`,
  `focusAuto: true`); a fixed `autoHeightenLevel` wins over the ceil rule; an
  explicit `castRank` wins over BOTH; no fixed rank and no usable level is the
  rule's loud refusal; and a `cantrip`+`focus` document still rides the
  CANTRIP arm (`cantrip-auto`, `focusAuto: false`) — row 183's behaviour.
- `tests/domain/mobSpells.test.ts` (extended): the DIFFERENTIAL through the ONE
  resolver — the real `Athletic Rush` at mob level 5 → rank 3 and level 9 →
  rank 5 with the assignment carrying NOTHING but the name, the detail naming
  `heightening: focus-auto` and `(focus spell, auto-heightened)` and NOT
  `cantrip-auto`; a fixed `autoHeightenLevel` (6) wins over level 9; an explicit
  `castRank` (4) wins; a focus spell on a level-less mob resolves but yields
  `result: null` with a `casterLevel`/`focus spell` issue and a
  `mobSpellIssues` sentence naming the mob.
- `tests/ingest/packs/pf2e-foundry.test.ts` (extended): the REAL Lawbringer's
  12 `spell` items in exact source order, "Athletic Rush" rank-LESS and with no
  `autoHeightenLevel` (both entries state null) while the ranked non-focus items
  keep row 189's `heightenedLevel ?? level.value` expression (row 189's real
  Ghost Mage pin stays green — the brief's demanded proof that the ranked
  mapping did not move); a synthetic focus item takes the ITEM's fixed rank (4)
  over the entry's (6); a focus item's stated `heightenedLevel: 9` is IGNORED
  (still no cast rank); and a malformed `spellcastingEntry.autoHeightenLevel`
  fails the creature LOUDLY as a named per-creature failure.
- `tests/features/mob-spell-chips.test.tsx` (extended): the END-TO-END outcome
  through the ONE `MobSpellChips`/`SpellChip` path and the EXISTING row-184
  harness — the REAL Lawbringer through the REAL bestiary adapter, the REAL
  `Athletic Rush` seeded in the library, rendered as a chip whose title is
  `cast at rank 3 (focus spell, auto-heightened)` / `heightening: focus-auto`
  (no second harness, no second fixture set).
- `tests/architecture/one-cantrip-signal.test.ts` (EXTENDED): the SOURCE SCAN
  now holds BOTH trait signals to exactly ONE site each — `.includes('cantrip')`
  and `.includes('focus')` only in `src/domain/spellData.ts`
  (`spellTraitsAreCantrip`, `spellTraitsAreFocus`) — and asserts every consumer
  (both PF2e lanes, `spellHeightening`, `mobSpells`) calls the predicate.
- AMENDED, not weakened: `tests/ingest/packs/html-to-text.test.ts`'s
  `foundry-pf2e` lane digest — the lane now hashes THREE fixtures instead of two
  (no byte of `wolf.json` or `ghost-mage.json` moved), so `entries` 2 → 3 and the
  `after` digest is the newly measured
  `6ab65fdf04c36a3afec384cee29f53b21e7ee3de9ef4ac90a16adbd340eeaee9`, with the
  row-191 record written beside the row-149/170/189 records.
  `foundry-pf2e-rules` is UNCHANGED: the focus spell fixture lives in the
  separate `tests/fixtures/spells/` corpus this block does not enumerate, the
  same reason Fireball/Ignition never moved it (row 183).

**Injected RED, watched (raw logs kept out of tree; every arm's file hash
printed, identical arms labelled VOID):** removing the focus arm from
`spellAtRank` reds the level-5/level-9 differential pins (a focus spell then
throws for a missing `castRank`); reversing the precedence so the ceil rule runs
before `autoHeightenLevel` reds the fixed-rank pins; stamping a cast rank for a
focus item in the importer reds the real Lawbringer pin and the synthetic
`heightenedLevel: 9` pin; reusing `'cantrip-auto'` for the focus provenance reds
the focus-detail pins; re-adding a `.includes('focus')` outside
`domain/spellData.ts` reds the EXTENDED source scan by file.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove the owner's
on-disk bestiary already carries the no-rank focus stamp — this arc adds NO
migration and NO index, so a pre-arc bestiary pack needs a RE-IMPORT (row 181's
decision stands); the fixtures are one real focus caster, so a future pack shape
that states the fixed rank differently fails LOUDLY rather than being guessed;
a focus spell's own `autoHeightenLevel` is the only fixed-rank source exercised,
so a second upstream source (should one ever exist) would need its own arm; and
no test can prove a person finds the chips readable — it proves the bytes.

### The ONE spells instruction reaches every AI-authored mob lane (docs/17 row 200, docs/11 §Mob spells, docs/18 §2.4)

Row 184 built the vocabulary and the no-invention boundary, but its reply
contract omitted the field the vocabulary invited AND the Encounter Cartographer
— the lane that stocks a dungeon — was never wired at all. This slice makes the
two halves come from ONE composer and closes the lane. The pins:

- `tests/llm/mob-spells-lanes.test.ts` (NEW; jsdom, because it drives the engine
  through `waitFor`): the THREE-lane differential through the REAL run engine
  with a mocked chat — the NPC stat-block step's prompt, an encounter draft's
  prompt and the Cartographer brief's prompt each carry
  `MOB_SPELL_SECTION_HEADER`, the real `Fireball — Rank 3` / `Ignition —
  Cantrip` lines AND the contract clause `"spells": [`, and each carries
  NEITHER without a corpus. The NPC arm's no-corpus prompt is compared
  BYTE-FOR-BYTE against `tests/fixtures/mobSpells/statblock-no-corpus.txt`
  (captured from the pre-fix tree; the empty-corpus guard is what keeps it
  green). The Cartographer arm adds the boundary: an invented `Flameball` spends
  exactly ONE repair turn (`chatMock` is called twice), that repair names the
  spell through `MOB_SPELL_REPAIR_LEAD_IN`, and the surviving entry lands on the
  brief step's output as raw `spellIssues` plus the amber `notice` naming both
  the spell and the mob — never a silent drop.
- `tests/architecture/one-spells-shape.test.ts` (NEW; node, architecture scan):
  the JSON-quoted entry shape (`"castRank"`) is declared in exactly ONE `src/`
  file (`llm/promptScaffolding.ts`), the vocabulary header and the contract
  composer both render `MOB_SPELL_ENTRY_SHAPE`, the two public composers read
  ONE corpus predicate declared once, and `runEngine.ts` imports
  `formatMobSpellContractClause` and hand-writes neither the `"spells":` clause
  nor the shape.
- AMENDED, not weakened: `tests/llm/module-gen-and-provenance.test.ts` still
  detects `MOB_SPELL_SECTION_HEADER` on its own (the header now embeds
  `MOB_SPELL_ENTRY_SHAPE`, byte-composed by the composer);
  `tests/llm/rejectionReason.test.ts`'s exactly-N scan goes 7→8 deciding sites
  (the Cartographer's spell-repair refusal) and its
  `rejectedStepOutput(raw, evaluated.issues, evaluated.reasons)` byte pattern
  1→2, so the new refusal is provably built by the ONE constructor; and
  `tests/llm/mob-spells.test.ts` + `tests/llm/strictSchemaSmoke.test.ts` stay
  green unchanged.

**Injected RED, watched (raw logs kept under the writer's `/tmp` worktree;
every arm's file hash printed, identical arms labelled VOID):** dropping the
clause from the contract reds the three-lane `"spells": [` assertions; removing
the Cartographer's vocabulary reds the Cartographer arm; removing the
empty-corpus guard reds the NPC byte-identity arm; re-spelling the shape in a
second prompt string reds the source scan by file; writing `"spells":` into
`runEngine.ts` reds the call-site arm.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove a live model
names a spell for a caster the module's own text implies but never states — it
proves the vocabulary and the contract reached the prompt and that an invented
name is LOUD; and no test can prove a pre-arc rules pack holds structured spells
at all — row 181's no-migration decision stands, so the rules pack must be
RE-IMPORTED before an assigned name can resolve (docs/12 §15.4).

### Caster-aware NPC generation — the clause at BOTH steps, and the caster's own numbers (docs/17 row 201, docs/11 §Mob spells, docs/08-MODULE-DESIGNER §M4-C, docs/18 §2.2/§2.3)

The owner's report ("the NPC smith just needs to be explicitely caster aware …
a GM needs spell DCs to actually play the spell") has two halves: a
caster-aware PROMPT and a place for the caster's numbers. Row 200 made every mob
lane OFFER the library; this slice makes a module-described caster come out AS
one. The pins:

- `tests/llm/mob-spells-lanes.test.ts` (EXTENDED): `MOB_SPELL_CASTER_CLAUSE` is
  present in BOTH NPC prompts with a corpus — the NPC DRAFT prompt (identity and
  prose) and the NPC stat-block prompt (spells and numbers) — and the stat-block
  arm still carries the vocabulary and the `"spells": [` contract. The NPC DRAFT
  prompt WITHOUT a corpus is compared BYTE-FOR-BYTE against the NEW pre-arc
  golden `tests/fixtures/mobSpells/npc-draft-no-corpus.txt` (captured at HEAD
  before this slice), and the encounter-draft and Cartographer prompts WITH a
  corpus are compared byte-for-byte against their own NEW pre-arc goldens
  (`encounter-draft-with-corpus.txt`, `cartographer-brief-with-corpus.txt`) —
  those two lanes keep the existing OPTIONAL invitation and never render the
  clause. (The NPC draft is handed the clause but NOT the vocabulary list: it
  authors no stat block.)
- `tests/domain/statblock-caster.test.ts` (NEW): the three caster fields are
  additive/nullable (a pre-arc block parses with none of them and
  `casterStatLine` is `null`); a stated `spellDC: "25"` / `spellAttack: "+17"` /
  `tradition: "arcane"` coerces and renders as ONE line; a malformed DC fails the
  parse NAMING `spellDC`; a caster that states NO DC yields the LOUD
  `SPELL_DC_MISSING_MARKER` with no digit in it (a level-7 block would suggest
  25 — the invented number this pin forbids); and the CANTRIP confirmation the
  owner asked about: a level-7 caster's Ignition is rank 4 / `5d4` with
  `cantrip-auto` provenance, while a caster whose level is unknown is a loud
  `casterLevel` issue with no formula and no rank.
- `tests/features/statblock-caster.test.tsx` (NEW): the ONE `StatBlockCard`
  renders the stated line (`data-state="stated"`), renders the LOUD marker
  (`data-state="missing-spell-dc"`, no digit) for a caster that states none, and
  renders NO caster line for a mundane or legacy block (the legacy block also
  mounts no spell section).
- `tests/lib/mob-spells-pdf.test.ts` (EXTENDED): the module PDF prints the SAME
  `Spell DC 25 · spell attack +17 · tradition arcane` bytes the card shows, and
  prints the LOUD marker (and no `Spell DC`) for a caster that states none.
- `tests/llm/mob-spells.test.ts` (EXTENDED): through the REAL run path a
  stat-block reply that states the three fields stores them on the artifact row,
  unchanged and underived.
- `tests/architecture/one-spells-shape.test.ts` (EXTENDED): the shared corpus
  gate is now read by THREE composers (vocabulary section, contract clause,
  caster clause); `MOB_SPELL_CASTER_CLAUSE` is declared once, `Caster awareness`
  is spelled nowhere in `runEngine.ts`, and `runEngine.ts` reaches the clause
  exactly TWICE (the two NPC steps).
- AMENDED, not weakened: `tests/llm/module-gen-and-provenance.test.ts` detects
  the new literal on its own (the one-source marker set);
  `tests/llm/strictSchemaSmoke.test.ts` still converts `statBlockSchema` — its
  new required-nullable keys reach EVERY lane's strict schema, the bounded and
  documented consequence of the shared shape (the encounter/Cartographer PROMPT
  bytes are unchanged; their `response_format` gained the fields).

**Injected RED, watched (raw logs kept under the writer's `/tmp` worktree; every arm's file hash printed, identical arms labelled VOID):** dropped the caster clause from the stat-block composer → the two stat-block clause pins red; dropped the clause from the NPC draft arm → the draft pin red; replaced the loud DC marker with a computed number → the domain, card and PDF `not.toMatch(/\d/)` pins red; removed the empty-corpus guard → the byte-identity goldens red.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
actually assigns spells and a DC to a caster the module's prose implies — it
proves the clause and the list reached the prompt and that a stated DC survives to
every surface; and the module text reaches the stat-block step through
`input.brief` (measured: the step reads `input.brief` plus the draft's `name`, not
the draft body), so a caster the DRAFT invents without the module stating it is
carried only by the draft's name and the clause — closing that would need a
draft-level caster field, deliberately not added (docs/17 row 201).

### The stat-block request contract is PER SYSTEM, and a stray cross-system field is quiet (docs/17 row 205, docs/11 §Mob spells, docs/18 §2.2/§2.3)

The owner's real Pathfinder 2e run produced eight loud errors, one per spell:
*"the mob «Nirklex» assigns a spell it cannot use: the spell «Regenerate» is
pathfinder2e; a dnd5e caster/character level cannot apply to it"*. The root
cause was our own contract: the 5e lane's `casterLevel`/`characterLevel` sat on
the ONE STORED assignment schema, strict structured outputs turn every key into
a required nullable property, and the PF2e request's response format therefore
DEMANDED the other system's fields while the prose shape named only
`{ name, castRank }`. The pins:

- `tests/llm/stat-block-contract.test.ts` (NEW) — THE DIFFERENTIAL over the
  emitted JSON Schema: the PF2e `spells` item carries
  `name`/`castRank`/`autoHeightenLevel` and NOT the dnd5e keys; the dnd5e item is
  the mirror (`name`/`castRank`/`casterLevel`/`characterLevel`); the two emitted
  schemas must DIFFER (identical arms are the tell, never the result); every
  emitted property stays required-nullable; no `$ref` is emitted (a reused zod
  instance would be refused by `strictSchema`); the assignment builder itself is
  per-system; and a system with NO corpus emits the STORED schema
  byte-for-byte. Plus the compatibility arm: `statBlockSchema` still parses a row
  carrying ANY of the five assignment keys (the owner's saved NPC needs no
  migration), a legacy row keeps `spells: undefined`, and a reply admitted by
  either request variant parses as storage.
- `tests/llm/stat-block-contract.test.ts` (SOURCE SCAN) — the population pins:
  `statBlockResponseFormat(` occurs once (the NPC stat-block step),
  `encounterDraftSchemaFor(` once (the encounter draft contract),
  `encounterGeneratorBriefSchemaFor(` once (the Cartographer brief), and
  `schemaResponseFormat` survives only for the two contracts that carry NO stat
  block (continuity report, vision-locate). A fourth hand-built variant reds by
  count.
- `tests/llm/mob-spells-lanes.test.ts` (EXTENDED) — the PROSE half through the
  REAL engine: the PF2e stat-block prompt contains `spellEntryShape('pathfinder2e')`
  and not `"casterLevel"`; a dnd5e campaign's prompt contains
  `spellEntryShape('dnd5e')` and not `"autoHeightenLevel"` — one assertion per
  system on the bytes the model sees. The two with-corpus goldens
  (`encounter-draft-with-corpus.txt`, `cartographer-brief-with-corpus.txt`) were
  REGENERATED for the per-system shape rather than claimed byte-identical; the
  no-corpus goldens are untouched (the gate keeps those prompts pre-arc).
- `tests/domain/mobSpells.test.ts` (EXTENDED) — THE REGRESSION PIN: a PF2e
  `Ignition` carrying `casterLevel: 9, characterLevel: 9` resolves to rank 3 /
  `4d4` (the mob's OWN level 5), yields `issues: []`, makes `mobSpellIssues`
  return `[]` (so no repair turn and no boundary failure), and names both keys on
  the chip detail and through `mobSpellWarnings`; the mirror (a 5e spell carrying
  `autoHeightenLevel`) is ignored the same way; and a 5e spell STILL reads its own
  `casterLevel`/`characterLevel` into the cantrip progression (row 194 unchanged).
- `tests/features/mob-spell-chips.test.tsx` (EXTENDED) — the same case through
  the ONE card: the chip renders the correct values with NO `mob-spell-issues`
  box, and the quiet `mob-spell-warnings` box names the mob and says the field
  was ignored.
- `tests/architecture/one-spells-shape.test.ts` (AMENDED) — the JSON-quoted
  `"castRank"` needle now lives in exactly ONE src file (`llm/statBlockContract`),
  the composer renders `spellEntryShape(system)` in BOTH halves, the corpus gate
  is declared once and read by THREE composers, and `runEngine.ts` hand-writes
  neither the shape nor a `"spells": [` clause nor a `schemaResponseFormat('statblock'` call.

**Every existing REAL check stays as loud as it was** and its pins are
unamended: an invented name still stores an unresolved chip plus a named issue
and spends the ONE repair turn (`tests/llm/mob-spells-lanes.test.ts`,
`tests/llm/mob-spells.test.ts`), and a level-less cantrip is still a loud
`casterLevel` issue.

**Injected RED, watched (raw logs kept under the writer's `/tmp` worktree; every
arm's file hash printed, identical arms labelled VOID):** gave the PF2e request
schema the dnd5e keys back → the differential pins red; restored the old throw
for a cross-system field → the regression and card pins red; routed one lane to
a hand-built variant → the population pins red.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
obeys the per-system shape (every pin mocks the transport or drives the real
engine with a mocked chat); no test can prove the reinterpretation of a real
saved row beyond the parse plus `mobSpellChips` pins (a real on-disk row is not
available to a test); and no test proves the owner's eight errors are gone on his
own library — that follows from the request no longer demanding the fields and
from the tolerance being unable to throw.



The owner's go-ahead ("d&d spell lane is a go") puts the SAME `spell` chunk lane
on a SECOND system. The fixtures are REAL upstream documents whose provenance is
recorded HERE and asserted in the test, so "verified against the real corpus" is
checked rather than remembered:

- `tests/fixtures/packs/dnd5e/spells/cantrip-fire-bolt.yml` (NEW) —
  `foundryvtt/dnd5e` @ `6.0.x`, `packs/_source/spells/cantrip/fire-bolt.yml`,
  sha256 `2ffd57301b166ff5ef5b306ede94db3827dcc6bb3a7e1439d0d37df2b3e3e04c`
  (2,946 bytes), the body after its provenance comment header. The upstream file
  is COMMITTED VERBATIM; the header also carries the fetch date.
- `tests/fixtures/packs/dnd5e/spells/1st-level-magic-missile.yml` (NEW) —
  `packs/_source/spells/1st-level/magic-missile.yml`, sha256
  `9fea9a6b0845bad8a9b2c96e067308e4cda96c9dca0d734664c7d58786028600` (2,876
  bytes). Its damage part states `scaling.mode: ''` — the PROSE-ONLY case.
- `tests/fixtures/packs/dnd5e/spells/3rd-level-fireball.yml` (NEW) —
  `packs/_source/spells/3rd-level/fireball.yml`, sha256
  `1011e2baf84af360f5c7852e68b52d6a21df98acf23ad721a435c74fa3925f57` (3,172
  bytes). Structured `whole` scaling AND an `At Higher Levels.` sentence — the
  case where both exist.
- `tests/fixtures/packs/dnd5e/mage-caster.yml` (NEW) — a CARVE of the real
  `packs/_source/monsters/humanoid/mage.yml` (full upstream sha256
  `e873a560af94bdc4318498e51f0433fc5230db44acf476907071f9f9276e3b2e`, 67,469
  bytes; carve body sha256
  `8246a7145ce5634aab4900f5881747245135c116614e142e0529d4cf2eed5949`, 13,336
  bytes): the creature document's lines 1–403 plus its `items:` entries for
  Fire Bolt and Fireball. Every field the adapter reads is upstream's own bytes
  — the repo's established trimmed-fixture pattern, never a synthesised shape,
  and the header names the exact line ranges and what was dropped.
- `tests/ingest/packs/dnd5e-foundry.test.ts` (extended): each fixture's
  `{path, sha256, bytes}` is ASSERTED (a drift reds by name); Fire Bolt maps
  `rank: 0` + `cantrip: true` + `school: 'evo'` + `traditions: []` +
  `filterAxis: 'school'` + the four cast facts + `1d10` + the `whole` scaling
  part + the `CC-BY-4.0` source line; Fireball maps `rank: 3`, the 20-foot
  sphere area, `8d6` and the `At Higher Levels.` sentence VERBATIM; Magic
  Missile maps `scaling.mode: ''` and its `Higher Levels.` sentence verbatim; a
  document with no `level`, an unknown school code and a `whole` scaling block
  with no dice count each fail LOUDLY as a named per-entry failure (no partial
  row); the pack import lands two `spell` chunks with the folder-derived
  heading paths; and the real Mage carve's own spell items map to
  `[{name: 'Fire Bolt'}, {name: 'Fireball', castRank: 3}]`, with a CR-only
  creature inventing NO level field and a spell-less creature omitting the key.
- `tests/domain/spellHeightening.test.ts` (extended): Fireball at slot 3 vs 5
  is `8d6` → `10d6` from the source's own dice count; the prose-only shape
  returns its sentence verbatim behind `DND5E_PROSE_ONLY_MARKER` and computes
  NOTHING; `'half'` is refused loudly; a rank below the source level is refused;
  **the CANTRIP TRAP as a differential** — Fire Bolt at character level 5 vs 11
  is `2d10`/`3d10` with `appliedRank: 0` and `cantripScaling: true` (the PF2e
  rule would print rank 3 / rank 6), while a PF2e cantrip at the same levels
  keeps `3d6`/`6d6` with `cantripAuto: true`; and the DISPATCH is pinned BOTH
  ways (a 5e payload carrying PF2e traits and a PF2e heightening object still
  never reaches a PF2e arm; a PF2e payload carrying an `upcast` block never
  reaches the 5e arm).
- `tests/domain/mobSpells.test.ts` (extended): the differential through the ONE
  RESOLVER — a 5e cantrip at `casterLevel` 5 vs 11 yields `2d10`/`3d10` at
  `cast at level 0` with `upcasting: upcast`, a resolved levelled 5e spell
  keeps its source damage at level 3, an unseeded name stays a loud unresolved
  chip + a `mobSpellIssues` sentence naming both halves, and a dnd5e
  `casterLevel` on a PF2e spell is a loud issue (`resolved: true`, `result:
  null`), never a silent ignore.
- `tests/features/spells-page.test.tsx` (extended/rewritten): a real Dexie dnd5e
  campaign lists its spells with `Level N` wording (never `Rank N`), the strip
  says `Schools` and filtering is a school union, a school-less spell shows the
  per-row `no school` mark, a payload that names no axis says exactly that on
  its card, the card shows the school and the source's higher-level sentence
  VERBATIM, and the OLD "Spells are not imported for D&D 5e" state is gone —
  the per-system empty state now names the D&D 5e SRD spells pack and its
  remedy.
- `tests/features/mob-spell-chips.test.tsx` (extended): the END-TO-END
  library-mob half through the EXISTING `StatBlockCard`/`SpellChip` harness —
  the real Fire Bolt and Fireball corpus plus the Mage carve's assignments
  render `cast at level 0` / `2d10 fire` / `cantrip, scaled by the caster`, and
  `cast at level 3: 8d6 fire` with the source sentence; an unseeded
  `Eldritch Blast` renders `spell-chip-unresolved` with the loud issue box; and
  a spell-less creature renders no `mob-spells` section.
- `tests/architecture/one-cantrip-signal.test.ts` (extended): the SOURCE SCAN
  gains the dnd5e signal — `dnd5eSpellIsCantrip` is defined AND called only in
  `src/ingest/packs/dnd5e-foundry.ts`, and the 5e mapper's own comment proves it
  compares `level === 0` rather than looking up a trait.
- `tests/architecture/one-cantrip-rank-rule.test.ts` (NEW; node — the
  `tests/architecture/**` glob is already in `nodeTestGlobs`): the exactly-one
  pin for the Paizo cantrip-rank rule the row-194 follow-up folded. The
  arithmetic `Math.min(10, Math.max(1, Math.ceil(level / 2)))` is spelled in
  exactly ONE file (`src/domain/spellHeightening.ts`, as the exported
  `pf2eCantripRankFor`) and `domain/mobSpells.maxCastableRank` plus both
  `spellAtRank` arms (cantrip and auto-heightened focus) CALL it; the needle is
  the whitespace-collapsed ARITHMETIC with the variable name blanked, so
  neither a function rename nor a parameter rename can hide a copy, while an
  unrelated ceil clamp (`llm/roomBudget.roomBudgetReferenceCreatureLevel`, a
  half-level reference creature with no 1..10 rank ceiling) does not match. The
  AGREEMENT pin lives in `tests/domain/mobSpells.test.ts` (extended): at caster
  levels 1, 7, 9, 10 and 20 `maxCastableRank(level)` ===
  `pf2eCantripRankFor(level)` === the `appliedRank` of a cantrip AND of an
  auto-heightened focus spell, while a dnd5e cantrip at the same caster level
  stays `appliedRank: 0` with `cantripScaling: true` — never
  `pf2eCantripRankFor(9)`'s rank 5.
- `tests/ingest/packs/packFetch.test.ts` (extended): the dnd5e source's
  broadened `packRoot` + `packDirs: ['monsters','spells']` and both curated
  recipes (337 creatures · 329 spells) are asserted, and the advanced listing
  offers the monsters and spells folders while never offering the item-adapter
  folders.
- AMENDED, not weakened (NAMED amendments): `tests/ingest/packs/html-to-text.test.ts`
  — the call-site table's `dnd5e-foundry` count is 1 → 3 (the spell
  description and the higher-level paragraph use the SAME seam; total 9 → 11)
  and the `foundry-dnd5e-srd` lane digest is 13 entries →
  `4e6779ff4e59ec9fa6d5f1476924e533d28d00037942b36c3895f48a169d546f` (14
  entries: the new flat `mage-caster.yml`; the three spell documents live in the
  `dnd5e/spells/` subdirectory and the flat lane walk now skips DIRECTORIES
  explicitly, which is a harness fix, not a byte change);
  `tests/features/spell-rows.test.ts` asserts the row's `filterAxis` +
  `filterValues` instead of the removed `traditions` projection (the payload's
  own `data.traditions` is unchanged and still asserted where it belongs).
- The fixtures are NOT enumerated by the `tests/fixtures/spells/` corpus lane
  digest: the dnd5e spell fixtures join `tests/fixtures/packs/dnd5e/spells/`,
  and the dnd5e LANE digest above covers the flat creature files only.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test can prove a live 5e
creature's spells all exist in the owner's imported corpus (resolution is a
library question, and an unresolved name is loud by design); no test can prove
the `'half'` scaling mode's real semantics — it is REFUSED, so no number is ever
derived from it; no test can prove a 5e creature's character level is right when
its document states none (the tier is left UNCHOSEN and the chip says so); no
test can prove the school is the axis a player would want (class lists are not
in these documents at all, and inventing them was refused); and no test proves
the rendering reads well to a person — it proves the bytes.

### A resolved mob spell chip opens the spell's description (docs/17 row 216, docs/11 §Mob spells, docs/18 §2.3)

The owner reported that a caster's spell chips were not clickable. The chips now
open the spell's description through the app's ONE detail renderer — no second
detail component, no navigation away from the stat block, and no second corpus
read:

- `tests/features/mob-spell-chips.test.tsx` (EXTENDED; jsdom): the pins through
  the EXISTING `StatBlockCard`/`SpellChip`/Dexie harness (the shared `seedSpells`
  helper gains an optional per-spell `text`, so a description fragment is
  distinctive). (1) clicking a RESOLVED chip opens `mob-spell-dialog`, whose
  `spell-card` shows the spell's name, the SEEDED chunk's stored description and
  a cast fact (Fireball's `500 feet`); (2) Escape AND the close control both
  dismiss it, and the chip is still there; (3) clicking an UNRESOLVED chip opens
  NOTHING — asserted as ABSENCE of `mob-spell-dialog` and `spell-card`, with the
  resolved sibling opening the same dialog as NON-VACUITY; (4) the resolved
  chip's `title` EQUALS `mobSpellChipDetail`'s bytes for the same chip resolved
  through `mobSpellChips`/`mobSpellIndex` (a DIFFERENTIAL against the ONE
  composer), and both testids plus `data-spell-unresolved` are unchanged;
  (5) a mob storing `fireball` against a library `Fireball` opens the LIBRARY
  spell's card and its description — a lookup by the raw stored name reds — and
  (6) the existing dnd5e block opens the 5e Fire Bolt card through the SAME
  path, printing the 5e payload's own `Cantrip`/`Evocation` wording.
- `tests/architecture/one-spell-card.test.ts` (NEW; node — the
  `tests/architecture/**` glob is already in `nodeTestGlobs`): the
  EXACTLY-ONE-DETAIL-RENDERER source scan. The `spell-card` testid is declared
  in exactly `src/features/spells/spell-card.tsx`, and `SpellCard` is imported
  by exactly the TWO declared hosts — `SpellsPage.tsx` (the list's pane) and
  `mob-spell-chips.tsx` (the chip's dialog). A second detail view that claims
  the testid, or a THIRD host, reds by file; the walk is Node's recursive
  `readdirSync` with the counting INLINE, so no named helper body is added to
  the tripwire's test-tree inventory (docs/17 row 212).

**Injected RED, watched (raw logs kept; every arm's `git hash-object` printed,
each restored from HEAD by a `trap`):** the baseline arm (hash
`1eb7165ceb98c509386f6292bf0f52731c3f26d3`) ran 16 passed. Making the chip click
a no-op (hash `81bae019597783c03a8373b0582caa3edfd85d5f`) reds pins 1, 2, 3, 5
and 6 (5 failed / 11 passed). Giving the UNRESOLVED chip the same dialog (hash
`f3bd4d0eb8d6ccac375ec7df0e20bee8ea5d99c6`) reds pin 3 ALONE (1 failed / 15
passed). Passing the description as `''` (hash
`dd4bb6a1c704cc10485221be9a7412857cd9ab62`) reds the three description
assertions — pin 1's `Expected element to have text content: A roaring blast of
fire detonates at the spot you designate.` beside the card's real `Received`
text, with pins 5 and 6 — so the pin reaches the CHUNK TEXT, not merely the
payload. The restored hash equals the baseline hash, and no arm is VOID (all
four hashes differ). **WHAT THESE PINS DO NOT PROVE:** no test proves the
dialog reads well to a person (it proves the bytes and the dismissal); the
description a real library carries is the ingest lane's output, proven in its
own lane, not here; and the source scan catches a second HOST or a second
`spell-card` testid owner, not a paraphrased second renderer under a new testid
(the source scan is a tripwire, not a proof).

### Every model-prose surface renders through the ONE `WikiMarkdown` (docs/17 row 217, docs/05 §The chip, docs/18 §2.2/§2.3)

The owner read literal `[[Name]]` bytes on the npc view (*"In the description i
see [[<name>]] occurrances which are supposed to be links, but are not."*) and
asked for the rendering to be centralized. The ONE React renderer already
existed — `WikiMarkdown` chips a resolved token and dashes an unresolved one —
so the slice folds every measured BYPASS onto it. The pins below are behaviour
first (a chip, its destination, and the absence of the raw bytes), plus the
exactly-one source scan that keeps a second `react-markdown` import impossible
to be born quietly. The stat-block `TextBlocks` contract and the
imported-record surfaces are deliberately NOT migrated (docs/17 row 217).

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **`NpcCard` summary / `appearance` / `personality`**: a resolved token is a chip carrying the pool row's id whose click opens it; an unresolved one is the dashed chip whose `title` holds the byte-exact `[[Ghost Keep]]` while the TEXT never does; a token-free field reads as before | `tests/features/model-prose-rendering.test.tsx` (2 pins) | ✅ REVERT-PROVEN (injection B) |
| **`EncounterCard` summary AND a roster entry's `notes`** both chip against the SAME pool and open it | same | ✅ |
| **`CollapsibleRow` summary with NO context** (empty pool) dashes, never raw bytes | same | ✅ |
| **`RevisionDialog` snapshot summary + body** through the seam with an empty pool; the file's direct `react-markdown` import is GONE | same + the import scan | ✅ REVERT-PROVEN (injection C) |
| **Campaign-tree row-summary tooltip** resolves against `[...artifacts, ...globals]` and opens via the tree's own `onSelectArtifact` | same (hover through the real `WorkspacePage`) | ✅ REVERT-PROVEN (injection D) |
| **`BattleSurface` room `key`, `keyTreasure` and a mob's frozen `treasure`** chip; the resolved one carries the seeded encounter's id | `tests/features/battle-surface.test.tsx` (existing seeded harness; `seedKeyedBattle` gained optional `keyText`/`keyTreasure`/`treasure`) | ✅ |
| **The EXACTLY-ONE seam**: `react-markdown` and `remarkWikiLinks` are imported by exactly `wiki-markdown.tsx`, and a declared surface map (file + reason + `<WikiMarkdown` count) holds the migrated population with a per-site rot check | `tests/architecture/one-model-prose-renderer.test.ts` (3 pins) | ✅ REVERT-PROVEN (injections B and C) |
| **The deliberate exclusions stay green**: the `TextBlocks` pins and the imported-record surfaces untouched, the whole suite green | the full gate (343 files / 4441 tests) | ✅ |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `imports react-markdown from exactly the one renderer, and proves it can see one` | `tests/architecture/one-model-prose-renderer.test.ts` | a second `react-markdown` import (the pre-217 `revision-dialog` spelling) — injection C |
| `runs the wiki token plugin only inside the one renderer` | same | a second importer of `remarkWikiLinks`, i.e. a second token walker |
| `declares every model-prose surface, and each still renders through the seam` | same | a surface reverting to a bare `<p>{modelText}</p>` and dropping its `<WikiMarkdown` call — injections B and C |
| `NpcCard: a resolved token is a chip that opens the artifact, an unresolved one is dashed, and no raw bytes survive` | `tests/features/model-prose-rendering.test.tsx` | the raw bytes coming back — injection B |
| `NpcCard: appearance resolves or dashes per token, personality without a token is unchanged` | same | a per-field reversion the file-level count cannot see, and a chip that loses its byte-exact tooltip |
| `EncounterCard: the summary AND a roster entry’s notes both chip, and open the same pool` | same | a summary migrated but `notes` left raw (or vice versa) |
| `CollapsibleRow: the expanded summary chips even with no context` | same | an empty-pool surface printing raw bytes instead of the dashed chip |
| `RevisionDialog: both snapshot fields render through the seam (empty pool)` | same | a second markdown dialect (no wiki chips) inside the revision view — injection C |
| `the campaign-tree summary tooltip resolves against the tree’s own pool` | same | a chip resolved against the WRONG pool (or no pool) — injection D |
| `room key, room treasure and a mob’s frozen treasure all render wiki chips, never raw bytes` | `tests/features/battle-surface.test.tsx` | the board's three model-prose fields bypassing the renderer |

**REVERT-PROVEN** (each injection applied under the suite lock, its changed
file's `git hash-object` PRINTED, restored by a `trap` from HEAD — never a bare
`git checkout --` — and every arm's hash distinct, so no arm is VOID; raw logs
in `/tmp/model-prose-logs/`):

- **A — baseline.** `artifact-cards.tsx` `e859bd57a9c1b628b2e03dfe5fa7c50fd881a24c`,
  `revision-dialog.tsx` `7bd9c8f76fdf0d2301d4f596952e2e1cbd9c12d8`,
  `campaign-tree.tsx` `c8e5ffad3d69790a0717a16f986897400a3df65d`,
  `one-model-prose-renderer.test.ts` `14eb9655cddc8646a5a669ebc6e2ff79c9bc60f4`,
  `model-prose-rendering.test.tsx` `a663f9cbd885018e0bf4146996a6cbf5ceaf609a`
  → **9 passed / 0 failed**.
- **B — one migrated surface reverted to a bare `<p>`** (`artifact-cards.tsx`
  hash `ba532c05dfb240f93eeb8c25e99c8cac7858f91b`) → **2 failed / 7 passed**: the
  `NpcCard` no-raw-bytes pin (`expected … not to contain '[['`) AND the arch
  surface-count pin (declared 5, observed 4).
- **C — the seam bypassed** (the pre-slice `revision-dialog.tsx` restored from
  `1d43d27`, hash `f3923d0fa10ef97245d764e2e6671e95c172f0fe`) → **3 failed / 6
  passed**: both arch pins (a second `react-markdown` importer; declared 2,
  observed 0 `<WikiMarkdown`) and the `RevisionDialog` behaviour pin (no dashed
  chips).
- **D — a real pool replaced by an EMPTY one where one exists** (all four
  `TreeRow` mounts' `artifacts={wikiPool}` → `artifacts={[]}`,
  `campaign-tree.tsx` hash `6fddc90a5fbc743c1835c2aafba3147570fa49f5`) → **1
  failed / 8 passed**: the campaign-tree clickable-chip pin ALONE, with the arch
  scan GREEN — the measured proof that the pin tests the THREADING, not merely
  that a renderer ran.
- Restored hashes equal the baseline hashes above and `git status` is clean.

**WHAT THESE PINS DO NOT PROVE:** the source scan is TEXTUAL — `await
import('react-markdown')` and a re-export that hides the specifier are invisible
to it, and a per-FIELD reversion is caught by that surface's behaviour pin, not
by the file-level `<WikiMarkdown` count; the behaviour pins render small direct
fixtures, not a real model run, so "a real LLM echoes a token into this field"
is established by the write path (docs/17 row 217), not by a fixture; and no pin
asserts how a chip reads to a person — it proves the bytes, the destination and
the raw-byte absence.

### The peek modal's pool threading is pinned as an integration (docs/17 row 219, docs/05 §The chip, docs/18 §2.3)

Row 217 routed every model-prose surface through the ONE `WikiMarkdown`, but its
behaviour pins render `NpcCard`/`EncounterCard` DIRECTLY and hand each one its own
pool — so nothing held the PEEK MODAL's threading, and the modal is the module
reader's entity card, the exact screen the owner reported (*"This was the npc view
from the model entities"*). Measured at `4f9728b`: emptying the modal's
`artifacts={artifacts}` on its `NpcCard` (`peek-modal.tsx` hash
`cc6d42c1668cc5c14508dd568cbd2d7b54257b8c` → `65f59c19a8f9671043c48946e81d0b83c6a511ef`)
left every rendering test green. These pins mount the MODAL with a real pool: its
own pool must resolve the summary token, and its own breadcrumb push must run on
the click. NO src change was needed. The reader's source scan
(`reader-encounter-roster.test.tsx`) is deliberately NOT extended — it sees the
`artifacts={artifacts}` bytes but not whether the value is threaded, which is the
break arm D measures.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **`PeekModal` → `NpcCard`** (the reader's entity card): the modal's `artifacts` pool resolves the summary `[[Ash Gate]]` to the resolved `wiki-chip` carrying the pool row's id (`wiki-chip-unresolved` absent), and the click pushes the linked artifact (`dialog-title` becomes its name, `peek-back` appears, the root card is gone) | `tests/features/model-prose-rendering.test.tsx` (new `describe`, 2 pins) | ✅ REVERT-PROVEN (arms B and C) |
| **`PeekModal` → `EncounterCard`**: the same threading for the encounter summary and the same breadcrumb push | same | ✅ REVERT-PROVEN (arms C and D) |
| **The row-217 component pins stay as they are** (they pin the cards, not the modal) and the reader's source scan is not restated | same file, the 6 existing pins unchanged | ✅ |
| **No src change, whole suite green** | the full gate | ✅ |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `NpcCard: the modal’s pool resolves the npc summary token, and the click pushes the linked artifact onto the modal’s own breadcrumb` | `tests/features/model-prose-rendering.test.tsx` | the modal handing an EMPTY pool to the card — the dispatcher's arm-D break (`artifacts={[]}`), red as the missing resolved chip |
| `EncounterCard: the modal’s pool resolves the encounter summary token, and the click pushes the linked artifact onto the modal’s own breadcrumb` | same | the same break on the encounter arm |
| (both) the click assertion | same | the modal's internal `onOpenArtifact` breadcrumb push replaced by a no-op — red on the unchanged dialog title |

**REVERT-PROVEN** (each injection applied under the suite lock, its changed
file's `git hash-object` PRINTED, restored by a `trap` from HEAD — never a bare
`git checkout --` — and every arm's hash distinct, so no arm is VOID; raw logs in
`/tmp/entity-pin-logs/`):

- **A — baseline.** `tests/features/model-prose-rendering.test.tsx` through the
  gate runner → **1 file / 8 tests passed** (the 6 row-217 pins plus the 2 new),
  gate GREEN.
- **B — the dispatcher's own arm reproduced exactly.** `peek-modal.tsx` baseline
  `cc6d42c1668cc5c14508dd568cbd2d7b54257b8c` → injected
  `65f59c19a8f9671043c48946e81d0b83c6a511ef` (`<NpcCard … artifacts={artifacts}`
  → `artifacts={[]}`) → **1 failed / 7 passed**: only the Npc integration pin,
  `Unable to find an element by: [data-testid="wiki-chip"]` (the dashed
  unresolved chip is the only chip). This is the whole point of the slice.
- **C — the modal's breadcrumb push is a no-op.** `peek-modal.tsx` injected hash
  `5e5915ce60d4edccf338bdb1dbbfb199d6bd61f8` (`onOpenArtifact={(next) =>
  {push(next.id)}}` → `() => {}`) → **2 failed / 6 passed**: BOTH integration
  pins red on `expected 'Silt Warden'/'Ford Ambush' to be 'Ash Gate'` — the chip
  resolved and the push never ran.
- **D — the encounter arm's pool emptied.** `peek-modal.tsx` injected hash
  `7fe97c28ffa8551e11ad775eb8b990772d836f85` → **1 failed / 7 passed**: the
  Encounter integration pin alone (the Npc pin stays green because its call was
  not touched).
- Each arm restored `peek-modal.tsx` to `cc6d42c1668cc5c14508dd568cbd2d7b54257b8c`
  and released the lock; `git status` is clean.

**WHAT THESE PINS DO NOT PROVE:** they mount the modal directly, not through
`ModuleReaderPage`, so the ROUTE's own `setPeekId(artifact.id)` hand-off is still
held only by `reader-encounter-roster.test.tsx`'s source scan plus
`module-reader.test.tsx`; they assert the modal's pool and breadcrumb push, not
how a chip reads to a person; and the pool is a direct fixture, so "a real model
echoes a token into this field" remains established by the write path (docs/17
row 217), not here.

### The top-bar chat-model picker and its recency list (docs/17 row 193, docs/05 §Top bar/§Settings, docs/18 §2.1/§2.3)

The owner asked for a picker for the global first-try chat model ("the picker
should also have a section for the most recently used models that is always
sorted by recency"). The pins are split by idea, each naming row 193:

- `tests/domain/recent-chat-models.test.ts` (NEW): the ONE ordering rule —
  A→B→C gives exactly `['c','b','a']`; re-using A gives exactly `['a','c','b']`;
  a duplicate never appears twice; the cap arm asserts the EXACT list and that
  the entry dropped is the OLDEST; the rule does not mutate its input; an
  empty/whitespace model is ignored; a fresh row is `[]`; and a stored row
  written before the field PARSES as `[]` (no migration).
- `tests/db/settingsRepo.test.ts`: the ONE recording seam reads, merges and
  writes inside one transaction — a FRONT insert, a DIFFERENTIAL that two
  concurrent recorders both land (the read-modify-write the seam exists to
  forbid would lose one), move-to-front dedupe, the exact cap, the empty-model
  no-op, and a legacy row.
- `tests/features/model-picker.test.tsx` (NEW, the REAL top bar on the real
  router): the trigger renders in the banner immediately after the Settings
  link on `/` (no campaign) AND on `/c/:id` (campaign route); the Recently-used
  group is in stored order and picking writes `settings.defaultChatModel` AND
  lands the model at the FRONT; a typed id that is NOT in the loaded account
  list is settable; with no API key the Account-models group SAYS why it is
  absent while recents and a typed id still work (and no fetch is attempted);
  and a failed fetch renders its reason in the panel AND calls `toastError`.
- `tests/llm/runEngine.test.ts`: a run whose chat model resolves to the GLOBAL
  default records it; a run with a persona override records NOTHING (the global
  default is not in play).
- `tests/architecture/one-model-option-source.test.ts` (NEW, SOURCE SCAN): the
  `listModels(` population is exactly the transport definition, the
  `listModelIds` option seam, and the two deliberately-different consumers
  (the Settings "Test key" probe, `ReasoningEffortSelect`'s full-row metadata);
  `listModelIds` is defined once; and `model-input.tsx` / `model-picker.tsx`
  reach the seam and never `listModels` directly.

**Injected RED, watched (four arms, the changed file's hash PRINTED by `git
hash-object` for every arm and the tree restored from HEAD by a `trap` before
the next arm — no two arms identical):** **A** baseline — `settings.ts`
`e6be7c3ee683c5cf176a8644fc6fb288a95569f1`, `model-picker.tsx`
`db15d36d8b11ab21689f14176f55727d4c2d7310` → **GREEN 4 files / 28 tests**;
**B** the ordering rule APPENDS instead of moving to front (`settings.ts`
`d024f2baf18fe4b17ab8414c4ff1980cd9b10b10`) → **RED 4** (A→B→C order,
re-use dedupe, the cap arm, purity); **C** the cap removed (`settings.ts`
`cf63d5dc2ec466b5cc428e639458123a9dc9648e`) → **RED 1**, exactly the cap arm
(the exact-list + oldest-dropped assertion); **D** the picker's recording call
removed (`model-picker.tsx` `6f546ca950c98ae5c9ec12156bc3c60293336a48`) →
**RED 3** (pin 3 picking writes the setting AND lands at the front, plus the
free-form and no-key arms that assert the recency front). Every restored file's
hash was printed again and matched the baseline hash.

**The engine call is FIRE-AND-FORGET, and that was a measured correction:**
awaiting a settings transaction at `executeFrom`'s top held the run row at its
previous status long enough for a legitimately racing `approve` to observe a
stale `awaiting_user` and re-enter the SAME step — the first gate run reddened
exactly there (`module-gen-and-provenance`'s finalize pin and
`encounter-map-queue`'s "deleted run is silent" pin, both from a doubled
statblock call), and `void this.recordChatModelInUse(...)` (the method catches
and toasts its own failures) cured both. The top bar's new `Chat model: …`
control also made `canvas-chat-thread.test.tsx`'s page-wide
`queryAllByRole('button', { name: /chat/i })` name the app chrome, so that ONE
assertion is now scoped to `<main>` (the pin is the modules-list front door,
ledger 91, and its row-inventory half is untouched).

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves eight is the
right cap for the owner (it is a documented product choice, pinned exactly so
it cannot drift silently); no test proves the recency list matches his memory —
it proves the ORDER the app stored; and no test proves a real OpenRouter account
returns any particular model list (the fetch is mocked, while its failure and
its absence are the states that are pinned).

### Every global-chat-model path records the recents (docs/17 row 198, docs/05 §Top bar/§Settings, docs/18 §2.1)

Row 193 recorded "the global model was in play" at exactly two sites (the
widget's choose and the run funnel's `executeFrom`), so a model SET IN SETTINGS
and used only in module generation, the document planner, canvas refine/chat or
the Idea Board never reached the top bar's "Recently used" list. This slice
makes the list complete for the global model and nothing else, through ONE seam:
`llm/recentChatModel.recordGlobalChatModelInUse` (fire-and-forget with its own
catch/toast — awaiting a settings transaction on a run's critical path was row
193's measured regression) over the unchanged write
`db/settingsRepo.recordRecentChatModel`, with the ordering rule, the cap of 8,
the dedupe and the widget untouched. The run funnel's private
`recordChatModelInUse` keeps its own resolution and comparison and delegates the
recording half to the shared seam (the rule-4 fold).

The pins are split by idea:

- `tests/architecture/global-chat-model-recording.test.ts` (NEW, SOURCE SCAN):
  every `src/**` file that mentions `resolveChatModel(` or `defaultChatModel`
  (comments stripped) is pinned by exact per-file count with a WRITTEN decision
  — the population and each `record`/`exclude` reason live in the file's
  `DECISIONS` table. It also pins `recordGlobalChatModelInUse(` to exactly its
  call sites (runEngine 1, moduleGen 5, modulePlan 1, canvasRefine 1, canvasChat
  1, ideaBoard 1, the definition 1), refuses a recording site with no `record`
  decision, and names the deliberate exclusions: the four `moduleGen.repairModel`
  escalation sites, the lab bench's diagnostic probe, and the UI mounts that only
  edit or display the setting.
- `tests/llm/moduleGen.test.ts` (5 new pins): the spine pass, the parts pass, the
  full normalization pass, the incremental new-name classification and the
  one-name classification each put a distinct global id at the FRONT of the real
  settings row's recents.
- `tests/llm/modulePlan.test.ts`, `tests/llm/canvasRefine.test.ts`: the planner
  and canvas refine record the global model, real DB.
- `tests/llm/canvasChat.test.ts`: a turn with NO session model records the global
  default; a turn with a session model leaves the list byte-unchanged (the
  non-global exclusion).
- `tests/llm/ideaBoard-recording.test.ts` (NEW, real Dexie, transport the only
  mock): an empty `board.model` records the global model at the front; a
  per-board model leaves the list untouched.
- Row 193's pins (`recent-chat-models.test`, `settingsRepo.test`,
  `model-picker.test`, `runEngine.test`) pass UNCHANGED — order, cap, dedupe,
  concurrent recorders, the widget's three recents mounts and the run funnel's
  global-vs-persona behaviour. The sibling scan
  `architecture/one-model-option-source.test`'s `recordRecentChatModel(`
  expectation is updated to the new truth (the widget, the repo definition and
  the in-use seam file), because the run funnel no longer calls the write
  directly.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves the owner finds
the widened list more useful than the narrow one, nor that a real provider
accepts any particular id — the pins prove WHICH model each path stored, against
the real settings row, with the transport mocked (every added site's chat is
mocked at the protocol boundary). The source scan is textual: it cannot see a
call assembled through a template or a re-export, which is why the behaviour pins
carry the per-site proof and the scan carries the population.

**Injected RED, watched (the tree was restored from `HEAD` by a `trap` after every
arm and every changed file's hash was PRINTED with `git hash-object`; no two arms
identical):** **A** baseline — `modulePlan.ts` `c4aeffd391…`, `ideaBoard.ts`
`d809e0d1c5…`, `runEngine.ts` `98849716a9…`, `settingsRepo.ts` `1d7375bc85…`,
`canvas-module-actions.test.tsx` `daebcc49f4…` → **GREEN 8 files / 190 tests**;
**B** the planner's recording call removed (`modulePlan.ts` `7cbbbb5eab…`) →
**RED 1**, exactly the NAMED pin *planModuleDocument … records the GLOBAL chat
model at the front of the recents (docs/17 row 198)*; **C** the Idea Board made to
record unconditionally, dropping the `board.model === ''` guard (`ideaBoard.ts`
`c7d877b9e8…`) → **RED 1**, exactly the NAMED exclusion pin *leaves the recents
untouched when the per-board model answers*; **D** the run funnel's recording
awaited — BOTH the method-internal form (`runEngine.ts` `1bed93e27f…`) and the
faithful critical-path form `await this.recordChatModelInUse(...)`
(`runEngine.ts` `80a7eddfe4…`) → **GREEN 113/113**, i.e. row 193's racing
regression did NOT reproduce under either injection in this lightly-loaded
single-worker run. That is a REPORTED non-reproduction, not a licence to await:
the race row 193 measured is latency-dependent (the settings transaction
contending with the run row's write), so the fire-and-forget contract stands on
row 193's own measurement and is kept. **E** (the `actDrained` cure added to
`canvas-module-actions.test.tsx` for this slice's extra settings write) was probed
by delaying the cause — a 50 ms wait inside `recordRecentChatModel`
(`settingsRepo.ts` `ef4a78d8ff…` in both arms) with the un-cured test
(`58157bceaa…`, the e9db52f form) against the cured one (`daebcc49f4…`): **BOTH
GREEN 1/1**, so the injection did not reproduce the chunk-busy leak and this arm
is INCONCLUSIVE — not evidence for the cure. The cure's evidence is the gate
itself: the pre-cure full gate reddened on this test (`8` act() entries, all
`CanvasPage`) and the post-cure full gate is **333 files / 4313 tests green**,
with the cure following the documented §"the write that feeds a mounted live
query is DRAINED" pattern and changing no assertion.

### The non-global recents exclusions assert the WHOLE list is unchanged (docs/17 row 203, appended to row 198 by reference)

Row 198's exclusion pins each asserted "the GLOBAL id is absent" — canvas chat
and the persona override on an empty list (`toEqual([])`), the Idea Board on a
list holding one older entry. That is the weaker claim: the list's meaning
(docs/17 row 199) is *only the global first-try chat model belongs in it*, so an
excluded tier must leave the array UNCHANGED, whole and in order. Two changes
close it:

- **One drain, one seam:** `tests/db/helpers.recentsAfterSettlingWrites()` is the
  ONE way an exclusion pin reads the list. `recordGlobalChatModelInUse` is
  FIRE-AND-FORGET by contract (rows 193/198), so a bare read straight after the
  action can pass before a wrongly scheduled recorder commits. The drain awaits
  an EMPTY `updateSettings` patch — an `rw` transaction on the ONE settings row,
  which Dexie queues behind any pending recorder — and only then returns the
  stored array for a full deep-equality compare.
- **Every pin extended, never duplicated:** `tests/llm/runEngine.test.ts` (the
  persona override now seeds `['older/model']` and asserts it back; the
  escalation pin now also asserts the recents hold the GLOBAL first-try model and
  never `potent/fallback`), `tests/llm/imageRun.test.ts` (NEW pin: an image run
  on `settings.imageModel` leaves the list unchanged), `tests/search/embeddings-concurrency.test.ts`
  (NEW pin: a real `ensureEmbeddings` call on `settings.embeddingModel` leaves the
  list unchanged), `tests/llm/ideaBoard-recording.test.ts` and
  `tests/llm/canvasChat.test.ts` (their existing exclusion pins read through the
  drain and compare the whole array).

**Injected RED, watched — one arm per excluded tier (the lock held from BEFORE
the first injection, every mutated file's hash PRINTED with `git hash-object`,
the tree restored from `HEAD` by a `trap`, and every post-arm hash printed again
and MATCHING the baseline hash; no two arms identical):**

| Arm | Tier | Mutation (printed hash) | Pin that reds |
| --- | --- | --- | --- |
| A | baseline | no mutation — `ideaBoard.ts` `d809e0d1c58e`, `runEngine.ts` `eef4bbed0a6f`, `canvasChat.ts` `4f8a493deccc`, `embeddings.ts` `6462e5cb46d7` | all six named pins GREEN (1 passed each) |
| B | Idea Board per-board | `else recordGlobalChatModelInUse(board.model)` — `ideaBoard.ts` `f2505ff328682ba012a11c589703465797f4a8a9` | **RED 1** — *leaves the recents UNCHANGED when the per-board model answers* |
| C | persona override | the funnel's `if (model !== settings.defaultChatModel) return;` guard dropped — `runEngine.ts` `9bfd46713c60cb8d7e38f3ce6d730c014a38b57c` | **RED 1** — *does NOT record a persona override: the whole recents list is unchanged* |
| D | fallback/escalation | `recordGlobalChatModelInUse(repairTarget)` at the draft contract-repair site — `runEngine.ts` `366d9b7a0c69f4d0373dd5d98bb5a27582d43eeb` | **RED 1** — *escalates the contract-repair attempt to the fallback model — and the recents keep the GLOBAL model, never the fallback* |
| E | image | the `persona.mode === 'image'` early return replaced by `recordGlobalChatModelInUse(settings.imageModel)` — `runEngine.ts` `2b817f442c84bd3d2c0de358279f6331d51d6b3c` | **RED 1** — *an image run leaves the recents UNCHANGED: the image tier is not the global chat model* |
| F | embedding | `recordGlobalChatModelInUse(settings.embeddingModel)` in `requestEmbeddings` — `embeddings.ts` `eb1516155119ffd6aa3fe77975eff1c49b153f3f` | **RED 1** — *leaves the chat recents UNCHANGED: the embedding model is a different tier* |
| G | canvas-chat session | `else recordGlobalChatModelInUse(model)` on the session branch — `canvasChat.ts` `cacba85bca278b04b955f4cf9ed891539c05d39d` | **RED 1** — *records the GLOBAL default only when no session model is selected (docs/17 rows 198/203)* |

Each arm ran its NAMED pin only (`-t`), one worker, `--max-old-space-size=2048`.
Restored hashes: `ideaBoard.ts` `d809e0d1c58eb93cc16a5ef78138ac21040e399a`,
`runEngine.ts` `eef4bbed0a6f7302aeab7bdd800ca995fd27b5ef`, `canvasChat.ts`
`4f8a493deccc43011826be949a30d504b39776a5`, `embeddings.ts`
`6462e5cb46d73b9c88f479da1b107f78019a48fc` — byte-identical to baseline.

**The dispatcher's stated mechanism did NOT reproduce for the mutation shape
above, recorded rather than smoothed:** the brief for row 203 says the IDEA
mutation left the suite GREEN. I extracted the pre-strengthening pin verbatim
from `HEAD` (`tests/llm/ideaBoard-recording.test.ts`, hash
`51a51b57f92425e17fc86e13c8629bc164ee770f`), ran it against arm B's mutation
(`ideaBoard.ts` `f2505ff328…`) and it also went **RED 1** — the synchronous
recorder at the top of `refineIdeaBoard` is queued before the test's read, so an
`else`-branch write lands in time. The gap the drain closes is the general one
(fire-and-forget writes are only PROVEN committed by a queued write behind them,
and the whole-array compare is the honest claim); it is not claimed to be
reproduced by that particular mutation.

### The ONE model-picking widget (docs/17 row 199, docs/05 §Top bar/§Settings/§Onboarding, docs/18 §2.1/§2.3)


The owner asked to make the model picker "a global widget … shared across all
model picking instances (setup too)". The measured population was NINE
model-picking instances: `ModelInput` EIGHT times (Settings ×5 — global chat,
fallback chat, embedding, image, fallback image — plus the persona override, the
Idea Board's per-board model and the dense canvas-chat field) and row 193's
top-bar `ModelPicker` once. Both components are deleted; `model-widget.tsx` now
renders both surface shapes over one implementation, and the setup wizard's
OpenRouter step gained the field (it had none).

The pins are split by idea, each naming row 199 unless it is a row-193 pin:

- `tests/features/model-widget.test.tsx` (NEW, 13 tests, the widget in
  isolation): the field variant renders a label + free-form input + browse and
  the trigger variant renders the compact trigger; EACH variant offers the
  account list through `listModelIds`, honours free-form entry for a typed id
  the account list does not contain, shows the loud no-key state with no fetch
  attempted, and shows a failed fetch's reason in the panel AND through
  `toastError` (never an empty list reading as "no models"); a `fetchOptions`
  override is used without touching `listModels`; recents render in stored order
  when passed and are absent when not; and a recents-offering instance records a
  choose through the ONE seam while a non-recents instance does not.
- `tests/settings-page.test.tsx` (the REAL Settings page): the chat-model
  field's panel shows the stored recents in order while the fallback-chat and
  first-try-image panels show none — the PLACEMENT pinned behaviourally, not
  just by the component's props.
- `tests/features/feature-shell-and-editor.test.tsx`
  (`onboarding-wizard.test.tsx`'s harness): the OpenRouter step renders the
  field with `DEFAULT_CHAT_MODEL`, and choosing through its panel writes
  `settings.defaultChatModel` — the same setting the top bar and Settings write,
  with no wizard-only model setting.
- `tests/architecture/one-model-option-source.test.ts` (row 193's SOURCE SCAN,
  extended): the whole mount population by file and count (TopBar 1,
  settings-section 5, persona 1, IdeaBoard 1, ChatSidebar 1, SetupWizardDialog
  1), `ModelInput`/`ModelPicker` absent from `src/` and both deleted files gone,
  `recentModels={` at exactly the three global-chat mounts, and
  `recordRecentChatModel(` at exactly the widget, the repo definition and the run
  funnel. A new copy or a dropped-through inline picker reds.
- Row 193's behavioural pins (`model-picker.test`, `recent-chat-models.test`,
  `settingsRepo.test`, `runEngine.test`) pass UNCHANGED — recency order, cap and
  dedupe included; the trigger's testids and their `waitFor`-on-the-asserted-field
  discipline are kept.

**Injected RED, watched (four arms, the changed file's hash PRINTED by `git
hash-object` for every arm and the tree restored from an out-of-tree pristine
copy by a `trap` before the next arm — no two arms identical, no VOID arm;
baseline hashes `model-widget.tsx` `4768ffe29a720cdcc63c5b813a8978f6fdb658a9`,
`settings-section.tsx` `c56faec9aed6c9a98b7ba423072f969409523c04`,
`SetupWizardDialog.tsx` `49c456cb5bd1e767d594d06cd6aaaa9737f2d9e1`, all three
re-hashed identical after the last arm):** **A** baseline → **GREEN 3 files / 28
tests**; **B** the shared panel's free-form `Use "…"` group removed
(`model-widget.tsx` `db363385fa161caa6db9ac0fc6074934f609fd9d`) → **RED 2** —
BOTH variants' free-form pins; **C** `recentModels={current.recentChatModels}`
dropped at the Settings chat-model mount (`settings-section.tsx`
`86221c1eceb55141f79e9371447da185d3de383e`) → **RED 2** — the architecture
placement scan AND the Settings-page placement pin; **D** the wizard field's
`onChange` write removed (`SetupWizardDialog.tsx`
`dda97fc3a5d4ae4fe81af731c1de63e737fc7b4f`) → **RED 1**, exactly the wizard pin.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** jsdom asserts definitions, not
a rendered page, so no pin proves the two variants LOOK right side by side (they
prove each renders its own shell and both share every behaviour behind it); the
canvas-chat sidebar's "no recents" is proven by its model source being the
session-only `useCanvasChatStore.setModelSelection`, not the global setting, and
by the source scan that no mount outside the three passes `recentModels`; and no
test proves a real OpenRouter account returns any particular list (the fetch is
mocked, while its failure and its absence are the states pinned).

### The run-completion trigger for a restocked roster's portraits (docs/17 row 196, docs/11 §Module generation integration, docs/18 §2)

The owner's module switch ("generate mob encounter images") promised illustrated
encounters and they kept shipping cover-less, while the editor's own button
worked. The mechanism was a stale ROSTER, not a blind detector: the module sweep
snapshotted right after its entity batches and illustrated the Encounter Smith's
STUB roster; the unattended Cartographer restock that every fresh encounter
triggers then REPLACED it (`data.monsters`), and nothing re-enqueued the
creatures that only exist afterwards. The fix is ONE trigger at the
run-completion seam (`post-run-extras.enqueueAutomaticRosterPortraits`) plus ONE
seam for "run both portrait lanes" (`mob-portrait-queue.enqueueEncounterPortraitFill`,
which the editor's fill press, the module sweep and the trigger now all call).

- `tests/features/portrait-queues.test.ts`, describe `automatic roster portraits
  for a restocked encounter (row 196)` — four pins, each naming row 196:
  - **P1 (revert-proof integration)** — the REAL flow (module + Smith + the
    automatic Cartographer restock), the sweep deliberately ABSENT: the map
    queue settles with the 4-room/4-entry fresh population, and then the FINAL
    roster's `planMobPortraitBatch(...)` reports `missing: []` with a non-empty
    `imaged` set. Deleting the automatic branch from `runPostCreateExtras`
    leaves `missing: ['Kuo-toa']` forever — nothing else in that test enqueues a
    portrait — which is the RED this pin exists for. The restocked creatures are
    inline-statblock entries, so they ride the INVENTED lane (MEASURED by the
    differential below: dropping that lane reds P1/P2/P3, dropping the cited lane
    is a VOID probe), and the fixture brief carries non-empty `notes` because an
    invented creature's roster notes ARE its prompt grounding — the ungrounded
    arm failed with exactly `"Kuo-toa" has no appearance, summary, or body to
    ground the image prompt`.
  - **P2 (DIFFERENTIAL)** — the portrait lane's image call is GATED so nothing
    has committed art while both arms are read over the SAME post-restock DB
    state: the trigger's ACTUAL enqueue set (`queued` + `active` job names,
    deduped and sorted) must EQUAL the editor's
    `planMobPortraitBatch(...).missing`, with BOTH arms asserted NON-EMPTY (two
    arms that do not differ are a VOID probe, never evidence). It also asserts
    no job carries `regen`. The gate blocks ONLY the portrait call —
    `encounterRunAdapters.generateImages` IS the `@/llm/imageGen` mock, so the
    map run's own stylize call (a prompt containing `battlemap`) resolves
    immediately while every creature portrait parks on the gate.
  - **P3 (no double work)** — over the illustrated roster, the fill seam run
    TWICE returns `enqueued: 0` both times, asks for ZERO additional
    generations (`generateImages` call count unchanged), sets no `regen`, and
    the sweep's own `encountersNeedingMobPortraits` no longer lists the
    encounter — so the automatic sweep and the completion trigger cannot
    double-book it.
  - **the module switch OFF arm** — the same real flow with
    `autoGenerateMobImages: false`: no portrait job is enqueued and the
    campaign's `creatureImages` table stays EMPTY (the map run's own image call
    is not a portrait, which is why this pin is the presentation table and never
    a raw `generateImages` call count).
- `tests/features/mob-portraits-section.test.tsx` — the editor's `fillMissing`
  now calls the ONE seam `enqueueEncounterPortraitFill`, so the mock and every
  batch-fill assertion moved with it (the per-entry invented action still calls
  `enqueueInventedCreaturePortraits` directly — it is NOT the batch fill, and
  the two are asserted apart).
- `tests/features/mob-portrait-module-gaps.test.ts` and
  `tests/features/module-post-generation.test.ts` — these spy the two LANES, so
  their `vi.mock` factory for the queue module gained
  `enqueueEncounterPortraitFill` as a composite that forwards to the two lane
  spies. The sweep's DECISION (which encounters, which switch, one failure per
  encounter) stays exactly what those files assert.

**A LATENT RACE THIS LANDING TIPPED, reported rather than hidden:**
`tests/features/model-picker.test.tsx`'s first pin asserted the trigger's model
text in the same beat as `findByTestId` resolved the ELEMENT, but `ModelPicker`
reads that text from an asynchronous `useLiveQuery` — so the barrier covered the
element, not the field it asserted (docs/17 row 132). It passed on `origin/main`
by a hair; this landing's extra module bindings moved the settings liveQuery
behind the element's first, model-less render and the pin reddened
deterministically (MEASURED: 5/5 GREEN with this landing's tree stashed, RED
with it — then GREEN after the one `waitFor`). The fix is a one-line barrier
around the existing assertion; nothing about the picker's behaviour changed.

**Injected RED, watched — every arm's changed-file hash PRINTED (`git
hash-object`), the suite lock held BEFORE any injection and the tree restored
from HEAD by a `trap` before the next arm (the restored hashes matched the
baseline exactly):**
- **A baseline** — `post-run-extras.ts`
  `ce2431197b152a7319ddd31a0e9bc187ae0b28fe`, `mob-portrait-queue.ts`
  `1508030e768088f72175627c27770460daca0b17` → **GREEN 4/4**.
- **B the trigger call removed** (`post-run-extras.ts`
  `9a448d33e540cdf8a7719e3da62e577fa9a9bd36`) → **RED 3** — P1, P2 and P3 all
  time out on the final roster never being filled. This is the revert-proof the
  pin exists for.
- **C1 VOID probe — the CITED lane dropped** from the fill seam
  (`mob-portrait-queue.ts` `c3bba6f0b71b4f5367d39cd767139e99c3a2b7d0`) →
  **GREEN 4/4, i.e. the arms did NOT differ: a VOID probe, never evidence.** It
  is recorded because it MEASURED a fact this fixture would otherwise hide — the
  restocked inline entries ride the INVENTED lane, so a cited-lane break is
  invisible here (the cited lane is pinned by `module-post-generation` and
  `mob-portrait-module-gaps` instead).
- **C2 the INVENTED lane dropped** from the fill seam (`mob-portrait-queue.ts`
  `4cbe7f3810eb92dd737498e8c2f2103df0c1a58a`) → **RED 3** — P1, P2 and P3. Both
  lanes of the ONE seam are therefore load-bearing, in the direction the fixture
  actually walks.
- **D the module switch ignored** (`post-run-extras.ts`
  `233e805eab27e8cfc1aa340d5c156473f750f3d5`) → **RED 1** — exactly the
  module-switch-OFF arm (portraits were generated for a module that switched
  them off).

### The import report names SPELLS, and the Spells page names WHICH empty it is (docs/17 row 204, docs/12 §15.4/§15.7, docs/05 §Rules/§Empty states)

The owner was sure he had imported PF2e spells, yet his Spells page was empty
and his NPCs had no spells — and nothing on screen could answer *"did my import
actually bring spells?"*, because the import report stated only a total chunk
count and `sectionsImported` MIXES journal pages, conditions, feats, spells,
actions and class features. The pins below name the spell lane on every report
surface and split the page's one generic empty state into the two corpus-level
cases (plus the unchanged filtered one).

- `tests/ingest/packs/pf2e-rules.test.ts` — the REAL rules-text fixture import
  (4 entries: 2 feats + 1 action + 1 SPELL) states `spellsImported === 1`
  beside `sectionsImported === 4`, so the count is not a rename of the mixed
  lane. A second pin is the CLASSIFICATION DIFFERENTIAL: the reported number
  equals the ONE count seam `ingest/packImport.spellsImportedFromChunks(chunks)`
  and equals the page's OWN `buildSpellRows(...)` entry rows for that book;
  then a payload-less `spell` chunk returns **0** from the seam (where a bare
  `chunkType === 'spell'` tally would return 1) and renders exactly one
  `data-error` row. That is what "the spell count" means: the rows the list
  will show, never a corrupt row counted as a spell.
- `tests/ingest/packs/dnd5e-foundry.test.ts` — the two REAL dnd5e spell
  fixtures report `spellsImported === 2`; `tests/ingest/packs/pack-import.test.ts`
  — a creature-only selection reports **0** (and `sectionsImported === 0`),
  the "fixture with none" arm.
- `tests/features/spells-page.test.tsx` (the existing page harness) — the THREE
  empty states, each with its own fixture and asserted on its RENDERED message:
  (i) no ready book of the campaign's system → `spells-no-material` + the
  import remedy (both systems, unchanged); (ii) a ready book of the system
  carrying only a `section` chunk (the pre-arc library) → the NEW
  `spells-no-spell-data` state naming the RE-IMPORT remedy and NOT the
  no-material one; (iii) one spell excluded by the tradition multi-filter →
  the unchanged `spells-filter-empty`, with neither corpus empty state present.
- `tests/rules-page.test.tsx` and `tests/features/bestiary-fetch-section.test.tsx`
  (the existing UI harness) — the per-lane breakdown
  (`0 spells · 1 stat block · 0 items · 0 sections`) is asserted in the manual
  import TOAST, the import SUMMARY dialog, the SETTINGS fetch toast and on the
  book CARD; a seeded pack book (packMeta `sectionsImported: 4`, 3 `section`
  chunks + 1 `spell` chunk) reads `1 spell · 0 stat blocks · 0 items · 3
  sections`, proving both the partition (the spell is not also counted under
  `sections`) and the LIVE spell lane (the stored `packMeta` has no
  `spellsImported`, so a `packMeta`-only card would have printed a false
  `0 spells`). The card's total (`4 chunks`) is kept.
- `tests/architecture/one-pack-lane-report.test.ts` (NEW, SOURCE SCAN) — the
  `formatPackLanes(` call-site population is exactly the formatter plus the
  four surfaces (`pack-import-dialog` ×2, `bestiary-fetch-section`, `RulesPage`),
  so a fifth surface that formats its own lane line reds.

**Injected RED, watched — the suite lock held from BEFORE the first injection,
the mutated file's hash PRINTED with `git hash-object` for every arm, and the
tree restored from out-of-tree pristine copies by a `trap` before the next arm;
every post-arm hash printed again and MATCHING its baseline, no two arms
identical:**
- **A baseline** — `packImport.ts` `1ca815d2fb4989f7fd467accd64360caefb47f3b`,
  `SpellsPage.tsx` `495fe0df764037f7758b0ebbfd468fec35794309`,
  `RulesPage.tsx` `739ed56928df6321ba8248f1e21777fef6ca1483` → **GREEN 7 files /
  93 tests**.
- **B `spellsImported` wired to the mixed `sectionsImported`**
  (`packImport.ts` `ffccffc25098fbb078feca012b1b73f926bd56c9`) → **RED 2** —
  exactly pin 1's real-fixture lane test (`expected 4 to be 1`) and the
  classification differential.
- **B2 the count seam made a bare `chunkType === 'spell'` tally**
  (`packImport.ts` `03e5718f4325b48e145686e4b0e1f7532f720573`) → **RED 1**,
  exactly pin 2 (`expected 1 to be +0`): a payload-less `spell` chunk is not a
  spell.
- **C the `spells-no-spell-data` state collapsed into the generic one**
  (`SpellsPage.tsx` `5c01e177686fb483e659ad9ab1394622a5dac8ca`) → **RED 1**,
  exactly the re-import-remedy pin.
- **D the book card's lane breakdown removed** (`RulesPage.tsx`
  `6c801856d03209872e5d6497af767f523e435a07`) → **RED 2**, exactly the two
  `book-lanes` card pins (the architecture call-site scan is textual and stays
  green under a rendered-out block, which is why the behavioural card pin is
  the load-bearing one).

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no pin proves the live spell
count matches a real on-disk library beyond the seeded chunk rows, and none
proves the empty-state copy reads well to a person — it proves which data
branch renders which message. The import's own behaviour (what is written,
`packMeta`, the chunk classification, the corpus read, the `ready` rule, the
page's filtering) is deliberately UNCHANGED and is pinned by the pre-existing
suites.

### An already-imported pack is stated in Settings — derived live from the library (docs/17 row 210, docs/16 §5/§7, docs/05 §Bestiary packs)

The owner could not tell an already-imported pack from an unfetched one on the
Settings → "Bestiary packs" card, so his imported spells were invisible until he
inferred them from an empty Spells page. Every recipe row now states its import
state, DERIVED FROM THE LIBRARY on each read (never a stored flag, which goes
stale on a rename/delete/re-import) — and the state is bounded by what the
library can PROVE: provenance, then an exact title, then the recipe's upstream
FOLDER name stated as its own BASIS (docs/17 row 281), and UNKNOWN when none
answers.

- `tests/features/bestiary-fetch-section.test.tsx` (the section's EXISTING
  harness; eight pins in a new describe, each seeding the REAL Dexie library
  through `createPackBook`/`finalizePackBook`/`putChunks` and driven through the
  real live read):
  - **pin 1 (provenance)** — a fetched book **renamed away from its label** (so
    provenance is the ONLY key that can identify it) reads
    `Imported — fetched 2026-09-16T11:04:00.000Z · 1 spell · 2 stat blocks · 0
    items · 0 sections` (the spell lane counted LIVE from a stored `spell` chunk)
    and offers `Re-import`, enabled, with `Re-import Pathfinder Monster Core` as
    its accessible name.
  - **pin 2 (title fallback)** — a manual book with NO provenance and the label
    as its title reads imported through the title key, `updated <its own
    updatedAt ISO>` (no fetch stamp exists, so the row does not claim one) and
    `0 spells · 2 stat blocks · 0 items · 1 section`.
  - **pin 3 (no match)** — with a ready pack book of ANOTHER adapter in the
    library (so the read provably answered), the recipe reads `Not imported
    yet.` with `Fetch & import`, enabled.
  - **pin 4 (ambiguous)** — TWO books matching by title read `Import state
    unknown — 2 books in the library match this pack (…), so which one to report
    cannot be decided.`, state NO lane text (never a pick), and keep the button
    enabled.
  - **pin 5 (system mismatch)** — a provenance-matched book stored `dnd5e`
    states `System mismatch: … stored as D&D 5e, but this source imports
    Pathfinder 2e — a Pathfinder 2e campaign will not see its content. Use "Set
    system" on the Rules page to correct it.`, with the imported state still
    stated beside it.
  - **pin 6 (action honesty)** — ONE render holds an imported recipe
    (`Re-import`) and an unimported sibling (`Fetch & import`), both ENABLED.
  - **loading** — synchronously after render the row reads `Checking the
    library…`, never `Not imported yet.`, and resolves to the real state.
  - **unidentified** — a manual import's derived slug title
    (`pathfinder-monster-core` as a book title) reads UNKNOWN (unidentified)
    with the lookalike named, NOT `Not imported yet.`
  - **pin 7 (the FOLDER basis, docs/17 row 281)** — the RULES-TEXT recipe
    (`foundry-pf2e-rules`, `packs/pf2e/spells`, label "Spells — ranks, cantrips,
    focus, rituals") with the manual-import-shaped candidate every earlier pin
    lacked (ready pack book, same adapter, NO `sourceUrl`, title `spells`) reads
    `Imported from a file — matched by the upstream folder name \`spells\` (no
    fetch provenance) · updated <its own updatedAt ISO> · 0 spells · 2 stat
    blocks · 0 items · 1 section` and offers `Re-import`. Every import-state pin
    before this one was BESTIARY-only, which is why the owner's spells book could
    read "Not imported yet." for a pack his library held.
  - **pin 8 (the folder key is NOT a wildcard)** — a same-adapter book titled
    after a DIFFERENT curated folder (`feats`) leaves the spells row at
    `Not imported yet.` with `Fetch & import`, so the new key cannot swallow its
    own adapter's rows.
- `tests/architecture/one-pack-lane-report.test.ts` — AMENDED: the
  `formatPackLanes(` call-site population now counts
  `bestiary-fetch-section.tsx` TWICE (its fetch toast + its new state line), so
  the new surface rides row 204's ONE formatter instead of re-spelling the
  lanes.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no pin proves the live library
matches a given on-disk library beyond the seeded rows; none proves the copy
reads well to a person (it proves which data branch renders which message); and
the UNIDENTIFIED arm is a heuristic by construction — it decides "looks like",
never "is". The class it genuinely cannot cover is a manual import whose title
is SILENT about the pack (a zip named `bundle.zip`): it matches none of the
three keys and no lookalike, so the row reads `Not imported yet.` — the case
row 281's FOLDER key narrows (a file named after the upstream folder is now
caught, with its basis named) but does not close, recorded in docs/17 rows 210
and 281 rather than hidden (the remedy is a re-import either way, and the action
stays available).

**INJECTED RED, watched — the suite lock held BEFORE the first injection, the
mutated file's hash PRINTED with `git hash-object` for every arm, the tree
restored from an OUT-OF-TREE copy by a `trap` (the work was uncommitted, so
`git checkout --` would have destroyed it) and re-hashed before the next arm,
no two arms sharing a hash:**

| injection (one file at a time, `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1`) | result |
|---|---|
| **A baseline** — `pack-import-state.ts` `268863a6534469c2467184c32b04f919cd484483`, `bestiary-fetch-section.tsx` `87081bb1ce8e2f52146acfe9ca07bceb1df9a952` | **GREEN 17/17** |
| **B the PROVENANCE key removed** (`if (provenanceMatches(…))` → `if (false && provenanceMatches(…))`) — `pack-import-state.ts` `0844add416164afc77882f348cd5a72e102aa8fc` | **RED 1**, exactly pin 1 (the renamed fetched book, which ONLY provenance can identify) |
| **C the AMBIGUITY collapse — first match wins** (`identified.length > 1` → `> 2`) — `pack-import-state.ts` `b36bb6646d5167c1545e06328f665319a06c0dc5` | **RED 1**, exactly pin 4 (two matches read imported instead of UNKNOWN) |
| **D the SYSTEM-MISMATCH state removed** (`systemMismatch: book.system !== expectedSystem` → `false`) — `pack-import-state.ts` `27fe402d461534cb17224ce8d3536e1d375a141f` | **RED 1**, exactly pin 5 |

No arm was VOID: all four hashes differ and every arm's RED named a different
pin. The five remaining pins (title fallback, no match, action honesty,
loading, lookalike) stayed GREEN under all four injections, so each pin owns
its own behaviour rather than riding another's.

**The row-281 arm (the FOLDER basis) was injected the same way, and the
revert-proven pair is printed as sha256:** deleting the folder arm from
`pack-import-state.ts` (`1f799dbf0ab0710c98428be64da9c3472c6cf68b99318c341534152987822c58`
→ `9d7de5e7b610ea48cda923192c0ba59085f4e5c58f1a8f208c5577fe8b6ade19` → restored
byte-identically to `1f799dbf…`) RED exactly **pin 7** and left **pin 8** GREEN
on the SAME injected tree, so the new key's positive and negative arms each own
their behaviour. The three hashes differ, so the arms are not VOID.

### A pack payload must agree with its adapter's declared system (docs/17 row 209, docs/12 §6, docs/18 §2.2)

A book's `system` is a CONSTANT per adapter (`packImport` writes
`adapter.system` at `createBook`) while the adapter's own payloads carry a game
system (`StatBlock.system`, `ItemData.system`, `SpellData.system`), and nothing
compared them — so a mis-chosen adapter could silently store a PF2e rules pack
as dnd5e, invisible to every PF2e campaign (the same invisible-state class as
rows 204/210, one step earlier). The pins below drive the REAL adapters and the
REAL fixtures and assert the refusal, the report line and the no-false-positive
rule together.

- `tests/ingest/packs/pack-import.test.ts` (the runner's EXISTING harness; the
  probes reuse the real adapters and real fixtures — no second fixture set):
  - **pin 1 (wrong adapter, both directions)** — a wrapper of the REAL
    `foundry-pf2e` parser declaring `dnd5e`, fed the real pf2e `baseNpc`
    document, hits the EXISTING zero-entry path (`finalized` empty) and the
    `failBook` message contains `charau-ka.json (Charau-ka): the stat block is
    for game system "pathfinder2e", but adapter "…" declares "dnd5e"` — entry,
    claimed system and declared system, all named. The mirror feeds the real
    dnd5e `ape.yml` under a `pathfinder2e` declaration and asserts the
    dnd5e→pathfinder2e sentence plus the adapter's OWN `entryNoun` (`no valid
    creature or spell entries`).
  - **pin 2 (a correct import is unchanged and says its system)** —
    `result.system === 'pathfinder2e'` for `foundry-pf2e` and `'dnd5e'` for
    `foundry-dnd5e-srd`, each equal to the `system` `createBook` was handed and
    with zero failures. The RENDERED line is pinned in
    `tests/rules-page.test.tsx` (`pack-import-system` reads
    `stored as Pathfinder 2e`, and the toast carries the same words) and in
    `tests/features/bestiary-fetch-section.test.tsx` (the fetch report).
  - **pin 3 (no false positive)** — the REAL `foundry-pf2e-conditions` fixture
    (`blinded.json`) is a plain `section` entry with NO structured payload, so
    it makes no system claim: it imports with zero failures,
    `sectionsImported === 1` and a `section` chunk. Absent is not disagreement.
  - **pin 4 (partial disagreement)** — a probe adapter emitting one
    `pathfinder2e` item beside one `dnd5e` item imports exactly the agreeing
    one (`itemsImported === 1`, one persisted `item` chunk), names every
    refusal (`file`, `name`, both systems) and finalizes `ready` with
    `entriesImported: 1` / `entriesFailed: 1` — the importer's existing
    per-entry policy, pinned rather than a new behaviour.
  - **pin 5 (row 204 unchanged)** — `tests/architecture/one-pack-lane-report.test.ts`
    still names exactly the formatter plus the four surfaces, and the lane
    strings (`0 spells · 1 stat block · 0 items · 0 sections`) are asserted
    unchanged in `rules-page` and `bestiary-fetch-section`: the system line
    rides BESIDE the breakdown, never inside it.

**INJECTED RED, watched — the suite lock held BEFORE the first injection, the
mutated file's hash PRINTED with `git hash-object` for every arm, the tree
restored by a `trap` FROM HEAD (the slice was committed first, so
`git checkout HEAD -- <path>` is the correct restore — never a bare
`git checkout -- <path>`, which restores the index), and the post-arm hashes
printed again and MATCHING the baseline:**

| injection (one file at a time, `NODE_OPTIONS=--max-old-space-size=2048 CAMPAIGNER_TEST_WORKERS=1`, the four report/runner files) | result |
|---|---|
| **A baseline** — `packImport.ts` `71c1ae6fcb6ce826bf898a6ca46abd6b9b5cc0ca`, `pack-lanes.ts` `566a95a89fa6c40fc0b51acd1f4bc0b63ef06411` | **GREEN 4 files / 46 tests** |
| **B the agreement check disabled** (`if (claimed === null \|\| claimed === adapter.system) return null` → `return null`) — `packImport.ts` `86776f4231007dd13a8253bee88430d2428fc0d7` | **RED 3 = exactly the refusal pins** (pin 1 in both directions and pin 4 — all three assert the LOUD refusal, so disabling the check reds all three) |
| **C the check made to fail on an ABSENT system** (the same guard → `if (claimed === adapter.system) return null`) — `packImport.ts` `0a27df0fe23dc2398f03180dfc4bff6d4eeaee92` | **RED 1 = exactly pin 3** (the no-claim conditions `section`) |
| **D the report's system line blanked** (`formatPackSystem` returning `''`) — `pack-lanes.ts` `7ef03bd3554c8fb3817a3d2b90fa9d0a84589032` | **RED 2 = exactly pin 2's RENDERED halves** (the manual report + toast in `rules-page.test.tsx` and the fetch report in `bestiary-fetch-section.test.tsx`; the ingest-level `result.system` stays green, which is why both halves are pinned) |

No arm was VOID: the mutated files' four hashes are distinct and three
different pin sets reddened. The restored hashes matched the baseline exactly
(`71c1ae6f…` / `566a95a8…`), so no injection survived its arm.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** the check compares the systems
payloads CLAIM — it does not detect a system from a document's own shape, so an
adapter whose mapping stamped a wrong literal in BOTH its payload and its
declaration would still agree. No pin proves the copy reads well to a person.
What is deliberately UNCHANGED — every adapter's emitted payloads and declared
`system`, every parse schema, `packMeta`, the row-204 lane counts, the corpus
read and row 207's scoping — is held by the pre-existing suites.

### The generation reads are scoped to the campaign's game system (docs/17 row 207, docs/12 §15.1, docs/11 §Module-side cast, docs/18 §2 rows 136/160)

The owner asked whether a dnd5e pack changes what a Pathfinder campaign
generates. It did, in exactly THREE generation reads, while the spell corpus,
the run retrieval, the encounter roster and the item pool were already scoped:
the module PARTS rule excerpts (`ruleExcerptSection` called `searchRules` with
no `system`), the module creator's bestiary window (`collectCreatorRoster` →
`listLibraryCreatures()`), and the CAST that resolves the window's request
(`entity-batch.libraryCitationForEntity`, the dangerous half — it could resolve
a dnd5e stat block INTO a pf2e npc). The fix threads ONE optional `system`
through the ONE creature pool (filtered by the OWNING BOOK's system, the books
read once and indexed by id) and through `searchRules`'s existing option; the
global Rules page, bestiary browser and wiki-link publisher stay deliberately
unscoped.

- `tests/llm/moduleGen.test.ts` — the existing PARTS harness with REAL retrieval
  (nothing mocked at the search boundary): two READY rules books, one per
  system, each carrying the part synopsis's own tokens (`low tide`) plus a
  system-distinct marker sentence, so an UNSCOPED search of the same synopsis is
  asserted to return BOTH markers (the non-vacuity half). A pf2e module's PARTS
  prompt carries the pf2e marker and NOT the dnd5e one; the dnd5e campaign is
  the mirror. The byte no-behaviour-change pin is in the same test: a fresh,
  identical pf2e campaign/module built against the own-system-only library and
  one built AFTER the dnd5e book is installed produce the SAME prompt bytes.
- `tests/llm/creatorRoster.test.ts` — the existing window harness with one
  creature that exists only in its own system's book:
  `collectCreatorRoster(3, 'pathfinder2e')` offers only the pf2e creature, the
  mirror holds, and the unscoped call still lists both. The same file pins the
  UNSCOPED decisions: `wikiLinkCreatures()` and `listLibraryCreatures()` return
  every system's creatures.
- `tests/features/entity-batch-creature-book.test.ts` — the existing cast
  harness drives `libraryCitationForEntity` DIRECTLY: the pf2e cast of the
  dnd5e-only name REJECTS, and the message names the entity «Aunt Agatha», the
  creature «Beholder» AND the scope (`no creature of that name for Pathfinder 2e`);
  the same-system cast resolves in both directions; a caller passing NO system
  keeps the pre-207 every-book pool (the pre-207 exact-sentence pin in the same
  file is untouched and still green).
- `tests/bestiary/roster.test.ts` — the UI decision, behaviourally: one
  `buildBestiaryRows` call over a dnd5e AND a pf2e book lists both systems'
  creatures, so the browser's global design cannot be scoped silently.

**Injected RED, watched — the suite lock held from BEFORE the first injection,
each mutated file's hash PRINTED with `git hash-object` for every arm, and the
tree restored from OUT-OF-TREE pristine copies of the changed files inside a
`trap`; every post-arm hash printed again and MATCHING its baseline, no two arms
identical:**

- **A baseline (no injection)** — `creatureRepo.ts`
  `c862eda121b86db588b028f60ce387d50f8c83a9`, `creatorRoster.ts`
  `adae436d521a55e68a7e85c03f8282904e628aea`, `moduleGen.ts`
  `807fcc570965ee9b67b75668ad64ca1df06969da`, `entity-batch.ts`
  `4dfb30194ade2e3747d3fb46ddc8de5ae4ff6f43` → **GREEN 5 files / 156 tests**
  (the four files above PLUS `llm/moduleGen-cast.test.ts`, whose two pre-existing
  `'no creature of that name'` pins stay green because the scoped clause is
  APPENDED after that substring).
- **B the search scoping removed** (`ruleExcerptSection`'s `system` dropped from
  the `searchRules` options) — `moduleGen.ts`
  `d0f31e1d939ca3a0639d092ec455c566e4a21f5f` → **RED 2**, exactly the two new
  PARTS pins: the byte comparison (`expected 'Campaign: Emberfall (Pathfinder
  2e)…' to be '…'` — the dnd5e marker leaked into the pf2e prompt) and the
  mirror (`expected '…' not to contain 'PF2E-ONLY-RULE'`).
- **C the pool scoping removed** (the owning-book filter line deleted from
  `listLibraryCreatures`) — `creatureRepo.ts`
  `fff429ff40644342273bba5a2f562dd1714db981` → **RED 5**: both window pins
  (`expected [ 'Goblin Warrior', 'Beholder' ] to deeply equal [ 'Goblin
  Warrior' ]` and the mirror), the missing-book pin, and both cast-refusal pins.
- **D the loud refusal replaced by a silent drop** (the no-such-creature throw
  becomes `return null`) — `entity-batch.ts`
  `2dfd173214daaf77565c093dd6dbc677e186d2ab` → **RED 6**: the two row-207 cast
  pins plus the four pre-existing refusal pins (a silent drop defeats every
  "this must NOT resolve" pin, which is exactly why the loudness is
  load-bearing). Restored byte-identically after every arm (hashes printed again
  and matching), tree clean.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** every pin drives the REAL
pools, retrievals and DB rows over fake-indexeddb but mocks the model transport,
so what is proved is which bytes a prompt carries and which citations resolve —
never a live model's obedience; the "only its own system's books" property is
proved over SEEDED books, not over an owner's on-disk mixed library; and no pin
proves the library UI's items/pack titles read well to a person. **The
already-scoped reads (spell corpus, encounter roster, item pool) and the
already-recorded citation resolution are deliberately UNCHANGED and stay pinned
by their pre-existing suites.**

### The spell vocabulary is a per-group random sample, and the caster clause counts 2 per level (docs/17 row 211, docs/11 §Mob spells, docs/18 §2.2)

The owner refused the 300-line prefix — *"limiting to 300 leads to whole spell
levels no longer present"* — and asked for *"a random sample of half the
available spells"* for each applicable level, plus *"just 2 spells of each
applicable level"*. The prefix is gone; the per-group sample and the count are
the pins.

- `tests/domain/mobSpells.test.ts` (EXTENDED; node project, `nodeTestGlobs`):
  - **no hidden level**: 120 spells at each of ranks 1–6 plus a ONE-spell rank 7
    (and cantrips stored at rank 1/0) — every rank has a line, each full rank
    exactly `ceil(120 / 2) = 60`, and `R7-Only — Rank 7` survives; the 10
    cantrips form ONE group (5 lines) and none of them counts as `Rank 1`,
    though PF2e stores it there.
  - **the half rule**: groups of n = 1/2/3/5/120 yield 1/1/2/3/60.
  - **no cap, no note**: the sampled list exceeds 300 lines and
    `formatMobSpellSection` renders no `TRUNCATED`.
  - **injected randomness**: two identical fixed sources are byte-identical;
    two different sources over one corpus differ — the owner's
    attractor-breaking property, asserted as a DIFFERENCE so an accidentally
    equal pair cannot pass.
  - **dedupe**: a corpus carrying "Animate Dead" from two books (different
    casing) offers it once, first wins; a removed dedupe offers three lines
    where two are due.
  - **offer vs permission**: a corpus spell the draw did not offer still
    resolves through the FULL-corpus index with no issue, while an invented name
    is still a loud unresolved issue naming the spell and the mob.
- `tests/architecture/one-spells-shape.test.ts` (EXTENDED, SOURCE SCAN):
  `MOB_SPELL_VOCABULARY_LIMIT`, `MOB_SPELL_TRUNCATION_PREFIX`,
  `MOB_SPELL_TRUNCATION_SUFFIX` and `the list is TRUNCATED` appear in NO `src/`
  file — the dead window cannot return unnoticed.
- `tests/llm/mob-spells-lanes.test.ts` (EXTENDED): the caster clause the model
  sees states `2 cantrips, then 2 spells of each rank (spell level) up to the
  highest it can cast`, keeps the `spellDC`/`spellAttack`/`tradition` fields,
  and no longer carries the open-ended `cantrips plus the spells its level
  allows`. The no-corpus goldens (`statblock-no-corpus.txt`,
  `npc-draft-no-corpus.txt`) stay byte-identical. The encounter-draft and
  Cartographer WITH-corpus goldens were re-verified, NOT regenerated: their
  seeded corpus is one cantrip group of one and one rank group of one, where the
  half rule is a no-op and the group order is unchanged — the brief's
  expectation that those goldens move did not hold, and regenerating them would
  have hidden that the lane corpus is too small to exercise the sample at all.

**Injected RED, watched (hash-printed arms under one lock; the tree restored
from a saved baseline by `trap` and the restoration PROVED by hash;
`src/domain/mobSpells.ts` baseline `f151f5d2d72206752e2d514022ebddc87ad5cd87`):**
A baseline **GREEN 41**; B the `max(1, …)` guard removed (`bcfaf681…`) →
**GREEN 41, VOID** — `ceil(n / 2) ≥ 1` for every `n ≥ 1`, so the guard is
redundant and its removal changes no behaviour (the brief's arm premise is
wrong; the meaningful probe is the ceiling); B2 `Math.floor(n / 2)` with NO
guard (`05c49f6e…`) → **RED 3**: the one-spell rank 7 gone, the half rule's
n = 1 group empty, and the single-spell corpus empty; C all groups flattened to
one key (`34b9cab5…`) → **RED 2**: rank 1 vanished and the group sizes became
corpus shares instead of per-group halves; D the dedupe removed (`37968670…`) →
**RED 1**: the duplicate spelling appears (3 lines where 2 are due); E `ceil` →
`floor` with the guard kept (`073d7775…`) → **RED 1**: the half-rule sizes 3/5
come out 1/2. The restored hash after every arm and at the end is
`f151f5d2…`, byte-identical.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves a live model
picks a good (or even a legal) two-per-level set from the sample — it proves the
bytes the model was offered, the count the clause states, and that the
resolver's permission is untouched; the random sample is exercised through its
pure function with injected sources, never through a real `Math.random` draw (a
statistical property is not provable in a unit test); and the recorded trade-off
(a module-named spell can fall outside the draw) is the owner's choice, not a
defect this suite can measure.

### A module's NAME is editable at creation — the field, the ONE seam, the additive draft (docs/17 row 213, docs/08-MODULE-DESIGNER §M4-B, docs/18 §2.3)

The owner's report — every new module was called "New Module" and the creation
dialog had no way to name it — is pinned at the dialog, the schema and the
source, using the EXISTING harnesses (no new fixture set):

- `tests/features/new-module-draft.test.tsx` (the draft prefill/persist/flush
  suite): (1) the `new-module-title` field renders pre-filled with
  `defaultModuleTitle()` and typing changes it; (2) a typed name reaches the
  `NewModule` input the dialog hands `createModuleAndRun` as the title (the
  harness intercepts that input — `@/llm/moduleGen` is mocked) AND the stored
  draft carries the same value; (3) a whitespace-only field creates
  `defaultModuleTitle()`, never `''`, with no toast, and the draft stores the
  RESOLVED value so `title: min(1)` cannot fail on a debounce; (4) the typed
  name survives the close/reopen draft cycle and PREFILLS; (5) a
  `newModuleDraftSchema` parse of an object with NO `title` key yields the
  placeholder while a WITH-title draft keeps it, and a dialog opened on such a
  legacy row prefills the placeholder with no "could not be read" toast;
  (5b) deleting a MODULE leaves the draft intact, so the next open prefills the
  name (the owner-ratified regeneration workflow — measured: only campaign
  deletion clears the tagged draft); plus the row-162 pin that
  `defaultModuleTitle()` still returns `'New Module'`.
- `tests/features/module-ui-toast.test.tsx` (the dialog-open/start suite): the
  dialog renders the Name field with the placeholder — visibly editable, with a
  testid distinct from the reader's `module-title`.
- `tests/architecture/module-title-seam.test.ts` (NEW, source scan): the
  "exactly one" pin (AGENTS §Centralization 2) — `export function
  resolveModuleTitle(` is defined in exactly ONE file, `resolveModuleTitle(` is
  called from exactly TWO sites in `new-module-dialog.tsx` (the draft's saved
  value and the creation input), and the dialog contains no
  `title: 'New Module'`/`title: "New Module"` literal, so a re-inlined literal
  or a second resolver reds.

**Injected RED, watched (each arm's changed file hash printed by `git hash-object`,
the tree restored from an OUT-OF-TREE copy under a `trap` with the post-restore
hash re-verified equal to the baseline — the slice was still uncommitted, so a
`git checkout HEAD --` would have restored the WRONG bytes; the row-210
precedent):** A baseline — `domain/module.ts`
`e5b48f27a1edd50dc9af8ce36bd320ade05b1f5f`, `domain/settings.ts`
`4e0aafc4850132d50f43a2853de1682cba28a3ec`, `new-module-dialog.tsx`
`f2cba85989e01c172fe71e872dec6bc54ae5d466` → **GREEN 3 files / 57 tests**. B the
resolver's blank arm forced to `''` → `module.ts`
`c03d914d5a56e43dec2ac33c4af69ea65a3dc710`, **RED 1 test (pin 3) with 2 failed
assertions**: the creation input title is `''`, and — the coupling worth naming —
the debounced draft write fails LOUDLY (`toastError('The New Module draft could
not be saved', …)` carrying a ZodError `too_small` on `newModuleDraft.title`),
which is the pin's `expect.soft` no-toast half. C the dialog's creation arm
re-inlined to `title: 'New Module'` → `new-module-dialog.tsx`
`9aba588dba4429106773087860835c8267e9f95b`, **RED 3** = the carry pin (the typed
name no longer reaches the input) plus BOTH seam-scan tests (the dialog call-site
count drops to 1 and the literal is found). D the schema's `.default` removed →
`settings.ts` `386052b3e1377c11214db6cd65b5c0795d3c7c14`, **RED 2** = both halves
of pin 5 (the bare parse throws on the missing key, and the dialog's
legacy-prefill pin — which waits for the stored CONCEPT to prove the read really
happened — times out because the refused draft opens at defaults). No arm was
VOID (four distinct changed-file hashes, four distinct red sets) and every
restored hash matched its baseline exactly.

**WHAT THESE PINS DO NOT PROVE, stated plainly:** no test proves the owner sees
the field where he looks (it is asserted present and pre-filled, not
screenshotted); no test proves a live `createModuleAndRun` beyond the input the
dialog hands the mocked generator (that the real `createModule` stamps the title
on the row is covered by the rows above; the dialog's own seam stops at the
input); and the prefill-is-good call is the owner's, so the suite pins the
BEHAVIOUR he ratified, not that a second module starting from the previous name
is desirable in general.

### The seven pack-adapter promise wrappers are ONE seam (docs/17 row 214, docs/12 §15, docs/18 §2)

The duplicate-body tripwire's first `src/` inventory held group
`4849c733c9136aa8` with seven sites, all named `parseFile` — every pack adapter
hand-wrote the same promise-wrapper around its own synchronous `parseFileSync`.
The parsing is per-lane and genuinely different; the wrapper was one idea, so
row 214 folds it into `ingest/packs/types.asPackFileParser` (beside the
`PackAdapter` contract it enforces, not in the document-conventions module
`text.ts`) and each adapter keeps its identical exported surface through one
line: `const parseFile = asPackFileParser(parseFileSync);`. The fold's own proof
is the tripwire's stale-entry red, watched BEFORE the baseline line was deleted;
the per-idea pin is a source scan, because a folded group cannot guard against a
member coming back alone — the tripwire only sees a verbatim second copy.

**Matrix**

| Surface | Covered by | State |
| --- | --- | --- |
| **The promise wrapper is defined exactly once**, in `types.ts`, and non-vacuously carries both arms (the resolve of the sync result and the non-`Error` rejection rewrap) | `tests/architecture/one-pack-file-parser.test.ts` (2 pins) | ✅ REVERT-PROVEN (arm C) |
| **No adapter may re-spell the wrapper** — no `Promise.resolve(parseFileSync`, no `instanceof Error ? error : new Error(String(error))`, no revived `function parseFile(` outside the seam | same | ✅ REVERT-PROVEN (arm C) |
| **All seven adapters import the seam and call it exactly once**, and no eighth file reaches for it | same | ✅ |
| **The tripwire's `src/` population no longer holds the group**, and the stale baseline line was DELETED only after its red | `tests/architecture/no-duplicate-implementations.test.ts` (baseline `14 groups / 32 sites`) | ✅ REVERT-PROVEN (arm B) |
| **Every adapter's parse behaviour is unchanged** — mapping, schemas, failure shapes, skip counting, and the rejection path through the real adapters | the existing per-adapter/lane suites, untouched (below) | ✅ REVERT-PROVEN (arm D) |

**Pin table**

| Pin | File | What it would catch |
| --- | --- | --- |
| `defines the ONE seam in types.ts, and proves the needles can see it` | `tests/architecture/one-pack-file-parser.test.ts` | the seam deleted or moved, or a copy that reuses either wrapper line in another pack file — arm C |
| `has every adapter call the ONE seam, and no other file that does` | same | one adapter dropping its seam call (re-spelling the wrapper), or an eighth file reaching for it |
| `matches the checked-in baseline exactly` | `tests/architecture/no-duplicate-implementations.test.ts` | the stale `4849c733c9136aa8` line surviving the fold — arm B; and a verbatim copy returning at 2+ sites |
| `.rejects` assertions through each REAL adapter (`empty`/`unparseable` inputs) | `dnd5e-equipment.test.ts`, `dnd5e-foundry.test.ts`, `pf2e-equipment.test.ts`, `pf2e-foundry.test.ts`, `parse-docs.test.ts` | the seam's rejection arm swallowing a sync throw — arm D |

**REVERT-PROVEN** (each arm's changed-file `git hash-object` PRINTED, restored
by a `trap` from HEAD, raw logs in `/tmp/parsefile-logs/`; no arm VOID):

- **A — baseline after the fold.** detector + the new source scan + the whole
  `tests/ingest/packs/` suite → **14 files / 242 tests passed**. Folded-file
  hashes: `types.ts` `e67c1c118e5e388d0ba765bc44e2fbabe9e044f8`,
  `pf2e-journal.ts` `7c12a2044dd075088640189e7b15e6038940dc2a`,
  `pf2e-conditions.ts` `17fa6ed766aab9d047aaada941f9bf6b09b89cec`; the new pin
  `331cbe077c5e5dee94f8d4dda374ce57941442db`.
- **B — the fold with the stale baseline line still present**
  (`duplicateImplementationsBaseline.json` hash
  `66313f19227063cd5c4e58f6d0ea3d69b1b47fab` BEFORE the deletion) → the detector
  **RED 1 / 19 passed**, printing `STALE BASELINE ENTRY — 4849c733c9136aa8
  [all seven src/ingest/packs/…:parseFile sites] no longer matches any duplicate
  group`. This is the fold's own proof. Folded sources at that arm:
  `29153af6fed73d948b9707d20a175fb59d1a3c51` (dnd5e-equipment),
  `3b923512d813bce97038a1110734c771902b5460` (dnd5e-foundry),
  `2a95b72aa442ae1aee68bda8280150a778d4d456` (pf2e-equipment),
  `97237a09f33147a85dbea711f4c59d25b9999311` (pf2e-foundry),
  `0043dd2b9650f79f0f29b84255f24110146a87ee` (pf2e-rules).
- **C — the wrapper pasted back into ONE adapter under another name**
  (`pf2e-journal.ts` `7c12a2044dd075088640189e7b15e6038940dc2a` → injected
  `37359b273a4bc7ac04bd5acce74a833942b8686b`) → the SOURCE SCAN reds **1 failed
  / 19 passed** naming the file and the `Promise.resolve(parseFileSync` needle,
  with the DETECTOR GREEN — the single-site class the tripwire structurally
  cannot see. Pasted into TWO adapters (adding `pf2e-conditions.ts`
  `17fa6ed766aab9d047aaada941f9bf6b09b89cec` → `b8a76fd31d034a2d2448758835ed605095952b99`)
  → the detector reds **NEW DUPLICATE — shared normalized body
  `4849c733c9136aa8` (180 chars)** at the two `parseFileLegacy` sites AND the
  source scan reds (**2 failed / 18 passed**), so both pins have teeth.
- **D — the seam's rejection arm made to swallow** (`types.ts`
  `e67c1c118e5e388d0ba765bc44e2fbabe9e044f8` → injected
  `963bbad293c986a2f3f1345449883a8414fb552f`, the `Promise.reject` replaced by a
  resolved empty `PackFileParse`) → **5 files / 7 tests failed, 215 passed**: the
  per-adapter `.rejects` pins (`dnd5e-equipment`, `dnd5e-foundry`,
  `pf2e-equipment`, `pf2e-foundry`, `parse-docs`), so a failure-path pin DID
  already exist and none was added. Every restored hash equals its baseline and
  `git status` names only this slice's files.

**WHAT THESE PINS DO NOT PROVE:** the source scan is textual and
comment-blind — a wrapper composed at runtime or reached through an
intermediate helper is invisible to it, and a paraphrase that avoids both needle
lines would pass it; the tripwire side catches only an exact verbatim second
copy. The behaviour claim rests on the untouched per-adapter suites, not on the
scan.

**GATE — RAW NUMBERS.** `bash scripts/gate.sh` from the worktree, raw log
`/tmp/parsefile-logs/gate.log`, chunk logs `/tmp/parsefile-logs/gate-chunks`:
**GATE GREEN, exit 0 — 344 files / 4450 tests**, `chunk arithmetic: 344 of 344
test files covered`, lint **0 errors**, typecheck clean, **no `Errors:` line**,
peak RSS of any single chunk **1231 MB**, combined peak **2341 MB of the 3000 MB
cap**. This slice adds **+1 file / +2 tests** (the new source scan; the baseline
JSON change adds no test).

### Remaining gaps

1. **Monster source UI** (`monster-source.tsx`) — the source selector, NPC
   combobox and inline-stats dialog are mounted (editor tests render the
   encounter form) and the resolve pipeline is repo-tested
   (`encounterResolve.test`). The rulebook stat-block search dialog IS now
   driven end to end (`tests/features/monster-source-citation.test.tsx`, added
   by docs/17 row 155 — real search, real book, real pick); the remaining three
   controls are still not. Next task when touching M3-B: add
   `tests/features/monster-source.test.tsx` for the selector/NPC/inline paths,
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

`bash scripts/gate.sh` is THE one way the suite runs (AGENTS §Host hygiene 7) —
never a hand-rolled `vitest run`. The test step fails on console noise, routes
that stop mounting, and Base UI composition regressions; the script takes the
atomic suite lock, refuses to start while any other suite (ours or the owner's
other DSH project's) is running, and prints the summed counts with each chunk's
wall time and peak RSS.

**Two chunks at once, one worker each (docs/17 row 175).** The five directory
chunks of the old gate are now SEVEN: `tests/features` — half the gate on its own
— is split round-robin into `tests_features_a` and `tests_features_b` so the two
long poles overlap, and at most TWO chunks run concurrently, each in its OWN
process group (`setsid`). The config bound is unchanged: `vite.config.ts` defaults
`maxWorkers` to `DEFAULT_TEST_WORKERS` (2, ledger row 94) in the file AND in each
`test.projects` entry, so a bare `pnpm exec vitest run` cannot exceed it and a CLI
`--maxWorkers=N` cannot raise or lower it (it lands on the root config, which each
project's own value overrides). `CAMPAIGNER_TEST_WORKERS=<n>` remains the one
explicit way to raise it for a run that owns the machine, and a mis-set value
fails loudly rather than silently defaulting.

**The MEMORY half of the bound is a top-level `execArgv`, and a live probe pins it
(docs/17 row 229).** `vite.config.ts` sets
`execArgv: ['--max-old-space-size=1536']` (`TEST_WORKER_HEAP_CAP_MB`) at the root
and in each `test.projects` entry. The pre-vitest-4 `poolOptions.forks.execArgv`
spelling is INERT under vitest 4 — nothing reads it, and it is absent from
vitest's types, so `tsc -b` (which does typecheck `vite.config.ts`) cannot see its
loss: measured, the dead spelling left a worker at its 4144 MB default where the
declared one measures 1584 MB. `tests/lib/test-workers.test.ts` therefore probes
the LIVE `v8.getHeapStatistics().heap_size_limit` of the worker it runs in AND
that `process.execArgv` carries the cap — under this gate's own
`NODE_OPTIONS=--max-old-space-size=1536` the limit comes out capped either way, so
only the second arm reds there, and only the first reds for a bare run.

The default test timeout is 20
seconds. `GATE_PARALLEL_CHUNKS=1 bash scripts/gate.sh` forces the gate back to
sequential.

**The watchdog sums every live chunk.** It samples the combined RSS of all live
chunks' process groups every second and kills ALL of them at `GATE_RSS_CAP_MB`
(3000) or when available memory drops below `GATE_AVAIL_FLOOR_MB` (2500); a killed
chunk is VOID, is re-run SEQUENTIALLY and is never counted. If the combined peak
only approaches the cap (90% of it by default) the gate falls back to sequential
before the kill line and says so in the summary.

**The diff decides the ORDER, and exactly two skips are allowed.** Every run checks
the chunk arithmetic (the union of the chunk file lists must equal the test files
under `tests/` with no path twice). The diff base is `origin/main` (three-dot)
plus the working tree; the chunks a diff touches run FIRST, so a red surfaces in
one or two minutes instead of twelve. Vitest is skipped ENTIRELY only for a
docs-only diff (lint and typecheck still run), and a diff that touches test files
ALONE runs only the chunks that contain them. Every other diff runs the full set —
there is no other skipping, because a gate that guesses at coverage is the failure
mode this refuses. `b84d074` had raised the old worker count from four to six (the
suite is file-parallel and was leaving half the machine idle); row 94 superseded
that with the bound above, after a bare unbounded run twice outlived its writer —
and because jsdom plus PDF/image workers otherwise starve event loops on
constrained CI/agent VMs.

### The image prompt's grounding cap is ONE owner-set constant (docs/17 row 223)

The 800-character cap the composer had inherited is gone: `IMAGE_PROMPT_GROUNDING_MAX_CHARS = 10_000`
(`src/llm/imagePromptDraft.ts`) is used by BOTH capped sites — the composed prompt's `Description:` line and
`portraitGroundingForChunk` — and both pins now assert against the constant, not a literal.

| Pin | What it holds | What reds it |
|---|---|---|
| `caps the stripped description at the ONE owner-raised cap` (`tests/llm/imagePromptDraft.test.ts`) | a body longer than the cap yields exactly `IMAGE_PROMPT_GROUNDING_MAX_CHARS` characters in the prompt | re-hardcoding a smaller number at the slice site |
| `keeps a grounding shorter than the cap COMPLETE` (same file) | a 1,000-character body is present VERBATIM — the reported regression: it used to lose its last 200 characters | restoring an 800 cap anywhere |
| `caps the composed grounding deterministically at the ONE owner-raised cap` (same file) | the portrait grounding is pure and exactly the constant long when it overflows | a second cap value, or a non-deterministic build |

Owner decision, verbatim (2026-09-17): *"I never authorized a cap and i would have vehemently opposed such a low
one. So thats why some details get ignored. Please raise the cap to 10k. Most image models can do much more than
that."* Unchanged and named in the ledger: the cut is still SILENT when it bites (surfacing it is its own slice),
the `appearance` shortcut stays uncapped, and the non-image length budgets (`runEngine` persona-context 800 /
encounter-pool 600, `wikilinks.surroundingParagraphs` 1200) were deliberately NOT touched — they are different
seams with their own markers.

### The image text-render guard no longer forbids text wholesale (docs/17 row 224, docs/11 §D5)

The owner reported that the guard he had asked for had become a BAN — a model he
instructed to make a legend refused to draw one. The bare Avoid terms `text`,
`letters`, `numbers`, `words`, `label` are DROPPED (an image model reads them as
"no text at all"), and the owner's positive clause `IMAGE_TEXT_SPARING_CLAUSE`
("Unless requested otherwise, use text sparingly.") rides the COMPOSED prompt of
both `buildImagePrompt` branches and of the classic-stylize battlemap template.
`long paragraphs of text` and `illegible or garbled or misspelled lettering` were
ADDED, so the original incident (the model captioning the whole plot) stays
guarded. The vision dungeon path's plaque clause and the classic battlemap's
owner-ratified usability hard-bans are deliberately NOT softened — both are
load-bearing in their own paths (below).

| Pin | What it holds | What reds it |
|---|---|---|
| `rides the composed prompt in BOTH builder branches, verbatim` (`tests/llm/imageTextGuard.test.ts`; the clause also rides the classic-stylize capture in the same file) | the owner's clause is present, with its exact words, in the `appearance` shortcut AND the name/summary/description grounding, and is NOT in the Avoid list; the classic battlemap prompt carries it too | removing the clause from either branch, or from the classic template, or moving it into `IMAGE_TEXT_NEGATIVE` |
| `forbids no text wholesale: no bare text/letters/numbers/words/label item` (same file) | a STRUCTURAL assertion over the Avoid list's comma-separated items — no bare `text`/`letters`/`numbers`/`words`/`label` item survives, with a non-vacuity floor on the item count. `toContain` over the whole string is NOT enough (`long paragraphs of text` contains the substring "text"), which is why the split is the assertion | restoring any bare item (the pin that would have stopped the reported defect) |
| `still names the proven failure modes` (same file) | the list still names the original incident's shapes — `long paragraphs of text`, `captions`, `explanatory text`, `plot summary`, `stat block`, `character sheet`, `watermark`, `signature`, `illegible or garbled or misspelled lettering` | deleting the guard instead of narrowing it ("no guard at all") |
| `lets a requested treasure map / legend / letter coexist with the guard` (same file) | for three requests (treasure map, labelled map with a legend, confession letter) and BOTH branches: the request is present, the clause VERBATIM (`Unless requested otherwise, use text sparingly.`) is present, and no forbidding Avoid item is | dropping the clause's "unless requested otherwise" half — the contradiction case |
| `puts the text-budget clause before the trailing instruction` (`tests/llm/imagePromptDraft.test.ts`) | the clause sits BETWEEN the grounding and `extraInstruction`, so a request that asks for text follows the "unless requested otherwise" it is the exception to | moving the clause after the instruction |
| `unifies the mob portrait name as an alias` + `keeps an explicit negative as the override (the option stays the seam)` (both `imageTextGuard.test.ts` and `imagePromptDraft.test.ts`) | `MOB_PORTRAIT_TEXT_NEGATIVE` is identical by identity to `IMAGE_TEXT_NEGATIVE`; a caller's own `negative` wins and an explicit `''` opts out | a second list for portraits; closing the override seam |
| the vision carve-out (`imageTextGuard.test.ts`, `keeps the room plaques while the blanket list stays ABSENT`) | the vision map still carries `no written text anywhere except the 2 letter plaques` and neither the blanket list nor `Avoid:` | adding the shared list or the sparing clause to the vision path |

**Moved prompt pins, named rather than blanket-re-baselined:** the four
`toEqual` prompt literals in `tests/llm/imageRun.test.ts`, the exact-prompt
literals in `tests/llm/imagePromptDraft.test.ts`, and the six `Avoid:`-prefix
substrings (`tests/db/mob-portrait-cache.test.ts` ×2,
`tests/features/portrait-queues.test.ts` ×4) — all moved ONLY by the
clause line or the list's new first item, and each re-derived from the composed
prompt. The cap pins now take the FIRST line after `Description: ` (the clause
rides its own line), so the 10,000-character assertion is unchanged in meaning.

**UNCHANGED and named:** the 10,000-character cap, the five-caller
`buildImagePrompt` registry, the `negative` override seam, the vision plaque
mechanism, and the classic battlemap's usability hard-bans (docs/11 D17). No
PDF/layout dump moved (no PDF-rendering suite or baseline was touched).

### The natural-site classic-stylize arm is pinned (docs/17 row 225, docs/11 §D17)

Row 224's verification found the gap: the classic-stylize template has TWO mode
contracts (architectural vs natural, docs/11 D17) and the only capture drove the
ARCHITECTURAL arm, so `IMAGE_TEXT_SPARING_CLAUSE` could be removed from the
`natural ? [...]` arm alone and the focused guard/draft suite stayed green
(34 passed; injected `runEngine.ts` hash
`dde93a76a52195e210f8d1b18ac8086fff1759f5`). On a fresh run `natural` is derived
from the Cartographer brief's `environment: 'outdoor'` through
`resolveEncounterMapMode` (no target ⇒ no owner `mapMode` override and no
persisted `locationKind`), so the capture is now ONE named helper
(`captureClassicStylizePrompt`) and a second pin drives it outdoors.

| Pin | What it holds | What reds it |
|---|---|---|
| `classic stylize (natural site) carries the sparing clause and its own prose contract, and never the architectural clauses` (`tests/llm/imageTextGuard.test.ts`) | the prompt the engine actually hands `encounterRunAdapters.generateImages` for a brief with `environment: 'outdoor'` carries `IMAGE_TEXT_SPARING_CLAUSE` VERBATIM; carries the natural `Theme:`/`Site:`/`Scene:` prose lead and the placement-only clause (the soft patches where creatures gather, the single approach triangle, the softened visible-approach-path entrance clause); and does NOT carry the architectural materials line, keep-walls clause or architectural entrance wording | removing the clause from the natural arm alone (arm hash `dde93a76a52195e210f8d1b18ac8086fff1759f5`), pasting the architectural materials/keep-structure line into it, or breaking the `environment: 'outdoor'` derivation |
| same pin, hard-ban half | the usability hard-bans survive in the natural arm — `no map legend`, `no text labels`, the pale-box/plaque clause and the continuous-terrain sentence — the owner's 2026-09-17 decision ("Battlemaps do not need text, so that restriction can stay.") | removing or softening any hard-ban in the natural arm |
| `classic stylize (architectural) falls back to the guard when the brief wrote no negative` (same file; the renamed original) | the architectural capture is unchanged and now also asserts the materials + keep-structure contract is present and the placement-only clause absent | removing the clause from the architectural arm, or leaking the natural clause into it |

### The Idea Board's conversation clears ROW FIRST, and its content survives (docs/17 row 227, docs/21 §The chat's controls, docs/18 §2.3)

The owner reported there was no clear-chat control on the Idea Board. The
control now lives in the chat column's header (`Clear chat`, accessible name
"Clear chat") and confirms through the shared `AlertDialog` primitive; the
clear itself is ONE seam, `features/idea-board/store.clearIdeaBoardChat()`,
which writes the persisted transcript to `[]` through the SAME
`saveIdeaBoard(next, expected)` compare-and-swap `flushIdeaBoard` uses — AWAITED,
row first — and only then empties the live store, cancelling the pending debounce
so it cannot re-serialize the cleared conversation. Six pins live in the EXISTING
idea-board page harness (`tests/features/idea-board.test.tsx`, whose mocked repo
keeps a `persistedRow`, so "the stored row" is asserted and not merely the
store).

| Pin | What it holds | What reds it |
|---|---|---|
| `offers a Clear chat control in the chat surface, and its dialog states the boundary` | the button's accessible name is `Clear chat` and it sits INSIDE the `idea-board-chat` column; the dialog copy names the saved conversation, `NOT cleared`, `DOCUMENT`, `Previous drafts`, `content, not conversation` and "not an undo" | removing the control, moving it out of the chat surface, or a dialog that does not state the boundary |
| `cancelling clears NOTHING — the store AND the persisted row are unchanged` | the cancel path leaves both `useIdeaBoard`'s transcript and `persistedRow.messages` at 2 entries and calls `saveIdeaBoard` ZERO times | a dialog that clears on OPEN (the classic bug), or a cancel wired to the clear |
| `confirming empties the conversation in memory AND on the persisted row, surviving a later flush` | the store transcript is `[]`, the UI is back to `Nothing asked yet.`, `saveIdeaBoard` was called with `messages: []` against the loaded snapshot, `persistedRow.messages` is `[]`, and a later `flushIdeaBoard()` cannot restore it | a store-only clear (the reload half), or a clear that leaves the pending debounce armed |
| `leaves the board DOCUMENT and Previous drafts byte-unchanged (a clear that wipes the board reds)` | `document`, `versions` and `model` are identical in the store AND on `persistedRow` after the clear | a clear that resets the board to a blank one (the non-vacuity arm: "clearing the chat" must not be "wiping the board") |
| `a failed clear write is LOUD and leaves the conversation intact` | `saveIdeaBoard` rejects once → `toastError` carries the exact "nothing was cleared" sentence, the store transcript keeps 2 entries, `persistedRow` keeps 2, and no success toast fires | a clear that empties the store before (or despite) a failed row write; a swallowed failure |
| `refuses LOUDLY while a refinement reply is in flight — nothing is cleared` | with a refinement parked, confirm toasts "still in flight", the typed instruction (3 entries) and the stored row (2) are untouched, and nothing succeeds | a clear that runs under a streaming reply (the canvas chat's refusal rule) |

**The seam is deliberately forked from the canvas chat, and the reason is in
the store's doc comment:** `clearChat.clearModuleChat` is module-keyed to
`patchModule(moduleId, { chatThread: [] })`, while a board has no module id and
its write is a whole-row compare-and-swap on the single `ideaBoards` row; a
shared parameterisation would be vague. The shared part is the PERSISTENCE seam
(`saveIdeaBoard`) and the dialog primitive, not the orchestration.

**REVERT-PROVEN, four arms, every arm's file hash PRINTED (`git hash-object`),
no two arms identical:** (A) baseline GREEN — `store.ts`
`792ea4df8352b3da076ed8283e75435a92af68ea`, `IdeaBoardPage.tsx`
`19c7bd3a87753093a72a6e99d8592036b13af790`; (B) the persisted clear REMOVED
(store only: `const next = cleared`) → `store.ts`
`0d2cb80b4d737ea280ee44af8acf1ace1c8e7a0e`, pin 3 (confirm empties the row) AND
pin 5 (a failed write is loud) red — with no row write there is nothing to
reject; (C) the clear also wiping the content (`document: '', versions: []`) →
`store.ts` `a3e6e8608092aff28c1f63e2f0bc113887cdc607`, pin 4 red; (D) the CANCEL
path wired to the clear → `IdeaBoardPage.tsx`
`d6c6a8aba81c0c9d0c519a6c05e98c3aab763848`, pin 2 red. Every arm was restored
from HEAD between runs (`git checkout --`) and the tree verified back at the
baseline hashes; the focused file ran under the suite lock, one worker,
`--max-old-space-size=2048`, raw logs `/tmp/arm-{A,B,C,D}.log`.

**UNCHANGED and named:** the board's send/stream/stop path and its 500 ms
debounced persistence (this adds a control, not a second chat), the repo's
compare-and-swap and its backup/export behaviour, and the canvas chat's own
clear (bytes untouched).
### The campaign export's zip is built through the ONE streaming seam (docs/17 row 276, docs/18 §2.1)

`lib/exportImport.buildZip` was the LAST caller of the synchronous `zipSync` in `src/` — the
debt docs/18 §5 recorded when row 265 cured the whole-DB backup. It is now ASYNC and rides the
same seam, which row 276 EXTRACTED out of `buildBackup` into `src/lib/zipStream.ts` so both
producers use it (one fflate `Zip`, one 1 MiB push slice loop, one MACROTASK yield).

| Pin | What it holds | What reds it |
|---|---|---|
| `yields to the event loop while the zip is packed (row 276 differential)` (`tests/lib/exportImport.test.ts`) | a MACROTASK scheduled BEFORE the build runs while the build is still in flight, and the finished archive is still the single-file export | a `zipSync` revert — `src/lib/exportImport.ts` `e125740d…` → `a0b4c0e6…` → `e125740d…`, `expected false to be true` — OR a microtask-only yield (`setTimeout(resolve, 0)` → `resolve()`): `src/lib/zipStream.ts` `1319693a…` → `4850f8de…` → `1319693a…`. Both arms restored byte-identically |
| `keeps zip construction in the seam and zipSync out of src/` (SOURCE SCAN) (`tests/architecture/one-zip-writer.test.ts`, NEW) | `zipSync(` has ZERO call sites in `src/`, and every `Zip`/`ZipDeflate`/`AsyncZipDeflate`/`ZipPassThrough` construction lives in `src/lib/zipStream.ts`. It parses the TypeScript AST (comments naming `zipSync` cannot red it) and declares NO named helper, because `tests/**` is itself under the duplicate-body tripwire | a reintroduced `zipSync(` call reds it naming `src/lib/exportImport.ts:367` (`e125740d…` → `f7acb6e0…` → `e125740d…`); a foreign `new ZipDeflate(` reds it naming `src/lib/backup.ts (new ZipDeflate)` (`153caa89…` → `aa6c6aed…` → `153caa89…`) |

**The FILE is unchanged** — the same entry names, the same JSON, the same `level: 6` — and every
round-trip pin in `tests/lib/exportImport.test.ts` passes unchanged. The streamed CONTAINER is
slightly larger over the same entries (data descriptors + per-slice deflate): the trade docs/18
§5 (b) already records for the backup. **MEASURED** (scratch harness, deleted after use, raw log
`.gate-logs/row276-measure2.log`): 400 notes × 32 KiB — PRE one 531.5 ms synchronous block and 0
event-loop turns, POST 413 turns with a longest uninterrupted stretch of 90.4 ms.
**WHAT IS NOT CHUNKED, stated rather than implied:** the export's JSON assembly (the top-level
`JSON.stringify` + one per artifact + `bytesFromBase64` per image) and the export's progress
reporting (the dialog's `busy` state only) — both named in docs/18 §5 as the residual trade.

### The pack-import residual — one failure guard, one reconcile seam, one named not-ready book (docs/17 row 277, docs/18 §2.1/§2.2/§5)

The felt problem is a book that lies about itself in two directions: a PACK import
that threw after `createBook` left the row reading `processing…` forever (nothing
reconciled pack books, and the Rules page's failure copy is shown only for
`'error'`), and the Spells page answered "No spells imported for <system>" while
that very system's book was still importing. Three parts, ONE seam each — the
post-create failure guard, the EXISTING start-up reconcile extended with a pack
lane, and the ONE ready-book rule reused for the not-ready half.

| Surface | Covered by | State |
| --- | --- | --- |
| Any post-`createBook` throw (a `statBlockSchema`/`itemDataSchema` parse, a `persistChunks` failure, a `finalizeBook` failure) lands the row in `'error'` with the failure's OWN message and rethrows — the row is never left `'processing'` | `tests/ingest/packs/pack-import.test.ts` — `names the book and rethrows when a persist fails after the row exists`, `names the book and rethrows when finalizeBook fails`, and the REAL-Dexie pin `leaves NO processing book behind — the real Dexie row reaches \`error\`` (row state, not call shape) | pinned |
| The guard is EXACTLY ONCE: the zero-entry arm writes its own message and the catch does not fail the row again | `tests/ingest/packs/pack-import.test.ts` — `marks the book error and throws when zero entries validate` now asserts `deps.failed` has LENGTH 1 as well as the message | pinned |
| A `failBook` that itself fails (the row was deleted mid-import) is reported BESIDE the original failure, never swallowed in its place | `tests/ingest/packs/pack-import.test.ts` — `keeps BOTH failures visible when the row cannot be marked at all` (both messages in ONE throw) | pinned |
| `importPack` holds the ONE cross-tab ingest lease across the whole post-create pass, so the reconcile's `isGenerationLockHeld` guard is NON-VACUOUS on a pack book | `tests/ingest/packs/pack-import.test.ts` — `holds the ONE ingest lease across the whole post-create pass` (a stubbed `LockManager`: the lock is named `ingestLockName(<the created book>)`, HELD while the chunks persist, and released after the pass) | pinned |
| The PACK lane reconciles a `'processing'` pack row to `'error'` with the PACK sentence, which names the pack's real remedy and NOT the PDF one | `tests/ingest/ingestReconcile.test.ts` — `fails a processing pack row with the PACK lane's own sentence, never the PDF one` (the two constants are asserted to DIFFER, and `Retry…` is asserted absent) | pinned |
| The lanes never touch each other's rows, each reads its OWN origin population, the lease guard covers packs too, the batch is loud once with its own remedy, and a row that finished between the read and the write is never overwritten | `tests/ingest/ingestReconcile.test.ts` — the five remaining pack-lane pins (`the two lanes never touch each other's rows`, `leaves a pack row another tab is importing alone`, `reads its own origin population`, `reports a pack batch loudly, once`, `never overwrites a pack row that finished`) | pinned |
| The mount effect actually reaches the pack lane THROUGH the app: the owner's library card stops saying `processing…` and carries the pack sentence | `tests/features/feature-shell-and-editor.test.tsx` — `reconciles a PACK import a discarded tab left 'processing' — with the pack's own remedy`, rendered through the real router beside the row-266 PDF pin | pinned |
| The Spells page NAMES a same-system book that is still importing (and one that failed, with that book's OWN remedy), never claiming nothing is imported; a ready book still takes today's path; a cross-system book never triggers it | `tests/features/spells-page.test.tsx` — five pins (`names a still-importing same-system book…`, `names a FAILED pack import and points at the pack remedy`, `names a FAILED PDF import and points at its own Retry control`, `a not-ready book of ANOTHER system never triggers…`, `a READY book keeps today's path…`) | pinned |
| The not-ready half did NOT fork the ready-book rule: the set is "same-system books MINUS the ready answer" (`readyBooksOf`), and the ready filter is still declared once | `tests/db/ready-book-seam.test.ts` — the source scan is unchanged and stays green (the needle `(book) => book.status === 'ready'` still appears only in `db/rulebookRepo.ts`) | pinned |
| The exception catalogue has not grown: the new tests copy no shared helper | `tests/architecture/no-duplicate-implementations.test.ts` — 18 green; the first draft extended the file-local `memoryDeps`/`createBook` helpers and the tripwire red-carded the baseline, so the id capture moved into a NEW local `trackedDeps` and the blessed copies stayed byte-identical. A `*Baseline.json` edit would have been DELETE-only; none was needed | pinned |

**REVERT-PROVEN, one arm per part, every arm's sha256 printed with `sha256sum`, no
two arms identical, each restored byte-identically from an out-of-tree copy under
`.gate-logs/` (raw logs beside them):** (A) `src/ingest/packImport.ts`
`41d6a951fdbb660e…` → `60d25aaa9d4f04e4…` (the exactly-once guard inverted, so the
catch never names the row) → **RED 5 / GREEN 21**, the five being the zero-entry
exactly-once pin plus all four guard pins (`.gate-logs/row277-armA2-run.log`); (B)
`src/ingest/ingestReconcile.ts` `cc5b251b0c4372bf…` → `662450802d4e8874…` (the pack
batch short-circuited to `[]`) → **RED 4 / GREEN 7**, exactly the pack-lane batch
pins (`.gate-logs/row277-armB-run.log`); (C) `src/features/spells/SpellsPage.tsx`
`ffc9303c18a5fe96…` → `ce6b0d29b40cd8b9…` (the not-ready branch removed) → **RED 3 /
GREEN 14**, exactly the three naming pins (`.gate-logs/row277-armC-run.log`). Each
file was verified back at its original hash after the run.

**UNPROVEN here, stated rather than implied:** the lease is EXERCISED against a
stubbed `LockManager` — jsdom has no Web Locks and no second tab, so "a start-up in
another tab leaves a live pack import alone" is pinned as the GUARD's behaviour
(a held lock name → no write) plus the import's HOLD of that name, not as a real
cross-tab race. The device test remains the owner's.

## The clean cut (docs/17 row 278): test families DELETED, and the owed migration

The clean cut abolished the older-shape layer, so the families that existed only
to prove it are DELETED rather than kept green artificially:

- `tests/db/migration.test.ts` (1,651 l.) — the whole v1→v30 chain.
- `tests/db/mobCopyRepair.test.ts` (754 l.) — the v24 conversion + retry.
- `tests/app/migration-notice.test.tsx` — the five migration notices.
- `tests/architecture/one-legacy-mob-read.test.ts` — the legacy-read seam pin.
- `tests/features/mob-copy-on-write.test.ts`, `monster-source-citation.test.tsx`,
  `cast-row-borrowed-stats-scan.test.ts` — the legacy pointer's UI arms.

NEW: `tests/db/clean-cut.test.ts` (11 pins) — the purge and its counts, the
library/settings survival, the `mobPortraits`→image chain, idempotence, the
notice sentence, the old-settings-row parse, the ATOMIC abort via the fault hook,
`db.verno === 31`, the newer-version residual with NO delete, the
`npc-ref` re-homing, the two file refusals, and the exactly-one `.version(` /
`.upgrade(` source scan.

**COMPLETED (the owed half), triaged by SUBJECT rather than by colour.** Tests
whose SUBJECT was retired compatibility were DELETED: the `resolveMonsterEntry`
`rulebook` arms, the content-hash citation healing, the `creatureRef` borrowed
stats, the deleted refine, the legacy-pointer failure/loud arms, the
`OPTIONAL_TABLES` backup tolerance, the citation-naming banner rows, the
canonical-republish toast, the `rulebook`-only uncited list, and the migration/
retry semantics. Tests whose SUBJECT is a LIVE rule but whose FIXTURE was the
old shape were CONVERTED to the copy shape (a `chunk:` origin token names the
creature; the row owns its block): the identity/portrait lanes, seed freezing,
the adoption seams, the `npc-ref` resolution, the drift policy and the two file
refusals. ALL CHUNKS ARE GREEN: db 402, domain 455, lib 381, features 1497,
llm 1267, architecture 100, remainder 369.

The pass also FOLDED one duplicate it exposed: `tests/helpers/visionComplexTarget.ts`
now carries the complex-encounter fixture the two vision tests had copied
byte-for-byte. `*Baseline.json` edits were DELETE-ONLY (the deleted
`cast-row-borrowed-stats-scan` and `monster-source-citation` sites and one stale
entry).

## One cast-write rule, and the source-scan helper it folded (docs/17 row 284)

`tests/architecture/one-cast-write-rule.test.ts` (3 source pins) holds the ONE
predicate a direct instruction now outranks: `domain/creature
.castCreatureWritePermitted` is DEFINED once and ASKED from exactly the declared
enforcement homes (the engine's statblock step, refill merge and encounter mint;
the change seam's route; the entity batch's destination check), and — the pin
that matches the measured defect — in `runEngine.ts` the instruction read
(`directInstructionFor`) sits BEFORE the statblock step's boundary call, so a
refusal can never be reached without consulting the owner's words. It also pins
the expression's FOLD: `additionalInstructionOf(` no longer appears in the
engine, because "did the owner ask for something" is composed in one place.

**THE TRIPWIRE CAUGHT THIS SLICE'S OWN COPY AT BIRTH, AND IT WAS FOLDED.** The
first draft of that pin carried its own `import.meta.glob` + normalization +
`filesWith`, byte-identical to `one-library-copy.test.ts`'s, and
`no-duplicate-implementations.test.ts` reddened it BY NAME (112-char normalized
body, two sites, not in the inventory). It was folded, not blessed: the glob and
the needle lookup now live in `tests/helpers/sourceCode.ts` (`CODE`,
`filesWith`), both pins import them, and **NO `*Baseline.json` was edited** (the
pair was never baselined, so the fold simply returns the population to one site).
This is the second time the tripwire caught a copy at birth in this arc and the
second time the cure was a fold.

RED-PROVEN, arms in `<worktree>/.gate-logs/row284-writer/` (`arms.md` + the raw
`injectA..D.log`): the predicate reverted to the unconditional boundary → 2 named
pins red; the boundary DELETED → the narrowness pin and the merge refusal red;
the change seam's refusal removed → 2 red; the origin stamps dropped when a run
authors → the identity assertions red. Every file restored byte-identically
(`sha256sum -c pristine.sha256` OK); no two injected hashes equal.

**THE FIFTH SITE'S ARGUMENT IS PINNED BY DECLARATION, NOT BY BEHAVIOUR (docs/17
row 286) — the brief's premise was REFUTED by measurement.** A fourth arm in
`tests/architecture/one-cast-write-rule.test.ts` declares WHAT the batch's
destination check passes (`castCreatureWritePermitted(destination,
aimedAtThisRow ? instruction : undefined)`, and the aim's identity definition),
and two arms in `tests/features/entity-batch-cast-description.test.ts` drive the
aimed boundary END TO END through the REAL `runEntityBatch` (previously
uncovered: `change-artifact.test.ts` mocks it) — an instruction AUTHORS on a cast
row and stamps `statBlockAuthored`, none REFUSES. The ternary's ARGUMENT is
behaviourally INERT: substituting `undefined` (or `instruction`) reds the SOURCE
arm only, because the run stamps `statBlockAuthored` before the destination check
reads the row, the CREATE arm is unreachable (MEASURED: it produces a fresh,
stamp-free row), and the aimed-no-instruction case is refused earlier at the
change seam. So the two end-to-end arms are red-proven by BOUNDARY injections
(`&& (false as boolean)` → the refusal arm; `|| true` → the authoring arm), while
the argument drift has no behavioural pin. Arm (b)'s refusal branch is reachable
only by calling `runEntityBatch` directly — a unit pin, not a production path.
Every injection type-clean, `entity-batch.ts` `1858d83b…` restored byte-identically;
no two arms identical. Removing the inert argument is a LATER `src/` decision
(docs/18 §5), deliberately not taken by this tests-only slice.

## The instruction-level read is a MODEL call, and its pins mock the transport (docs/17 row 289)

`tests/llm/instruction-level.test.ts` (6 pins) is the seam's own family:
`llm/instructionLevel.readInstructionLevel` is a structured call, so the chat
transport is MOCKED and the pins assert the CONTRACT and the PROMPT, not the
network. What they hold: the owner's own sentence resolves the number he meant
(the unit half of the exact regression — the end-to-end half is
`tests/llm/runEngine.test.ts`'s *reads the owner's own sentence through the
MODEL and BINDS the level he asked for*); the entity's NAME and its CURRENT
level ride the payload, so a relative request has a base; `null` is taken as
the honest answer for an instruction that asks for nothing (the call still
happens — the model is the authority, never a pattern's silence); an empty
instruction is refused BEFORE any call; a reply outside the app's 1..20 domain
or off the contract fails LOUDLY with the named sentence and no fallback; and a
transport failure is named while an `AbortError` passes through untouched so the
run still records a cancel.

The pins that CARRY the owner's case are behavioural and live beside the engine:
`runEngine.test.ts` gained four arms — his sentence binds level 3 on a row whose
minted block was level 1 (the regression), the standalone named read when no
stored hint disagrees, NO instruction ⇒ NO call (the exact call count), and both
failure arms (transport and schema-invalid) failing the run and writing
nothing. The pre-289 regex pins were CONVERTED, never deleted, because their
SUBJECT is live: `level-language.test.ts`'s language arm now drives the model
reader (the union is the model's job), `runEngine.test.ts`'s CLASS D and
`needsStatBlock:false` arms insert one read reply and their stat-block prompt
moves from call 1 to call 2, and
`tests/architecture/one-level-resolution.test.ts` pins the deleted wrapper
ABSENT (`export function instructionLevel` appears nowhere in `src/`) plus the
new reader defined once and called only by the engine.

RED-PROVEN, arms in `.gate-logs/row289-arm{A..E}-*` with every sha256 printed
before and after and every file restored byte-identically, `tsc -b` exit 0 on
every injected tree (a lone `tsc --noEmit -p tsconfig.app.json` does NOT cover
`tests/`, docs/17 row 288): (A) the model's answer ignored → 6 named pins red
across the unit and end-to-end arms; (B) the no-instruction guard removed →
exactly the NO-call pin red; (C) the failure swallowed → exactly the loud-failure
pin red; (D) the 1..20 domain widened → the domain pins red; (E) the regex
wrapper reborn in `roomBudget.ts` → the source pin red. No two injected hashes
equal. The row-212/215 tripwire stayed GREEN with **NO `*Baseline.json` edit** —
its own catch in this slice (a `userContentAt` helper byte-identical to
`mob-spells-lanes.test.ts`'s `lastPrompt`) was REPLACED by `promptOf`, which is
loud on a missing call: a different contract, not a renamed copy.

## The module list reads as an arc, and the two orders stay two (docs/17 row 297)

The owner's report was a DISPLAY complaint — *"Modules in a campaign right now
are sorted by inverse recency (the latest on top), I would like them to be
sorted by start level."* — and the cure is ONE pure comparator applied at ONE
display seam, so the family is deliberately small and three-layered.

**Behaviour, `tests/domain/module.test.ts` (+5).** Each of the comparator's four
keys gets its own arm — `levelMin` ascending whatever the input order,
`levelMax` ascending at one start level, `createdAt` ascending (story order),
`id` on a FULL tie — plus the TOTALITY arm: a six-module list with a duplicate
pair, a same-start-level wider module and gaps between the level groups is
sorted, then every ROTATION and the REVERSAL of it must produce the one expected
sequence. The totality arm is what makes "a tie never depends on the array" a
measurement rather than a claim about `Array.prototype.sort`.

**Source, `tests/architecture/one-module-list-order.test.ts` (NEW, 3).** Built on
the ONE `tests/helpers/sourceCode` glob (never a ninth hand-rolled walker — the
row-212 BASELINED population). (1) The comparator is DEFINED once, in
`src/domain/module.ts`, and its four keys appear IN ORDER inside the body. (2) It
is referenced from exactly ONE production file, the display seam
`src/features/modules/hooks.ts`, which holds exactly ONE `.sort(` and it is the
comparator's — and the hook names no `updatedAt` at all. (3) The repo's own read
`src/db/moduleRepo.ts` still sorts
`rows.map(parseModuleRow).sort((a, b) => b.updatedAt - a.updatedAt)` and contains
no comparator reference. Both halves live in ONE test so neither order can be
silently swapped for the other.

**Rendered, `tests/features/module-ui-toast.test.tsx` (+1).** Three modules
seeded so the repo's recency order CONTRADICTS the level order (the level-5
chapter edited last, the level-1 chapter first), asserted through the DOM order
of the rows' unique `module-board-link-<id>` testids — the page must read level
1 → 3 → 5, which is the arm that fails if the display still used recency.

**RED-PROVEN, arms in `.gate-logs/row297-injections/` with every sha256 printed
before and after, every file restored byte-identically, `tsc -b` exit 0 on every
injected tree** (a lone `tsc --noEmit -p tsconfig.app.json` does NOT cover
`tests/`, docs/17 row 288): (A) `levelMin` reversed → RED 3 node + RED 1
rendered; (B) `levelMax` reversed → RED 3 node (the rendered fixture has
distinct start levels, so it stays green — the arms are not interchangeable;
the source key-order arm reds too); (C) `createdAt` + `id` reversed → RED 4
node; (D) the display seam stops sorting (sort plus its import, so the injected
tree stays type-clean) → RED 1 source + RED 1 rendered (the fall-back-to-recency
arm); (E) `listModulesByCampaign` swapped for a hand-rolled level sort → RED 1
source + RED 1 behavioural. No two injected hashes equal.

**THE MEASURED GAP THIS FAMILY CLOSED.** The pre-existing repo-order pin
(`tests/db/moduleRepo.test.ts`'s newest-first flip) turned out NOT to be
discriminating against a level sort: both of its modules share one band, so
`createdAt` ASC coincides with the bumped recency order and arm E left it GREEN.
One discriminating arm was added there — a level-5 module touched LAST, so the
display's arc order is the REVERSE of the repo's — and arm E reds it by name.
The row-212/215 tripwire ran 18/18 GREEN with **NO `*Baseline.json` edit**. No
existing pin asserted the old display order, so none was updated or deleted.

## The encounter link goes straight to the battle, through ONE seam (docs/17 row 298)

The family is **one new unit file plus arms in three existing behavioural files
and one architecture scan**, because the claim is a CROSS-SURFACE one: the
module text's encounter link, the encounter card's button and the battle
surface's empty state must be the SAME act, and a second implementation must be
visible to a source scan rather than to discipline.

- `tests/features/open-encounter-battle.test.ts` (**NEW, 5**) — the seam
  itself. `runBattle` is wrapped with the REAL implementation
  (`vi.fn(actual.runBattle)`) so the failure arm exercises the real catch/toast,
  while `seedBattleFromEncounter` and `@/lib/toast` are mocked. Arms: an
  existing battle is returned and `runBattle` is NOT called (and
  `seedBattleFromEncounter` is not either); a missing key on the row falls back
  to the clicked encounter; no battle ⇒ `runBattle` called ONCE with
  `(campaignId, moduleId, encounter)` and the SEED'S OWN key returned (the
  library→adopted-copy hop); a fresh seed with no key falls back to the clicked
  id; a rejected seed returns `null` AND
  `toastError('Could not seed the battle', error)` fires.
- `tests/features/module-reader.test.tsx` (**+2**) — the READER, both directions
  through the REAL reader. An `[[Ford Ambush]]` prose chip navigates to
  `battlePath(campaignId, moduleId, encounter.id)` and the peek modal /
  `play-encounter-card` are ABSENT; an `[[Old Tower]]` (location) chip still
  opens the peek modal and leaves the module URL alone.
- `tests/features/battle-surface.test.tsx` (**+2, +1 extended**) — the EMPTY
  state (`start-battle` seeds an unseeded encounter, the board renders, and the
  row's `encounterArtifactId` is asserted) and the header affordance
  (`open-encounter-card`'s `href` is `artifactPath(campaignId, encounterId)`);
  the existing no-provenance test gains the documentation-only absence
  assertion (docs/18 §5 — the gate's false arm is unreachable by route).
- `tests/features/reader-encounter-roster.test.tsx` (**AMENDED, named**) — the
  source scan that asserted `not.toContain("artifact.kind === 'encounter'")`
  pinned the OLD three-hop behaviour and is rewritten as the positive claim
  (docs/18 §5).
- `tests/architecture/one-battle-per-encounter.test.ts` (**+1 test, 2 amended
  inventories**) — the exactly-one pin: the `openEncounterBattle(` population
  (the seam + its three callers), the `runBattle(` population (the seam + the
  in-battle Reseed + its own definition), the amended `battlePath(` and
  `getBattleForEncounter(` inventories, and the DECLARED gate on the header
  affordance.

**ARMS — each `tsc -b` exit 0 on the INJECTED tree (never a lone
`tsc --noEmit -p tsconfig.app.json`, which does not cover `tests/**`), sha256
printed before AND after, every file restored BYTE-IDENTICALLY, no two injected
hashes equal** (patches and raw logs under `.gate-logs/row298-injections/`):
**A** the seam's existing-battle early return deleted → **RED 4** (both seam
existing arms plus the button's `Open battle` resume and picker-reattach pins —
so the extraction is behaviour-preserving in the direction that matters);
**B** the seam returns the clicked id instead of the seed's key → **RED 1**
(the named key); **C** the seam swallows a failed seed → **RED 1** (`null`);
**D** the reader stops branching on the encounter kind (the branch condition
renamed, the cast through `unknown`) → **RED 2** (the behavioural encounter arm
AND the roster source scan); **E** the reader routes EVERY kind through the
seam → **RED 1** (the non-encounter peek arm — the change does not over-reach);
**F** the empty state's `start-battle` testid renamed → **RED 1** (the
empty-state arm); **G** the header affordance's key guard removed → **RED 1**
(the declared source gate); **G2** the affordance pointed at `modulePath` →
**RED 1** (the `href` arm); **H** the empty state bypasses the seam for a direct
`runBattle` call → **RED 1** (the exactly-one source pin) while the empty-state
behavioural arm stayed GREEN on the same tree — the measurement that the SOURCE
pin is the mechanism guard and the behavioural arm is not.

**MEASURED GAP, RECORDED RATHER THAN HIDDEN:** the affordance's
`encounterArtifactId !== null` gate has NO reachable false arm (a board with no
encounter key cannot be routed to), so its pin is a declaration; the
documentation-only absence assertion in the no-provenance test cannot red under
the guard's removal and is labelled as documentary (docs/18 §5). The
row-212/215 tripwire ran 18/18 GREEN with **NO `*Baseline.json` edit**.


## The upstream section miss is named, and absence stays silent (docs/17 row 294, docs/18 §2/§5)

**WHAT IS PINNED.** `packs/types.sectionMissFailure` separates a legitimate
ABSENCE (the section is not in the document at all — nothing is reported) from a
MISS (the section IS present under markup the adapter's VALUE pattern does not
read — ONE named `PackEntryFailure` on the import report). Three families, three
fixture sets, one seam:

- `tests/ingest/packs/dnd5e-foundry.test.ts` — the `At Higher Levels` sentence.
  **A** a `<strong>At Higher Levels.</strong>` document ⇒ the sentence is
  extracted and `failures` is empty; **B** the same words under `<span>` (the
  value pattern's `<strong>` assumption fails) ⇒ the sentence is empty AND
  exactly one issue naming `At Higher Levels` and `docs/17 row 294`; **C** a
  document with no such section ⇒ empty and NO issue; plus the REAL Fireball
  fixture, whose two spellings still read with no issue (the probe changes
  nothing about extraction).
- `tests/ingest/packs/pf2e-rules.test.ts` — the heightening notes. The
  pre-existing pin *"captures an unrecognized Heightened line as LOUD unparsed
  PLAIN PROSE"* asserted `failures === []` for exactly the present-but-unread
  case: **it pinned the defect and is UPDATED deliberately**, now asserting the
  one issue while `heighteningUnparsed` (row 221's stored prose) is unchanged.
  Two arms join it: a spell with no heightening mention reports nothing
  (absence), and a readable `Heightened (+2)` reports nothing (the value pattern
  wins).
- `tests/ingest/packs/pf2e-journal.test.ts` — the `Section:` and `pg.` footers.
  **A** both footers under `<em>` ⇒ read, no issue; **B1** a `<strong>Section:
  …</strong>` footer ⇒ one issue naming `Section`; **B2** a `<span>… pg. 75</span>`
  citation ⇒ one issue naming `Source citation`; **C** a footer-less divider page
  ⇒ no issue. A fifth arm drives a drifted page through `importPack` and asserts
  the miss reaches the seam's OWN public shape — `result.failed` (the list
  `PackImportReport` renders) and `packMeta.entriesFailed` — while the page still
  imports (`result.imported === 1`, `book.status === 'ready'`).
- `tests/architecture/one-section-miss.test.ts` — the exactly-one SOURCE SCAN
  (obligation 2): ONE definition of the seam in `types.ts`, the three declared
  families each importing and calling it (journal twice, for its two footers),
  no FOURTH user, no second composer of the composed sentence anywhere under
  `src/ingest/packs/**`, and no `console.warn`/`console.error` in the directory
  (rule 2's channel ban, made mechanical).

**ARMS — each `tsc -b` exit 0 on the INJECTED tree (never a lone
`tsc --noEmit -p tsconfig.app.json`, which does not cover `tests/**`), sha256
printed before AND after, every file restored BYTE-IDENTICALLY, no two injected
hashes equal** (arm scripts and raw logs under `.gate-logs/row294/`):
**absence-reports** the seam's probe gate deleted, so every unread section is
reported ⇒ **RED 6** (the dnd5e A/B/C pin, the PF2e absence arm, the journal A/B/C
pin, and the journal real-fixture arm — absence is load-bearing); **miss-silent**
the seam returns `null` again ⇒ **RED 5** (all three families' miss pins plus the
`importPack` report arm, and the source scan's non-vacuity arm, which proves the
needles really read the seam); **dnd5e-forged** the call site passes `true` for
the value pattern's own answer ⇒ **RED 1** (the dnd5e pin — the wiring, not just
the helper); **pf2e-rules-forged** the same forgery there ⇒ **RED 1** (the
updated heightening pin); **journal-forged** the section footer's read flag
forged ⇒ **RED 2** (the journal pin AND the report arm, while the citation arm
stays green on the same tree — the two footers are separately wired);
**copy-sentence** a re-spelled rule + sentence in a second pack file ⇒ **RED 2**
(both source-scan arms). The row-212/215 duplication tripwire ran GREEN with
**NO `*Baseline.json` edit**.
## The typed sentence's entity kind comes from the model, and no pattern reads it (docs/17 row 293)

The family is **one NEW source pin plus one NEW rendered file, plus the deletion
of the pin that asserted the defect**, because the claim has two halves that fail
in different ways: a resurrected guesser is invisible to behaviour on today's
fixtures, and a wrong DEFAULT is invisible to a source scan.

**Source, `tests/architecture/one-kind-source.test.ts` (NEW, 2).** Built on the
ONE `tests/helpers/sourceCode` glob (never a ninth hand-rolled walker — the
row-212 baselined population). (1) `guessKindFromSentence` appears in NO `src/`
file (the non-vacuity arm proves the walk sees the tree). (2) The kind's two
positive spellings are asserted in `stub-popover.tsx` —
`useState<StubKind | null>(recordedKind ?? null)` and
`if (!userPickedRef.current) setKind(classified.kind)` — and the popover +
`persona-request.ts` pair must contain NONE of `new RegExp`, `.test(`, `.exec(`,
`.match(`, `.matchAll(`, the constructor and four call shapes any keyword
classifier is USED through. The search is DECLARED in the test's doc comment,
not implied; the positive halves prove the scan reads the right bytes.

**Rendered, `tests/features/stub-popover-kind.test.tsx` (NEW, 4).** The popover
is rendered DIRECTLY with `classifyEntityName` mocked to a promise the test
resolves by hand — the only way to observe the in-flight state. All four arms use
the German sentence `Die Gilde im Keller`, which the deleted pattern read as
`npc`. (1) NO preselected kind before the verdict (the trigger reads
`Classifying…`, and no kind value exists), then the verdict's `faction`; (2) the
owner's manual `location` wins over a later `faction` verdict AND is the kind the
stub is actually written with (read back from the database); (3) a RECORDED kind
is shown immediately and `classifyEntityName` is never called (the unchanged
path); (4) a rejected classification leaves the select unselected ("Choose a kind
…"), renders `stub-kind-failed`, calls `toastError`, blocks both Create and
Generate, writes NOTHING and invents no `npc`.

**The defect pinners, DELETED and NAMED.**
`tests/features/persona-request.test.ts`'s `describe('guessKindFromSentence')`
asserted the regex's three guesses (location/faction/npc) — it pinned the DEFECT
itself, so the whole family and the import are DELETED and replaced by the two
files above; nothing was weakened. One neighbour needed a timing amendment,
also named: `tests/features/module-reader.test.tsx`'s two-step-confirm arm now
waits for the classification's kind before pressing Create, because Create is
(correctly) blocked until a kind exists. That file's other popover arms were
already waiting on the verdict.

**ARMS — each `tsc -b` exit 0 on the INJECTED tree (never a lone
`tsc --noEmit -p tsconfig.app.json`, which does not cover `tests/**`, docs/17 row
288), sha256 printed before AND after, every file restored BYTE-IDENTICALLY, no
two injected hashes equal** (patches and raw logs under
`.gate-logs/row293-injections/`): **A** the guesser RESURRECTED as an exported
seam → **RED 2** (both source arms; `persona-request.ts`
`f990c0b0…`→`f15a318e…`→restored); **B** a DEAD regex literal added to the
popover → **RED 1** (the pattern-shape arm; the name arm stays GREEN on the same
tree, so the two halves of the source pin are separately proven;
`b4d0b393…`→`8775ee93…`→restored); **C** `recordedKind ?? 'npc'` (the silent
default reborn) → **RED 3** (source needle + "no preselected kind" + the failure
arm) with the recorded-kind arm GREEN, so the default and the recorded path are
separable (`3463b304…`); **D** the manual-pick guard removed → **RED 1**, exactly
the manual-pick arm (`cad2b434…`); **E** `setClassifyFailed(true)` removed →
**RED 1**, exactly the visible-failure arm (`41e3a3fa…`); **F** `recordedKind`
ignored → **RED 2** (source needle + the recorded-kind arm; `f3ec60cb…`).

FOCUSED IN-TURN at DEFAULT workers: **88/88 across the 8-file touched/neighbour
cohort** (including the row-212/215 tripwire `no-duplicate-implementations`
18/18 with **NO `*Baseline.json` edit**) and **118/118 across the 8-file
`persona-request` brief cohort**. NO suite lock, NO full run (the dispatcher owns
the integrated gate).
