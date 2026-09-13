# 11 — Encounter generator: generated battlemaps, room layouts and veils

Adds a **fully generated encounter** to Campaigner: an LLM drafts the design
(rooms, roster, tactics), deterministic code turns it into a **grid layout**
(rooms as rectangle unions, corridors, doors), a canvas renderer draws a
**schematic map**, an OpenRouter image model **stylizes** it under a
structure-preserving contract, and **the human picks the candidate** — the
regenerate affordance is the correction path (D14). Complex dungeons can
alternatively map through the **vision-located path** (D19): one painted
labeled map whose room plaques are sight-located — no pick pause,
locate+verify is the gate. The result is an
`encounter` artifact whose battles seed with **mobs placed in their rooms and
one VEIL per monster spawn group** (a veil, never a fog — D4's fog-cloud
amendment) — the party reveals the fight group by
group, exactly the GM-Cockpit veil mechanic M5 already runs.

Binding conventions from `00-OVERVIEW.md §Global conventions` and `AGENTS.md`
apply throughout (no silent fallbacks; zod at every boundary; failures loud;
progress via the shared dock; one logical task per commit).

## Position in the roadmap

- Builds on **M5**: `encounter` artifacts, battle veils and the table surface.
- Builds on completed **M6**: derived Global/Campaign/Module ownership,
  module-anchored battles, `seedBattleFromEncounter(campaignId, moduleId,
  encounterId)`, and the module reader as the only play view.
- All new designed content stays on the `encounter` artifact (which may be
  global); the battle-row addition is additive. The next schema version is
  **Dexie v12**, after M6's v10 ownership and v11 play-retirement migrations.

## Naming (binding)

The **encounter generator** authors designed content (artifact). The live run
stays **battle**. The new persona is the **Encounter Cartographer** (`slug:
'encounter-cartographer'`); its run mode is `'encounter'` (extends
`personaSchema.mode`). The map+layout data on the artifact is the
**layout**; the spawn-group cover veils on the board are **group veils**.

## Decisions (binding, settled with the user)

