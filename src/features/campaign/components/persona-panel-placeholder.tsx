import { MessageSquareTextIcon } from 'lucide-react';

/** Right-pane placeholder for the persona Assistant/Runs panel (built in T7). */
export function PersonaPanelPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquareTextIcon aria-hidden className="size-6 text-muted-foreground" />
      <h2 className="text-sm font-medium">Persona panel</h2>
      <p className="max-w-[26ch] text-xs text-muted-foreground">
        The Assistant and Runs tabs arrive with the persona engine (T7).
      </p>
    </div>
  );
}
