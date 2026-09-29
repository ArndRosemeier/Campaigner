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
 * THE ADVISORS ARE DATA (rows 396/400), in ONE list (`ADVISOR_LENSES`): adding a built-in is adding
 * an entry here; a custom advisor is a Settings entry — no new function, no new UI. A lens `prompt` is plain critique
 * guidance and must never name the chat's command vocabulary (pinned by
 * tests/llm/advisors.test.ts against the real outgoing messages).
 */
export const advisorScopeSchema = z.enum(['section', 'selection', 'global']);
export type AdvisorScope = z.infer<typeof advisorScopeSchema>;

export const ADVISOR_SCOPE_LABELS: Readonly<Record<AdvisorScope, string>> = {
  section: 'This section',
  selection: 'Selection',
  global: 'Whole document',
};

export interface AdvisorLens {
  /** Stable id, persisted on the card. */
  id: string;
  /** The label the control and the card show. */
  name: string;
  /** What this advisor looks for or produces — plain guidance, never command syntax. */
  instruction: string;
  /** The scope the control pre-selects; the owner may change it per ask. */
  defaultScope: AdvisorScope;
}

/**
 * ONE list: the row-400 standard advisors and the four row-396 lenses are
 * built-ins side by side. CONTEXT is always the whole document; a scope only
 * adds a line naming what to concentrate on. The generative advisors (advance
 * the plot, next section) answer with IDEAS in prose — they never edit and are
 * never taught the command syntax.
 */
export const ADVISOR_LENSES: readonly AdvisorLens[] = [
  {
    id: 'critique',
    name: 'Critique',
    defaultScope: 'global',
    instruction:
      'Critique what is there: name its concrete weaknesses — vague, contradictory, thin, cliched or unclear passages — and say why each one hurts the module.',
  },
  {
    id: 'more-details',
    name: 'More details',
    defaultScope: 'section',
    instruction:
      'Say where the text needs more detail (sensory description, names, motives, read-aloud lines, practical specifics the GM will lack at the table) and suggest concretely WHAT to add, as ideas in prose.',
  },
  {
    id: 'less-details',
    name: 'Less details',
    defaultScope: 'section',
    instruction:
      'Say where the text carries more detail than the table needs (repetition, over-explained backstory, ornament that slows play) and name what could be cut or condensed.',
  },
  {
    id: 'advance-plot',
    name: 'Advance the plot inside a section',
    defaultScope: 'section',
    instruction:
      'Propose how the story could move forward from within this section: complications, revelations, reversals and choices that raise the stakes. Offer a few distinct ideas in prose; do not write the finished text.',
  },
  {
    id: 'next-section',
    name: 'Create next section',
    defaultScope: 'global',
    instruction:
      'Propose what the NEXT section of the module could be, given everything before it: its purpose, place, opposition, a key choice and how it hooks onto what the players just did. Offer ideas in prose, not finished text.',
  },
  {
    id: 'tension-pacing',
    name: 'Tension & pacing',
    defaultScope: 'global',
    instruction:
      'Judge tension and pacing: where does momentum sag, where does a scene overstay or rush, is there escalation across the levels, is there a payoff for each build-up?',
  },
  {
    id: 'continuity',
    name: 'Continuity & consistency',
    defaultScope: 'global',
    instruction:
      'Judge continuity and consistency: contradictions between levels, names or facts that change, motives that do not hold, events that ignore what came before.',
  },
  {
    id: 'agency-stakes',
    name: 'Player agency & stakes',
    defaultScope: 'global',
    instruction:
      'Judge player agency and stakes: where do the players only watch, where is there no real choice, what do they stand to win or lose, are consequences visible?',
  },
  {
    id: 'encounter-balance',
    name: 'Encounter & difficulty balance',
    defaultScope: 'global',
    instruction:
      'Judge encounter and difficulty balance: are fights and challenges fair for the intended party level, is the variety of challenge types sufficient, are there spikes or lulls in danger?',
  },
];

/**
 * A CUSTOM advisor (Settings.customAdvisors, global to the owner, no DB bump).
 * Validated at the boundary: a blank name or instruction is a loud error.
 */
export const customAdvisorSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, 'An advisor needs a name'),
  instruction: z.string().trim().min(1, 'An advisor needs an instruction'),
  defaultScope: advisorScopeSchema,
});

/** Every advisor the owner can resolve an id against: built-ins, then custom. */
export function allAdvisors(custom: readonly AdvisorLens[]): AdvisorLens[] {
  return [...ADVISOR_LENSES, ...custom];
}

/** The advisors OFFERED: built-ins minus the hidden ones, then the custom list. */
export function visibleAdvisors(
  custom: readonly AdvisorLens[],
  hidden: readonly string[],
): AdvisorLens[] {
  return allAdvisors(custom).filter((advisor) => !hidden.includes(advisor.id));
}

export function advisorLens(id: string, custom: readonly AdvisorLens[] = []): AdvisorLens | undefined {
  return allAdvisors(custom).find((lens) => lens.id === id);
}

/** What an advisor was asked to concentrate on (persisted on its card). */
export const advisorScopeTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }),
  z.object({ scope: z.literal('section'), level: z.number().int(), title: z.string() }),
  z.object({
    scope: z.literal('selection'),
    level: z.number().int(),
    title: z.string(),
    text: z.string(),
  }),
]);
export type AdvisorScopeTarget = z.infer<typeof advisorScopeTargetSchema>;

function quoted(text: string): string[] {
  return text.split('\n').map((line) => `> ${line}`);
}

/** The ONE scope statement: the advisor prompt and the approval text both use it. */
export function advisorScopeLines(target: AdvisorScopeTarget): string[] {
  switch (target.scope) {
    case 'global':
      return ['Concentrate on the whole document.'];
    case 'section':
      return [`Concentrate on the section "${target.title}" (level ${String(target.level)}).`];
    case 'selection':
      return [
        `Concentrate on this selected passage, from the section "${target.title}" (level ${String(target.level)}):`,
        ...quoted(target.text),
      ];
  }
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
  /** Row 396 cards only (the level-range cut was retired in row 400: context is always the whole document). */
  range: z.object({ min: z.number().int(), max: z.number().int() }).nullable().default(null),
  /** Row 400: what the advisor concentrated on. Absent on older cards. */
  scope: advisorScopeTargetSchema.optional(),
  state: advisorCardStateSchema.default('pending'),
});
export type AdvisorCard = z.infer<typeof advisorCardSchema>;

/**
 * The user turn APPROVE sends into the normal chat: clearly attributed, the
 * critique quoted verbatim. Free text goes through untouched (AGENTS rule 5).
 */
export function advisorApprovalText(card: AdvisorCard, critique: string): string {
  const scope = card.scope === undefined ? [] : advisorScopeLines(card.scope);
  return [
    `An advisor (${card.lensName}; model: ${card.model}) reviewed the document and offers the advice below. Weigh it and decide what, if anything, to change.`,
    ...(scope.length === 0 ? [] : ['', `Scope of the advice: ${scope[0] ?? ''}`, ...scope.slice(1)]),
    '',
    'The advice:',
    ...quoted(critique),
  ].join('\n');
}
