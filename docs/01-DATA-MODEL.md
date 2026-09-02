# 01 — Data Model

All types live in `/src/domain`. Each type has a zod schema (same file,
`<Name>Schema`) and the TS type is derived via `z.infer`. Dexie tables live in
`/src/db/db.ts`.

## Conventions

```ts
type Id = string;               // crypto.randomUUID()
interface BaseEntity {
  id: Id;
  createdAt: number;            // Date.now()
  updatedAt: number;
}
```

## Entities

### Campaign
```ts
interface Campaign extends BaseEntity {
  name: string;
  description: string;          // markdown
  system: GameSystem;           // see below
}
type GameSystem = 'dnd5e' | 'pathfinder2e' | 'cosmere' | 'generic-d20' | 'other';
```

### Artifact (the central content unit)

One table, discriminated by `kind`. Milestone 1 implements kinds
`npc | location | faction | note`; the union is designed to grow
(`encounter | plotarc | session | handout` in M2).

```ts
interface ArtifactBase extends BaseEntity {
  campaignId: Id;
  kind: ArtifactKind;
  name: string;
  tags: string[];
  summary: string;              // 1–3 sentences, shown in tree tooltips
  body: string;                 // markdown, the main free-text content
  links: ArtifactLink[];        // outgoing links
  currentRevision: number;      // starts at 1
  imageIds: Id[];               // referenced images (images table), gallery order (M3-A)
  coverImageId: Id | null;      // cover thumbnail for tree/PDF (M3-A)
}
type ArtifactKind = 'npc' | 'location' | 'faction' | 'note';

interface ArtifactLink {
  targetId: Id;                 // another Artifact
  relation: string;             // free text, e.g. 'member-of', 'located-in', 'ally-of'
}
```

Kind-specific structured data goes in a `data` field:

```ts
interface NpcArtifact extends ArtifactBase {
  kind: 'npc';
  data: {
    role: string;               // e.g. 'villain', 'quest giver'
    appearance: string;
    personality: string;
    motivation: string;
    secrets: string;
    voiceNotes: string;         // how to play them at the table
    statBlock: StatBlock | null;
  };
}
interface LocationArtifact extends ArtifactBase {
  kind: 'location';
  data: {
    locationType: string;       // 'city' | 'dungeon' | 'region' | free text
    inhabitants: string;
    pointsOfInterest: { name: string; description: string }[];
    hooks: string[];            // adventure hooks anchored here
  };
}
interface FactionArtifact extends ArtifactBase {
  kind: 'faction';
  data: {
    goals: string;
    methods: string;
    resources: string;
    ranks: { title: string; description: string }[];
  };
}
interface NoteArtifact extends ArtifactBase {
  kind: 'note';
  data: Record<string, never>;  // body/tags only
}
type Artifact = NpcArtifact | LocationArtifact | FactionArtifact | NoteArtifact;
```

### StatBlock (normalized d20)

One shared shape for all d20 systems; system-specific bits go into `extras`.

```ts
interface StatBlock {
  system: GameSystem;
  level: string;                // CR, level, or tier as printed, e.g. "CR 5", "Level 3"
  size: string;                 // 'Medium', etc.
  creatureType: string;         // 'humanoid (goblin)', class names for NPCs
  ac: number;
  acNote: string;               // 'natural armor', shield info…
  hp: number;
  hpFormula: string;            // '8d8 + 16', '' if unknown
  speed: string;                // '30 ft., fly 60 ft.'
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  saves: string;                // as printed, e.g. 'Dex +5, Wis +3'
  skills: string;
  senses: string;
  languages: string;
  traits: NamedText[];          // passive features
  actions: NamedText[];
  reactions: NamedText[];
  legendary: NamedText[];
  extras: Record<string, string>; // system-specific fields, key = label as printed
}
interface NamedText { name: string; text: string }
```

### Monster sources (M3-B)

Every `encounter` monster entry carries a `source` discriminated union that
says where its stats come from. Resolution is repo-backed
(`resolveMonsterEntryWithRepos`) over the pure dispatcher in
`/src/domain/encounterResolve.ts`; dangling references resolve to
`{ statBlock: null, origin: 'missing ref' }` so the UI renders a warning
badge instead of crashing.

```ts
type MonsterSource =
  | { type: 'npc-ref'; artifactId: Id }    // stats live on the linked NPC artifact
  | { type: 'inline'; statBlock: StatBlock } // one-off, embedded
  | { type: 'rulebook'; chunkId: Id }      // ingested statblock chunk (RuleChunk)
  | { type: 'none' };                      // name-only entry (pre-M3-B rows migrate here)
interface MonsterEntry { name: string; count: number; notes: string; source: MonsterSource }
```

Dexie upgrade `version(3)` fills `source: { type: 'none' }` on pre-M3-B
encounter rows. The Encounter Designer cites ingested stat-block excerpts via
`sourceChunkIndex` in its draft, which finalize maps back to
`{ type: 'rulebook', chunkId }` (see 04-LLM-PERSONAS.md).

