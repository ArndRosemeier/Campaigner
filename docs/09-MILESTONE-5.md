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
  line-of-sight simulation; a "fog" renders above tokens, a "veil" is
  plain cover). As shipped (ledger 65, 2026-09-09) the two kinds read
  differently: fog is an opaque, blocking cover (since 2026-09-10 an
  animated grey cloud), veil is a transparent one whose taps pass through to
  the room-key marker beneath it — see the M5-D veil amendment below, which
  supersedes the 8fa7abd 10% tint. Since 2026-09-10 (fog-cloud arc,
  owner-directed) a **generated cover over a mob area is a VEIL, not a
  fog** — the seeder seeds the transparent kind, because coverage (not the
  fill) is what hides mobs and a cover is what the GM draws a fog for.
- **Initiative bonus is frozen onto the token at roll time** so later
  artifact edits never rewrite history.
- **One live battle per session**, created lazily on first mutation, deleted
  when it empties.

---

## M5-A — Party: the `pc` artifact kind

Player characters become artifacts (kind `'pc'`) — useful before any board
exists (tree, quick-find, the player-audience module PDF) and required by the
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
- The module PDF's player document renders PC cards (name, portrait, HP — no
  `notes`, which are GM material; docs/07 §M3-D).

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
- `effect.ts` (veil-parity arc) — SYMMETRIC edge resize for effect markers
  (`resizeEffectFromEdge`: the single `sizeCells` span grows from every
  handle with the center fixed, cell-quantized via `veilSpanNorm`, min
  `EFFECT_MIN_CELLS`).
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
   Amended 2026-09-06 (encounter-resume arc, resume-by-default): *a module
   whose running battle already carries THIS encounter's provenance
   (`battle.encounterArtifactId === encounter.id`) never re-seeds from the
   button — it offers **Open battle**, a plain navigation onto the persisted
   board. Re-seeding the same encounter is the explicit **Re-run battle** →
   "Replace running battle?" two-step; a battle from a different encounter
   keeps the confirm-first replace.* Amended 2026-09-06 (encounter-resume
   arc, reseed provenance): *every REPLACE now stamps an additive
   `battle.reseed` line on the row — `{ at, encounterArtifactId,
   encounterName }` (`null` for the original seed, epoch-ms `at` matching the
   entity stamps) — so the row itself answers who/when/what replaced the
   board, and the battle surface offers a destructive two-step **Re-seed**
   that re-runs this exact path against the row's own provenance encounter.*
   Amended 2026-09-06 (encounter-resume arc, in-battle spawn): *the battle
   surface's GM rail gains a **Spawn** panel listing the PROVENANCE
   encounter's roster (GM mode only; hidden without provenance). Each
   "Spawn" appends ONE instance to the live board through the shared
   `expandRosterEntries` path — the exact seeding identity rules (npc-ref by
   reference, ONE mob artifact per cited chunk with ONE deduped seed row,
   inline frozen rows, statless entries HP-less + loud toast), never a stat
   copy. Labels continue the on-board count ("Troll 2"), placement takes the
   next staging-ground cell (fallback cascade without one), and with
   initiative on the latecomer is auto-rolled into the order
   (useInitiativeReconcile). Spawn appends — live/everLive, the stage
   snapshot and existing pieces are untouched.*
2. Seed map: the encounter's `mapImageId`, else the linked location's cover
   image if it is map-role, else no map (viewport board — source behavior).
   Amended 2026-09-08 (single-map-slot arc, docs/11 D16): *precedence is
   unchanged (mapImageId → location map-cover → null), but branch 1 now
   checks EXISTENCE — a `mapImageId` whose image row is gone falls through
   to the location-cover branch with a loud toast, never a frozen dangling
   id on the board. Freshness follows from the same rule: seeding reads the
   CURRENT map, so a seed after a regenerate picks up the new board copy
   while never-opened battles converge and live ones stay frozen.*
