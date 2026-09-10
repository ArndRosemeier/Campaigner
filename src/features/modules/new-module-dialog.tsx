import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { MinusIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type {
  Campaign,
  EncounterFloorGuardrail,
  EntityKind,
  ModuleSizeDial,
  NewModule,
  NewModuleDraft,
} from '@/domain';
import {
  defaultEncounterFloorGuardrail,
  defaultNewModuleDraft,
  ENTITY_KINDS,
  MODULE_SIZE_LABELS,
} from '@/domain';
import { modulePath } from '@/app/routes';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { createModuleAndRun } from '@/llm/moduleGen';
import { toastError } from '@/lib/toast';

/**
 * "New Module" creation dialog (08-MODULE-DESIGNER M4-B): concept, level
 * range (two steppers, max ≥ min), tone, size dial, the opt-in cross-module
 * continuity checkbox. Creates the Module row and navigates to the reader
 * immediately — the spine draft runs there, with its live streaming card,
 * Stop button and progress dock; the dialog never blocks on the LLM.
 *
 * PERSISTED DRAFT (owner request, docs/17): every value this dialog holds —
 * concept included — is saved to the settings row's `newModuleDraft`, tagged
 * with the campaign it was written in. Reopening the dialog in that campaign
 * prefills it, so a module creation can be retried (or restarted after a
 * reset) without retyping. The write is debounced on change and flushed
 * synchronously when the run starts and when the dialog closes; the tag means
 * another campaign's draft is never prefilled here. `Reset to defaults` is the
 * escape hatch — a prefill with no way out is its own trap.
 *
 * ADVANCED — numeric encounter floor (owner decision, docs/17): how many
 * encounters per level the generator must name is a NUMBER, rendered into the
 * prompt clauses AND into the floor gate (one source of truth in the domain).
 * The value chosen here is recorded ON THE MODULE ROW at creation, so a later
 * pass, repair or retry uses the module's own rules.
 */

const SIZES: readonly ModuleSizeDial[] = ['sketch', 'standard', 'detailed'];

/** Human labels for the automation grid rows (artifact/entity kinds). */
const KIND_LABELS: Readonly<Record<EntityKind, string>> = {
  npc: 'NPC',
  location: 'Location',
  event: 'Event',
  faction: 'Faction',
  note: 'Note',
  encounter: 'Encounter',
};

/** How long after the last edit the draft lands on the settings row. */
const DRAFT_DEBOUNCE_MS = 500;

/**
 * Field-by-field equality for two drafts. Used to tell "the form still shows
 * the dialog's pristine defaults" (nothing to save, nothing to defend) from "a
 * user edit already happened" — an array-compare through `every` because the
 * kind lists are the only non-primitive fields.
 */
function draftsEqual(a: NewModuleDraft, b: NewModuleDraft): boolean {
  const sameKinds = (left: readonly EntityKind[], right: readonly EntityKind[]): boolean =>
    left.length === right.length && left.every((kind, index) => kind === right[index]);
  return (
    a.campaignId === b.campaignId &&
    a.concept === b.concept &&
    a.levelMin === b.levelMin &&
    a.levelMax === b.levelMax &&
    a.tone === b.tone &&
    a.sizeDial === b.sizeDial &&
    a.includePriorModules === b.includePriorModules &&
    a.autoApproveSpine === b.autoApproveSpine &&
    sameKinds(a.autoGenerateKinds, b.autoGenerateKinds) &&
    sameKinds(a.autoImageKinds, b.autoImageKinds) &&
    a.autoGenerateBattlemaps === b.autoGenerateBattlemaps &&
    a.autoGenerateMobImages === b.autoGenerateMobImages &&
    a.encounterFloorGuardrail.enabled === b.encounterFloorGuardrail.enabled &&
    a.encounterFloorGuardrail.perLevel === b.encounterFloorGuardrail.perLevel
  );
}

export interface NewModuleDialogProps {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The dialog is MOUNTED PER CAMPAIGN: the state, the refs and the prefill all
 * belong to ONE campaign, so the key is the campaign id. Switching campaign
 * while the dialog is open remounts the inner component instead of leaving a
 * mounted dialog showing the campaign it was opened in.
 *
 * Why a remount rather than an effect that notices the change: every piece of
 * this dialog's state (the controlled fields, the pristine defaults the
 * "an edit already happened" test compares against, the last-read seed, the
 * draft the debounced save and the close/unmount flush write from) is
 * per-campaign, and the values a React effect still sees in the commit where
 * the campaign changed are the PREVIOUS campaign's. A remount resets all of
 * them at once, in the one place React already guarantees the ordering — the
 * old mount's unmount flush still runs first, so the previous campaign's draft
 * is saved under its own tag before the new mount seeds from the new campaign's
 * tag. An effect-based reset would have to re-derive that ordering by hand
 * (state, refs and the flush's own ref) in the same commit.
 */
export function NewModuleDialog({
  campaign,
  open,
  onOpenChange,
}: NewModuleDialogProps): JSX.Element {
  return (
    <NewModuleDialogContent
      key={campaign.id}
      campaign={campaign}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

/** The dialog body: one instance per open dialog per campaign (see above). */
function NewModuleDialogContent({
  campaign,
  open,
  onOpenChange,
}: NewModuleDialogProps): JSX.Element {
  const navigate = useNavigate();
  const [concept, setConcept] = useState('');
  const [levelMin, setLevelMin] = useState(1);
  const [levelMax, setLevelMax] = useState(3);
  const [tone, setTone] = useState('');
  const [sizeDial, setSizeDial] = useState<ModuleSizeDial>('standard');
  const [includePriorModules, setIncludePriorModules] = useState(false);
  const [autoApproveSpine, setAutoApproveSpine] = useState(false);
  const [autoGenerateKinds, setAutoGenerateKinds] = useState<EntityKind[]>([]);
  const [autoImageKinds, setAutoImageKinds] = useState<EntityKind[]>([]);
  // Master switch for this module's automatic battlemaps (owner request:
  // "when automating encounters, battlemap creation should run automatically
  // with defaults") — ON by default; unticking keeps maps manual for this
  // module. It gates BOTH the post-run automation for every encounter this
  // module creates and the post-parts sweep (post-generation.ts).
  const [autoGenerateBattlemaps, setAutoGenerateBattlemaps] = useState(true);
  // Opt-in mob-portrait automation (the battlemaps toggle's portrait
  // equivalent): gates the post-parts sweep's portrait enqueue for every
  // encounter this module creates (post-generation.ts). Off by default —
  // image work stays explicit per module.
  const [autoGenerateMobImages, setAutoGenerateMobImages] = useState(false);
  // Advanced (08 §M4-B, amended): the module's numeric encounter floor,
  // recorded on the row at creation.
  const [encounterFloorGuardrail, setEncounterFloorGuardrail] = useState<EncounterFloorGuardrail>(
    defaultEncounterFloorGuardrail(),
  );
  const [starting, setStarting] = useState(false);

  // The stored draft (pure read — never `getSettings`, which writes). Held in
  // a ref as well: `flush` (run start, dialog close) must save the CURRENT
  // values without re-subscribing every render.
  const settings = useLiveQuery(() => readSettings(), []);
  const draftRef = useRef<NewModuleDraft>(defaultNewModuleDraft(campaign.id));
  // Seeded once per open: an edit made while the settings row was still
  // loading must never be overwritten by the arriving prefill.
  const seededRef = useRef(false);
  // The dialog's own defaults for THIS open — the yardstick for "the user has
  // already changed something" before the prefill lands.
  const pristineRef = useRef<NewModuleDraft>(defaultNewModuleDraft(campaign.id));
  // True once the user has edited anything: the arriving prefill is then
  // SKIPPED for this open (the user's typing wins) instead of clobbering it.
  //
  // Armed SYNCHRONOUSLY by the interactions themselves (`markEdited`, called
  // from every handler and toggle) and never by an effect. That is the whole
  // guarantee: the prefill's decision is taken by an effect, so an edit whose
  // flag is armed by ANOTHER effect can lose the race — React may apply the
  // arriving prefill in the very commit that carries the user's keystrokes
  // (measured: the seed ran first, wrote the stored draft over the field and
  // left the rest of the typing appended to it, i.e. "A harbor bell rings
  // underwater." came back as "harbor bell rings underwater."). A flag set by
  // the interaction itself is already true whenever any effect runs.
  const touchedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Marks the form as the USER's: from here on the stored draft is never applied
   * again in this open, and the form's values are the ones that get saved. Call
   * this synchronously from the interaction that changes a value — see
   * `touchedRef` above for why an effect may not do it.
   */
  function markEdited(): void {
    touchedRef.current = true;
  }

  /**
   * Persists the draft NOW (validated at the settings boundary). A failure is
   * LOUD (AGENTS 2) but never blocks creating the module — the draft is a
   * convenience, not the artifact.
   */
  const persist = useCallback(async (draft: NewModuleDraft): Promise<void> => {
    try {
      await updateSettings({ newModuleDraft: draft });
    } catch (error) {
      toastError('The New Module draft could not be saved', error);
    }
  }, []);

  /**
   * Cancels the pending debounce and persists the current draft immediately.
   *
   * Only the USER's values are ever written back. The prefill's values are the
   * row's already — and a snapshot that arrived after the form was seeded can
   * even be OLDER than the row (see the seed effect), so writing an untouched
   * form back could only put an older draft over a newer one: closing a
   * just-reopened dialog would erase the very edit the close before it saved.
   * No edit this open ⇒ nothing to save.
   */
  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!touchedRef.current) return;
    void persist(draftRef.current);
  }, [persist]);

  // Prefill the stored draft — once per OPEN (and once per MOUNT: the campaign
  // is a mount identity, see `NewModuleDialog`) — and only while the form is
  // still the row's. The stored draft is prefilled only when its campaign tag
  // matches the campaign being created in; another campaign's draft is left
  // untouched and this dialog opens at its defaults.
  const seedDraft = useCallback(
    (stored: NewModuleDraft | null | undefined): void => {
      const matches = stored?.campaignId === campaign.id;
      const draft = matches ? stored : defaultNewModuleDraft(campaign.id);
      draftRef.current = draft;
      setConcept(draft.concept);
      setLevelMin(draft.levelMin);
      setLevelMax(draft.levelMax);
      setTone(draft.tone);
      setSizeDial(draft.sizeDial);
      setIncludePriorModules(draft.includePriorModules);
      setAutoApproveSpine(draft.autoApproveSpine);
      setAutoGenerateKinds([...draft.autoGenerateKinds]);
      setAutoImageKinds([...draft.autoImageKinds]);
      setAutoGenerateBattlemaps(draft.autoGenerateBattlemaps);
      setAutoGenerateMobImages(draft.autoGenerateMobImages);
      setEncounterFloorGuardrail(draft.encounterFloorGuardrail);
    },
    [campaign.id],
  );

  //
  // The ROW stays the source of truth for an untouched form, so a newer
  // snapshot replaces an older prefill. It has to: the close's `flush` reaches
  // the settings live query a DB round trip after the dialog has reopened, so a
  // reopen can prefill a snapshot OLDER than the draft it just wrote (measured
  // with the stored-draft read delayed: the reopen prefilled "" over the field
  // the user had filled, and the next close then wrote that stale value back
  // over the row — the draft was destroyed). The first snapshot to arrive after
  // an open is therefore not the last word; every later one is applied too,
  // until the user touches the form. From that moment nothing may overwrite it
  // (`touchedRef` above) — typing always wins, in this open and every later
  // snapshot of it.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      seededRef.current = false;
      pristineRef.current = defaultNewModuleDraft(campaign.id);
      touchedRef.current = false;
    }
    if (settings === undefined) return;
    // The settings row arrived after the user already started editing: their
    // values stand and the prefill is skipped for this open (the draft they
    // wrote is still in the row — nothing is lost, and the next open prefills).
    if (touchedRef.current) {
      seededRef.current = true;
      return;
    }
    const stored = settings.newModuleDraft;
    const draft =
      stored !== null && stored.campaignId === campaign.id
        ? stored
        : defaultNewModuleDraft(campaign.id);
    seededRef.current = true;
    // A snapshot the form already shows changes nothing — and skipping it here
    // is what keeps a re-emission (every settings write re-runs the live query)
    // from churning the prefill and the save effect.
    if (draftsEqual(draft, draftRef.current)) return;
    seedDraft(stored);
    // `campaign.id` is a dependency because the seed is campaign-scoped: the
    // pristine defaults this effect arms the "an edit already happened" test
    // with are that campaign's, and `seedDraft`'s tag check reads it. Inside
    // one mount it cannot change (the campaign is the mount key), so the extra
    // runs only re-apply the same snapshot.
  }, [open, settings, seedDraft, campaign.id]);

  // Debounced save on every change. Only the USER's edits are saved: before the
  // prefill lands the form may still show this dialog's pristine defaults, and
  // after it lands the form may still be showing a snapshot older than the row,
  // so a write of an untouched form could only destroy what is stored.
  useEffect(() => {
    const next: NewModuleDraft = {
      campaignId: campaign.id,
      concept,
      levelMin,
      levelMax: Math.max(levelMax, levelMin),
      tone,
      sizeDial,
      includePriorModules,
      autoApproveSpine,
      autoGenerateKinds: [...autoGenerateKinds],
      autoImageKinds: [...autoImageKinds],
      autoGenerateBattlemaps,
      autoGenerateMobImages,
      encounterFloorGuardrail,
    };
    // The ref always mirrors what the form shows, so `flush` saves the CURRENT
    // values no matter when it runs.
    draftRef.current = next;
    if (!touchedRef.current) {
      // Prefill not read yet: a value that differs from the pristine defaults
      // is a user edit, and it must survive the arriving prefill. (Every
      // interaction marks the form itself — this is the backstop for a change
      // that reached the state some other way.)
      if (!seededRef.current && !draftsEqual(next, pristineRef.current)) touchedRef.current = true;
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void persist(draftRef.current);
    }, DRAFT_DEBOUNCE_MS);
  }, [
    campaign.id,
    concept,
    levelMin,
    levelMax,
    tone,
    sizeDial,
    includePriorModules,
    autoApproveSpine,
    autoGenerateKinds,
    autoImageKinds,
    autoGenerateBattlemaps,
    autoGenerateMobImages,
    encounterFloorGuardrail,
    persist,
  ]);

  // Unmount (route change, campaign switch) must not lose the last edit.
  useEffect(() => flush, [flush]);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      // Closing the dialog flushes: the last edit survives even if it landed
      // inside the debounce window.
      if (!next) flush();
      onOpenChange(next);
    },
    [flush, onOpenChange],
  );

  /**
   * Reset to the dialog's own defaults (prefill's escape hatch). The reset is a
   * user edit like any other: it must latch, or an arriving snapshot of the
   * draft just discarded would bring it straight back.
   */
  function resetToDefaults(): void {
    markEdited();
    seedDraft(null);
  }

  // The opt-in continuity checkbox is only meaningful when some other module
  // of this campaign actually carries authored text (premise or parts).
  const priorModules = useLiveQuery(() => listModulesByCampaign(campaign.id), [campaign.id]);
  const hasPriorText = (priorModules ?? []).some(
    (module) =>
      (module.spine?.premise ?? '') !== '' || module.parts.some((part) => part.markdown !== ''),
  );

  const canStart = concept.trim() !== '' && !starting;

  /** Toggles one kind in one of the two automation lists (persisted on the row). */
  function toggleKind(
    list: EntityKind[],
    setList: (next: EntityKind[]) => void,
    kind: EntityKind,
  ): void {
    setList(list.includes(kind) ? list.filter((entry) => entry !== kind) : [...list, kind]);
  }

  /**
   * One guardrail count: integers only, never below `min` (0 everywhere except
   * an enabled floor, which needs at least 1). A cleared/invalid field falls
   * back to `min` instead of writing NaN — the stored value is always a valid
   * integer, so a draft can never come back invalid.
   */
  function guardrailCountInput(
    min: number,
    write: (current: EncounterFloorGuardrail, value: number) => EncounterFloorGuardrail,
  ): (event: { target: { value: string } }) => void {
    return (event): void => {
      markEdited();
      const parsed = Number.parseInt(event.target.value, 10);
      const value = Number.isNaN(parsed) ? min : Math.max(min, parsed);
      setEncounterFloorGuardrail((current) => write(current, value));
    };
  }

  async function start(): Promise<void> {
    setStarting(true);
    try {
      // The draft is saved BEFORE the navigation: a run started now survives a
      // reload, and the deleted-module retry later finds these exact values.
      flush();
      // Fully-specified creation input (the dialog always sends a tone).
      // `createModuleAndRun` forwards this object verbatim to `createModule`,
      // so the additive automation fields and the guardrails ride along.
      const input: NewModule & { tone: string } = {
        campaignId: campaign.id,
        title: 'New Module',
        concept: concept.trim(),
        levelMin,
        levelMax: Math.max(levelMax, levelMin),
        tone: tone.trim(),
        sizeDial,
        includePriorModules,
        autoApproveSpine,
        autoGenerateKinds,
        autoImageKinds,
        autoGenerateBattlemaps,
        autoGenerateMobImages,
        encounterFloorGuardrail,
      };
      const moduleId = await createModuleAndRun(campaign, input);
      onOpenChange(false);
      navigate(modulePath(campaign.id, moduleId));
    } catch (error) {
      // Only creation-setup failures land here (e.g. the row could not be
      // saved); the spine draft reports its own failures on the module row
      // and via toast, and the reader shows them with a Retry.
      toastError('The module could not be created', error);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="new-module-dialog">
        <DialogHeader>
          <DialogTitle>New Module</DialogTitle>
          <DialogDescription>
            The spine (premise + part plan) is drafted first and shown for your approval; parts are
            written afterwards, one per level band.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="module-concept">Concept</Label>
            <Textarea
              id="module-concept"
              rows={3}
              placeholder="e.g. 'smugglers' cove gone eldritch — the party raids a smuggling den that has dug into something older.'"
              value={concept}
              onChange={(event) => {
                markEdited();
                setConcept(event.target.value);
              }}
            />
          </div>

          <div className="flex items-end gap-3">
            <LevelStepper
              id="module-level-min"
              label="Level from"
              value={levelMin}
              onChange={(next) => {
                markEdited();
                setLevelMin(next);
              }}
            />
            <LevelStepper
              id="module-level-max"
              label="Level to"
              value={Math.max(levelMax, levelMin)}
              min={levelMin}
              onChange={(next) => {
                markEdited();
                setLevelMax(next);
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="module-tone">Tone (optional)</Label>
            <Input
              id="module-tone"
              placeholder="e.g. grim, folk-horror, swashbuckling…"
              value={tone}
              onChange={(event) => {
                markEdited();
                setTone(event.target.value);
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Size</Label>
            <div className="flex gap-1" role="group" aria-label="Module size">
              {SIZES.map((size) => (
                <Button
                  key={size}
                  type="button"
                  variant={sizeDial === size ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  aria-pressed={sizeDial === size}
                  onClick={() => {
                    markEdited();
                    setSizeDial(size);
                  }}
                >
                  {MODULE_SIZE_LABELS[size]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Target part length: sketch ≈ 400–700 words, standard ≈ 800–1500, detailed ≈ 1500–2500.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="module-include-prior"
              checked={includePriorModules}
              disabled={!hasPriorText}
              onCheckedChange={(checked) => {
                markEdited();
                setIncludePriorModules(checked);
              }}
            />
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="module-include-prior"
                className={hasPriorText ? '' : 'text-muted-foreground'}
              >
                Continue from previous modules
              </Label>
              <p className="text-xs text-muted-foreground">
                {hasPriorText
                  ? 'Give the generator the other modules of this campaign — premises and part texts, drafts included — as settled history to continue.'
                  : 'No previous modules with text in this campaign yet.'}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="module-auto-spine"
              data-testid="auto-spine"
              checked={autoApproveSpine}
              onCheckedChange={(checked) => {
                markEdited();
                setAutoApproveSpine(checked);
              }}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="module-auto-spine">Generate parts without review</Label>
              <p className="text-xs text-muted-foreground">
                Skip the spine checkpoint: the generated premise and part plan are approved as-is
                and the parts are written immediately. The plan cannot be reshaped beforehand —
                parts stay individually editable and rewritable afterwards.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>After the parts are written</Label>
            <div className="rounded-md border p-2" data-testid="module-automation-grid">
              <div className="flex items-center gap-2 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                <span className="flex-1">Artifact type</span>
                <span className="w-14 text-center">Generate</span>
                <span className="w-14 text-center">Image</span>
              </div>
              {ENTITY_KINDS.map((kind) => (
                <div key={kind} className="flex items-center gap-2 py-0.5">
                  <span className="flex-1 text-sm">{KIND_LABELS[kind]}</span>
                  <span className="flex w-14 justify-center">
                    <Checkbox
                      aria-label={`Auto-generate ${KIND_LABELS[kind]} artifacts`}
                      data-testid={`auto-generate-${kind}`}
                      checked={autoGenerateKinds.includes(kind)}
                      onCheckedChange={() => {
                        markEdited();
                        toggleKind(autoGenerateKinds, setAutoGenerateKinds, kind);
                      }}
                    />
                  </span>
                  <span className="flex w-14 justify-center">
                    <Checkbox
                      aria-label={`Auto-generate images for ${KIND_LABELS[kind]} artifacts`}
                      data-testid={`auto-image-${kind}`}
                      checked={autoImageKinds.includes(kind)}
                      onCheckedChange={() => {
                        markEdited();
                        toggleKind(autoImageKinds, setAutoImageKinds, kind);
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="module-auto-battlemaps"
                data-testid="auto-battlemaps"
                checked={autoGenerateBattlemaps}
                onCheckedChange={(checked) => {
                  markEdited();
                  setAutoGenerateBattlemaps(checked);
                }}
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="module-auto-battlemaps">Generate encounter battlemaps</Label>
                <p className="text-xs text-muted-foreground">
                  Automatic and on by default: every encounter this module creates (or already has
                  without a battlemap) gets an unattended map run with the campaign's defaults —
                  aspect from Settings, the dungeon tier only for dungeon encounters. Untick to keep
                  battlemaps manual (needs image generation in Settings).
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="module-auto-mob-images"
                data-testid="auto-mob-images"
                checked={autoGenerateMobImages}
                onCheckedChange={(checked) => {
                  markEdited();
                  setAutoGenerateMobImages(checked);
                }}
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="module-auto-mob-images">Generate encounter mob images</Label>
                <p className="text-xs text-muted-foreground">
                  Every encounter this module creates queues a portrait for its rulebook-cited
                  roster creatures — one per creature kind, grounded in the cited stat-block entry
                  and canonically cached, so the same creature reuses its portrait everywhere (needs
                  image generation in Settings).
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Runs once the parts finish: unresolved wiki-links of the checked types are detailed,
              images attach to their artifacts, every encounter gets its battlemap, and its
              creatures queue for their portraits. Everything can also be run manually from the
              entity panel.
            </p>
          </div>

          <details className="rounded-md border p-2" data-testid="module-guardrails-advanced">
            <summary className="cursor-pointer text-sm font-medium select-none">
              Advanced — encounter guardrails
            </summary>
            <div className="flex flex-col gap-3 pt-3">
              <p className="text-xs text-muted-foreground">
                How many encounters the generator must name per level of the module. This number is
                written into the generation prompt AND enforced when the module is generated — it is
                recorded on this module, so its later rewrites and retries keep using it. The default
                is today's value: one distinct encounter per level.
              </p>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="guardrail-floor-enabled"
                  data-testid="guardrail-floor-enabled"
                  checked={encounterFloorGuardrail.enabled}
                  onCheckedChange={(checked) => {
                    markEdited();
                    setEncounterFloorGuardrail((current) => ({
                      perLevel: checked ? Math.max(1, current.perLevel) : 0,
                      enabled: checked,
                    }));
                  }}
                />
                <div className="flex flex-1 items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor="guardrail-floor-enabled">Encounter floor</Label>
                    <p className="text-xs text-muted-foreground">
                      Off = no minimum count of named encounters at all.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="guardrail-floor-per-level" className="text-xs">
                      Per level
                    </Label>
                    <Input
                      id="guardrail-floor-per-level"
                      data-testid="guardrail-floor-per-level"
                      type="number"
                      min={0}
                      max={10}
                      className="w-20 text-center"
                      disabled={!encounterFloorGuardrail.enabled}
                      value={encounterFloorGuardrail.perLevel}
                      onChange={guardrailCountInput(0, (current, value) => ({
                        enabled: current.enabled,
                        perLevel: value,
                      }))}
                    />
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="guardrail-reset"
                onClick={() => {
                  markEdited();
                  setEncounterFloorGuardrail(defaultEncounterFloorGuardrail());
                }}
              >
                Reset to today's defaults
              </Button>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="new-module-reset"
            onClick={resetToDefaults}
          >
            Reset to defaults
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button disabled={!canStart} onClick={() => void start()} data-testid="start-module">
            {starting ? 'Creating…' : 'Draft spine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LevelStepper({
  id,
  label,
  value,
  min = 1,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}): JSX.Element {
  function clamp(next: number): number {
    return Math.min(20, Math.max(min, next));
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => {
            onChange(clamp(value - 1));
          }}
        >
          <MinusIcon aria-hidden />
        </Button>
        <Input
          id={id}
          type="number"
          min={min}
          max={20}
          value={value}
          aria-label={label}
          className="w-16 text-center"
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (!Number.isNaN(parsed)) onChange(clamp(parsed));
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Increase ${label}`}
          onClick={() => {
            onChange(clamp(value + 1));
          }}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
