# fix-01 — Entity name normalization (one model call, no heuristics)

Status: **approved design, not yet implemented**. Builds on `08-MODULE-DESIGNER.md`
(M4-B generator, M4-C entity workflow); binding conventions from
`00-OVERVIEW.md §Global conventions` and `AGENTS.md` apply.

## Problem

Module generation produces **more than one artifact entry for the same
entity** because the model writes name variants into wiki-links:

- declensions/possessives: `[[Halmunds]]` next to `[[Halmund]]` (German
  genitive; English `'s`),
- role/title specifiers: `[[Guard Halmund]]` next to `[[Halmund]]`,
- cross-part drift: part 2 says `[[Guard Halmund]]`, part 5 says `[[Halmund]]`.

Every wiki-link name is treated as its own entity, so each variant becomes its
own row in the entity panel and its own artifact once stubbed/generated.

### Root causes (discovery, 2026-02)

1. **The part writer never sees the entity glossary.** `partCall`
   (`src/llm/moduleGen.ts`) sends premise, themes, synopses and the previous
   part — but not the spine's recorded `entities: [{ name, kind }]`. The
   instruction "wiki-link every proper noun as [[Name]]" carries no rule about
   inflections, titles, or which spelling is canonical, so the writer
   re-derives names from prose and drifts.
2. **Resolution folds nothing but case.** `resolveWikiLink`
   (`src/lib/wikilinks.ts`) matches exact name/alias, case-insensitively —
   `Guard Halmund` and `Halmunds` never fold onto `Halmund`.
3. **Every creation path trusts the link name blindly.** Stub creation
   (`stub-popover.tsx`), single generate (`alignEntityName`,
   `entity-detail.ts`) and batch (`entity-panel.tsx`) create/align artifacts
   per link name with no duplicate check.
4. **Kind classification is keyed per variant.** `classifyModuleEntities`
   records kinds per exact link name, so variants also split the batch
   buckets.

## Core decision

**The fix is model-driven, exclusively.** One LLM call sees the text's entity
names and all existing artifacts and returns, per name, the canonical entity
it refers to. **No procedural reconciliation decides anything**: no string
similarity, no suffix stripping, no stop-word/role-word lists, no edit
distance — anywhere in the decision path. Determinism only (a) validates the
reply's shape and (b) applies the verdict mechanically.

Why rejected heuristics stay rejected: a false merge silently collapses two
genuinely different entities ("Bas" vs "Bass" can be two real NPCs), while a
false split leaves a *visible* duplicate the user can resolve by hand. Only
the model — which wrote the text and knows the world — has enough information
to tell them apart, and artifacts are important enough to spend the call.

### Binding principles for this fix

1. **Model decides, code obeys.** Every merge/split decision comes from the
   normalization call. Validators may *reject* a reply (retry, then fail
   loudly); they never *correct* or substitute it.
2. **Ties go to "keep separate".** The prompt instructs: merge only when
   confident it is the same person/place/thing. A missed merge is a visible
   duplicate; a wrong merge is silent data corruption.
3. **Application is mechanical and reversible.** A verdict becomes a link
   rewrite to `[[canonical|variant]]` plus, where needed, an alias — never a
   deletion, never a prose edit.
4. **No artifact from an unverified name.** Batch generation is gated on the
   pass having succeeded (below).
5. **The pass never merges two existing artifacts.** A name that already
   exactly matches an existing artifact's name maps to itself, always.
   Reconciling existing duplicates stays a separate, manual feature.

---

## The normalization call

One call per module (after parts land), replacing the current
`classifyModuleEntities` behaviour — kinds and canonical names come back in
the same reply so kinds attach to the *canonical* entity, not to each variant.

### Input (user message)

1. **Every wiki-link name** of the module text (premise + all parts, as
   extracted by `extractWikiLinks`), each with a short context excerpt —
   `surroundingParagraphs(text, name, ~400)` as the classification call
   already builds. Resolved names are included too: the panel folds rows by
   link name, so a variant that resolves via alias still occupies its own row
   until the text is rewritten.
