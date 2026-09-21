import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { AnyArtifact,
  EncounterArtifactData,
  FactionArtifactData,
  GameSystem,
  LocationArtifactData,
  Module,
  NpcArtifactData,
  PcArtifactData,
  PlotArcArtifactData,
  StatBlock,
} from '@/domain';
import {
  blankStatBlock,
  CANONICAL_ROOM_MARKERS,
  ENCOUNTER_PARTY_LEVEL_MAX,
  ENCOUNTER_PARTY_LEVEL_MIN,
  npcDataIsCastCreature,
  npcStatsAreAuthored,
} from '@/domain';
import { MonsterSourceControls, MonsterStatblocksPanel } from '@/features/campaign/components/monster-source';
import { AuthoredStatBlock, BorrowedStatBlock } from '@/features/campaign/components/borrowed-stats';
import { Field } from '@/features/campaign/components/form-field';
import { PairListEditor, StringListEditor } from '@/features/campaign/components/list-editors';
import { StatBlockCard, StatBlockForm } from '@/features/campaign/components/stat-block';
import { partLevelMentionFor } from '@/llm/roomBudget';

function TextAreaField({
  label,
  value,
  onChange,
  readOnly = false,
  readOnlyReason,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Shared creature row: the field is readable but not editable, with the
   * reason in `title` (never a silently dropped keystroke). */
  readOnly?: boolean;
  readOnlyReason?: string | undefined;
  testId?: string;
}) {
  return (
    <Field label={label}>
      <Textarea
        value={value}
        readOnly={readOnly}
        title={readOnly ? readOnlyReason : undefined}
        data-testid={testId}
        className="min-h-[64px] text-sm"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

// Kind-specific forms (05-UI: "plain labeled inputs, mapped 1:1 to the
// structured data fields").

export interface NpcFormProps {
  artifactName: string;
  data: NpcArtifactData;
  onChange: (data: NpcArtifactData) => void;
  campaignSystem: GameSystem;
  /** Read-only mode for the NPC's AUTHORED text, used by any caller that
   * presents the row without owning it (the module reader's cards, a peek).
   * A bestiary creature no longer needs it — it is a read-only library row with
   * no artifact, so no editor can open one (docs/11 D1/D8). Deliberately NOT
   * the stat block: this prop never reaches it. */
  authoredTextReadOnly?: boolean;
  /** The reason each locked field carries in its own `title` (one per field, so
   * neither says the other field's name). */
  appearanceReadOnlyReason?: string | undefined;
  personalityReadOnlyReason?: string | undefined;
}

export function NpcForm({
  artifactName,
  data,
  onChange,
  campaignSystem,
  authoredTextReadOnly = false,
  appearanceReadOnlyReason,
  personalityReadOnlyReason,
}: NpcFormProps) {
  const [editingStatBlock, setEditingStatBlock] = useState(false);
  // WHICH KIND OF NUMBERS THIS ROW HOLDS (docs/17 row 284) — the distinction the
  // cast boundary never had to make before a direct instruction could author a
  // cast row: a pure COPY (the library's numbers, read-only, nothing to edit) or
  // an AUTHORED block that merely HAS a cast origin (the row's own numbers, so
  // the ordinary Edit/Remove affordances apply while the origin stays disclosed).
  const castCopy = npcDataIsCastCreature(data) && !npcStatsAreAuthored(data);
  const authoredFromCast = npcDataIsCastCreature(data) && npcStatsAreAuthored(data);

  function patch(next: Partial<NpcArtifactData>): void {
    onChange({ ...data, ...next });
  }

  function setStatBlock(next: StatBlock): void {
    patch({ statBlock: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <TextAreaField
        label="Appearance"
        value={data.appearance}
        readOnly={authoredTextReadOnly}
        readOnlyReason={appearanceReadOnlyReason}
        testId="npc-appearance"
        onChange={(appearance) => {
          patch({ appearance });
        }}
      />
      <TextAreaField
        label="Personality"
        value={data.personality}
        readOnly={authoredTextReadOnly}
        readOnlyReason={personalityReadOnlyReason}
        testId="npc-personality"
        onChange={(personality) => {
          patch({ personality });
        }}
      />

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Stat block</h2>
          {/* A PURE CAST COPY (docs/11 D3; docs/17 row 255b) owns a COPY of the
              library's block — it is not a run's to author (the cast-row refill
              refuses such a block before any model call), so the "Add stat
              block"/Edit/Remove affordances are NOT offered here: those numbers
              render read-only below, labelled with their source (ledger row
              134). AN AUTHORED-FROM-CAST ROW (docs/17 row 284) is the other half:
              a direct instruction authored its numbers, so they are the row's
              own and the ordinary affordances apply — while the origin stays
              disclosed as provenance by `AuthoredStatBlock` below. */}
          {castCopy ? null : data.statBlock === null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                patch({ statBlock: blankStatBlock(campaignSystem) });
              }}
            >
              Add stat block
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant={editingStatBlock ? 'secondary' : 'outline'}
                onClick={() => {
                  setEditingStatBlock((editing) => !editing);
                }}
              >
                {editingStatBlock ? 'Done editing' : 'Edit'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  patch({ statBlock: null });
                }}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
        {castCopy ? (
          <BorrowedStatBlock
            npcName={artifactName}
            copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}
          />
        ) : authoredFromCast && data.statBlock === null ? (
          <AuthoredStatBlock
            npcName={artifactName}
            copy={{ statBlock: null, sourceLine: data.sourceLine }}
          />
        ) : data.statBlock === null ? null : editingStatBlock ? (
          <StatBlockForm statBlock={data.statBlock} onChange={setStatBlock} />
        ) : authoredFromCast ? (
          <AuthoredStatBlock
            npcName={artifactName}
            copy={{ statBlock: data.statBlock, sourceLine: data.sourceLine }}
          />
        ) : (
          <StatBlockCard statBlock={data.statBlock} name={artifactName} />
        )}
      </div>
    </div>
  );
}

export interface PcFormProps {
  data: PcArtifactData;
  campaignSystem: GameSystem;
  onChange: (data: PcArtifactData) => void;
}

/**
 * Player-character form (M5-A). The HP field is the PC's own persistent
 * current HP (whole number, clamped to ≥ 0 here; max comes from the stat
 * block and the battle clamps on write). The initiative override is the
 * extra bonus on top of the dex modifier; empty = dex only.
 */
export function PcForm({ data, campaignSystem, onChange }: PcFormProps) {
  const [editingStatBlock, setEditingStatBlock] = useState(false);

  function patch(next: Partial<PcArtifactData>): void {
    onChange({ ...data, ...next });
  }

  function setStatBlock(next: StatBlock): void {
    patch({ statBlock: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Player name">
          <Input
            value={data.playerName}
            placeholder="'' for GM-run PCs"
            className="h-7 text-sm"
            autoCapitalize="words"
            autoCorrect="off"
            enterKeyHint="next"
            onChange={(event) => {
              patch({ playerName: event.target.value });
            }}
          />
        </Field>
        <Field label="Current HP">
          <Input
            type="number"
            value={String(data.currentHp)}
            min={0}
            step={1}
            className="h-7 text-sm"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              patch({ currentHp: Number.isNaN(parsed) ? 0 : Math.max(0, parsed) });
            }}
          />
        </Field>
      </div>
      <Field label="Initiative override (extra bonus on top of DEX; empty = dex only)">
        <Input
          type="number"
          value={data.initiativeOverride === null ? '' : String(data.initiativeOverride)}
          step={1}
          className="h-7 text-sm"
          onChange={(event) => {
            const raw = event.target.value.trim();
            const parsed = raw === '' ? Number.NaN : Number.parseInt(raw, 10);
            patch({ initiativeOverride: Number.isNaN(parsed) ? null : parsed });
          }}
        />
      </Field>
      <TextAreaField
        label="Notes"
        value={data.notes}
        onChange={(notes) => {
          patch({ notes });
        }}
      />

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Stat block</h2>
          {data.statBlock === null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                patch({ statBlock: blankStatBlock(campaignSystem) });
              }}
            >
              Add stat block
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant={editingStatBlock ? 'secondary' : 'outline'}
                onClick={() => {
                  setEditingStatBlock((editing) => !editing);
                }}
              >
                {editingStatBlock ? 'Done editing' : 'Edit'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  patch({ statBlock: null });
                }}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
        {data.statBlock !== null && !editingStatBlock && (
          <StatBlockCard statBlock={data.statBlock} name="This PC" />
        )}
        {data.statBlock !== null && editingStatBlock && (
          <StatBlockForm statBlock={data.statBlock} onChange={setStatBlock} />
        )}
      </div>
    </div>
  );
}

