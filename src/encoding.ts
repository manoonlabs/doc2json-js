type BufferLike = {
  from(input: Uint8Array | string, encoding?: string): Uint8Array & { toString(e: string): string };
};

function nodeBuffer(): BufferLike | undefined {
  const value = (globalThis as { Buffer?: BufferLike }).Buffer;
  return typeof value?.from === "function" ? value : undefined;
}

/** Standard base64 of some bytes, in any runtime. */
export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = nodeBuffer();
  if (buffer) return buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Bytes of a standard base64 string, in any runtime. */
export function base64ToBytes(base64: string): Uint8Array {
  const buffer = nodeBuffer();
  if (buffer) return new Uint8Array(buffer.from(base64, "base64"));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
