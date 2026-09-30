import { listModels } from '@/llm/openrouter';

/**
 * THE account model-id option source (docs/17 row 193, docs/18 §2.3): the ONE
 * way a model-choice control turns the account's OpenRouter models into the
 * free-form id list it offers. `features/settings/model-widget.ModelWidget` (the
 * ONE model-picking component, docs/17 row 199) calls THIS for both of its
 * variants and every mount, so the app performs one `/models` fetch through one
 * seam instead of a second copied fetch at a surface (AGENTS rule 4).
 * `listModels` is the transport seam beneath it and caches the response for the
 * session (`llm/modelCache`).
 *
 * `fetchOptions` on a widget remains the escape hatch for a DIFFERENT list (the
 * image models, filtered by `listImageModels`) — not a second chat-model source.
 */
export async function listModelIds(): Promise<string[]> {
  return (await listModels()).map((model) => model.id);
}
