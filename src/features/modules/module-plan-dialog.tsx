import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { FileTextIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WriterModelId } from '@/components/writer-model-id';
import { patchModule } from '@/db/moduleRepo';
import {
  DOCUMENT_PLAN_ROLE_MEANING,
  readStoredDocumentPlan,
  type AnyArtifact,
  type DocumentPlanAudience,
  type DocumentPlanRole,
  type Id,
  type Module,
  type ModuleDocumentPlan,
} from '@/domain';
import { planModuleDocument } from '@/llm/modulePlan';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * The DOCUMENT PLAN surface (docs/17 row 109, docs/05 §Module PDF): what the
 * model decided about this module's PDF, and the ONE action that decides it
 * again.
 *
 * It is deliberately an INSPECTOR, not an editor. The owner has just paid to
 * delete a drag-and-drop outline builder, and a plan is regenerable rather than
 * hand-maintainable: the surface exists so he can SEE the model's sections,
 * their order, titles, roles, audiences and image anchors — the reason the plan
 * is stored as data at all ("he could not see or correct what the AI decided")
 * — and ask for another one. There is no add/remove/reorder control, no tree
 * and no per-node styling: the only per-section control is the AUDIENCE, which
 * is the one decision that changes what a PLAYER is allowed to read and is
 * therefore worth correcting without re-planning the whole document.
 *
 * Failure is loud here (AGENTS rule 2): a planner error (transport, invalid
 * JSON, a plan naming something that does not exist, or a module already busy
 * generating) is toasted by name and the PREVIOUS plan is left exactly as it
 * was — never a partial write, never a cleared row. A stored plan that is not
 * valid is shown with its reason (`readStoredDocumentPlan`) rather than hidden,
 * because an invalid plan is what makes the export fall back loudly.
 */
