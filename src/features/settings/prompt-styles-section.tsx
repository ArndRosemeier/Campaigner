import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';

import type { PromptStyle } from '@/domain';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  catalogStyles,
  deletePromptStyle,
  discardUnreadablePromptStyles,
  duplicatePromptStyle,
  readPromptStyleCatalog,
  resetPromptStyleToSource,
  savePromptStyle,
  setDefaultPromptStyle,
} from '@/db/promptStyleRepo';
import { readSettings } from '@/db/settingsRepo';
import { PROMPT_STYLE_SECTION_MARKERS } from '@/domain';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  previewPromptStyle,
  type PromptStylePreview,
} from '@/features/settings/prompt-style-preview';

/**
 * Module writing styles (docs/17 row 86, 05-UI.md §Settings): the module
 * generation prompts, visible and editable.
 *
 * WHAT IS EDITABLE AND WHAT IS NOT: a style is the USER prompt text plus
 * placeholders — anything the author writes. The CONTRACT clauses (the reply
 * format the parser reads, the encounter floor, the wiki-link rules, the kinds,
 * the mechanics, the length target) are marked `contract.*` and are injected by
 * the app on every composition: a style can say anything it likes around them,
 * and cannot remove them. The editor marks those lines in the preview so the
 * boundary is visible rather than documented only.
 *
 * Built-ins cannot be edited at all — a built-in changing under a user's feet
 * would silently rewrite what their next module sounds like. "Duplicate" is the
 * way in, and a user style derived from a built-in keeps a "Reset to source".
 */
