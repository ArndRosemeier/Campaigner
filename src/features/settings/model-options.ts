import { listModels } from '@/llm/openrouter';

/**
 * THE account model-id option source (docs/17 row 193, docs/18 §2.3): the ONE
 * way a model-choice control turns the account's OpenRouter models into the
 * free-form id list it offers. `ModelInput`'s default browse list (the chat,
 * embedding and persona fields) and the top-bar model picker all call THIS, so
 * the app performs one `/models` fetch through one seam instead of a second
 * copied fetch at the picker (AGENTS rule 4). `listModels` is the transport
 * seam beneath it and caches the response for the session (`llm/modelCache`).
 *
 * `fetchOptions` on a `ModelInput` remains the escape hatch for a DIFFERENT
 * list (the image models, filtered by `listImageModels`) — not a second
 * chat-model source.
 */
export async function listModelIds(): Promise<string[]> {
  return (await listModels()).map((model) => model.id);
}
