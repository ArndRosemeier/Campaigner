# 04 — OpenRouter Client & Persona Engine

## OpenRouter client (`/src/llm/openrouter.ts`)

```ts
interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface ChatOptions {
  model: string; temperature: number;
  responseFormat?: 'json';       // sets response_format: { type: 'json_object' }
  signal?: AbortSignal;
  onToken?: (delta: string) => void;   // streaming callback
}
async function chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
```

- Endpoint `POST https://openrouter.ai/api/v1/chat/completions`, headers
  `Authorization: Bearer <settings.openRouterApiKey>`,
  `HTTP-Referer: 'https://campaigner.local'`, `X-Title: 'Campaigner'`.
- Always request `stream: true`; parse SSE per the WHATWG spec (`data: {json}` /
  `data: [DONE]`, `:`-prefixed keep-alive comments like `: OPENROUTER PROCESSING`
  are ignored), concatenate `choices[0].delta.content`, invoke `onToken` per delta.
- Stream completion: whichever comes first of `[DONE]`, a clean connection
  close, or `choices[0].finish_reason` (the terminal finish_reason repeats on
  OpenRouter's accounting usage chunk — treat it as an accounting frame, not a
  second terminal event). The reader is cancelled on completion/failure so the
  connection returns to the pool.
- Stream failures are surfaced, never hung: a top-level `error` field or
  `finish_reason: "error"` throws `OpenRouterError`; no bytes for 120s (stall
  watchdog, keep-alives count as activity) aborts with a stall error.
- Errors: non-200 → throw `OpenRouterError(status, bodyText)`. 429/5xx: retry
  twice with 2s/8s backoff before throwing. Missing API key → throw
  `MissingApiKeyError` (UI catches this and opens Settings).

## Built-in personas (`/src/llm/personas/builtins.ts`)

Seed on app start (insert if slug missing; never overwrite user edits).
Milestone 1 shipped **NPC Smith** fully wired; the other definitions are seeded
but their runs reuse the exact same pipeline with different prompts and
`producesKind` (implement in M2 — pipeline must not hardcode NPC anywhere
except step `statblock`, which runs only when `producesKind === 'npc'`).

`producesKind` is required for generate/review personas; image personas
(`mode: 'image'`, M3-A) never produce an artifact and omit it. Image personas
are not chainable (chainRunner/moduleForge reject them).

| slug             | name              | producesKind | mode     | one-line purpose                       |
|------------------|-------------------|--------------|----------|----------------------------------------|
| npc-smith        | NPC Smith         | npc          | generate | Memorable NPCs with stat blocks         |
| worldbuilder     | Worldbuilder      | location     | generate | Regions, cities, dungeons               |
| faction-designer | Faction Designer  | faction      | generate | Factions with goals, methods, ranks     |
| plot-architect   | Plot Architect    | note         | generate | Adventure/campaign arcs and hooks       |
| arc-weaver       | Arc Weaver        | plotarc      | generate | Plot arcs with beats, stakes, climax    |
| session-chronicler | Session Chronicler | session   | generate | Ready-to-run session plans              |
| encounter-smith  | Encounter Smith   | encounter    | generate | Balanced encounters with monsters       |
| continuity-editor | Continuity Editor | note        | review   | Reports contradictions in an artifact   |
| illustrator      | Illustrator       | —            | image    | Drafts an image prompt and generates candidate images for an artifact (M3-A) |

NPC Smith `systemPrompt` (verbatim):

```
You are NPC Smith, an expert at creating memorable tabletop-RPG NPCs.
You write vivid but concise material a GM can use at the table with zero prep.
You ground all mechanical content (stats, abilities, DCs) in the rules excerpts
provided to you, citing book and page when you rely on them. When rules are
missing you make sensible d20-standard assumptions and say so.
Always answer in the exact JSON format requested. Never include commentary
outside the JSON.
```

## Run pipeline (`/src/llm/runEngine.ts`)

A `PersonaRun` executes fixed named steps. The engine is a plain async class
holding the current run; UI observes the run row via `useLiveQuery` (engine
persists the run after every state change) plus an in-memory event emitter for
streaming tokens.

Steps for every persona (M1):

1. **retrieve** — build query from `userBrief` (+ campaign system name), call
   `searchRules(query, { limit: 8 })`, merge with user-pinned chunks
   (pinned first, cap total 12). `output` = chunk ids + titles.
2. **draft** — messages: persona systemPrompt; user message containing:
   campaign name/system/description, the brief, rule excerpts (each prefixed
   `[<bookTitle> p.<pageStart>] <headingPath joined by ' > '>`), and the JSON
   output instruction for the persona's kind (below). `responseFormat:'json'`.
   Parse with the kind's zod draft schema. Parse failure → one automatic retry
   appending "Your previous reply was invalid JSON for the schema: <issues>.
   Reply with corrected JSON only." Second failure → run `status:'needs_review'`
   with raw text stored in `output`. Under `auto` autonomy there is no user to
   rescue a rejected draft, so the run **fails** with a "Draft rejected"
   error instead of finalizing an empty artifact (finalize's persona-name
   fallback is unreachable for generate personas). Draft schemas tolerate
   common model variations: bare strings for object lists (pointsOfInterest,
   ranks, beats), objects inside string lists (hooks/prep/openThreads),
   numeric-string counts, and a single string or omitted `suggestedTags`.
