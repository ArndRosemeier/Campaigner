import { generateImages } from '@/llm/imageGen';
import { assembleImagePrompt } from '@/llm/imagePromptDraft';
import type { ImagePromptDraft } from '@/llm/schemas';
import { intakeImage } from '@/lib/imageIntake';

/**
 * "Generate ONE image and prepare it for storage" — THE one way (docs/18
 * §2.2, docs/17 row 126).
 *
 * WHY THIS EXISTS (AGENTS rule 4). Four call sites hand-rolled the same
 * five-line tail, byte for byte — the module/campaign cover queue, the entity
 * image queue, the mob portrait queue and the canonical portrait cache: draft
 * → `assembleImagePrompt(draft)` → `generateImages(finalPrompt, 1, …)` →
 * refuse an empty result → EXIF-safe `intakeImage`. The same rationale
 * travelled with every copy, which is exactly what made four copies read as
 * four deliberate decisions; and the empty-result sentence was a literal four
 * times over, pinned by nothing. The seam owns the WHOLE tail, so the next
 * caller that needs one image cannot re-derive any of it.
 *
 * WHAT STAYS WITH THE CALLER (deliberately): which draft to illustrate, the
 * settings read that supplies the model, and how the prepared image is
 * WRITTEN — `imageRepo.createImage`, `artifactRepo.attachImagesToArtifact` and
 * `imageRepo.buildStoredImage` answer different storage questions and are not
 * this seam's business.
 *
 * WHY THE SEAM TAKES NO `n`, AND WHY THAT IS NOT A LIMITATION. Its two
 * multi-candidate siblings in `runEngine` answer a different question ("how
 * many candidates, and which one does the owner pick?") and stay on
 * `generateImages`: the persona run's generate step (`n = 2` + the pick step)
 * and the encounter map's `unattended ? 1 : 2` pair. On THIS path `n = 1` is
 * fixed, and the candidate-count machinery is structurally inert:
 * `imageGen`'s n-unsupported 400 retry and the `cappedToOne` flag it raises are
 * both guarded by `n > 1`; `filteredCount` can only be non-zero if the API
 * returns MORE entries than were asked for, and an all-filtered response
 * already throws inside `generateImages` ('image API returned no images')
 * before this seam sees it. So no caller here has a degradation to surface,
 * and the seam adds none.
 *
 * THE BOUNDARY, NAMED SO THE NEXT READER DOES NOT HAVE TO RE-DERIVE IT:
 * `runEngine`'s vision-map step generates one map image through the
 * `encounterRunAdapters` indirection (the run engine's test-stubbing seam) from
 * a raw `buildLabeledMapPrompt` string — the documented text-render carve-out,
 * so there is no `assembleImagePrompt` draft to hand over — and intakes it with
 * `{ role: 'map' }`. It keeps its own sentence, which tells the owner what the
 * consequence was ("the vision-map step failed without saving partial results");
 * adopting this seam's message would drop that context for a phrase that says
 * less. That decision is recorded in docs/18 §4.
 */

/**
 * The ONE sentence for "the image API answered with nothing" on this path.
 * Exported so a caller can pin/quote it without restating the literal (the
 * four copies this seam replaced were pinned by nothing — docs/17 row 126).
 */
export const NO_IMAGE_FROM_API_MESSAGE = 'the image API returned no image';

/**
 * One image, prepared for storage: the intake result (EXIF-safe decode,
 * downscaled, re-encoded — `imageIntake`) plus the prompt contract it was
 * generated from and the model that ACTUALLY produced it (escalation-aware —
 * `generateImages` reports the model that answered, so the image row records
 * the truth instead of the requested model).
 *
 * Every storage writer that takes one image takes exactly this shape
 * (`NewStoredImage` minus `campaignId`/`source`/`role`), which is why it is
 * declared once here instead of as a literal at each write site.
 */
export interface GeneratedOneImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  /** The ASSEMBLED prompt — what the row records, not the draft. */
  prompt: string;
  model: string;
}

export interface GenerateOneImageOptions {
  model: string;
  signal?: AbortSignal | undefined;
}

/**
 * Assembles the prompt contract, generates ONE image, refuses an empty result
 * loudly and intakes it. Throws whatever `generateImages` throws (a missing
 * key, an escalation-exhausted API error, a stop) unchanged — this seam adds
 * no error handling of its own beyond the empty-result refusal.
 */
export async function generateOneImage(
  prompt: ImagePromptDraft,
  options: GenerateOneImageOptions,
): Promise<GeneratedOneImage> {
  const finalPrompt = assembleImagePrompt(prompt);
  const generated = await generateImages(finalPrompt, 1, {
    model: options.model,
    signal: options.signal,
  });
  const blob = generated.images[0];
  // LOUD, never a blank cover or portrait (AGENTS rule 1). `generateImages`
  // already throws when the API returned zero candidates, so this stands at
  // the seam's own boundary: an empty list reaching a caller would store a row
  // for an image that does not exist. The message is the seam's, once.
  if (blob === undefined) throw new Error(NO_IMAGE_FROM_API_MESSAGE);
  const intake = await intakeImage(blob);
  return {
    blob: intake.blob,
    mimeType: intake.mimeType,
    width: intake.width,
    height: intake.height,
    prompt: finalPrompt,
    model: generated.modelUsed,
  };
}