| # | Decision |
|---|---|
| D1 | **Standalone generator**: a run creates a complete `encounter` artifact from a brief — roster included — plus layout, map and room veils. It also runs in a **regenerate** mode against an existing encounter (same or edited roster): name, links and body survive; layout + map are replaced. |
| D2 | **Two autonomies**: interactive runs use the run-engine autonomy (manual/review pause at the checkpoints below; map pick always pauses, M3-A rule). **Unattended auto runs** (module generation) never pause: one stylize candidate, no pick gate — the `entity-image-queue` precedent (08 §M4-C). Any failure fails that encounter loudly; the batch continues. |
| D3 | Rooms are **unions of rectangles** (1 rect = plain, 2–3 rects = L/T shapes). Every room carries a **mob sub-rectangle** (`mobsRect`) inscribed in the union — it is both the mob placement area and the source the per-group veil footprints are cut from (D4). |
| D4 | **One veil per monster spawn group** (owner-ratified group veils — supersedes the old one-veil-per-room rule): each room's `mobsRect` is split per `monsterIndexes` entry, in the owner's group order, into the minimal cell bounding box of that group's `placeMonsters` cells (`veilsFromSpawnClusters`, beside the legacy `veilsFromRooms`) — kind `veil`, int cells ≥ `VEIL_MIN_CELLS`. Rooms with no monster groups seed no veil. The room's FIRST group keeps `id = room.id` so the Path rail's "Reveal next room" still resolves per room; later groups mint fresh ids and every group veil carries `roomId = room.id` (additive on `battleVeilSchema`). Corridors stay open (GM can add fog manually). Amended (veil-reachability arc): **cover convention** — each seeded group veil covers its spawn area PLUS a one-cell margin on every side, clamped to the board bounds (a 1x1 group seeds at most 3x3), so the GM can grab the veil body and reach the edge handles around the tokens, which stay directly clickable above. Amended (veil-overlap merge): same-room group covers that OVERLAP (share ground) merge at seed into one veil — the bounding-box union re-clamped to the board, keeping the room id + `roomId` — so single-room adjacent spawns seed exactly one veil; disjoint same-room covers stay separate and cross-room covers never merge. GM-created veils are untouched. Amended (ledger 65, owner-ratified): **fog RENDERS as its name — an opaque, blocking cover** (`bg-zinc-300` then, no alpha, same in GM and player view; the earlier "~10% in both views" fill was what made fog indistinguishable from a GM-drawn transparent veil — the owner's "there are no fogged rooms right now" report, when every seeded row was already `kind: 'fog'`). Seeding geometry, `kind`, `roomId`, the merge, and coverage/pruning/initiative are all byte-unchanged; only the fill and the tap behavior are keyed off `kind` (docs/18 seam row; ledger 65). Amended (fog-cloud arc, 2026-09-10, owner-directed — supersedes the ledger-65 `bg-zinc-300` fill AND the seeded kind): **the seeded group covers are kind `'veil'`** — owner, verbatim: "The mobs should be covered by a veil, not fog." The seeder emitted the opaque BLOCKING kind over mob clusters; a veil is the kind the job needs, because hiding is done by COVERAGE (kind-agnostic: `portraitCoveredByVeils`, player-view DOM removal, initiative pruning, auto-roll on reveal), while a plain cover also keeps the map readable, passes a sub-threshold tap through to the room-key marker beneath it — repairing a real access bug, since a keyed room's marker sits at its `mobsRect` centre, inside the seeded cover by construction, and markers stay BELOW veils, so an opaque fog over it was untappable — and stays draggable/resizable/deletable exactly as before. Fog remains the GM-drawn opaque blocking kind and now renders as an animated grey cloud (`battle-fog-cloud`, pure CSS, `prefers-reduced-motion` aware — 09-MILESTONE-5 M5-D fog-cloud amendment). Seeding geometry, `roomId`, the merge, coverage/pruning/initiative and the rail's per-room resolution via `veil.id`/`veil.roomId` are byte-unchanged: the rail never resolves by kind. No migration either: `kind` is persisted board data, so a battle seeded before the amendment keeps its opaque fog covers (rendered as the new cloud, still blocking) until the board is re-seeded from its encounter — every NEW seed emits veils. |
| D5 | **Token art is not generated**: npc-backed tokens use the artifact's cover/portrait, seedFighter tokens use the deterministic initials fallback (M5-D behavior). No image calls for tokens. Amended 2026-09-05 by afa23f4/070d4ba/64b30f9 (mob-artifact arc): *rulebook-cited creatures become real mob artifacts — ONE `npc` artifact per campaign per cited chunk — and gain a one-click owner-ratified portrait batch ("Generate mob portraits"); every other seedFighter token keeps the initials fallback. See "D5 amendment — mob portraits" below. Amended 2026-09-08: uncited entries (`inline` / `none`) gain on-demand creature artifacts + local portraits ("Create creature + portrait", per entry and batch-all); invented covers stay local-only, never the global cache. Amended 2026-09-09: all-imaged batches offer portrait regeneration (canonical slots republished with fresh bytes — future clones everywhere get the new art, other campaigns' existing covers unchanged; flavored/invented regenerate locally). Amended 2026-09-10 (docs/17 row 90): the batch covers EVERY roster participant that can own a portrait — `npc-ref` rows route by whether their artifact is chunk-backed (shared bestiary portrait, deduped) or not (its own local portrait) — and the inline stat block's `level` is validated at the encounter boundary against the app's one level parser. See "The portrait batch covers EVERY roster participant" and "The inline stat block's `level`" below.* |
| D6 | **Geometry is layout-anchored, never screen-anchored.** When a battle carries the map layout, every cell metric — veil spans, veil resize quantization, token snapping, the visible grid overlay, token size — derives from `boardWidth / cols` (normalized), never from a fixed CSS-px grid. Without a layout the current behavior is unchanged. |
| D7 | **Structure-first**: geometry exists as data *before* any pixels; the image stylizes a rendered schematic; geometry is **never read back from pixels**. Amended 2026-09-08 (D14): the vision check that "only flagged drift for human review" is GONE entirely — no pixel is read back anywhere, and the human is the judge at pick. Amended 2026-09-09 (D19): the vision-located path carves out ONE exception — room LABEL positions (plaques the pipeline itself painted, not geometry) are read back through the structured vision locate; packed geometry is still never read back, and vision rooms carry none. |
| D8 | **Effect markers are geometric showpieces** (encounter-resume arc, owner-ratified): the battle surface stamps disc/square zones as an additive `board.effects` array — normalized center, `sizeCells` in grid cells (the D6/D7 rules apply verbatim: layout-anchored, never screen pixels), `TOKEN_STAMP_COLORS` fill at ~70% transparency (fill alpha 0x4d, border 0xcc — static, never opacity swings), optional non-stat label. Board material: rendered in BOTH GM and player views; never initiative members, never coverage-hidden (they are not tokens); carried by the stage snapshot; scenery lock gates their moves like veils. |
| D9 | **Room keys & mob treasure are GM-only text that travels with its structure** (owner-ratified, 2026-09-07): every layout room carries additive `key`/`keyTreasure` (persisted ON the room — `packRooms` rotates brief rooms, so a parallel roomId-keyed array would orphan), every roster entry carries additive `treasure` (persisted ON the entry — the editor removes roster rows, so an index-keyed array would orphan). The encounter editor edits them; battle seed freezes roster `treasure` onto each token (frozen-copy precedent, initiativeBonus); the battle surface renders GM-only key markers at room staging points + a rail key card + a GM-only token-treasure block — none of which mounts in player view (M5-D contract, 09 amendment). Map regeneration replaces room keys with the fresh brief's (accepted, stated in UI copy and the prompt clause). |
| D11 | **Encounters have a SHAPE — `siteShape: 'single' \| 'complex'` on the encounter data, additive default `'single'`** (owner-ratified, 2026-09-08): editor labels **"Encounter" (single)** and **"Dungeon" (complex)**. A single site is one arena — `rooms.length === 1`, `corridors: []`, veils for its spawn groups at seed (group-veil policy: the spawn-room exemption is gone), start position = the entrance cell when present else the room's mobsRect center, no room discovery beyond the spawn groups. A complex is a dungeon — multi-room, one board, sequential play along the path, GM-only Path rail + "Reveal next room" as an ADVISORY aid (no locks, no initiative resets; the latecomer auto-roll stays an editable aid; reveal-all — one press lifts EVERY group veil of the next veiled room, resolving per room via `veil.id` AND `veil.roomId`, so no room reads revealed while its mobs stay covered). The derived default: `locationKind === 'dungeon'` ⇒ complex, else single — materialized for legacy rows by `normalizeEncounterShapeData` (parse-on-read) AND the v17 backfill. Hard invariants refine on the ARTIFACT data (single ⇒ 1 room & no corridors; complex ⇒ >1 room); the stricter generation dichotomy — a brief commits to 1 room or 4–10, never 2–3 — is a repairable brief-boundary issue. See "Site shape, per-room challenge and the path" below. |
| D12 | **Asymmetric per-room budget loop (owner-specified)**: each complex room carries `targetLevel` (additive, optional; defaults to the encounter's parsed levelHint) and the assigned creatures' levels are summed against a documented band — **too easy ⇒ ship silently (owner: fine)**; **too hard ⇒ lower that room's targetLevel a step (floor 1) and retry through the encounter brief's EXISTING single repair turn** (budget issues join the issue list like coverage/source issues); **after the bounded retry still over ⇒ LOUD advisory** persisted on the step output AND `data.budgetAdvisory` on the artifact — never silent, never a failed run. The final (possibly lowered) targetLevel persists on the room, visible and owner-editable. dnd5e band = our own documented approximation (verbatim rationale below, mirroring the treasure-ladder licensing stance, docs/12 §13.2/§14); pf2e ships NO numbers — GM Core verbatim from retrieved excerpts when present, else the always-on loud advisory. The in-place Smith content fill runs the same loop over a RECONCILED partition (see below). **Amended (fill-grade arc, owner-ratified): a COMPLEX inverts the asymmetry — every room stocks a real fight against a drawn `fillGrade` expectation ('empty' repairable, 'under' loud); the "no lower bound" call now holds for SINGLE arenas only, the roster is sized at the real seam (prompt + bounded map-queue expansion — SHAPE-gated, see the amendment), and the in-place fill packs by nearest-band fit. See "D12 amendment — fillGrade stocking" below.** |
| D13 | **The play path is stored on the layout** — `encounterLayoutSchema.path: z.array(z.uuid()).optional()`, a permutation of the room ids refined by the shared layout schema. The Cartographer brief's room order IS the path (stored explicitly — `packAttempt` ROTATES `brief.rooms`, so the array order cannot be trusted), rotated so the entry room is first: **first path room = spawn room**. Legacy complexes get `path` backfilled as their room-array order (spawn first if derivable) by the v17 migration; the surface falls back to array order when absent. The rail's veiled-room set resolves per ROOM (`veil.id` for the primary group, `veil.roomId` for every group veil), so a room reads veiled until its last group veil lifts and "Reveal next room" reveal-alls the room. |
| D15 | **Auto-promote on second-module use** (owner-ratified, 10 D12): an encounter roster or battle token that cites another module's npc/mob artifact promotes it to campaign level with a loud toast — at run-engine finalize (both remap sites), the editor encounter save, the top of `seedBattleFromEncounter` / `spawnRosterInstance` (before identity freezes), and bestiary `spawnMobArtifactIntoModule` (second-module spawn promotes/shared instead of moving). No separate core state — every path funnels through `adoptIntoCampaign`. |
| D17 | **The encounter map has a STYLE MODE — architectural vs. natural site — and OUTDOORS the encounter's own prose is the truth** (owner-ratified): WHO HOLDS GROUND TRUTH. Dungeons: the layout IS the truth — the schematic-faithful contract (walls/corridors/keys/veils; keep-structure prompt + the stone/wood/dirt materials line) stays byte-identical. Outdoors: our geometry encodes ONLY spawn positions — the schematic renders a placement-only overlay (soft organic spawn patches over the mob-cluster cells + the entrance marker; NO region boundary stroke, NO wall geometry) and the stylize prompt is rebuilt from the brief's own prose (theme + terrain + summary), with NO materials line, NO keep-walls clause, and NO terrain bans (an island in a lava lake or a murder-clown tent stays paintable). The usability hard-bans (no title/legend/grid/text/characters; no white/pale boxes) and the entrance marker stay verbatim; the entrance clause softens to "a visible approach path at the marked spot" (marker mechanics unchanged). Mode derivation: the brief's `environment: 'outdoor'` OR the persisted `locationKind: 'wilderness'` ⇒ natural, else architectural — and the owner's editor override (`mapMode` on the encounter data, additive optional, 'auto' stores nothing) beats both. See "Natural-site mode" below. |
| D14 | **The user is the judge; regenerate is the correction; NO VLM verification** (owner-directed removal, 2026-09-08): "Nope. Stop the verification altogether. Let the user be the judge with a regenerate option. No need to waste model calls here. Things do not need to be verified in a brittle way. Just have a way to easily regenerate." The verify step (the 5a8f8f2/42db-era machinery: the coarse-grid cell contract, the `arena-verdict` structural check, thresholds, drift overlays, the dedicated verify model) is DELETED — model calls are not spent on brittle self-grading. The manual run pauses at pick; **"Regenerate candidates"** re-runs the stylize step only (same brief, same layout — room keys and geometry untouched) and pauses at pick again. Regenerating the LAYOUT (fresh keys/geometry) stays the separate existing affordance. Old run rows carrying verify steps heal at the run-row parse boundary. Amended 2026-09-09 (D19): the vision path reintroduces a VLM call as LOCATION, not verification — reading back plaque positions the pipeline itself painted, gated by the count check + focused re-ask, still-missing failing loud. No grading, no verdict, no thresholds; Regenerate everything stays the human's correction. |
| D10 | **The Dungeon preset is a generation-time grid tier + brief bias, not a board feature** (owner-ratified, 2026-09-07): choosing Dungeon makes the layout engine pack on a FIXED ×2 tier per aspect (4:3 48×36, 16:9 56×32, 1:1 40×40 — "same cells per room, more cells per map"; room size classes unchanged), biases the brief toward a connected 4–8 room complex, and persists the choice as `preset` on the encounter artifact, the run row and in Settings so regenerations and resumes reproduce the tier. No `battle.gridScale` field ever: cells keep their in-world meaning and every D6 layout-anchored metric derives from `cols/rows`, so half-size cells render everywhere automatically. Exit marker out of v1 (the name stays reserved). **D10 amendment (locationKind, owner-ratified)**: encounters classify themselves — the encounter persona's EXISTING draft call gains a bounded `locationKind` (`'dungeon' | 'building' | 'wilderness' | 'other'`, persisted additively on the encounter artifact, owner-correctable in the editor, no extra LLM call), and the preset resolves per encounter: **explicit per-run choice > the encounter's own `locationKind` (`'dungeon'` → Dungeon tier, `'building'`/`'wilderness'` → Standard) > the Settings fallback** for unclassified (`'other'`) rows. The Settings page's Encounter-maps Preset select carries **Auto** as its default (self-classification is the norm; Standard/Dungeon remain explicit overrides). See "D10 amendment — per-encounter locationKind" below. |
| D18 | **Two-button regeneration (owner-directed, 2026-09-09)**: the encounter editor offers EXACTLY two automatic actions for BOTH shapes, plus the prose checkbox — the old one-fight content "Regenerate with AI" and the standalone battlemap "Generate layout & map / Regenerate" are DELETED (subsumed, never renamed). **Regenerate everything** = a new dungeon top to bottom (complex: a fresh full Cartographer run — new roster + new layout + new map, same as if module-generated fresh; a roomless complex resets the row first so the fill-grade machinery runs against the row's own preset; single: a fresh Smith one-fight draft + a fresh map, one action). **Repopulate** = the map looks fine, the spawn looks wrong — a NEW roster for ALL rooms (complex: ROSTER-ONLY Cartographer pass — brief with the 'empty'/'over' repair loop + room-mirror + fresh cap, finalize persisting ONLY `monsters` (+ lowered `targetLevel`s) onto the PRESERVED rooms/map; single: today's Smith one-fight fill). A dungeon's repopulation is NOT a Smith extension — its clauses key on the target's actual shape. The **prose checkbox** ("Also redesign name and prose", default OFF) chains AFTER the automatic pass: a Smith PROSE-ONLY run (persists name/prose/body; any roster drift fails the run loud with nothing persisted). Unticked, a dungeon's name and prose stay byte-identical (singles always get fresh Smith prose; the box additionally replaces the name there). Both buttons honor the draw-once fill grade, the row preset, the remembered-preset trap fix, the cap math and the repair-turn semantics; manual Clear (map deletion) and the invisible unattended map queue stay as-is. Amended 2026-09-09 (D19): the D18 section gains a complex-only per-run **Map path** control (Use default / Classic / Vision) for Regenerate everything — the choice rides `EncounterRegenOptions.dungeonMapPath` through the run row (explicit-only, never persisted as the Settings default); singles ignore it, repopulation takes none. See "D18 — two-button regeneration" below. |
| D19 | **A second, vision-located dungeon path for complex maps (owner-directed, 2026-09-09; the lab's labeled-map recipe production-hardened — "31 of 32 letters found, success for this config")**: the Settings `dungeonMapPath: 'classic' \| 'vision'` (DEFAULT `'classic'` — vision is opt-in; select beside the encounter preset, labels "Classic (vector rooms)" / "Vision-located labels") governs complex/multi-room production (initial runs + the unattended queue + Regenerate everything); the D18 per-run choice beats it both ways for ONE run. SINGLES always map classic (one arena needs no registration — the override is ignored, never an error); REPOPULATION is path-independent (roster-only, never touches the map); the unattended queue passes no override (the setting governs). The vision pipeline is `brief → vision-map → finalize`: (a) SIDECAR FIRST — rooms (letter A..N in room order for 4–10 rooms, name, description, encounter assignment, declared graph edges) + the brief's `entryRoomIndex` room flagged as the entrance (entry keeps its letter; the prompt draws it AS the visual ingress — stairs/cave mouth/gate/portal per concept, plaque included — and its observed point doubles as party ingress) authored from the brief BEFORE any image exists; (b) ONE labeled map through the existing image pipeline + storage (same `mapImageId` home; no aspect normalization — the image IS the map); (c) ONE structured vision pass with the configured chat model (0–1000 grid, zod boundary — a vision-incapable model fails the map step loud); (d) VERIFY by count check + a focused re-ask per miss ("only label D", found points as context) — still missing ⇒ the MAP STEP FAILS LOUD (candidate pruned, nothing persisted) naming the letters, NEVER an invented coordinate. Geometry posture: vision rooms carry NO `rects`/`mobsRect`/`entrance`/corridor-`rects` (schema-enforced); corridors carry declared `a`/`b` edges; spawns, group veils and key markers resolve to the observed point (+ deterministic scatter/placement around a point); anything needing polygons fails loud, never silently centers; connectivity IS the sidecar's declared room graph. Shape follows each room's description + the dungeon concept — NO regular/irregular distinction or toggle anywhere in the vision path. KNOWN DEBT (accepted): layout drift (the painted map drifting from the declared graph) has no verifier this arc — Regenerate everything is the correction. See "Vision-located dungeon path" below. |

### D5 amendment, SECOND revision — the creature tier supersedes the mob artifact (docs/17 row 106)

**READ THIS BEFORE THE BLOCK BELOW.** The first revision of this amendment
(kept verbatim underneath, as the record of what was decided then) is
**superseded in its mechanism** by the creature tier. Everything in it that
describes a *hidden `npc` artifact per cited chunk* — `data.monsterChunkId`,
`db/mobArtifacts.ts` (`getOrCreateMobArtifact`, `spawnMobArtifactIntoModule`,
`materializeInventedCreatureArtifact`, `carryMobCoversForward`,
`countMobArtifactsCitedByModule`, `isMobArtifact`),
`features/campaign/creature-row-guard.ts`, and the "a creature row is not an
authored NPC, so refuse the AI/refill/editor writes on it" family — describes a
model that NO LONGER EXISTS. Do not implement from it.

What replaced it, in one paragraph: a creature is a **library** row (a statblock
chunk, read-only, addressed by identity); an encounter roster **cites** it and
materializes **nothing** (`db/creatureRepo.resolveCreatureCitation`, resolved by
chunk id with a content-hash fallback, throwing on an empty ref); an `npc` that
**carries** `data.creatureRef` is a **CAST CREATURE** — an authored row with
derived stats (the numbers are NEVER authored: they are read off the library
citation; only the PROSE may be written by a run — her own persona targeting the
row, docs/17 row 133), created only by `db/creatureRepo.castCreatureAsNpc` (idempotent
per campaign/module/name/identity, never overwriting, refusing a rival or an
authored npc of that name, stamping the module tag), held by the **module
generator** and the bestiary spawn dialog and by **no encounter path at all**
(the roster schema cannot express a cast — pinned in
`tests/db/creatureRepo.test.ts`); portraits are **presentation**, keyed by
creature identity in the global `mobPortraits` table plus the per-campaign
`creatureImages` rows, read through the ONE seam `creatureCoverImageId`. The
three roster `source` variants on disk are UNCHANGED (`rulebook` / `npc-ref` /
`inline` / `none`, D2 stands), and the `missing ref` reason is ONE shape with an
optional name (`missing ref (Ghost Lumberjack)`, read through
`isMissingRefOrigin`).

The owner's intent for this area is unchanged and is the reason the tier exists:
*"Often modules want lets say a zombie, but its old aunt agatha. So, she will
have zombie stats but with prose. ... the encounter generated mobs wont need it,
they should not introduce important NPCs on their own."*

---

### The module-side cast — how the generator ASKS for the Aunt Agatha path (owner intent, docs/17 row 107)

The creature tier gave casting ONE implementation and two possible holders. This
section is the half that makes it reachable **from the module generator itself**
— the owner's own emphasis, verbatim:

> *"Thats actually an important path. Often modules want lets say a zombie, but
> its old aunt agatha. So, she will have zombie stats but with prose. This path
> should be easily available for mob generation (inside the module generator
> mainly, i think the encounter generated mobs wont need it, they should not
> introduce important NPCs on their own)."*

The request travels in three hops, and each hop has exactly one owner.

1. **The contract** (`domain/module.ts`). An entity record — the
   `{ name, kind }` entries the pass-0 spine declares and every later entity
   pass reads — gains ONE optional field, `bestiary`:
   `{ creature: string, book?: string }`. `creature` is the creature's name **as
   the library spells it** (`canonicalCreatureName`: the innermost heading of a
   stat-block chunk); `book` is the disambiguator a workspace with two books
   needs, matched against the same origin label every creature surface shows
   (`creatureOriginLabel`). The field is **additive in the strictest sense**: a
   record written before it parses with no `bestiary` key at all, a record that
   asks for nothing never gains one, and the model's own `"bestiary": null` (the
   strict JSON contract's spelling of "absent") reads as `undefined`.
2. **The prompt** (`llm/promptStyles.spineEntityKindsClause`). The clause rides
   the entity-kind bullet — the place the prompt describes what an NPC entity is
   — and it is rendered **only when the workspace holds at least one library
   creature** (`db/creatureRepo.listLibraryCreatures`). It teaches the REQUEST,
   never a statistic: a memorable character keeps its own name and the module's
   prose about it and borrows only the creature's numbers; a generic mob that is
   not a character gets no NPC entity at all. An empty library therefore composes
   the pre-change prompt **byte for byte** (pinned against
   `tests/fixtures/promptStyles/spine-classic-default.txt`).
3. **Finalize** (`features/modules/entity-batch.ts`). When the entity becomes an
   artifact, the batch reads the slot off the module row
   (`domain/module.bestiarySlotForEntity`), resolves the name to a library
   citation, and casts through `db/creatureRepo.castCreatureAsNpc` — the ONE cast
   function, unchanged. The creature's numbers are the library's, and the prose is
   the module's own paragraphs about the entity (`surroundingParagraphs` over
   `moduleDocumentText`), which is what the generator wrote about her — so while
   those paragraphs DESCRIBE her, no persona run is started for that entity at
   all. The result is ONE `npc` row carrying her name, that prose and a
   `creatureRef`, with **no authored stat block** — the pair `npcDataSchema`
   refuses by name — and a second run REUSES the row through the cast's own
   idempotency. **A MENTION IS NOT A DESCRIPTION** (docs/17 row 133, the owner's
   report: *"those named zombies only get an image on their details, nothing
   more. No text, no stat block, nothing"*): when the module's own paragraphs do
   NOT describe the entity — the text lists her, or the spine declared a name no
   scene ever wrote — the batch runs the entity's OWN persona **targeting the row
   it just cast**, and the cited row's REFILL below is what writes: the stat-block
   step is skipped with its reason before any model call, the citation survives
   byte-identical, `statBlock` stays null, and the DESCRIPTION is authored. The
   cast is kept in every case (the citation is the identity, the numbers stay the
   library's, the portrait cache still supplies the image); the numbers are never
   authored. The question "does this text describe her?" is ONE seam —
   `lib/wikilinks.describesEntity`, floor `ENTITY_DESCRIPTION_FLOOR` (40
   non-whitespace characters left once the entity's own name is taken out of the
   passage) — asked TWICE: over the module's paragraphs, and over the row's own
   body, so a row that already carries a description is never written over (a
   retry after a failed description run still finds a thin row and runs again).
   Trash mobs cited only inside an encounter are untouched by all of this: the
   encounter side still holds no cast seam and no persona of its own.

**Failures are LOUD and NAMED, never a guess and never a silent drop of the
prose.** `entity-batch.libraryCitationForEntity` refuses, in the owner's terms:

| Situation | What happens |
|---|---|
| The library holds no creature of that name | the entity FAILS with "the entity «X» asks to borrow the stats of «Y», but this workspace's library holds no creature of that name — import the book it comes from" |
| Two creatures share the name and the slot named no book | the entity FAILS listing both candidates and their books, naming the field to disambiguate with |
| A book is named that holds no such creature | the entity FAILS naming the book and listing what the library does have |
| One canonical entity is asked for two different creatures | the slot carry itself throws rather than picking one |

Each refusal lands in the batch's existing `failed[]` (name + message) — the
convention the panel and the module automation already toast — so the entity is
reported exactly like any other per-entity generation failure, and NOTHING is
written: no statless twin, no half-cast row.

**A description run that does not complete is loud too, and the cast still
stands.** When the batch authors the description above and that run dies (the
provider failed, the contract failed, the page ate it), the entity is reported in
`failed[]` with the run's own class — while its artifact exists: the cast landed,
the citation stands, the portrait is on it, and only the PROSE is missing. It is
the ONE case an entity appears in both `cast` and `failed`, and it is a
failure the owner has to hear (docs/17 row 131's funnel reports it in the console
and in the toast); re-running that entity runs this same arm again, because the
row still carries no description. A run the owner STOPPED is not a failure at
either arm — it is withdrawn and silent (docs/17 row 117).

### A cited row's REFILL — the Aunt Agatha rule (docs/17 row 112)

One rule for every path that writes a cast creature npc in place (the artifact
editor's "Generate/Regenerate with AI", the persona panel's targeted run, and —
since docs/17 row 133 — the entity batch's DESCRIPTION arm, which runs the
entity's own persona against the row it just cast when the module's paragraphs
only name her: this rule is what makes that write safe, and it is why the batch
extends THIS path rather than opening a second one), and
it has two halves that must never be separated. (The D3/D4 labels in this doc's
decisions table are the room-geometry and group-veil decisions; this rule is
recorded here, beside the cast it constrains, rather than as another D number.)

**NEVER ASK a cited row for a stat block.** A row that carries `creatureRef`
derives its numbers from the library creature, so `runStatblock` resolves the
REFILL TARGET (`getAnyArtifact(input.targetArtifactId)`) and, when
`isCastCreatureNpc` holds, finishes the step `'skipped'` with a reason naming
the citation and the library creature — decided BEFORE the model call. The
step-off is scoped to the TARGET, not to the kind or the draft: a NEW npc is
unaffected (nothing cites anything yet), a non-cited refill still produces its
block, and the draft's own `needsStatBlock` answer no longer gets a vote on a
cited row, because whether stats MATTER is a different question from where a
row's stats COME FROM. Asking anyway is not merely a wasted call: the answer is
a block the row cannot keep, so the run would fail after spending it.

**NEVER CONSTRUCT the refused pair.** `npcDataSchema` refuses an npc carrying
both a `creatureRef` and an authored `statBlock`, by name — so a refill merge
that assembled both would surface as a schema parse, not as an explanation.
`runEngine.mergeRefillData`'s npc branch therefore REFUSES a draft block on a
cited row with a sentence naming the row and the library creature and saying
nothing was written, and keeps the citation on the row it returns. Never drop
the citation (that severs the identity stating where the numbers come from),
never drop the block (that discards what a user-edited step produced), and never
"prefer one" silently. The step-off above makes this refusal unreachable from
the pipeline it just ran; it stays because a run PERSISTED before this rule —
resumed, or with a hand-edited statblock step — can still deliver one.

**The citation is IDENTITY, not content: a refill never deletes it.** Refilling
Aunt Agatha's prose leaves her `creatureRef` byte-identical and her `statBlock`
null, which is what keeps her numbers the library zombie's (the owner's own
words for this path: *"she will have zombie stats but with prose"*). Pinned in
`tests/llm/refill-creature-stats.test.ts`; the failure surface this rule's
refusal speaks through is recorded in docs/05 §Error surfaces and docs/18 §4.

**The borrowed numbers are DERIVED at read time and now RENDERED — read-only and
labelled** (docs/17 row 134; until that row they were drawn nowhere the owner
looked, which is the second half of his *"No text, no stat block, nothing"*).
The derivation is ONE rule, `domain/encounterResolve.resolveDerivedNpcStats` —
the same one the encounter roster's `npc-ref` arm has always read, so a row's
details panel, an encounter listing that row and a battle token can never answer
"which numbers are this npc's?" differently — repo-wired for top code as
`db/creatureRepo.resolveDerivedNpcStats`, which is the read the UI asks. The
RENDER is ONE component, `features/campaign/components/borrowed-stats.
BorrowedStatBlock`, mounted by the artifact editor's `NpcForm` (the details
surface the owner opens) and by the read-only `NpcCard` (the module reader's peek
modal and the session-mode card); it draws the library's block with a
`Borrowed from the library` badge and the disclosed origin label
(`NPC: Aunt Agatha (stats from Monster Manual p.316)`), so a reader can always
tell borrowed numbers from an authored block — and NOTHING is stored on the row,
so a library re-import or a corrected creature changes what she shows with no
write to any artifact. A cited row is therefore offered **no "Add stat block"
button**: asking such a row for a block is refused before any model call (the
half above) and `npcDataSchema` refuses to keep the pair, so that button was an
affordance that could never produce anything. **Failure is loud in both forms**:
a library that no longer holds the creature renders the named
`missing ref (Zombie)` in place — never a blank or greyish stat area — and a
citation carrying neither a chunk id nor a content hash is an error, shown in
place and raised through `lib/toast`. A non-cited npc is untouched: an authored
block renders and edits exactly as before, and an npc with neither citation nor
block keeps its "Add stat block" affordance.

**The asymmetry stays structural.** The encounter side can cite and cannot cast,
because it holds no cast seam and no schema field to express one; the new tests
extend that pin from the encounter ARTIFACT's data schema to the encounter
GENERATION contracts (the Smith draft, the Cartographer brief) and to the
absence of any cast call in `runEngine`/`encounterRoster`. The opposite claim
would be a second invented-creature path, which the tier exists to prevent.

---

### D5 amendment — mob portraits (2026-09-05, owner-ratified; afa23f4, 070d4ba, 64b30f9; coverage + level contract amended 2026-09-10, docs/17 row 90) — SUPERSEDED IN MECHANISM, kept as the record

The original D5 was written when a rulebook-cited monster had NO artifact
identity to hang art on. The owner ratified the mob-artifact arc, verbatim:

- **Mob artifacts**: finalize (BOTH remap sites — the Cartographer's map
  finalize and the in-place Smith fill) get-or-creates ONE campaign-scoped
  `npc` artifact per cited chunk. Kind `'npc'` + additive
  `data.monsterChunkId` marker — NOT a new kind, and NOT a `links` entry
  (artifact links are artifact→artifact in every consumer; a chunkId there
  renders as a broken node). The artifact holds the roster creature name +
  the marker; **NO stat duplication** — the chunk stays the source of truth
  (`resolveMonsterEntry` keeps reading it). Idempotent across runs and
  encounters (scan-based lookup mirroring `materializeMonsterNpc`'s
  one-entity-per-name scan). Key = chunkId: cross-book duplicate creatures
  get separate artifacts — acceptable v1; the roster disambiguates by book.
- **Token wiring**: additive optional `mobArtifactId` on the rulebook
  `monsterSource` variant (zod `.optional()` — old rows valid). At seed
  time ALL instances of that entry share `artifactId = mobArtifactId` (the
  npc-ref branch shape) and ONE `seedFighters` row freezes the
  chunk-resolved stats under that artifact id (the
  `byArtifactId.get(id) ?? bySeedId.get(id)` fallthrough in fighterStats
  resolves every instance — the mob artifact itself carries no statBlock).
  Portraits then render via the existing `coverImageId` path in TokenView —
  zero BattleSurface changes.
- **Lazy retro-fill**: existing encounters (no `mobArtifactId`) get their
  artifacts at SEED time (get-or-create during battleSeed's monster
  resolution) — no migration, no finalize requirement. The finalize path
  and the seed path share the same get-or-create helper
  (`src/db/mobArtifacts.ts`); finalize also creates, so the batch action
  works right after generation.
- **Third writer — bestiary roster spawn (2026-09-06, owner-ratified
  single placement)**: the Rules screen's Bestiary tab (12-BESTIARY-PACKS
  §12) spawns a creature into a module directly from its stat-block chunk —
  `spawnMobArtifactIntoModule` get-or-creates via the SAME helper and then
  `stampModuleOwnership`s the artifact into the picked module
  (`module:<title>` tag, one placement at a time; same-module spawn is an
  idempotent no-op, a different module MOVES the artifact with the old tag
  kept as history). No encounter artifact is required — the chunk is the
  source of truth exactly as above.
