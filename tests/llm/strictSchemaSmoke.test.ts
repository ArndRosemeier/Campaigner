import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import { moduleEntityKindSchema, moduleSpineSchema } from '@/domain';
import { normalizationReplySchema } from '@/domain/entityNormalization';
import { statBlockSchema } from '@/domain/statblock';
import {
  continuityReportSchema,
  encounterDraftSchema,
  encounterGeneratorBriefSchema,
  factionDraftSchema,
  imagePromptDraftSchema,
  locationDraftSchema,
  noteDraftSchema,
  npcDraftSchema,
  pcDraftSchema,
  plotArcDraftSchema,
} from '@/llm/schemas';
import { strictJsonSchema } from '@/llm/strictSchema';

const spineReply = z.object({
  ...moduleSpineSchema.shape,
  entities: z.array(moduleEntityKindSchema),
});

const CONTRACTS: Record<string, z.ZodType> = {
  'pc-draft': pcDraftSchema,
  'npc-draft': npcDraftSchema,
  'location-draft': locationDraftSchema,
  'faction-draft': factionDraftSchema,
  'note-draft': noteDraftSchema,
  'plotarc-draft': plotArcDraftSchema,
  'encounter-draft': encounterDraftSchema,
  'encounter-brief': encounterGeneratorBriefSchema,
  statblock: statBlockSchema,
  'continuity-report': continuityReportSchema,
  'image-prompt-draft': imagePromptDraftSchema,
  'module-spine': spineReply,
  'entity-normalization': normalizationReplySchema,
};

function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  visit(record);
  for (const property of Object.values(record.properties ?? {})) {
    walk(property, visit);
  }
  if (record.items !== undefined) walk(record.items, visit);
  for (const member of (record.anyOf ?? []) as unknown[]) walk(member, visit);
}

describe('smoke: every LLM contract converts to the strict subset', () => {
  for (const [name, schema] of Object.entries(CONTRACTS)) {
    it(`converts ${name}`, () => {
      const { schema: json } = strictJsonSchema(name, schema);
      let violation: string | null = null;
      walk(json, (node) => {
        if (node.type === 'object') {
          if (node.additionalProperties !== false) violation = 'additionalProperties';
          const required = (node.required ?? []) as string[];
          const keys = Object.keys((node.properties ?? {}));
          if (keys.some((key) => !required.includes(key))) violation = 'not-all-required';
        }
        if ('propertyNames' in node) violation = 'propertyNames';
      });
      expect(violation).toBeNull();
    });
  }
});