export interface LocationFormProps {
  data: LocationArtifactData;
  onChange: (data: LocationArtifactData) => void;
}

export function LocationForm({ data, onChange }: LocationFormProps) {
  function patch(next: Partial<LocationArtifactData>): void {
    onChange({ ...data, ...next });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Location type">
        <Input
          value={data.locationType}
          className="h-7 text-sm"
          placeholder="e.g. tavern, ruin, city quarter"
          onChange={(event) => {
            patch({ locationType: event.target.value });
          }}
        />
      </Field>
      <TextAreaField
        label="Inhabitants"
        value={data.inhabitants}
        onChange={(inhabitants) => {
          patch({ inhabitants });
        }}
      />
      <PairListEditor
        label="Points of interest"
        labelA="Name"
        labelB="Description"
        rows={data.pointsOfInterest.map((poi) => ({ a: poi.name, b: poi.description }))}
        onChange={(rows) => {
          patch({ pointsOfInterest: rows.map((row) => ({ name: row.a, description: row.b })) });
        }}
      />
      <StringListEditor
        label="Adventure hooks"
        items={data.hooks}
        onChange={(hooks) => {
          patch({ hooks });
        }}
        itemPlaceholder="A hook…"
      />
    </div>
  );
}

export interface FactionFormProps {
  data: FactionArtifactData;
  onChange: (data: FactionArtifactData) => void;
}

