/**
 * The structured-output schema NAME of the chat call in flight — the ONE seam
 * the transport-mocking tests use to tell a module's model calls apart (the
 * pass's critique is `adversarial-critique`, the shared text-transform core's
 * editor is `canvas-refine`).
 *
 * WHY IT IS A HELPER AND NOT A COPY (AGENTS §Centralization obligation 4): a
 * second spelling of this reader in `tests/llm/canvasChatChanges.test.ts` was
 * caught BY NAME by `tests/architecture/no-duplicate-implementations.test.ts`
 * when the adversarial chat trigger landed (docs/17 row 360) — the tripwire
 * doing exactly its job on a copy at birth. It lives here once; both files
 * import it.
 */
export function schemaNameOf(options: unknown): string {
  const format = (options as { responseFormat?: { name?: string } } | undefined)?.responseFormat;
  return format?.name ?? '';
}
