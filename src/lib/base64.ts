/**
 * Base64 → bytes for binary payloads (image blobs in API responses and
 * export bundles). One shared implementation instead of the two formerly
 * identical private copies.
 */
export function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
