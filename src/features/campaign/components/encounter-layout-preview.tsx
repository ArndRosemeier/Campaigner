import type { JSX } from 'react';

import type { EncounterLayout } from '@/domain';

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
        if (room.stagingPoint === undefined) return null;
        return (
          <div
            key={`${room.id}-marker`}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full border-2 border-black font-bold text-[10px] shadow-sm select-none"
            style={{
              left: `${String(room.stagingPoint.x * 100)}%`,
              top: `${String(room.stagingPoint.y * 100)}%`,
              width: '20px',
              height: '20px',
              backgroundColor: room.letter ? `hsl(${String(room.markerHue ?? 300)}, 100%, 50%)` : '#ec4899',
              color: '#000',
            }}
            title={`${room.name} staging marker ${room.letter ?? ''}`}
          >
            {room.letter ?? '•'}
          </div>
        );
      })}
    </div>
  );
}
