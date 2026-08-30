/** Centralized date/time formatting so timestamps render the same everywhere. */
export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
