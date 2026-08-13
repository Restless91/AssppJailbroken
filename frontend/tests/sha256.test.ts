import { describe, expect, it } from "vitest";
import { sha256HexFallback } from "../src/utils/sha256";

describe("sha256HexFallback", () => {
  it("matches the SHA-256 standard vector", () => {
    expect(sha256HexFallback(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes UTF-8 input consistently", () => {
    expect(sha256HexFallback(new TextEncoder().encode("访问密码"))).toBe(
      "f4f712d5be91721a35df604c380a06e99666727fcc2aadfe15d2475c86a16363",
    );
  });
});
