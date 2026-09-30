import { describe, expect, it } from 'vitest';

import { filesWith } from '../helpers/sourceCode';

/**
 * ONE game-system picker (docs/17 row 416): the new-campaign choice, a
 * rulebook's system and the bestiary filter all render
 * `components/game-system-select`. Before the fold two surfaces each built the
 * option list themselves (one from `GAME_SYSTEMS`, one from the label map's
 * keys), and a third was about to be added.
 */
describe('the game-system picker is one component', () => {
  it('only the shared component iterates the systems to build options', () => {
    // Both spellings the two folded copies used: the ordered list, and the
    // label map's keys.
    const builders = [
      ...filesWith('GAME_SYSTEMS.map('),
      ...filesWith('Object.keys(GAME_SYSTEM_LABELS)'),
      ...filesWith('Object.entries(GAME_SYSTEM_LABELS)'),
    ].filter((path) => !path.startsWith('src/domain/'));
    expect(builders).toEqual(['src/components/game-system-select.tsx']);
  });

  it('every system choice renders it (non-vacuity: the three known surfaces)', () => {
    expect(filesWith('<GameSystemSelect')).toEqual([
      'src/features/bestiary/bestiary-roster.tsx',
      'src/features/campaign/CampaignPickerPage.tsx',
      'src/features/rules/book-dialogs.tsx',
    ]);
  });
});
