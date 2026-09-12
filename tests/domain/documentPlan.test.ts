import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_PLAN_ROLES,
  documentPlanIssues,
  documentPlanSectionDestination,
  moduleDocumentPlanSchema,
  moduleDocumentPlanReplySchema,
  readStoredDocumentPlan,
  type AnyArtifact,
  type DocumentPlanSection,
  type Id,
  type PartPlan,
} from '@/domain';
import { newId } from '@/domain';

/**
 * The document plan as DATA (docs/17 row 109, docs/07 §M3-D). This file pins
 * the two halves of the contract that the renderer and the planner both rely
 * on, and nothing about rendering:
 *
 * 1. the SCHEMA — a well-formed plan parses; every malformed shape is refused
 *    WITH THE OFFENDING FIELD NAMED (never coerced, never defaulted away);
 * 2. the REFERENCE CHECK — a plan may only NAME things that exist, and a
 *    missing part, artifact, encounter or image is reported by name.
 */

const PART_PLAN: PartPlan[] = [
  { title: 'The Dockyards', levelBand: '1-2', synopsis: '', levelUpTrigger: '' },
  { title: 'The Vault', levelBand: '3', synopsis: '', levelUpTrigger: '' },
];

/** A minimal artifact stub: the reference check reads `id`, `kind`, `name`. */
function artifactStub(id: Id, kind: AnyArtifact['kind'], name: string): AnyArtifact {
  return { id, kind, name } as AnyArtifact;
}

const ARTIFACT_ID = newId();
const ENCOUNTER_ID = newId();
const IMAGE_ID = newId();

function context(overrides: Partial<Parameters<typeof documentPlanIssues>[1]> = {}) {
  return {
    partPlan: PART_PLAN,
    hasPremise: true,
    artifacts: [
      artifactStub(ARTIFACT_ID, 'location', 'Old Tower'),
      artifactStub(ENCOUNTER_ID, 'encounter', 'Pier Ambush'),
    ],
    imageIds: [IMAGE_ID],
    ...overrides,
  };
}

function section(overrides: Partial<DocumentPlanSection> = {}): DocumentPlanSection {
  return {
    title: 'The Gate',
    role: 'explanation',
    audience: 'all',
    source: { type: 'part', planIndex: 0 },
    images: [],
    ...overrides,
  };
}