- **Portrait batch (one-click, not auto)**: an encounter-level
  "Generate mob portraits" action in the encounter editor (beside the
  monsters section). It enumerates the encounter's CHUNK-BACKED creature
  kinds whose mob artifact lacks `coverImageId` — a `rulebook` citation or an
  `npc-ref` to an artifact carrying `data.monsterChunkId`, the routing
  widened by row 90 in "The portrait batch covers EVERY roster participant"
  below, which is also the authority the MODULE-level sweep reads (row 96:
  both lanes there, never a rulebook-only roster shape); for each, generates n=1 portrait and
  attaches it as cover — the entity-image-queue mechanics (pump / intake /
  deterministic prompt draft / attach-cover) keyed by **artifactId** (the
  queue's wiki-link-name resolution does not fit mob artifacts;
  `src/features/campaign/mob-portrait-queue.ts`). **Prompt grounding (stat-exempt,
  2026-09-08, owner-ordered):** `portraitGroundingForChunk`
  (`src/llm/imagePromptDraft.ts`) composes the grounding ONLY from stat-free
  material — size + creatureType identity plus the traits / actions /
  reactions / legendary named-text prose (names + texts), capped at 800 chars.
  ALL numeric fields stay out by FIELD (level, ac, acNote, hp, hpFormula,
  speed, abilities, saves, skills, senses, languages, extras, system — `level`
  is borderline and deliberately excluded): smart image models RENDER chunk
  stat text into portraits. When `statBlock` is null (unparsed chunks) the
  helper falls back to raw `chunk.text` verbatim — the loud residual render
  risk, documented on the helper, never silent. Belt and braces: the
  text-render guard is default-on EVERYWHERE (`IMAGE_TEXT_NEGATIVE` →
  `Avoid: text, letters, … speech bubbles, watermark, signature, plot
  summary, explanatory text`), wired as the default `negative` of the shared
  Illustrator contract — covers, entity images, portraits, the run-engine
  prompt draft, the classic battlemap stylize (empty brief negative falls
  back to it), and the `appearance` shortcut (which keeps winning AND
  carries the guard) are all guarded; a caller passes its own list only as
  an explicit override. The mob-portrait `MOB_PORTRAIT_TEXT_NEGATIVE` name
  stays as an alias (identical by identity — the general list covers the
  proven portrait list). The ONE carve-out is the vision dungeon path
  below: it NEEDS its carved room plaques, so it never routes through the
  Illustrator contract — its tailored "no written text anywhere except the
  N letter plaques" clause is its guard instead (a blanket no-letters Avoid
  would fight the locate contract). **Owner amendment (2026-09-05, c3c021f):** the prompt draft is
  deterministic — no LLM call ("I dont want that extra LLM call. Just use
  the appearance/body."). Failures report loud per mob (`{name, message}`
  style, `entity-batch.ts` pattern); skip-if-imaged guard (existing queue
  behavior) — no re-generation of mobs that have covers.
- **On-demand invented creatures (2026-09-08)**: uncited roster entries
  (`inline` / `none` — model-invented mobs with no bestiary citation) get a
  per-entry and batch-all **"Create creature + portrait"** action in the
  same editor section (05-UI). It materializes a REAL `npc` artifact per
  entry name (`db/mobArtifacts.materializeInventedCreatureArtifact`:
  roster name, appearance seeded from the entry's notes/treasure text, the
  inline block when present else null, summary noting the encounter;
  scoped to the encounter's `moduleId` when module-owned else
  campaign-level so `deleteModule` cascade/keep disposes them together —
  and the roster entry is NOT rewritten, so battleSeed spawn paths stay
  identical), then flows through the EXISTING portrait queue as a
  LOCAL-only job (no `chunkId`: prompt grounded on the artifact's own
  content, never the cache). GM-only (editor surface);
  materialize/generation failures surface loudly, never placeholders.

