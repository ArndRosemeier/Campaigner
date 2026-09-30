# 21 — Idea Board: the standalone plain-text writing surface

**Built and landed** (docs/17 row 173). The owner's request, verbatim:

> *"I want to introduce a new functionality into the app that is not really
> connected with any other system, but can be used for basically everything. We
> already have a module chat. I want to have something very similar, but for
> normal text without any wikilinks. Lets call this Idea Board. Its just an edit
> box with a left sidebar (similar to module chat) where the user can paste a
> text, then refine it with the LLM. With a small copy button so the text is then
> easily copied into whatever the user wants. Similar to the chatgpt canvas. I
> guess a lot of the module chat functionality can be reused for this."*

The intent behind the literal ask is a **scratch surface**: paste anything, talk
it through with a model, copy the result out. It is deliberately not a
campaign artifact — no campaign has to be open, nothing is generated into the
workspace, and the text never becomes part of a module.

## What it is

- **`/idea-board`** — an app-level route in the main navigation (before Rules),
  reachable with **no campaign open**. `campaignIdFromPath` returns `undefined`
  there, so the campaign bar renders its disabled-tabs state and the New Module
  button is hidden, exactly as on `/rules` and `/settings`.
- **One document + one conversation**, both persisted on ONE row in the
  `ideaBoards` table (Dexie v23, additive). `ideaBoardRepo.getIdeaBoard`
  creates the row on first open inside a transaction, so two concurrent opens
  cannot mint two boards; `saveIdeaBoard(next, expected)` is an in-transaction
  compare-and-swap against the snapshot the session loaded, so a second tab's
  write is refused loudly instead of silently overwritten.
- **The document is plain text.** No wiki-link resolution, no markdown
  language extensions, no parts, no scaffolding labels, no entity or artifact
  reads. A `[[token]]` the owner types stays those literal characters — the
  feature's whole point against the module canvas, and pinned by
  `tests/features/idea-board.test.tsx` (it types `Original [[literal]]` and
  asserts the accepted text is stored verbatim).
- **A left chat sidebar** (`md:w-80`, the module chat's shape) with the
  conversation, a session model selection defaulting to the Settings first-try
  model, and an instruction box. Return sends, Shift+Return keeps the newline.
- **A small copy button** in the header that copies the whole document through
  `lib/clipboard.copyText`.
- **`Previous drafts`** under the document: accepting a model suggestion, or
  restoring an earlier draft, snapshots the text it replaces. This is the
  board's own undo for MODEL writes (the editor's CodeMirror history owns
  typing). There is deliberately no cloud of versions — one flat list on the
  row.

## The chat's controls

- **Clear chat** — a small button in the chat column's header (beside the
  `Refinement chat` label) opens the shared `AlertDialog` primitive for one
  confirmation, then returns the CONVERSATION to a pristine state through ONE
  seam, `clearIdeaBoardChat` (docs/18 §2.3). The ordering is the point and it
  is the module canvas chat's rule: the PERSISTED transcript on the board row
  is written FIRST through the same `saveIdeaBoard` compare-and-swap the
  debounced writer uses, and is AWAITED — so a failed write aborts the whole
  clear, toasts loudly, and leaves the conversation intact; only after the row
  is clear does the live store empty. A pending debounced save is cancelled
  first, because its trailing fire would put the cleared transcript straight
  back on the row.
- **What it does NOT clear** (the dialog's copy says it in the owner's face):
  the board's DOCUMENT, its Previous drafts, and a suggested replacement that
  has not been accepted. Those are content, not conversation — clearing the
  chat is not an undo, and it never deletes the owner's writing. It also
  cannot reach another board or any module chat thread: there is one board row,
  and the write is a whole-row compare-and-swap.
