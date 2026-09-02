import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { ScopeToggles } from '@/domain';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export type ScopeSurface = 'workspace' | 'moduleView';

export interface ScopeControlProps {
  /** Which surface's stored preference this control edits (D3/D4). */
  surface: ScopeSurface;
}

const TOGGLES: { key: keyof ScopeToggles; label: string }[] = [
  { key: 'global', label: 'Global' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'module', label: 'Module' },
];

/**
 * Artifact scope control (10-MILESTONE-6 D3): three toggles deciding which
 * ownership scopes a surface shows. The preference persists per surface in
 * settings — workspace starts Campaign + Module, the module view starts with
 * everything visible (D4) — so hiding the library is the user's explicit
 * choice, never a data change.
 */
export function ScopeControl({ surface }: ScopeControlProps): JSX.Element | null {
  const settings = useLiveQuery(async () => readSettings(), []);
  if (settings === undefined) return null;
  const toggles = settings.artifactScopes[surface];

  async function setToggle(key: keyof ScopeToggles, value: boolean | 'indeterminate'): Promise<void> {
    const current = await readSettings();
    await updateSettings({
      artifactScopes: {
        ...current.artifactScopes,
        [surface]: { ...current.artifactScopes[surface], [key]: value === true },
      },
    });
  }

  return (
    <div className="flex items-center gap-2" data-testid="scope-control" data-surface={surface}>
      {TOGGLES.map(({ key, label }) => (
        <Label
          key={key}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
        >
          <Checkbox
            checked={toggles[key]}
            data-testid={`scope-toggle-${key}`}
            onCheckedChange={(checked) => {
              void setToggle(key, checked);
            }}
          />
          {label}
        </Label>
      ))}
    </div>
  );
}