- **The portrait batch covers EVERY roster participant that can own a
  portrait (owner report, 2026-09-10, docs/17 row 90; owner decision:
  *"A special look for a special zombie is ok."*)**. The enumeration used to
  be lane-by-`monsterSource.type`: `rulebook` entries in one lane,
  `inline`/`none` in the other — so an `npc-ref` row matched NEITHER and a
  materialized monster (the assertion rule's collision path, below) was
  invisible to the batch: the owner's two risen lumberjacks produced
  *"No creatures to illustrate — add roster entries first"* and could never be
  illustrated. Routing is now by **what the row's creature IS**, resolved from
  the artifact the row points at, never by the shape of its `source`:

  | Roster row | Lane | Portrait |
  |---|---|---|
  | `rulebook` (chunk citation) | rulebook | the one shared bestiary portrait (canonical slots go through the global cache) |
  | `npc-ref` → artifact WITH `data.monsterChunkId` (a mob artifact) | rulebook | the SAME shared portrait, deduped by artifact — never a second job, never a second cover |
  | `npc-ref` → artifact WITHOUT the marker (a monster the encounter materialized from a model-authored inline block; a named NPC standing in the roster) | invented | its OWN **local** portrait, grounded on the artifact's content |
  | `inline` / `none` (uncited) | invented | materialize the creature artifact first, then the same local portrait |

  **The cache firewall is structural, not a lane label**: an invented job
  carries NO `chunkId`, so the worker can build no `cacheKeyForMonsterSource`
  and can neither read nor write the global `mobPortraits` table. That is what
  keeps the owner's rule — a distinct invented creature never inherits a
  bestiary creature's shared art, and a bestiary creature is never
  re-illustrated locally because a roster row happens to point at its
  artifact. An artifact that already carries art is enumerated as
  `alreadyImaged`: enumeration attaches, detaches and regenerates NOTHING, so
  a named NPC keeps whatever portrait she already had. A dangling `npc-ref`
  throws loudly in BOTH the read-only count and the enqueue (the dangling
  `mobArtifactId` rule), and the section's label and copy state the
  participant count, so the empty state appears only when the enumeration is
  genuinely empty. The same enumeration backs the encounter's post-create
  `mobPortraits` extra (`derivePostCreateExtras`), which now runs BOTH lanes —
  a fresh Smith encounter's materialized monsters are illustrated there too.

- **The inline stat block's `level` is validated at the encounter boundary
  (owner report, 2026-09-10, docs/17 row 90)**. The owner's two lumberjacks
  rendered **"Level sourceName"**: the model's own citation vocabulary leaked
  into the level field of its inline block, nothing validated it
  (`statBlockSchema.level` was a bare `z.string()`), and the junk value
  PERSISTED on the materialized `npc` artifact. The acceptance set is what the
  app's one level parser (`llm/encounterRoster.parseLevelSort`) already
  accepts — a number (`"3"`, `"-1"`), a fraction (`"1/2"`), or `"—"` (the dnd5e
  system's own printed value for a CR-less creature). Anything else is refused
  as a NAMED ISSUE at both model boundaries (the Smith's `encounterSourceIssues`
  and the Cartographer's brief), through the existing one-repair-then-loud path:
  the repair prompt names the monster and the printed-level contract, a second
  offender fails the run (no silent coercion, no dropped monster), and
  `materializeMonsterNpc` independently refuses to write an artifact row from a
  block whose level does not parse. The prompt's shape hint now DESCRIBES the
  field instead of printing `"level": string` — the bare type is what invited
  the slip. The acceptance set is deliberately NOT tightened in
  `domain/statblock.ts`: that schema is the READ boundary for every stat block
  in the app, including the editor's blank form (`blankStatBlock` parses
  `level: ''`) and PDF-ingested chunks, whose detection is best-effort by
  design and whose unparseable levels are a documented sort-last state — see
  docs/18 §4.

- **The inline stat block's `abilities` are d20 SCORES, and a printed signed
  modifier is refused at the same boundaries (owner report, docs/17 row 95)**.
  A generated Pathfinder 2e mob rendered **"2 (−4)"**: PF2e prints ability
  *modifiers*, the model wrote its printed `+2`, and the shared read schema's
  coercion (`numericStat` — `Number("+2")` is 2) turned it into the score 2,
  which the stat block and the battle initiative then read as a score. The
  shape hint now STATES the convention (`score = 10 + 2 × the printed
  modifier`, worked example: a PF2e "Str +2" is written 14) — docs/12 §5 is the
  authority for the conversion, not a second convention — and
  `runEngine.statBlockSignedAbilityIssues` refuses a SIGNED ability value as a
  NAMED issue (teaching the conversion) through the existing
  one-repair-then-loud path: it rides `encounterSourceIssues` for BOTH model
  boundaries (the Smith draft and the Cartographer brief) and the statblock
  step's own reply, reading the reply's RAW pre-coercion object because the
  sign is exactly what the coercion erases. An UNSIGNED value the model meant
  as a modifier is NOT mechanically detectable and is never guessed (docs/18
  §4); `domain/statblock.ts` is untouched (it is the READ boundary). Display is
  per-system: a PF2e block prints the bonus only, every other system
  `score (bonus)` (docs/05 §Artifact editor).

- **Portrait regeneration (owner-ordered, 2026-09-09)**: when a batch would
  enqueue NOTHING because every portrait already exists, the section offers
  a **"Regenerate N portrait(s)?"** confirm (same for the per-entry
  invented action) instead of the old already-generated toast — Confirm
  enqueues delete-after-replace regen jobs; Cancel keeps today's
  toasts. Partial batches (some enqueued, some imaged) keep today's silent
  behavior with NO regen offer (05-UI). Mechanics (`regenerateMobPortraits`
  / `regenerateInventedCreaturePortraits`, the one way — docs/18):
  resolve + validate with no side effects (unknown artifacts, unreadable
  chunks throw loud with all old covers intact), republish canonical slots
  with FRESH bytes first (below — a failed republish throws loud with all
  old covers intact and nothing enqueued), then enqueue regen jobs (`regen:
  true`) for the imaged artifacts plus the normal batch for the cover-less
  remainder. The old covers stay until each worker commits its replacement
  (preservation rule below); tokens never sit on initials mid-regen.
  Flavored and invented covers regenerate locally,
  always; a canonical citation regenerates by REPUBLISH (below) — a plain
  re-enqueue would clone identical bytes, a no-op regen.

- **Portrait preservation rule (owner-observed permanent loss, 2026-09-09)**:
  regenerate/reseed NEVER destroys a mob portrait. Delete-after-replace is
  the only semantics: the old cover (blob + revision-snapshot pins) survives
  until the fresh cover COMMITS on the artifact in ONE attach-seam
  transaction (fresh cover lands, ONLY the superseded ids leave the gallery,
  are scrubbed from that artifact's snapshots, and are refcount-pruned) —
  snapshots are never scrubbed before the replacement commits, and the
  success path frees ONLY the superseded blob. A failed fresh generation, a
  skipped job, or the in-memory queue dropped on reload therefore leaves the
  old portrait — bytes and restore path — intact, with a loud error on the
  queue's per-mob failure path (never silent loss). Complementary:
  encounter content regeneration carries covers forward — when a re-cited
  roster entry converges on a NEW cover-less mob-artifact row (re-chunked /
  re-imported chunk), the old same-named row's cover is cloned onto the new
  row (`carryMobCoversForward`, the portrait worker's own clone mechanism);
  old rows remain as orphans (no deletion sweep — out of scope).

- **Battle-card trigger (2026-09-09)**: the battle surface's selection card
  offers per-token **Generate portrait** (cover-less) / **Regenerate
  portrait** (imaged, same confirm) for rulebook-cited mobs, GM-only —
  `enqueueSingleMobPortrait` / `regenerateSingleMobPortrait`
  (`src/features/campaign/mob-portrait-queue.ts`): the SAME queue, dock,
  dedupe, skip, and canonical-republish semantics as the editor batch — no
  second pipeline, no second detach path (docs/18). The token resolves to
  its mob artifact via `data.monsterChunkId`; the citing name comes from the
  provenance encounter's roster entry (chunkId/mobArtifactId match, artifact
  name fallback). Chunk-less tokens (PCs, real NPCs, inline synthetics,
  statless rows) show NO action — no dead affordance — and player-safe view
  never mounts it. The card's portrait image stays a pure lightbox button;
  the action is a separate explicit button.

### Content identity at citation birth (chunk-hash-fallback, owner-observed false 'missing ref')

Import keeps cited `chunkId`s as-is (source-instance uuids) but runtime
resolution only knew uuids — so a byte-identical installed book under new
row ids still showed 'missing ref' + the campaign banner, even though the
banner promises it "clears itself the moment the content is installed".
Rulebook citations now resolve by CONTENT identity, not just source uuid:

- **Stamped at birth**: the rulebook `monsterSource` variant carries
  additive optional `contentHash` (the cited chunk's SHA-256) + `creatureName`
  (`chunk.headingPath[0]`, roster entry-name fallback). Stamped by EVERY
  citation writer through the shared pure `contentIdentityFor`
  (`src/domain/encounterResolve.ts`) so all births agree: runEngine
  finalize (both remap sites, via `rulebookSourceFor` — a chunk that
  vanished between retrieve and finalize throws LOUD instead of writing a
  dangling citation), the editor's rulebook-link dialog (hash + heading ride
  the search hit into `onPick`), and the spawn picker's synthetic mob entry
  (`buildMobPickEntry`). Import heals pre-stamp entries from the v2 manifest
  (`healRulebookSources` in `src/lib/exportImport.ts`, matched by exporting
  artifact + cited chunkId) — old exports resolve too; the cited uuid is
  still KEPT as-is. The bestiary spawn dialog (`mobArtifacts.ts`
  `fillCoverFromCache` source) and the seed retro-fill write NO persisted
  citation, so there is nothing to stamp — they resolve through the same
  fallback below.
- **Resolver fallback, exact-only**: `resolveMonsterEntry`'s rulebook branch
  tries the uuid first, then `getChunkByContentHash` when the uuid misses
  and a hash is stamped (`MonsterLookups` gains the method;
  `resolveMonsterEntryWithRepos` prefers the statful hit when several local
  chunks share one hash — a statless hash hit never satisfies, mirroring the
  import L0 rule). A hit resolves stats + origin from the LOCAL chunk
  exactly as a uuid hit (pack creature label / PDF page label from the local
  row). A miss stays 'missing ref' unchanged.
- **Re-export carries dangling stamps (residual closed)**: `collectDependencies` writes a `missing-chunk` citation WITH the entry's own `contentHash`/`creatureName` when the chunk join misses (chunk data wins when present — the stamp is fallback-only), so re-exporting a healed-but-dangling campaign produces a manifest a second-generation import clears at L0 instead of aborting on.
- **L1 explicitly deferred**: a same-creature chunk under a NEW hash
  (revised printing) still resolves 'missing ref' — the import dep dialog
  already reports that drift (`version-drift`), and the resolver stays
  exact-content. `creatureName` is stamped now but RESERVED (unused by the
  resolver) for that future fuzzy lane.

### Global portrait cache (slice A — owner-ratified)

Core/external bestiary creatures only (NEVER module-generated NPCs):
a portrait is generated ONCE per rulebook chunk and reused across all
campaigns/modules. Dexie v18 `mobPortraits` table (`id, &chunkId`,
additive, no upgrade — starts empty) mapping chunkId → one global-scope
shared-blob image row.

- **Canonical-only (binding).** Encounter rosters flavor core creatures
  ("slimey giant rat" citing the giant-rat chunk) while mechanics spread
  the flavor (first-citer-wins artifact naming). A flavored generation
  entering a chunk-keyed cache would make every giant rat everywhere
  slimey — so the cache holds CANONICAL portraits only: prompt grounded on
  the chunk's stat-exempt portrait grounding (`portraitGroundingForChunk` —
  identity + prose, never raw stat numbers) plus the chunk's canonical
  creature name (last `headingPath` element), never roster/artifact flavor. The cache is
  written ONLY by canonical generations (the citing entry used the
  canonical name, trimmed case-insensitive), so the single normal
  generation serves both cover and cache. A flavored citation gets its
  local flavored cover and NOTHING ELSE: no write, no overwrite, no
  behind-the-back canonical generation (never spend image budget for
  global benefit unsolicited). A chunk cited only ever flavored keeps an
  empty slot and per-campaign behavior is unchanged.
- **Generate-once.** The queue's canonical branch checks the cache first
  (`ensureCanonicalMobPortrait` fast path: a populated slot is CLONED into
  the cover-less artifact's cover through `cloneCachedPortraitToArtifact`,
  so no image generation happens) and generates only on a miss, through the
  dedicated cache worker (in-memory single-flight per chunkId, put-if-absent
  publish converging on the unique `&chunkId` winner). The BATCH does not
  pre-clone while it enumerates (owner report → ledger 83): a cover-less
  canonical citation is a normal job — the worker clones the slot and the
  batch reports it as work, so a hole the owner can see is never reported as
  art that already existed. Progress keys stay artifactId-based; generation
  stays manual-only.
- **Render = clone.** The shared global row is never attached; each mob
  artifact gets its own campaign-scoped copy of the bytes as
  `coverImageId` through the attach seam — zero BattleSurface changes.
- **NEVER-DELETE.** The cached blob is explicitly immune to campaign
  `pruneUnreferencedImages` (structural: global-scope rows are outside
  every campaign prune's scan) and the global
  `deleteImageIfUnreferenced` path (explicit cache-record check) while
  the cache record exists.
- **Regeneration = REPUBLISH (owner-ordered, 2026-09-09 — the coherent
  canonical consequence).** Regenerating a canonical portrait generates
  FRESH bytes and republishes the global slot (`replaceCanonicalPortrait`,
  the ONLY unconditional slot writer, via
  `regenerateCanonicalMobPortrait`, the ONLY fresh-generation path) — the
  slot IS the canonical portrait, so future clones everywhere render the
  new art. Other campaigns' EXISTING covers are INVARIANT: render-is-clone
  means they carry independent campaign-scoped rows, verified before
  claiming and pinned by tests. The superseded global blob is deleted in
  the republish transaction (referenced by nothing — never a regen leak).
  The regen surfaces a loud toast naming the shared consequence. The
  local-only alternative (a fresh cover diverging from canon) was rejected:
  a silently non-canonical "canonical" portrait is the worse lie —
  regenerating a canonical citation is therefore NEVER local-only. The
  republished bytes reach existing covers through the preservation rule's
  delete-after-replace force-clone (old local cover live until the clone
  commits), never through a detach.
- **Grandfathering.** Existing per-campaign covers are kept; no backfill.
- **Firewall.** Every cache entry point gates on
  `cacheKeyForMonsterSource`: `source.type === 'rulebook'` with a defined
  `chunkId`. npc-ref / inline / none rows and marker-less module NPCs
  (entity queue) never touch the seam — pinned by tests. On-demand
  invented-creature artifacts carry no `monsterChunkId` marker and their
  portrait jobs carry no `chunkId`, so both the materialize and the
  generate stay structurally off-seam (covers LOCAL ONLY) — pinned by
  tests. The 2026-09-10 widening (above) added a THIRD such row shape — an
  `npc-ref` pointing at a marker-less `npc` artifact — and it is off-seam for
  the same structural reason, not because of its lane: the invented lane hands
  the worker no `chunkId`, so no cache key can be built for it
  (`tests/features/mob-portrait-npc-ref.test.ts` pins the cache count).

## Pipeline (run-engine steps)

A new run-engine mode with fixed named steps (same architecture as the image
mode: run row per state change, event emitter for streaming, autonomy via
`pauses()`):

| Step | Kind | Pauses (manual/review) | Output |
|---|---|---|---|
| `brief` | LLM + zod | yes (editable) | theme, rooms w/ purpose + roster + adjacency, entry point |
| `layout` | deterministic | yes (review overlay) | `encounterLayout` JSON |
| `schematic` | deterministic (canvas) | never | in-memory data URL, exact pixel size |
| `stylize` | image API + `input_references` | no (candidates land in pick) | 2 image candidates (1 in auto) |
| `pick` | UI | **always** (auto: picks candidate 1 by contract) | kept map image id |
| `finalize` | repo writes | — | encounter artifact updated/created |

The table above is the CLASSIC pipeline. Vision runs (`dungeonMapPath:
'vision'` resolved for a multi-room brief) run
`brief → vision-map → finalize` instead — no layout/schematic/stylize/pick,
no pick pause (the single map is selected by contract; locate+verify is the
gate). See "Vision-located dungeon path" below.

- `brief` reads the campaign context like other personas (retrieval + linked
  artifacts) and — in regenerate mode — the existing encounter artifact
  (roster verbatim; the LLM may not rename roster entries).
- `brief` validation is **strict on meaning, tolerant on formatting**: numeric
  strings for counts/indexes are coerced, `styleNotes`/`negative`/`notes`/
  `description` default to `''` when omitted (guidance, not data). Roster,
  rooms, index bounds, connectivity and — for fresh encounters — resolvable
  stat-block sources stay hard requirements. A failed parse produces **named
  issues** (`path: message`, or `monsters[i] "Name": …` for sources); the one
  repair turn quotes them to the model, and a still-rejected step persists
  them as `output.issues` (next to `raw`) so the review card lists them.
  A rejected brief cannot be approved (04 §Autonomy); Retry and Edit remain.
- In **regenerate mode** the model's monster entries carry no stat data: the
  roster (with its stat sources) is preserved verbatim from the target, so
  embedded `statBlock`/`sourceChunkIndex` fields are stripped before
  validation and the prompt asks for `name/count/notes` only. The model's
  roster must match the target's length, and every roster entry must belong
  to exactly one room — both checked at the brief boundary (repairable) so
  they never surface later as run-killing layout errors. Fresh encounters
  without rulebook excerpts get the **complete inline stat-block shape** in
  the prompt; a partial block stays a validation failure.
- `layout` is **pure code** (next section): the LLM never emits coordinates.
  A bounded retry ladder (re-pack with jitter, max 3 attempts, shrinking room
  size classes) ends in a failed run — never a placeholder layout.
- `stylize` prompt contract — TWO mode contracts (natural-site mode, D17):
  - **Architectural (dungeon — the default, byte-identical to the pre-mode
    contract)**: style guidance from the brief (medium, palette, biome, era)
    + the binding instruction "keep walls, openings and overall structure
    exactly as in the reference image; no text, no labels, no grid lines, no
    numbers, no tokens/minis, no watermark" + the anti-hallucination
    negatives (owner-observed 2026-09-08: a jungle map came back with white
    rectangles baked into the floors — the image model read the schematic's
    pale room fills as geometry to preserve): no white/pale boxes,
    rectangles, plaques, discs, signposts or other label-like markers apart
    from the entrance triangle; room floors are painted as continuous natural
    terrain with no discrete light-colored sub-rectangles. `negative` and
    `styleNotes` mirror the Illustrator contract (07 §M3-A).
  - **Natural site (outdoors — prose-led)**: the encounter's own prose leads
    (theme + `terrain` + `summary`, then `styleNotes`); the reference image
    is explained as placement-only (patches = where creatures gather, the
    triangle = the approach); the materials line and the keep-walls clause
    are OMITTED entirely and there are NO terrain bans (no "no rectangles",
    no "no structures" — an island in a lava lake or a murder-clown tent
    stays paintable). The usability hard-bans above keep VERBATIM in both
    modes, and the entrance clause softens to "a visible approach path at
    the marked spot" (the marker mechanics are unchanged).
- **No verify step (D14)**: the former `verify` bullet set — the SHAPE-AWARE
  coarse-grid contract for complexes, the `arena-verdict` structural check
  for single arenas (the 5a8f8f2 fix for the 7/7 auto-run blocker), the 12%
  `needs_review` threshold with named reports, the drift overlays and the
  dedicated vision model — is SUPERSEDED and then DELETED (owner, 2026-09-08,
  verbatim in D14). `src/llm/encounterVision.ts` is gone; nothing reads map
  pixels or spends a chat call grading a stylized image. What replaced the
  correction loop:
  - **"Regenerate candidates"** in the pick view (`runEngine.regenerateEncounterCandidates`)
    truncates the run back to the stylize step — the approved brief and
    layout (room keys included) stay untouched — and re-runs stylize, so the
    user judges a fresh batch at the same pick pause. The discarded batch's
    still-unattached candidates are pruned (`deleteUnreferencedImages`
    re-checks references, so an id that somehow got attached survives).
  - **Regenerate layout** (the pre-existing affordance) remains the full-geometry
    correction: fresh pack (variant ladder), fresh room keys — the ratified
    D9 consequence.
- `pick` renders each candidate with the **room overlay** (labeled room
  rects + mobs rect) so the user judges alignment, not just looks.
- `finalize` stores the kept image (`role: 'map'`), writes
  `encounterData.layout` + `mapImageId`, and (regenerate mode) keeps
  `name/body/links/monsters` untouched. Regenerate mode routes the
  re-anchor + content write through `attachImagesToArtifact` (one
  images+artifacts+revisions tx, cover explicitly kept) — a crash between
  them can no longer strand a library-scoped image while the artifact keeps
  the old map; the fresh-create birth path stays a single-row
  `createArtifact` (no desync window, intentionally off-seam).

## Layout engine (`src/domain/encounterMap/`, pure TS, vitest-covered)

- `packRooms(brief)`: adjacency graph + per-room size classes → rectangles on
  a fixed grid (`gridW × gridH` chosen from the aspect option, see below),
  1-cell corridors between connected rooms, doors on shared edges. Adjacent
  rooms are placed in neighboring grid slots so the connection graph stays
  compact and branching (a central room can fan out instead of forming one
  serial U); twelve deterministic packing candidates are scored for corridor
  length, connected-room distance and one-dimensional chains, and the best
  valid candidate wins. Rooms may be unions of 2–3 rects; `mobsRect` is the
  largest inscribed rectangle minus a 1-cell border.
- Validation (all loud): rooms disjoint, corridors 1 cell wide and connected
  door-to-door, exactly one `spawn` room, `mobsRect` area ≥ the room's monster
  count, everything inside the grid. Invalid ⇒ retry, then fail.
- `placeMonsters(layout, roster)`: one free cell per instance inside the
  room's `mobsRect` (deterministic scatter, ≥1 cell apart, doors excluded) —
  reused by the seeder; the layout persists only `monsterIndexes`, placement
  is recomputed at seed time so roster edits never desync stored coordinates.
- `veilsFromRooms(layout)`: one `BattleVeil` per room — kind `'veil'`, center
  normalized from `mobsRect`, `widthCells/heightCells` = the rect's cell
  span (legacy helper, kept for its pin tests). Battle seed uses
  `veilsFromSpawnClusters(layout, rosterCounts)` (D4): one veil per
  `monsterIndexes` entry — the group's `placeMonsters` cells PLUS the
  one-cell cover margin (clamped to the board), first group per room keeping
  `id = room.id`, every group carrying `roomId`. Correct under D6 because
  cell metrics are layout-anchored on the surface.
- `renderSchematic(layout, cellPx, factory, mode)` — canvas: walls dark,
  floor light, doors as gaps, subtle per-room fill; **cell px = 96** (e.g.
  24×18 → 2304×1728, inside the 4096 map cap). Returns a data URL; nothing
  stored. `mode` (D17 natural-site mode) picks the contract: `'architectural'`
  (default — legacy callers and pre-mode runs keep the exact bytes) renders
  the room/wall schematic; `'natural'` renders the placement-only overlay —
  one soft organic moss patch per room over the mob-cluster cells
  (`mobsRect`, drawn as a deterministic union of jittered circles, never a
  rectangle) + the canonical entrance triangle with NO wall gap and NO
  landing pad, over the same neutral base; corridors paint nothing.

Aspect options in the run dialog: **4:3 (24×18, default)**, 16:9 (28×16),
1:1 (20×20). Aspect selection is a genuine user preference, persisted in
`settings` like the generation language.

## Data model (additive Dexie v12)

```ts
// src/domain/encounterMap.ts (new; re-exported from domain index)
export const layoutRectSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0),
  w: z.number().int().min(1), h: z.number().int().min(1),
}); // grid cells, origin top-left

export const layoutRoomSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** Union footprint (1 = plain rect, 2–3 = L/T shapes). */
  rects: z.array(layoutRectSchema).min(1).max(3),
  /** Inscribed mob area: placement source and the room veil's footprint. */
  mobsRect: layoutRectSchema,
  description: z.string(),
  /** Indexes into `encounterData.monsters`. */
  monsterIndexes: z.array(z.number().int().nonnegative()),
  /** Exactly one room per layout. */
  spawn: z.boolean(),
});

export const layoutCorridorSchema = z.object({
  a: z.uuid(), b: z.uuid(),
  rects: z.array(layoutRectSchema).min(1), // 1 cell wide
});

export const encounterLayoutSchema = z.object({
  gridW: z.number().int().min(12).max(40),
  gridH: z.number().int().min(12).max(40),
  theme: z.string(),           // style summary, reused by regeneration prompts
  rooms: z.array(layoutRoomSchema).min(1).max(9),
  corridors: z.array(layoutCorridorSchema),
});
```

- `encounterDataSchema` gains `layout: encounterLayoutSchema.nullable()
  .default(null)` — the encounter's designed map data (upgrade default `null`;
  artifact revisions snapshot it automatically, D2 of M6).
- `battleBoardSchema` gains `mapLayout: z.object({ cols: z.number().int(),
  rows: z.number().int() }).nullable().default(null)` — stamped from the
  encounter's layout at seed time; `null` keeps today's CSS-px behavior for
  GM-drawn veils on uploaded maps.
- No new tables; the map goes through the existing `images` table
  (`role: 'map'`, 4096 cap). Runs/revisions/storage all reuse existing rows.

## Battle surface: layout-anchored metrics (M5-D extension)

When `board.mapLayout !== null` (D6):

- Cell metrics: `cellWidth = boardWidth / cols`, `cellHeight = boardHeight /
  rows` (normalized at capture, same re-capture-on-mount pattern as the
  staging ground). Veil spans, `resizeVeilFromEdge` quantization and token
  snapping use these, so a veil covers the same map area on every viewport.
- The visible grid overlay renders from the layout
  (`background-size: ${100/cols}% ${100/rows}%`) — it aligns with the
  generated map by construction.
- `tokenSize` re-captures from the measured cell size on mount so portrait
  tokens fill a layout cell.
- Veil/token geometry **stored on the battle stays cell-quantized and
  normalized** — no schema change to `battleVeilSchema`; only the cell-size
  *source* changes. GM-added veils on a layout battle quantize to layout
  cells too (consistent, and still screen-size stable).
- Staging ground: seeded at the `spawn` room's `mobsRect` center.

Without `mapLayout` (uploaded maps): exact current behavior, byte-for-byte.

## Room keys & mob treasure (owner-ratified, 2026-09-07; e489a65 → 01a0b5e)

The encounter generator now authors the GM-only text a live table reads:
what the GM says when the party first enters each room (**room keys**),
what treasure sits in each room (**room treasure**), and what ONE instance
of each creature carries (**mob treasure**). All of it is free-text GM
checklist content — never player-facing, never structured loot output.

### Data model (additive defaults, D9)

- `encounterMapRoomBriefSchema` and `layoutRoomSchema` gain
  `key: z.string().default('')` and `keyTreasure: z.string().default('')`.
  Persisted **on the room**: `packRooms` rotates brief rooms
  (`rotate(brief.rooms, attempt % count)`), so a parallel roomId-keyed
  array could orphan on every retry. `packAttempt` copies both onto the
  packed `LayoutRoom`, and `layoutFromStagingMarkers` copies them through
  the staging rebuild — a key survives rotation, review edits and the
  detector round-trip with its room (test: packing-rotation survival).
- `monsterEntrySchema` (domain + the Smith's draft/brief schemas) gains
  `treasure: z.string().default('')`, persisted **on the entry**: the
  editor removes roster rows, so an index-keyed side array would re-key and
  corrupt. Both finalize remap sites (map finalize + in-place Smith fill)
  persist draft treasure; the regenerate contract copies the target roster
  verbatim INCLUDING treasure ("same names, counts and treasure").
- Keys and treasure are *optional enrichment* defaults (AGENTS rule 1) — a
  brief that omits them parses with `''` and is never rejected over their
  absence; a dropped legacy artifact still reads valid.

### Generation (prompt clauses + retrieval)

- `src/llm/treasureGuidance.ts` (new, unit-tested):
  `treasureGuidanceFor(system)` teaches the shared treasure structure
  (one string per roster entry = what ONE instance carries; hoard-level
  finds go to the encounter's top-level `treasure` / the room's
  `keyTreasure`; permanent/magic items come ONLY from the item pool by
  exact name — never re-stating the pool section, only adding structure
  and budget around it) plus a **per-system budget**:
  - **dnd5e** — Campaigner's OWN documented approximation (pocket treasure
    ≈ 5 × CR in mixed gp-equivalent coins; hoards ≈ 50 gp × average
    encounter level; at most one magic item per two encounter levels). The
    **DMG is not licensable** — no DMG text is quoted, paraphrased or
    restated; the doc you are reading IS the shipped approximation.
  - **pathfinder2e** — the GM Core treasure rules are the law: when the
    retrieved excerpts include the treasure chapter the model follows its
    budgets **VERBATIM** under Paizo's Community Use Policy (personal use);
    no Paizo text ships with Campaigner. Without such an excerpt the model
    gives unquantified treasure instead of inventing amounts — a
    paraphrased budget would be a silent fabrication.
  `roomKeyGuidanceFor()` teaches the Cartographer the key contract: a
  1–3-sentence read-aloud-style key per room + a one-item-per-line room
  treasure checklist; outdoor encounters get keys on their staging areas
  too; and the regeneration consequence ("room keys regenerate together
  with the map").
- The Smith's draft prompt carries `treasureGuidanceFor(system)`; the
  Cartographer's brief prompt carries both clauses plus the
  `,key:string,keyTreasure:string` reply fields.
- Encounter retrieval gains a bounded **third search**
  (`'treasure budget by level party wealth hoard coins'`, limit 3,
  `chunkTypes: ['section', 'table']`) merged into the merged context —
  excerpt grounding for the budget, never a citation channel. The frozen
  citable stat-block search is untouched (pinned at 3 calls).

### Editor, seeding and surface

- **Editor** (`kind-forms.tsx`): a per-row treasure textarea in
  `MonsterListEditor`; a **Room keys** section (only when
  `data.layout !== null`) with one key + room-treasure textarea per room,
  labelled `Room <canonical letter> — <name>`. Edits touch only the key
  fields — room rectangles stay regenerate-only (non-goals). The
  battlemap section states the two-action contract ("Regenerate everything
  builds a new layout and map, Repopulate keeps the map") and the
  fresh-keys consequence ("Regenerate everything writes fresh room keys").
- **Seeding**: `battleTokenSchema` gains `treasure` (default `''`,
  mirroring the `initiativeBonus` frozen-copy precedent);
  `tokenFromFighter` takes an optional treasure; `expandRosterEntries`
  stamps `entry.treasure` on every instance token (statless tokens
  included). In-battle spawn shares the same expansion path, so a
  mid-fight spawn inherits the checklist.
- **Battle surface**: key markers derive — never stamp — from the
  provenance encounter's CURRENT layout (useLiveQuery), one tappable badge
  per keyed room at its `stagingPoint` (canonical marker letter), rendered
  before the veils so a covered room hides its key marker exactly like it
  hides its mobs. Only rooms with key content get a marker. Tapping opens
  the key card in the right rail (room header, key text, room treasure,
  `whitespace-pre-line`); background tap and the player-safe toggle clear
  the selection. The selection card gains a GM-only treasure block
  (`data-testid="token-treasure"`) for non-empty token treasure.
- **Player-safe DOM contract (09 §M5-D amendment)**: markers, key card and
  treasure text mount ONLY in GM view — pinned by a contract test
  asserting the key/treasure strings are absent from `document.body`.

## Seeding (`seedBattleFromEncounter` extension)

For an encounter with `layout !== null`:

1. Stamp `board.mapLayout` from the layout.
2. Create the spawn-group veils (`veilsFromSpawnClusters`) — kind `'veil'`
   (a mob cover is plain cover, never fog — D4's fog-cloud amendment),
   one per `monsterIndexes` entry (D4); the spawn room's groups are veiled
   too (no exemption).
3. Place each roster instance on a free cell of its room's `mobsRect`
   (`placeMonsters`), `visible: true` — the group's veil removes it from the DOM
   and initiative (the player-safe mechanic, byte-identical since the
   token-lifecycle arc; **reveal = GM lifts the veil**, and reconcile already
   auto-rolls revealed fighters). The GM order additionally keeps veiled NPCs
   with a veiled badge (GM honesty — the GM sidebar no longer starves under
   default-on group veils).
4. Spawn PCs in the spawn room's `mobsRect` instead of the default center.

Roster entries without stats keep today's loud statless path, placed in their
room like everyone else. `layout === null` encounters seed exactly as today.

**Auto-promote (D15):** seeding and in-battle spawning resolve the roster's
token artifact ids against the battle module FIRST — an owner mismatch
promotes the artifact to campaign level (loud toast) before the seed rows
freeze identity, so the first module never loses its monster silently and
both modules share the one row.

### D16 — single-map-slot replace (owner decision, 2026-09-08)

The gallery holds EXACTLY one map per encounter — regenerate REPLACES, never
accumulates (multiple maps per encounter stays a v1 non-goal). The
regenerate finalize rides the attach seam in one transaction: the fresh map
appends, the previous `mapImageId` leaves `imageIds` via `removeImageIds`,
its blob rides `pruneCandidates` (refchecked — freed only when nothing still
pins it), and unpicked candidates stay pruned at pick as before. History
keeps every replaced id: `writeRevision` clones the whole row, so each
revision snapshot's `data.mapImageId` names the map on file at that revision
— and the imageRepo refcount pins exactly those ids (live `data.mapImageId`,
snapshot `data.mapImageId`, frozen `board.mapImageId`), so deleting an old
gallery row can never destroy the blob under a live board. The live
battlemap itself is undeletable: `removeImageFromArtifact` refuses (loud,
with Regenerate guidance) any image that is any encounter's current
`data.mapImageId` — the editor lightbox delete rides the same function.

Board convergence: after the finalize swaps the map, every battle with
`encounterArtifactId` on the target and `board.everLive === false`
converges onto the fresh `mapImageId` + `mapLayout` (repo-level
`convergeBoardsToRegeneratedMap` through the `patchBattle` path — tokens,
veils and everything else ride along untouched). A battle that already went
live stays FROZEN on the board the table actually played — Open battle never
reseeds (docs/18 gotcha) — and the finalize toasts loudly so the GM re-runs
the battle to pick up the new map. Seeding always reads the CURRENT map, so
a seed after a replace picks up the new board copy.

## LLM/image client changes

- `imageGen.ts`: optional `inputReferences: { dataUrl: string }[]` on
  `POST /api/v1/images` → `input_references: [{ type: 'image_url',
  image_url: { url } }]` (OpenRouter's documented edit contract). The
  deterministic rescale-to-aspect guard runs before intake: a stylized image
  that came back with a different aspect is letterboxed/cropped to the exact
  layout aspect on the canvas **before** `intakeImage`, and the guard's action
  is recorded on the step output (never silent).
- `openrouter.ts`: `ChatMessage.content` retains the widened
  `string | content parts` shape (client-level capability; the vision guard
  in `walkModelChain` still consults `requestHasImageInput`). The D19
  vision-locate pass sends image parts (the map data URL + the instruction)
  — the only pipeline caller that does.

## Persona + run engine

### D18 — two-button regeneration (owner-directed, 2026-09-09)

Owner verdict on the old surface: a content "Regenerate with AI" on a
dungeon resetting it to one fight is "just wrong UI". The editor now offers
EXACTLY two automatic actions for both shapes plus the checkbox (D18 row
above for the contract). Engine seams (all in `src/llm/runEngine.ts` unless
noted; no Dexie/schema changes):

- `StartRunInput.encounterScope?: 'full' | 'rosterOnly'`,
  `encounterProseOnly?: boolean`, `encounterRedesignName?: boolean`.
- `ENCOUNTER_ROSTER_ONLY_STEP_NAMES = ['brief', 'finalize']` + the
  step-output marker pattern (`briefRosterOnlyMarker()` stamps
  `rosterOnly: true`): scope-aware `executeFrom` kinds, `runStep` finalize
  routing, `editStep` re-stamp, `retryStep` pre-reset capture, and guards in
  `regenerateEncounterLayout` / `regenerateEncounterCandidates` /
  `pickEncounterMap` that refuse roster-only runs.
- The brief drops the empty-roster throw (an empty roster is now a FRESH
  population — "appending to nothing means designing everything"); the
  roster pin applies to full runs only; a roster-only complex brief renders
  the stocking clauses against the target's actual rooms (mirror list),
  keeps the verbatim-prefix → source-cited-appends → cap structure, and
  stamps the brief's draw-once fill grade on the step output.
- The evaluate gate enforces the room mirror (same count, same order,
  every roster entry in exactly one room) and the fresh cap
  (Σ room expectations + margin, byte-identical message).
- `runEncounterRosterFinalize()` persists ONLY `monsters` (plus lowered
  `targetLevel`s and the LOUD advisory) onto the preserved rooms — geometry,
  keys, corridors, path, name, prose, links, tags, images, preset,
  siteShape, locationKind and fill grade all ride along; the room-tagging
  maps the brief's partition by index (the gate already approved it — a
  drift is a loud invariant failure, never a silent re-partition).
- The Smith's `encounterProseOnly` branch persists name/prose/body only and
  fails loud on ANY roster drift (`renamed` / `encounterRedesignName`
  aliases feed the alias-append only when the box is ticked).
- Orchestration seam `src/features/campaign/encounterRegen.ts`:
  `repopulateEncounter()` (complex roster-only pass, singles the Smith
  fill; roomless complexes refuse with a loud error pointing at Regenerate
  everything), `regenerateEncounterEverything()` (complex full reset via
  `resetComplexForRegeneration()` then the full pipeline with the row
  preset — remembered-preset trap fix; singles the Smith draft then the
  unattended map queue), `runProseRedesign()` chained after when the box
  is ticked. Draw-once: finalize uses `target.data.fillGrade ??
  <brief stamp> ?? drawFillGrade()` — one draw per run at most, legacy rows
  backfill on repopulation. Amended (D19): `EncounterRegenOptions`
  gains the per-run `dungeonMapPath` (explicit-only — the complex
  Regenerate-everything leg forwards it onto the run row; singles ignore
  it, repopulation takes none).
- Surface: `encounter-ai-section` holds `encounter-regenerate-everything`,
  `encounter-repopulate` (disabled for roomless complexes) and
  `encounter-redesign-prose`; the battlemap section keeps Upload + Clear
  and states the two-action contract; the old hand-off store
  (`encounterGenerationRequest.ts`) is deleted — the panel no longer
  receives encounter hand-offs (manual panel runs are fresh creates only).
  Amended (D19): the section gains the complex-only per-run Map path
  control (`encounter-regen-map-path` + `encounter-regen-map-path-hint` —
  Use default / Classic / Vision with one honest line per path); the
  choice is section state only, never persisted.
- Tests: `tests/llm/encounterRepopulate.test.ts` (9: replace-all-rooms +
  repair loop + byte-identical layout/map + advisory + fill grade, over-cap
  rejection, legacy backfill, pipeline shape, regen-everything complex,
  prose ON byte-identical roster, prose drift loud fail, single repopulate,
  single regen-all).

- New built-in persona `encounter-cartographer`, `mode: 'encounter'`,
  `producesKind: 'encounter'` (mode enum and the `producesKind` refine extend).
- Run engine: step list above; `brief` and `layout` are user-editable
  checkpoints (the layout editor shows the rendered schematic + overlays);
  `stylize` never pauses; `pick` pauses on every autonomy except the
  unattended queue path (D2). The **pick view** carries **Regenerate
  candidates** (D14) beside the layout review's Regenerate layout.
- Run panel: generic step rendering plus two new step UIs — the layout review
  (schematic + room overlay, **Regenerate layout** button) and the map pick
  (candidates with overlays + **Regenerate candidates**). Room rects are
  **not** hand-editable in v1
  (regenerate instead — D2's "later refinements" = edit the roster/brief and
  re-run).
- The encounter editor's generation surface is the D18 two-button section
  (**Regenerate everything** / **Repopulate** + the "Also redesign name and
  prose" checkbox — the ONLY automatic actions for both shapes): both go
  through the ONE change seam `features/modules/change-artifact.changeArtifact`
  (docs/17 row 101, docs/18 §2), which resolves the row, routes by its kind and
  forwards to `encounterRegen` — the surface keeps only its `running` flag and
  its toasts, and a `refused` result is toasted with the seam's own reason. The
  seam adds no prompt text of its own: `EncounterRegenOptions.instruction` is
  the one optional addition (appended to every brief this operation sends,
  absent = byte-identical), because a change is requested from the seam rather
  than written by it (no persona-panel hand-off —
  the `encounterGenerationRequest` store is deleted and manual panel runs
  are fresh creates only). The Battlemap section keeps Upload battlemap +
  Clear and states the two-action contract; the pre-filled-brief wording is
  gone with the hand-off. This is the intended path for module stubs
  (a roomless complex resets, then runs the full pipeline).

### D19 — vision-located dungeon path (owner-directed, 2026-09-09)

The lab's labeled-map recipe (`experiments/labeledDungeon.ts`), hardened
for production. Engine seams (all in `src/llm/runEngine.ts` unless noted):

- `src/llm/visionDungeon.ts` (new, creation-path home): `LabeledMapRoom`
  (rooms carry optional `isEntry` — the brief's entry room keeps its letter
  like every other room; the flag only designates it),
  `MAX_LABELED_MAP_ROOMS = 14`, `labelForRoomIndex` / `labelsForRoomCount`
  (A..N in room order), `buildLabeledMapPrompt(rooms, concept,
  connectivity?)` (rooms render as "Room A: name — description",
  connectivity as the declared graph, diegetic engraved/carved plaques,
  no-monsters clause, place-for-labels rule, natural-shape instruction —
  NO global regular/irregular clause; exactly one `isEntry` room renders
  the entrance clause naming its letter explicitly — "Room C is the
  dungeon entrance … draw it AS a visual entrance (stairs descending, a
  cave mouth, a gate, or a portal to suit the concept), plaque included" —
  zero flagged rooms render no clause, two throw loud), `buildVisionLocateInstruction` /
  `buildVisionRelocateInstruction` (0–1000 grid, omit-never-invent),
  `visionLabelMarkSchema` / `visionLocateReplySchema` /
  `parseVisionLocateReply` (JSON extraction + zod boundary), `locateDungeonLabels`
  (initial pass + count check + focused re-ask per miss, first-mark-wins
  dedupe, still-missing ⇒ `VisionLocateError` naming the letters). The lab
  aliases the shared contract (`dungeonVisionReplySchema`,
  `parseDungeonVisionReply`) — lab imports FROM the shared module, never
  the reverse.
- Path resolution: the brief stamps `mapPath` via `resolveBriefMapPath`
  (rooms > 1 AND (per-run override ?? `settings.dungeonMapPath`) is
  `'vision'`); `ENCOUNTER_VISION_STEP_NAMES = ['brief', 'vision-map',
  'finalize']`; `executeFrom` re-resolves the kinds after the brief stamps
  its marker (pre-brief runs read an explicit vision override
  optimistically); manual brief edits re-stamp the marker; the run row
  carries `dungeonMapPath` explicit-only (null = no override) and every
  resume/retry input rebuild carries it back.
- `runVisionDungeonMap()`: sidecar from the brief's rooms + concept +
  declared graph → ONE `generateImages` call (count 1) → `intakeImage` →
  `createImage` (`role: 'map'`) → `blobToDataUrl` → `locateDungeonLabels`
  over `visionLocatePass` (configured chat model, temperature 0,
  `schemaResponseFormat`) → rooms minted with letters + observed
  `x_norm/y_norm` (+ `key`/`keyTreasure`/`targetLevel` carried over) and
  declared-graph corridors. The sidecar carries the brief's entry
  designation under the SAME rule as classic's `entryRoomId`
  (`labels[entryRoomIndex]` at the sidecar construction site, mirroring the
  layout step's `roomIds[entryRoomIndex]` — never a second rule): the entry
  room is flagged `isEntry` so the prompt draws it as the ingress, the
  stored room keeps `spawn` on the entry room, and the stored `path` leads
  with it. NO aspect normalization (cropping could cut
  plaques). ANY locate failure prunes the unattached candidate via
  `deleteUnreferencedImages` first — the failed step persists NOTHING
  (a missing entry plaque fails loud under the same miss policy, naming
  its letter like any other).
- `effectiveEncounterLayout` also reads the vision-map step; finalize
  selects the single map by contract (`readVisionMapImageId`); the
  classic-only affordances (`regenerateEncounterLayout`,
  `regenerateEncounterCandidates`, `pickEncounterMap`) refuse vision runs
  loud with the retry-vision-map pointer.
- Point-based consumers: `placeMonsters` + `veilsFromSpawnClusters` deal
  from deterministic Chebyshev-ring cells around each room's observed
  point (`pointRoomCells`, shared helper); `seedBattleFromEncounter`
  stages the party AT the spawn room's observed point (missing point ⇒
  loud seed failure) — the spawn room IS the brief's entry room, so the
  entry coordinate doubles as party ingress (no separate entry-spawn
  handling: spawn resolution already reads the spawn room's point
  uniformly); battle-surface key markers sit on the observed
  point; anything needing polygons (`renderSchematic`,
  `veilsFromRooms`, `stagingBlockRect`) throws loud on geometry-less
  rooms. The layout preview marks observed plaques instead of rects.
- Tests: `tests/llm/encounterVisionMap.test.ts` (18: helpers, entry-as-
  entrance prompt clause (entry letter named, non-entry rooms clean, no
  clause without a designation, two entrances throw), happy path,
  non-zero entryRoomIndex control (prompt + spawn + entry-first path +
  ingress at that room's plaque), miss⇒re-ask⇒found, still-missing loud
  fail with nothing persisted, missing-ENTRY loud fail with nothing
  persisted, override-beats-setting, singles-ignore,
  repopulate-untouched, observed-point seeding), `tests/llm/encounterVisionSteering.test.ts` (5: classic
  default, steered regen both ways + never-persisted default, setting
  default, singles ignore), the queue-uses-setting case in
  `tests/features/encounter-map-queue.test.ts`, the steering control in
  `tests/features/editor-surfaces.test.tsx`.

## Module generation integration (the unattended path)

- The module entity workflow (08 §M4-C) gains `encounter` as a stub kind:
  `ENTITY_KINDS` extends with `'encounter'`, the stub persona map gains an
  Encounter-Smith slug for modules, and the entity panel offers encounter
  generation like the other kinds.
- A batch queue (the `entity-image-queue` pattern: shared progress dock, one
  job per encounter, failures loud per job, queue continues) runs the
  generator in **auto** for every module-owned encounter lacking a layout —
  triggered from the module view ("Generate encounter maps" — UNCHANGED, the
  explicit manual batch), the forge's post-pass, and now AUTOMATICALLY for
  every freshly created encounter (post-run-extras: persona panel, entity
  batch, module post-generation). This is the D2 unattended contract; no
  pick pause. Campaign-level encounters enqueue with a null `moduleId` and
  keep the D2 unattended semantics unchanged.
- **No-double-work guard** (owner-ratified): an encounter that already
  carries its map (layout + map image) or has a queued/active map job is
  NEVER re-enqueued by the automation path (`encounterNeedsMap` /
  `isEncounterMapPending` — the queue's processJob re-checks as a second
  belt). Regenerating an existing map stays an EXPLICIT user action
  (regeneration replaces room keys — the ratified consequence).
- **Mob portraits on the unattended path (owner report, docs/17 row 96):** the
  module sweep's portrait step runs the encounter editor's OWN two batch
  entries per module-owned encounter with un-imaged roster creatures —
  `enqueueMobPortraits` (chunk-backed kinds: `rulebook` citations and
  `npc-ref` rows to a mob artifact, sharing the one bestiary portrait) then
  `enqueueInventedCreaturePortraits` (every other participant: an uncited
  mob's on-demand creature, a materialized `npc-ref` monster, a named NPC
  standing in the roster) — and it decides WHICH encounters those are with the
  queue's own routing/art rules
  (`features/campaign/mob-portrait-participants.encounterNeedsMobPortraitWork`),
  never with a rulebook-only reading of `source.type`, and the switch it
  obeys is the RUN's own (`target ?? module`, like battlemaps and both kind
  lists) so an explicit target's confirmation and its work cannot disagree.
  Additive in both
  lanes, one try per encounter (a failure is that encounter's loud reason and
  never stops the sweep), and the same predicate is what "Resume automatic
  module creation" and the entity sidebar's "Generate everything" list — so a
  roster of materialized core creatures is offered, enqueued and illustrated
  by the SAME rule. The configured toggle is `autoGenerateMobImages`
  (docs/08 §Post-generation automation); the editor's own one-click batch is
  unchanged.
- Encounters produced here are module-owned (`moduleId`, M6-B semantics) and
  battle-ready via the module view's Run battle.

## What an encounter IS (retired: the conflict-kind vocabulary)

**Retired 2026-09 (owner decision, docs/17 row 72).** The `conflictKind` enum
(combat / hazard / chase / social / puzzle / exploration), the encounter `wants`
pair and the declared-mix gate that consumed them are GONE from the module
pipeline: the gate had no consumer beyond the declarations it demanded, so it
measured the planner's wording rather than the module (08 §M4-B-1). There is no
shared scene-kind enum any more — `ENCOUNTER_CONFLICT_KINDS` no longer exists —
and this generator builds exactly one thing, so it needs no such vocabulary to
aim at.

**An encounter is a FIGHT.** It is the scene the party resolves in initiative,
on a battle map, against a monster roster with images — precisely what this
generator produces (brief → layout → map → mob portraits). Anything that is not
a fight belongs to the module as an `event` instead: a negotiation, a hazard, a
puzzle, an investigation, a ritual, a chase. An event gets an illustration and
nothing else — **no battle map, no monsters, no roster** — and it never enters
this pipeline: `post-generation.ts` filters map and mob-portrait targets by
`kind === 'encounter'` on the artifact, so a non-fight scene cannot be handed a
map or a roster by the automation.

What that means for the seam:
- The module planner declares a scene as `kind: 'encounter'` only when a fight
  happens, and the normalization prompt classifies by what the party DOES in the
  scene, never by how dangerous it sounds (08 §M4-B-1).
- Danger, risk and player agency are NOT the discriminator and are NOT lost: a
  hazardous crossing or a tense negotiation is as dangerous as it ever was, it
  is simply written as an `event`.
- Conflict quality ("is the situation actually contested") is prompt discipline
  in the module prompts, never a check here: a check over prose would need a
  classifier guessing at a gate, which this repo forbids.

## Cost & latency (per encounter, indicative)

Manual run: 1–2 chat calls (brief, optional repair) + 2 image calls
(schematic stylize candidates). Auto/module batch: 1 chat + 1 image call per
encounter. Image calls ride the existing 5-minute headers timeout. Progress
docks on the shared `useProgressStore` job for batch, on run steps for
interactive runs.

## Entrance/exit spawn zones (2026-09-05; 4b6db55, 97f8252, aea57a5)

A generated layout carries **one entrance zone** on the spawn room: the gap
in the outer wall the party enters through. The zone exists in four layers,
all anchored to the layout (D7):

- **Geometry** (`LayoutRoom.entrance` — C1, `4b6db55`): the entrance cell +
  outward side, placed deterministically — the outer-wall cell farthest from
  the room's own corridor doors (Manhattan min; ties → nearest grid edge →
  (y, x) → fixed north/west/east/south side order); omitted when no outer
  wall is reachable. The schema rejects entrance-carrying non-spawn rooms,
  cells outside the room union, sides that do not face the outer wall, and
  openings into corridors. `observed {x, y}` (0..1, positions only) is the
  ONLY pixel-derived field — the sanctioned stagingPoint-style exception to
  D7, absorbed at pick review.
- **Marker vocabulary** (schematic + detector, C1/C2): the schematic paints
  the wall gap, a landing pad, and one solid neon triangle (tip 0.30·cellPx
  inward, base 0.60·cellPx ⇒ measured blob circularity ≈ 0.73 at stylize
  scale; room discs ≈ 1.0). The hue is `entranceMarkerConfig(rooms.length)`
  = the canonical palette entry one past the room count — rooms consume
  `CANONICAL_ROOM_MARKERS` strictly in order, so the entrance hue can never
  collide with a room hue. At 10 rooms the palette is exhausted: no marker
  is drawn or detected and detection is skipped (the layout geometry stays
  authoritative; placement is unchanged). The triangle never gets a disc or
  a plaque.
- **Prompt & detection wiring** (C2, `97f8252`): the stylize prompt declares
  the entrance gap + triangle and the keep-structure line names the gap;
  detection pairs triangle-shaped blobs only with the entrance target
  (`MarkerTarget.shape: 'triangle'`, circularity window [0.45, 0.8],
  shape-exact tiebreak in the greedy assignment so a disc target can never
  steal the triangle blob at equal hue distance). ADJUDICATED: entrance-
  carrying layouts KEEP the packed geometry in every candidate — corridor +
  room rects are never replaced by marker-derived staging layouts; only
  `observed` is absorbed. No detected triangle ⇒ no candidate ⇒ finalize
  uses the packed layout verbatim. Layouts WITHOUT an entrance keep
  today's marker-staging candidate path unchanged (their own pins).
- **Verify + seed** (C2/C3): seeding anchors the party at the entrance (see
  below) and the table surface renders an emerald cell overlay with an inward
  triangle. The verify half of this arc (the coarse-drift exclusion for
  door/entrance cells, the `arena-verdict` entrance question) died with the
  verify step (D14) — the entrance survives as geometry, prompt clause and
  seed anchor.

### Seeding extension (C3, `aea57a5`)

`seedBattleFromEncounter` anchors the staging ground at the entrance:
`stagingBlockRect` — the spawn room's `mobsRect` slid along the entrance
axis until it hugs the entrance wall while staying inside the room union —
and stamps `board.entrance` (normalized cell center + side) for the
BattleSurface overlay. Retrofitted at seed time — **no migration**: old
battle rows parse with `entrance: null`, and re-seeding any encounter whose
layout lacks an entrance reproduces the pre-entrance behavior byte-identical
(mobsRect ground, no stamp).

### D4 exception — spawn-room fog with an entrance (2026-09-05, adjudicated; implemented in `aea57a5`; SUPERSEDED by group veils)

> **D4 amendment:** when the encounter layout carries an entrance, seed
> skips the spawn room's fog veil.
>
> Rationale, verbatim from the adjudication: *"the party is standing in the
> spawn room when the battle opens — the entrance is the way in, so the
> room they occupy cannot begin veiled."* The GM reveals the remaining
> rooms as before.

SUPERSEDED (group-veil policy, owner-ratified): every monster spawn group is
covered by default, INCLUDING the spawn room's — the exemption is gone, so
single-room sites seed their spawn-group veils instead of zero. The party
still starts in the spawn room (staging is unchanged); its monsters simply
begin veiled. The passage above stays as history; D4 as amended is the rule.

Layouts without an entrance keep D4 exactly: one veil per spawn group,
each covering its group's `placeMonsters` cells plus the one-cell margin
(cover convention), corridors open.

### Exit (non-goal, name reserved)

The party's way OUT is intentionally not modeled in v1 — no exit marker, no
schema field, no prompt clause. The design is RESERVED, symmetric to the
entrance: one outer-wall cell per non-spawn room, a neon triangle pointing
OUT, detected with the same triangle gate, seeded as a `board.exit` overlay.
The entrance arc (C1 geometry → C2 prompt/detection → C3 seed) is the
template to follow when this is ratified.

## Dungeon preset (owner-ratified, 2026-09-07; cc2ad02 → d69455e)

The Dungeon preset (D10) is a **generation-time ×2 grid tier + brief bias**,
implemented in six bounded commits. It is deliberately NOT a battle-level
field: the board stays a pure function of the layout, and every D6
layout-anchored metric (veils, snapping, grid tracks, token size — the
cc2ad02 fix makes `TokenView` render `board.tokenSize * token.scale` so
rendered size ≡ coverage size) derives from `mapLayout.cols/rows`, so the
halved cell renders identically on the schematic, the stylized map, and the
live table with no new surface code. The schematic cap scales with the tier
(`schematicCellPx`, 45eed86: `min(96, 4096/gridW, 4096/gridH)` — 48×36
renders at 85px/cell, inside the 4096px map cap).

- **Grid tier** (`GRID_BY_ASPECT_DUNGEON`, 6302804): 4:3 → 48×36,
  16:9 → 56×32, 1:1 → 40×40 — exactly twice the base tier per aspect, FIXED
  (room-count independent; a 1-room dungeon gets the same 48×36 that a
  10-room complex gets). Room size classes are unchanged: same cells per
  room, more cells per map. All tiers stay inside the layout schema's 60 max.
  Deriving the preset from the layout dimensions would be ambiguous (a
  10-room standard 4:3 pack reaches the same 48×36), so the preset is
  **persisted**, not inferred.
- **Persistence** (6302804): `preset: 'standard' | 'dungeon'` on the
  encounter artifact data, `encounterPreset` on the run row (aspect
  pattern), `encounterPreset` in Settings. Dexie **v15** backfills the
  additive defaults (`'standard'` / `null` / `'standard'` — the M5-C
  `mapImageId` pattern).
- **Run-engine threading** (4bf06b6; amended by the locationKind arc): the
  preset resolves **explicit per-run choice → the encounter's locationKind →
  Settings** (`resolveEncounterPreset`); `startRun` persists only an EXPLICIT
  choice (null = Auto) for pauses/resumes;
  the brief step stamps it next to `aspect` and, for Dungeon, adds a soft
  contract clause ("connected dungeon complex of 4–8 rooms joined by
  corridors; the entry room is the party's way in") — the geometry itself
  stays deterministic packer output. `runEncounterLayout` packs on the
  preset's tier, the stylize staging rebuild re-tiers identically, and
  finalize writes the run's preset into the artifact data in BOTH branches
  (fresh create and regenerate — the run is authoritative for the map it
  just produced; an in-place Smith content fill keeps the target's preset —
  it never re-tiers the map on file). The unattended queue passes NO explicit
  choice: the job's preset resolves from the encounter's own `locationKind`,
  with `settings.encounterPreset` backstopping unclassified rows.
- **UI** (d69455e; amended, moved to Settings): the Settings page's
  Encounter-maps Preset select beside Map aspect defaults to **Auto**; Standard/Dungeon force the
  tier. A **regenerate keeps the target encounter's own preset** — the
  panel passes the target's preset over the Settings value, so an existing
  map is never silently re-tiered (stated in the regenerate-target copy:
  "keeping its map preset"); the images section captions a dungeon map
  "Dungeon layout on file".

## D10 amendment — per-encounter locationKind (owner-ratified)

The Dungeon preset originally resolved from one global Settings value: an
unattended queue run could only produce dungeons when the campaign opted in
for EVERY map, and an encounter's actual setting (a cellar vs. a river
crossing) played no role. The amendment lets encounters classify themselves:

- **Classification rides the EXISTING draft call** — no extra LLM call, no
  verification pass. The Encounter Smith's draft contract gains a bounded
  `locationKind: 'dungeon' | 'building' | 'wilderness' | 'other'`
  (case-insensitive coercion, `'other'` default when the model declines);
  the Cartographer's brief already stages `environment` ('dungeon' |
  'outdoor') and it maps onto the artifact as dungeon/wilderness.
- **Persistence is additive**: `locationKind` on the encounter artifact data
  with the `'other'` zod default — legacy rows parse without a Dexie bump
  (the M5-C `mapImageId` pattern). The encounter editor shows a small
  owner-correctable selector beside the map fields.
- **No-double-work guard**: the automatic battlemap path never re-enqueues
  a mapped encounter or an already-queued/active map job; regenerating an
  existing map stays explicit (and replaces room keys — the ratified
  consequence).
- **Resolution order** (`resolveEncounterPreset`): explicit per-run choice
  (the run row's persisted preset; Auto writes null) → the encounter's own
  `locationKind` ('dungeon' → Dungeon tier; 'building'/'wilderness' →
  Standard) → the Settings fallback for unclassified rows, with 'standard'
  as the terminal default. The Settings page's Encounter-maps select writes Settings (null =
  Auto, the default); a fresh panel run passes NO preset so the chain — not
  a coerced Settings value — decides; a regenerate keeps the target's own
  persisted preset (D10's "never silently re-tiered" rule, unchanged).
## Site shape, per-room challenge and the path (owner-ratified, 2026-09-08)

The arc ratified in this section makes the encounter's SHAPE a first-class,
owner-visible choice, gives every dungeon room its own challenge target with
an asymmetric budget loop, stores the play path explicitly, and deletes the
marker path entirely. Commits: schema+migration → generation → surface →
editor → deletion → docs.

### D11 — siteShape (single / complex)

- **Data**: `encounterDataSchema.siteShape = z.enum(['single','complex']).default('single')`
  — additive, no Dexie bump for the field itself (parse-on-read materializes
  the default). One derivation, `normalizeEncounterShapeData` (`src/domain/
  artifact.ts`), is shared by parse-on-read, the v17 backfill and backup/
  revision validation: layout null ⇒ 'single' (uploaded maps stay
  byte-identical in behavior); `rooms.length <= 1` ⇒ 'single' (stray
  corridors cleared — a one-room arena has none); `rooms.length > 1` ⇒
  'complex' with `path` backfilled. A persisted value always wins.
- **Editor labels**: **"Encounter" (single)** / **"Dungeon" (complex)**.
  The selector sits beside Location kind; the option the battlemap on file
  cannot hold is DISABLED with the reason in the hint — the owner is never
  silently re-shaped.
- **Generation dichotomy**: the brief must commit — single = exactly ONE
  room (no corridors), complex = 4–10 rooms. A 2–3-room reply is a
  repairable brief-boundary issue (`rooms: an encounter is either a single
  arena (exactly 1 room) or a dungeon complex (4–10 rooms) — …`). Finalize
  stamps `siteShape` from the produced layout in BOTH branches (fresh
  create and map regenerate): the target's old shape may not match the
  fresh layout's room count.
- **Seeding**: every monster spawn group is covered by default, INCLUDING the
  spawn room's — the group-veil policy ends the spawn-room exemption (which
  the D4 entrance-only exemption above, and then the D11 never-seed rule,
  once granted): a SINGLE site seeds its spawn groups' veils (no more
  zero-veil singles); a COMPLEX veils every group on every room for
  sequential play along the path. Start position on a single site is the
  entrance CELL when the layout carries one, else the room's mobsRect
  center; complexes keep the entrance-hugging staging block. The room's
  first group keeps `id = room.id` so the Path rail still resolves per room.

### D12 — the asymmetric per-room budget loop (`src/llm/roomBudget.ts`)

- **Contract**: every room may carry `targetLevel` (absentable in the LLM
  brief, persisted on the packed room; omitted rooms default to the
  encounter's parsed levelHint via `parseRosterTargetLevel`). The prompt
  clause (`roomBudgetGuidanceFor`) teaches: "every room must ALONE challenge
  the party — a complex is a sequence of fights, not one fight spread thin."
- **Check** (`checkRoomBudget`): sum the assigned creatures' levels × count
  (the SAME parser that orders the bestiary roster, `parseLevelSort` — the
  one level parser in the codebase; fractional levels count fractionally;
  `'—'` CR-less summons count 0; a missing/unreadable level makes the room
  **loud-unverified**, naming the creatures — never silently skipped).
- **The band — dnd5e (our own documented approximation, verbatim rationale):
  the DMG encounter-building tables are not licensable, so Campaigner ships
  its OWN coarse ladder in our own words — nothing is quoted, paraphrased or
  restated numerically from it. A room tuned for target level T is over
  budget when its assigned creatures' levels (CR) sum to MORE than T + 2
  (`ROOM_BUDGET_OVER_MARGIN`) — roughly a hard single fight's worth of
  creature levels. The band is UPPER-only by itself; the lower side is the
  fill-grade expectation below — for SINGLE arenas there is still NO lower
  bound (a quiet room ships silently, per the owner's asymmetric call), and
  complexes derive one from `fillGrade` (the amendment below). This mirrors
  the treasure-ladder licensing stance (docs/12 §13.2/§14), and this
  document IS the shipped approximation.**
- **pf2e — verbatim from retrieved chunks when present, else loud advisory**:
  creature budgets are Paizo's (GM Core). Campaigner ships NO numeric pf2e
  budget; the prompt directs the model to the retrieved GM Core excerpts
  VERBATIM when they are present. Whether an excerpt actually surfaced is
  not deterministically decidable from the retrieval output, so the
  deterministic check is replaced by an ALWAYS-ON advisory
  (`PF2E_BUDGET_ADVISORY`) persisted on the run and the artifact —
  over-loud by design, never a fabricated paraphrase (AGENTS rule 1).
- **The loop**: first parse over-budget ⇒ each over room's target is lowered
  a step (floor 1) in the ISSUE TEXT and the brief's EXISTING single repair
  turn fires quoting it (`"targetLevel": N and field weaker or fewer
  creatures so it fits its band`). The post-repair pass is FINAL: still over
  ⇒ the target is lowered a step again deterministically (floor 1), the
  final value persists on the room, and the LOUD advisory joins the step
  output (`budgetAdvisory`) and the artifact (`data.budgetAdvisory`). Never
  a failed run; the editor shows the advisory and the owner can correct any
  target.
- **In-place Smith content fill — reconciliation** (`reconcileRoomAssignments`,
  exact rules): the fill rewrites `data.monsters` while the layout stays
  byte-identical, so `room.monsterIndexes` would dangle/shift/skip against
  the new roster. Deterministic re-partition: (1) **preserve by name-match**
  — every existing assignment whose creature name (trim/case-insensitive)
  still exists is kept on its room, remapped to the new index, first room to
  claim a name wins; (2) **append round-robin** — unclaimed new entries, in
  roster order, cycle rooms[0..n-1] (a single-site layout therefore places
  everything in its one room); (3) **drop the gone**. The same budget check
  then runs — no repair turn exists at finalize, so over rooms get the
  deterministic tail only (step-down + advisory). Room CAPACITY is not
  re-derived; an overfull room still fails loudly at seed (layout
  validation). **Amended (fill-grade arc): step (2) is now nearest-band
  packing when per-room expectations exist — see the amendment below.**

### D12 amendment — fillGrade stocking (owner-ratified; per-room lower bound for complexes)

Owner-observed root cause: multi-room dungeons shipped ~one-encounter-empty —
the Smith sizes a ONE-fight roster (it never sees rooms), the auto-map queue
pinned that roster VERBATIM into the Cartographer's 4–10-room brief,
`checkRoomBudget` was upper-bound-only (zero-creature rooms read 'ok'), the
in-place fill round-robined the regenerated roster one entry per room, and a
digit-free `levelHint` left rooms 'unverified' (advisory-only). The arc fixes
the chain at five seams; the "no lower bound" call of D12 is AMENDED for
complexes only — a single arena keeps "a quiet room is a feature" byte-identical.

- **The field**: `encounterDataSchema.fillGrade` — additive optional integer
  0–100, NO Dexie bump (parse-on-read keeps legacy rows absent = undrawn).
  Meaning: the share of a STANDARD SINGLE-ENCOUNTER threat budget each room
  of a complex should carry. **Draw-once**: `drawFillGrade()` (pure, seeded-RNG
  injectable) draws from a documented distribution — ~70% of draws land in
  the 55–90 center, ~10% light (45–55), ~10% breather (30–45), ~10% spike
  (90–100); no draw plans a room near zero. Invoked only when a complex
  layout first materializes with the field ABSENT: the run's brief step draws
  a candidate (so the prompt can carry real numbers and the expansion cap)
  and the finalize STAMPS it — a fresh Cartographer birth, a legacy row's
  first full regeneration, or a repopulation backfill (`target grade ??
  brief stamp ?? draw` — one draw per run at most, a legacy complex with
  neither draws NOW so the budget check runs against a real expectation). A value on the
  row — owner-set or an earlier draw — is NEVER redrawn (the mapMode
  precedence); a single-arena outcome discards the draw; the editor shows a
  complex-only "Fill grade" number input next to Location kind (empty =
  drawn once; an owner value always wins).
- **The expectation**: `expectedRoomThreat(fillGrade, targetLevel, system)`
  (`src/llm/roomBudget.ts`, pure) — a room at target level T expects
  `fillGrade/100 × (T + 2)` creature-levels (the SAME band constants the
  'over' verdict uses, so the expectation can never exceed the band) plus an
  approximate mob count against the reference creature (roughly half the
  room's target level; a full band ≈ 2–4 creatures). pf2e returns null — the
  numbers are our dnd5e-family approximation and applying them to Paizo's
  budgets would fabricate licensed numbers (docs/12 §13.2/§14 stance); pf2e
  complexes keep the always-on advisory and the verbatim roster pin.
- **The lower verdicts** (`checkRoomBudget` gains `complex`/`fillGrade`/
  `system`): a complex room with ZERO creature instances is the **'empty'**
  verdict — a REPAIRABLE issue on fresh complex briefs (it joins the
  brief's EXISTING single repair turn exactly like an 'over' room); a
  complex room summing to less than `expected − ROOM_BUDGET_UNDER_MARGIN`
  (1 creature-level of slack, documented) is the **'under'** verdict —
  advisory-only. Both produce LOUD `budgetAdvisory` entries naming the room
  and its expected-vs-shipped ("shipped 0, expected ~4.9 creature-levels
  (≈2 creatures)"). No expectation ⇒ no lower verdict (no fillGrade yet,
  fillGrade 0 = owner-sanctioned empty room, pf2e, or a single arena).
- **targetLevel REQUIRED for complexes**: the brief contract's superRefine —
  a 4–10-room brief where any room omits `targetLevel` is a named schema
  issue that rides the existing one-repair turn, then rejects loudly (a
  digit-free levelHint can no longer leave rooms 'unverified'). Single
  arenas stay optional; the artifact-data read path keeps the hint-stamp
  fallback for legacy rows. The schema check is bounded to valid complex
  shapes (4–10 rooms) so a 2–3-room reply still fails with the D11
  site-shape message.
- **Roster sizing at the real seam**: the fresh Cartographer brief prompt
  now says "a complex of N rooms needs roughly one fight per room — size the
  roster for N fights", carries the per-room stocking numbers
  (`fillGradeStockingFor` — null for pf2e or a digit-free level, never an
  invented number), and the qualitative "each room must ALONE challenge the
  party" clause stays verbatim. **MAP-QUEUE PATH (the dominant flow)**: a
  complex brief may EXPAND the pinned roster — the target's entries stay the
  first N byte-identical (same order/names/counts/treasure; their persisted
  stat sources, mob artifacts and content identity survive untouched), and
  appended entries (each citing `sourceChunkIndex`/`sourceName`/inline
  `statBlock` — checked like fresh citations) stock the rooms the pin would
  have left empty. Bounded: the whole complex may total at most the SUM of
  its rooms' expected shares + `ROOM_BUDGET_OVER_MARGIN` — an over-cap
  roster is a repairable issue, never a silent accept. The verbatim pin is
  byte-identical for single arenas and pf2e. The merged roster persists at
  map finalize (the appended entries materialize through the SAME
  source-resolution birth path as a fresh Cartographer encounter).
  **AMENDED (shape-gated restock, owner-directed): the stocking clauses and
  the expansion gate key on the regeneration TARGET'S ACTUAL SHAPE
  (`encounterDataIsComplex` — the parse-normalized `siteShape`, the ONE D11
  shape derivation), not on the remembered `preset`.** The battlemap
  "Regenerate" action passes the artifact's OWN persisted `data.preset` as
  the explicit per-run choice (D10 explicit-wins stands untouched; the
  preset keeps driving the grid tier and the preset prose), so a legacy
  complex row whose remembered preset is 'standard' used to brief a
  one-arena map with NO stocking clauses at all — the shape now carries the
  contract. For a complex-shaped target the append clause is a DIRECTIVE —
  the same three-part structure (verbatim prefix → source-cited appended
  entries → cap = Σ room expectations + margin), but the model MUST append
  to reach one fight per room; the permissive "MAY" wording remains for
  non-complex targets on a dungeon preset (their brief stays byte-identical,
  "a quiet room is a feature" included). The evaluate gate reads the SAME
  authorization flag the prompt rendered (dungeon preset OR complex shape,
  band systems only), so a reply that grows rooms on an unauthorized run
  keeps the exact verbatim pin — it is never repaired against a source
  contract the prompt never stated. pf2e keeps the byte-identical verbatim
  pin (no cap exists to bound an append, so no append clause renders).
  **AMENDED (D18 two-button regeneration, owner-directed): the old content
  "Regenerate with AI" (the Encounter Smith one-fight fill) NEVER restocked
  — and now it no longer exists as a standalone button. Restocking is
  REPOPULATE (roster-only Cartographer pass: the stocking clauses keyed on
  the target's actual shape, brief partition mapped by index onto the
  preserved rooms, 'empty'/'under' LOUD) and REGENERATE EVERYTHING (fresh
  full run). Only these two automatic actions re-size a roster against the
  fill grade. The editor's fill-grade helper and the two-button copy say
  so.**
  **AMENDED (first generation stocks like regeneration, owner-directed):
  a never-mapped target (`layout` null — the Smith stub's one-fight roster,
  always single-shape with row preset `'standard'` from the forge) briefs
  like a fresh regeneration whenever the stocking contract authorizes
  (dungeon preset or complex shape, band systems): NO verbatim pin — the
  MUST-style fresh-population clause with per-room numbers and cap renders
  instead of the permissive MAY — and the evaluate gate engages the
  `freshCapped` cap on complex replies. A 1-room reply on such a target is
  a repairable shape issue (the old single-room escape shipped one fight
  clean through the no-lower-verdicts single path). Finalize persists the
  whole brief roster fully materialized (the `freshPopulation` brief-step
  marker), never prefix-merged under the stub's entries. A never-mapped
  single (standard preset, single shape) keeps the verbatim pin
  byte-identical, and pf2e keeps its verbatim pin (no cap to bound an
  append). The fixed cast rides a threaded must-appear section in the
  unpinned brief (the map brief never carried the summaries) — the
  Cartographer re-adds fixed-cast NPCs by exact name with stats as-is via
  the inline-statblock path. Dungeon-intent arrives through the Smith
  draft's `locationKind` (model-classified per the draft guidance, default
  `'other'`) or the Settings encounter-preset default — the documented
  lever when the forge leaves a row unclassified; no forge changes in this
  arc.**
- **Reconcile packing (D12 semantics change)**: `reconcileRoomAssignments`
  step (2) now packs unclaimed entries by NEAREST-BAND FIT when per-room
  expectations exist — biggest-threat-first, each entry into the room whose
  remaining headroom it brings nearest its band (`min |expected − shipped −
  threat|`, ties to the lowest room index), preferring rooms still UNDER
  their expectation so a fitted room is never topped up while another waits
  for its fight; only when every room is at/over its expectation may an
  entry overflow the least-wrong room. The old round-robin remains the
  documented fallback when expectations are absent (pf2e, pre-expectation
  callers). A room left EMPTY by packing is a legitimate outcome — the
  budget loop reports it as the loud 'empty' verdict, never silently.
- **LEGACY_COMPLEX_BUDGET_NOTE** (the v17 migration note on legacy complex
  rows) now says the next map generation draws the dungeon's fill grade and
  re-checks every room against it.

### D13 — the stored path

`encounterLayoutSchema.path: z.array(z.uuid()).optional()` + superRefine: a
permutation of the room ids. `packAttempt` captures the BRIEF's room order
before its packing rotation and stores it entry-room-first (`spawnFirstPath`),
so **first path room = spawn room** and the play order survives repacking.
The Path rail on the battle surface (GM view, complex sites) lists rooms in
path order with the revealed frontier highlighted and a **"Reveal next
room"** button that lifts the next veiled path room's veil — a plain veil
removal, exactly a manual GM lift. It is an ADVISORY AID: no locks, no
initiative resets, and key markers/badges now sit at each room's mobsRect
CENTER (derived from the live layout — the old `stagingPoint ?? (0.5, 0.5)`
fallback stamped dead-center-of-board badges on every non-staging layout).

### Structured level context — the part's level and a party of 4 (owner-directed)

Owner rule, verbatim: "Each module part has an explicite level and always
assume a party of 4, thats what all modules do normally." Neither the Smith
draft nor the Cartographer brief received structured level data before this
arc — no party level, no party size, no level band; the level flowed only as
free text (`levelHint` / brief prose via `parseRosterTargetLevel`). Owner
correction: there is NO band math — a part's level is EXACT (a "2–4 module"
is a 2-part, a 3-part and a 4-part); the low/high-end question does not
apply.

- **Party size** is the constant 4 — `PARTY_SIZE` (`src/llm/roomBudget.ts`,
  beside the budget derivation): the one named constant both prompts use,
  nobody re-derives it.
- **Party level** is the referencing part's level: at brief time the
  encounter's `[[Name]]` mention is located in the module text → the
  containing part → its `levelBand`, taken as the EXACT level. ONE shared
  pure helper, `partLevelForMention` (`src/llm/roomBudget.ts` — no second
  implementation): first part in plan order carrying the mention wins
  (deterministic); a pathological multi-level band string on one part parses
  to its low end — never a loud failure, never a silent break of
  generation; a premise-only mention carries no levelBand and does not
  count.
- **Both prompts** carry the one structured line `Party of 4 adventurers at
  level N.` (`partyLevelLine`): the Smith draft via `buildEntityBrief`
  (`src/features/modules/persona-request.ts` — encounter AND npc stubs
  (`stubKindCarriesPartyLevel`: the npc kind covers NPCs and monsters alike,
  both `npc` rows), resolved in `entity-batch.ts` at the same position
  `surroundingParagraphs` excerpts) and the Cartographer brief via
  `runEncounterBrief` (module lookup through the target's `moduleId`, same
  helper).
- **Budgets key off N**: `fillGradeStockingFor`'s `promptLevel` prefers the
  structured level; the free-text `parseRosterTargetLevel(target?.data.
  levelHint ?? input.brief)` chain STAYS as the fallback underneath
  (levelHint-only regenerations behave exactly as today).
- **Edges**: no mention found in the module text (or no owning module) →
  today's behavior byte-identical (structured line absent, fallback chain as
  now). No new failure modes, no new loud paths, no Dexie/schema changes
  (the association is derived at brief time, never stored).

### Fixed cast — the encounter pins its drafted scene members (owner-directed)

Owner case: part prose established an undead NPC (the Smith gave it stats —
the prose itself carried none), but the encounter that was supposed to
feature it shipped only generic undeads; on top, the NPC's stats were never
encounter-weighted (a level-6 NPC in a level-1 module). Owner decisions
(pinned, not relitigated): NPCs detail BEFORE encounters (batch order is
pinned, never "usually"); the prose writer may define constant participants
per encounter with the rest generated (the end boss fight against Halvar
the giant never fields a generic giant); the prose names ONLY those
constants, the rest stays automated.

- **NPC drafts carry the structured level** (ledger 56 extended):
  `stubKindCarriesPartyLevel` (`src/features/modules/persona-request.ts`)
  passes `partLevelForMention` for npc stubs exactly like encounter stubs —
  this kills level-6-in-level-1 at the source. Deliberate mismatches stay
  legal: the brief states levels honestly, the finalize advisories flag them.
- **Encounters detail last**: `orderedKinds`
  (`src/features/modules/post-generation.ts`) runs the post-generation
  batches in `ENTITY_KINDS` order — npc first, encounter last — so an
  encounter batch's brief-time snapshot (`listArtifactsByCampaign`, re-read
  fresh in `runEntityBatch`) already holds every NPC/monster an earlier
  batch drafted. Pinned by test against reordering; no other orchestration
  changes.
- **The brief carries the fixed cast**: per encounter target,
  `fixedCastForEncounter` (`src/llm/roomBudget.ts`, pure) collects the
  drafted npc-kind artifacts whose `[[Name]]` mentions share the encounter's
  scene context (the same `surroundingParagraphs` position the brief
  excerpts; first mention wins the order; the encounter's own name never
  counts), and `buildEntityBrief` renders them as FIXED CAST with the
  must-appear instruction — exact names, stats used as-is via the
  inline-statblock path (never substituted with generic equivalents, and
  finalize's one-entity-per-name reuse links the existing row instead of
  duplicating it); the pipeline designs the REST of the roster as today. An
  empty cast renders nothing — briefs without one stay byte-identical.
- **No Dexie/schema changes**: the cast is brief-time derivation from
  in-batch results + module text, never stored.
- **Finalize checks the cast landed**: after the roster finalizes
  (`runFinalize`, Smith paths only — fresh creation and the in-place fill),
  two advisories ride the existing advisory block (`data.budgetAdvisory` +
  the step notice, the 'under' precedent) — cast-coverage (a fixed-cast name
  absent from the roster: the prose said they fight, the roster does not)
  and level-mismatch (a FIELDed cast member more than one band step off the
  party level; absent members get the coverage advisory instead of this
  one). Both loud, never blocking; unjudgeable states (no owning module, no
  scene mention, empty cast, no party level, unreadable cast level) yield
  nothing, never a failure.

### The scene is the truth — the assertion rule (owner-directed, docs/17 row 89)

**The owner's report, verbatim:** *"The encounter prose generator actually did
a good job here, and the mob generator was not too bad either. The problem is
the disconnect. The prose actually holds truth, but it might not always be
sufficient. If the prose is vague then the mob generator can improvise, if its
specific like here, it must follow that lead."* His German module staged the
fight concretely — two of the missing lumberjacks risen as undead, axes still
in their hands, motionless on a narrow boggy footbridge over a knee-deep icy
stream in a pine forest — and the roster came back a sea hag, two ghoul
soldiers and two skeletal guards: five creatures, one swamp hag, nothing of the
lumberjacks, their axes or their stillness.

**The diagnosis (dispatcher-verified).** The scene text *did* reach the
encounter prompt (`features/modules/entity-batch.ts` builds the brief with
`surroundingParagraphs` + premise + party level + fixed cast, and that brief is
the `Task:` line of the draft). But it arrived framed as **"Where it is
mentioned:"** — CONTEXT, not SPECIFICATION — while the encounter designer was
told its job is to design a level-appropriate, citable, environment-plausible
roster. So the swamp produced the hag and the undead produced ghouls and
skeletons, and **nothing obliged the roster to agree with the scene text**. The
only bridge that existed was the FIXED CAST (`roomBudget.fixedCastForEncounter`),
and it was empty: the scene named no participants — because the writer's own
contract clause (`PARTS_ENCOUNTER_CASTING`) demanded that the rank and file
*"stay anonymous and undescribed by name (no names, no counts), so the encounter
pipeline casts them."* The contract caused the vague opposition, and the vague
opposition unbound the pipeline.

**The rule, and why it is DIRECTIONAL rather than a threshold.** Everything the
scene text **ASSERTS** is binding on the encounter; everything it leaves **OPEN**
is the generator's to invent. It is deliberately NOT implemented as an "is the
prose specific enough?" judgement — that threshold is exactly the question a
model answers inconsistently and then rationalises after the fact. There is no
threshold anywhere in the mechanism: a stated creature is staged or declared, an
unstated one is free.

Four places carry it, each with a revert-proof test
(`tests/llm/sceneAuthority.test.ts`, plus the added cases in
`tests/features/persona-request.test.ts` and `tests/llm/fixedCast.test.ts`):

1. **The writer's contract clause** (`PARTS_ENCOUNTER_CASTING`,
   `src/llm/promptStyles.ts` — still ONE contract slot, rendered once per part
   in all three built-in styles). It now says the writer **states what the fight
   IS and where it happens** (the opposition's nature, roughly how many, what
   they carry, what they are doing; the place, its terrain and the conditions the
   party fights in), that **a stated count is binding**, that these are FICTION
   and not mechanics (no stat lines, no tactics rules, no map — the mechanics
   slot's boundary, restated), that a rank-and-file fighter gets **no personal
   name** (the one half of the old clause that survives, now about names only),
   and that the pipeline owns the CASTING and must not contradict the fiction
   while **silence is not a constraint**. The "no names, no counts" prohibition
   that produced the vague opposition is deleted.
2. **The encounter pipeline's own prompt section** (`SCENE_AUTHORITY_SECTION`,
   `src/llm/sceneAuthority.ts`) — CODE, not persona text: personas are
   user-editable stored rows, so a persona edit would never reach an app the
   owner already has. It renders in the Smith draft prompt (`runDraft`, for
   `kind === 'encounter'` only) and in the Cartographer brief prompt, where the
   roster and the map are designed together. Every other kind's draft prompt is
   byte-identical without it — pinned by an exact-bytes comparison.
3. **The brief's framing** (`buildEntityBrief`'s additive `encounterScene`
   parameter, set true only by the encounter path in `entity-batch.ts`): an
   encounter's surrounding text is labelled **"The scene this encounter must
   stage — whatever it states about the opposition and the place is FIXED, and
   the roster and the map must match it:"** instead of "Where it is mentioned:".
   Every non-encounter brief keeps the pre-rule bytes.
4. **The loud collision path** (below) — without it the rule would create
   exactly the silent substitution AGENTS 1 forbids.

**The map is bound by the same text.** The assertion rule names the roster AND
the map: whatever the scene states about the place — terrain, ground, weather,
the conditions the party fights in — must be what the encounter is fought on.
D17 is untouched and is what makes this work: a natural-site map is already
rebuilt from the brief's own prose (terrain + summary, no materials line, no
terrain bans), so an outdoor fight's map follows the scene text by construction,
and the Cartographer's `terrain` field and room descriptions carry it indoors.
No new map-side mechanism was added, and no prose-vs-map checker exists: the
declaration below is the model's own account, which is the honest bound of what
code can verify without a classifier (AGENTS 1/3).