### ArtifactRevision

Full snapshot per revision (simple, storage is cheap for text).

```ts
interface ArtifactRevision extends BaseEntity {
  artifactId: Id;
  revision: number;             // 1-based
  snapshot: Artifact;           // deep copy at save time
  source: 'user' | 'persona';   // who produced this revision
  runId: Id | null;             // PersonaRun that produced it, if source==='persona'
}
```
Saving an artifact: increment `currentRevision`, write the revision row, then
update the artifact row. Keep at most 50 revisions per artifact (delete oldest).

### Rulebook & RuleChunk

```ts
interface Rulebook extends BaseEntity {
  title: string;                // user-editable, default = PDF filename
  system: GameSystem;
  filename: string;
  pageCount: number;
  status: 'processing' | 'ready' | 'error';
  errorMessage: string;
  // The original PDF bytes are NOT stored (size); only extracted content.
}

interface RuleChunk extends BaseEntity {
  bookId: Id;
  pageStart: number;            // 1-based
  pageEnd: number;
  chunkType: 'section' | 'statblock' | 'table';
  headingPath: string[];        // e.g. ['Chapter 9: Combat', 'Grappling']
  text: string;                 // cleaned plain text of the chunk
  statBlock: StatBlock | null;  // parsed, when chunkType === 'statblock'
  contentHash: string;          // SHA-256 hex of `text`, for embedding cache
}
```

### ChunkEmbedding

```ts
interface ChunkEmbedding {
  contentHash: string;          // primary key; matches RuleChunk.contentHash
  model: string;                // embedding model id used
  vector: number[];             // stored as plain array; Float32Array in memory
}
```

### Persona & PersonaRun — see `04-LLM-PERSONAS.md` for full semantics

```ts
interface Persona extends BaseEntity {
  slug: string;                 // 'npc-smith' — unique, used in code
  name: string;                 // 'NPC Smith'
  description: string;
  systemPrompt: string;
  model: string;                // OpenRouter model id, e.g. 'anthropic/claude-sonnet-4.5'
  temperature: number;          // default 0.8
  producesKind?: ArtifactKind;  // artifact kind this persona outputs;
                                // omitted for image personas (mode 'image', M3-A)
  mode: 'generate' | 'review' | 'image';  // default 'generate'
  builtIn: boolean;             // built-ins are re-seeded on app start if missing
}

type Autonomy = 'manual' | 'review' | 'auto';
type RunStatus = 'running' | 'awaiting_user' | 'needs_review'
               | 'completed' | 'cancelled' | 'failed';

interface PersonaRun extends BaseEntity {
  campaignId: Id;
  personaId: Id;
  autonomy: Autonomy;
  status: RunStatus;
  userBrief: string;            // the user's task description
  pinnedChunkIds: Id[];         // user-pinned rule chunks
  steps: RunStep[];             // embedded array (runs are small)
  resultArtifactId: Id | null;
  targetArtifactId: Id | null;  // review (M2) / image (M3-A) personas: the artifact under review/decoration
  errorMessage: string;
}
interface RunStep {
  index: number;
  name: string;                 // 'retrieve' | 'draft' | 'statblock' | 'finalize' (generate personas)
                                // 'gather' | 'check' | 'finalize' (review personas, M2)
                                // 'prompt-draft' | 'generate' | 'pick' (image personas, M3-A)
  status: 'pending' | 'running' | 'done' | 'approved' | 'rejected';
  input: unknown;               // JSON-serializable
  output: unknown;              // JSON-serializable
  userEdit: unknown | null;     // user's edited version of output, if any
}
```

### Deliverable (M3-D)

A publishable adventure-module PDF built from an explicit, user-curated
outline — never derived implicitly from the tree. Own table
(`deliverables: 'id, campaignId'`, Dexie `version(5)`).

```ts
interface Deliverable extends BaseEntity {
  campaignId: Id;
  title: string;
  subtitle: string;
  audience: 'gm' | 'player';    // player: secrets/GM-only/tactics+treasure stripped
  coverImageId: Id | null;
  outline: OutlineNode[];
}
type OutlineNode =
  | { type: 'chapter'; title: string; children: OutlineNode[] }   // page-break banner, ToC entry
  | { type: 'part'; title: string; children: OutlineNode[] }      // group header inside a chapter
  | { type: 'artifact'; artifactId: Id; include: { body: boolean; data: boolean; statBlocks: boolean; images: boolean } }
  | { type: 'text'; markdown: string }    // interstitial prose
  | { type: 'gallery'; gallery: 'npcs' | 'treasure' };            // auto-generated back matter
```

