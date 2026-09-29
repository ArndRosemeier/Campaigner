import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import {
  ADVISOR_LENSES,
  ADVISOR_SCOPE_LABELS,
  advisorScopeSchema,
  customAdvisorSchema,
  type AdvisorLens,
} from '@/domain/advisors';
import { toastError } from '@/lib/toast';

/**
 * Canvas advisors (docs/17 row 400): the built-ins can be HIDDEN and DUPLICATED
 * (never edited, so the defaults stay reliable); custom advisors are added,
 * edited and removed here. Global to the owner, stored in Settings.
 */
export function AdvisorsSection(): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [scope, setScope] = useState<AdvisorLens['defaultScope']>('global');
  if (settings === undefined) return <Card data-testid="advisors-section" />;
  const { customAdvisors, hiddenAdvisors } = settings;

  function save(patch: Parameters<typeof updateSettings>[0]): void {
    void updateSettings(patch).catch((error: unknown) => {
      toastError('Could not save the advisors', error);
    });
  }

  function add(draft: { name: string; instruction: string; defaultScope: AdvisorLens['defaultScope'] }): boolean {
    const parsed = customAdvisorSchema.safeParse({ id: `custom-${crypto.randomUUID()}`, ...draft });
    if (!parsed.success) {
      toastError('The advisor is not valid', new Error(parsed.error.issues.map((i) => i.message).join('; ')));
      return false;
    }
    save({ customAdvisors: [...customAdvisors, parsed.data] });
    return true;
  }

  return (
    <Card data-testid="advisors-section">
      <CardHeader>
        <CardTitle>Advisors</CardTitle>
        <CardDescription>
          Advisors read the whole document and answer in prose; the canvas chat is the only editor. Built-in
          advisors can be hidden or duplicated, not edited.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {ADVISOR_LENSES.map((advisor) => {
          const hidden = hiddenAdvisors.includes(advisor.id);
          return (
            <div key={advisor.id} className="flex items-center gap-2" data-testid={`advisor-row-${advisor.id}`}>
              <span className="flex-1">
                {advisor.name} <span className="text-muted-foreground">({ADVISOR_SCOPE_LABELS[advisor.defaultScope]})</span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                data-testid={`advisor-hide-${advisor.id}`}
                onClick={() => {
                  save({
                    hiddenAdvisors: hidden
                      ? hiddenAdvisors.filter((id) => id !== advisor.id)
                      : [...hiddenAdvisors, advisor.id],
                  });
                }}
              >
                {hidden ? 'Show' : 'Hide'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                data-testid={`advisor-duplicate-${advisor.id}`}
                onClick={() => {
                  add({ name: `${advisor.name} (copy)`, instruction: advisor.instruction, defaultScope: advisor.defaultScope });
                }}
              >
                Duplicate
              </Button>
            </div>
          );
        })}
        {customAdvisors.map((advisor) => (
          <div key={advisor.id} className="flex items-center gap-2" data-testid={`advisor-row-${advisor.id}`}>
            <span className="flex-1">
              {advisor.name} <span className="text-muted-foreground">({ADVISOR_SCOPE_LABELS[advisor.defaultScope]}, yours)</span>
            </span>
            <Button
              size="xs"
              variant="ghost"
              data-testid={`advisor-remove-${advisor.id}`}
              onClick={() => {
                save({ customAdvisors: customAdvisors.filter((entry) => entry.id !== advisor.id) });
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="mt-2 flex flex-col gap-2 border-t pt-2">
          <Input aria-label="New advisor name" data-testid="advisor-new-name" placeholder="Name" value={name} onChange={(e) => { setName(e.target.value); }} />
          <Textarea aria-label="New advisor instruction" data-testid="advisor-new-instruction" placeholder="What should this advisor do?" value={instruction} onChange={(e) => { setInstruction(e.target.value); }} />
          <select aria-label="New advisor default scope" data-testid="advisor-new-scope" className="w-fit rounded border bg-background px-1" value={scope} onChange={(e) => { setScope(advisorScopeSchema.parse(e.target.value)); }}>
            {advisorScopeSchema.options.map((s) => (
              <option key={s} value={s}>{ADVISOR_SCOPE_LABELS[s]}</option>
            ))}
          </select>
          <Button
            size="sm"
            className="self-start"
            data-testid="advisor-add"
            onClick={() => {
              if (add({ name, instruction, defaultScope: scope })) {
                setName('');
                setInstruction('');
              }
            }}
          >
            Add advisor
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
