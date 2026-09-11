import 'fake-indexeddb/auto';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import type { AnyArtifact, Id } from '@/domain';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { clearDatabase } from '../db/helpers';

/**
 * The chip's hover tooltip (docs/17 row 100, docs/05 §The chip): EVERY
 * wiki-link chip shows the token it was WRITTEN from — byte-exact, inner
 * spacing included — ahead of whatever the chip already said.
 *
 * The owner's report, verbatim: *"i would like to have a hover tooltip over
 * all Wikilinks where the raw text of the link is displayed. Some things are
 * just not visible in the rendered version, like encounter parameters."*
 *
 * The token is not recoverable after the FACT: `remarkWikiLinks` rewrites a
 * text run into a synthetic link node whose only child is the DISPLAY text, so
 * the source bytes have to be carried at that moment. They ride the node's
 * `data.hProperties` (verified against react-markdown 10.1.0 +
 * mdast-util-to-hast 13.2.1 in this arc) and arrive as `data-wiki-raw`.
 *
 * The pins below are deliberately written so that a RECONSTRUCTION from
 * name+display cannot pass any of them (see the non-vacuity block at the
 * bottom, which asserts the two plausible reconstructions are NOT what the
 * chip carries).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

/** The owner's own shape: the display text hides the target AND the token. */
const PADDED_TOKEN = '[[ Ash Gate |the gate]]';
const PLAIN_TOKEN = '[[Ash Gate]]';
const MISSING_TOKEN = '[[Kael]]';

let campaignId: Id;

async function seedArtifact(name: string, kind: 'npc' | 'location' = 'npc'): Promise<AnyArtifact> {
  return createArtifact({
    campaignId,
    kind,
    name,
    summary: '',
    body: '',
  });
}

beforeEach(async () => {
  await clearDatabase();
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  campaignId = campaign.id;
});

describe('a resolved chip', () => {
  it('shows the byte-exact token FIRST, then the kind and name', async () => {
    const gate = await seedArtifact('Ash Gate');
    render(<WikiMarkdown value={`Beyond it lies ${PADDED_TOKEN}.`} artifacts={[gate]} />);

    const chip = screen.getByTestId('wiki-chip');
    // The rendered label is the display text — the target is invisible here,
    // which is exactly the complaint.
    expect(chip).toHaveTextContent('the gate');
    expect(chip).toHaveAttribute('data-wiki-name', 'Ash Gate');
    expect(chip).toHaveAttribute('title', '[[ Ash Gate |the gate]] — NPC Ash Gate');
    // The carrier is inspectable on the element itself, independent of the
    // tooltip string.
    expect(chip).toHaveAttribute('data-wiki-raw', PADDED_TOKEN);
  });

  it('shows a plain token byte-exact too', async () => {
    const gate = await seedArtifact('Ash Gate');
    render(<WikiMarkdown value={`Beyond it lies ${PLAIN_TOKEN}.`} artifacts={[gate]} />);

    expect(screen.getByTestId('wiki-chip')).toHaveAttribute(
      'title',
      '[[Ash Gate]] — NPC Ash Gate',
    );
  });

  it('uses the artifact KIND label the chip already used', async () => {
    const tower = await seedArtifact('Old Tower', 'location');
    render(<WikiMarkdown value={`See ${PLAIN_TOKEN.replace('Ash Gate', 'Old Tower')}.`} artifacts={[tower]} />);

    expect(screen.getByTestId('wiki-chip')).toHaveAttribute(
      'title',
      '[[Old Tower]] — Location Old Tower',
    );
  });
});

describe('an unresolved chip', () => {
  it('shows the token AND keeps "not detailed yet"', () => {
    render(<WikiMarkdown value={`Ask ${MISSING_TOKEN} about it.`} artifacts={[]} />);

    const chip = screen.getByTestId('wiki-chip-unresolved');
    expect(chip).toHaveAttribute('data-wiki-raw', MISSING_TOKEN);
    expect(chip).toHaveAttribute('title', '[[Kael]] — Kael — not detailed yet');
    // The old sentence survives INTACT as the tail — nothing the chip said
    // before was traded away for the token.
    expect(chip.getAttribute('title')).toContain('Kael — not detailed yet');
  });
});

