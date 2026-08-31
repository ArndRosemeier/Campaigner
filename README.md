# Campaigner

A **local-first, client-side** web app that helps tabletop-RPG game masters
build campaign and adventure material — system-agnostic, with first-class
support for d20 systems. No backend, no accounts: everything lives in your
browser (IndexedDB).

## Stack

Vite · React 18 (strict TypeScript) · Tailwind CSS v4 + shadcn/ui (dark
default) · react-router v6 · zustand · Dexie.js (IndexedDB) · zod ·
MiniSearch · pdfjs-dist · vitest + testing-library.

## Getting started

Prerequisites: Node 20+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev        # start the dev server
```

Open the printed URL (default `http://localhost:5173`). The app runs fully
client-side — no backend, no accounts.

## Usage

1. **Settings first (optional but recommended).** Open _Settings_ and paste an
   [OpenRouter](https://openrouter.ai) API key, pick a default chat model, and
   (optionally) enable embeddings for semantic search. _Test key_ verifies the
   key against OpenRouter. The _Danger zone_ deletes **all** local data.
2. **Create a campaign** on the picker screen — name, game system, description.
3. **Import a rulebook** in _Rules_: pick a PDF; it is parsed into searchable
   chunks (chapter headings, stat blocks, prose) in a web worker. Progress and
   per-book status show on each book card; failed books offer a _Retry…_ menu
   item (the original bytes are not stored — you re-select the file).
4. **Search & pin** rule text in the rules search box — keyword (and semantic,
   when embeddings are on) results show their source, book/page breadcrumb, and
   highlighted matches. Pin chunks to keep them attached to persona runs.
5. **Write with personas** from the workspace right pane: choose a persona
   (e.g. _NPC Smith_), an autonomy mode — _Manual_ (approve every step),
   _Review_ (pause on problems), _Auto_ (run through) — type a brief, and press
   _Start_. Each run streams its steps (retrieve → draft → stat block →
   finalize); approve, edit, retry, or cancel when prompted. Finished runs
   produce versioned artifacts in the campaign tree (full revision history,
   restore any snapshot). Beyond _NPC Smith_, the built-in set covers
   _Location Architect_, _Faction Designer_, _Plot Architect_, and _Session
   Chronicler_; the _Continuity Editor_ reviews any existing artifact for
   inconsistencies and writes a continuity report. Chain several personas in
   the _Writers' room_ tab: each step can hand its output to the next as
   context. Artifact kinds include NPCs, locations, factions, notes,
   encounters, plot arcs, and sessions.
6. **Export & import** — a single artifact, a selection, or a whole campaign as
   a JSON file (or a zip bundle with per-artifact files) via the tree's
   right-click menu or the picker screen; import always creates a fresh copy.
   Any artifact also exports as a PDF — _GM notes_ (everything incl. secrets
   and stat block) or a _player handout_ (name/summary/body only).
7. **See the web of links** with the _Link graph_ button above the tree:
   artifacts cluster by kind, edges carry their relation labels, and clicking
   a node opens the artifact.
8. **Manage embeddings** on the _Rules_ page: the embeddings panel shows how
   many chunks are embedded for the current model and lets you embed the whole
   library at once or clear the cache.
9. Everything persists locally in IndexedDB and survives reloads.

**In-app help:** press <kbd>?</kbd> anywhere (or the ? button in the top bar)
for searchable help, and every screen's header has a small ? button that opens
help for exactly that surface — including the non-obvious bits like
right-click menus, hover-to-delete buttons and persona chaining.

## Scripts

| Script           | Purpose                           |
| ---------------- | --------------------------------- |
| `pnpm dev`       | Vite dev server                   |
| `pnpm build`     | Type-check + production build     |
| `pnpm preview`   | Preview the production build      |
| `pnpm lint`      | ESLint (strict type-checked)      |
| `pnpm typecheck` | `tsc -b` (no emit)                |
| `pnpm test`      | Vitest (jsdom + testing-library)  |
| `pnpm format`    | Prettier (Tailwind class sorting) |

## Documentation

The `docs/` folder is the source of truth. Read in order:
`00-OVERVIEW.md` → `01-DATA-MODEL.md` … `05-UI.md`, with the ordered task
plan in `06-MILESTONES.md`.
