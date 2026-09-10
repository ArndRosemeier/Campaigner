import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { PenLineIcon } from 'lucide-react';

import type { Module } from '@/domain';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { patchModule } from '@/db/moduleRepo';
import { catalogStyles, readPromptStyleCatalog } from '@/db/promptStyleRepo';
import { readSettings } from '@/db/settingsRepo';
import { modulePromptStyleOf, promptStyleForModule } from '@/llm/promptStyles';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * "The style you are writing in has moved on" (docs/17 row 86).
 *
 * A module RECORDS the style text it was generated with, which is what makes an
 * edit of a style safe: parts already written, and every retry or repair of
 * them, keep composing exactly the prompt they were written under. That
 * guarantee would be a one-way door without this bar: the bar is the explicit,
 * visible way to move an EXISTING module onto a style's current text.
 *
 * It says nothing when there is nothing to say — a module whose recorded text
 * equals the style's current text (including every module written before styles
 * existed, which resolves to the immutable Classic) renders nothing at all.
 *
 * The two states it reports:
 * - the style's text changed: "Adopt" re-records the style at its current
 *   version; parts already written are untouched, later parts use the new text;
 * - the style was DELETED: the module keeps its recorded text (nothing is lost
 *   and nothing needs deciding), so the bar only explains why the picker no
 *   longer lists it.
 */
export function ModuleStyleBar({ module }: { module: Module }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const catalog = useLiveQuery(async () => {
    const settings = await readSettings();
    return readPromptStyleCatalog(settings.defaultPromptStyleId);
  }, []);
  if (catalog === undefined || dismissed) return null;

  const recorded = promptStyleForModule(module);
  const current = catalogStyles(catalog).find((style) => style.id === recorded.style.id);

  if (current === undefined) {
    return (
      <div
        className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground"
        data-testid="module-style-bar"
        data-state="deleted"
      >
        <PenLineIcon aria-hidden className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          This module is written in “{recorded.style.name}” v{recorded.style.version}, a style that no
          longer exists. Its text is recorded on the module, so generation continues exactly as
          before.
        </span>
      </div>
    );
  }

  if (current.templateText === recorded.style.templateText) return null;

  return (
    <div
      className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground"
      data-testid="module-style-bar"
      data-state="updated"
    >
      <PenLineIcon aria-hidden className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">
        This module is written in “{recorded.style.name}” v{recorded.style.version}; that style is now
        v{current.version}. Parts already written keep their text and continue as they are.
      </span>
      <AlertDialog>
        <AlertDialogTrigger
          render={<Button variant="ghost" size="xs" data-testid="module-style-adopt" />}
        >
          Adopt v{current.version}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Write the rest of this module in “{current.name}” v{current.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every part written from now on — and every retry, repair or per-part regeneration —
              uses the style’s current text. Parts already written keep the text they have and are
              never rewritten by this. The module records the new text, so later edits of the style
              still do not change it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void patchModule(module.id, { promptStyle: modulePromptStyleOf(current) })
                  .then(() => {
                    toastSuccess(
                      `Rest of this module now uses “${current.name}” v${String(current.version)}`,
                    );
                  })
                  .catch((error: unknown) => {
                    toastError('Could not adopt the style', error);
                  });
              }}
            >
              Adopt v{current.version}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Button
        variant="ghost"
        size="xs"
        data-testid="module-style-keep"
        onClick={() => {
          setDismissed(true);
        }}
      >
        Keep v{recorded.style.version}
      </Button>
    </div>
  );
}
