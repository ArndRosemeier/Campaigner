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

```sh
pnpm install
pnpm dev        # start the dev server
```

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