**The loud collision path (mandatory, and the reason the encounter half is code
rather than persona text).** A creature the scene states may have no citable stat
source in this campaign's books. The old behaviour there was the nearest generic
equivalent — silently. Now:

- both roster-authoring contracts (`encounterDraftSchema` — the Smith draft —
  and `encounterGeneratorBriefSchema` — the Cartographer brief, `llm/schemas.ts`)
  gain an ADDITIVE, OPTIONAL `substitutions: [{ asserted, used, reason }]`
  defaulting to empty. ABSENT and NULL both read as "none declared", so a brief
  stored before this field existed parses and renders nothing (pinned);
- the prompt instructs that a stated assertion it cannot honour must either be
  built as a complete inline `statBlock` for exactly the creature described, or
  be recorded in that field — **never silently swapped**;
- the app SURFACES it through the existing advisory seam the fixed-cast checks
  use: `roomBudget.substitutionAdvisories` renders one line per declaration into
  the same `data.budgetAdvisory` block and step notice the GM already reads
  ("The module text for *X* states *two risen lumberjacks with axes* and the
  roster uses *two ghoul soldiers* instead. The encounter declared this
  substitution itself — reason: …"), at all four finalize seams (Smith fresh
  creation, Smith in-place fill, Cartographer full run, Cartographer roster-only
  repopulation);
