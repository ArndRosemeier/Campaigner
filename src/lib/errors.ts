/**
 * Thrown by repos when a referenced entity does not exist.
 *
 * Note: errors thrown inside a Dexie transaction get wrapped by Dexie
 * (name preserved, original stored as `inner`) when they cross the
 * transaction boundary — always match with `isNotFoundError`, not instanceof.
 */
export class NotFoundError extends Error {
  constructor(entity: string, key: string) {
    super(`${entity} not found: ${key}`);
    this.name = 'NotFoundError';
  }
}

/**
 * The message of any thrown value: `Error` instances keep their message,
 * anything else (strings, DOMExceptions are Errors too, plain objects) is
 * stringified. One home for the formerly inlined
 * `error instanceof Error ? error.message : String(error)` copies.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Type guard that also matches Dexie-wrapped NotFoundErrors. */
export function isNotFoundError(error: unknown): error is NotFoundError {
  if (error instanceof NotFoundError) return true;

  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError' &&
    (error as { inner?: unknown }).inner instanceof NotFoundError
  );
}

/**
 * True when a thrown value is the platform's out-of-storage refusal, whichever
 * spelling it arrived in (docs/17 row 265). ONE recognizer, because the
 * browsers disagree and the callers must not: the modern DOMException name is
 * `QuotaExceededError`, the legacy DOMException `code` is 22, and Firefox still
 * throws `NS_ERROR_DOM_QUOTA_REACHED` for the same condition. Dexie re-wraps an
 * error thrown inside a transaction (the `NotFoundError` note above), so the
 * `.inner` chain is walked a bounded way instead of comparing one level.
 *
 * A caller that recognizes this failure owes the user the MITIGATION, not the
 * error name: the platform's message is not a sentence anyone can act on, so
 * the surface pairs this predicate with its own "free space, then try again"
 * copy (docs/18 §2.3, the backup row).
 */
export function isQuotaExceededError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { name?: unknown; code?: unknown; inner?: unknown };
    if (candidate.name === 'QuotaExceededError') return true;
    if (candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    if (candidate.code === 22) return true;
    current = candidate.inner;
  }
  return false;
}
