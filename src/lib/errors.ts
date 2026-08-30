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
