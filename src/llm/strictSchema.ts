import { z } from 'zod';

import { errorMessage } from '@/lib/errors';

/**
 * Strict structured outputs (owner decision): every JSON contract is sent to
 * OpenRouter as `response_format: { type: 'json_schema', json_schema: {
 * name, strict: true, schema } }`, which enforces the schema token-level
 * during decoding — the model CANNOT produce a wrong shape. This module owns
 * the zod → JSON-Schema conversion and the strict-subset normalization.
 *
 * Conversion convention (zod 4, `z.toJSONSchema` with `io: 'output'`):
 *
 * - `.default(x)` fields come out REQUIRED (zod v4 marks defaulted fields
 *   required in output mode): the decoder forces the model to emit a
 *   concrete value, so the runtime default only ever fires for non-LLM
 *   inputs (old rows, hand edits, pack imports).
 * - `.optional()` fields come out NOT required; strict mode requires every
 *   key, so the normalizer re-adds them as required + nullable
 *   (`"type": [t, "null"]` / `anyOf` with null). The LLM-facing schemas wrap
 *   such fields so `null` parses back to `undefined` (the "absentable"
 *   convention in /src/llm/schemas.ts) — consumers keep their old shape.
 * - `z.preprocess`/coercion wrappers emit their INNER output schema: under
 *   constrained decoding the model can only produce the canonical shape, and
 *   the preprocessors keep tolerating legacy variants at parse time.
 * - Free-form `z.record()` maps emit `propertyNames` + a schema-valued
 *   `additionalProperties`, which strict mode cannot represent (OpenAI-style
 *   strict forbids arbitrary keys). Such properties are DROPPED from the
 *   emitted schema (the model can neither omit nor invent them; the runtime
 *   default covers them). Known instance: StatBlock `extras` — LLM-drafted
 *   stat blocks therefore carry no extras; hand edits and pack imports still
 *   do.
 * - Constraint keywords (minLength, minimum, minItems, …) are stripped:
 *   strict decoders reject or ignore them, and the zod parse enforces them
 *   at the boundary regardless.
 * - Recursive schemas (`$ref` cycles) THROW: constrained decoding cannot
 *   express them. No current contract recurses — if one appears, this fails
 *   loudly at call time instead of silently degrading.
 */

export interface SchemaResponseFormat {
  kind: 'schema';
  /** OpenAI-style schema name ([A-Za-z0-9_-], ≤ 64 chars). */
  name: string;
  /** The normalized strict-subset JSON Schema. */
  jsonSchema: Record<string, unknown>;
}

/** A schema that cannot be expressed in the strict subset — loud, by design. */
export class StrictSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictSchemaError';
  }
}

/** Keywords the strict decoders reject or ignore; the zod boundary keeps
 * enforcing whatever they expressed. `default` carries no decoding meaning
 * under all-required emission. */
const STRIP_KEYWORDS = new Set([
  '$schema',
  'default',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
]);

/** OpenAI-style schema name validation: `[A-Za-z0-9_-]{1,64}`. */
function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sanitized)) {
    throw new StrictSchemaError(`invalid strict-schema name: "${name}"`);
  }
  return sanitized;
}

/** True when the node is zod's emission of a free-form record
 * (`propertyNames` + schema-valued `additionalProperties`). */
function isRecordNode(node: Record<string, unknown>): boolean {
  return 'propertyNames' in node;
}

/** Wraps a schema node so `null` also validates (strict mode has no
 * "optional": every key is present, absence is expressed as null). */
function nullableOf(node: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(node.enum)) return { anyOf: [node, { type: 'null' }] };
  if (typeof node.type === 'string') return { ...node, type: [node.type, 'null'] };
  if (Array.isArray(node.type)) {
    const types = node.type.map((member) => String(member));
    return types.includes('null') ? node : { ...node, type: [...types, 'null'] };
  }
  if (Array.isArray(node.anyOf)) {
    const members: unknown[] = node.anyOf;
    return { ...node, anyOf: [...members, { type: 'null' }] };
  }
  return { anyOf: [node, { type: 'null' }] };
}

const UNSUPPORTED_COMPOSITION = new Set(['oneOf', 'allOf', 'not']);

