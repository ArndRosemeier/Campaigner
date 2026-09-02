# 09 — Milestone 5: Party & live battles

Ports the **encounter mechanism** of GM Cockpit (`/home/box/Harness/GM_Helper`,
external reference implementation — read-only, never a build dependency) into
Campaigner. GM Cockpit runs a live-table tactical board on a single tablet:
tokens on a gridded map, fog/veils, initiative, per-encounter HP, and a
player-safe table view. Campaigner already owns the *design-time* half — the
`encounter` artifact kind (monster roster with resolved stat blocks, terrain,
tactics) and Play mode. M5 adds the missing *run-time* half: **seed a battle
from an encounter artifact and run it at the table.**

Binding conventions from `00-OVERVIEW.md §Global conventions` and `AGENTS.md`
apply throughout (no silent fallbacks; zod at every boundary; failures loud).

## Naming (binding)

Campaigner's word "encounter" is taken: it is an **artifact kind** (designed
content). The live run is therefore a **battle** — `battles` table,
`BattleBoard` type, `features/play/battle/`, UI label "Battle". The artifact
stays the thing you design; the battle is the thing you run.

## Source audit (what ports, what doesn't)

GM Cockpit is ~18.6k LOC; the encounter mechanism is ~7.5k of it, cleanly
layered:

| Source area | LOC | Disposition |
|---|---|---|
| Pure engine (`host/encounter.ts`, `initiative.ts`, `veil.ts`, `gridSnap.ts`, gesture gates) | ~1,050 | **Port as-is** into `src/domain/battle/` — no React, no store, no IDB; retype IDs and the card/media accessors, add the tests the source never had |
| Domain types (`EncounterBoard`, tokens, veils, staging, combat block) | ~350 | **Port** as zod schemas in `src/domain/battle.ts` |
| Store actions (HostStore encounter surface) | ~1,050 | **Rewrite** as `battleRepo` (Dexie, normalize-on-write) + thin zustand/liveQuery wiring — source is `idb` + a hand-rolled store |
| UI (TableSurface 1,943, gestures 522, pan/zoom 419, initiative sidebar, inspector) | ~4,350 | **Re-skin/re-plug** against Tailwind/shadcn; the gesture hook's contract (local live-drag → commit on release) is kept |
| Persistence readers/migrations | ~1,100 | **Skip** — fresh Dexie schema; keep only the *pattern* (tolerant reader with loud warnings for imports) |

Zero automated tests exist in the source; every engine module gains vitest
coverage **during** the port (AGENTS gate: `pnpm lint && pnpm typecheck &&
pnpm test`).

