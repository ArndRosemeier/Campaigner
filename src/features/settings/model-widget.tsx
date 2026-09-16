import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { CheckIcon, ChevronsUpDownIcon, HistoryIcon, SparklesIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { recordRecentChatModel } from '@/db/settingsRepo';
import { listModelIds } from '@/features/settings/model-options';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * THE model-picking widget (docs/17 rows 193 and 199, docs/05 §Top bar/§Settings).
 * ONE component owns the option fetch, the searchable list, the free-form entry,
 * the loud no-key/failed states and the optional recents; it renders in the two
 * shapes the app needs:
 *
 * - `field` — label + free-form text input + a browse popover. The shape the
 *   deleted `ModelInput` rendered, keeping its `id`/`label`/`placeholder` and
 *   size-class props so the dense canvas-chat instance (44px touch targets)
 *   keeps its layout.
 * - `trigger` — the compact top-bar button (the deleted `ModelPicker`) that
 *   shows the current global chat model and opens the same panel.
 *
 * The account list comes from the ONE `listModelIds` seam; `fetchOptions` is the
 * escape hatch for a DIFFERENT list (the image fields' `listImageModels`), never
 * a second chat-model source. `canBrowse` (the caller's key probe, one input for
 * both variants) gates the fetch: the panel still OPENS without a key and says
 * in words why the list is absent (an empty list must never read as "the account
 * has no models" — AGENTS rules 1–2). Free-form entry survives in both variants:
 * the field's own input is free text, and the panel offers a `Use "<typed id>"`
 * item whenever the typed id is not an account model.
 *
 * `recentModels` is the RECENTS gate: pass it exclusively for instances that edit
 * the GLOBAL first-try chat model (`settings.defaultChatModel`). Recents mean
 * "the global chat model was in play" (`domain/settings.withRecentChatModel`,
 * `db/settingsRepo.recordRecentChatModel`), so a persona/image/embedding/fallback
 * tier showing them would lie about what the list means. Its PRESENCE (even `[]`)
 * is what enables the group and the recording on a choose;
 * `tests/architecture/one-model-option-source.test.ts` pins the exact mount
 * population and which mounts pass it.
 */
interface ModelWidgetBase {
  /** The current model id (free text — the setting is a string). */
  value: string;
  /**
   * Persists the id the user picked or typed. Return the write's promise when
   * it is asynchronous: a choose awaits it before recording a recent, and its
   * rejection is surfaced with `toastError` (AGENTS rule 2).
   */
  onChange: (value: string) => unknown;
  /** Model ids to offer; defaults to the ONE `listModelIds` account seam. */
  fetchOptions?: (() => Promise<string[]>) | undefined;
  /**
   * False when the caller knows there is no API key to browse with. The panel
   * then says so in words and no fetch is attempted; a typed id (and recents
   * where offered) still work. The caller owns this because it already holds
   * the settings row — the widget never opens a second settings subscription.
   */
  canBrowse: boolean;
  /**
   * The GLOBAL chat-model recents to offer. Set it ONLY for instances that edit
   * `settings.defaultChatModel`: its presence is also what records a pick
   * through `db/settingsRepo.recordRecentChatModel`. Absent for every other
   * tier, because the list means "the global chat model was in play" and
   * showing or recording it elsewhere would lie (docs/17 rows 193 and 199).
   */
  recentModels?: readonly string[] | undefined;
}

interface ModelFieldVariant extends ModelWidgetBase {
  variant: 'field';
  id: string;
  label: string;
  placeholder: string;
  inputClassName?: string | undefined;
  triggerClassName?: string | undefined;
}

interface ModelTriggerVariant extends ModelWidgetBase {
  variant: 'trigger';
}

export type ModelWidgetProps = ModelFieldVariant | ModelTriggerVariant;

export function ModelWidget(props: ModelWidgetProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const isTrigger = props.variant === 'trigger';
  const canBrowse = props.canBrowse;
  const recentModels = props.recentModels;
  // Presence of the recents prop IS the placement decision (docs/17 row 199):
  // only a global-chat-model instance passes it, and only such an instance
  // records through the ONE recency seam.
  const globalChat = recentModels !== undefined;
  const recents = recentModels ?? [];
  const fetchOptions = props.fetchOptions;

  // One fetch per widget, on first open, once the caller says browsing is
  // possible. An effect (not the popover callback) so a panel opened before the
  // key lands still loads. No cleanup: the widget stays mounted with the panel,
  // and a request that settles after a close simply caches its list.
  useEffect(() => {
    if (!open || !canBrowse || options !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    void (fetchOptions !== undefined ? fetchOptions() : listModelIds())
      .then((next) => {
        setOptions(next);
      })
      .catch((error: unknown) => {
        setLoadError(errorMessage(error));
        toastError("Could not load the account's models", error);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, canBrowse, options, loading, fetchOptions]);

  /** The ONE choose path: persist through the caller, then record the recent. */
  async function apply(model: string): Promise<void> {
    const trimmed = model.trim();
    if (trimmed === '') return;
    setOpen(false);
    try {
      await props.onChange(trimmed);
    } catch (error) {
      toastError('Could not set the model', error);
      return;
    }
    if (!globalChat) return;
    try {
      await recordRecentChatModel(trimmed);
    } catch (error) {
      toastError('Could not update the recently used models', error);
    }
  }

  /** The field's own input is free text; each keystroke persists immediately. */
  function typed(next: string): void {
    void Promise.resolve(props.onChange(next)).catch((error: unknown) => {
      toastError('Could not set the model', error);
    });
  }

  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLowerCase();
  const matches = (model: string): boolean =>
    needle === '' || model.toLowerCase().includes(needle);
  // Filtering only REMOVES rows — it never re-sorts, so the recents group keeps
  // its stored most-recent-first order even while searching (docs/17 row 193).
  const shownRecents = recents.filter(matches);
  const known = new Set([...recents, ...(options ?? [])]);
  const shownOptions = (options ?? []).filter(
    (model) => !recents.includes(model) && matches(model),
  );
  const showFreeForm = trimmedQuery !== '' && !known.has(trimmedQuery);

  const panel = (
    <PopoverContent className="w-80 p-0" align={isTrigger ? 'start' : 'end'}>
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
                onSelect={() => void apply(trimmedQuery)}
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
                  onSelect={() => void apply(model)}
                >
                  <HistoryIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{model}</span>
                  {model === props.value && (
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
                Add an OpenRouter API key in Settings to browse the account&rsquo;s models.{' '}
                {globalChat
                  ? 'Recently used and a typed model id still work.'
                  : 'A typed model id still works.'}
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
              <CommandItem key={model} value={model} onSelect={() => void apply(model)}>
                <span className="truncate">{model}</span>
                {model === props.value && (
                  <CheckIcon aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  );

  if (props.variant === 'trigger') {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-testid="model-picker-trigger"
          aria-label={`Chat model: ${props.value}`}
          title={props.value}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-w-52')}
        >
          <SparklesIcon aria-hidden data-icon="inline-start" className="shrink-0" />
          <span className="min-w-0 truncate">{props.value}</span>
          <ChevronsUpDownIcon aria-hidden data-icon="inline-end" className="shrink-0 opacity-60" />
        </PopoverTrigger>
        {panel}
      </Popover>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex gap-2">
        <Input
          id={props.id}
          value={props.value}
          placeholder={props.placeholder}
          className={props.inputClassName}
          onChange={(event) => {
            typed(event.target.value);
          }}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            className={buttonVariants({ variant: 'outline', className: props.triggerClassName })}
            aria-label={`Browse ${props.label}s`}
          >
            <ChevronsUpDownIcon aria-hidden />
          </PopoverTrigger>
          {panel}
        </Popover>
      </div>
    </div>
  );
}
