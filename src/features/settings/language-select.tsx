import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LanguagesIcon } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { GENERATION_LANGUAGES } from '@/domain/settings';

/**
 * Generation-language picker (settings §language): reads/writes the
 * `language` field of the local settings row (default English). Rendered in
 * the top bar — i.e. on the main page — and on the Settings page.
 */
export function LanguageSelect({
  ariaLabel = 'Generation language',
  compact = false,
}: {
  ariaLabel?: string;
  /** Compact width for the top bar. */
  compact?: boolean;
}): JSX.Element {
  const settings = useLiveQuery(() => readSettings(), []);

  return (
    <Select
      value={settings?.language ?? 'en'}
      items={Object.fromEntries(
        GENERATION_LANGUAGES.map((language) => [language.code, language.label]),
      )}
      onValueChange={(value) => {
        if (value !== null) void updateSettings({ language: value });
      }}
    >
      <SelectTrigger aria-label={ariaLabel} className={compact ? 'w-36' : 'w-52'}>
        <LanguagesIcon aria-hidden className="size-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GENERATION_LANGUAGES.map((language) => (
          <SelectItem key={language.code} value={language.code}>
            {language.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
