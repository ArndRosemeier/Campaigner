import type { JSX } from 'react';

import { entranceMarkerConfig, type EncounterLayout } from '@/domain';

/** Rotation (deg) of the down-pointing base glyph so it points INWARD. */
const ENTRANCE_ROTATION = { north: 0, east: 90, south: 180, west: 270 } as const;

export function EncounterLayoutPreview({
  layout,
  overlay = false,
}: {
  layout: EncounterLayout;
  overlay?: boolean;
}): JSX.Element {
  return (
    <div
      className={
        overlay
          ? 'pointer-events-none absolute inset-0 overflow-hidden'
          : 'relative w-full overflow-hidden rounded-md border bg-muted'
      }
      style={{ aspectRatio: `${String(layout.gridW)} / ${String(layout.gridH)}` }}
      data-testid="encounter-layout-preview"
    >
      {layout.rooms.flatMap((room) =>
        room.rects.map((rect, index) => (
          <div
            key={`${room.id}-${String(index)}`}
            className="absolute border border-primary/70 bg-primary/10"
            style={{
              left: `${String((rect.x / layout.gridW) * 100)}%`,
              top: `${String((rect.y / layout.gridH) * 100)}%`,
              width: `${String((rect.w / layout.gridW) * 100)}%`,
              height: `${String((rect.h / layout.gridH) * 100)}%`,
            }}
            title={room.name}
          >
            {index === 0 && (
              <span className="block truncate bg-background/70 px-0.5 text-[9px]">{room.name}</span>
            )}
          </div>
        )),
      )}
      {layout.rooms.map((room) => (
        <div
          key={`${room.id}-mobs`}
          className="pointer-events-none absolute border border-dashed border-destructive/80 bg-destructive/10"
          style={{
            left: `${String((room.mobsRect.x / layout.gridW) * 100)}%`,
            top: `${String((room.mobsRect.y / layout.gridH) * 100)}%`,
            width: `${String((room.mobsRect.w / layout.gridW) * 100)}%`,
            height: `${String((room.mobsRect.h / layout.gridH) * 100)}%`,
          }}
          title={`${room.name} mob area`}
        />
      ))}
      {layout.rooms.map((room) => {
        const entrance = room.entrance;
        if (entrance === undefined) return null;
        const marker = entranceMarkerConfig(layout.rooms.length);
        const hue = marker?.hue ?? 300;
        return (
          <div
            key={`${room.id}-entrance`}
            className="pointer-events-none absolute"
            style={{
              left: `${String(((entrance.x + 0.5) / layout.gridW) * 100)}%`,
              top: `${String(((entrance.y + 0.5) / layout.gridH) * 100)}%`,
              transform: `translate(-50%, -50%) rotate(${String(ENTRANCE_ROTATION[entrance.side])}deg)`,
            }}
            title={`${room.name} entrance`}
            data-testid="encounter-entrance-marker"
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderTop: `12px solid hsl(${String(hue)}, 100%, 50%)`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
