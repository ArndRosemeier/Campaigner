import Dexie from 'dexie';

import { db } from '@/db/db';

/** localStorage keys owned by the app; the theme preference survives wipes. */
const APP_STORAGE_PREFIX = 'campaigner.';
const PRESERVED_KEYS = new Set(['campaigner.theme']);

/**
 * "Delete all data" (05-UI.md §Settings danger zone): closes and deletes the
 * IndexedDB database and clears app-owned localStorage (except the theme).
 * The caller reloads the page afterwards so all stores re-seed.
 */
export async function deleteAllData(): Promise<void> {
  db.close(); // synchronous
  // Dexie.delete() returns a Dexie (thenable); normalize for strict typing.
  const deletion: Promise<void> = Dexie.delete(db.name).then(() => undefined);
  await deletion;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(APP_STORAGE_PREFIX) && !PRESERVED_KEYS.has(key)) {
      localStorage.removeItem(key);
    }
  }
}
