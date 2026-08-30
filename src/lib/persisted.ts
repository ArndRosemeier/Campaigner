import { z } from 'zod';
import type { PersistStorage } from 'zustand/middleware';

/**
 * Shared persist-storage wrapper: zustand's persist middleware rehydrates
 * blindly by default; this validates the JSON envelope against a zod schema
 * and falls back to defaults on mismatch (T1 lesson, centralized here).
 */
const envelopeSchema = z.object({
  state: z.unknown(),
  version: z.number(),
});

export function zodPersistStorage<S>(schema: z.ZodType<S>): PersistStorage<S> {
  return {
    getItem: (name) => {
      const raw = localStorage.getItem(name);
      if (raw === null) return null;
      let json: unknown;
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        localStorage.removeItem(name);
        return null;
      }
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) {
        localStorage.removeItem(name);
        return null;
      }
      const state = schema.safeParse(parsed.data.state);
      if (!state.success) {
        localStorage.removeItem(name);
        return null;
      }
      return { state: state.data, version: parsed.data.version };
    },
    setItem: (name, value) => {
      localStorage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
    },
  };
}