3. Expand the roster: each `MonsterEntry` with resolved stats
   (`resolveMonsterEntry`) produces `count` portrait tokens ("Goblin 1..n"),
   `maxHp` from the statblock, `currentHp` = max, dex modifier (+ PC-style
   override on the npc data, if present) as the initiative bonus. Sources
   `type: 'none'` (name-only rows) seed as **tokens without HP that are
   excluded from initiative**, shown with a loud "no stats" badge — never a
   placeholder number (AGENTS rule 1).
   Amended 2026-09-05 by afa23f4/070d4ba (mob-artifact arc): *a statful
   RULEBOOK entry now seeds all its instances on ONE shared npc artifact —
   the entry's `mobArtifactId` (stamped by finalize) or, for rows written
   before the marker, the lazily get-or-created artifact keyed by the cited
   chunk — and freezes ONE `seedFighters` row under that artifact id (stats
   still resolved from the chunk via the fighterStats fallthrough). Inline
   entries keep per-instance synthetic ids; statless entries are unchanged.
   Portraits ride the existing `coverImageId` token path (11 §"D5 amendment
   — mob portraits").*
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
here (full inspection happens back on the GM view). Amended 2026-09-06 by
fba12b7: *the tap contract ships as a selection card in the right rail —
portrait art + label + HP meter in BOTH modes (player-safe included; the
card renders only what the board already shows: cover art via the shared
useImageUrl path, label, HP), plus a GM-only allowance in GM mode: an
"Open card" button mounts the existing full NpcCard (statblock included) in
a dialog for NPC tokens that resolve to a statblock. The button never
renders in player-safe mode — stat text still never enters the DOM there —
and tapping the empty board deselects.* Amended 2026-09-06 by 8fa7abd:
*veils render at a ~10% tint in BOTH views — veil `bg-black/10`, fog keeps
its light tint at `bg-zinc-200/10` — because the veil's job is to mark
unexplored ground and hide mobs, not to blind the GM to their own map.
Selection and dragging read via outline + lift (`ring-2 ring-amber-400`,
drag adds `z-20`), never opacity swings; the solid amber resize handles
carry the resize affordance, so the translucent fill hides nothing. Coverage
is scoped to MOB tokens by the seed-chain fighter kind (seedFighters rows
for rulebook/inline monsters and npc artifacts for npc-ref monsters resolve
kind 'npc'; PCs resolve 'pc'; statless tokens and stamps are absent from the
stats lookup and are never coverage-hidden) — no new schema field. Coverage
removal from the DOM is a player-view behavior: player view removes veiled
mob tokens, GM view sees everything under its own veils, and every token
that survives renders ABOVE the veil (veils mount first in the content
frame). The initiative prune stays mode-independent and mob-scoped: a
veiled mob is not yet in play and re-enters with an auto-roll on reveal;
fogged PCs now roll and stay in the order.* **The 8fa7abd fog-tint rule in
that amendment is SUPERSEDED 2026-09-09 (ledger 65, owner-ratified) — read
the next amendment before restoring the 10% fog tint** (the coverage and
initiative rules that follow it in the same amendment stand unchanged).

Amended 2026-09-09 (ledger 65 — the fog/veil distinction, owner-ratified,
**supersedes the 8fa7abd 10%-in-both-views rule** above): *the two kinds do
different things again, keyed off `veil.kind` — `kind` already encodes the
seeder's fog intent, so existing AND newly seeded rows light up with no data
migration and NO new field. **Fog is OPAQUE and blocks**: a solid
`bg-zinc-300` fill (alpha-free, never `opacity-*`), rendered identically in
GM and player view, and a sub-threshold tap on a fog selects the fog and
stops there. **Veil is transparent and clicks through**: it keeps the
`bg-black/10` tint, and a sub-threshold tap on its body that lands inside a
room-key marker's 44px hit pad opens that room's key instead of merely
selecting the veil (markers stay BELOW veils with `z-index: auto` — 469f058
— so pass-through, never z-index, is what makes a covered key reachable).
The earlier "must not blind the GM" reasoning was overridden because it was
not the actual risk: tokens still paint ABOVE the veils by DOM order, the GM
can still drag a fog aside, delete it, or lift it with "Reveal next room" —
while at ~10% the two kinds were visually the same thing, which is exactly
the bug the owner reported ("fog and veil … do the exact same thing"). The
GM is not blinded by an opaque rectangle they own and can move. Both tool
buttons are pinnable now (`data-testid="veil-tool"` / `fog-tool`): before
this they had no testid, so no test could click either one. Reversal is one
ternary (the fill) plus the tap branch; ledger 65 records the reasoning.
Both buttons call the ONE creator `addVeil(kind)`, and `kind` is the single
behavioral and visual switch — there is no second fog mechanism to keep in
sync.* **The `bg-zinc-300` FILL named in this amendment — and its phrase "the
seeder's fog intent", which no longer describes the seeder — are SUPERSEDED
2026-09-10 (fog-cloud arc): read the next amendment before restoring the flat
slab or seeding fog over mobs. Everything else here still stands unchanged:
fog opaque and blocking, veil transparent and pass-through, the two tool
buttons, the tap rules and the two-ternary reversal shape.**

Amended 2026-09-10 (fog-cloud arc — three owner-directed reports in one
pass, ratified by the reports themselves; supersedes only the `bg-zinc-300`
fill above): *first, **"The mobs should be covered by a veil, not fog"** —
`veilsFromSpawnClusters` (the seeder) and `veilsFromRooms` (the legacy
helper) emitted every generated cover with `kind: 'fog'`, i.e. the opaque
BLOCKING kind over a mob cluster. They now emit `kind: 'veil'`, which is the
kind the job actually needs: coverage is kind-agnostic (`portraitCoveredByVeils` over all veils; player view removes the covered mob tokens from the
DOM, initiative prunes them, and a veiled mob re-enters with an auto-roll on
reveal), so the fill is free to be the transparent one — and being plain
cover repairs a real access bug: a room-key marker sits at its room's
`mobsRect` CENTRE, inside the generated cover by construction, and markers
stay BELOW veils, so while the seeded kind was a blocking fog the keyed
room's OWN key marker was unreachable by tap; as a veil the same tap passes
through and opens the key. Fog stays the GM-drawn opaque, blocking kind —
ledger 65 is untouched. Seeding geometry is untouched too: `VEIL_MIN_CELLS`,
the one-cell cover margin, the overlap merge (union bounding box under the
first-emitted ROOM id the Path rail resolves), `roomId`, and the loud throw
for a vision room without a `mobsRect` all behave byte-identically; the
Path rail resolves rooms by `veil.id`/`veil.roomId`, never by kind, so
"Reveal next room" is unaffected in intent AND in behavior. Second, **"Right
now its just a white opaque rectangle. I would like this to be grey-ish and
animated, cloudy with some contrast, not just mushy"** — fog's fill is now
the `battle-fog-cloud` class (index.css): three layered radial gradients
(alpha-free greys, near-white puffs over dark patches) combined with
`background-blend-mode` only, drifting on ONE `background-position`
animation — no per-frame JavaScript, no timers, one cheap CSS animation per
fog rect. It stays OPAQUE and blocking: no `opacity-*`, no alpha channel, no
`mix-blend-mode` (which would blend the fog with the map behind it and make
it see-through), and the class sets no `position`/`z-index` (an unlayered
rule would win the cascade against the board's own `absolute` positioning
and the markers-below-veils paint order). `prefers-reduced-motion: reduce`
stops the drift and keeps the cloud — a static cloud, never "no fog" — and
the animation touches background-position only, so it can never fight the
selection ring or the drag lift. Third, **"When clicking on a fog, the
delete action is labeled delete veil, please correct"** — the rail resolved
the selection by id alone (the record type is one kind-discriminated shape),
so its destructive label was kind-blind; it now resolves the selected RECORD
and both the delete action and the four edge-handle aria-labels take their
noun from `veil.kind` ("Delete fog" / "Resize fog n" for a fog, veil for a
veil). Test ids stay the FAMILY ids (`battle-veil`, `delete-veil`,
`veil-handle-*`) exactly as the `BattleVeil` type is the family type: they
address the shared record type, while the user-visible and accessible names
are the ones that must be kind-true. The user-facing guide text ("fog covers
each room's monsters") was corrected in the same arc. All three are pinned:
layered-cloud + no-flat-slab, kind-named controls, and the seeded cover's
tap-through to its room's key. **NO MIGRATION, and this is the one visible
consequence: `kind` is persisted board data, so a battle seeded BEFORE this
amendment keeps its `kind: 'fog'` covers — they still render (as the new
cloud) and still BLOCK, and only a fresh seed emits veils. A running battle
therefore gets the new cover kind by re-seeding the board from its encounter
(the surface's destructive re-seed, `confirm-reseed`) or by lifting/deleting
the old covers; nothing re-reads the kind at read time, and no schema field,
Dexie version or setting changed.***

Amended 2026-09-07 by 01a0b5e (room-keys/treasure arc, owner-ratified; D9 in
11-ENCOUNTER-GENERATOR): *GM view additionally renders room-key markers — one
tappable badge per keyed layout room at its staging point, derived from the
provenance encounter's current layout and rendered under the veils — a key
card in the right rail (room key + room-treasure checklist) when a marker is
tapped, and a treasure block on the selection card for tokens whose seeded
mob treasure is non-empty. All three are GM-only content: they never mount in
the player-safe DOM, and the contract test pins the key/treasure strings as
absent from `document.body`. Background taps and the player-safe toggle clear
the marker selection.*

Amended 2026-09-07 by cc2ad02 (dungeon preset arc, D10 in
11-ENCOUNTER-GENERATOR): *token rendering honors `board.tokenSize` —
`TokenView` renders `board.tokenSize * token.scale` instead of a hardcoded
64px, so the rendered size always equals the coverage/snapping size. On
mapless boards (64px default) nothing changes; on layout boards the setting
finally re-captures as designed, and the dungeon preset's finer grid
(half-size cells) renders tokens at their layout-cell coverage — the fix
also gates the auto-fit effect on `battle.board.live` so it can no longer
overwrite the first-entry reveal write and permanently hide seeded PC
tokens.*

Amended 2026-09-06 (encounter-resume arc, `everLive`): *entering the table
reveals every token exactly ONCE per seed — the board carries an additive
`everLive` flag (default false; legacy rows read `undefined`, which counts as
unspent) and the surface stamps it `true` on the first entry. A Lift →
re-enter cycle resumes the board verbatim: `live` returns, the reveal does
not re-run, and tokens the GM deliberately hid stay hidden. Before this, the
`liveBoard` rule re-fired on every entry after a Lift and wiped the GM's
per-token visibility — reopening a battle silently changed what the players
could see.*

**Interaction:**

- Drag (≥8px threshold): live local position with grid snapping, single repo
  commit on release; tap = select; scenery lock rejects stamp/veil moves.
  Amended 2026-09-08 (one-gesture-machine rebuild): *ONE gesture state
  machine owns every board stream (`domain/battle/gestureMachine`:
  idle|armed|active × token|veil|effect|effectResize|pan|pinch|tap, a single
  ref) with ONE set of board-level pointer handlers as the sole capture
  owner — pieces render hit areas, never streams. A release the machine
  does not own is ignored (one release commits exactly once);
  cancel/capture-loss/blur/unmount always abandon with zero commits (cancel
  never commits — the old veil/effect cancel-committed); second-pointerdown
  never overwrites (background second finger promotes to pinch with
  abandon-no-commit, piece second grab ignored); moves are pointerId-checked;
  scenery/player-safe gates run before arming (a forbidden grab no-ops,
  never a silent pan). Native dragstart is suppressed on the board and an
  active grab carries cursor-grabbing.*
  Amended 2026-09-06 by 0275d27: *the live-local-position contract covers
  veils exactly like tokens — a dragged veil follows the pointer in local
  state (zero Dexie writes mid-drag) and persists exactly once on release —
  and veil drops snap like token drops: the center quantizes to the veil's
  own widthCells×heightCells span, landing the veil's edges on cell
  boundaries (matching the cell-quantized resize math).* Amended 2026-09-06
  by d0c7fc8: *the threshold is SCREEN-space (client px from the
  pointer-down origin) so the tap window is zoom-invariant, and every
  pointer conversion runs against the transformed content frame — the
  pan/zoom transform and the aspect-fit letterbox live between the outer
  container and the %-positioned pieces, so container-frame math drifted by
  (s−c)(1−1/zoom) + pan/zoom plus the letterbox offset; snapping, thresholds
  and fog coverage all use the content div's frame.*
- Pan/zoom (0.35–4, pinch + wheel + buttons), DOM-transform based. Amended
  2026-09-06 by d0c7fc8: *the range is the code truth — `ZOOM_MIN = 0.35`,
  `ZOOM_MAX = 4` (BattleSurface.tsx); the former "0.35–80" was a spec
  typo.* Amended 2026-09-06 by cbe8218: *the pan gesture starts from any
  non-piece surface — the letterbox background, the map image itself
  (`data-board-background` on the `<img>`), or the content frame (e.g.
  while the map image loads); before this, a drag on the map was a dead
  zone. The same pan gesture semantics hold: a ≥8px screen-space drag pans
  and keeps the selection, a sub-threshold tap deselects; token/veil
  pointerdowns mark their targets via data attributes and own no stream
  (the board owns every stream — the old piece-level stopPropagation and
  the piece-level move/up handlers are gone), the
  resize handles are board-owned hit areas, and a background second finger
  promotes to pinch with abandon-no-commit while a piece second grab is
  ignored.* Amended 2026-09-06 (parking lot,
  not scheduled): *the coarse-pointer screen-space art overlay — "portrait
  tokens render in a screen-space overlay so art stays crisp" — is DROPPED
  from the spec; the shipped surface renders tokens in the transformed
  frame with no overlay layer. See the parking lot below.*
- Veils: add veil/fog, resize from n/e/s/w handles (hidden while scenery is
  locked). Amended 2026-09-08 (one-gesture-machine rebuild): *the
  CLICK-to-resize path (fba12b7) is DELETED — veil handles are drag-resize
  now, sharing the ONE resize gesture with effect handles: the handle drag
  previews the cell-quantized geometry live (`resizeVeilFromEdge`, opposite
  edge pinned) with zero writes mid-gesture and exactly one commit on
  release; a tap commits nothing.*
- Effect markers (D8, added 2026-09-06 by the encounter-resume arc):
  **Disc**/**Square** toolbar stamps — a geometric form spawns at the board
  center one cell across in the first stamp color, then drags with the veil
  contract (live local position, zero writes mid-drag, one snap-quantized
  commit on release). Selected markers grow/shrink (cell-quantized, min one
  cell) and delete from the rail; scenery lock gates their moves like veils;
  the fill renders at ~70% transparency and the marker is board material in
  BOTH views (D8); the stage snapshot captures and restores them. Amended
  2026-09-08 (veil-parity arc): *markers gain the veil's four n/e/s/w edge
  handles (12px dot in a 44px transparent pad, hidden while scenery is
  locked or in player view) — but DRAG, not click: the
  handle drag previews the symmetric cell-quantized size live
  (`resizeEffectFromEdge`, center fixed) with zero writes mid-gesture and
  exactly one commit on release; a tap or a return-to-start-size drag
  commits nothing, cancel commits nothing. The rail Grow/Shrink buttons stay
  as the discrete-step (accessibility) path, Shrink disabled at one cell.
  Amended 2026-09-08 (one-gesture-machine rebuild): *veil and effect
  handles share the ONE `effectResize` machine kind (the payload
  discriminates) with one board-owned start/preview/finish path.*
- Stage: **⚑ Set stage** (confirm) captures the snapshot; **↻ Reset**
  restores geometry, clears initiative, resets NPC instance HP to artifact
  max, re-spawns missing PCs at the staging ground, stays live.
  Amended 2026-09-06 (encounter-resume arc): *the toolbar gains a destructive
  two-step **Re-seed** (GM mode, provenance-bearing battles only) that
  replaces the running board from the row's own provenance encounter —
  `seedBattleFromEncounter` semantics verbatim: fresh board, discarded stage,
  `reseed` stamped. After a re-seed the surface re-arms the first-entry
  reveal, so the fresh board goes live immediately with the seeded layout,
  and stale piece selections are dropped. The right rail carries a GM-view
  provenance line ("Seeded from …", plus "Re-seeded …" when a replace
  happened; a deleted seeding encounter reads loud, never blank).*
- Initiative: enable → every visible fighter rolls (d20 + frozen bonus; PCs
  and NPCs alike); reconcile-on-change (reveal → auto-roll, cover/hide →
  prune) suppressed while a board gesture is in flight via the gesture gate
  — a boolean the machine drives (no depth counters, no throwing ends:
  imbalance resolves to a recoverable reset, never a crash);
  drag-to-reorder; **>>>** next turn with the floating turn marker.
- Damage/heal: token float controls with quick ± steppers (Damage −10/−5/−1,
  Heal +1/+5/+10, every control ≥44px) that apply the delta directly (clamped
  `0..maxHp`), writing to the token (NPC) or the pc artifact (PC). Amended
  2026-09-06 by 4e3de75: *the typed ±HP input is gone — even flat-value
  adjustments are button-driven, and arbitrary amounts go through the dice
  roller's ± modifier steppers. The former "plain random roller (d20/d6
  totals) is built in; no 3D dice dependency" clause is superseded: Roll
  damage / Roll heal open the reusable dice roller (`src/features/dice/`,
  `@3d-dice/dice-box` under the hood) with a captured intent; a settled
  total is applied signed by the intent (damage ⇒ −|total|, heal ⇒ +|total|)
  through the unchanged applyHp path and confirmed with a formula toast.
  The 3D engine is dynamic-imported on first dialog open — the battle
  surface's main bundle pays nothing — and every engine failure is loud
  (inline status + toast + Retry; dice rolls blocked, flat steppers and
  modifier-only rolls unaffected; never a silent 2D degradation). The last
  rolled tray persists as a user preference (`dice.lastTray`); player view
  renders neither the roll controls nor the roller. Amended 2026-09-09:
  *percentile dice roll engine-side as numeric `Nd100` (never `Nd%`, which
  upstream parses to a lone tens die) so the engine throws the tens+ones
  pair and settles one combined 1–100 result per die with 00+0 counting as
  100 — `1d%` stays the chip/summary/log name only.*

**Parking lot (not scheduled):**

- Coarse-pointer screen-space art overlay (former spec line, dropped
  2026-09-06): portrait tokens would render in a screen-space overlay so
  art stays crisp at high zoom. Nothing implements it — the shipped surface
  renders tokens in the transformed frame; revisit only with a concrete
  on-device crispness complaint, together with the tablet-hardening backlog
  in 05-UI §Tablet.

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
- 3D dice (`@3d-dice/dice-box`) — SUPERSEDED 2026-09-06 by the M5-D
  dice-roller amendment (4e3de75, Damage/heal above): the reusable DiceRoller
  ships it. AI battlemap sketching (the existing image pipeline covers map
  creation), cross-module battle persistence beyond the session row.
- Importing GM Cockpit archives.

## Onboarding addendum — setup wizard + first-module guide (post-M5)

Owner-ratified onboarding arc (discovery + design banked before
implementation), spec'd in 05-UI.md §Onboarding. It closes the gap between
install and first use: until now a fresh browser landed on the picker's
empty state with no path to the key → rulebook → first module loop, and all
teaching lived in contextual help tips.

### Scope

- **Settings row** gains `onboarding: { status: fresh|active|dismissed|complete,
  stepState: [{id,state}] }` (missing entries read as pending; `.default()` so
  old rows and backups parse — the post-M3 convention). One-time-flag precedent:
  `retiredSessionNotesRemoved`.
- **Setup wizard** (`features/onboarding/`): checklist dialog mounted in the
  AppShell, six steps linking out to Settings / Rules / the picker, detection
  auto-ticks (key, language, rulebook, campaign+module), skip/resume, Finish +
  Don't-show-again persistence, one-time auto-open guarded on fresh status AND
  zero campaigns with a liveness check against unmounted shells. Re-open
  affordances: picker header, picker empty card, welcome panel, help `setup`
  topic.
- **First-module guide** (`features/guide/`, routes `/guide`,
  `/guide/:chapterId`): nine structured chapters (`guideContent.ts`,
  helpContent pattern) rendered through the WikiMarkdown pipeline, opened in
  another tab from the wizard's last step / help / the modules empty state;
  chapter CTAs deep-link into the app (static routes; campaign-scoped ones
  resolve against the most recently updated campaign, disabled hint when none).

### Decisions

- **Checklist, not stepper**: steps are skipped and resumed independently, so a
  linear stepper misrepresents the flow; the list states progress honestly.
- **Link out, never re-implement**: the wizard teaches by pointing at the
  existing ingest surfaces (Settings, Rules) and tracks completion — no second
  ingest UI to maintain or drift.
- **Step state as a list, not a record**: zod v4's record-with-enum-keys is
  exhaustive (an empty default would fail parse); a `{id,state}` list keeps the
  missing-means-pending semantics type-clean for future steps.
- **Auto-open upgrades safely**: an existing install (campaigns > 0) never sees
  the wizard pop; the entry points stay available instead.
- **Guide as an in-app route, not a static file**: same origin keeps IndexedDB
  (deep links resolve the real campaign), it themes with the app, ships in the
  bundle for offline/PWA use, and stays test-enforced.

### Acceptance criteria

- A fresh browser (no settings row, no campaigns) auto-opens the wizard exactly
  once per launch-until-changed; the status row reads `active` immediately
  after; a second mount does not auto-open.
- An install with ≥1 campaign never auto-opens, whatever the onboarding status.
- Saving an OpenRouter key, importing a book, or creating campaign + module
  ticks the matching pending step automatically (persisted in the settings row).
- Begin/Mark done/Skip persist; closing and reopening the wizard focuses the
  first unresolved step; Finish is disabled until all six resolve and then
  persists `complete`; "Don't show again" persists `dismissed`.
- The guide renders all nine chapters with working prev/next and chapter nav;
  an unknown chapter id renders the not-found page; a campaign-scoped CTA
  carries the real path when a campaign exists and the disabled hint when not;
  the wizard's author step and the modules empty state open `/guide` with
  `target="_blank"`.
- `pnpm lint && pnpm typecheck && pnpm test` passes with the wizard and guide
  registries completeness-covered (30 new tests across
  `tests/domain/settings-onboarding.test.ts`,
  `tests/features/onboarding-wizard.test.tsx`, `tests/features/guide.test.tsx`).

### Non-goals

- Interactive tours / spotlight overlays anchored to live surfaces; a checklist
  with deep links covers v1.
- Per-chapter "mark complete" sync between guide checkpoints and wizard steps
  (the wizard's detection signals already cover the real completion state).
- Bundled sample rulebooks (the repo's `Sample rules/` are unlicensed fixtures,
  not shippable content).
- Localizing the wizard and guide copy (generation content localizes; UI chrome
  stays English).
