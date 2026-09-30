import type { JSX } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  UI_SCALES,
  useUiScaleStore,
  type UiScale,
} from '@/app/theme/uiScale';

const UI_SCALE_LABELS: Record<UiScale, string> = {
  0.9: '90%',
  1: '100%',
  1.1: '110%',
  1.25: '125%',
  1.5: '150%',
  2: '200%',
};

/**
 * Appearance card (05-UI.md §Settings): the UI-scale select. Stores the
 * chosen factor in the uiScale store (localStorage, theme precedent);
 * `useUiScaleSync` in the app shell applies it to the document root.
 */
export function AppearanceSection(): JSX.Element {
  const uiScale = useUiScaleStore((state) => state.uiScale);
  const setUiScale = useUiScaleStore((state) => state.setUiScale);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Scales controls and text app-wide; battle-map boards and 3D dice are
          unaffected.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select
          value={String(uiScale)}
          items={Object.fromEntries(
            UI_SCALES.map((factor) => [String(factor), UI_SCALE_LABELS[factor]]),
          )}
          onValueChange={(value) => {
            const factor = UI_SCALES.find((candidate) => String(candidate) === value);
            if (factor !== undefined) setUiScale(factor);
          }}
        >
          <SelectTrigger aria-label="UI scale" className="w-52" data-testid="ui-scale">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UI_SCALES.map((factor) => (
              <SelectItem key={factor} value={String(factor)}>
                {UI_SCALE_LABELS[factor]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
