import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import type { AnyArtifact, Id } from '@/domain';
import { WIKI_LINK_PATTERN, resolveWikiLink } from '@/lib/wikilinks';
import { cn } from '@/lib/utils';

/**
 * Wiki-link decorations for the canvas editor (08-MODULE-DESIGNER
 * §Module canvas): `[[Name]]`/`[[Name|display]]` tokens render as kind-colored
 * marks resolved against the READER pool (campaign artifacts + the global
 * library) with the module's own tier-0 context — the exact resolution
 * semantics and color palette of the shared `WikiMarkdown` renderer, drawn as
 * inline CM6 marks instead of React chips (the doc string is the truth; the
 * decorations are pure view chrome and never touch the document).
 *
 * Chips are ATOMIC (`EditorView.atomicRanges`): cursor motion and selection
 * treat `[[Name]]` as one unit, so editing never strands half a token.
 * Decorations carry `data-wiki-*` attributes (name/status) so tests and
 * future click affordances can read them.
 */

/** The kind→color palette, hue-identical to WikiMarkdown's chips. */
const KIND_MARK_CLASSES: Readonly<Record<AnyArtifact['kind'], string>> = {
  pc: 'bg-rose-500/10 text-rose-800 dark:text-rose-200',
  npc: 'bg-sky-500/10 text-sky-800 dark:text-sky-200',
  location: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  event: 'bg-teal-500/10 text-teal-800 dark:text-teal-200',
  faction: 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
  note: 'bg-neutral-500/10 text-neutral-800 dark:text-neutral-200',
  encounter: 'bg-red-500/10 text-red-800 dark:text-red-200',
  plotarc: 'bg-violet-500/10 text-violet-800 dark:text-violet-200',
};

const MARK_BASE = 'cm-wiki-link rounded px-0.5 font-medium';
const MARK_UNRESOLVED =
  'border-b border-dashed border-muted-foreground/40 text-muted-foreground';

/**
 * The class list for one wiki-link token's mark (pure — exported for tests):
 * resolved/ambiguous chips carry their artifact kind's palette (ambiguous
 * adds a wavy amber underline), unresolved ones render dashed + muted.
 */
export function wikiMarkClassFor(
  name: string,
  artifacts: readonly AnyArtifact[],
  moduleId?: Id,
): string {
  const resolution = resolveWikiLink(
    name,
    artifacts,
    moduleId === undefined ? undefined : { moduleId },
  );
  if (resolution.status === 'unresolved' || resolution.artifact === undefined) {
    return cn(MARK_BASE, MARK_UNRESOLVED);
  }
  const ambiguous = resolution.status === 'ambiguous';
  return cn(
    MARK_BASE,
    KIND_MARK_CLASSES[resolution.artifact.kind],
    ambiguous && 'underline decoration-amber-600 decoration-wavy',
  );
}

function buildWikiDecorations(
  view: EditorView,
  artifacts: readonly AnyArtifact[],
  moduleId: Id | undefined,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
      const start = from + match.index;
      const end = start + match[0].length;
      const name = (match[1] ?? '').trim();
      const resolution = resolveWikiLink(
        name,
        artifacts,
        moduleId === undefined ? undefined : { moduleId },
      );
      const status =
        resolution.status === 'resolved' && resolution.artifact === undefined
          ? 'unresolved'
          : resolution.status;
      const ambiguous = status === 'ambiguous';
      builder.add(
        start,
        end,
        Decoration.mark({
          class: wikiMarkClassFor(name, artifacts, moduleId),
          attributes: {
            'data-wiki-name': name,
            'data-wiki-status': status,
            title:
              ambiguous && resolution.artifact !== undefined
                ? `⚠ multiple artifacts match “${name}”`
                : resolution.artifact !== undefined
                  ? resolution.artifact.name
                  : `${name} — not detailed yet`,
          },
        }),
      );
    }
  }
  return builder.finish();
}

/**
 * The wiki-link decoration extension for one canvas editor. The pool and
 * module context are fixed per editor instance (the part selector remounts
 * the editor on module change), so the plugin closes over them.
 */
export function wikiLinkDecorations(
  artifacts: readonly AnyArtifact[],
  moduleId: Id | undefined,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildWikiDecorations(view, artifacts, moduleId);
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildWikiDecorations(update.view, artifacts, moduleId);
        }
      }
    },
    {
      decorations: (instance) => instance.decorations,
      // The raw token `[[Name]]` is one editing unit.
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => {
          return view.plugin(plugin)?.decorations ?? Decoration.none;
        }),
    },
  );
  return plugin;
}
