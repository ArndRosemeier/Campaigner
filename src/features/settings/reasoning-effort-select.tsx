import { useEffect, useState, type JSX } from 'react';
import { BrainIcon } from 'lucide-react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { ReasoningEffort } from '@/domain/settings';
import {
  getCachedModels,
  listModels,
  modelSupportsReasoning,
  type OpenRouterModel,
} from '@/llm/openrouter';

const REASONING_OPTIONS: readonly { value: ReasoningEffort; label: string; description: string }[] = [
  { value: 'default', label: 'Model default', description: 'Let the model decide its default reasoning behavior' },
  { value: 'low', label: 'Low', description: 'Fast, minimal reasoning tokens' },
  { value: 'medium', label: 'Medium', description: 'Balanced reasoning tokens' },
  { value: 'high', label: 'High', description: 'Maximum depth and thoroughness' },
  { value: 'none', label: 'Off', description: 'Disable reasoning' },
  { value: 'minimal', label: 'Minimal', description: 'Absolute minimum reasoning budget' },
  { value: 'max', label: 'Max', description: 'Maximum supported reasoning budget' },
];

export function ReasoningEffortSelect({
  id,
  label = 'Reasoning effort',
  value,
  model,
  models: externalModels,
  inheritLabel,
  canBrowse = true,
  onChange,
}: {
  id: string;
  label?: string;
  value: ReasoningEffort;
  model: string;
  models?: readonly OpenRouterModel[];
  inheritLabel?: string;
  canBrowse?: boolean;
  onChange: (value: ReasoningEffort) => void;
}): JSX.Element {
  const [internalModels, setInternalModels] = useState<OpenRouterModel[] | null>(() => getCachedModels());

  useEffect(() => {
    if (externalModels === undefined && internalModels === null && canBrowse) {
      void listModels().then(setInternalModels).catch(() => undefined);
    }
  }, [externalModels, internalModels, canBrowse]);

  const effectiveModels = externalModels ?? internalModels ?? undefined;
  const isSupported = modelSupportsReasoning(model, effectiveModels);

  const options = REASONING_OPTIONS.map((opt) =>
    opt.value === 'default' && inheritLabel ? { ...opt, label: inheritLabel } : opt,
  );

  return (
    <div className="flex flex-col gap-1.5" data-testid={`${id}-container`}>
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <BrainIcon aria-hidden className="size-3.5 text-muted-foreground" />
          {label}
        </Label>
        {isSupported ? (
          <Badge variant="outline" className="text-emerald-500 border-emerald-500/30 text-[10px] font-normal">
            Supported
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">Not supported by this model</span>
        )}
      </div>
      <Select
        value={value}
        disabled={!isSupported}
        items={Object.fromEntries(options.map((opt) => [opt.value, opt.label]))}
        onValueChange={(val) => {
          if (val !== null) onChange(val);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-label={label}
          data-testid={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span>{opt.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
