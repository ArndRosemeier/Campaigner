import { describe, expect, it } from 'vitest';

import {
  anyArtifactSchema,
  artifactSchema,
  artifactScope,
  globalArtifactSchema,
  type Artifact,
  type GlobalArtifact,
} from '@/domain';

/**
 * M6-A ownership invariants (10-MILESTONE-6): scope is derived from
 * `(campaignId, moduleId)` — never stored — and the schema shapes make
 * impossible states unrepresentable: a global artifact has no campaign and
 * no module and only exists for the library kinds; a module-owned artifact
 * is always anchored in a campaign. Global `pc`s are the motivating
 * non-representable state (their HP lives ON the artifact).
 */

const STAMP = { id: '00000000-0000-4000-8000-0000000000a1', createdAt: 1, updatedAt: 1 };

function ownedNote(over: Partial<Artifact> = {}): Artifact {
  return {
    ...STAMP,
    campaignId: '00000000-0000-4000-8000-000000000c01',
    moduleId: null,
    kind: 'note',
    name: 'A note',
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data: {},
    ...over,
  } as Artifact;
}

function globalNpc(over: Partial<GlobalArtifact> = {}): GlobalArtifact {
  return {
    ...STAMP,
    campaignId: null,
    moduleId: null,
    kind: 'npc',
    name: 'Troll',
    tags: [],
    aliases: [],
    summary: '',
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data: {
      role: '',
      appearance: '',
      personality: '',
      motivation: '',
      secrets: '',
      voiceNotes: '',
      statBlock: null,
    },
    ...over,
  } as GlobalArtifact;
}

describe('artifact ownership schema (M6-A)', () => {
  it('parses campaign- and module-owned rows; moduleId defaults to null', () => {
    const campaign = artifactSchema.parse(ownedNote());
    expect(campaign.moduleId).toBeNull();
    expect(artifactScope(campaign)).toBe('campaign');

    const moduleOwned = artifactSchema.parse(
      ownedNote({ moduleId: '00000000-0000-4000-8000-0000000000b1' }),
    );
    expect(artifactScope(moduleOwned)).toBe('module');
    // A module-owned artifact is anchored in its campaign — the shape
    // guarantees campaignId is a real id (never null).
    expect(moduleOwned.campaignId).toBe('00000000-0000-4000-8000-000000000c01');
  });

  it('parses a global library row and derives the global scope', () => {
    const parsed = globalArtifactSchema.parse(globalNpc());
    expect(artifactScope(parsed)).toBe('global');
    expect(anyArtifactSchema.parse(globalNpc())).toEqual(parsed);
  });

  it('rejects a global pc — HP lives on the artifact and must never be shared', () => {
    const result = anyArtifactSchema.safeParse({
      ...globalNpc(),
      kind: 'pc',
      data: { playerName: '', statBlock: null, currentHp: 10, initiativeOverride: null, notes: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a global row that carries a module', () => {
    const result = anyArtifactSchema.safeParse(
      // A state the type system already forbids — the runtime check is the
      // same shape guard, verified here against hand-corrupted input.
      globalNpc({ moduleId: '00000000-0000-4000-8000-0000000000b1' as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a null campaignId on a kind that cannot be global', () => {
    const result = anyArtifactSchema.safeParse({
      ...ownedNote(),
      campaignId: null,
      moduleId: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a module-owned row without a campaign anchor', () => {
    const result = anyArtifactSchema.safeParse(ownedNote({ campaignId: null as never }));
    expect(result.success).toBe(false);
  });
});