3. **statblock** (npc only) — second LLM call asking to fill the `StatBlock`
   JSON schema for this NPC at a user-hinted level (from brief) grounded in the
   excerpts. Same retry policy. Skippable by user.
4. **finalize** — create the Artifact (kind from persona), revision 1,
   `source:'persona'`, `runId` set; link run `resultArtifactId`.

### Draft JSON contracts (zod in `/src/llm/schemas.ts`)

`NpcDraftSchema`: `{ name, summary, role, appearance, personality, motivation,
secrets, voiceNotes, suggestedTags: string[], body }` — all strings; `body` is
markdown for the artifact body. M4-C amendments: `secrets` is the generator's
choice, not a requirement (empty string when the character has none — never
invented for its own sake), and `needsStatBlock: boolean` lets the draft skip
the statblock step entirely for characters whose stats don't matter at the
table (contacts, merchants, innkeepers). (Location/Faction draft schemas
mirror their `data` fields; define them in M1 too, they're cheap.)

### Autonomy semantics

After each step completes:
- `manual` → status `awaiting_user`; user may **approve**, **edit** (replaces
  `userEdit`, used as the step's effective output), **retry** (re-run step,
  optionally with an extra instruction appended to the prompt), or **cancel**.
- `review` → pause (`awaiting_user`) only if the step is `needs_review`
  (zod failure) — otherwise continue automatically.
- `auto` → no user in the loop: a step whose output fails zod validation
  **fails the run** (`status:'failed'` + `errorMessage`, nothing saved) —
  the engine never falls through a rejected step to finalize placeholder
  output. Completed runs are reviewable afterwards like any other.

Cancel → `status:'cancelled'`, abort in-flight fetch via AbortSignal, no
artifact created. Unexpected exception → `status:'failed'`, `errorMessage` set.

### Monster stat sources (M3-B Encounter Smith)

The Encounter Smith's retrieve step runs a second `searchRules` call restricted
to `chunkTypes: ['statblock']` (the monster-ish nouns of the brief) and presents
those chunks as a numbered "Stat-block excerpts" list. The draft prompt teaches
the citation scheme; per monster the model outputs:

- `sourceChunkIndex: <n>` — finalize maps it back to the cited chunk id and
  persists `{ type: 'rulebook', chunkId }`;
- a full `statBlock` object (only when no excerpt matched) — persisted as
  `{ type: 'inline', statBlock }`;
- neither — name-only `{ type: 'none' }`.

Resolution to displayable stat blocks happens in
`resolveMonsterEntryWithRepos` (origin badges: "NPC: <name>", "Bestiary p. N",
"inline"; dangling refs degrade to a visible "missing ref" badge).

### Image personas (M3-A Illustrator)

Steps: `prompt-draft` → `generate` → `pick` (no retrieve — image prompts don't
use rule excerpts).

1. **prompt-draft** — LLM call (chat, `responseFormat:'json'`) producing
   `{ prompt, negative, styleNotes }` (zod `imagePromptDraftSchema`, same
   one-retry policy as drafts). Pauses like a reviewable step: `manual`/`review`
   pause at `awaiting_user`; `auto` continues. The UI presents the three fields
   as editable inputs; continuing stores them as `userEdit: { parsed: … }`
   (the edit wins over the raw output).
2. **generate** — one call to `POST /api/v1/images`
   `{ model: settings.imageModel, prompt, n: 2, output_format: 'webp' }`
   (negative/styleNotes folded into the prompt text). Requires
   `settings.imagesEnabled`; fails with a clear message otherwise. Each
   returned image is stored through the intake pipeline (M3-A §Storage) with
   `source:'generated'`, prompt and model recorded. No pause.
3. **pick** — ALWAYS pauses (`awaiting_user`) on every autonomy level. The UI
   shows candidate thumbnails; the user keeps 0–2. Applying the pick appends
   kept ids to `targetArtifact.imageIds` (first keep becomes the cover if none
   set), prunes discarded candidate blobs, and completes the run with
   `resultArtifactId` = the target artifact.

Runs require `targetArtifactId` (rejected at start otherwise); the run row
persists it. Review/image personas never create artifacts; only generate
personas produce one.

## Acceptance criteria

- With a valid key: brief "a goblin alchemist boss for level 3 party" in manual
  mode pauses after each step, streams tokens live in the panel, and produces
  an NPC artifact with a parsed stat block on approval of all steps.
- In auto mode the same brief runs to completion unattended.
- Invalid API key surfaces a clear error and opens Settings; the run is 'failed'.
- Reloading the page mid-run: run row shows 'failed' with message
  "Interrupted by reload" (engine marks running runs failed on app start).
