import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { CircleHelpIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HELP_CONTENT, HELP_TOPIC_IDS, type HelpTopic } from '@/help/helpContent';
import { useHelpStore } from '@/help/helpStore';
import { cn } from '@/lib/utils';

/**
 * The in-app help dialog: searchable topic list on the left, content on the
 * right. Opens focused on a topic (contextual ? buttons) or at the start
 * page (? shortcut / top bar button).
 */
export function HelpDialog(): JSX.Element {
  const topic = useHelpStore((state) => state.topic);
  const closeHelp = useHelpStore((state) => state.closeHelp);
  const [filter, setFilter] = useState('');

  const open = topic !== null;
  const active: HelpTopic = topic ?? 'start';

  const visibleTopics = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query === '') return HELP_TOPIC_IDS;
    return HELP_TOPIC_IDS.filter((id) => {
      const entry = HELP_CONTENT[id];
      const haystack =
        `${entry.title} ${entry.summary} ${entry.tips.join(' ')} ${entry.keywords ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [filter]);

  const entry = HELP_CONTENT[active];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeHelp();
          setFilter('');
        }
      }}
    >
      <DialogContent
        className="flex h-[80vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl"
        data-testid="help-dialog"
      >
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CircleHelpIcon aria-hidden className="size-4" />
            Help
          </DialogTitle>
          <DialogDescription>
            What you can do on each screen — or search for a feature.
          </DialogDescription>
          <input
            value={filter}
            placeholder="Search help…"
            aria-label="Search help"
            className="mt-2 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            data-testid="help-search"
          />
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Help topics"
            className="min-h-0 shrink-0 overflow-y-auto border-b p-2 sm:w-56 sm:border-r sm:border-b-0"
          >
            <ul className="flex flex-col gap-0.5">
              {visibleTopics.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className={cn(
                      'w-full rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent',
                      id === active && 'bg-accent font-medium text-accent-foreground',
                    )}
                    onClick={() => {
                      useHelpStore.setState({ topic: id });
                    }}
                  >
                    {HELP_CONTENT[id].title}
                  </button>
                </li>
              ))}
              {visibleTopics.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching topic.</li>
              )}
            </ul>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="help-content">
            <h2 className="text-sm font-semibold">{entry.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{entry.summary}</p>
            <ul className="mt-3 flex flex-col gap-2">
              {entry.tips.map((tip, index) => (
                <li key={index} className="flex gap-2 text-sm">
                  <span
                    aria-hidden
                    className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                  />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
