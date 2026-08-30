import { describe, expect, it } from 'vitest';

import { buildLines } from '@/ingest/buildLines';
import { item, page } from './fixtures';

describe('buildLines', () => {
  it('groups items by y (tolerance 2) and joins them left-to-right', () => {
    const [lines] = buildLines([
      page([
        item('The', 100, 700),
        item('quick', 130, 700),
        item('fox', 160, 701.5), // within tolerance → same line
        item('next line', 100, 680),
      ]),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines?.[0]?.text).toBe('The quick fox');
    expect(lines?.[1]?.text).toBe('next line');
  });

  it('marks the largest font line as a level-1 heading', () => {
    const [lines] = buildLines([
      page([
        item('Chapter 9: Combat', 72, 740, 16, 'F2'),
        item('Combat is', 72, 700),
        item('handled in rounds.', 120, 700),
        item('Initiative', 72, 680),
      ]),
    ]);

    expect(lines?.[0]?.headingLevel).toBe(1);
    expect(lines?.[1]?.headingLevel).toBe(0);
    expect(lines?.[1]?.text).toBe('Combat is handled in rounds.');
  });

  it('assigns deeper levels to smaller heading sizes across the document', () => {
    const [pageOne, pageTwo] = buildLines([
      page([
        item('Part One', 72, 740, 20, 'F2'),
        item('Body text one.', 72, 700),
        item('Body text two.', 72, 680),
        item('Body text three.', 72, 660),
      ]),
      page(
        [
          item('Section A', 72, 740, 15, 'F2'),
          item('Body text continues.', 72, 700),
          item('Another body line.', 72, 690),
          item('Subsection', 72, 680, 13, 'F2'),
          item('More body text.', 72, 660),
          item('Yet more body text.', 72, 650),
        ],
        2,
      ),
    ]);

    expect(pageOne?.[0]?.headingLevel).toBe(1);
    expect(pageOne?.[1]?.headingLevel).toBe(0);
    expect(pageTwo?.[0]?.headingLevel).toBe(2);
    expect(pageTwo?.[3]?.headingLevel).toBe(3);
  });

  it('reads left column fully before right column on two-column pages', () => {
    const [lines] = buildLines([
      page([
        item('left top', 60, 700),
        item('a', 100, 700),
        item('left bottom', 60, 500),
        item('b', 100, 500),
        item('right top', 400, 700),
        item('c', 440, 700),
        item('right bottom', 400, 500),
        item('d', 440, 500),
      ]),
    ]);

    expect(lines?.map((line) => line.text)).toEqual([
      'left top a',
      'left bottom b',
      'right top c',
      'right bottom d',
    ]);
  });
});