/**
 * Recursively normalizes one converted node into the strict subset:
 * objects → `additionalProperties: false` with ALL keys required (formerly
 * optional ones become nullable), records dropped, unsupported keywords
 * stripped, composition forms zod does not emit rejected loudly.
 */
function normalizeNode(node: unknown): Record<string, unknown> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new StrictSchemaError('unexpected non-object JSON-Schema node');
  }
  const record: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  for (const keyword of UNSUPPORTED_COMPOSITION) {
    if (keyword in record) {
      throw new StrictSchemaError(`strict schemas do not support "${keyword}" nodes`);
    }
  }
  if ('$ref' in record || '$defs' in record || 'definitions' in record) {
    throw new StrictSchemaError(
      'strict structured outputs do not support recursive/reused ($ref) schemas — rewrite the contract without recursion',
    );
  }
  // Strip unsupported keywords (never `delete`: rebuild the node).
  const cleaned: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(record)) {
    if (!STRIP_KEYWORDS.has(keyword)) cleaned[keyword] = value;
  }

  if (Array.isArray(cleaned.anyOf)) {
    cleaned.anyOf = (cleaned.anyOf as unknown[]).map(normalizeNode);
  }
  if (cleaned.type === 'array' && cleaned.items !== undefined) {
    cleaned.items = normalizeNode(cleaned.items);
  }
  if (cleaned.type === 'object') {
    const properties = (cleaned.properties ?? {}) as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(cleaned.required) ? (cleaned.required as string[]) : [],
    );
    const kept: Record<string, unknown> = {};
    for (const [key, rawProperty] of Object.entries(properties)) {
      if (rawProperty === null || typeof rawProperty !== 'object') {
        throw new StrictSchemaError(`property "${key}" is not a schema object`);
      }
      if (isRecordNode(rawProperty as Record<string, unknown>)) {
        // Free-form record (e.g. StatBlock.extras): strict mode cannot
        // represent arbitrary keys — the property is dropped from the
        // emitted schema entirely; the runtime default covers it.
        continue;
      }
      const normalized = normalizeNode(rawProperty);
      kept[key] = originalRequired.has(key) ? normalized : nullableOf(normalized);
    }
    cleaned.properties = kept;
    cleaned.required = Object.keys(kept);
    cleaned.additionalProperties = false;
  }
  return cleaned;
}

/**
 * Converts a zod schema into the strict structured-outputs subset. Throws
 * `StrictSchemaError` on anything the subset cannot express (recursion,
 * records at the root, unexpected nodes) — loud by design.
 */
export function strictJsonSchema(
  name: string,
  zodSchema: z.ZodType,
): { name: string; schema: Record<string, unknown> } {
  let raw: Record<string, unknown>;
  try {
    raw = z.toJSONSchema(zodSchema, {
      io: 'output',
      unrepresentable: 'throw',
      cycles: 'throw',
      reused: 'inline',
    });
  } catch (error) {
    // zod throws on cycles/unrepresentable nodes — rebranded so every
    // conversion failure is the same loud, typed error.
    throw new StrictSchemaError(
      `schema "${name}" cannot be converted to a strict JSON schema: ${errorMessage(error)}`,
    );
  }
  if (raw.type !== 'object') {
    throw new StrictSchemaError(
      `schema "${name}" must describe an object at the root (got "${String(raw.type)}")`,
    );
  }
  if (isRecordNode(raw)) {
    throw new StrictSchemaError(`schema "${name}" is a free-form record at the root`);
  }
  return { name: sanitizeName(name), schema: normalizeNode(raw) };
}

/** Builds the ChatOptions.responseFormat value for one contract. */
export function schemaResponseFormat(name: string, zodSchema: z.ZodType): SchemaResponseFormat {
  const strict = strictJsonSchema(name, zodSchema);
  return { kind: 'schema', name: strict.name, jsonSchema: strict.schema };
}

/** Builds the ChatOptions.responseFormat value from a PRE-converted JSON
 * Schema (no zod source): the caller owns strict-subset conformance. */
export function rawSchemaResponseFormat(
  name: string,
  jsonSchema: Record<string, unknown>,
): SchemaResponseFormat {
  return { kind: 'schema', name: sanitizeName(name), jsonSchema };
}
