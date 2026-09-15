/** Clipboard capability boundary. Callers own their user-visible success/error messages. */
export async function copyText(text: string): Promise<void> {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) throw new Error('Clipboard API is unavailable here');
  await clipboard.writeText(text);
}