export function FactionForm({ data, onChange }: FactionFormProps) {
  function patch(next: Partial<FactionArtifactData>): void {
    onChange({ ...data, ...next });
  }

  return (
    <div className="flex flex-col gap-3">
      <TextAreaField
        label="Goals"
        value={data.goals}
        onChange={(goals) => {
          patch({ goals });
        }}
      />
      <TextAreaField
        label="Methods"
        value={data.methods}
        onChange={(methods) => {
          patch({ methods });
        }}
      />
      <TextAreaField
        label="Resources"
        value={data.resources}
        onChange={(resources) => {
          patch({ resources });
        }}
      />
      <PairListEditor
        label="Ranks"
        labelA="Title"
        labelB="Description"
        rows={data.ranks.map((rank) => ({ a: rank.title, b: rank.description }))}
        onChange={(rows) => {
          patch({ ranks: rows.map((row) => ({ title: row.a, description: row.b })) });
        }}
      />
    </div>
  );
}

/** Monsters row editor: name / count / notes / source (Encounter kind, M3-B). */
function MonsterListEditor({
  monsters,
  campaignArtifacts,
  campaignSystem,
  onChange,
}: {
  monsters: EncounterArtifactData['monsters'];
  campaignArtifacts: readonly AnyArtifact[];
  /** The rulebook-link dialog's pool stays inside the campaign's system. */
  campaignSystem: GameSystem;
  onChange: (monsters: EncounterArtifactData['monsters']) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Monsters</span>
      {monsters.map((monster, index) => (
        <div key={index} className="flex flex-col gap-1 rounded-md border p-1.5">
          <div className="flex items-center gap-1">
            <Input
              value={monster.name}
              placeholder="Name"
              className="h-7 flex-1 text-sm"
              aria-label="Monster name"
              autoCapitalize="words"
              autoCorrect="off"
              enterKeyHint="next"
              onChange={(event) => {
                onChange(
                  monsters.map((m, i) => (i === index ? { ...m, name: event.target.value } : m)),
                );
              }}
            />
            <Input
              type="number"
              min={1}
              value={monster.count}
              aria-label="Monster count"
              className="h-7 w-16 text-sm"
              onChange={(event) => {
                const count = Number.parseInt(event.target.value, 10);
                onChange(
                  monsters.map((m, i) =>
                    i === index
                      ? { ...m, count: Number.isNaN(count) ? 1 : Math.max(1, count) }
                      : m,
                  ),
                );
              }}
            />
            <Input
              value={monster.notes}
              placeholder="Notes"
              className="h-7 flex-1 text-sm"
              aria-label="Monster notes"
              onChange={(event) => {
                onChange(
                  monsters.map((m, i) => (i === index ? { ...m, notes: event.target.value } : m)),
                );
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove monster ${monster.name || index + 1}`}
              onClick={() => {
                onChange(monsters.filter((_, i) => i !== index));
              }}
            >
              ×
            </Button>
          </div>
          <MonsterSourceControls
            entry={monster}
            campaignArtifacts={campaignArtifacts}
            campaignSystem={campaignSystem}
            onChange={(next) => {
              onChange(monsters.map((m, i) => (i === index ? next : m)));
            }}
          />
          {/* Mob treasure (owner-ratified): what ONE instance carries — GM
              checklist text, frozen onto each seeded token at seed time. */}
          <Textarea
            value={monster.treasure}
            placeholder="Treasure carried by one of these (one item per line)"
            className="min-h-[44px] text-sm"
            aria-label={`Treasure carried by one ${monster.name || 'of these'}`}
            onChange={(event) => {
              onChange(
                monsters.map((m, i) => (i === index ? { ...m, treasure: event.target.value } : m)),
              );
            }}
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() => {
          onChange([...monsters, { name: '', count: 1, notes: '', treasure: '', source: { type: 'none' } }]);
        }}
      >
        Add monster
      </Button>
    </div>
  );
}

export interface EncounterFormProps {
  data: EncounterArtifactData;
  campaignArtifacts: readonly AnyArtifact[];
  /** The campaign's game system — scopes the rulebook stat-block dialog. */
  campaignSystem: GameSystem;
  /**
   * The encounter's ARTIFACT NAME — the mention the party-level part lookup
   * reads (docs/17 row 291). Passed separately from `data` because the name
   * lives on the artifact row, not in the kind form's data.
   */
  name: string;
  /**
   * The encounter's owning MODULE row, live (docs/17 row 291): the party level
   * is the EXACT level of the first part whose text mentions this encounter.
   * `null` = this encounter is campaign-level; `undefined` = the module row is
   * still loading (the field renders its owner-set form until it resolves).
   */
  module: Module | null | undefined;
  onChange: (data: EncounterArtifactData) => void;
}

export function EncounterForm({
  data,
  campaignArtifacts,
  campaignSystem,
  name,
  module,
  onChange,
}: EncounterFormProps) {
  function patch(next: Partial<EncounterArtifactData>): void {
    onChange({ ...data, ...next });
  }

  // Site-shape boundary (docs/11 D11): the owner can only pick a shape the
  // layout on file can hold — a single arena is exactly one room with no
  // corridors, a dungeon is multi-room. An incompatible option is disabled
  // with the reason in the hint (loud, never silently rewritten).
  const layout = data.layout;
  const canBeSingle = layout == null || (layout.rooms.length === 1 && layout.corridors.length === 0);
  const canBeComplex = layout == null || layout.rooms.length >= 2;

  // THE PARTY LEVEL (docs/17 row 291): a module part that MENTIONS this
  // encounter IS the level the fight is made for — derived, shown read-only,
  // named. Only when NO part mentions it does the owner set it, through the
  // STRUCTURED number below (AGENTS rule 5: never a free-text level). The
  // run refuses loudly when neither exists, so the field states which case
  // the row is in rather than leaving the owner guessing.
  const partMention = module == null ? undefined : partLevelMentionFor(module, name);
  const partyLevelValue = data.partyLevel === undefined ? '' : String(data.partyLevel);

  return (
    <div className="flex flex-col gap-3">
      {data.budgetAdvisory !== '' && (
        <p
          className="rounded-md border border-amber-300/40 bg-amber-950/30 p-2 text-xs whitespace-pre-line text-amber-200"
          data-testid="budget-advisory"
        >
          {data.budgetAdvisory}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Difficulty">
          <Input
            value={data.difficulty}
            placeholder="medium / deadly / …"
            className="h-7 text-sm"
            onChange={(event) => {
              patch({ difficulty: event.target.value });
            }}
          />
        </Field>
        <Field label="Party level">
          {partMention === undefined ? (
            <>
              <Input
                type="number"
                inputMode="numeric"
                min={ENCOUNTER_PARTY_LEVEL_MIN}
                max={ENCOUNTER_PARTY_LEVEL_MAX}
                step={1}
                value={partyLevelValue}
                placeholder={`${String(ENCOUNTER_PARTY_LEVEL_MIN)}–${String(ENCOUNTER_PARTY_LEVEL_MAX)}`}
                className="h-7 text-sm"
                data-testid="encounter-party-level"
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === '') {
                    patch({ partyLevel: undefined });
                    return;
                  }
                  // A STRUCTURED number, validated here exactly as the stored
                  // schema validates it: a non-integer or an out-of-range value
                  // is never written (the boundary would reject it), and it is
                  // never silently clamped into a different level (AGENTS
                  // rule 1). The controlled value therefore keeps the last
                  // valid number on screen.
                  const value = Number(raw);
                  if (!Number.isInteger(value)) return;
                  if (value < ENCOUNTER_PARTY_LEVEL_MIN || value > ENCOUNTER_PARTY_LEVEL_MAX) return;
                  patch({ partyLevel: value });
                }}
              />
              <span className="text-[11px] font-normal text-muted-foreground">
                No module part mentions this encounter — set the exact party level the fight is made for.
              </span>
            </>
          ) : (
            <>
              <Input
                readOnly
                value={String(partMention.level)}
                aria-label="Party level"
                title="Derived from the module part that mentions this encounter — edit the part to change it."
                className="h-7 text-sm"
                data-testid="encounter-party-level-readonly"
              />
              <span className="text-[11px] font-normal text-muted-foreground">
                Part “{partMention.partTitle}” mentions this encounter — its exact level is the party level.
              </span>
            </>
          )}
        </Field>
      </div>
      <MonsterListEditor
        monsters={data.monsters}
        campaignArtifacts={campaignArtifacts}
        campaignSystem={campaignSystem}
        onChange={(monsters) => {
          patch({ monsters });
        }}
      />
      <MonsterStatblocksPanel monsters={data.monsters} targets={campaignArtifacts} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Location kind">
          <Select
            value={data.locationKind}
            items={{
              dungeon: 'Dungeon',
              building: 'Building',
              wilderness: 'Wilderness',
              other: 'Other / unclassified',
            }}
            onValueChange={(value) => {
              if (
                value === 'dungeon' ||
                value === 'building' ||
                value === 'wilderness' ||
                value === 'other'
              ) {
                patch({ locationKind: value });
              }
            }}
          >
            <SelectTrigger aria-label="Location kind" className="h-7 text-sm pointer-coarse:text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dungeon">Dungeon</SelectItem>
              <SelectItem value="building">Building</SelectItem>
              <SelectItem value="wilderness">Wilderness</SelectItem>
              <SelectItem value="other">Other / unclassified</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] font-normal text-muted-foreground">
            Where this encounter takes place. An automatic battlemap maps dungeons on the
            Dungeon tier (finer grid) and everything else on Standard; the encounter
            personas classify this themselves and you can correct it here.
          </span>
        </Field>
        {/* Fill grade (docs/11 D12 amendment): the per-room stocking share a
            complex is written against — complex-only (a single arena has no
            rooms to stock). Empty = draw-once at the next map materialization;
            an owner-set value always wins and is never redrawn. */}
        {data.siteShape === 'complex' && (
          <Field label="Fill grade">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={data.fillGrade ?? ''}
              placeholder="Auto (drawn once)"
              aria-label="Fill grade"
              className="h-7 text-sm"
              onChange={(event) => {
                const raw = event.target.value;
                if (raw.trim() === '') {
                  patch({ fillGrade: undefined });
                  return;
                }
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                patch({ fillGrade: Math.min(100, Math.max(0, Math.round(parsed))) });
              }}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              How much of a standard fight's threat each dungeon room should carry, 0–100.
              Left empty, the first map generation draws one (most dungeons 55–90, some
              lighter, some spikier) and keeps it; a value set here always wins. Changing
              it restocks nothing by itself: press Repopulate for a new roster against
              the new value (Regenerate everything rebuilds the map too). Those two
              buttons are the only automatic generation — a single encounter always
              rewrites as one fight.
            </span>
          </Field>
        )}
        <Field label="Site shape">
          <Select
            value={data.siteShape}
            items={{ single: 'Encounter', complex: 'Dungeon' }}
            onValueChange={(value) => {
              if (value === 'single' || value === 'complex') {
                patch({ siteShape: value });
              }
            }}
          >
            <SelectTrigger aria-label="Site shape" className="h-7 text-sm pointer-coarse:text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single" disabled={!canBeSingle}>
                Encounter (single)
              </SelectItem>
              <SelectItem value="complex" disabled={!canBeComplex}>
                Dungeon (complex)
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] font-normal text-muted-foreground">
            {canBeSingle && canBeComplex
              ? 'Encounter = one arena (straight to melee). Dungeon = multi-room complex, played room by room along the path.'
              : 'The battlemap on file fixes this shape — run Regenerate everything for the other shape first.'}
          </span>
        </Field>
        {/* Natural-site mode (docs/11): the map contract is derivable from
            the encounter's own classification (outdoor/wilderness ⇒ the
            natural-site placement contract; dungeon/building ⇒ the
            architectural dungeon contract), and the owner can force either
            way — a ruin in the woods plays architectural, an open cave plays
            natural. 'auto' stores nothing (the field stays unset = derive). */}
        <Field label="Map style">
          <Select
            value={data.mapMode ?? 'auto'}
            items={{ auto: 'Auto (from site)', natural: 'Natural site', architectural: 'Dungeon (architectural)' }}
            onValueChange={(value) => {
              if (value === 'natural' || value === 'architectural') {
                patch({ mapMode: value });
              } else if (value === 'auto') {
                patch({ mapMode: undefined });
              }
            }}
          >
            <SelectTrigger aria-label="Map style" className="h-7 text-sm pointer-coarse:text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (from site)</SelectItem>
              <SelectItem value="natural">Natural site</SelectItem>
              <SelectItem value="architectural">Dungeon (architectural)</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] font-normal text-muted-foreground">
            How the automatic battlemap treats this site. Auto follows the
            encounter's own classification: outdoor/wilderness maps as a
            natural site (open terrain led by the encounter's description,
            only spawn zones marked), dungeon/building as architectural
            (walls and structure). Force the other way for a ruin in the
            woods or an open cave.
          </span>
        </Field>
      </div>
      {layout !== null && (
        <RoomKeysEditor
          layout={layout}
          onChange={(next) => {
            patch({ layout: next });
          }}
        />
      )}
      <Field label="Terrain">
        <Input
          value={data.terrain}
          className="h-7 text-sm"
          onChange={(event) => {
            patch({ terrain: event.target.value });
          }}
        />
      </Field>
      <TextAreaField
        label="Tactics"
        value={data.tactics}
        onChange={(tactics) => {
          patch({ tactics });
        }}
      />
      <TextAreaField
        label="Treasure"
        value={data.treasure}
        onChange={(treasure) => {
          patch({ treasure });
        }}
      />
    </div>
  );
}

/**
 * Per-room GM keys (owner-ratified) + the dungeon path (docs/11 D11/D12):
 * one key textarea, room-treasure checklist and owner-editable targetLevel
 * per layout room, listed in PATH order for complexes (the play order).
 * Moving a room rewrites only `layout.path` — room rectangles stay
 * regenerate-only (docs/11 non-goals), and the rooms array itself never
 * reorders (its rects and keys travel with the room). Regenerating the
 * battlemap replaces keys with the fresh brief's (accepted consequence,
 * stated here and in the map-regeneration copy).
 */
function RoomKeysEditor({
  layout,
  onChange,
}: {
  layout: NonNullable<EncounterArtifactData['layout']>;
  onChange: (layout: NonNullable<EncounterArtifactData['layout']>) => void;
}) {
  const isComplex = layout.rooms.length > 1;
  const currentPath = layout.path ?? layout.rooms.map((room) => room.id);
  const roomById = new Map(layout.rooms.map((room) => [room.id, room]));
  const orderedIds = isComplex
    ? currentPath.filter((id) => roomById.has(id))
    : layout.rooms.map((room) => room.id);
  const orderedRooms = orderedIds.flatMap((id) => {
    const room = roomById.get(id);
    return room === undefined ? [] : [{ room, index: layout.rooms.indexOf(room) }];
  });
  function movePathRoom(from: number, to: number): void {
    if (to < 0 || to >= orderedIds.length) return;
    const next = [...orderedIds];
    const moved = next[from];
    if (moved === undefined) return;
    next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ ...layout, path: next });
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="room-keys-editor">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Room keys</h2>
        <span className="text-[11px] text-muted-foreground">
          GM-only; shown at each room's mob area. Regenerating the battlemap rewrites them.
        </span>
      </div>
      {orderedRooms.map(({ room, index }, position) => {
        const marker = room.letter ?? CANONICAL_ROOM_MARKERS[index]?.letter ?? String(index + 1);
        return (
          <div key={room.id} className="flex flex-col gap-1 rounded-md border p-1.5">
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium text-muted-foreground" data-testid={`room-key-label-${position}`}>
                Room {marker} — {room.name}
                {isComplex ? ` (path ${String(position + 1)})` : ''}
              </span>
              {isComplex && (
                <span className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move room ${marker} up`}
                    data-testid={`room-move-up-${position}`}
                    disabled={position === 0}
                    onClick={() => {
                      movePathRoom(position, position - 1);
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move room ${marker} down`}
                    data-testid={`room-move-down-${position}`}
                    disabled={position === orderedRooms.length - 1}
                    onClick={() => {
                      movePathRoom(position, position + 1);
                    }}
                  >
                    ↓
                  </Button>
                </span>
              )}
            </div>
            <Textarea
              value={room.key}
              placeholder="What the GM reads when the party first enters…"
              className="min-h-[44px] text-sm"
              aria-label={`Room ${marker} key`}
              onChange={(event) => {
                onChange({
                  ...layout,
                  rooms: layout.rooms.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)),
                });
              }}
            />
            <Textarea
              value={room.keyTreasure}
              placeholder="Treasure hidden in this room (one item per line)"
              className="min-h-[44px] text-sm"
              aria-label={`Room ${marker} treasure`}
              onChange={(event) => {
                onChange({
                  ...layout,
                  rooms: layout.rooms.map((r, i) => (i === index ? { ...r, keyTreasure: event.target.value } : r)),
                });
              }}
            />
            <Input
              type="number"
              min={1}
              value={room.targetLevel === undefined ? '' : String(room.targetLevel)}
              placeholder="Target level"
              className="h-7 text-sm"
              aria-label={`Room ${marker} target level`}
              data-testid={`room-target-level-${position}`}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = raw === '' ? Number.NaN : Number.parseInt(raw, 10);
                onChange({
                  ...layout,
                  rooms: layout.rooms.map((r, i) =>
                    i === index
                      ? { ...r, targetLevel: Number.isNaN(parsed) ? undefined : Math.max(1, parsed) }
                      : r,
                  ),
                });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export interface PlotArcFormProps {
  data: PlotArcArtifactData;
  onChange: (data: PlotArcArtifactData) => void;
}

export function PlotArcForm({ data, onChange }: PlotArcFormProps) {
  function patch(next: Partial<PlotArcArtifactData>): void {
    onChange({ ...data, ...next });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Arc type">
        <Input
          value={data.arcType}
          placeholder="adventure / campaign / …"
          className="h-7 text-sm"
          onChange={(event) => {
            patch({ arcType: event.target.value });
          }}
        />
      </Field>
      <TextAreaField
        label="Premise"
        value={data.premise}
        onChange={(premise) => {
          patch({ premise });
        }}
      />
      <TextAreaField
        label="Stakes"
        value={data.stakes}
        onChange={(stakes) => {
          patch({ stakes });
        }}
      />
      <PairListEditor
        label="Beats"
        labelA="Title"
        labelB="Description"
        rows={data.beats.map((beat) => ({ a: beat.title, b: beat.description }))}
        onChange={(rows) => {
          patch({ beats: rows.map((row) => ({ title: row.a, description: row.b })) });
        }}
      />
      <StringListEditor
        label="Hooks"
        items={data.hooks}
        itemPlaceholder="Adventure hook…"
        onChange={(hooks) => {
          patch({ hooks });
        }}
      />
      <TextAreaField
        label="Climax"
        value={data.climax}
        onChange={(climax) => {
          patch({ climax });
        }}
      />
    </div>
  );
}

export function NoteForm() {
  return (
    <p className="text-xs text-muted-foreground">
      Notes have no additional fields — use the Markdown body above.
    </p>
  );
}
