import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { ROUTES } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Catch-all screen for unknown URLs. */
export function NotFoundPage(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardDescription>Error 404</CardDescription>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            The page you are looking for does not exist.
          </p>
          <Link to={ROUTES.campaignPicker} className={buttonVariants({ variant: 'outline' })}>
            Back to campaign picker
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
