import type { ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { abilityModifier, formatModifier, type NamedText, type StatBlock } from '@/domain';
import {
  PairListEditor,
  ExtrasEditor,
  type PairRow,
} from '@/features/campaign/components/list-editors';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const ABILITY_LABELS: Readonly<Record<(typeof ABILITIES)[number], string>> = {
  str: 'STR',
  dex: 'DEX',
  con: 'CON',
  int: 'INT',
  wis: 'WIS',
  cha: 'CHA',
};

function toNamedTextRows(items: readonly NamedText[]): PairRow[] {
  return items.map((item) => ({ a: item.name, b: item.text }));
}

function fromNamedTextRows(rows: readonly PairRow[]): NamedText[] {
  return rows.map((row) => ({ name: row.a, text: row.b }));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function TextField({
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
      <Input
        value={value}
        className="h-7 text-sm"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        className="h-7 text-sm"
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          onChange(Number.isNaN(parsed) ? 0 : parsed);
        }}
      />
    </Field>
  );
}

/** Classic stat-block card display (05-UI §Artifact editor). */
export function StatBlockCard({ statBlock, name }: { statBlock: StatBlock; name: string }) {
  const headlineParts = [statBlock.size, statBlock.creatureType].filter((part) => part !== '');

  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="border-b pb-1.5">
        <h3 className="font-serif text-lg font-bold">{name}</h3>
        {headlineParts.length > 0 && <p className="text-xs italic">{headlineParts.join(' ')}</p>}
        {statBlock.level !== '' && <p className="text-xs">Level {statBlock.level}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2 border-b py-1.5 text-xs">
        <div>
          <span className="font-semibold">AC</span> {statBlock.ac}
          {statBlock.acNote !== '' && (
            <span className="text-muted-foreground"> ({statBlock.acNote})</span>
          )}
        </div>
        <div>
          <span className="font-semibold">HP</span> {statBlock.hp}
          {statBlock.hpFormula !== '' && (
            <span className="text-muted-foreground"> ({statBlock.hpFormula})</span>
          )}
        </div>
        <div>
          <span className="font-semibold">Speed</span> {statBlock.speed || '—'}
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1 border-b py-2 text-center text-xs">
        {ABILITIES.map((ability) => {
          const score = statBlock.abilities[ability];
          return (
            <div key={ability}>
              <div className="font-semibold">{ABILITY_LABELS[ability]}</div>
              <div>
                {score} ({formatModifier(abilityModifier(score))})
              </div>
            </div>
          );
        })}
      </div>

      <dl className="py-1.5 text-xs">
        {[
          ['Saving Throws', statBlock.saves],
          ['Skills', statBlock.skills],
          ['Senses', statBlock.senses],
          ['Languages', statBlock.languages],
        ]
          .filter(([, value]) => value !== '')
          .map(([label, value]) => (
            <div key={label} className="flex gap-1">
              <dt className="shrink-0 font-semibold">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>

      {(['traits', 'actions', 'reactions', 'legendary'] as const).map((section) => {
        const items = statBlock[section];
        if (items.length === 0) return null;
        return (
          <div key={section} className="mt-2">
            <h4 className="border-b text-xs font-bold tracking-wide uppercase">{section}</h4>
            <ul className="mt-1 space-y-1 text-xs">
              {items.map((item, index) => (
                <li key={index}>
                  <span className="font-semibold italic">{item.name}.</span> {item.text}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {Object.entries(statBlock.extras).length > 0 && (
        <dl className="mt-2 border-t pt-1.5 text-xs">
          {Object.entries(statBlock.extras).map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt className="shrink-0 font-semibold">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export interface StatBlockFormProps {
  statBlock: StatBlock;
  onChange: (next: StatBlock) => void;
}

/** Edit form for every StatBlock field, mapped 1:1 (05-UI: "plain labeled inputs"). */
export function StatBlockForm({ statBlock, onChange }: StatBlockFormProps) {
  function patch(next: Partial<StatBlock>): void {
    onChange({ ...statBlock, ...next });
  }

  function patchAbility(ability: (typeof ABILITIES)[number], value: number): void {
    patch({ abilities: { ...statBlock.abilities, [ability]: value } });
  }

  function patchNamedList(
    section: 'traits' | 'actions' | 'reactions' | 'legendary',
    rows: PairRow[],
  ): void {
    patch({ [section]: fromNamedTextRows(rows) });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="Level"
          value={statBlock.level}
          onChange={(level) => {
            patch({ level });
          }}
        />
        <TextField
          label="Size"
          value={statBlock.size}
          onChange={(size) => {
            patch({ size });
          }}
        />
        <TextField
          label="Creature type"
          value={statBlock.creatureType}
          onChange={(creatureType) => {
            patch({ creatureType });
          }}
        />
        <TextField
          label="Speed"
          value={statBlock.speed}
          onChange={(speed) => {
            patch({ speed });
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="AC"
          value={statBlock.ac}
          onChange={(ac) => {
            patch({ ac });
          }}
        />
        <TextField
          label="AC note"
          value={statBlock.acNote}
          onChange={(acNote) => {
            patch({ acNote });
          }}
        />
        <NumberField
          label="HP"
          value={statBlock.hp}
          onChange={(hp) => {
            patch({ hp });
          }}
        />
        <TextField
          label="HP formula"
          value={statBlock.hpFormula}
          onChange={(hpFormula) => {
            patch({ hpFormula });
          }}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {ABILITIES.map((ability) => (
          <NumberField
            key={ability}
            label={ABILITY_LABELS[ability]}
            value={statBlock.abilities[ability]}
            onChange={(value) => {
              patchAbility(ability, value);
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="Saving throws"
          value={statBlock.saves}
          onChange={(saves) => {
            patch({ saves });
          }}
        />
        <TextField
          label="Skills"
          value={statBlock.skills}
          onChange={(skills) => {
            patch({ skills });
          }}
        />
        <TextField
          label="Senses"
          value={statBlock.senses}
          onChange={(senses) => {
            patch({ senses });
          }}
        />
        <TextField
          label="Languages"
          value={statBlock.languages}
          onChange={(languages) => {
            patch({ languages });
          }}
        />
      </div>
      <PairListEditor
        label="Traits"
        labelA="Name"
        labelB="Text"
        rows={toNamedTextRows(statBlock.traits)}
        onChange={(rows) => {
          patchNamedList('traits', rows);
        }}
      />
      <PairListEditor
        label="Actions"
        labelA="Name"
        labelB="Text"
        rows={toNamedTextRows(statBlock.actions)}
        onChange={(rows) => {
          patchNamedList('actions', rows);
        }}
      />
      <PairListEditor
        label="Reactions"
        labelA="Name"
        labelB="Text"
        rows={toNamedTextRows(statBlock.reactions)}
        onChange={(rows) => {
          patchNamedList('reactions', rows);
        }}
      />
      <PairListEditor
        label="Legendary actions"
        labelA="Name"
        labelB="Text"
        rows={toNamedTextRows(statBlock.legendary)}
        onChange={(rows) => {
          patchNamedList('legendary', rows);
        }}
      />
      <ExtrasEditor
        extras={statBlock.extras}
        onChange={(extras) => {
          patch({ extras });
        }}
      />
    </div>
  );
}
