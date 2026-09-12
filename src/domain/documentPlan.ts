import { z } from 'zod';

import type { AnyArtifact } from '@/domain/artifact';
import type { Id } from '@/domain/entity';
import type { PartPlan } from '@/domain/module';

/**
 * The DOCUMENT PLAN (docs/17 row 109, docs/07 §M3-D): an LLM-authored,
 * zod-validated layout plan for ONE module's PDF, and nothing else.
 *
 * The owner's split, ratified: **the model authors the PLAN, the renderer
 * authors the PAGES.** The plan decides order, section titles, roles,
 * audiences and which existing images print where; every typographic decision
 * stays in `lib/modulePdf`. That split is what makes a re-export diffable: a
 * stored plan renders the same document twice, while a model authoring the
 * rendering itself would produce a different book on every export.
 *
 * Two hard rules shape every field below:
 *
 * 1. **A plan may only NAME things that exist.** Every section references
 *    something the module already has — a part of its own part plan (by the
 *    stable `planIndex` the part plan and the canvas both use, `-1` = the
 *    premise), an artifact the module OWNS or MENTIONS (by id), or an
 *    encounter among those (by id) — plus the image ids those rows already
 *    hold. `documentPlanIssues` is the ONE reference check; a name that is not
 *    there is a LOUD, named failure (AGENTS rules 1–3), never a silent skip
 *    and never a guess.
 * 2. **The plan carries no content and no styling.** There is no markdown, no
 *    pdfmake node, no font, no colour and no free-form role vocabulary here:
 *    the roles are the owner's layout insight, CLOSED, one renderer treatment
 *    each (`DOCUMENT_PLAN_ROLE_MEANING`). A field a model could fill with
 *    rendering instructions would make the renderer non-deterministic again —
 *    the exact thing the owner's split forbids.
 */

/** Section roles: the owner's insight, closed, one renderer treatment each. */
export const documentPlanRoleSchema = z.enum(['explanation', 'read-aloud', 'gm-note', 'aside']);

export type DocumentPlanRole = z.infer<typeof documentPlanRoleSchema>;

/** Every role, in the order the planner prompt lists them. */
export const DOCUMENT_PLAN_ROLES: readonly DocumentPlanRole[] = [
  'explanation',
  'read-aloud',
  'gm-note',
  'aside',
];

/**
 * What each role IS (owner's words: "the explanation is the body", the
 * module's own narration is read-aloud, "mechanical content is a GM note", and
 * a genuinely parenthetical insert is an aside). The planner is told these
 * sentences verbatim and the renderer implements exactly one treatment each
 * (docs/07 §M3-D): swapping a role changes treatment, never content.
 */
export const DOCUMENT_PLAN_ROLE_MEANING: Readonly<Record<DocumentPlanRole, string>> = {
  explanation: 'the body: explanatory prose about what this section names',
  'read-aloud': "the module's own narration, printed in the read-aloud box for the table",
  'gm-note': 'mechanical or GM-facing content, printed as a boxed GM note',
  aside: 'a short parenthetical insert, printed small and indented',
};

/** Which documents carry a section. `all` = the GM and the player document. */
export const documentPlanAudienceSchema = z.enum(['all', 'gm', 'player']);

export type DocumentPlanAudience = z.infer<typeof documentPlanAudienceSchema>;

/**
 * The audience a section carries when nothing says otherwise: the kind rules
 * that already exist are the DEFAULT the plan may override (docs/07 §M3-D) —
 * a `gm-only`-tagged row, a `note`, a `plotarc`, an encounter's
 * tactics/treasure and a faction's methods are GM material, everything else is
 * `all`. In the PLAN the model must state the audience it chose (a plan whose
 * decisions are not visible cannot be corrected), so this constant is what the
 * planner prompt derives its default from and what a section's `audience`
 * documents itself against — the renderer reads the section's own value.
 */
export const DOCUMENT_PLAN_GM_KINDS: readonly string[] = ['note', 'plotarc'];

/** The stable `planIndex` meaning "the module's premise" (the fix-01 key). */
export const DOCUMENT_PLAN_PREMISE_INDEX = -1;

