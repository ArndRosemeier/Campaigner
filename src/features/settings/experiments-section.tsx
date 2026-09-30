import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { FlaskConicalIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ROUTES } from '@/app/routes';

/**
 * The discreet dev-lab entry on the Settings page (05-UI.md §Settings):
 * a link to the experiment lab — never in the main nav flow, never
 * reachable by accident from a generation surface.
 */
export function ExperimentsSection(): JSX.Element {
  return (
    <Card data-testid="experiments-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConicalIcon aria-hidden className="size-4" />
          Experiments
        </CardTitle>
        <CardDescription>
          A reusable experiment lab for testing image models and LLM vision
          against each other — outside the creation path, session-only, and
          clearly labeled as an experiment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" render={<Link to={ROUTES.lab} />} nativeButton={false} data-testid="experiments-open-lab">
          Open experiment lab
        </Button>
      </CardContent>
    </Card>
  );
}
