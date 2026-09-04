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
