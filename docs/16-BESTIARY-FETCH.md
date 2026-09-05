# 16 — Bestiary Pack Fetch (user-triggered downloads from pinned sources)

Owner order (2026-09-05): **add user-triggered bestiary-pack fetching** — the
app downloads chosen packs from pinned upstream repos at the user's click and
feeds them into the existing `importPack` pipeline. This spec formalizes and
REVERSES one binding constraint of 12-BESTIARY-PACKS §1/§2 ("no network, no
fetch" in the import path); it is an explicit amendment, not drift.

## 1. Ratified decisions (binding, verbatim)

1. **Pack scope: curated + full-list toggle** — a curated recipe list per
   adapter by default (core bestiaries), plus an "advanced: list everything in
   the repo" toggle that lists all packs on demand.
2. **Source refs: pinned recipe refs** — pf2e `v14-dev`, dnd5e `6.0.x` (the
   spec-12-verified formats); the ref is stored in provenance.
3. **Location: the Settings menu** — a settings card, near the existing
   embeddings/grounding cards. The manual file-import dialog in `/rules` STAYS
   as the fallback.
4. **Flow: fetch → importPack in one user-triggered action**, with progress
   and the existing import-report semantics (loud, collected failures; zero
   valid entries → error book).

## 2. Amendment to 12-BESTIARY-PACKS (recorded there; binding)

The "no network, no bundling" rule is amended as follows (see §3 of doc 12):

- **12 §1, "No network, no bundling"** is replaced by: *The app never bundles
  or ships third-party content (nothing in the repo or the deployed bundle is
  third-party bestiary data; packs are fetched to the user's own browser from
  pinned upstream repos and stored in their own IndexedDB). Network fetching
  is allowed ONLY as the user-triggered pack fetch (16-BESTIARY-FETCH) from
  the pinned source repos listed there; the import pipeline itself stays
  network-free — adapters parse bytes they are handed (zero-network asserted
  by unit test). The user can still import pack files manually (unchanged
  fallback in `/rules`).*
- **12 §2** gains the preamble: *User-triggered fetch from the pinned sources
  of §16 changes the acquisition channel, not the licensing model: the fetch
  downloads to the user's own browser storage from the upstream repo the user
  chose — Campaigner never bundles, re-serves, or redistributes, and the book
  stores provenance (source ref, URL, fetch time) + license, displayed in the
  UI. The table's license strings are unchanged.*
- **12 §9/§10** gain the note: *the §9 "no fetching" non-goal and the §10
  "no network calls from the adapters" criterion are scoped to the import
  pipeline; fetching lives exclusively in `src/ingest/packFetch.ts`
  (16-BESTIARY-FETCH) — adapters and `packImport` still import no `fetch`.*

## 3. Engine decision (Phase A, verified 2026-09-05)

The fetcher runs in the **user's browser**, so every endpoint must serve
`Access-Control-Allow-Origin` for an arbitrary web origin. Verified evidence
(curl `-H "Origin: http://localhost:5173"`; sparse clones of both repos at the
pinned refs):

| Endpoint | CORS | Verdict |
|---|---|---|
| `raw.githubusercontent.com` | `access-control-allow-origin: *` (probe: pf2e `v14-dev/README.md`, HTTP 200) | **Primary file server for both sources.** No authenticated requests, no user-specific rate limit beyond normal CDN protection; unauthenticated GitHub-anonymous raw is the most permissive GitHub host for browsers. |
| `api.github.com` | `access-control-allow-origin: *`, `x-ratelimit-limit: 60` (60 req/h **per IP** — shared NAT/proxy/VPN egress exhausts it) | **Discovery fallback only.** `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` returned `truncated: false`, 7240 entries / 352 monster YAML blobs for dnd5e `6.0.x` (the 100k-entry cap is not approached); pf2e's full tree (29 672 pack blobs) could not be verified live — 60/h per IP ran out mid-mission (rate-limit error body, `remaining: 0`), which is itself the evidence for fallback-only status. |
| `codeload.github.com` (zipball) | `access-control-allow-origin: https://render.githubusercontent.com` (pin, not `*`); the browser's own CORS check applies per response in a redirect chain, and every redirect response must carry ACAO for the calling origin | **Rejected.** Even the initial response's pinned ACAO never matches a web origin — one-request repo zips are unusable from the app. |
| `github.com/<repo>/releases/download/...` → `objects.githubusercontent.com` | 302 → `release-assets.githubusercontent.com`; **final response carries no `access-control-allow-origin` at all** (probed pf2e `system.zip` @`pf2e-8.5.0`) | **Rejected.** |
| jsDelivr (`data.jsdelivr.com`, `cdn.jsdelivr.net`) | `access-control-allow-origin: *` when it answers, BUT: `@6.0.x` → 403 "Package size exceeded the configured limit of 50 MB"; `@v14-dev` → 404 "Couldn't find version 14-dev … not a version range or an npm tag" (branch names unsupported) | **Rejected as an engine.** Not documented as a fallback either. |

**Engine: per-file raw.githubusercontent.com fetches.** The pf2e repo ships no
NDJSON `.db` files in `packs/pf2e/**` at `v14-dev` (0 `.db` files in the
sparse checkout; 29 672 JSON blobs across 98 packs) and its releases carry no
usable single-file JSON assets (latest pf2e releases hold only `system.zip` /
`json-assets.zip` — no per-pack NDJSON), so no single-file fetch can bound
request counts; per-file raw is the only CORS-clean path. Bounded concurrency
(`mapWithConcurrency`) keeps wall-clock reasonable, and failures are collected
loudly rather than sequential-slow.

Fallback chain (documented, minimal): **raw → (discovery only) api.github.com
git/trees**. No third-party proxy is used anywhere; if raw fails (network down
/ GitHub down), the error is loud and named — no jsDelivr/proxy fallback.

### Listing (pack discovery)

- **Curated recipes** (default): constant lists in `src/ingest/packFetch.ts`
  — zero network for the default view.
- **Advanced "list everything"** (on-demand): pf2e uses **api.github.com
  git/trees** (`recursive=1` — pf2e's tree is beyond the 100k cap? No: the
  dnd5e tree was 7 240 entries with `truncated: false`; pf2e's ~35k-entry tree
  is comfortably below the 100k-entry recursion cap, but the **60 req/h per-IP
  limit can exhaust the listing even when the call itself succeeds** — the UI
  names the rate limit in the error when it happens; this is the documented
  degraded path). dnd5e's tree is small and verified `truncated: false`.
  Raw.githubusercontent.com cannot list directories (404-ish JSON, no index),
  so trees-API-or-nothing for the full list; the curated list never needs it.

## 4. Curated recipe list (Phase A deliverable)

Verified 2026-09-05 against sparse clones at the pinned refs (file counts =
creature documents, excluding `_folder.yml` metadata docs).

**pf2e** — repo [foundryvtt/pf2e](https://github.com/foundryvtt/pf2e), branch
`v14-dev`, layout `packs/pf2e/<pack>/<slug>.json` (flat; AP bestiaries nest
further, e.g. `gatewalkers-bestiary/book-1-.../x.json` — the recipe lists
packs, the fetcher recurses via the trees API when listing; curated recipes
point at flat core packs only):

| Recipe (book title) | Pack path | Creatures (verified) |
|---|---|---|
| Pathfinder Monster Core | `packs/pf2e/pathfinder-monster-core` | 492 |
| Pathfinder Monster Core 2 | `packs/pf2e/pathfinder-monster-core-2` | 446 |
| Pathfinder Bestiary | `packs/pf2e/pathfinder-bestiary` | 166 |
| Pathfinder Bestiary 2 | `packs/pf2e/pathfinder-bestiary-2` | 160 |
| Pathfinder Bestiary 3 | `packs/pf2e/pathfinder-bestiary-3` | 165 |
| Pathfinder NPC Core | `packs/pf2e/pathfinder-npc-core` | 272 |
| NPC Gallery | `packs/pf2e/npc-gallery` | 6 |
| Menace under Otari (free starter bestiary) | `packs/pf2e/menace-under-otari-bestiary` | 93 |

The mission brief's example names ("bestiary", "bestiary-2", "monster-core")
**do not exist** at `v14-dev` — the real folder names are the `pathfinder-*`
ones above (Phase A confirmation the brief asked for). Repo totals: 98 packs,
29 672 creature JSON blobs; every sampled document is `type: 'npc'`
(pathfinder-monster-core: 492/492).

**dnd5e** — repo [foundryvtt/dnd5e](https://github.com/foundryvtt/dnd5e),
branch `6.0.x`, layout `packs/_source/monsters/<type>/<slug>.yml`, **337
`type: npc` YAML files** across 15 type folders (aberration 6, beast 99,
celestial 7, construct 10, dragon 44, elemental 17, fey 7, fiend 24, giant
11, humanoid 41, monstrosity 40, ooze 5, plant 7, summons 14, undead 20; plus
15 `_folder.yml` metadata docs the fetcher skips), 9.37 MB total — one fetch
bounds every possible dnd5e request count at ~337 files, bounded by
`mapWithConcurrency`. The whole SRD monster set ships as **one dnd5e recipe**
("D&D 5e SRD Monsters — 337 creatures"); per-type splits add clicks, not
value. (Spec-12's "337 SRD monsters" re-verified exactly.)

## 5. UX (Settings → "Bestiary packs" card)

Per registered adapter with fetch recipes (pf2e + dnd5e; Cosmere has none),
each row: pack title + creature count + pinned ref badge (`v14-dev` /
`6.0.x`), license line, and a "Fetch & import" button. Advanced toggle "List
all packs in the repo" (on-demand trees-API listing; pf2e ~60+ packs incl.
every AP bestiary; dnd5e lists its 15 type folders as pack rows). Inline
progress ("Fetching X/Y files…"), then the standard import report (imported /
skipped / failed counts + expandable failed list) and the book lands in
`/rules` with Pack badge, license and provenance. Errors via `toastError`;
no-network / rate-limit / unknown-pack failures are loud and named. Fetching
"again" creates a new book (same policy as re-importing a PDF).

## 6. Data flow (no pipeline fork)

```
Settings card click (user-triggered)
  → packFetch.recipesFor(adapterId)          (curated constant)
  → [advanced] listPacks(adapterId)          (trees API, on demand)
  → fetchPackFiles(adapterId, recipe, {onFetchProgress})
       listing → select creature files (skip non-creature docs)
       → mapWithConcurrency(4) fetch raw.githubusercontent.com
       → PackInputFile[]  (+ collected download failures)
  → importPack(adapterId, files, { title, onProgress, deps })
       (UNCHANGED — zod, batches, report, zero-entries → error book)
  → finalize: packMeta + provenance (sourceRef, sourceUrl, fetchedAt)
```

`importPack` is called exactly as the `/rules` dialog calls it. `packFetch`
never touches Dexie or chunk persistence — the import runner owns that. Zero
valid entries → existing error-book semantics.

## 7. packMeta provenance extension (additive, no migration)

```ts
// packMetaSchema additions (all optional → old backups parse unchanged):
sourceRef: z.string().optional(),   // pinned ref, e.g. 'v14-dev' | '6.0.x'
sourceUrl: z.string().optional(),   // pack base URL (raw.githubusercontent.com/...)
fetchedAt: z.number().int().positive().optional(), // epoch ms; absent for manual imports
```

Backup round-trip: `rulebookSchema` parses old packs (no provenance) and new
packs (provenance present) unchanged; the backup zip dumps tables raw, so no
migration, no schema bump.

## 8. Failure policy

- Download failure = **failure entry with context** (`file` = relative pack
  path, `message` = `download failed: <status/statusText/network cause>`),
  folded into `importPack`'s existing failures list → visible in the report
  and `entriesFailed`. Never catch-and-continue into silence.
- Network/CORS failure on the FIRST request (before any file): the fetch
  throws a named error (`Failed to fetch <url>: <cause>`); the UI toasts it
  and the card shows the failed state. Never a silent empty book.
- Zero valid entries after downloads → existing `importPack` error-book path.
- Trees-API listing failure (rate limit, network): loud named error mentioning
  the 60 req/h per-IP GitHub limit when applicable; curated fetches never
  need the listing API.

## 9. Acceptance criteria

- Curated recipes pinned to the ratified refs (`v14-dev`, `6.0.x`) — test
  asserts the constants.
- Fetcher (mocked fetch): success path imports a ready book; a partial
  download failure is collected loudly (report + `entriesFailed`); zero-entries
  → error book; non-creature docs are skipped without requests; provenance
  stamped; concurrency bounded; CORS/network failure → loud named error.
- Adapters + `packImport` still import no `fetch` (existing zero-network tests
  untouched and passing; new grep-level assertion covers `packFetch` as the
  only fetch caller in `src/ingest`).
- Settings card renders curated lists, lists on demand via the advanced
  toggle, shows inline progress + report; packMeta backup round-trip holds.
- Gates: `pnpm lint && pnpm typecheck && pnpm test` green; lint stays at the
  4 pre-existing warnings.

## 10. Non-goals

- No bundling or shipping third-party content; no arbitrary user URLs.
- No scheduled/auto fetch; no update lifecycle beyond "fetch again creates a
  new book".
- No third-party proxy (jsDelivr or otherwise) — raw is the engine; if raw is
  unreachable the failure is loud, not proxied.
- No change to adapters, `packImport`, the `/rules` manual import dialog, or
  the encounter pipeline.

## 11. Milestones

- **F-1 — Engine**: `src/ingest/packFetch.ts` (recipes, listing, selective
  fetch, bounded concurrency, failure collection) + tests.
- **F-2 — Provenance**: packMeta additive fields + round-trip test.
- **F-3 — Settings UI**: the "Bestiary packs" card + tests.
