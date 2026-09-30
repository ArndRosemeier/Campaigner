import type { Id } from '@/domain';

/**
 * Module reader scroll memory (docs/17 row 305): the reader's PIXEL offset per
 * module, remembered for the SESSION only.
 *
 * WHY IT IS NEEDED. The reader's document is a plain `<div overflow-y-auto>`
 * inside `ModuleReaderPage`, and the route child under `AppShell`'s bare
 * `<Outlet/>` flips element type on every navigation (reader ⇄ battle ⇄ board
 * ⇄ modules list), so the reader UNMOUNTS and remounts at `scrollTop = 0` — the
 * owner's report ("the module text is rendered fresh and the scroll position is
 * not saved"). There is no keep-alive and no route cache anywhere (docs/18 §4),
 * and the browser's own `history.scrollRestoration` cannot help: the document
 * itself never scrolls. The text is NOT regenerated — it lives on the module
 * row and is re-read/re-parsed — so the only thing lost is the position.
 *
 * THE SHAPE, and why it is this one. A plain module-scope map of one number per
 * module: the `features/modules/canvas/canvasView.lastCanvasScroll` precedent
 * (a session value at module scope, NOT a React store). Nothing RENDERS from
 * this value — the reader applies it imperatively once its content has
 * committed — so a zustand store (`previewStore`'s shape, keyed per module)
 * would add a subscription channel with no subscriber and a re-render risk on
 * every scroll land. It is deliberately NOT persisted: no Dexie write, no
 * settings field, no schema, no migration (the persisted arm is priced and
 * REJECTED in docs/18 §4 — `patchModule` re-stamps `updatedAt`, whose order is
 * semantic and load-bearing, and every landed write re-emits the module
 * liveQuery and re-parses every part). Lost on reload, by the owner's answer.
 *
 * Keyed by MODULE ID, never by history: that is what makes it work for BOTH
 * return paths (the browser's Back and the battle's in-app "Back to module",
 * which navigates without a hash) and for the plain modules-list round trip.
 */
const positions = new Map<Id, number>();

/** Remembers the reader's pixel offset for one module. */
export function rememberReaderScroll(moduleId: Id, top: number): void {
  positions.set(moduleId, top);
}

/** The remembered pixel offset for one module — `null` when none is known. */
export function recallReaderScroll(moduleId: Id): number | null {
  return positions.get(moduleId) ?? null;
}

/** Drops the memory (test isolation; the reader never needs to forget). */
export function resetReaderScroll(): void {
  positions.clear();
}
