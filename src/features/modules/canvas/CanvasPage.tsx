import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  BanIcon,
  LoaderCircleIcon,
  SaveIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { canvasPath, modulePath, modulesPath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Module } from '@/domain';
import { cancelModuleGen } from '@/llm/moduleGen';
import { saveModulePartText } from '@/features/modules/partText';
import { useArtifacts, useCampaign, useGlobalArtifacts } from '@/features/campaign/hooks';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { useModule } from '@/features/modules/hooks';
import { CanvasEditor } from '@/features/modules/canvas/canvasEditor';
import { activeCanvasView } from '@/features/modules/canvas/canvasView';
import {
  resolveCanvasScope,
  scopeKey,
  scopeParam,
  type CanvasScope,
  type PlannedPart,
} from '@/features/modules/canvas/canvasScope';
import { pendingSuggestions } from '@/features/modules/canvas/suggestions';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Module canvas (08-MODULE-DESIGNER §Module canvas): ChatGPT-canvas-style
 * document co-authoring for ONE module part — a CodeMirror 6 markdown
 * document (the doc string IS the markdown, byte-exact) with wiki-link chips,
 * AI proposals rendered as suggestions, and every accepted text landing
 * through THE one part-text save path. ONE part is edited at a time; the
 * part selector (premise + parts by planIndex) is the scope control, and
 * deep links open a chosen part (`?part=<planIndex|premise>`, `#part-<n>`
 * honored — the reader's convention).
 */

export function CanvasPage(): JSX.Element {
  const { campaignId = '', moduleId = '' } = useParams<{
    campaignId: string;
    moduleId: string;
  }>();
  const campaign = useCampaign(campaignId === '' ? undefined : campaignId);
  const module = useModule(moduleId === '' ? undefined : moduleId);
  const artifacts = useArtifacts(campaignId === '' ? undefined : campaignId);
  const globalArtifacts = useGlobalArtifacts();
  const location = useLocation();
  const navigate = useNavigate();

  const plans = useMemo<PlannedPart[]>(() => {
    if (module === null || module === undefined) return [];
    if (module.spine === null) return [];
    return module.spine.partPlan.map((plan, planIndex) => ({      planIndex,
      title: plan.title,
      levelBand: plan.levelBand,
    }));
  }, [module]);

  const scope = useMemo<CanvasScope>(
    () => resolveCanvasScope(location.search, location.hash, plans),
    [location.search, location.hash, plans],
  );

  // Part text lives in the EDITOR (the doc string is the truth); the page
  // mirrors it only as a render trigger for the Save affordance and the
  // part-switch guard (the guard re-reads the live editor view).
  const [docText, setDocText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<CanvasScope | null>(null);
  // Adjusting state during render (React's derive-state pattern): a scope
  // change remounts the editor, so unsaved-edit tracking resets NOW, not a
  // frame later — the guard can never read the previous part's dirtiness.
  const [renderedScopeKey, setRenderedScopeKey] = useState(scopeKey(scope));
  if (renderedScopeKey !== scopeKey(scope)) {
    setRenderedScopeKey(scopeKey(scope));
    setDocText(null);
  }

  if (
    campaign === undefined ||
    module === undefined ||
    artifacts === undefined ||
    globalArtifacts === undefined
  ) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (campaign === null) {
    return <MissingCanvas message="This campaign does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  if (module === null) {
    return <MissingCanvas message="This module does not exist (it may have been deleted)." campaignId={campaignId} />;
  }
  const currentModule: Module = module;
  if (currentModule.spine === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This module has no spine yet — the canvas edits its parts once the spine exists.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link to={modulesPath(campaignId)} />}
          nativeButton={false}
        >
          Back to modules
        </Button>
      </div>
    );
  }

  const busy = currentModule.status === 'generating';
  const pool = [...artifacts, ...globalArtifacts];
  const scopeIsPart = scope.kind === 'part';
  const part =
    scope.kind === 'part'
      ? currentModule.parts.find((entry) => entry.planIndex === scope.planIndex)
      : undefined;
  const partMarkdown = scope.kind === 'part' ? (part?.markdown ?? '') : '';
  // Dirty = the live doc diverged from the saved row (the mirror updates on
  // every editor change; the save itself re-reads the live editor view).
  const dirty = scopeIsPart && docText !== null && docText !== partMarkdown;

  /** The selector's switch request — a pending proposal or unsaved edits
   * die with the screen, so switching away needs an explicit loud confirm. */
  function requestScopeSwitch(target: CanvasScope): void {
    const sameScope =
      (target.kind === 'premise' && scope.kind === 'premise') ||
      (target.kind === 'part' &&
        scope.kind === 'part' &&
        target.planIndex === scope.planIndex);
    if (sameScope) return;
    const view = activeCanvasView.current;
    const pendingCount = view === null ? 0 : pendingSuggestions(view.state).length;
    if (pendingCount > 0 || dirty) {
      setSwitchTarget(target);
      return;
    }
    navigate(canvasPath(campaignId, moduleId, scopeParam(target)));
  }

  async function savePart(): Promise<void> {
    if (scope.kind !== 'part' || saving) return;
    const doc = activeCanvasView.current?.state.doc.toString();
    if (doc === undefined) return;
    setSaving(true);
    try {
      await saveModulePartText(currentModule.id, scope.planIndex, doc);
      setDocText(doc);
      toastSuccess('Part saved');
    } catch (error) {
      toastError('Could not save the part', error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="module-canvas">
      <header className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
        <Button
          variant="ghost"
          size="xs"
          render={<Link to={modulePath(campaignId, moduleId)} />}
          nativeButton={false}
        >
          <ArrowLeftIcon aria-hidden data-icon="inline-start" />
          Reader
        </Button>
        <span className="font-heading text-sm font-semibold" data-testid="canvas-module-title">
          {currentModule.title}
        </span>
        {busy ? (
          <>
            <Badge variant="secondary">
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              generating
            </Badge>
            <Button
              variant="outline"
              size="xs"
              data-testid="canvas-stop"
              onClick={() => {
                cancelModuleGen(currentModule.id);
              }}
            >
              <BanIcon aria-hidden data-icon="inline-start" />
              Stop
            </Button>
          </>
        ) : (
          <Badge variant="secondary">{currentModule.status}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={scope.kind === 'premise' ? 'premise' : String(scope.planIndex)}
            items={{
              premise: 'Premise',
              ...Object.fromEntries(
                plans.map((plan) => [
                  String(plan.planIndex),
                  `Part ${String(plan.planIndex + 1)}: ${plan.title}`,
                ]),
              ),
            }}
            onValueChange={(value) => {
              requestScopeSwitch(
                value === 'premise' ? { kind: 'premise' } : { kind: 'part', planIndex: Number(value) },
              );
            }}
          >
            <SelectTrigger aria-label="Part" className="w-64" data-testid="canvas-part-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="premise">Premise (read-only)</SelectItem>
              {plans.map((plan) => (
                <SelectItem key={String(plan.planIndex)} value={String(plan.planIndex)}>
                  {`Part ${String(plan.planIndex + 1)}: ${plan.title}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {scope.kind === 'part' && (
            <Button
              variant="outline"
              size="xs"
              disabled={!dirty || saving || busy}
              data-testid="canvas-save"
              onClick={() => {
                void savePart();
              }}
            >
              <SaveIcon aria-hidden data-icon="inline-start" />
              {saving ? 'Saving…' : 'Save part'}
            </Button>
          )}
        </div>
      </header>

      {scope.kind === 'premise' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl">
            <p
              className="mb-4 flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
              data-testid="canvas-premise-notice"
            >
              <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
              The premise is read-only in canvas v1 — it is generated with the spine. Switch to a
              part to co-author its markdown.
            </p>
            <article className="prose-module" data-testid="canvas-premise-body">
              <WikiMarkdown
                value={currentModule.spine.premise}
                artifacts={pool}
                moduleId={currentModule.id}
              />
            </article>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {plans.find((plan) => plan.planIndex === scope.planIndex)?.title ??
                `Part ${String(scope.planIndex + 1)}`}
            </span>
            <span>
              Levels {plans.find((plan) => plan.planIndex === scope.planIndex)?.levelBand ?? '?'}
            </span>
            {part?.edited === true && <Badge variant="outline">edited</Badge>}
          </div>
          <CanvasEditor
            key={scopeKey(scope)}
            initialMarkdown={partMarkdown}
            artifacts={pool}
            moduleId={currentModule.id}
            onChange={setDocText}
          />
        </div>
      )}


      <AlertDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
      >
        <AlertDialogContent data-testid="canvas-switch-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this part?</AlertDialogTitle>
            <AlertDialogDescription>
              Pending proposals and unsaved edits live only on this screen — switching parts
              discards them (the saved module text is unaffected). Session staging dies on reload
              too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              data-testid="canvas-switch-confirm"
              onClick={() => {
                const target = switchTarget;
                setSwitchTarget(null);
                if (target !== null) {
                  navigate(canvasPath(campaignId, moduleId, scopeParam(target)));
                }
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MissingCanvas({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button
        variant="outline"
        size="sm"
        render={<Link to={modulesPath(campaignId)} />}
        nativeButton={false}
      >
        Back to modules
      </Button>
    </div>
  );
}
