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
  producesKind: ArtifactKind;   // artifact kind this persona outputs
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
  errorMessage: string;
}
interface RunStep {
  index: number;
  name: string;                 // 'retrieve' | 'draft' | 'statblock' | 'finalize'
  status: 'pending' | 'running' | 'done' | 'approved' | 'rejected';
  input: unknown;               // JSON-serializable
  output: unknown;              // JSON-serializable
  userEdit: unknown | null;     // user's edited version of output, if any
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
}
```

## Dexie schema (`/src/db/db.ts`)

```ts
import Dexie, { type Table } from 'dexie';

export class CampaignerDB extends Dexie {
  campaigns!: Table<Campaign, Id>;
  artifacts!: Table<Artifact, Id>;
  revisions!: Table<ArtifactRevision, Id>;
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