- **While a refinement reply is in flight** the clear REFUSES LOUDLY with a
  toast and clears nothing (the canvas chat's rule): the reply would land its
  own message moments later, so the pristine state the control advertises could
  not be promised.

## What it is NOT, and why the module chat is not reused wholesale

`llm/canvasChat`, `features/modules/canvas/chatTurn` and its store are
module-shaped end to end: they split a parts document, ground on the campaign
premise and every preceding module's full text, resolve wiki-links against the
artifact pool, serialize on a one-generation-per-`moduleId` registry, persist
into `modules.chatThread`, and reply with `<edit>` / `<request>` / `<change>`
commands that mutate artifacts through `changeArtifact`. A board has no module
id, no parts and no entities, so reusing that protocol would import semantics
the board must not have. **What IS shared is everything below the contract**:

| Shared seam | What the board takes from it |
|---|---|
| `llm/openrouter.chat` | the API key, the escalation chain, strict structured outputs, the language directive, retries, stream watchdogs, abort |
| `llm/jsonReply.parseJsonReply` + zod | the reply boundary |
| `llm/strictSchema.schemaResponseFormat` | the strict JSON contract |
| `llm/generatedTextHygiene.generatedTextScanForFields` | escape debris + scaffolding-echo scan BEFORE the text can be accepted |
| `db/settingsRepo` | `defaultChatModel`, `defaultReasoningEffort`, language |
| `lib/editorTheme.plainEditorTheme` | the CodeMirror theme (extracted from `features/modules/canvas/canvasTheme`, which now composes markdown highlighting on top of it) |
| `lib/pageFlush` | the debounced write lands when the page goes away |
| `lib/progress` | the dock job while a reply streams |
| `lib/clipboard.copyText` | the copy capability |
| `features/progress/stop-all-generations` | Stop all aborts an in-flight board turn |

## The refinement contract (`src/llm/ideaBoard.ts`)

ONE chat call. The system prompt states the surface's contract: ordinary text,
NO wiki-links or app markup; answer in `reply`; return the COMPLETE resulting
text in `document` when asked to write, rewrite or restructure; return
`document: null` for a question or a discussion. The final user turn is a JSON
payload `{ document, instruction }` and the conversation rides as history.

The reply schema `{ reply: string(min 1), document: string(min 1) | null }` is
**expressible in the strict subset** (the nullable half becomes an `anyOf` with
null; `minLength` is stripped by the normalizer because the zod parse enforces
it) — pinned in `tests/llm/ideaBoard.test.ts`, which asserts the emitted schema
is `{kind: 'schema', name: 'idea-board'}` with exactly the `reply`/`document`
properties.

Loud refusals, each named (AGENTS rules 1/3):

| Situation | What happens |
|---|---|
| empty instruction | throws before any call (`Enter a message first.`) |
| the reply is not the contracted JSON | `parseJsonReply` + zod throw; nothing is applied |
| `document` is only whitespace | refused by name — the strict decoder strips `minLength`, so this is checked on the parsed value; a whitespace board is never written |
| the text carries escape debris or echoes our own prompt scaffolding | refused, naming the issue from the shared hygiene scan |

A user abort is NOT an error: the caller decides from `signal.aborted`, and a
stopped turn applies nothing and records no reply.

## The write path, and the two rules that protect the owner's text

1. **A refinement never writes the document.** The reply lands as a
   `proposal`; `replaceIdeaDocument` is the only path that changes
   `board.document` from model output, and it snapshots the CURRENT draft first.
   That is what makes "typing while the model thinks" safe: the suggestion is
   accepted onto text that may have moved, and what it replaced is recoverable
   from Previous drafts. Pinned in `tests/features/idea-board.test.tsx`.
2. **The owner's instruction is recorded BEFORE the call.** A failed or stopped
   turn therefore never discards what they typed — the module chat's rule, and
   the reason the board's transcript is written the moment Send is pressed
   rather than only on success.

A failed SAVE keeps the draft in memory with a humanized reason and a
`Retry saving` control; there is deliberately no automatic retry loop, because
the compare-and-swap's "another tab changed this" refusal would otherwise be
reported forever. A save that settles while the owner typed keeps the newer
draft (the next debounce writes it).

## Storage, backup and lifetime

- Table `ideaBoards` (`'id, updatedAt'`), Dexie version 23, additive with no
  upgrade body: an older database simply has no board and
  `getIdeaBoard` creates one.
- `domain/ideaBoard.parseIdeaBoards(rows)` REFUSES more than one row by name.
  One board is the feature's contract, and a restore that would silently pick
  or discard one of two is refused before any wipe.
- **Full-app backup carries the board** (`lib/backup.ts`): `ideaBoards` is in
  `OPTIONAL_TABLES`, so a pre-v23 zip restores with an empty board instead of
  failing the missing-table check, and the import validates the rows through
  `parseIdeaBoards` BEFORE the destructive write. Pinned end to end in
  `tests/db/ideaBoard.test.ts`.
- **Campaign export deliberately does NOT carry it.** The board is app-level,
  not campaign state; putting it in a campaign file would make "export this
  campaign" a carrier for unrelated writing.
- No campaign/module delete path touches the board: it is not campaign-keyed,
  so `deleteCampaign`, `removeAllGeneratedContent` and
  `deleteCampaignWorkspace` cannot reach it. **`Settings → Delete all data`
  DOES take it** (`db/maintenance.deleteAllData` deletes the whole IndexedDB
  database, and the board is IndexedDB data), which is the honest reading of
  "all data" — it is not a stored preference like the theme, so it is not in
  `PRESERVED_KEYS`. Only that explicit, confirmed wipe, a board edit, or a
  backup restore ever clears the document.

## Layout and appearance — two invariants (docs/17 row 174)

The owner's first look at the board: *"The board looks like a big white square.
white on white maybe? And the vertical space is not really used."* Two
mechanical causes, both worth stating because neither is visible to a test that
mocks the editor:

1. **The height chain must start at `h-full`.** The shell renders the page
   inside `<main className="min-h-0 flex-1">`, which is a PLAIN BLOCK — not a
   flex container — so a page root of `flex-1` resolves against nothing and the
   board collapses to its floor height (`min-h-64`), leaving the viewport
   unused. The root is therefore `flex h-full min-h-0 flex-col`, and each layer
   down to the editor (`flex-1` body → `flex-1` section → `flex-1` surface →
   `height="100%"` editor) carries a definite height. `CanvasPage` fills the
   same slot the same way; the board's first version did not.
2. **The writing surface needs a visible edge.** In LIGHT mode `--card` and
   `--background` are both pure white, and `--border` is a 92% grey, so
   `bg-card border` read as a featureless white block on a white page — the
   owner's "white on white". The surface uses the app's Card convention
   instead: `rounded-lg bg-card ring-1 ring-foreground/10`, which is
   theme-aware (10% of the foreground: a real line in light mode, a soft one in
   dark).

The editor's own colours come from `lib/editorTheme.plainEditorTheme` — one
layer, every value a CSS custom property — and the extension set is the named
seam `features/idea-board/editor.ideaBoardEditorExtensions`: plain text, with
`@uiw`'s `basicSetup` OFF and its pieces listed explicitly (`history()` and the
keymaps are in the list because the page's Undo/Redo controls call the `undo`/
`redo` commands against that view). No markdown language and no wiki decoration
is installed, which is what keeps `[[…]]` literal.