/**
 * What a section is ABOUT: one thing that already exists. The union is a
 * `z.union` and not a `z.discriminatedUnion` on purpose — the strict
 * structured-output normalizer (`llm/strictSchema`) rejects the `oneOf` node
 * zod emits for a discriminated union, so a discriminated union here would
 * throw at call time. Each member is a STRICT object, so a source that carries
 * the wrong key for its own `type` is refused loudly instead of being silently
 * trimmed into a different section.
 */
export const documentPlanSourceSchema = z.union([
  z.strictObject({
    type: z.literal('part'),
    /** The module's own part key: `-1` = the premise, else a `planIndex`
     * into `spine.partPlan` (identity — never renumbered). */
    planIndex: z.number().int().min(DOCUMENT_PLAN_PREMISE_INDEX),
  }),
  z.strictObject({ type: z.literal('artifact'), artifactId: z.uuid() }),
  z.strictObject({ type: z.literal('encounter'), artifactId: z.uuid() }),
]);

export type DocumentPlanSource = z.infer<typeof documentPlanSourceSchema>;

/** How many images one section may anchor (a plate and its cover, at most). */
export const DOCUMENT_PLAN_MAX_ANCHORS = 4;

/** Sections in one plan: generous, but a plan is a document, not a dump. */
export const DOCUMENT_PLAN_MAX_SECTIONS = 60;

export const documentPlanSectionSchema = z.strictObject({
  /** The printed section title — the ONE text field the model owns. */
  title: z.string().trim().min(1),
  role: documentPlanRoleSchema,
  audience: documentPlanAudienceSchema,
  source: documentPlanSourceSchema,
  /**
   * The image ids this section anchors, in print order. Each one must be an
   * image the module ALREADY holds (`modulePdfImageRequests`' set: the module
   * cover, an artifact cover, or an encounter's map — its own row's
   * `mapImageId`, else its live battle board's); the renderer decides the
   * treatment from what the image IS, never from a plan-declared style.
   */
  images: z.array(z.uuid()).max(DOCUMENT_PLAN_MAX_ANCHORS).default([]),
});

export type DocumentPlanSection = z.infer<typeof documentPlanSectionSchema>;

/**
 * The plan as it rides the module row. `plannedByModel` / `plannedAt` are
 * PROVENANCE written by the app, never by the model (the emitted contract
 * omits them — the `writerModel` precedent, docs/17 row 93), and both are
 * additive defaults so a plan stored before them still parses.
 */
export const moduleDocumentPlanSchema = z.strictObject({
  sections: z.array(documentPlanSectionSchema).min(1).max(DOCUMENT_PLAN_MAX_SECTIONS),
  /** The `modelUsed` of the call that served this plan; `''` = not recorded. */
  plannedByModel: z.string().default(''),
  /** When the plan was generated (epoch ms); `0` = not recorded. */
  plannedAt: z.number().default(0),
});

export type ModuleDocumentPlan = z.infer<typeof moduleDocumentPlanSchema>;

/**
 * The plan AS THE MODEL EMITS IT: the same sections without the app's own
 * provenance fields. A `.default('')` field comes out REQUIRED in the strict
 * subset, which would force the decoder to invent a model id — so provenance
 * is omitted from the contract and stamped on the parsed plan by the seam.
 */
export const moduleDocumentPlanReplySchema = moduleDocumentPlanSchema.omit({
  plannedByModel: true,
  plannedAt: true,
});

export type ModuleDocumentPlanReply = z.infer<typeof moduleDocumentPlanReplySchema>;

/** The stable destination id of planned section `index` (pdfmake `id`). */
export function documentPlanSectionDestination(index: number): string {
  return `node-plan-${String(index)}`;
}

/** The stored plan's verdict: the ONE read every consumer goes through. */
export type StoredDocumentPlan =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; plan: ModuleDocumentPlan };

/** `path: message` per issue, counted — the loud reason a plan is refused. */
export function documentPlanIssueSummary(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === 'symbol' ? part.toString() : String(part)))
      .join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const head = lines.slice(0, 3).join('; ');
  return lines.length > 3 ? `${head}; and ${String(lines.length - 3)} more` : head;
}

