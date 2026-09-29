import { z } from 'zod';

/**
 * ADVISORS (docs/17 row 396, docs/23 BUILD STATE): adversarial critique inside
 * the canvas chat. Several ADVISORS comment on the module document, but only
 * ONE editor — the main chat model — ever changes it. An advisor is a separate
 * model call with its own context; it is never told the edit-command syntax and
 * can never write. Its answer is plain critique prose shown as a card the owner
 * APPROVES (the critique is then sent through the normal chat as a user turn) or
 * DISMISSES.
 *
 * THE LENSES ARE DATA, in ONE list (`ADVISOR_LENSES`): adding a lens is adding
 * an entry here — no new function, no new UI. A lens `prompt` is plain critique
 * guidance and must never name the chat's command vocabulary (pinned by
 * tests/llm/advisors.test.ts against the real outgoing messages).
 */
export interface AdvisorLens {
  /** Stable id, persisted on the card. */
  id: string;
  /** The label the control and the card show. */
  name: string;
  /** What this advisor looks for — plain critique guidance. */
  prompt: string;
}

export const ADVISOR_LENSES: readonly AdvisorLens[] = [
  {
    id: 'tension-pacing',
    name: 'Tension & pacing',
    prompt:
      'Judge tension and pacing: where does momentum sag, where does a scene overstay or rush, is there escalation across the levels, is there a payoff for each build-up?',
  },
  {
    id: 'continuity',
    name: 'Continuity & consistency',
    prompt:
      'Judge continuity and consistency: contradictions between levels, names or facts that change, motives that do not hold, events that ignore what came before.',
  },
  {
    id: 'agency-stakes',
    name: 'Player agency & stakes',
    prompt:
      'Judge player agency and stakes: where do the players only watch, where is there no real choice, what do they stand to win or lose, are consequences visible?',
  },
  {
    id: 'encounter-balance',
    name: 'Encounter & difficulty balance',
    prompt:
      'Judge encounter and difficulty balance: are fights and challenges fair for the intended party level, is the variety of challenge types sufficient, are there spikes or lulls in danger?',
  },
];

export function advisorLens(id: string): AdvisorLens | undefined {
  return ADVISOR_LENSES.find((lens) => lens.id === id);
}

export const advisorCardStateSchema = z.enum(['pending', 'approved', 'dismissed']);
export type AdvisorCardState = z.infer<typeof advisorCardStateSchema>;

/**
 * The advisor metadata of a chat message (`moduleChatMessageSchema.advisor`).
 * `lensId` is a plain string, not the lens enum: a lens removed later must not
 * make an old thread unreadable. The critique itself is the message `text`; a
 * failed advisor is `status: 'failed'` with `error`.
 */
export const advisorCardSchema = z.object({
  lensId: z.string(),
  lensName: z.string(),
  /** The model that actually answered. */
  model: z.string(),
  /** The level range the advisor was shown, or null = the whole document. */
  range: z.object({ min: z.number().int(), max: z.number().int() }).nullable().default(null),
  state: advisorCardStateSchema.default('pending'),
});
export type AdvisorCard = z.infer<typeof advisorCardSchema>;

/**
 * The user turn APPROVE sends into the normal chat: clearly attributed, the
 * critique quoted verbatim. Free text goes through untouched (AGENTS rule 5).
 */
export function advisorApprovalText(card: AdvisorCard, critique: string): string {
  return [
    `An advisor (lens: ${card.lensName}; model: ${card.model}) reviewed the document and offers this critique. Weigh it and decide what, if anything, to change.`,
    '',
    ...critique.split('\n').map((line) => `> ${line}`),
  ].join('\n');
}