Ported rules that are kept verbatim (they are the mechanism's substance):

- **HP ownership split**: players own current HP **on their artifact** (it
  persists between battles); NPCs own current HP **on the token instance**
  (fresh per battle). An NPC artifact must never store current HP.
- **Covered/hidden tokens are removed from the DOM and pruned from
  initiative** — that *is* the player-safe mechanic (there is no
  line-of-sight simulation; a "fog" veil renders above tokens, a "veil" is
  plain cover).
- **Initiative bonus is frozen onto the token at roll time** so later
  artifact edits never rewrite history.
- **One live battle per session**, created lazily on first mutation, deleted
  when it empties.

---

## M5-A — Party: the `pc` artifact kind

Player characters become artifacts (kind `'pc'`) — useful before any board
exists (tree, quick-find, player-audience deliverables) and required by the
battle (auto-included fighters).

### Schema (extend `src/domain/artifact.ts`, one `db.version(8)`)

```ts
export const pcDataSchema = z.object({
  /** The human player's name; '' for GM-run PCs. */
  playerName: z.string(),
  /** Same normalized d20 shape NPCs carry; null until filled in.
   *  The battle engine REQUIRES it for initiative/HP — a statless PC is a
   *  loud warning in the UI, never a silent placeholder. */
  statBlock: statBlockSchema.nullable(),
  /** Owned by the PC (not the battle): whole number, 0..maxHp. */
  currentHp: z.number().int().min(0),
  /** Extra initiative bonus on top of the dex modifier (Alert etc.); null = dex only. */
  initiativeOverride: z.number().int().nullable(),
  notes: z.string(),
});
```

- `kind: 'pc'` joins `ArtifactKind`; tree gains a **Party** group at the top
  of the campaign tree; quick-find and Play's context grid index PCs.
- Artifact editor form: name, player name, HP stepper, initiative override,
  notes, stat-block editor (reuse the existing stat-block rendering;
  manual entry is acceptable — full statblock required only before a battle).
- Portrait comes from the existing image pipeline (`coverImageId`) and later
  doubles as the token art.
- Deliverables: `audience: 'player'` renders PC cards (name, portrait, HP —
  no notes with secrets).

### Dexie (version 8)

No data migration (new kind, new table below) — the upgrade only adds
defaults for the schema changes in M5-C.

---

## M5-B — Battle domain, engine, persistence

### Types & zod (`src/domain/battle.ts`)

Direct retyping of the source board; every field validated, strict:

```ts
const battleTokenSchema = z.object({
  id: z.uuid(),
  /** Artifact-backed (pc/npc) or null for geometric stamps. */
  artifactId: z.uuid().nullable(),
  /** For npc-backed tokens: which roster entry instance this is. */
  label: z.string(),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), // normalized board coords
  visible: z.boolean(),
  scale: z.number(),                 // 0.5 | 1 | 2 | 3 …
  shape: z.enum(['circle', 'square', 'portrait']),
  color: z.string().nullable(),      // stamp fill; null for portraits
  /** NPC instance HP (null for PCs — the pc artifact owns it — and stamps). */
  currentHp: z.number().int().min(0).nullable(),
  initiativeRoll: z.number().int().min(1).max(20).nullable(),
  /** Frozen copy of the artifact's bonus at roll time. */
  initiativeBonus: z.number().int().nullable(),
  conditions: z.array(z.string()),
});
const battleVeilSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['veil', 'fog']),
  x: z.number(), y: z.number(),
  widthCells: z.number().int().min(1), heightCells: z.number().int().min(1),
});
const stagingGroundSchema = z.object({ x, y, cellWidth, cellHeight }); // normalized 3×3
const battleBoardSchema = z.object({
  mapImageId: z.uuid().nullable(),
  live: z.boolean(),                     // false = prep scratch, true = on the table
  tokens: z.array(battleTokenSchema),
  veils: z.array(battleVeilSchema),
  gridSize: z.number().min(16).max(128).nullable(),  // CSS px; null hides grid
  tokenSize: z.number().min(16).max(128),
  sceneryMovementLocked: z.boolean(),
  initiativeEnabled: z.boolean(),
  initiativeOrder: z.array(z.uuid()),    // token ids; activeIndex indexes it
  activeIndex: z.number().int().min(0),
  stage: stageSnapshotSchema.nullable(), // saved opening layout for Reset
  stagingGround: stagingGroundSchema.nullable(),
});
export const battleSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  sessionId: z.uuid(),                   // the session artifact this battle belongs to
  encounterArtifactId: z.uuid().nullable(), // what seeded it (provenance)
  board: battleBoardSchema,
});
```

Constants ported: `STAGING_GROUND_CELLS = 3`, `VEIL_DEFAULT_CELLS = 2`,
`GRID_DEFAULT = 72`, `TOKEN_RING_OUTSET_PX = 4`. Dropped in v1: token
`tracks` (per-instance counters) — conditions stay.

### Engine (`src/domain/battle/`, pure, no React/IO)

- `board.ts` — empty board, spawn point in the staging ground, stage
  capture/clone/reset, token scrub (artifact deletion removes its tokens),
  HP fill/repair (`combatHpForToken` → `{ maxHp, currentHp, ownedBy: 'artifact' | 'token' }`,
  loud errors on missing stats).
- `initiative.ts` — roll (d20 via `Math.random`, bonus frozen), sort (total
  desc → bonus desc → label A–Z), prune-to-visible-fighters with
  `activeIndex` adjustment, order splicing, next-turn cycling.
- `veil.ts` — cell metrics, edge resize (center-preserving, cell-quantized),
  portrait-covered-by-veils test.
- `gridSnap.ts` + `gestureGate.ts` — snapping and the two module-level drag
  gates (copied verbatim; ~53 LOC, zero deps).

Max HP and initiative bonus resolve through the existing
`resolveMonsterEntry` machinery for NPCs and through `pcDataSchema` for PCs —
the engine receives plain numbers, never Dexie.

### Persistence (`src/db/battleRepo.ts`, `db.version(8)`)

```ts
battles: 'id, campaignId, sessionId'
```

- **One live battle per session**: `ensureBattle(sessionId)` returns the row
  or lazily creates an empty one (source rule: no "create" action exists).
- **Normalize on write** (repo-level, the analog of the source's
  `normalizeEncounter`/`fillTokenCurrentHp`): every put re-fills NPC token HP
  from the backing artifact's statblock when `null`, re-ensures PC tokens
  exist for every PC artifact of the campaign, and clamps HP to `[0, maxHp]`.
- UI reads via `useLiveQuery`; drag commits are single repo calls (the
  component holds transient live-drag state locally, exactly the source's
  `liveDrag` pattern).
- Deleting the last non-PC token with no map deletes the battle (source rule);
  deleting a pc/npc artifact scrubs its tokens.

### Tests (mandatory, the source has none)

Initiative reconcile/prune/adjust, veil coverage, snap metrics, HP ownership
transitions, stage reset, staging-ground spawn layout — ported behavior as
golden tests against the pure modules.

---

## M5-C — Seeding a battle from an encounter artifact

### Schema additions

- `encounterDataSchema` gains `mapImageId: z.uuid().nullable()` (upgrade
  default `null`): the designed battlemap, set from the existing image
  pipeline.
- `storedImageSchema` gains `role: z.enum(['artwork', 'map'])` (upgrade
  default `'artwork'`). Map-role images bypass the 1600px intake re-encode
  (cap 4096px long edge) — a full-table map at 1600px is unreadably blurry.
  Map pickers only offer map-role images.

### "Run battle" flow

On encounter cards in Play (and the workspace editor header): **Run battle**
→

1. `ensureBattle(activeSessionId)`; if a battle already runs, confirm
   (replace = fresh seed, stage snapshot discarded).
2. Seed map: the encounter's `mapImageId`, else the linked location's cover
   image if it is map-role, else no map (viewport board — source behavior).
3. Expand the roster: each `MonsterEntry` with resolved stats
   (`resolveMonsterEntry`) produces `count` portrait tokens ("Goblin 1..n"),
   `maxHp` from the statblock, `currentHp` = max, dex modifier (+ PC-style
   override on the npc data, if present) as the initiative bonus. Sources
   `type: 'none'` (name-only rows) seed as **tokens without HP that are
   excluded from initiative**, shown with a loud "no stats" badge — never a
   placeholder number (AGENTS rule 1).
4. Ensure PC tokens: every `pc` artifact of the campaign spawns row-major in
   the staging ground (default center of the board). Statless PCs are
   skipped with the same loud badge.
5. Stamp the row's `encounterArtifactId`; `live: false` until "Show battle".

---

## M5-D — Table surface (battleground UI)

`/src/features/play/battle/`, entered from Play via **Show battle** (and
 seeded boards render embedded in the GM view first), exited via **✕ Lift**.
Full-screen, dark, tablet-first (`(any-pointer: coarse)` aware like the
source). Rendered with `data-player-safe="true"` when shown to players.

**Rendering contract (the player-safe rules):** the table surface renders
ONLY the board — map, grid, visible portrait tokens (art or deterministic
initials fallback), stamps, veils/fog, staging ground, initiative sidebar
(totals + turn arrow), vertical HP fill meters, downed overlay at 0 HP. No
artifact bodies, no stat text, no notes, no secrets. Tokens under a fog/veil
and `visible: false` tokens are **removed from the DOM** (not dimmed) and
pruned from initiative. **Token tap shows name + image + HP only** — the
source's inspect modal on the table surface opens the full card with secrets
revealed one tap from the player-facing screen; that flaw is explicitly fixed
here (full inspection happens back on the GM view).

**Interaction:**

- Drag (≥8px threshold): live local position with grid snapping, single repo
  commit on release; tap = select; scenery lock rejects stamp/veil moves.
- Pan/zoom (0.35–80, pinch + wheel + buttons), DOM-transform based; on coarse
  pointers portrait tokens render in a screen-space overlay so art stays
  crisp.
- Veils: add veil/fog, resize from n/e/s/w handles (hidden while scenery is
  locked).
- Stage: **⚑ Set stage** (confirm) captures the snapshot; **↻ Reset**
  restores geometry, clears initiative, resets NPC instance HP to artifact
  max, re-spawns missing PCs at the staging ground, stays live.
- Initiative: enable → every visible fighter rolls (d20 + frozen bonus; PCs
  and NPCs alike); reconcile-on-change (reveal → auto-roll, cover/hide →
  prune) suppressed during sidebar reorder drags via the gesture gate;
  drag-to-reorder; **>>>** next turn with the floating turn marker.
- Damage/heal: token float controls with a numeric delta (clamped
  `0..maxHp`), writing to the token (NPC) or the pc artifact (PC). A plain
  random roller (d20/d6 totals) is built in; **no 3D dice dependency**.

---

## Suggested build order

M5-A → M5-B → M5-C → M5-D; each is independently shippable. A is the small
standalone win. B is where the tests live. D is the big bet (the source's
TableSurface is 1,943 LOC and the least portable piece) — ship a first cut
without pan/zoom overlay polish, then iterate. Effort shape: ~1.4k LOC ports
nearly as-is (engine + types), ~1k re-binds to Dexie/repos, ~4k UI re-plug.

## Acceptance criteria

- A campaign with 2 `pc` artifacts (statblocks filled) and an encounter
  artifact ("3 goblins via rulebook source, 1 troll via npc-ref", a map-role
  map): **Run battle** → **Show battle** yields a full-screen board with the
  map, 4 monster tokens with filled HP, 2 PC tokens at the staging ground;
  enabling initiative rolls all six, sorted desc with a turn marker.
- Dragging a fog veil over a monster removes its token from the board *and*
  its entry from initiative; pulling it back restores both with an auto-roll.
- Damaging a troll to 0 shows the downed overlay; **↻ Reset** restores its
  HP to the NPC artifact's max; damaging a PC writes the PC artifact's
  `currentHp` (persists across battles).
- **⚑ Set stage** → rearrange → **↻ Reset** restores the exact opening
  layout.
- Deleting an NPC artifact removes its tokens from every battle; a statless
  PC/monster is loudly badged and excluded from initiative — no placeholder
  HP anywhere.
- The table surface contains no stat text and no secrets in the DOM at any
  point (token tap = name/image/HP), verified by a test asserting the
  rendered surface.
- `pnpm lint && pnpm typecheck && pnpm test` passes with the new engine
  modules fully covered.

## Non-goals

- Authoring board setups back into encounter artifacts (the source's
  "encounter card" snapshot) — later enhancement; v1 stages snapshots live on
  the battle only.
- Token `tracks`/counters, line-of-sight, token collision rules, lighting.
- Multiplayer, player devices, any sync — single screen, second render
  surface only (as in the source).
- 3D dice (`@3d-dice/dice-box`), AI battlemap sketching (the existing image
  pipeline covers map creation), cross-module battle persistence beyond the
  session row.
- Importing GM Cockpit archives.
