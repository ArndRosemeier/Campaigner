import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type {
  EncounterArtifactData,
  FactionArtifactData,
  GameSystem,
  LocationArtifactData,
  NpcArtifactData,
  PlotArcArtifactData,
  SessionArtifactData,
  StatBlock,
} from '@/domain';
import { blankStatBlock } from '@/domain';
import { PairListEditor, StringListEditor } from '@/features/campaign/components/list-editors';
import { StatBlockCard, StatBlockForm } from '@/features/campaign/components/stat-block';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Textarea
        value={value}
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
}

export function NpcForm({ artifactName, data, onChange, campaignSystem }: NpcFormProps) {
  const [editingStatBlock, setEditingStatBlock] = useState(false);

  function patch(next: Partial<NpcArtifactData>): void {
    onChange({ ...data, ...next });
  }

  function setStatBlock(next: StatBlock): void {
    patch({ statBlock: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Role">
          <Input
            value={data.role}
            className="h-7 text-sm"
            onChange={(event) => {
              patch({ role: event.target.value });
            }}
          />
        </Field>
        <Field label="Voice notes">
          <Input
            value={data.voiceNotes}
            className="h-7 text-sm"
            onChange={(event) => {
              patch({ voiceNotes: event.target.value });
            }}
          />
        </Field>
      </div>
      <TextAreaField
        label="Appearance"
        value={data.appearance}
        onChange={(appearance) => {
          patch({ appearance });
        }}
      />
      <TextAreaField
        label="Personality"
        value={data.personality}
        onChange={(personality) => {
          patch({ personality });
        }}
      />
      <TextAreaField
        label="Motivation"
        value={data.motivation}
        onChange={(motivation) => {
          patch({ motivation });
        }}
      />
      <TextAreaField
        label="Secrets"
        value={data.secrets}
        onChange={(secrets) => {
          patch({ secrets });
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
          <StatBlockCard statBlock={data.statBlock} name={artifactName} />
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

/** Monsters row editor: name / count / notes (Encounter kind). */
function MonsterListEditor({
  monsters,
  onChange,
}: {
  monsters: EncounterArtifactData['monsters'];
  onChange: (monsters: EncounterArtifactData['monsters']) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Monsters</span>
      {monsters.map((monster, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            value={monster.name}
            placeholder="Name"
            className="h-7 flex-1 text-sm"
            aria-label="Monster name"
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
                  i === index ? { ...m, count: Number.isNaN(count) ? 1 : Math.max(1, count) } : m,
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
      ))}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() => {
          onChange([...monsters, { name: '', count: 1, notes: '' }]);
        }}
      >
        Add monster
      </Button>
    </div>
  );
}

export interface EncounterFormProps {
  data: EncounterArtifactData;
  onChange: (data: EncounterArtifactData) => void;
}

export function EncounterForm({ data, onChange }: EncounterFormProps) {
  function patch(next: Partial<EncounterArtifactData>): void {
    onChange({ ...data, ...next });
  }

  return (
    <div className="flex flex-col gap-3">
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
          <Input
            value={data.levelHint}
            placeholder="e.g. 3"
            className="h-7 text-sm"
            onChange={(event) => {
              patch({ levelHint: event.target.value });
            }}
          />
        </Field>
      </div>
      <MonsterListEditor
        monsters={data.monsters}
        onChange={(monsters) => {
          patch({ monsters });
        }}
      />
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

export interface SessionFormProps {
  data: SessionArtifactData;
  onChange: (data: SessionArtifactData) => void;
}

export function SessionForm({ data, onChange }: SessionFormProps) {
  function patch(next: Partial<SessionArtifactData>): void {
    onChange({ ...data, ...next });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Session number">
        <Input
          value={data.sessionNumber}
          className="h-7 text-sm"
          onChange={(event) => {
            patch({ sessionNumber: event.target.value });
          }}
        />
      </Field>
      <TextAreaField
        label="Recap"
        value={data.recap}
        onChange={(recap) => {
          patch({ recap });
        }}
      />
      <StringListEditor
        label="Prep"
        items={data.prep}
        itemPlaceholder="Prep item…"
        onChange={(prep) => {
          patch({ prep });
        }}
      />
      <StringListEditor
        label="Open threads"
        items={data.openThreads}
        itemPlaceholder="Unresolved thread…"
        onChange={(openThreads) => {
          patch({ openThreads });
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