- a `substitutions` value that is present but unreadable is a LOUD error, never
  a silently dropped declaration (`sceneAuthority.sceneSubstitutionsOf`).

**What is NOT in this arc** (named so the boundary is not re-derived): contract
VERSIONING (recording contract text per module so an existing module keeps its
old bytes), and any prose-vs-map contradiction checker beyond what the model
declares.

**The byte-identity consequence, stated plainly (owner-approved).** The contract
layer is CODE, not recorded data: changing a contract value re-renders the parts
prompt for **every** style, including modules that already exist and are
resumed. That is deliberate — coherence between the prose and the encounter it
produces beats frozen contract bytes — and it is not smuggled in: the style
TEMPLATE texts (Classic, Story, Freestyle) are unchanged, only the injected
value moved, and the fixtures that carry the composed bullet were updated by
hand (row 89 names them and says what their pin now means).

**Reversal recipe.** Restore the previous `PARTS_ENCOUNTER_CASTING` value in
`src/llm/promptStyles.ts` (one constant), delete the `SCENE_AUTHORITY_SECTION`
entry from the two prompt assemblers in `runEngine.ts`, drop the
`encounterScene` argument in `entity-batch.ts`, and remove `substitutions` from
the two schemas (the advisory call sites then read an absent field as `[]` and
render nothing). No migration, no stored-data rewrite, no schema version: every
piece is code plus optional fields no older row ever carried.

