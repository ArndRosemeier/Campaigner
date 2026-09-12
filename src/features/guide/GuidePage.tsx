import { useLiveQuery } from 'dexie-react-hooks';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeftIcon, ArrowRightIcon, SparklesIcon } from 'lucide-react';

import { NotFoundPage } from '@/components/NotFoundPage';
import {
  guidePath,
  modulesPath,
  workspacePath,
} from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import { GUIDE_CHAPTERS, guideChapter } from '@/features/guide/guideContent';
import type { GuideAppLink } from '@/features/guide/guideContent';
import { listCampaigns } from '@/db/campaignRepo';
import { cn } from '@/lib/utils';

/**
 * First-module guide (05-UI.md §Guide): long-form, authored as structured
 * data in guideContent.ts and rendered full-page — opened in another tab
 * from the setup wizard, the help 'setup' topic and the modules empty
 * state. Chapter CTAs deep-link into the app: static routes always resolve;
 * campaign-scoped ones resolve against the most recently updated campaign
 * and render as a disabled hint while none exists.
 */
export function GuidePage(): JSX.Element {
  const { chapterId } = useParams<{ chapterId?: string }>();
  const chapter = guideChapter(chapterId);

  if (chapter === undefined) {
    return <NotFoundPage />;
  }

  const index = GUIDE_CHAPTERS.findIndex((entry) => entry.id === chapter.id);
  const previous = index > 0 ? GUIDE_CHAPTERS[index - 1] : undefined;
  const next = index < GUIDE_CHAPTERS.length - 1 ? GUIDE_CHAPTERS[index + 1] : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">First-Module Guide</h1>
          <p className="text-sm text-muted-foreground">
            From an empty browser to one playable module — {GUIDE_CHAPTERS.length} chapters, about
            30 minutes. You can keep this tab open beside the app.
          </p>
        </header>

        <div className="flex flex-col gap-4 lg:flex-row">
          <nav
            aria-label="Guide chapters"
            className="shrink-0 lg:sticky lg:top-2 lg:w-60 lg:self-start"
          >
            <ol className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
              {GUIDE_CHAPTERS.map((entry, entryIndex) => (
                <li key={entry.id}>
                  <Link
                    to={guidePath(entry.id)}
                    className={cn(
                      'flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent',
                      entry.id === chapter.id && 'bg-accent font-medium text-accent-foreground',
                    )}
                    data-testid={`guide-nav-${entry.id}`}
                  >
                    <span className="text-xs text-muted-foreground">
                      {String(entryIndex + 1)}.
                    </span>
                    <span className="whitespace-nowrap lg:whitespace-normal">
                      {entry.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </nav>

          <article className="flex min-w-0 flex-1 flex-col gap-4" data-testid="guide-chapter">
            <div>
              <Badge variant="outline" className="mb-2">
                Chapter {String(index + 1)} of {String(GUIDE_CHAPTERS.length)} · ~
                {String(chapter.minutes)} min
              </Badge>
              <h2 className="text-lg font-semibold">{chapter.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{chapter.intro}</p>
            </div>

            {chapter.sections.map((section) => (
              <section key={section.heading} className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">{section.heading}</h3>
                <div className="max-w-prose text-sm">
                  <WikiMarkdown value={section.markdown} artifacts={[]} />
                </div>
              </section>
            ))}

            <p
              className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
              data-testid="guide-checkpoint"
            >
              {chapter.checkpoint}
            </p>

            {chapter.appLink !== undefined && <GuideLinkButton link={chapter.appLink} />}

            <div className="mt-2 flex items-center gap-2">
              {previous !== undefined ? (
                <Link
                  to={guidePath(previous.id)}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  data-testid="guide-prev"
                >
                  <ArrowLeftIcon aria-hidden data-icon="inline-start" />
                  {previous.title}
                </Link>
              ) : (
                <span />
              )}
              <span className="flex-1" />
              {next !== undefined && (
                <Link
                  to={guidePath(next.id)}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  data-testid="guide-next"
                >
                  {next.title}
                  <ArrowRightIcon aria-hidden data-icon="inline-end" />
                </Link>
              )}
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

/**
 * A chapter's "Do it now" button. Campaign-scoped routes resolve against the
 * most recently updated campaign; without any campaign they render as a
 * disabled hint (the campaign-tabs disabled precedent).
 */
function GuideLinkButton({ link }: { link: GuideAppLink }): JSX.Element {
  // The repo's list is already most-recently-updated first — [0] IS latest.
  const latestCampaign = useLiveQuery(async () => (await listCampaigns())[0], [], undefined);

  if (link.route.kind === 'static') {
    return (
      <div>
        <a
          href={link.route.path}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: 'sm' })}
          data-testid="guide-app-link"
        >
          <SparklesIcon aria-hidden data-icon="inline-start" />
          {link.label}
        </a>
      </div>
    );
  }

  const campaignId = latestCampaign?.id;
  if (campaignId === undefined) {
    return (
      <div>
        <span
          className="text-sm text-muted-foreground"
          data-testid="guide-app-link-disabled"
        >
          {link.label} — create a campaign first (chapter 2).
        </span>
      </div>
    );
  }

  const path =
    link.route.section === 'modules' ? modulesPath(campaignId) : workspacePath(campaignId);

  return (
    <div>
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ size: 'sm' })}
        data-testid="guide-app-link"
      >
        <SparklesIcon aria-hidden data-icon="inline-start" />
        {link.label}
      </a>
    </div>
  );
}