describe('moduleDocumentPlanSchema — the shapes it accepts and refuses', () => {
  it('parses a well-formed plan, sections in order, anchors and all', () => {
    const parsed = moduleDocumentPlanSchema.parse({
      sections: [
        section({ title: 'The Premise', source: { type: 'part', planIndex: -1 } }),
        section({
          title: 'At the Gate',
          role: 'read-aloud',
          audience: 'gm',
          source: { type: 'artifact', artifactId: ARTIFACT_ID },
          images: [IMAGE_ID],
        }),
        section({
          title: 'The Ambush',
          role: 'gm-note',
          source: { type: 'encounter', artifactId: ENCOUNTER_ID },
        }),
        section({ title: 'A word on tides', role: 'aside', audience: 'player' }),
      ],
    });
    expect(parsed.sections.map((entry) => entry.title)).toEqual([
      'The Premise',
      'At the Gate',
      'The Ambush',
      'A word on tides',
    ]);
    // The role vocabulary is CLOSED: the four the owner named, no others.
    expect(DOCUMENT_PLAN_ROLES).toEqual(['explanation', 'read-aloud', 'gm-note', 'aside']);
    // Provenance is the app's to write, and its absence is not an error.
    expect(parsed.plannedByModel).toBe('');
    expect(parsed.plannedAt).toBe(0);
  });

  it('refuses a plan with no sections, by name', () => {
    const result = moduleDocumentPlanSchema.safeParse({ sections: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections']);
  });

  it('refuses an invented ROLE by name (no free-form styling vocabulary)', () => {
    const result = moduleDocumentPlanSchema.safeParse({
      sections: [section({ role: 'callout-box' as DocumentPlanSection['role'] })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections', 0, 'role']);
    expect(result.error?.issues[0]?.message).toContain('explanation');
  });

  it('refuses an audience outside all/gm/player by name', () => {
    const result = moduleDocumentPlanSchema.safeParse({
      sections: [section({ audience: 'table' as DocumentPlanSection['audience'] })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections', 0, 'audience']);
  });

  it('refuses an empty title by name', () => {
    const result = moduleDocumentPlanSchema.safeParse({ sections: [section({ title: '   ' })] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['sections', 0, 'title']);
  });

  it('refuses a source with the WRONG key for its type (never silently trimmed)', () => {
    // `type: 'part'` carrying an artifactId: a strict member, so this is a
    // refusal rather than a part section with the id dropped on the floor.
    const result = moduleDocumentPlanSchema.safeParse({
      sections: [
        {
          title: 'Mixed up',
          role: 'explanation',
          audience: 'all',
          source: { type: 'part', planIndex: 0, artifactId: ARTIFACT_ID },
          images: [],
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('artifactId');
  });

  it('refuses a non-uuid artifact id and a planIndex below the premise key', () => {
    expect(
      moduleDocumentPlanSchema.safeParse({
        sections: [section({ source: { type: 'artifact', artifactId: 'not-a-uuid' } })],
      }).success,
    ).toBe(false);
    expect(
      moduleDocumentPlanSchema.safeParse({
        sections: [section({ source: { type: 'part', planIndex: -2 } })],
      }).success,
    ).toBe(false);
  });

  it('refuses a plan that smuggles raw rendering content in', () => {
    // No markdown, no pdfmake node, no styling: the schema is strict, so an
    // extra key (a `body`, a `style`, a `fontSize`) is a REFUSAL, not a field
    // the renderer has to ignore.
    for (const extra of [{ body: 'raw text' }, { style: 'big' }, { fontSize: 22 }]) {
      const result = moduleDocumentPlanSchema.safeParse({
        sections: [{ ...section(), ...extra }],
      });
      expect(result.success).toBe(false);
    }
  });

  it('emits a strict contract the model can only answer with a valid plan', () => {
    // The emitted contract carries the sections and NOT the app's provenance
    // (a `.default('')` field would otherwise be REQUIRED of the decoder).
    const emitted = moduleDocumentPlanReplySchema.parse({
      sections: [section()],
    });
    expect(Object.keys(emitted)).toEqual(['sections']);
    expect(emitted.sections[0]?.images).toEqual([]);
  });
});

describe('readStoredDocumentPlan — absent is normal, invalid is an error', () => {
  it('reads absence as absent (never an error)', () => {
    expect(readStoredDocumentPlan(null).status).toBe('absent');
    expect(readStoredDocumentPlan(undefined).status).toBe('absent');
  });

  it('reads a stored plan as valid, in place', () => {
    const plan = moduleDocumentPlanSchema.parse({
      sections: [section()],
      plannedByModel: 'vendor/model-x',
      plannedAt: 1_700_000_000_000,
    });
    const read = readStoredDocumentPlan(plan);
    expect(read.status).toBe('valid');
    expect(read.status === 'valid' ? read.plan.plannedByModel : '').toBe('vendor/model-x');
  });

  it('reads a corrupt value as INVALID, naming the field', () => {
    const read = readStoredDocumentPlan({ sections: [{ title: 'x' }] });
    expect(read.status).toBe('invalid');
    expect(read.status === 'invalid' ? read.reason : '').toContain('sections.0.role');
  });
});

describe('documentPlanIssues — a plan may only name what exists', () => {
  it('passes a plan whose every reference is there', () => {
    expect(
      documentPlanIssues(
        [
          section({ source: { type: 'part', planIndex: -1 } }),
          section({ source: { type: 'artifact', artifactId: ARTIFACT_ID } }),
          section({
            source: { type: 'encounter', artifactId: ENCOUNTER_ID },
            images: [IMAGE_ID],
          }),
        ],
        context(),
      ),
    ).toEqual([]);
  });

  it('reports a missing PART by name and position', () => {
    const issues = documentPlanIssues(
      [section({ title: 'Chapter Four', source: { type: 'part', planIndex: 3 } })],
      context(),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.where).toBe('the plan’s section “Chapter Four”');
    expect(issues[0]?.reason).toContain('part 4');
    expect(issues[0]?.reason).toContain('plans 2 parts');
  });

  it('reports the PREMISE when the module has none', () => {
    const issues = documentPlanIssues(
      [section({ source: { type: 'part', planIndex: -1 } })],
      context({ hasPremise: false }),
    );
    expect(issues[0]?.reason).toContain('no premise yet');
  });

  it('reports an artifact the module neither owns nor mentions', () => {
    const stranger = newId();
    const issues = documentPlanIssues(
      [section({ title: 'Elsewhere', source: { type: 'artifact', artifactId: stranger } })],
      context(),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain(stranger);
    expect(issues[0]?.reason).toContain('neither owns nor mentions');
  });

  it('reports a row named as an encounter that is not one', () => {
    const issues = documentPlanIssues(
      [section({ source: { type: 'encounter', artifactId: ARTIFACT_ID } })],
      context(),
    );
    expect(issues[0]?.reason).toContain('Old Tower');
    expect(issues[0]?.reason).toContain('is a location');
  });

  it('reports an image the module does not hold, in ANY section', () => {
    const issues = documentPlanIssues(
      [section({ images: [newId(), IMAGE_ID] })],
      context(),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toContain('anchors image');
    expect(issues[0]?.reason).toContain('neither the module nor its encounters');
  });

  it('reports EVERY defect, not just the first (the owner sees the whole plan)', () => {
    const issues = documentPlanIssues(
      [
        section({ title: 'A', source: { type: 'part', planIndex: 9 } }),
        section({ title: 'B', images: [newId()] }),
      ],
      context(),
    );
    expect(issues.map((issue) => issue.where)).toEqual([
      'the plan’s section “A”',
      'the plan’s section “B”',
    ]);
  });

  it('gives every planned section a stable destination id', () => {
    expect(documentPlanSectionDestination(0)).toBe('node-plan-0');
    expect(documentPlanSectionDestination(11)).toBe('node-plan-11');
  });
});
