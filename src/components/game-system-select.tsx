import type { JSX } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GAME_SYSTEMS, GAME_SYSTEM_LABELS, gameSystemSchema, type GameSystem } from '@/domain/gameSystem';

interface CommonProps {
  ariaLabel: string;
  triggerClassName?: string;
  testId?: string;
}

/** A plain choice of one system, or a FILTER that also offers "all systems". */
type GameSystemSelectProps = CommonProps &
  (
    | { allLabel?: undefined; value: GameSystem; onChange: (system: GameSystem) => void }
    | { allLabel: string; value: GameSystem | 'all'; onChange: (system: GameSystem | 'all') => void }
  );

/**
 * THE game-system picker (docs/17 row 416): the campaign picker's new-campaign
 * choice, a rulebook's system and the bestiary filter render this ONE control,
 * so the option list and its labels are `domain/gameSystem`'s and nothing else.
 * The chosen value is parsed back through `gameSystemSchema`, never cast.
 */
export function GameSystemSelect(props: GameSystemSelectProps): JSX.Element {
  const items: Record<string, string> =
    props.allLabel === undefined ? GAME_SYSTEM_LABELS : { all: props.allLabel, ...GAME_SYSTEM_LABELS };
  return (
    <Select
      value={props.value}
      items={items}
      onValueChange={(value) => {
        if (value === null) return;
        if (value === 'all' && props.allLabel !== undefined) {
          props.onChange('all');
          return;
        }
        props.onChange(gameSystemSchema.parse(value));
      }}
    >
      <SelectTrigger className={props.triggerClassName} aria-label={props.ariaLabel} data-testid={props.testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.allLabel !== undefined && <SelectItem value="all">{props.allLabel}</SelectItem>}
        {GAME_SYSTEMS.map((system) => (
          <SelectItem key={system} value={system}>
            {GAME_SYSTEM_LABELS[system]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