2. **All existing campaign artifacts** as `name (kind)` — names only, no
   summaries. No tight cap: name lists are cheap, and truncating the index
   would produce silent missed merges. (Chunk only if a campaign ever grows
   past what one call carries; a chunked run is still "the pass".)
3. The module premise, as today.

### Output (zod)

```ts
const normalizationReplySchema = z.object({
  entities: z.array(z.object({
    name: z.string(),      // verbatim input name, exactly as listed
    canonical: z.string(), // this name, another listed name, or an existing artifact's exact name
    kind: moduleEntityKindSchema, // npc | location | faction | note
  })),
});
```

### Verdict rules (prompt, binding wording intent)

- One entry per listed name, `name` spelled exactly as listed, no extra
  entries, no invented names.
- `canonical` is the exact spelling of the entity this name refers to: the
  name itself, another listed name (the variant's canonical form), or an
  existing artifact's exact name. Never a name that appears nowhere in the
  inputs. Canonical spellings must be final — no `A → B` when `B → C`.
- Merge only when confident the names refer to the same entity: same person,
  place, organization, or thing. A role title attached to the same person
  ("Guard Halmund" / "Harbormaster Ilse") merges onto the person's canonical
  name; similar names for different beings never merge.
- A name that exactly matches an existing artifact's name (case-insensitive)
  maps to itself.
- Kinds: same contract as today's classification, but describing the
  *canonical* entity.

### Reply validation (zod post-conditions — reject, never correct)

All checked after parsing; any violation → one retry with the violation
stated (same policy as `classifyCall`), then the pass **fails loudly**:

- every input name appears exactly once, verbatim (existing behaviour of the
  classification completeness check);
- every `canonical` is either the name itself, another listed name that maps
  to itself, or an existing artifact name (case-insensitive compare);
- no mapping chains (`A → B` where `B` maps elsewhere) and no cycles;
- no name that exactly matches an existing artifact name maps to anything but
  itself.

### Failure semantics — deliberately tighter than today's classification

Today a classification failure is toast-and-continue
(`moduleGen.ts`, "Could not classify entity types…"). For normalization that
would be a silent path back to duplicates, so:

- invalid/incomplete reply after the one retry → the pass is **failed**, not
  swallowed. The module stays `status: 'ready'` (the parts are done), but the
  failure is recorded on the module row and the entity panel shows a loud
  "Name normalization failed — Retry" state with the error; a toast fires as
  well. No fallback path exists — there is nothing safe to fall back to.
- The module row gains the pass state (one `db.version(N+1)`):

  ```ts
  entityNamesNormalized: boolean;   // false until a pass succeeds for the current text
  entityNormalizationError: string; // '' when none
  entityRewriteProposals:           // held hand-edited/premise rewrites awaiting
    { planIndex: number; replacements: { from: string; to: string }[] }[] | null;
  // planIndex -1 = the premise; null = nothing pending
  ```

  Any change to the module's text (part generated, part rewritten) resets
  `entityNamesNormalized` to `false` before the pass runs again at the end of
  the parts run. **Re-run cadence:** the pass runs at the end of EVERY parts
  run — the full run, per-part `rewritePart`, and `generateMissingParts` —
  costing exactly one model call per run; hand edits to part text do not flip
  the flag (hand-typed variant names are covered by the stub popover's
  verdict, below).

### Gate on artifact creation

- **Batch generation ("Generate all unresolved of kind…") refuses to run
  while `entityNamesNormalized === false`.** The buttons are disabled with a
  visible reason; the panel's failed-pass state offers the Retry. This is the
  actual guarantee: no variant name can become an artifact through the batch.
- **Stub popover / single "Generate"** for a name the pass never saw
  (hand-typed `[[...]]` by the user): the popover's one-shot classification
  call (`classifyEntityKind`) is extended with the same contract for that one
  name — it receives the campaign artifact index and may return
  `canonical !== name`. If it resolves to an existing artifact, the popover
  defaults to linking the name to that artifact (alias-add, same as
  "Link existing…") instead of creating a second stub, with the model's
  verdict shown as the reason. The user can still choose to create a
  standalone entity — the stub/generate buttons then require an inline
  confirm ("create as a separate entity") so overriding the model's verdict
  is a deliberate act.

---

## Applying a verdict

For each `name → canonical` where canonical ≠ name, and text containing
`[[name]]` or `[[name|display]]`:

1. **Rewrite the link target(s) to `[[canonical|<original display>]]`.**
   The rendered prose is byte-identical (the display text is exactly what was
   written), but the link resolves to the canonical name, so the entity panel
   folds to one row, `entityKinds` stays keyed canonically, and PDF export is
   untouched. Examples:
   - `[[Guard Halmund]]` → `[[Halmund|Guard Halmund]]`
   - `[[Halmunds]]` (in "Halmunds Haus") → `[[Halmund|Halmunds]]` — the
     genitive reading stays on the page
   - `[[Halmund's Tower]]` → `[[Halmund's Tower]]` unchanged **or**
     `[[Halmund|Halmund's Tower]]` only if the model returned that mapping —
     the model decides; the code never strips suffixes itself.
2. **If `canonical` is an existing artifact's name**, additionally add the
   variant as an **alias** on that artifact (unless present). Any future
   hand-written `[[variant]]` — in this or any other module — then resolves
   on its own; the alias mechanism from 08 §M4-A does what it was designed
   for, and no further text rewriting ever happens.
3. **If `canonical` is another text name**, nothing else to do: the first
   stub/generate of the canonical name owns it, and every variant link points
   there.
4. **Kinds**: the pass **replaces** `module.entityKinds` with records keyed by
   canonical name only — one record per canonical entity, first spelling of
   the canonical form as returned wins, kinds describing the canonical
   entity. It must NOT go through `mergeEntityKinds`: that helper only
   appends unknown names and never removes or re-keys, so stale
   variant-keyed records ("Guard Halmund") would survive forever and defeat
   the folding. The spine pass's normalization (below) uses the same
   replacement rule; its records additionally carry the variants they
   absorbed (`absorbed: string[]`) so the checkpoint can show what a
   canonical entry folded.

### Consent for hand-edited text

Parts the user has hand-edited (`ModulePart.edited === true`) and the
**premise** (spine text — user-authored and editable at the checkpoint, with
no `edited` flag) are not rewritten silently. The pass runs headless (inside
the parts-run progress job), so it never blocks on UI:

- Generated (unedited) parts apply immediately — they normalize text the app
  itself just produced.
- Affected hand-edited parts and the premise are held as **stored rewrite
  proposals** on the module row (`entityRewriteProposals`, with the
  replacement tokens per document). The entity panel shows a loud
  "Normalization wants to update hand-edited text — Review" banner; the one
  **confirm dialog** lists the proposed rewrites (variant → canonical, per
  document) and applies them on confirm (re-applying tokens to the current
  text, so edits made since the pass are preserved); declining drops the
  proposals and the panel keeps showing its variant rows. Either way the
  proposals are cleared after the choice.

### Rewrite mechanics (mechanical, not decisions)

The rewrite replaces whole wiki-link tokens only — `[[name]]` →
`[[canonical|name]]`, `[[name|display]]` → `[[canonical|display]]` — matched
verbatim against the names extracted from the same text, in one pass so a
rewritten token is never re-matched. Tokens inside **fenced code blocks and
inline code spans** are skipped (hand-pasted prose may quote the syntax);
this is text hygiene, not a decision, so it stays deterministic code.

## Prompt improvements (pairing, same change)

The pass then mostly finds nothing, which is the goal:

- **Glossary in every part call** (`partCall`): the module's canonical entity
  names (the spine's normalized `entityKinds` records — names + kinds,
  uncapped: a module's own glossary is small) plus the campaign artifact
  index, are listed with the rule: *refer to these entities only by these
  exact spellings when wiki-linking*. Cost policy: the part-call campaign
  index is **names only, capped at the same 60 entries the spine pass uses**
  (no summaries — the writer needs spellings, not descriptions), so a part
  call grows by a few hundred tokens; the normalization call keeps its
  uncapped names-only index because a truncated index produces silent missed
  merges there.
- **Declension rules in every part call**: link the base/canonical form only;
  never inflect inside the token (write `[[Halmund]]s Haus`, not
  `[[Halmunds]] Haus`); never bake roles or titles into the token (write
  `[[Halmund|the guard Halmund]]`, not `[[Guard Halmund]]`); use
  `[[Name|display]]` when the surface text must differ from the canonical
  name. State the rule language-agnostically and give both German and English
  examples (genitive/plural) — do not depend on a generation-language setting.
- **Spine pass**: "one entity entry per named entity, under one canonical
  spelling — list a person once, not once per role or title."

## Spine checkpoint integration

The spine pass 0 reply (`entities: [{ name, kind }]`) is **normalized against
the existing campaign artifacts before** `entityKinds` is stored and the
checkpoint is shown — same machinery, single call, so the glossary the user
approves is already canonical. Failure semantics match the spine's own loud
policy (one retry with the violations stated, then the spine fails — there is
no checkpoint worth approving on top of unverified names). `entityKinds` is
**replaced** with the canonical records (variants absorbed, per the
replacement rule above). The checkpoint gains an entities line listing the
canonical entries with their kinds, each showing the variants it absorbed as
a muted secondary note, so a wrong merge can be caught at the steering
moment; editing a name there is an ordinary plan edit.

---

## Acceptance criteria

- A module whose parts contain `[[Halmund]]`, `[[Guard Halmund]]` and
  `[[Halmunds]]` ends with **one** entity-panel row and **one** artifact after
  stubbing the canonical name; the rewritten links render the original prose
  byte-identically (display text unchanged in reader and PDF).
- `module.entityKinds` is **replaced** with one record per canonical entity —
  a pre-pass variant-keyed record ("Guard Halmund") is gone, not merged
  alongside; the batch buckets count variants under their canonical kind.
- After the pass, a hand-written `[[Guard Halmund]]` anywhere in the campaign
  resolves via the recorded alias.
- When the pass fails (simulated invalid reply twice), the module stays
  `ready`, the entity panel shows the failed state with the error, the toast
  fires, batch buttons are disabled with the reason, and Retry re-runs the
  pass.
- A hand-edited part affected by a verdict produces a stored proposal and the
  panel's review banner; confirming applies the rewrites to the part's
  current text, declining applies nothing — and the panel keeps showing its
  variant rows. Premise rewrites always take the proposal path.
- Hand-typed `[[Some Guard]]` in the stub popover, where the model returns an
  existing artifact, defaults to alias-linking with the verdict shown — and
  still allows an explicit standalone stub after the inline confirm.
- No similarity/suffix/stop-word logic exists anywhere in the **name-merge
  decision path** — the only string ops there are exact (case-insensitive)
  matches for validation and application. (`guessKindFromSentence` in the
  stub popover is a kind-placeholder UI default that the model's reply
  overrides — it decides nothing about merges and is out of scope.)
- `docs/08-TESTING.md` gains coverage-matrix rows for the pass, the gate and
  the consent flow.

## Non-goals

- Merging or reconciling **already existing** duplicate artifacts — a manual
  merge action is separate future work.
- A per-part normalization call during streaming (the post-parts pass plus
  the end-of-run re-pass covers rewrites; per-part stays possible later).
- Rewriting prose beyond link targets (display text is always preserved).
- Cross-module continuity checking.
- Any procedural fuzzy matching — rejected permanently for *decisions*;
  exact case-insensitive matching remains the only string comparison.
