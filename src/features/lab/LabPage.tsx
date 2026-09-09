import type { JSX } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LAB_EXPERIMENTS } from '@/features/lab/experiments/registry';

/**
 * The experiment-lab home (discreet dev surface, OUTSIDE the creation
 * path): renders every registered experiment with its run control + results
 * renderer. Session-only state throughout — nothing here persists, and
 * nothing in the creation path imports lab code.
 */
export function LabPage(): JSX.Element {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0"
      data-testid="lab-page"
    >
      <h1 className="flex items-center gap-2 text-base font-semibold">
        Experiment lab
        <Badge variant="outline">experiment — not part of generation</Badge>
      </h1>
      <p className="text-sm text-muted-foreground">
        Reusable benches for testing image models and LLM vision against each
        other. Each bench spends real money with your configured models; the
        cost is stated on its run button. Results live for this session only.
      </p>
      {LAB_EXPERIMENTS.map((experiment) => (
        <Card key={experiment.id} data-testid={`lab-experiment-${experiment.id}`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              {experiment.title}
              <Badge variant="secondary">experiment</Badge>
            </CardTitle>
            <CardDescription>{experiment.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <experiment.Body runLabel={experiment.runLabel} costNote={experiment.costNote} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
