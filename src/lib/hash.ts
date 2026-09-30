/**
 * SHA-256 hex digest of a UTF-8 string via the Web Crypto API.
 *
 * The single hashing helper in the app: `RuleChunk.contentHash` (embedding
 * cache key) and the ingestion pipeline both use it.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