export function ModulePlanButton({
  module,
  artifacts,
  size = 'xs',
  variant = 'outline',
}: {
  module: Module;
  artifacts: readonly AnyArtifact[];
  size?: 'xs' | 'sm';
  variant?: 'outline' | 'ghost';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const turnRef = useRef<AbortController | null>(null);
  const stored = readStoredDocumentPlan(module.documentPlan);

  async function regenerate(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const turn = new AbortController();
    turnRef.current = turn;
    try {
      const { plan } = await planModuleDocument({ moduleId: module.id, artifacts, turn });
      await patchModule(module.id, { documentPlan: plan });
      toastSuccess('Planned the document');
    } catch (error) {
      if (turn.signal.aborted) {
        // A user stop is not an error (the canvas-stop convention).
        toastInfo('Planning stopped');
      } else {
        toastError('Could not plan the document', error);
      }
    } finally {
      turnRef.current = null;
      setBusy(false);
    }
  }

  /**
   * The ONE correction the surface offers. It rewrites ONE section's audience
   * on the stored plan (nothing else: no reorder, no add, no remove, no
   * styling) and writes it through the ordinary module patch, so the row is
   * re-read inside the transaction and a concurrent write cannot be lost.
   */
  async function setAudience(
    plan: ModuleDocumentPlan,
    index: number,
    audience: DocumentPlanAudience,
  ): Promise<void> {
    const sections = plan.sections.map((section, position) =>
      position === index ? { ...section, audience } : section,
    );
    try {
      await patchModule(module.id, { documentPlan: { ...plan, sections } });
    } catch (error) {
      toastError('Could not change the section’s audience', error);
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        title="See what the AI decided about this module's PDF"
        data-testid="module-plan-button"
        onClick={() => {
          setOpen(true);
        }}
      >
        <FileTextIcon aria-hidden data-icon="inline-start" />
        Document plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl" data-testid="module-plan-dialog">
          <DialogHeader>
            <DialogTitle>Document plan</DialogTitle>
            <DialogDescription>
              The AI decides the structure of this module’s PDF — the sections, their order,
              titles, roles, audience and which existing images print. The renderer decides how
              every one of them looks, so the same plan always prints the same document.
            </DialogDescription>
          </DialogHeader>

          {stored.status === 'absent' ? (
            <p className="text-muted-foreground" data-testid="module-plan-absent">
              No plan yet — this module’s PDFs print the procedural outline (premise, part plan,
              parts, one chapter per kind, gallery, treasure).
            </p>
          ) : stored.status === 'invalid' ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive"
              data-testid="module-plan-invalid"
            >
              This module’s stored plan is not a valid document plan, so the PDF falls back to the
              procedural outline and says so on its page: {stored.reason}
            </div>
          ) : (
            <PlanSections
              plan={stored.plan}
              module={module}
              artifacts={artifacts}
              disabled={busy}
              onAudience={setAudience}
            />
          )}

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              data-testid={stored.status === 'valid' ? 'module-plan-regenerate' : 'module-plan-generate'}
              onClick={() => {
                void regenerate();
              }}
            >
              {busy ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" data-icon="inline-start" />
              ) : (
                <RefreshCwIcon aria-hidden data-icon="inline-start" />
              )}
              {busy
                ? 'Planning…'
                : stored.status === 'valid'
                  ? 'Regenerate'
                  : stored.status === 'invalid'
                    ? 'Replace it'
                    : 'Generate plan'}
            </Button>
            <Button
              variant="ghost"
              type="button"
              data-testid="module-plan-close"
              onClick={() => {
                if (busy) {
                  turnRef.current?.abort();
                  return;
                }
                setOpen(false);
              }}
            >
              {busy ? 'Stop' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The model's decision, section by section: the whole point of the surface. */
function PlanSections({
  plan,
  module,
  artifacts,
  disabled,
  onAudience,
}: {
  plan: ModuleDocumentPlan;
  module: Module;
  artifacts: readonly AnyArtifact[];
  disabled: boolean;
  onAudience: (
    plan: ModuleDocumentPlan,
    index: number,
    audience: DocumentPlanAudience,
  ) => Promise<void>;
}): JSX.Element {
  const sections = plan.sections;
  const byId = new Map<Id, AnyArtifact>(artifacts.map((artifact) => [artifact.id, artifact]));
  const partPlan = module.spine?.partPlan ?? [];
  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="module-plan-count">
          {sections.length} section{sections.length === 1 ? '' : 's'}
        </span>
        <WriterModelId model={modulePlanModel(module)} testId="module-plan-model" label="Planning model" />
      </div>
      <ScrollArea className="max-h-[50vh] pr-3">
        <ol className="flex flex-col gap-2" data-testid="module-plan-sections">
          {sections.map((section, index) => {
            const source = section.source;
            const artifact = source.type === 'part' ? undefined : byId.get(source.artifactId);
            const where =
              source.type === 'part'
                ? source.planIndex === -1
                  ? 'The premise'
                  : `Part ${String(source.planIndex + 1)} — “${partPlan[source.planIndex]?.title ?? 'unnamed part'}”`
                : artifact === undefined
                  ? `${source.artifactId} (not in this document’s pool)`
                  : `${artifact.name} · ${artifact.kind}`;
            return (
              <li
                key={`${String(index)}-${section.title}`}
                data-testid="module-plan-section"
                data-role={section.role}
                data-audience={section.audience}
                className="rounded-md border p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{index + 1}.</span>
                  <span className="font-medium">{section.title}</span>
                  <Badge variant="secondary">{ROLE_LABELS[section.role]}</Badge>
                  <Badge variant="outline">{AUDIENCE_LABELS[section.audience]}</Badge>
                  {section.images.length > 0 ? (
                    <Badge variant="outline" data-testid="module-plan-anchors">
                      {section.images.length} image{section.images.length === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {where} · {DOCUMENT_PLAN_ROLE_MEANING[section.role]}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Audience</span>
                  <Select
                    value={section.audience}
                    disabled={disabled}
                    items={AUDIENCE_LABELS}
                    onValueChange={(value) => {
                      if (value === null) return;
                      void onAudience(plan, index, value);
                    }}
                  >
                    <SelectTrigger
                      className="w-40"
                      aria-label={`Audience of ${section.title}`}
                      data-testid={`module-plan-audience-${String(index)}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          <span>{label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </>
  );
}

/** The recorded planning model, or `null` (never invented from settings). */
function modulePlanModel(module: Module): string | null {
  const stored = readStoredDocumentPlan(module.documentPlan);
  return stored.status === 'valid' ? stored.plan.plannedByModel : null;
}

const ROLE_LABELS: Readonly<Record<DocumentPlanRole, string>> = {
  explanation: 'Explanation',
  'read-aloud': 'Read-aloud',
  'gm-note': 'GM note',
  aside: 'Aside',
};

const AUDIENCE_LABELS: Readonly<Record<DocumentPlanAudience, string>> = {
  all: 'GM + player',
  gm: 'GM only',
  player: 'Player only',
};
