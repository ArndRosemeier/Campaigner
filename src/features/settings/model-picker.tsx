import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CheckIcon, ChevronsUpDownIcon, HistoryIcon, SparklesIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readSettings, recordRecentChatModel, updateSettings } from '@/db/settingsRepo';
import { listModelIds } from '@/features/settings/model-options';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Top-bar picker for the GLOBAL first-try chat model (`settings.defaultChatModel`,
 * docs/17 row 193, docs/05 §Top bar). It edits the SAME setting the Settings
 * page's "First-try chat model" field edits — there is no second stored model —
 * and it is rendered on every route, immediately beside the Settings nav entry.
 *
 * The "Recently used" group is ALWAYS the stored recents order
 * (most-recent-first): `shouldFilter={false}` keeps cmdk from score-sorting the
 * group, and our own filter only ever REMOVES entries, never reorders them (the
 * owner's "always sorted by recency"). Recents and free-form entry keep working
 * with no API key; the account list says in words why it is absent and a failed
 * fetch surfaces in the panel AND through `toastError` — an empty list never
 * masquerades as "the account has no models" (AGENTS rules 1–2).
 */
export function ModelPicker(): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const current = settings?.defaultChatModel ?? '';
  const recents = settings?.recentChatModels ?? [];
  // A key is the precondition for the account list only; recents and a typed
  // id are usable without one.
  const canBrowse = (settings?.openRouterApiKey ?? '') !== '';

  async function fetchOptions(): Promise<void> {
    if (options !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      setOptions(await listModelIds());
    } catch (error) {
      setLoadError(errorMessage(error));
      toastError("Could not load the account's models", error);
    } finally {
      setLoading(false);
    }
  }

  async function choose(model: string): Promise<void> {
    const trimmed = model.trim();
    if (trimmed === '') return;
    setOpen(false);
    try {
      await updateSettings({ defaultChatModel: trimmed });
    } catch (error) {
      toastError('Could not set the chat model', error);
      return;
    }
    try {
      await recordRecentChatModel(trimmed);
    } catch (error) {
      toastError('Could not update the recently used models', error);
    }
  }

  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLowerCase();
  const matches = (model: string): boolean =>
    needle === '' || model.toLowerCase().includes(needle);
  // Filtering removes rows; it never re-sorts. Recents keep their stored order.
  const shownRecents = recents.filter(matches);
  const known = new Set([...recents, ...(options ?? [])]);
  const shownOptions = (options ?? []).filter(
    (model) => !recents.includes(model) && matches(model),
  );
  const showFreeForm = trimmedQuery !== '' && !known.has(trimmedQuery);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && canBrowse) void fetchOptions();
      }}
    >
      <PopoverTrigger
        data-testid="model-picker-trigger"
        aria-label={`Chat model: ${current}`}
        title={current}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-w-52')}
      >
        <SparklesIcon aria-hidden data-icon="inline-start" className="shrink-0" />
        <span className="min-w-0 truncate">{current}</span>
        <ChevronsUpDownIcon aria-hidden data-icon="inline-end" className="shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a model id…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {showFreeForm && (
              <CommandGroup heading="Use a model id">
                <CommandItem
                  value={`use:${trimmedQuery}`}
                  data-testid="model-picker-use-custom"
                  onSelect={() => void choose(trimmedQuery)}
                >
                  Use “{trimmedQuery}”
                </CommandItem>
              </CommandGroup>
            )}
            {shownRecents.length > 0 && (
              <CommandGroup heading="Recently used" data-testid="model-picker-recents">
                {shownRecents.map((model) => (
                  <CommandItem
                    key={`recent:${model}`}
                    value={`recent:${model}`}
                    onSelect={() => void choose(model)}
                  >
                    <HistoryIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{model}</span>
                    {model === current && (
                      <CheckIcon aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Account models" data-testid="model-picker-account">
              {!canBrowse && (
                <p
                  data-testid="model-picker-no-key"
                  className="px-2 py-1.5 text-xs text-muted-foreground"
                >
                  Add an OpenRouter API key in Settings to browse the account&rsquo;s models.
                  Recently used and a typed model id still work.
                </p>
              )}
              {canBrowse && loading && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading models…</p>
              )}
              {canBrowse && loadError !== null && (
                <p
                  data-testid="model-picker-load-error"
                  className="px-2 py-1.5 text-xs text-destructive"
                >
                  Could not load the account&rsquo;s models: {loadError}
                </p>
              )}
              {canBrowse && !loading && loadError === null && options !== null && options.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  This account returned no models.
                </p>
              )}
              {canBrowse && !loading && loadError === null && needle !== '' && shownOptions.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No account model matches — use the typed id above.
                </p>
              )}
              {shownOptions.map((model) => (
                <CommandItem key={model} value={model} onSelect={() => void choose(model)}>
                  <span className="truncate">{model}</span>
                  {model === current && (
                    <CheckIcon aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
