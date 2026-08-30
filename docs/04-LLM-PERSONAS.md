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
- Always request `stream: true`; parse SSE lines (`data: {json}` / `data: [DONE]`),
  concatenate `choices[0].delta.content`, invoke `onToken` per delta.
- Errors: non-200 → throw `OpenRouterError(status, bodyText)`. 429/5xx: retry
  twice with 2s/8s backoff before throwing. Missing API key → throw
  `MissingApiKeyError` (UI catches this and opens Settings).

## Built-in personas (`/src/llm/personas/builtins.ts`)

Seed on app start (insert if slug missing; never overwrite user edits).
Milestone 1 ships **NPC Smith** fully wired; the other definitions are seeded
but their runs reuse the exact same pipeline with different prompts and
`producesKind` (implement in M2 — pipeline must not hardcode NPC anywhere
except step `statblock`, which runs only when `producesKind === 'npc'`).

| slug             | name              | producesKind | one-line purpose                       |
|------------------|-------------------|--------------|----------------------------------------|
| npc-smith        | NPC Smith         | npc          | Memorable NPCs with stat blocks         |
| worldbuilder     | Worldbuilder      | location     | Regions, cities, dungeons               |
| faction-designer | Faction Designer  | faction      | Factions with goals, methods, ranks     |
| plot-architect   | Plot Architect    | note         | Adventure/campaign arcs and hooks       |

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
   with raw text stored in `output`.
3. **statblock** (npc only) — second LLM call asking to fill the `StatBlock`
   JSON schema for this NPC at a user-hinted level (from brief) grounded in the
   excerpts. Same retry policy. Skippable by user.
4. **finalize** — create the Artifact (kind from persona), revision 1,
   `source:'persona'`, `runId` set; link run `resultArtifactId`.

### Draft JSON contracts (zod in `/src/llm/schemas.ts`)

`NpcDraftSchema`: `{ name, summary, role, appearance, personality, motivation,
secrets, voiceNotes, suggestedTags: string[], body }` — all strings; `body` is
markdown for the artifact body. (Location/Faction draft schemas mirror their
`data` fields; define them in M1 too, they're cheap.)

### Autonomy semantics

After each step completes:
- `manual` → status `awaiting_user`; user may **approve**, **edit** (replaces
  `userEdit`, used as the step's effective output), **retry** (re-run step,
  optionally with an extra instruction appended to the prompt), or **cancel**.
- `review` → pause (`awaiting_user`) only if the step is `needs_review`
  (zod failure) — otherwise continue automatically.
- `auto` → pause only on `needs_review`; `finalize` always runs, user reviews
  the artifact afterwards.

Cancel → `status:'cancelled'`, abort in-flight fetch via AbortSignal, no
artifact created. Unexpected exception → `status:'failed'`, `errorMessage` set.

## Acceptance criteria

- With a valid key: brief "a goblin alchemist boss for level 3 party" in manual
  mode pauses after each step, streams tokens live in the panel, and produces
  an NPC artifact with a parsed stat block on approval of all steps.
- In auto mode the same brief runs to completion unattended.
- Invalid API key surfaces a clear error and opens Settings; the run is 'failed'.
- Reloading the page mid-run: run row shows 'failed' with message
  "Interrupted by reload" (engine marks running runs failed on app start).