export function PromptStylesSection(): JSX.Element {
  const catalog = useLiveQuery(async () => {
    const row = await readSettings();
    return readPromptStyleCatalog(row.defaultPromptStyleId);
  }, []);

  return (
    <Card data-testid="prompt-styles-section">
      <CardHeader>
        <CardTitle>Module writing styles</CardTitle>
        <CardDescription>
          The instructions a module is generated with. A style is the prompt text with placeholders;
          the fixed clauses the app depends on (reply format, encounter floor, wiki-links) are marked
          in the preview and always ride along. Every module records the style text it was written
          with, so editing a style never changes a module that already exists.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {catalog?.error != null && (
          <div
            className="flex flex-col gap-2 rounded-md border border-destructive p-3"
            data-testid="prompt-styles-error"
          >
            <p className="text-sm font-medium text-destructive">
              Your saved prompt styles could not be read
            </p>
            <p className="text-xs text-destructive">
              {catalog.error.message} — only the built-in styles are available, and no edit can be
              saved until this row is replaced.
            </p>
            <DiscardUnreadable />
          </div>
        )}
        {catalog === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          catalogStyles(catalog).map((style) => (
            <PromptStyleRow
              key={style.id}
              style={style}
              isDefault={style.id === catalog.defaultStyleId}
              canReset={style.origin === 'user' && style.basedOn !== undefined}
              baseName={
                style.basedOn === undefined
                  ? undefined
                  : catalogStyles(catalog).find((entry) => entry.id === style.basedOn)?.name
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** The one explicit way out of an unreadable styles blob (never silent). */
function DiscardUnreadable(): JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        Discard unreadable styles
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard the unreadable styles?</AlertDialogTitle>
          <AlertDialogDescription>
            The stored styles cannot be parsed, so they cannot be shown or repaired here. This
            replaces them with an empty list and leaves your modules untouched — every module keeps
            the style text it was generated with.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              void discardUnreadablePromptStyles()
                .then(() => {
                  toastSuccess('Prompt styles reset — the styles list is empty again');
                })
                .catch((error: unknown) => {
                  toastError('Could not discard the prompt styles', error);
                });
            }}
          >
            Discard and start over
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PromptStyleRow({
  style,
  isDefault,
  canReset,
  baseName,
}: {
  style: PromptStyle;
  isDefault: boolean;
  canReset: boolean;
  baseName: string | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const builtin = style.origin === 'builtin';
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* One stable hook per row: the tests find a row by id, never by walking
          the DOM around a label. */}
      <div
        className="flex items-center gap-2 rounded-md border p-2"
        data-testid={`prompt-style-row-${style.id}`}
      >
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`Toggle ${style.name}`}
        >
          {open ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{style.name}</span>
        </CollapsibleTrigger>
        {isDefault && <Badge variant="secondary">default</Badge>}
        <Badge variant="outline">{builtin ? 'built-in' : `yours · v${String(style.version)}`}</Badge>
      </div>
      <CollapsibleContent>
        <div
          className="flex flex-col gap-3 rounded-md border border-t-0 p-3"
          data-testid={`prompt-style-body-${style.id}`}
        >
          {baseName !== undefined && (
            <p className="text-xs text-muted-foreground">
              Based on “{baseName}” — Reset to source takes that style’s current text.
            </p>
          )}
          {builtin ? (
            <p className="text-xs text-muted-foreground">
              Built-in styles ship with the app and cannot be edited: a change here would silently
              rewrite what every campaign’s next module sounds like. Duplicate it to make it yours.
            </p>
          ) : (
            <PromptStyleFields style={style} />
          )}
          <PreviewPanel templateText={style.templateText} />
          <div className="flex flex-wrap gap-2">
            {!isDefault && (
              <Button
                variant="outline"
                size="sm"
                data-testid={`prompt-style-make-default-${style.id}`}
                onClick={() => {
                  // The repo re-reads the catalog itself, so this cannot act on
                  // a stale render.
                  void setDefaultPromptStyle(style.id)
                    .then(() => {
                      toastSuccess(`New modules will be written in “${style.name}”`);
                    })
                    .catch((error: unknown) => {
                      toastError('Could not set the default style', error);
                    });
                }}
              >
                Make default
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              data-testid={`prompt-style-duplicate-${style.id}`}
              onClick={() => {
                void duplicatePromptStyle(style)
                  .then((copy) => {
                    toastSuccess(`“${copy.name}” created — edit it here`);
                  })
                  .catch((error: unknown) => {
                    toastError('Could not duplicate the style', error);
                  });
              }}
            >
              <CopyIcon aria-hidden data-icon="inline-start" />
              Duplicate
            </Button>
            {canReset && (
              <ResetToSource style={style} baseName={baseName ?? style.basedOn ?? ''} />
            )}
            {!builtin && <DeleteStyle style={style} />}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Name + template, saved on blur. A template that fails validation is NOT
 * written: the problem list below the field names every issue, and the text
 * stays in the field (nothing is silently dropped or sanitized).
 */
function PromptStyleFields({ style }: { style: PromptStyle }): JSX.Element {
  const [name, setName] = useState(style.name);
  const [templateText, setTemplateText] = useState(style.templateText);
  const preview = previewPromptStyle({ templateText });
  const problems = preview.problems;
  const dirty = name !== style.name || templateText !== style.templateText;

  const save = (): void => {
    if (!dirty) return;
    void savePromptStyle(style.id, { name, templateText })
      .then((saved) => {
        setName(saved.name);
        setTemplateText(saved.templateText);
        toastSuccess(`“${saved.name}” saved (v${String(saved.version)})`);
      })
      .catch((error: unknown) => {
        toastError('Could not save the prompt style', error);
      });
  };

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`prompt-style-name-${style.id}`}>Name</Label>
        <Input
          id={`prompt-style-name-${style.id}`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={save}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`prompt-style-template-${style.id}`}>Prompt text</Label>
        <Textarea
          id={`prompt-style-template-${style.id}`}
          value={templateText}
          rows={14}
          className="font-mono text-xs"
          spellCheck={false}
          data-testid={`prompt-style-template-${style.id}`}
          onChange={(event) => {
            setTemplateText(event.target.value);
          }}
          onBlur={save}
        />
        <p className="text-xs text-muted-foreground">
          Keep the section markers <code>{PROMPT_STYLE_SECTION_MARKERS.spine}</code> and{' '}
          <code>{PROMPT_STYLE_SECTION_MARKERS.parts}</code>: the spine planner and the per-part
          writer are two different prompts. A <code>contract.*</code> placeholder on its own line is
          required in each section.
        </p>
      </div>
      {problems.length > 0 && (
        <div
          className="rounded-md border border-destructive p-3"
          data-testid={`prompt-style-problems-${style.id}`}
        >
          <p className="text-sm font-medium text-destructive">This template cannot be saved as it is</p>
          <ul className="list-disc pl-4 text-xs text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="outline" size="sm" className="self-start" disabled={!dirty} onClick={save}>
        Save
      </Button>
    </>
  );
}

function ResetToSource({ style, baseName }: { style: PromptStyle; baseName: string }): JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        <RotateCcwIcon aria-hidden data-icon="inline-start" />
        Reset to source
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset “{style.name}” to “{baseName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Your prompt text is replaced by the source style’s CURRENT text (a new version). Modules
            already written keep the text they recorded, so nothing already generated changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void resetPromptStyleToSource(style.id)
                .then((saved) => {
                  toastSuccess(`“${saved.name}” reset to “${baseName}” (v${String(saved.version)})`);
                })
                .catch((error: unknown) => {
                  toastError('Could not reset the style', error);
                });
            }}
          >
            Reset the text
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteStyle({ style }: { style: PromptStyle }): JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="outline" size="sm" data-testid={`prompt-style-delete-${style.id}`} />}
      >
        <Trash2Icon aria-hidden data-icon="inline-start" />
        Delete
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{style.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The style disappears from the picker. Modules already written with it are NOT affected —
            each module carries its own copy of the style text it used — so this cannot change
            anything that already exists.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              void deletePromptStyle(style.id)
                .then(() => {
                  toastSuccess(`“${style.name}” deleted`);
                })
                .catch((error: unknown) => {
                  toastError('Could not delete the style', error);
                });
            }}
          >
            Delete the style
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The composed prompt, line by line, with the contract lines marked: this is
 * where the author sees that part of the text is not theirs to remove.
 */
function PreviewPanel({ templateText }: { templateText: string }): JSX.Element {
  const [surface, setSurface] = useState<'spine' | 'parts'>('parts');
  const preview = previewPromptStyle({ templateText });
  const current: PromptStylePreview = surface === 'spine' ? preview.spine : preview.parts;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label>Composed prompt (sample values)</Label>
        <div className="flex gap-1">
          {(['spine', 'parts'] as const).map((entry) => (
            <Button
              key={entry}
              type="button"
              size="sm"
              variant={surface === entry ? 'default' : 'outline'}
              aria-pressed={surface === entry}
              onClick={() => {
                setSurface(entry);
              }}
            >
              {entry === 'spine' ? 'Spine planner' : 'Part writer'}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Sample data stands in for your campaign: <code>‹…›</code> is a value the run fills in, and
        the highlighted lines are the contract clauses the app always injects.
      </p>
      {current.composed === null ? (
        <p className="text-xs text-destructive">
          This section cannot be composed — see the problems above.
        </p>
      ) : (
        <pre
          className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap"
          data-testid={`prompt-style-preview-${surface}`}
        >
          {current.composed.lines.map((line, index) => (
            // A composed line IS the layout: its index is its identity.
            <div
              key={index}
              data-layer={
                line.segments.find((segment) => segment.layer === 'contract') ? 'contract' : undefined
              }
            >
              {line.segments.map((segment, segmentIndex) => (
                <span
                  key={segmentIndex}
                  className={
                    segment.layer === 'contract'
                      ? 'rounded bg-primary/15 font-medium text-primary'
                      : undefined
                  }
                  data-segment-layer={segment.layer}
                >
                  {segment.text}
                </span>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