### Deletion record — the marker path dies entirely (owner: all pixel
read-back is unnecessary)

With D11's shape contract the marker machinery has no job left. Deleted in
full (each symbol verified consumer-free before deletion):

- The stylize prompt's disc-painting clauses (per-room "solid neon … disc +
  plaque" instructions) and the per-room marker instruction list.
- Room-disc detection + the staging-rebuild candidate branch in the run
  engine — with them, the two AGENTS-rule-1 violations that lived there:
  the SILENT packed-center fallback for undetected rooms and the SWALLOWED
  detection errors (`catch` + debugLog with no user surface).
- `layoutFromStagingMarkers` / `StagingRoomInput` / `StagingLayoutInput` /
  `adaptiveGridDimensions` (the room-count grid ladder — superseded by the
  fixed D10 tiers).
- `markerHue` / `markerColorName` / `stagingPoint` schema fields, and every
  `isStaging` validation escape (schema superRefine, `validateEncounterLayout`
  — overlap/border/connectivity checks are now UNCONDITIONAL — and the
  vision verify's fake 0.5-threshold staging branch).
- The editor marker overlay and the `entrance.observed` write-only field +
  triangle pixel detection. The schematic's PAINTED entrance triangle stays
  as decoration via `drawEntrance`, and the stylize prompt keeps only the
  preserve-clause for it ("keep … exactly as in the reference image").
- `candidateLayouts` plumbing: stylize output, verify and finalize all use
  THE packed layout — a map candidate is now purely a rendering.
- `src/domain/encounterMap/neonDetector.ts` — the whole module — and its
  test. `CANONICAL_ROOM_MARKERS` / `entranceMarkerConfig` / `RoomMarkerConfig`
  MOVE to `schematic.ts`: they are paint/label vocabulary only (room letters
  on the surface and editor, the schematic triangle's hue), and no pixel is
  ever read back (D7 holds unconditionally now).

### Migration v17 (justified backfill)

The v16→v17 upgrade backfills the additive fields on stored encounter rows:
`siteShape` (derived exactly as parse-on-read derives it — layout null ⇒
single; ≤1 room ⇒ single; >1 ⇒ complex with `path` = room-array order,
spawn room first when derivable) and `budgetAdvisory: ''`. It exists so the
STORED rows agree with what every parse materializes — the battle surface
and editor read `layout.path` / `siteShape` / `budgetAdvisory` directly. It
complements, never duplicates, the parse boundary. Legacy multi-room
complexes also gain the under-budget migration note on `budgetAdvisory`
(shown verbatim in the editor): their rooms carry no per-room targets until
the battlemap is regenerated — each room is roughly 1/N of the whole and
under-budget until then.

## Natural-site mode (owner-ratified)

Owner-diagnosed: a forest encounter rendered as "a strange rectangular stone
structure surrounded by forest". Root cause — the room designer (the
single-arena room contract) fired for ALL encounters, and the stylize prompt
was architectural unconditionally: the schematic's single room rect reads as
walls, and the prompt's materials line ("desaturated stone, wood, dirt")
plus the keep-walls preserve-clause told the image model to keep them. The
owner-ratified principle is **WHO HOLDS GROUND TRUTH**:

- **Dungeons**: the layout IS the truth — walls, corridors, keys and veils
  are real structure. The schematic-faithful contract is **byte-identical**
  to the pre-mode behavior (same schematic pixels vocabulary, same prompt
  clauses, pinned by tests).
- **Outdoors**: the encounter's own prose is the truth; our geometry encodes
  only spawn positions. The contract becomes **minimal, not inverted** — no
  terrain bans of any kind (no "no rectangles", no "no structures": an
  island in a lava lake or a murder-clown tent stays paintable) and the
  prose palette is fully open.

### The two contracts

- **Schematic** (`renderSchematic` `mode`): `'architectural'` (default)
  paints the room/wall schematic exactly as before. `'natural'` paints ONLY
  the placement overlay: one soft organic patch per room over the mob
  cluster (`mobsRect` — the cells `placeMonsters` scatters into), drawn as a
  deterministic union of jittered circles (two passes — translucent fringe +
  denser core — one fill each, so overlaps never seam; NO `Math.random`,
  same layout ⇒ same bytes), plus the canonical entrance triangle with no
  wall gap and no landing pad. No region boundary stroke, no wall geometry,
  no corridor fills — nothing readable as architecture survives the
  reference.
- **Stylize prompt**: natural mode rebuilds it from the encounter's own
  words — `theme` + `terrain` + `summary` (the parsed brief's real prose
  fields) lead, `styleNotes` keeps its slot, and ONE clause explains the
  reference as placement-only (patches = where creatures gather; triangle =
  the approach). OMITTED entirely: the stone/wood/dirt materials line and
  the keep-walls/openings/structure clause. KEPT verbatim: the usability
  hard-bans (no title/legend/grid/text/characters/tokens; no white or pale
  boxes/rectangles/plaques/discs/signposts) — they are the anti-hallucination
  floor, not a style opinion. The entrance clause softens to "a visible
  approach path at the marked spot"; the marker mechanics (one triangle,
  canonical hue, keep it) are unchanged.
