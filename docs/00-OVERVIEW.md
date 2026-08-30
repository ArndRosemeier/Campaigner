# Campaigner — Project Overview

Campaigner is a **pure client-side TypeScript web app** that helps a tabletop-RPG
Game Master build campaign and adventure material, mostly system-agnostic with
first-class support for d20 systems (D&D 5e, Pathfinder, Cosmere RPG, …).

## Core capabilities

1. **Rulebook ingestion**: import PDF rulebooks, extract and chunk their content,
   store it in an efficient internal format, and make it searchable.
2. **LLM personas**: specialist AI assistants (NPC Smith, Worldbuilder, …) that
   generate campaign artifacts, grounded in the ingested rules via retrieval.
   All LLM calls go through **OpenRouter** with a user-supplied API key.
3. **User-in-the-loop**: every generation pipeline has checkpoints; the user
   chooses per run whether to approve every step, only flagged steps, or none.
4. **Local-first storage**: everything lives in **IndexedDB** (via Dexie.js).
   No backend. Export all or parts of the work as JSON or PDF.

## Technology decisions (FINAL — do not revisit)

| Concern            | Choice                                              |
|--------------------|-----------------------------------------------------|
| Build tool         | Vite                                                |
| UI framework       | React 18 + TypeScript (strict)                      |
| Routing            | react-router v6                                     |
| Styling            | Tailwind CSS + shadcn/ui components                 |
| State (UI)         | zustand                                             |
| Storage            | Dexie.js (IndexedDB)                                |
| PDF parsing        | pdfjs-dist, run inside a Web Worker                 |
| Keyword search     | MiniSearch (in-memory index, rebuilt from Dexie)    |
| Semantic search    | OpenRouter embeddings, vectors stored in Dexie      |
| LLM API            | OpenRouter chat completions (fetch, streaming SSE)  |
| PDF export         | pdfmake (Milestone 2)                               |
| Zip bundling       | fflate (Milestone 2)                                |
| Schema validation  | zod (validates all LLM outputs and imports)         |
| IDs                | crypto.randomUUID()                                 |
| Testing            | vitest + @testing-library/react                     |

## Repository layout

```
/docs                  This spec suite (source of truth)
/src
  /app                 App shell, routing, layout, providers
  /components          Reusable UI components (incl. shadcn/ui in /components/ui)
  /db                  Dexie schema, migrations, typed table access
  /domain              Pure TS types + zod schemas for all entities (no IO)
  /ingest              PDF parsing worker + chunking pipeline
  /search              MiniSearch index, embedding client, hybrid retrieval
  /llm                 OpenRouter client, persona engine, run pipeline
  /features
    /campaign          Campaign tree, artifact editors
    /rules             Rules browser
    /personas          Persona panel, run checkpoints UI
    /settings          API key, model config
  /lib                 Small generic helpers
  /workers             Worker entry points
/tests                 Vitest test files mirroring /src
```

## Document map (read in order when implementing)

- `01-DATA-MODEL.md` — all entity types, zod schemas, Dexie schema
- `02-INGESTION.md`  — PDF → chunks pipeline, stat-block detection
- `03-RETRIEVAL.md`  — keyword + embedding hybrid search
- `04-LLM-PERSONAS.md` — OpenRouter client, persona definitions, run pipeline
- `05-UI.md`         — screens, layout, component inventory, interaction flows
- `06-MILESTONES.md` — ordered implementation tasks with acceptance criteria

## Global conventions (binding for all code)

- TypeScript `strict: true`; no `any` except at worker/JSON boundaries,
  immediately narrowed by zod parsing.
- All cross-module data shapes come from `/src/domain`; features never define
  their own copies of entity types.
- All IndexedDB access goes through `/src/db`; components never import Dexie.
- All LLM/JSON boundaries validated with zod `safeParse`; on failure the run
  enters a `needs_review` state, never throws to the UI.
- Every entity has `id: string` (UUID), `createdAt: number`, `updatedAt: number`
  (epoch ms).
- Errors shown to users via a single toast helper in `/src/lib/toast.ts`.
- No environment variables at build time; all configuration (API key, models)
  is user-entered at runtime and stored in Dexie `settings`.
