/**
 * THE one way to turn a title into a URL-safe filename stem (AGENTS rule 4,
 * docs/18 §2.3): lower-cased, every run of characters outside `[a-z0-9]`
 * collapsed to ONE `-`, leading and trailing dashes trimmed. Returns
 * `fallback` when the input reduces to nothing (a symbol-only name), because a
 * filename that is only its own suffix is not a filename.
 *
 * Every caller passes its fallback EXPLICITLY, and that is the whole reason
 * the parameter exists: the four call sites this seam folds emitted
 * `'artifact'` three times and `'module'` once, with no stated reason for the
 * difference — keeping each caller's own word is what makes the fold invisible
 * in the emitted filenames (docs/17 row 130).
 *
 * What this is NOT: a filename. The SUFFIX (`-gm-notes` / `-handout` for an
 * artifact PDF, `-gm` / `-player` for a module PDF, `-<date>.json`) is the
 * caller's own vocabulary and belongs to the caller — `lib/pdfExport.pdfFileName`
 * and `features/modules/module-pdf-button.modulePdfFileName` answer two
 * DIFFERENT questions (`gm`/`player` audience for a PDF viewer vs a PDF TEMPLATE
 * name) and deliberately do NOT share their naming role (docs/18 §2.3).
 */
export function fileSlug(name: string, fallback = 'artifact'): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || fallback
  );
}
