import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { FolderPlusIcon, MapPinnedIcon } from 'lucide-react';

import type { Id, Module } from '@/domain';
import { useModules } from '@/features/modules/hooks';
import { listCampaigns } from '@/db/campaignRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import { modulePath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface SpawnCreature {
  name: string;
  chunkId: Id;
}

/**
 * Module picker for the bestiary roster's "Spawn into module" (owner-ratified
 * placement; re-based on the cast seam by the core-mob arc, docs/11 D4): the
 * creature is CAST as an authored NPC owned by the picked module
 * (`castCreatureAsNpc` — a real `npc` row carrying the creature's `creatureRef`
 * and prose the module designer fills in, its stats derived from the library and
 * its cover seeded from the creature's canonical portrait). Nothing is created
 * for the CREATURE itself: the library row stays read-only and uncopyable
 * (docs/11 D8), and casting the same creature under the same name twice reuses
 * the same NPC. `/rules` is campaign-agnostic, so the dialog picks
 * the campaign too — one campaign preselects itself; several require an
 * explicit choice. Zero campaigns or zero modules are named empty states,
 * never silent no-ops. Success toasts with an "Open module" action that
 * navigates to the module reader.
 */
export function SpawnModulePicker({
  creature,
  open,
  onOpenChange,
}: {
  creature: SpawnCreature | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const campaigns = useLiveQuery(async () => listCampaigns(), []);
  const [pickedCampaignId, setPickedCampaignId] = useState<Id | null>(null);

  const campaignId: Id | null =
    pickedCampaignId ?? (campaigns?.length === 1 ? campaigns[0]?.id ?? null : null);
  const modules = useModules(campaignId ?? undefined);
  const campaignName = campaigns?.find((campaign) => campaign.id === campaignId)?.name ?? '';

  async function spawn(module: Module): Promise<void> {
    if (creature === null || campaignId === null) return;
    try {
      await castCreatureAsNpc({
        campaignId,
        moduleId: module.id,
        citation: { chunkId: creature.chunkId, creatureName: creature.name },
        name: creature.name,
      });
      toastSuccess(`${creature.name} spawned into '${module.title}'`, {
        label: 'Open module',
        onClick: () => {
          navigate(modulePath(campaignId, module.id));
        },
      });
      onOpenChange(false);
    } catch (error) {
      toastError('Could not spawn the creature', error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="spawn-module-picker" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Spawn “{creature?.name ?? ''}” into which module?</DialogTitle>
          <DialogDescription>
            The creature becomes a mob artifact owned by the picked module — the battle table and
            image flows work on it like any other NPC. Spawning it elsewhere moves it there.
          </DialogDescription>
        </DialogHeader>
        {campaigns === undefined ? (
          <p className="text-sm text-muted-foreground" data-testid="spawn-picker-loading">
            Loading campaigns…
          </p>
        ) : campaigns.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-sm" data-testid="spawn-picker-no-campaigns">
            <p className="font-medium">No campaigns yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a campaign first — creatures spawn into a campaign’s modules.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {campaigns.length > 1 && (
              <Select
                value={campaignId ?? ''}
                onValueChange={(value) => {
                  if (value === null) return;
                  setPickedCampaignId(value);
                }}
              >
                <SelectTrigger className="text-sm" aria-label="Pick campaign" data-testid="spawn-campaign-select">
                  <SelectValue placeholder="Pick campaign" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((campaign) => (
                    <SelectItem key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {modules === undefined || campaignId === null ? (
              <p className="text-sm text-muted-foreground" data-testid="spawn-picker-loading">
                Loading modules…
              </p>
            ) : modules.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm" data-testid="spawn-picker-no-modules">
                <p className="font-medium">No modules in “{campaignName}” yet.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create a module from the workspace, then spawn creatures into it.
                </p>
              </div>
            ) : (
              <div className="flex max-h-72 flex-col gap-1.5 overflow-auto" data-testid="spawn-module-list">
                {modules.map((module) => (
                  <Button
                    key={module.id}
                    variant="outline"
                    className="justify-start"
                    data-testid="spawn-module-option"
                    onClick={() => {
                      void spawn(module);
                    }}
                  >
                    <MapPinnedIcon aria-hidden data-icon="inline-start" />
                    <span className="min-w-0 truncate">{module.title}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderPlusIcon aria-hidden className="size-3.5" />
          The artifact is named after the roster creature and keeps the chunk as its stat source.
        </p>
      </DialogContent>
    </Dialog>
  );
}
