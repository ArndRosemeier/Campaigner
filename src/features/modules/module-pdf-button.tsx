import { useState } from 'react';
import type { JSX } from 'react';
import { FileDownIcon, LoaderCircleIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AnyArtifact, Module } from '@/domain';
import { EXPORT_PDF_TYPES, openSaveTarget } from '@/lib/filePicker';
import { fileSlug } from '@/lib/fileSlug';
import { buildModulePdf, type ModulePdfAudience } from '@/lib/modulePdf';
import { generatePdfBlob } from '@/lib/pdfExport';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * The module PDF export (docs/17 row 108): the MODULE is the document, so the
 * button lives where the module lives — the canvas header and the campaign
 * tree's module row. ONE component for both surfaces, so the two entry points
 * cannot drift into different documents.
 *
 * GM and PLAYER come out of ONE code path, with the audience as an explicit
 * option (`buildModulePdf`'s third argument fold): what differs between the
 * two files is exactly the renderer's audience rule, never a second builder.
 *
 * Failure reporting (AGENTS rule 2): the document itself always lands — a
 * missing premise, an unreadable map or a part the parts-document seam refused
 * is printed as a loud placeholder AND reported in the toast, named by its
 * site. A failed save (picker error, generation error) is loud too.
 */
export function ModulePdfButton({
  module,
  artifacts,
  size = 'xs',
  variant = 'outline',
}: {
  module: Module;
  artifacts: readonly AnyArtifact[];
  size?: 'xs' | 'sm';
  variant?: 'outline' | 'ghost';
}): JSX.Element {
  const [building, setBuilding] = useState<ModulePdfAudience | null>(null);

  async function exportPdf(audience: ModulePdfAudience): Promise<void> {
    if (building !== null) return;
    setBuilding(audience);
    // The destination is acquired FIRST, inside the click's gesture window
    // (the build is slow and the picker must open while the gesture is live) —
    // the artifact-PDF export precedent.
    let target;
    try {
      target = await openSaveTarget({
        suggestedName: modulePdfFileName(module, audience),
        types: EXPORT_PDF_TYPES,
      });
    } catch (error) {
      setBuilding(null);
      toastError('PDF export failed', error);
      return;
    }
    if (target.cancelled) {
      setBuilding(null);
      return;
    }
    try {
      const { blob, problems } = await buildModulePdf(
        module,
        artifacts,
        (definition) => generatePdfBlob(definition),
        { audience },
      );
      await target.write(blob);
      if (problems.length === 0) {
        toastSuccess(`Exported ${module.title} as a PDF`);
      } else {
        // Never silent: the document carries the same list as placeholders.
        toastInfo(
          `Exported ${module.title} with ${String(problems.length)} problem${problems.length === 1 ? '' : 's'}: ${problems
            .map((problem) => `${problem.where} — ${problem.reason}`)
            .join('; ')}`,
        );
      }
    } catch (error) {
      toastError('PDF export failed', error);
    } finally {
      setBuilding(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={variant}
            size={size}
            disabled={building !== null}
            title="Print this module as a PDF"
            data-testid="module-pdf-menu"
          >
            {building === null ? (
              <FileDownIcon aria-hidden data-icon="inline-start" />
            ) : (
              <LoaderCircleIcon aria-hidden className="animate-spin" data-icon="inline-start" />
            )}
            {building === null ? 'Module PDF' : 'Building…'}
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Module PDF</DropdownMenuLabel>
            <DropdownMenuItem
            data-testid="module-pdf-gm"
            onClick={() => {
              void exportPdf('gm');
            }}
          >
            GM document — premise, part plan, parts, artifacts, maps, gallery, treasure
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="module-pdf-player"
            onClick={() => {
              void exportPdf('player');
            }}
          >
            Player document — the same book without the planning or the secrets
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `<title>-<audience>.pdf`, slugged like every other export filename. */
function modulePdfFileName(module: Module, audience: ModulePdfAudience): string {
  // The one slug seam (lib/fileSlug), with THIS caller's own fallback: a module
  // has no artifact name, so a symbol-only title falls back to 'module'. The
  // audience SUFFIX (`gm`/`player`) is this file's role and deliberately does
  // NOT merge with `pdfExport.pdfFileName`'s template names (docs/18 §2.3).
  const slug = fileSlug(module.title, 'module');
  return `${slug}-${audience === 'gm' ? 'gm' : 'player'}.pdf`;
}
