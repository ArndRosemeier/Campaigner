import { create } from 'zustand';

import type { HelpTopic } from '@/help/helpContent';

/**
 * App-wide help dialog state: any surface can open help for itself via
 * `openHelp(topic)`; the dialog is mounted once in the AppShell.
 */
interface HelpStore {
  /** null = closed; otherwise the topic shown (defaults to 'start'). */
  topic: HelpTopic | null;
  openHelp: (topic?: HelpTopic) => void;
  closeHelp: () => void;
}

export const useHelpStore = create<HelpStore>((set) => ({
  topic: null,
  openHelp: (topic) => {
    set({ topic: topic ?? 'start' });
  },
  closeHelp: () => {
    set({ topic: null });
  },
}));
