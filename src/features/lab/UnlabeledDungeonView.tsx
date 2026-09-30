import { useRef, useState } from 'react';
import type { JSX } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/toast';
import { normToPercent } from '@/features/lab/experiments/labeledDungeon';
import { runUnlabeledDungeonBench } from '@/features/lab/labClients';
import {
  UNLABELED_DUNGEON_ROOM_COUNT,
  type UnlabeledDungeonMapResult,
} from '@/features/lab/experiments/unlabeledDungeon';

/**
 * The `unlabeled-dungeon-rooms` experiment body. Session-only state: maps
 * are in-memory data URLs, nothing is written to Dexie.
 */

type Phase = 'idle' | 'running' | 'done';

export interface UnlabeledDungeonViewProps {
  runLabel: string;
  costNote: string;
}

export function UnlabeledDungeonView({ runLabel, costNote }: UnlabeledDungeonViewProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [results, setResults] = useState<UnlabeledDungeonMapResult[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [runError, setRunError] = useState<string>('');
  const runningRef = useRef(false);

  const run = async (): Promise<void> => {
    if (runningRef.current) {
      toastError('The unlabeled dungeon bench is already running — wait for it to finish; runs never queue.');
      return;
    }
    runningRef.current = true;
    setPhase('running');
    setResults([]);
    setNotices([]);
    setRunError('');
    try {
      const maps = await runUnlabeledDungeonBench((notice) => {
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
    <div className="flex flex-col gap-4" data-testid="unlabeled-dungeon-view">
      <div className="flex flex-col gap-1">
        <Button
          onClick={() => void run()}
          data-testid="unlabeled-dungeon-run"
          className="flex h-auto flex-col items-start gap-0.5 whitespace-normal py-2"
        >
          <span>{phase === 'running' ? 'Running bench…' : runLabel}</span>
          <span className="text-xs font-normal opacity-80">{costNote}</span>
        </Button>
        {phase === 'running' && (
          <p className="text-xs text-muted-foreground" data-testid="unlabeled-running">
            Generating a 2K map, then finding rooms — this takes a few minutes.
          </p>
        )}
      </div>

      {notices.length > 0 && (
        <Card data-testid="unlabeled-notices">
          <CardHeader>
            <CardTitle className="text-sm">Run notices</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-amber-600 dark:text-amber-400">
              {notices.map((notice, index) => (
                <li key={`unlabeled-notice-${index}`}>{notice}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {runError !== '' && (
        <Card data-testid="unlabeled-run-error">
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

function countBadge(result: UnlabeledDungeonMapResult): string {
  return `${String(result.rooms.length)} of ${String(result.expectedCount)} rooms reported`;
}

function MapResultCard({
  result,
  index,
}: {
  result: UnlabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  const mismatch = result.status === 'ok' && result.rooms.length !== result.expectedCount;
  return (
    <Card data-testid={`unlabeled-map-${index}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          Map {index + 1}
          <Badge variant="outline">
            {result.resolution} {result.aspectRatio}
          </Badge>
          {result.status === 'failed' ? (
            <Badge variant="destructive">vision failed</Badge>
          ) : (
            <Badge variant={mismatch ? 'destructive' : 'outline'}>{countBadge(result)}</Badge>
          )}
        </CardTitle>
        {result.status === 'ok' ? (
          <CardDescription className="text-xs">
            Vision model: {result.modelUsed}
            {result.droppedDuplicates > 0
              ? ` — ${String(result.droppedDuplicates)} duplicate index${result.droppedDuplicates === 1 ? '' : 'es'} dropped (first sighting kept).`
              : ''}
            {mismatch
              ? ` The map was drawn as ${String(UNLABELED_DUNGEON_ROOM_COUNT)} rooms; the model reported ${String(result.rooms.length)}.`
              : ''}
          </CardDescription>
        ) : (
          <CardDescription className="text-xs text-destructive">
            Vision pass failed loudly: {result.errorMessage} — no disks drawn for this map.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <figure className="flex flex-col gap-1">
          <figcaption className="text-xs text-muted-foreground">Original</figcaption>
          <img
            src={result.imageUrl}
            alt={`Generated unlabeled dungeon map ${index + 1}`}
            className="w-full rounded border"
          />
        </figure>
        <figure className="flex flex-col gap-1">
          <figcaption className="text-xs text-muted-foreground">
            Annotated — numbered disks are the model&apos;s room centers
          </figcaption>
          <AnnotatedMap result={result} index={index} />
        </figure>
        <RoomTable result={result} index={index} />
      </CardContent>
    </Card>
  );
}

function AnnotatedMap({
  result,
  index,
}: {
  result: UnlabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  return (
    <div className="relative w-full">
      <img
        src={result.imageUrl}
        alt={`Annotated unlabeled dungeon map ${index + 1}`}
        className="block w-full rounded border"
      />
      <svg className="absolute inset-0 h-full w-full" data-testid={`unlabeled-overlay-${index}`} aria-hidden>
        {result.rooms.map((room) => (
          <g key={room.index}>
            <circle
              cx={`${normToPercent(room.x)}%`}
              cy={`${normToPercent(room.y)}%`}
              r={14}
              fill="#38bdf8"
              fillOpacity={0.45}
              stroke="#ffffff"
              strokeWidth={2}
              data-testid={`unlabeled-disk-${index}-${room.index}`}
            />
            <text
              x={`${normToPercent(room.x)}%`}
              y={`${normToPercent(room.y)}%`}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fontWeight={700}
              fill="#ffffff"
              stroke="#000000"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {room.index}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function RoomTable({
  result,
  index,
}: {
  result: UnlabeledDungeonMapResult;
  index: number;
}): JSX.Element {
  return (
    <table className="w-full text-xs" data-testid={`unlabeled-table-${index}`}>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">#</th>
          <th className="py-1 pr-2 font-medium">x</th>
          <th className="py-1 pr-2 font-medium">y</th>
          <th className="py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {result.rooms.length === 0 ? (
          <tr data-testid={`unlabeled-row-${index}-empty`}>
            <td className="py-1 text-muted-foreground" colSpan={4}>
              {result.status === 'failed' ? result.errorMessage : 'No rooms reported.'}
            </td>
          </tr>
        ) : (
          result.rooms.map((room) => (
            <tr key={room.index} className="border-t" data-testid={`unlabeled-row-${index}-${room.index}`}>
              <td className="py-1 pr-2 font-semibold">{room.index}</td>
              <td className="py-1 pr-2">{room.x}</td>
              <td className="py-1 pr-2">{room.y}</td>
              <td className="py-1 text-muted-foreground">{room.note ?? ''}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
