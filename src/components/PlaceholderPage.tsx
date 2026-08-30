import type { JSX } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface PlaceholderPageProps {
  /** Page/screen title, rendered as the page's main heading. */
  title: string;
  /** One short paragraph explaining what will live on this screen. */
  description: string;
  /** Milestone/task from docs/06-MILESTONES.md that will implement this screen. */
  milestone?: string;
}

/**
 * Shared placeholder screen used by every route during scaffolding (T1).
 * Real screens replace their page component; the shell and routing stay put.
 */
export function PlaceholderPage({
  title,
  description,
  milestone,
}: PlaceholderPageProps): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardDescription>Placeholder — screen not implemented yet</CardDescription>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{description}</p>
          {milestone && <Badge variant="secondary">Planned in {milestone}</Badge>}
        </CardContent>
      </Card>
    </div>
  );
}