Two honest notes about the diagnosis:

- `theme="none"` (which `canvasEditor.tsx` documents as the fix for a
  historical white slab) is KEPT for parity, but it is **not** what caused this
  defect. Inspected in the installed package: `@uiw/react-codemirror` uses the
  `theme` prop only to add a CLASS NAME (`cm-theme-light` / `cm-theme-none`) —
  it adds no extension — and no shipped CSS defines either class, while
  `@codemirror/view`'s base theme sets no background at all. The white came
  from the app palette plus the collapsed height, not from the wrapper's
  default theme.
- The extension set is mounted for REAL in
  `tests/features/idea-board-editor.test.tsx`, because the page-level test mocks
  CodeMirror and could never catch an extension list that throws or one that
  lost `history()`.

## Tests

| Pin | Where |
|---|---|
| typing during a request survives; accept replaces and snapshots; restore brings back the replaced text | `tests/features/idea-board.test.tsx` |
| a failed save keeps the draft and `Retry saving` clears the error | same |
| a stopped turn applies nothing and records no reply, but keeps the instruction | same |
| a failed reply keeps the instruction and toasts loudly | same |
| copy goes through the one clipboard seam (success and unavailable-clipboard failure) | same |
| the `Clear chat` control lives in the chat column and its dialog states the boundary; cancelling clears NOTHING (store AND row); confirming empties the live transcript AND the persisted row (and survives a later flush); the document and Previous drafts survive byte-unchanged; a rejected row write is loud and clears nothing; an in-flight reply refuses the clear | same (docs/17 row 227) |
| the editor mounts on the app theme, is wired to THE extension seam, and the page root carries `h-full` with a ring-edged surface | same (the owner-reported white square / unused height, docs/17 row 174) |
| the REAL editor builds from the seam, is labelled, and undo works — plus the seam installs no markdown language and no wiki decoration | `tests/features/idea-board-editor.test.tsx` |
| one board across concurrent opens; a conflicting save is refused | `tests/db/ideaBoard.test.ts` |
| two stored boards are refused rather than picked/discarded | same |
| writes are validated; a rejected write leaves the stored text intact | same |
| backup round-trip; a corrupt board fails the restore before the wipe; a pre-v23 zip restores empty | same |
| the request is grounded on the owner's text under a strict JSON contract; unset model falls back to Settings; board model wins | `tests/llm/ideaBoard.test.ts` |
| whitespace-only replacement, escape debris and a non-JSON reply are each refused | same |
| `navigator.clipboard.writeText` exists in exactly one place | `tests/architecture/clipboard-seam.test.ts` |