describe('an ambiguous chip', () => {
  it('shows the token AND keeps the ⚠ candidate list', async () => {
    // Two campaign rows of the SAME name: the reader keeps its ⚠ verdict.
    await seedArtifact('Ash Gate');
    await seedArtifact('Ash Gate');
    const pool = await import('@/db/artifactRepo').then((repo) => repo.listArtifactsByCampaign(campaignId));

    render(<WikiMarkdown value={`Beyond it lies ${PLAIN_TOKEN}.`} artifacts={pool} />);

    const chip = screen.getByTestId('wiki-chip');
    expect(chip).toHaveAttribute('data-wiki-ambiguous', 'true');
    expect(chip).toHaveAttribute(
      'title',
      '[[Ash Gate]] — ⚠ 2 artifacts match “Ash Gate”: Ash Gate, Ash Gate',
    );
    // The old warning survives intact as the tail.
    expect(chip.getAttribute('title')).toContain('⚠ 2 artifacts match “Ash Gate”');
  });
});

describe('non-vacuity: a reconstruction is NOT accepted', () => {
  it('carries neither plausible rebuild of the token from name + display', async () => {
    const gate = await seedArtifact('Ash Gate');
    render(<WikiMarkdown value={`Beyond it lies ${PADDED_TOKEN}.`} artifacts={[gate]} />);

    const title = screen.getByTestId('wiki-chip').getAttribute('title') ?? '';
    const raw = screen.getByTestId('wiki-chip').getAttribute('data-wiki-raw') ?? '';

    // The two things an implementation without the source bytes could build.
    const fromNameOnly = '[[Ash Gate]]';
    const fromNameAndDisplay = '[[Ash Gate|the gate]]';

    expect(raw).toBe(PADDED_TOKEN);
    expect(raw).not.toBe(fromNameOnly);
    expect(raw).not.toBe(fromNameAndDisplay);
    // And the tooltip LEADS with the real token, not a rebuild.
    expect(title.startsWith(PADDED_TOKEN)).toBe(true);
    expect(title.startsWith(`${fromNameOnly} —`)).toBe(false);
    expect(title.startsWith(`${fromNameAndDisplay} —`)).toBe(false);
  });
});

describe('surfaces that must NOT grow a raw-token tooltip', () => {
  it('leaves a plain markdown link alone', () => {
    render(<WikiMarkdown value="See [the gate](https://example.com/gate) for more." artifacts={[]} />);

    const link = screen.getByRole('link', { name: 'the gate' });
    expect(link).toHaveAttribute('href', 'https://example.com/gate');
    expect(link).not.toHaveAttribute('title');
    expect(document.querySelector('[data-wiki-raw]')).toBeNull();
    expect(screen.queryByTestId('wiki-chip')).toBeNull();
    expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
  });

  it('leaves a token inside a code span literal — no chip, no tooltip', () => {
    render(<WikiMarkdown value={`Write \`${MISSING_TOKEN}\` to link a name.`} artifacts={[]} />);

    // The brackets are visible because it is CODE — that is the point of the
    // span, not a chip whose tooltip happens to hold them.
    expect(screen.getByText(MISSING_TOKEN).tagName).toBe('CODE');
    expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
    expect(screen.queryByTestId('wiki-chip')).toBeNull();
    expect(document.querySelector('[data-wiki-raw]')).toBeNull();
  });

  it('leaves a token nested in markdown link TEXT literal — no chip, no tooltip', () => {
    render(<WikiMarkdown value={`See [${MISSING_TOKEN} here](https://example.com) please.`} artifacts={[]} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByRole('link')).not.toHaveAttribute('title');
    expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
    expect(document.querySelector('[data-wiki-raw]')).toBeNull();
  });

  it('leaves a token inside a fenced code block literal — no chip, no tooltip', () => {
    render(<WikiMarkdown value={`Example:\n\n\`\`\`\n${MISSING_TOKEN}\n\`\`\`\n`} artifacts={[]} />);

    expect(screen.getByText(MISSING_TOKEN).tagName).toBe('CODE');
    expect(screen.queryByTestId('wiki-chip-unresolved')).toBeNull();
    expect(document.querySelector('[data-wiki-raw]')).toBeNull();
  });
});
