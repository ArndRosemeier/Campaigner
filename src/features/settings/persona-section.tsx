import { useState } from 'react';
import type { JSX } from 'react';
import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon } from 'lucide-react';

import type { Persona } from '@/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { updatePersona, resetPersonaToDefault } from '@/db/personaRepo';
import { ARTIFACT_KIND_SINGULAR } from '@/domain/artifact';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Persona management (05-UI.md §Settings): editable name, description, model,
 * temperature and system prompt; built-ins get "Reset to default".
 */
export function PersonaSection({ personas }: { personas: Persona[] }): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Personas</CardTitle>
        <CardDescription>
          Per-persona prompts and models; the model field falls back to the default chat model when
          empty.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {personas.map((persona) => (
          <PersonaRow key={persona.id} persona={persona} />
        ))}
      </CardContent>
    </Card>
  );
}

function PersonaRow({ persona }: { persona: Persona }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 rounded-md border p-2">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`Toggle ${persona.name}`}
        >
          {open ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{persona.name}</span>
        </CollapsibleTrigger>
        <Badge variant="secondary">
          {persona.mode === 'image'
            ? 'images'
            : ARTIFACT_KIND_SINGULAR[persona.producesKind ?? 'note']}
        </Badge>
        {persona.builtIn && <Badge variant="outline">built-in</Badge>}
      </div>
      <CollapsibleContent>
        <PersonaFields persona={persona} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function PersonaFields({ persona }: { persona: Persona }): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-t-0 p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`persona-name-${persona.id}`}>Name</Label>
        <Input
          id={`persona-name-${persona.id}`}
          defaultValue={persona.name}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name !== '' && name !== persona.name) {
              void updatePersona(persona.id, { name }).catch((error: unknown) => {
                toastError('Could not save persona', error);
              });
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`persona-desc-${persona.id}`}>Description</Label>
        <Textarea
          id={`persona-desc-${persona.id}`}
          defaultValue={persona.description}
          rows={2}
          onBlur={(event) => {
            if (event.target.value !== persona.description) {
              void updatePersona(persona.id, { description: event.target.value }).catch(
                (error: unknown) => {
                  toastError('Could not save persona', error);
                },
              );
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`persona-model-${persona.id}`}>Model (blank = default)</Label>
        <Input
          id={`persona-model-${persona.id}`}
          defaultValue={persona.model}
          placeholder="e.g. anthropic/claude-sonnet-4.5"
          onBlur={(event) => {
            if (event.target.value !== persona.model) {
              void updatePersona(persona.id, { model: event.target.value }).catch(
                (error: unknown) => {
                  toastError('Could not save persona', error);
                },
              );
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`persona-temp-${persona.id}`}>Temperature: {persona.temperature}</Label>
        <Slider
          id={`persona-temp-${persona.id}`}
          min={0}
          max={2}
          step={0.1}
          value={[persona.temperature]}
          onValueChange={(value: number | readonly number[]) => {
            const next: readonly number[] = Array.isArray(value) ? value : [value];
            const temperature = next[0];
            if (typeof temperature === 'number' && temperature !== persona.temperature) {
              void updatePersona(persona.id, { temperature }).catch((error: unknown) => {
                toastError('Could not save persona', error);
              });
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`persona-prompt-${persona.id}`}>System prompt</Label>
        <Textarea
          id={`persona-prompt-${persona.id}`}
          defaultValue={persona.systemPrompt}
          rows={6}
          className="font-mono text-xs"
          onBlur={(event) => {
            if (event.target.value !== persona.systemPrompt) {
              void updatePersona(persona.id, { systemPrompt: event.target.value }).catch(
                (error: unknown) => {
                  toastError('Could not save persona', error);
                },
              );
            }
          }}
        />
      </div>
      {persona.builtIn && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            void resetPersonaToDefault(persona.slug)
              .then(() => {
                toastSuccess(`“${persona.name}” reset to default`);
              })
              .catch((error: unknown) => {
                toastError('Could not reset persona', error);
              });
          }}
        >
          <RotateCcwIcon aria-hidden data-icon="inline-start" />
          Reset to default
        </Button>
      )}
    </div>
  );
}
