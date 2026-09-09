import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MapIcon } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { DUNGEON_MAP_PATH_LABELS } from '@/domain';
import { toastError } from '@/lib/toast';

/**
 * Encounter-map defaults (05-UI.md §Settings): the global Map aspect /
 * Preset / Dungeon map path defaults every encounter map resolves from.
 * Same labels, copy and `updateSettings` write path as the persona panel
 * used to carry — the panel now holds per-run steering only.
 */
export function EncounterMapSection(): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);

  if (settings === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Encounter maps</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapIcon aria-hidden className="size-4" />
          Encounter maps
        </CardTitle>
        <CardDescription>
          Global defaults for every encounter map. Per-run steering (the
          encounter editor&apos;s Regenerate controls) overrides these for one
          run without changing them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="encounter-aspect">Map aspect</Label>
          <Select
            value={settings.encounterMapAspect}
            items={{ '4:3': '4:3', '16:9': '16:9', '1:1': '1:1' }}
            onValueChange={(value) => {
              if (value === '4:3' || value === '16:9' || value === '1:1') {
                void updateSettings({ encounterMapAspect: value }).catch((error: unknown) => {
                  toastError('Could not save map aspect', error);
                });
              }
            }}
          >
            <SelectTrigger id="encounter-aspect" aria-label="Map aspect">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="4:3">4:3</SelectItem>
              <SelectItem value="16:9">16:9</SelectItem>
              <SelectItem value="1:1">1:1</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="encounter-preset">Preset</Label>
          <Select
            value={settings.encounterPreset ?? 'auto'}
            items={{ auto: 'Auto', standard: 'Standard', dungeon: 'Dungeon' }}
            onValueChange={(value) => {
              if (value === 'auto' || value === 'standard' || value === 'dungeon') {
                // Auto (null) is the default: each encounter's own
                // locationKind decides its grid tier (docs/11 D10
                // amendment); Standard/Dungeon force the tier.
                void updateSettings({ encounterPreset: value === 'auto' ? null : value }).catch(
                  (error: unknown) => {
                    toastError('Could not save map preset', error);
                  },
                );
              }
            }}
          >
            <SelectTrigger id="encounter-preset" aria-label="Preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="standard">Standard</SelectItem>
              <SelectItem value="dungeon">Dungeon</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Auto: each encounter&apos;s own location kind decides — dungeons map on
            the Dungeon tier (a connected multi-room complex on a finer grid,
            each cell half the size), everything else on Standard. Standard or
            Dungeon forces the tier for every map.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="dungeon-map-path">Dungeon map path</Label>
          <Select
            value={settings.dungeonMapPath}
            items={{ classic: DUNGEON_MAP_PATH_LABELS.classic, vision: DUNGEON_MAP_PATH_LABELS.vision }}
            onValueChange={(value) => {
              if (value === 'classic' || value === 'vision') {
                // The production path for complex/multi-room maps
                // (docs/11 vision path): Classic packs vector rooms on
                // the grid; Vision paints one labeled map and locates
                // each room's plaque by sight. Singles always map
                // classic and repopulation never touches the map.
                void updateSettings({ dungeonMapPath: value }).catch((error: unknown) => {
                  toastError('Could not save dungeon map path', error);
                });
              }
            }}
          >
            <SelectTrigger id="dungeon-map-path" aria-label="Dungeon map path">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classic">{DUNGEON_MAP_PATH_LABELS.classic}</SelectItem>
              <SelectItem value="vision">{DUNGEON_MAP_PATH_LABELS.vision}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Classic packs vector rooms on the grid. Vision paints one labeled
            map and locates each room&apos;s plaque by sight — complex dungeons
            only; single arenas always map classic.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
