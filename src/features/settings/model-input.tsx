import { useState } from 'react';
import type { JSX } from 'react';
import { ChevronsUpDownIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { listModels, type OpenRouterModel } from '@/llm/openrouter';
import { toastError } from '@/lib/toast';

/**
 * Model field (05-UI.md §Settings): free-form text input prefilled with the
 * default, plus a combobox of the account's models (fetched from /models when
 * a valid key is present).
 */
export function ModelInput({
  id,
  label,
  value,
  placeholder,
  canBrowse,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  canBrowse: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);

  async function fetchModels(): Promise<void> {
    if (models !== null) return;
    try {
      setModels(await listModels());
    } catch (error) {
      toastError('Could not load model list', error);
      setModels([]);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) void fetchModels();
          }}
        >
          <PopoverTrigger
            className={buttonVariants({ variant: 'outline' })}
            disabled={!canBrowse}
            aria-label={`Browse ${label}s`}
          >
            <ChevronsUpDownIcon aria-hidden />
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <Command>
              <CommandInput placeholder="Filter models…" />
              <CommandList>
                <CommandEmpty>No models found.</CommandEmpty>
                <CommandGroup>
                  {(models ?? []).slice(0, 200).map((model) => (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                    >
                      {model.id}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
