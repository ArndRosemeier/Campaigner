import { PlusIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Add/remove row editors shared by the kind forms and the stat-block form. */

export interface StringListEditorProps {
  label: string;
  items: readonly string[];
  onChange: (items: string[]) => void;
  itemPlaceholder?: string;
}

export function StringListEditor({
  label,
  items,
  onChange,
  itemPlaceholder,
}: StringListEditorProps) {
  function update(index: number, value: string): void {
    onChange(items.map((item, i) => (i === index ? value : item)));
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            value={item}
            placeholder={itemPlaceholder}
            className="h-7 text-sm"
            onChange={(event) => {
              update(index, event.target.value);
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${label} entry ${index + 1}`}
            onClick={() => {
              onChange(items.filter((_, i) => i !== index));
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="w-fit"
        onClick={() => {
          onChange([...items, '']);
        }}
      >
        <PlusIcon aria-hidden /> Add
      </Button>
    </div>
  );
}

export interface PairRow {
  a: string;
  b: string;
}

export interface PairListEditorProps {
  label: string;
  labelA: string;
  labelB: string;
  rows: readonly PairRow[];
  onChange: (rows: PairRow[]) => void;
}

/** Two-column add/remove row list (points of interest, ranks, traits…). */
export function PairListEditor({ label, labelA, labelB, rows, onChange }: PairListEditorProps) {
  function update(index: number, patch: Partial<PairRow>): void {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-1">
          <Input
            value={row.a}
            placeholder={labelA}
            aria-label={`${labelA} ${index + 1}`}
            className="h-7 w-40 shrink-0 text-sm"
            onChange={(event) => {
              update(index, { a: event.target.value });
            }}
          />
          <Input
            value={row.b}
            placeholder={labelB}
            aria-label={`${labelB} ${index + 1}`}
            className="h-7 flex-1 text-sm"
            onChange={(event) => {
              update(index, { b: event.target.value });
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${label} entry ${index + 1}`}
            onClick={() => {
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="w-fit"
        onClick={() => {
          onChange([...rows, { a: '', b: '' }]);
        }}
      >
        <PlusIcon aria-hidden /> Add
      </Button>
    </div>
  );
}

export interface ExtrasEditorProps {
  extras: Readonly<Record<string, string>>;
  onChange: (extras: Record<string, string>) => void;
}

/** Key/value rows for system-specific stat-block fields. */
export function ExtrasEditor({ extras, onChange }: ExtrasEditorProps) {
  const keys = Object.keys(extras);

  function renameKey(index: number, nextKey: string): void {
    const next: Record<string, string> = {};
    keys.forEach((key, i) => {
      next[i === index ? nextKey : key] = extras[key] ?? '';
    });
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Extras (system-specific)</span>
      {keys.map((key, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            value={key}
            aria-label={`Extra ${index + 1} label`}
            placeholder="Label"
            className="h-7 w-40 shrink-0 text-sm"
            onChange={(event) => {
              renameKey(index, event.target.value);
            }}
          />
          <Input
            value={extras[key] ?? ''}
            aria-label={`Extra ${index + 1} value`}
            placeholder="Value"
            className="h-7 flex-1 text-sm"
            onChange={(event) => {
              onChange({ ...extras, [key]: event.target.value });
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove extra ${index + 1}`}
            onClick={() => {
              onChange(Object.fromEntries(Object.entries(extras).filter(([k]) => k !== key)));
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="w-fit"
        onClick={() => {
          onChange({ ...extras, '': '' });
        }}
      >
        <PlusIcon aria-hidden /> Add
      </Button>
    </div>
  );
}
