import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useProgressStore } from '@/lib/progress';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { AnyArtifact, Deliverable, Module, OutlineNode } from '@/domain';
import { fullInclude } from '@/domain';
import { db } from '@/db/db';
import { useScopedArtifacts } from '@/features/campaign/hooks';
import {
  createDeliverable,
  deleteDeliverable,
  listDeliverablesByCampaign,
  updateDeliverable,
} from '@/db/deliverableRepo';
import { useModules } from '@/features/modules/hooks';
import { seedOutlineFromModule } from '@/features/deliverables/seed-from-module';
import { buildModulePdf } from '@/lib/modulePdf';
import { generatePdfBlob } from '@/lib/pdfExport';
import { QuickFindDialog } from '@/features/quickfind/quickfind-dialog';

/**
 * Deliverable builder (07-MILESTONE-3 M3-D): left = deliverable list, right =
 * outline editor (nested chapters/parts/artifacts/text/galleries with reorder
 * buttons — no drag-and-drop — and per-artifact include toggles), audience
 * switch, cover picker, and "Generate PDF". The player variant strips
 * secrets/GM-only nodes at render time.
 */

/** The "+ Artifact" picker target: root list, or a chapter/part by path. */
type PickerTarget = readonly number[] | null;

function childrenAtPath(nodes: OutlineNode[], path: readonly number[]): OutlineNode[] {
  if (path.length === 0) return nodes;
  const index = path[0];
  if (index === undefined) return nodes;
  const node = nodes[index];
  if (node === undefined || (node.type !== 'chapter' && node.type !== 'part')) return nodes;
  return childrenAtPath(node.children, path.slice(1));
}

function withChildrenAtPath(
  nodes: OutlineNode[],
  path: readonly number[],
  children: OutlineNode[],
): OutlineNode[] {
  if (path.length === 0) return children;
  const index = path[0];
  if (index === undefined) return children;
  return nodes.map((node, i) => {
    if (i !== index || (node.type !== 'chapter' && node.type !== 'part')) return node;
    return { ...node, children: withChildrenAtPath(node.children, path.slice(1), children) };
  });
}