/**
 * Reads the plan off a module row. THREE outcomes, deliberately distinct:
 *
 * - `absent` (`null`/`undefined`) is the NORMAL state — every module written
 *   before this field, and every module whose owner has not planned it. The
 *   document is then the procedural outline, silently, BY DESIGN: absence is
 *   not a failure and must never be reported as one.
 * - `invalid` is an ERROR (a corrupt or hand-edited value): the caller is
 *   expected to fall back LOUDLY, never to coerce, repair or partially apply
 *   it (AGENTS rules 1–3).
 * - `valid` carries the parsed plan.
 *
 * The row field is stored as an unvalidated value (`z.unknown()` on
 * `moduleSchema`) for exactly this reason: a corrupt plan must not make the
 * whole module row unreadable at the repo boundary — the failure belongs at
 * the document, where it can be reported and where the export still lands.
 */
export function readStoredDocumentPlan(stored: unknown): StoredDocumentPlan {
  if (stored === null || stored === undefined) return { status: 'absent' };
  const parsed = moduleDocumentPlanSchema.safeParse(stored);
  if (!parsed.success) {
    return { status: 'invalid', reason: documentPlanIssueSummary(parsed.error) };
  }
  return { status: 'valid', plan: parsed.data };
}

/** One named defect in a plan: what it names, and how that is not there. */
export interface DocumentPlanIssue {
  /** The site, addressable by the owner (the section that names it). */
  where: string;
  reason: string;
}

/**
 * What the reference check reads: the module's own structure plus the pool of
 * rows and images the document can draw from. Injected rather than imported so
 * this stays a pure domain function — `lib/modulePdf` owns the SCOPING rule
 * (`modulePdfArtifacts`) and the image inventory, and hands both in.
 */
export interface DocumentPlanContext {
  /** The module's planned parts; `[]` when the spine pass has not run. */
  partPlan: readonly PartPlan[];
  /** Whether the module has a premise (a spine) for `planIndex` `-1`. */
  hasPremise: boolean;
  /** Every artifact the module's document may draw from (owned or mentioned). */
  artifacts: readonly AnyArtifact[];
  /** Every image id the module's document can print. */
  imageIds: readonly Id[];
}

/**
 * THE reference check (hard rule 1): one named issue per section that names a
 * part, artifact, encounter or image the module does not have. Empty ⇒ the
 * plan may be applied; non-empty ⇒ NOTHING from the plan is rendered (the
 * caller falls back loudly — never a half-applied plan).
 *
 * A part whose TEXT has not been generated yet is deliberately NOT an issue:
 * the part plan entry is what the plan names, and the renderer already prints
 * its loud "part is empty" placeholder for it. A plan is therefore still
 * applicable while parts are still being written.
 */
export function documentPlanIssues(
  sections: readonly DocumentPlanSection[],
  context: DocumentPlanContext,
): DocumentPlanIssue[] {
  const issues: DocumentPlanIssue[] = [];
  const artifactsById = new Map<Id, AnyArtifact>(
    context.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const imageIds = new Set<Id>(context.imageIds);
  for (const section of sections) {
    const where = `the plan’s section “${section.title}”`;
    const source = section.source;
    // Every anchor is checked for EVERY section — including a part section, and
    // including a section whose source is broken too (the owner sees all of it,
    // not the first defect).
    for (const imageId of section.images) {
      if (imageIds.has(imageId)) continue;
      issues.push({
        where,
        reason: `it anchors image ${imageId}, but neither the module nor its encounters hold that image`,
      });
    }
    if (source.type === 'part') {
      if (source.planIndex === DOCUMENT_PLAN_PREMISE_INDEX) {
        if (!context.hasPremise) {
          issues.push({
            where,
            reason: 'it names the module’s premise, but the module has no premise yet (the spine pass has not run)',
          });
        }
      } else if (source.planIndex >= context.partPlan.length) {
        const planned = context.partPlan.length;
        issues.push({
          where,
          reason:
            `it names part ${String(source.planIndex + 1)}, but the module plans ` +
            `${String(planned)} ${planned === 1 ? 'part' : 'parts'}`,
        });
      }
      continue;
    }
    const artifact = artifactsById.get(source.artifactId);
    if (artifact === undefined) {
      issues.push({
        where,
        reason:
          `it names ${source.type} ${source.artifactId}, which this module ` +
          'neither owns nor mentions',
      });
      continue;
    }
    if (source.type === 'encounter' && artifact.kind !== 'encounter') {
      issues.push({
        where,
        reason: `it names ${artifact.name} as an encounter, but that row is a ${artifact.kind}`,
      });
    }
  }
  return issues;
}
