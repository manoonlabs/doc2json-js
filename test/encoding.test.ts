import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/encoding";

describe("base64", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 256);

  it("round-trips with Buffer", () => {
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips without Buffer (browser path)", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      const encoded = bytesToBase64(bytes);
      expect(base64ToBytes(encoded)).toEqual(bytes);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
