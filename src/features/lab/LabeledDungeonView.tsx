import { useRef, useState } from 'react';
import type { JSX } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/toast';
import { runLabeledDungeonBench } from '@/features/lab/labClients';
import {
  DUNGEON_BENCH_LABELS,
  normToPercent,
  type LabeledDungeonMapResult,
} from '@/features/lab/experiments/labeledDungeon';

/**
 * The `labeled-dungeon-maps` experiment body (registry `Body`): run control
 * + results renderer. All state is session-only (dies on reload; maps are
 * in-memory data URLs) — no Dexie, no schema changes, no persistence.
 */

type Phase = 'idle' | 'running' | 'done';

export interface LabeledDungeonViewProps {
  runLabel: string;
  costNote: string;
}

export function LabeledDungeonView({ runLabel, costNote }: LabeledDungeonViewProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [results, setResults] = useState<LabeledDungeonMapResult[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [runError, setRunError] = useState<string>('');
  // One run at a time: the ref is the guard (state lags the second click),
  // a second click while running refuses loudly and never queues.
  const runningRef = useRef(false);

  const run = async (): Promise<void> => {
    if (runningRef.current) {
      toastError('The dungeon bench is already running — wait for it to finish; runs never queue.');
      return;
    }
    runningRef.current = true;
    setPhase('running');
    setResults([]);
    setNotices([]);
    setRunError('');
    try {
      const maps = await runLabeledDungeonBench((notice) => {
        setNotices((previous) => [...previous, notice]);
      });
      setResults(maps);
      setPhase('done');
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
      setPhase('done');
    } finally {
      runningRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="labeled-dungeon-view">
      <div className="flex flex-col gap-1">
        <Button
          onClick={() => void run()}
          data-testid="lab-run"
          className="flex h-auto flex-col items-start gap-0.5 whitespace-normal py-2"
        >
          <span>{phase === 'running' ? 'Running bench…' : runLabel}</span>
          <span className="text-xs font-normal opacity-80">{costNote}</span>
        </Button>
        {phase === 'running' && (
          <p className="text-xs text-muted-foreground" data-testid="lab-running">
            Generating maps, then reading them back — this takes a few minutes.
          </p>
        )}
      </div>

      {notices.length > 0 && (
        <Card data-testid="lab-notices">
          <CardHeader>
            <CardTitle className="text-sm">Run notices</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-amber-600 dark:text-amber-400">
              {notices.map((notice, index) => (
                // Append-only run log: the index is the identity.
                <li key={`lab-notice-${index}`}>{notice}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {runError !== '' && (
        <Card data-testid="lab-run-error">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">Bench run failed</CardTitle>
            <CardDescription className="text-destructive">{runError}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {results.map((result, index) => (
        <MapResultCard key={result.imageUrl} result={result} index={index} />
      ))}
    </div>
  );
}

/** One map: side-by-side original vs annotated + the per-letter table. */
function MapResultCard({
  result,
  index,
}: {
  result: LabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  return (
    <Card data-testid={`lab-map-${index}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          Map {index + 1}
          {result.status === 'failed' ? (
            <Badge variant="destructive">vision failed</Badge>
          ) : (
            <Badge variant="outline">
              {result.marks.length} of {DUNGEON_BENCH_LABELS.length} letters found
            </Badge>
          )}
        </CardTitle>
        {result.status === 'ok' ? (
          <CardDescription className="text-xs">Vision model: {result.modelUsed}</CardDescription>
        ) : (
          <CardDescription className="text-xs text-destructive">
            Vision pass failed loudly: {result.errorMessage} — no disks drawn for this map.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <figure className="flex flex-col gap-1">
            <figcaption className="text-xs text-muted-foreground">Original</figcaption>
            <img src={result.imageUrl} alt={`Generated dungeon map ${index + 1}`} className="w-full rounded border" />
          </figure>
          <figure className="flex flex-col gap-1">
            <figcaption className="text-xs text-muted-foreground">Annotated</figcaption>
            <AnnotatedMap result={result} index={index} />
          </figure>
        </div>
        <LetterTable result={result} index={index} />
      </CardContent>
    </Card>
  );
}

/**
 * Annotated map: the image plus an SVG overlay of half-transparent disks at
 * the returned coordinates with letter tags. Coordinate mapping is pure
 * (`normToPercent`) — pinned by unit tests.
 */
function AnnotatedMap({
  result,
  index,
}: {
  result: LabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  return (
    <div className="relative w-full">
      <img
        src={result.imageUrl}
        alt={`Annotated dungeon map ${index + 1}`}
        className="block w-full rounded border"
      />
      <svg
        className="absolute inset-0 h-full w-full"
        data-testid={`lab-overlay-${index}`}
        aria-hidden
      >
        {result.marks.map((mark) => (
          <g key={mark.label}>
            <circle
              cx={`${normToPercent(mark.x)}%`}
              cy={`${normToPercent(mark.y)}%`}
              r={16}
              fill="#ef4444"
              fillOpacity={0.5}
              stroke="#ffffff"
              strokeWidth={2}
              data-testid={`lab-disk-${index}-${mark.label}`}
            />
            <text
              x={`${normToPercent(mark.x)}%`}
              y={`${normToPercent(mark.y)}%`}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontWeight={700}
              fill="#ffffff"
              stroke="#000000"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {mark.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * Per-letter table: label, x, y, status found/missing (+ the model's raw
 * note if any). A MISSING letter renders NO disk and a loud "not found"
 * row — never an invented coordinate.
 */
function LetterTable({
  result,
  index,
}: {
  result: LabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  const byLabel = new Map(result.marks.map((mark) => [mark.label, mark]));
  return (
    <table className="w-full text-xs" data-testid={`lab-table-${index}`}>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Letter</th>
          <th className="py-1 pr-2 font-medium">x</th>
          <th className="py-1 pr-2 font-medium">y</th>
          <th className="py-1 pr-2 font-medium">Status</th>
          <th className="py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {DUNGEON_BENCH_LABELS.map((label) => {
          const mark = byLabel.get(label);
          const found = mark !== undefined;
          return (
            <tr key={label} className="border-t" data-testid={`lab-row-${index}-${label}`}>
              <td className="py-1 pr-2 font-semibold">{label}</td>
              <td className="py-1 pr-2">{found ? mark.x : '—'}</td>
              <td className="py-1 pr-2">{found ? mark.y : '—'}</td>
              <td className="py-1 pr-2">
                {found ? (
                  <Badge variant="outline">found</Badge>
                ) : (
                  <Badge variant="destructive">not found</Badge>
                )}
              </td>
              <td className="py-1 text-muted-foreground">
                {found && mark.note !== undefined ? mark.note : result.status === 'failed' ? result.errorMessage : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
