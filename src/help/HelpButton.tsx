import type { JSX } from 'react';
import { CircleHelpIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { HelpTopic } from '@/help/helpContent';
import { useHelpStore } from '@/help/helpStore';

/**
 * Contextual help affordance: a small ? button that opens the help dialog
 * focused on this surface's topic. Place it in section headers.
 */
export function HelpButton({
  topic,
  label,
  className,
}: {
  /** Topic to open; omit to open the help index. */
  topic?: HelpTopic;
  /** Surface name for the accessible label, e.g. "artifact library". */
  label: string;
  className?: string;
}): JSX.Element {
  const openHelp = useHelpStore((state) => state.openHelp);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Help: ${label}`}
      title={`Help: ${label}`}
      className={className}
      onClick={() => {
        openHelp(topic);
      }}
    >
      <CircleHelpIcon aria-hidden />
    </Button>
  );
}
