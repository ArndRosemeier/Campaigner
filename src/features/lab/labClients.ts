import { getSettings } from '@/db/settingsRepo';
import { generateImages } from '@/llm/imageGen';
import { resolveChatModel, resolveImageModel } from '@/llm/modelFallback';
import { chat } from '@/llm/openrouter';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';
import {
  LABELED_DUNGEON_IMAGE_COUNT,
  buildDungeonVisionInstruction,
  buildLabeledDungeonPrompt,
  dungeonVisionReplySchema,
  runLabeledDungeonExperiment,
  type LabeledDungeonMapResult,
} from '@/features/lab/experiments/labeledDungeon';

/**
 * The production transports for the labeled-dungeon bench: the app's
 * existing image-run pipeline (`imageGen.generateImages`) and the currently
 * configured chat model (`openrouter.chat` with a vision message) — NO new
 * model pickers. The bench tests the configured models; that is the point.
 * (Lab imports FROM app seams, never the reverse.)
 */

/** Blob → in-memory data URL (FileReader; session-only images, never persisted). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error('could not read a generated map image — the bench run failed'));
    };
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Runs the labeled-dungeon bench end to end against the configured models.
 * Run-level degradations (a capped candidate count, the models actually
 * used) report through `notify` so the view renders them loudly; per-image
 * vision failures land as loud `failed` rows in the results (a chat model
 * without vision input fails loud per image saying so — a valid result,
 * never a silent skip). Generation itself throws, failing the run loud.
 */
export async function runLabeledDungeonBench(
  notify: (notice: string) => void,
): Promise<LabeledDungeonMapResult[]> {
  const settings = await getSettings();
  const imageModel = resolveImageModel(settings);
  const chatModel = resolveChatModel(settings);
  notify(`Generating with image model "${imageModel}"; vision passes with chat model "${chatModel}".`);
  try {
    return await runLabeledDungeonExperiment({
      generateMaps: async () => {
        const generated = await generateImages(buildLabeledDungeonPrompt(), LABELED_DUNGEON_IMAGE_COUNT, {
          model: imageModel,
        });
        if (generated.cappedToOne) {
          notify(
            `The image model capped the request to 1 image (asked for ${String(LABELED_DUNGEON_IMAGE_COUNT)}) — model "${generated.modelUsed}" supports only one candidate per call.`,
          );
        }
        if (generated.filteredCount > 0) {
          notify(
            `${String(generated.filteredCount)} generated candidate(s) came back filtered/empty and were dropped — model "${generated.modelUsed}".`,
          );
        }
        if (generated.fallback !== null) {
          notify(
            `Image fallback fired: "${generated.fallback.from}" failed (${generated.fallback.reason}), "${generated.fallback.to}" produced the maps.`,
          );
        }
        return {
          blobs: generated.images,
          cappedToOne: generated.cappedToOne,
          modelUsed: generated.modelUsed,
        };
      },
      visionPass: async (imageUrl: string) => {
        const reply = await chat(
          [
            {
              role: 'user',
              content: [
                { type: 'text', text: buildDungeonVisionInstruction() },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          {
            model: chatModel,
            temperature: 0,
            responseFormat: schemaResponseFormat('dungeon-vision', dungeonVisionReplySchema),
          },
        );
        if (reply.fallback !== null) {
          notify(
            `Chat fallback fired on a vision pass: "${reply.fallback.from}" failed (${reply.fallback.reason}), "${reply.fallback.to}" answered.`,
          );
        }
        return { text: reply.text, modelUsed: reply.modelUsed };
      },
      blobToDataUrl,
    });
  } catch (error) {
    // Generation-level failure: loud, with the verbatim diagnosis.
    toastError('Labeled-dungeon bench run failed', error);
    throw new Error(errorMessage(error), { cause: error });
  }
}
