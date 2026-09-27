import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import type { Campaign } from '@/domain';
import { PersonaPanel } from '@/features/campaign/components/persona-panel';

/**
 * THE ONE way the hand-off pins mount the real persona panel (docs/17 rows
 * 374/376). The refill and illustration pin files each grew a byte-identical
 * private `renderPanel`, and the duplicate tripwire named both on the row-376
 * run — so the mount is FOLDED here and both files import it (AGENTS rule 4,
 * centralization obligation 2: a fold that no behavioural pin can see is pinned
 * by the tripwire itself, which is what caught this one at birth).
 *
 * Tests render the panel DIRECTLY, deliberately: `AppShell` is what seeds the
 * built-in personas, so `listPersonas` sees exactly what the test wrote — which
 * is how the "no illustrator persona" arm is constructible at all.
 */
export function renderPersonaPanel(campaign: Campaign): void {
  render(
    <MemoryRouter>
      <PersonaPanel campaign={campaign} hasApiKey />
    </MemoryRouter>,
  );
}