Rendering conventions live in 07-MILESTONE-3.md (read-aloud blockquote boxes,
difficulty kickers, labeled per-kind sections, two-column stat boxes, images
at ≤ 45% width, NPC gallery + treasure ledger appendices, "missing artifact"
placeholders for dangling references). Renderer: `/src/lib/modulePdf.ts` +
`/src/lib/mdToPdfmake.ts`.

### StoredImage (M3-A)

Binary payloads live in their own table; artifacts reference them by id
(`imageIds`/`coverImageId`). Payloads are stored as `Uint8Array` bytes
(structured clone-safe), never Blobs; consumers rebuild a Blob at the
boundary. A blob is deleted only when no artifact AND no revision snapshot
references it anymore (reference-counted deletion in `imageRepo`).

```ts
interface StoredImage extends BaseEntity {
  campaignId: Id;
  bytes: Uint8Array;            // re-encoded at intake: EXIF-safe decode, ≤1600px long edge
  mimeType: string;             // actually encoded format ('image/webp' target, PNG fallback)
  width: number;
  height: number;
  prompt: string;               // generation prompt; '' for uploads
  model: string;                // image model id; '' for uploads
  source: 'generated' | 'uploaded';
}
```

### Settings (single row, id = 'settings')

```ts
interface Settings {
  id: 'settings';
  openRouterApiKey: string;     // '' when unset
  defaultChatModel: string;     // default 'anthropic/claude-sonnet-4.5'
  embeddingModel: string;       // default 'openai/text-embedding-3-small'
  embeddingsEnabled: boolean;   // default false until API key present
  imageModel: string;           // default 'google/gemini-2.5-flash-image' (M3-A)
  imagesEnabled: boolean;       // default false — image generation is opt-in (M3-A)
  language: 'en'|'de'|'fr'|'es'|'it'|'pt'|'nl'|'pl'|'ru'|'ja'|'zh';
                                // generation language, default 'en' — enforced
                                // in every chat completion via a system
                                // directive (see /src/llm/language.ts)
}
```

## Dexie schema (`/src/db/db.ts`)

```ts
import Dexie, { type Table } from 'dexie';

export class CampaignerDB extends Dexie {
  campaigns!: Table<Campaign, Id>;
  artifacts!: Table<Artifact, Id>;
  revisions!: Table<ArtifactRevision, Id>;
  images!: Table<StoredImage, Id>;      // M3-A
  rulebooks!: Table<Rulebook, Id>;
  chunks!: Table<RuleChunk, Id>;
  embeddings!: Table<ChunkEmbedding, string>;
  personas!: Table<Persona, Id>;
  runs!: Table<PersonaRun, Id>;
  settings!: Table<Settings, string>;

  constructor() {
    super('campaigner');
    this.version(1).stores({
      campaigns:  'id, name',
      artifacts:  'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions:  'id, artifactId, [artifactId+revision]',
      rulebooks:  'id, system, status',
      chunks:     'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas:   'id, &slug',
      runs:       'id, campaignId, personaId, status, updatedAt',
      settings:   'id',
    });
    // M3-A: new images table; artifacts gain imageIds/coverImageId; runs gain
    // targetArtifactId. The upgrade fills defaults on existing rows —
    // existing version blocks are never mutated.
    this.version(2)
      .stores({
        campaigns:  'id, name',
        artifacts:  'id, campaignId, kind, [campaignId+kind], name, updatedAt',
        revisions:  'id, artifactId, [artifactId+revision]',
        images:     'id, campaignId',
        rulebooks:  'id, system, status',
        chunks:     'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas:   'id, &slug',
        runs:       'id, campaignId, personaId, status, updatedAt',
        settings:   'id',
      })
      .upgrade(async (tx) => { /* imageIds [], coverImageId null, targetArtifactId null */ });

    // M5-B (09-MILESTONE-5): new battles table — one live battle per session
    // (id, campaignId, sessionId). Version 9's upgrade backfills the M5-C
    // fields the schema now expects: encounter artifacts gain
    // `mapImageId: null` and images gain `role: 'artwork'` (map-role images
    // take a 4096px intake cap and are the only battlemap pickers offer).
    this.version(9).stores({
      campaigns:  'id, name',
      artifacts:  'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions:  'id, artifactId, [artifactId+revision]',
      images:     'id, campaignId',
      rulebooks:  'id, system, status',
      chunks:     'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas:   'id, &slug',
      runs:       'id, campaignId, personaId, status, updatedAt',
      deliverables: 'id, campaignId',
      modules:    'id, campaignId, updatedAt',
      battles:    'id, campaignId, sessionId',
      settings:   'id',
    });
  }
}
export const db = new CampaignerDB();
```

## Repository layer

For each table create a module in `/src/db` (e.g. `artifactRepo.ts`) exposing
typed CRUD functions. Components use these repos via hooks built on
`dexie-react-hooks` (`useLiveQuery`) so the UI reacts to DB changes
automatically. **Rule:** components never call `db.*` directly — always through
a repo function or a `useLiveQuery` hook defined in the feature's `hooks.ts`.
