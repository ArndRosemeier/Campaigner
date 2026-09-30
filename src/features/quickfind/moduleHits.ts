import type { Module } from '@/domain';

/** One module/part match ("selecting scrolls the reader"). */
export interface ModuleHit {
  module: Module;
  /** Undefined = the module itself; else the part index. */
  partIndex?: number | undefined;
}

/** Case-insensitive substring match over module title + part titles/bands. */
export function matchModules(
  query: string,
  modules: readonly Module[],
  limit = 8,
): ModuleHit[] {
  const text = query.trim().toLowerCase();
  if (text === '') return [];
  const hits: ModuleHit[] = [];
  for (const module of modules) {
    if (module.title.toLowerCase().includes(text) && hits.length < limit) {
      hits.push({ module });
    }
    const plan = module.spine?.partPlan ?? [];
    for (const [partIndex, part] of plan.entries()) {
      if (hits.length >= limit) break;
      const haystack =
        `${part.title} ${part.levelBand} ${part.synopsis}`.toLowerCase();
      if (haystack.includes(text)) {
        hits.push({ module, partIndex });
      }
    }
  }
  return hits.slice(0, limit);
}