- **Brief prompt**: the Cartographer's reply contract already lists
  `environment` ('dungeon' | 'outdoor') — one added line tells it to set the
  field honestly from the site's own nature (outdoor in the open,
  dungeon only inside an enclosed built complex).

### Mode derivation and the owner override

`resolveEncounterMapMode` (`src/domain/encounterMap/schema.ts`, the pure
derivation beside `resolveEncounterPreset`):

1. **Owner override** — `mapMode: 'architectural' | 'natural'` on the
   encounter data (additive + optional; legacy rows parse to undefined = no
   override, no Dexie bump). The encounter editor's **Map style** select
   (beside Location kind / Site shape) writes it: Auto stores nothing.
   A forest dungeon (ruin in the woods) can be forced architectural; an
   open cave classified 'dungeon' can be forced natural. The override beats
   every derived signal.
2. **Derived** — `'natural'` when EITHER signal says outdoors: the run's
   brief `environment === 'outdoor'` OR the persisted `locationKind ===
   'wilderness'`. The union is deliberate: an outdoor regeneration of a
   mis-classified row follows the fresh brief; an outdoor row re-briefed
   indoors stays natural until re-classified.
3. **Everything else** — `'architectural'`: dungeon is the default, and
   there is no silent third mode.

The derivation re-runs at every consumption from the EFFECTIVE brief prose
(`effectiveEncounterBrief`): the brief step stamps only the run facts (the
target's `mapMode` override + persisted `locationKind` as
`mapModeOverride`/`mapLocationKind` on the step output), so an owner-edited
brief re-classifies the map with it. Pre-mode run rows carry neither fact
and derive architectural — their behavior is byte-identical. Runs never
stamp `mapMode` on the artifact: it stays owner-owned (unset = derive), so
a re-classification re-derives. Seeding, veils, tokens and the layout
geometry are untouched by the mode — the battle plays identically either
way (D6/D11 hold); the mode changes only what the schematic paints and what
the stylize prompt says.

## Implementation record

Implemented in full on the M6 baseline: deterministic layout and schematic,
Dexie v12, room-aware seeding, reference-image/vision clients, interactive
Cartographer runs, layout-anchored battle metrics, and the unattended module
queue. The gate is 90 test files / 576 tests at completion. The site-shape
arc (D11–D13, 2026-09-08, c0bf5cf → 32db5bb) shipped in six bounded commits
(schema+v17, generation, surface, editor, deletion, docs); the gate at
completion is 149 test files / 1443 tests, and the marker path is fully
deleted (record above). The single-arena verify fix (2026-09-07) replaced
the single-site cell contract with the `arena-verdict` structural check and
named threshold reports after the production blocker (every single-site
verify failed: the graded grid is ~88% `void` periphery for one room) — its
machinery was subsequently DELETED with the verify step (D14, owner-directed:
the user is the judge; regenerate is the correction). The room-keys &
mob-treasure arc (D9, 2026-09-07, e489a65 → 01a0b5e) shipped in five
bounded commits (generation, editor, seed, surface, docs) on top of the
room-key persistence; the gate at completion is 140 test files / 1265
tests. The dungeon preset arc (D10, 2026-09-07, cc2ad02 → d69455e)
shipped in six bounded commits (surface token sizing, schematic cap,
data model, run-engine threading, UI, docs); the gate at completion is
140 test files / 1277 tests.

## Build order (completed)

- **A** — Layout engine (pure) + tests (packing, validation ladder, inscribed
  rect, placement, veil derivation, schematic geometry).
- **B** — Schemas + db version (encounter `layout`, board `mapLayout`) with
  migration goldens; battle seed extension + tests (placement, veils, spawn
  room, layout-less fallback unchanged).
- **C** — Clients: `input_references` on the image client (fetch-mocked),
  multimodal chat parts, verify schema + threshold logic.
- **D** — Run engine mode, persona, run-panel step UIs (layout review, map
  pick with overlay), aspect preference in settings.
- **E** — Battle surface layout-anchored metrics + grid overlay + goldens
  (alignment across viewport sizes).
- **F** — Module integration: encounter stub kind + unattended batch queue.
- **G** — Docs: `00` doc map, `01` data model, `05` UI, `08` testing matrix;
  this document becomes the binding spec of record.

## Acceptance criteria

- From a brief, an auto run produces a complete encounter artifact: roster
  with resolved sources, `layout` (validated rooms/corridors/doors), a
  map-role map image whose aspect matches the layout, and a computed veil set
  (one VEIL per spawned monster group). The seeded covers are veils, not fogs
  (fog-cloud arc, D4): plain cover — player view removes the covered mob
  tokens from the DOM (that removal, never the fill, is the hiding mechanic),
  and a tap on the cover passes through to the room-key marker it covers.
  FOG itself stays the opaque, blocking GM-drawn kind and renders as an
  animated grey cloud in both GM and player view (ledger 65 + the M5-D
  fog-cloud amendment in 09-MILESTONE-5).
- A manual run pauses at `brief` and `layout` (both editable/regeneratable)
  and at map pick — the LAST pause is the pick, and the pipeline is
  `brief→layout→schematic→stylize→pick→finalize` with NO verify step; the
  pick view's **Regenerate candidates** re-runs stylize only (layout and
  room keys byte-identical, fresh batch, still paused at pick); a failed
  layout after the retry ladder fails the run with an `errorMessage` — no
  placeholder encounter anywhere. An auto run completes unattended: stylize
  → pick picks candidate one by contract → finalize; a failing encounter
  fails loudly and the queue continues.
- **Run battle** on a generated encounter: every mob token sits in its room's
  area, covered by its spawn group's veil and absent from the DOM and initiative;
  lifting the group's veil reveals the mobs and auto-rolls their initiative;
  PCs spawn in the entry room.
- Resizing the window (tablet ↔ desktop) keeps every group veil on its room —
  layout-anchored metrics, golden-tested.
- Regenerating on an edited roster keeps the artifact's identity/links/body,
  replaces `layout` + `mapImageId` under the single-map-slot rule (D16: the
  previous map leaves the gallery in the same attach transaction, never-live
  boards converge, live boards stay frozen with a loud re-run toast),
  and re-derives placement.
- Module generation with encounters: encounter stubs become full encounters
  with maps unattended; a failing encounter reports loudly and does not stop
  the queue; retry re-runs only the failed job. The module itself ships under
  a hard encounter floor (docs/08 §M4-B): at least one distinct named
  encounter per level, allocated per part band — counted from the prose
  wiki-links, never from generated artifacts. The floor's number is the
  MODULE's own recorded guardrail (docs/08 §Editable encounter floor): the
  owner may raise it per module in the New Module dialog's Advanced
  disclosure, and may turn it off entirely — what an encounter IS (a fight:
  encounter artifacts, maps and rosters — §What an encounter IS) is untouched
  by that setting, and the retired conflict-kind/mix vocabulary no longer
  exists in either seam (docs/17 row 72).
- An uploaded-map encounter (no layout) behaves exactly as today.
- Room keys & mob treasure (D9): a generated brief's room keys persist on
  the finalized layout rooms through packing rotation and the staging
  rebuild; the Smith's draft treasure lands on the finalized roster entries;
  a map regeneration replaces keys with the fresh brief's while the roster
  (and its treasure) survives verbatim; seeded tokens freeze their entry's
  treasure (spawn included); GM view shows key markers + rail key card +
  token treasure; player view shows none of it (contract test).
- The dnd5e budget guidance is our own documented approximation and the
  pf2e guidance demands verbatim GM Core grounding — asserted by unit
  tests on `treasureGuidanceFor`.
- Dungeon preset (D10): a `dungeon` brief packs on the fixed ×2 tier per
  aspect (48×36 / 56×32 / 40×40) regardless of room count, deterministically;
  a standard brief stays on the base tier; the run row, artifact data and
  Settings round-trip the choice; the v14→v15 migration backfills the
  defaults. The battle surface needs no preset awareness — the layout's
  `cols/rows` carry the finer grid.
- Site shape (D11): a single encounter seeds its spawn groups' veils (group
  veils — no spawn-room exemption) and starts at
  the entrance cell (else mobsRect center); a complex veils every spawn group
  on every room for sequential play along the path; the editor selector disables the shape
  the map on file cannot hold; the artifact refine rejects single-with-
  corridors and complex-with-one-room rows; legacy rows parse with the
  derived shape (multi-room ⇒ complex with a spawn-first path).
- Budget loop (D12): a too-hard room triggers exactly one repair turn whose
  issue names the room, the sum and the lowered target; after the bounded
  retry the run still COMPLETES with the lowered targetLevel persisted on
  the room and the loud advisory on the step output and artifact; a room
  with unresolvable creature levels is loud-unverified; pf2e runs persist
  the verbatim-advisory instead of any numeric check; the in-place Smith
  fill re-partitions rooms by name-match / round-robin / drop and runs the
  same loop (pin tests in `tests/llm/roomBudget.test.ts`,
  `encounterCartographer.test.ts`, `encounterRun.test.ts`).
- Path (D13): packRooms stores the brief's room order entry-room-first;
  the layout schema rejects a non-permutation path; the surface rail
  follows the stored path and "Reveal next room" lifts EVERY group veil of
  the next veiled room (reveal-all, resolving per room via `veil.id` AND
  `veil.roomId` — advisory only, no locks, no initiative changes; no room
  reads revealed while its mobs stay covered — group-veil seam, §18).
- Marker-path deletion: no module under src/ reads map pixels for
  geometry; the detector module, staging builders and isStaging escapes
  are gone, and validation is unconditional.
- `pnpm lint && pnpm typecheck && pnpm test` passes with the layout engine,
  seed and surface-metric modules covered.

## Non-goals (v1)

- Line-of-sight simulation, lighting, dynamic fog reveal by movement.
- Hand-editing room rectangles (regenerate instead); free-form/organic rooms.
- Multiple maps or multiple "floors" per encounter.
- Token art generation *during the run* (D5 — the "Generate mob portraits"
  batch above owns it, amended 2026-09-05; rows 90/96 widened that batch to
  EVERY roster participant that can own a portrait, so this non-goal is about
  WHEN the art is made, not about which creatures: rulebook-cited creatures
  share the global bestiary portrait cache, while materialized and invented
  creatures are imaged locally), token `tracks`. (3D dice
  left this list 2026-09-06: the M5-D dice-roller amendment — 09-MILESTONE-5
  §M5-D, 4e3de75 — ships `@3d-dice/dice-box` in the battle surface's roller.)
- Player-facing second render surface / sync (M5 non-goal stands).
- Reading geometry back from stylized images (D7 holds unconditionally since
  D14 deleted the verify step).
- PDF export of layouts.