export function DeliverablesPage(): JSX.Element {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const deliverables = useLiveQuery(
    () => listDeliverablesByCampaign(campaignId),    [campaignId],
  );
  const artifacts = useScopedArtifacts('workspace', campaignId);
  const images = useLiveQuery(
    () => db.images.where('campaignId').equals(campaignId).toArray(),
    [campaignId],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null);
  const [seedDialogOpen, setSeedDialogOpen] = useState(false);

  const selected = deliverables?.find((entry) => entry.id === selectedId) ?? deliverables?.[0];

  useEffect(() => {
    if (selectedId === null && deliverables !== undefined && deliverables.length > 0) {
      setSelectedId(deliverables[0]?.id ?? null);
    }
  }, [deliverables, selectedId]);

  async function create(): Promise<void> {
    const created = await createDeliverable({
      campaignId,
      title: 'New Module',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [],
    });
    setSelectedId(created.id);
  }

  async function generate(deliverable: Deliverable): Promise<void> {
    setGenerating(true);
    const progress = useProgressStore.getState();
    const jobId = `deliverable-${deliverable.id}`;
    progress.start(jobId, `Building PDF: ${deliverable.title}`, 'Laying out the document…');
    try {
      const blob = await buildModulePdf(deliverable, artifacts ?? [], generatePdfBlob);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${deliverable.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('PDF generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'PDF generation failed');
    } finally {
      progress.finish(jobId);
      setGenerating(false);
    }
  }

  /** "Seed from module" (08-M4-D): pick a module, map premise → intro text
   * node, each part → chapter (part markdown + resolved entity artifact
   * nodes, deduped first-occurrence-wins). Replaces the outline. */
  function seedFromModule(module: Module): void {
    if (selected === undefined) return;
    const outline = seedOutlineFromModule(module, artifacts ?? []);
    void updateDeliverable(selected.id, { outline });
    setSeedDialogOpen(false);
    toast.success(`Outline seeded from “${module.title}”`);
  }

  function addNode(target: PickerTarget, node: OutlineNode): void {
    if (selected === undefined) return;
    const children = childrenAtPath(selected.outline, target ?? []);
    void updateDeliverable(selected.id, {
      outline: withChildrenAtPath(selected.outline, target ?? [], [...children, node]),
    });
  }

  return (
    <div className="flex h-full min-h-0" data-testid="deliverables-page">
      <aside className="flex w-64 shrink-0 flex-col gap-2 border-r p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Deliverables</h2>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="New deliverable"
            onClick={() => {
              void create();
            }}
          >
            <PlusIcon aria-hidden className="size-4" />
          </Button>
        </div>
        {(deliverables ?? []).map((deliverable) => (
          <button
            key={deliverable.id}
            type="button"
            className={`rounded-md border px-2 py-1.5 text-left text-sm ${
              selected?.id === deliverable.id ? 'bg-accent' : 'hover:bg-accent/50'
            }`}
            onClick={() => {
              setSelectedId(deliverable.id);
            }}
          >
            <span className="font-medium">{deliverable.title}</span>
            <Badge variant="outline" className="ml-2">
              {deliverable.audience}
            </Badge>
          </button>
        ))}
        {(deliverables ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No deliverables yet.</p>
        )}
      </aside>

      {selected === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Create a deliverable to start building a module PDF.
        </div>
      ) : (
        <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="deliverable-title">Title</Label>
              <Input
                id="deliverable-title"
                value={selected.title}
                className="w-56"
                onChange={(event) => {
                  void updateDeliverable(selected.id, { title: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="deliverable-subtitle">Subtitle</Label>
              <Input
                id="deliverable-subtitle"
                value={selected.subtitle}
                className="w-64"
                onChange={(event) => {
                  void updateDeliverable(selected.id, { subtitle: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Audience</Label>
              <Select
                value={selected.audience}
                items={{ gm: 'GM', player: 'Player' }}
                onValueChange={(value) => {
                  if (value !== null) void updateDeliverable(selected.id, { audience: value });
                }}
              >
                <SelectTrigger aria-label="Audience" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gm">GM</SelectItem>
                  <SelectItem value="player">Player</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Cover image</Label>
              <Select
                value={selected.coverImageId ?? ''}
                items={Object.fromEntries([
                  ['', 'None'],
                  ...(images ?? []).map((image): [string, string] => [
                    image.id,
                    `Image ${image.id.slice(0, 6)}`,
                  ]),
                ])}
                onValueChange={(value) => {
                  void updateDeliverable(selected.id, {
                    coverImageId: value === '' || value === null ? null : value,
                  });
                }}
              >
                <SelectTrigger aria-label="Cover image" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {(images ?? []).map((image) => (
                    <SelectItem key={image.id} value={image.id}>
                      Image {image.id.slice(0, 6)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label="Seed from module"
                data-testid="seed-from-module"
                onClick={() => {
                  setSeedDialogOpen(true);
                }}
              >
                Seed from module
              </Button>
              <Button
                size="sm"
                aria-label="Generate PDF"
                disabled={generating}
                onClick={() => {
                  void generate(selected);
                }}
              >
                {generating ? 'Generating…' : 'Generate PDF'}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete deliverable"
                onClick={() => {
                  void deleteDeliverable(selected.id).then(() => {
                    setSelectedId(null);
                  });
                }}
              >
                <TrashIcon aria-hidden className="size-4" />
              </Button>
            </div>
          </div>

          <OutlineEditor
            nodes={selected.outline}
            artifacts={artifacts ?? []}
            onChange={(outline) => {
              void updateDeliverable(selected.id, { outline });
            }}
            path={[]}
            onPickArtifact={setPickerTarget}
          />
        </section>
      )}

      {pickerTarget !== null && (
        <QuickFindDialog
          open
          onOpenChange={(open) => {
            if (!open) setPickerTarget(null);
          }}
          artifacts={artifacts ?? []}
          mode="play"
          onPickArtifact={(artifact) => {
            addNode(pickerTarget, {
              type: 'artifact',
              artifactId: artifact.id,
              include: fullInclude(),
            });
            setPickerTarget(null);
          }}
        />
      )}

      {seedDialogOpen && (
        <SeedModulePickerDialog
          campaignId={campaignId}
          onClose={() => {
            setSeedDialogOpen(false);
          }}
          onSeed={(module) => {
            seedFromModule(module);
          }}
        />
      )}
    </div>
  );
}

/**
 * Module picker for "Seed from module" (08-M4-D). Owns its module query so
 * the main builder page stays query-light; mounted only while open.
 */
function SeedModulePickerDialog({
  campaignId,
  onClose,
  onSeed,
}: {
  campaignId: string;
  onClose: () => void;
  onSeed: (module: Module) => void;
}): JSX.Element {
  const modules = useModules(campaignId === '' ? undefined : campaignId);
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="seed-module-dialog">
        <DialogHeader>
          <DialogTitle>Seed from module</DialogTitle>
          <DialogDescription>
            Pick the module to build this outline from — the premise becomes the intro, every part
            becomes a chapter with its resolved entities attached. This replaces the current
            outline.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {(modules ?? []).map((module) => (
            <button
              key={module.id}
              type="button"
              className="rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onSeed(module);
              }}
            >
              <span className="font-medium">{module.title}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {module.spine === null ? 'no spine yet' : `${module.spine.partPlan.length} parts`}
              </span>
            </button>
          ))}
          {(modules ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No modules in this campaign yet.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutlineEditor({
  nodes,
  artifacts,
  onChange,
  path,
  onPickArtifact,
}: {
  nodes: OutlineNode[];
  artifacts: readonly AnyArtifact[];
  onChange: (nodes: OutlineNode[]) => void;
  path: readonly number[];
  onPickArtifact: (target: readonly number[] | null) => void;
}): JSX.Element {
  function patch(index: number, next: OutlineNode): void {
    onChange(nodes.map((node, i) => (i === index ? next : node)));
  }

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return;
    const copy = [...nodes];
    const [moved] = copy.splice(index, 1);
    if (moved === undefined) return;
    copy.splice(target, 0, moved);
    onChange(copy);
  }

  function remove(index: number): void {
    onChange(nodes.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-1" style={{ marginLeft: path.length * 16 }}>
      {nodes.map((node, index) => {
        const childPath = [...path, index];
        return (
          <div
            key={`${node.type}-${index}`}
            className="rounded-md border p-2"
            data-testid={`outline-node-${node.type}`}
          >
            <div className="flex items-center gap-1">
              {node.type === 'chapter' || node.type === 'part' ? (
                <Input
                  value={node.title}
                  aria-label={`${node.type} title`}
                  className="h-7 flex-1 text-sm"
                  onChange={(event) => {
                    patch(index, { ...node, title: event.target.value });
                  }}
                />
              ) : node.type === 'artifact' ? (
                <span className="flex-1 text-sm">
                  {artifacts.find((artifact) => artifact.id === node.artifactId)?.name ?? (
                    <em className="text-destructive">missing artifact</em>
                  )}
                </span>
              ) : node.type === 'text' ? (
                <span className="flex-1 text-sm text-muted-foreground">Text block</span>
              ) : (
                <span className="flex-1 text-sm text-muted-foreground">
                  Gallery: {node.gallery === 'npcs' ? 'NPC gallery' : 'Treasure ledger'}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move up ${node.type} ${index}`}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <ArrowUpIcon aria-hidden className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move down ${node.type} ${index}`}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <ArrowDownIcon aria-hidden className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${node.type} ${index}`}
                onClick={() => {
                  remove(index);
                }}
              >
                <TrashIcon aria-hidden className="size-3.5" />
              </Button>
            </div>

            {node.type === 'artifact' && (
              <div className="mt-1 flex flex-wrap gap-3 text-xs">
                {(['body', 'data', 'statBlocks', 'images'] as const).map((facet) => (
                  <label key={facet} className="flex items-center gap-1">
                    <Switch
                      checked={node.include[facet]}
                      onCheckedChange={(checked) => {
                        patch(index, {
                          ...node,
                          include: { ...node.include, [facet]: checked },
                        });
                      }}
                      aria-label={`Include ${facet}`}
                    />
                    <span className="capitalize">
                      {facet === 'statBlocks' ? 'stat blocks' : facet}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {node.type === 'text' && (
              <textarea
                value={node.markdown}
                aria-label="Text block markdown"
                className="mt-1 min-h-16 w-full rounded-md border bg-transparent p-2 text-sm"
                onChange={(event) => {
                  patch(index, { type: 'text', markdown: event.target.value });
                }}
              />
            )}
            {(node.type === 'chapter' || node.type === 'part') && (
              <div className="mt-1">
                <OutlineEditor
                  nodes={node.children}
                  artifacts={artifacts}
                  onChange={(children) => {
                    patch(index, { ...node, children });
                  }}
                  path={childPath}
                  onPickArtifact={onPickArtifact}
                />
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap gap-1 pt-1">
        {path.length === 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onChange([...nodes, { type: 'chapter', title: 'New chapter', children: [] }]);
            }}
          >
            + Chapter
          </Button>
        )}
        {path.length === 1 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onChange([...nodes, { type: 'part', title: 'New part', children: [] }]);
            }}
          >
            + Part
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onPickArtifact(path);
          }}
        >
          + Artifact
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onChange([...nodes, { type: 'text', markdown: '' }]);
          }}
        >
          + Text
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onChange([...nodes, { type: 'gallery', gallery: 'npcs' }]);
          }}
        >
          + NPC gallery
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onChange([...nodes, { type: 'gallery', gallery: 'treasure' }]);
          }}
        >
          + Treasure
        </Button>
      </div>
    </div>
  );
}
