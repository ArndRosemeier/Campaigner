# 04 — OpenRouter Client & Persona Engine

## OpenRouter client (`/src/llm/openrouter.ts`)

```ts
interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface ChatOptions {
  model: string; temperature: number;
  responseFormat?: 'json';       // sets response_format: { type: 'json_object' }
  signal?: AbortSignal;
  onToken?: (delta: string) => void;   // streaming callback
  onReasoning?: (delta: string) => void; // reasoning-delta stream (illustration only)
}
async function chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
```

- Endpoint `POST https://openrouter.ai/api/v1/chat/completions`, headers
  `Authorization: Bearer <settings.openRouterApiKey>`,
  `HTTP-Referer: 'https://campaigner.local'`, `X-Title: 'Campaigner'`.
- Always request `stream: true`; parse SSE per the WHATWG spec (`data: {json}` /
  `data: [DONE]`, `:`-prefixed keep-alive comments like `: OPENROUTER PROCESSING`
  are ignored), concatenate `choices[0].delta.content`, invoke `onToken` per delta.
  Reasoning deltas (`delta.reasoning` / `delta.reasoning_content`) drive the
  liveness probe ("thinking") and are forwarded via `onReasoning` for display
  only — they are never appended to the returned answer and never persisted.
- Stream completion: whichever comes first of `[DONE]`, a clean connection
  close, or `choices[0].finish_reason` (the terminal finish_reason repeats on
  OpenRouter's accounting usage chunk — treat it as an accounting frame, not a
  second terminal event). The reader is cancelled on completion/failure so the
  connection returns to the pool.
- Stream failures are surfaced, never hung: a top-level `error` field or
  `finish_reason: "error"` throws `OpenRouterError`; no bytes for 120s (stall
  watchdog, keep-alives count as activity) aborts with a stall error.
- Errors: non-200 → throw `OpenRouterError(status, bodyText)`. 429/5xx: retry
  twice with 2s/8s backoff before throwing. On a 429 a `Retry-After` hint
  (seconds or HTTP-date, capped at 30s) replaces the plain backoff, and every
  backoff carries ±25% jitter so parallel workers do not retry in lockstep.
  Missing API key → throw
  `MissingApiKeyError` (UI catches this and opens Settings).
- Rate limits are per OpenRouter ACCOUNT: paid models have no platform
  request cap (upstream provider limits apply, with automatic provider
  failover), while `:free` models are capped at 20 requests/minute and
  50–1000 requests/day (by lifetime credit history). Mid-stream 429s arrive
  as `finish_reason: "error"` and surface like any other stream failure.
  Parallel generation (Settings → Parallel requests, see 05-UI) multiplies
  simultaneous traffic — keep the level low for `:free` models.
- Model escalation (`/src/llm/modelFallback.ts`): when `fallbackChatModel` is
  set, `chat()` walks `[primary, fallback]` — a failure classified as
  congestion (429/5xx/408/timeouts) or filter (403/moderation phrasings)
  escalates to the fallback; aborts and anything else rethrow the original
  error, and an exhausted chain throws one combined error naming every
  model. Vision requests (image input) skip a fallback the cached `/models`
  data knows is text-only. `chat()` returns
  `ChatResult { text, modelUsed, fallback }`; run steps persist an
  escalation `notice` so a fallback is visible, never silent.
- Contract repair escalates too: the ONE automatic retry after a schema/
  contract failure runs on the fallback model when configured
  (`repairModel()`; vision repairs via `visionRepairModel()`), because a
  violated contract is usually a capability weakness of the first-try model.

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
| encounter-smith  | Encounter Smith   | encounter    | generate | Balanced encounters with monsters       |
| encounter-cartographer | Encounter Cartographer | encounter | encounter | Complete room layouts and generated battlemaps |
| continuity-editor | Continuity Editor | note        | review   | Reports contradictions in an artifact   |
| illustrator      | Illustrator       | —            | image    | Drafts an image prompt and generates candidate images for an artifact (M3-A) |

### Encounter Cartographer pipeline

Mode `encounter` runs fixed steps `brief → layout → schematic → stylize →
verify → pick → finalize`. The LLM brief contains roster sources, room purpose,
adjacency and roster indexes but no coordinates. Pure code packs and validates
geometry; the schematic becomes an image input reference; a multimodal vision
check classifies a coarse floor/wall/void grid and flags mismatches above 12%.
Manual runs pause at brief, layout and map pick; auto picks candidate one.
Regeneration preserves artifact identity, prose, links and roster while
replacing layout/map. Module batches request one candidate and continue after
per-encounter failures. All long paths report through the shared progress dock.

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

`NpcDraftSchema`: `{ name, summary, appearance, personality,
suggestedTags: string[], body, needsStatBlock: boolean }` — `body` is markdown
for the artifact body. The draft contract is deliberately minimal (M4-C
simplification: role/motivation/secrets/voiceNotes were removed — enforced
prose fields made every NPC same-shaped); whatever else a character needs
goes into the free-form `body`. `needsStatBlock` lets the draft skip the
statblock step entirely for characters whose stats don't matter at the table
(contacts, merchants, innkeepers). (Location/Faction draft schemas mirror
their `data` fields; define them in M1 too, they're cheap.)

### Autonomy semantics

After each step completes:
- `manual` → status `awaiting_user`; user may **approve**, **edit** (replaces
  `userEdit`, used as the step's effective output), **retry** (re-run step,
  optionally with an extra instruction appended to the prompt), or **cancel**.
  A schema-rejected output cannot be approved as-is: the user must retry or
  supply an edit that validates at that step boundary. Encounter verification
  is the exception — `rejected` there means a valid map exceeded the drift
  threshold and the user may deliberately continue.
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
