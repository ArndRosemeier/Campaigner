/**
 * Device/browser capability probes for the tablet/PWA support (05-UI.md
 * §Tablet). All probes are conservative capability detection: when the
 * platform lacks the API (jsdom, old webviews), the answer is the safe
 * default — feature missing, not an error state.
 */

const INSTALL_HINT_KEY = 'campaigner.install-hint-dismissed';

/** Safe matchMedia: jsdom has none; absence reads as "does not match". */
export function mediaMatches(query: string): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** True when running as an installed home-screen web app. */
export function isStandalone(): boolean {
  if (mediaMatches('(display-mode: standalone)')) return true;
  // iOS home screen apps expose a non-standard flag instead.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** True on primary-touch devices (tablets/phones). */
export function isCoarsePointer(): boolean {
  return mediaMatches('(pointer: coarse)');
}

/**
 * The one-time "install to home screen" hint: touch device, running as a
 * plain browser tab (not installed), and not dismissed before. iOS has no
 * programmatic install prompt, so this is the app's only nudge.
 */
export function shouldShowInstallHint(): boolean {
  if (!isCoarsePointer() || isStandalone()) return false;
  return localStorage.getItem(INSTALL_HINT_KEY) === null;
}

export function dismissInstallHint(): void {
  localStorage.setItem(INSTALL_HINT_KEY, new Date().toISOString());
}

export function installHintDismissed(): boolean {
  return localStorage.getItem(INSTALL_HINT_KEY) !== null;
}

/**
 * Requests persistent storage so the browser will not evict the IndexedDB
 * under storage pressure (Safari's ITP additionally caps non-installed
 * sites at 7 days of no use — installing is the real fix; this request is
 * the belt to those braces). Rejections are surfaced by the caller
 * (AppShell startup toasts), never swallowed here.
 */
export async function ensurePersistentStorage(): Promise<void> {
  // Runtime feature detection — lib.dom types StorageManager as always
  // present, but jsdom and older Safari genuinely lack it.
  const storage = (navigator as { storage?: StorageManager }).storage;
  if (storage?.persist === undefined) return;
  if (await storage.persisted()) return;
  await storage.persist();
}

/**
 * Current persistence status: true/false from the platform, null when the
 * API is unavailable (informational line is hidden in that case).
 */
export async function storagePersistedStatus(): Promise<boolean | null> {
  const storage = (navigator as { storage?: StorageManager }).storage;
  if (storage?.persisted === undefined) return null;
  return storage.persisted();
}
