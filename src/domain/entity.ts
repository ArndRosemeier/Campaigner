import { z } from 'zod';

/**
 * Base conventions shared by every persisted entity (01-DATA-MODEL §Conventions).
 * IDs are `crypto.randomUUID()`, timestamps are epoch milliseconds.
 */
export type Id = string;

export const idSchema = z.uuid();

export const BaseEntitySchema = z.object({
  id: idSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type BaseEntity = z.infer<typeof BaseEntitySchema>;

/** Generates a fresh UUID — the single place IDs are minted. */
export function newId(): Id {
  return crypto.randomUUID();
}

/** The three `BaseEntity` fields for a brand-new entity. */
export function stampNewEntity(now: number = Date.now()): BaseEntity {
  return { id: newId(), createdAt: now, updatedAt: now };
}

/** Mutable fields of an entity, i.e. everything except identity and timestamps. */
export type EntityPatch<TEntity extends BaseEntity> = Partial<Omit<TEntity, keyof BaseEntity>>;
