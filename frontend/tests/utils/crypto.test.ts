import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptData, encryptData } from "../../src/utils/crypto";

describe("account backup encryption", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works on an insecure LAN origin without crypto.subtle", async () => {
    const randomSource = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: randomSource.getRandomValues.bind(randomSource),
    });
    const accounts = [{ email: "test@example.com", country: "CN", password: "secret" }];

    const encrypted = await encryptData(accounts, "backup-password");

    expect(encrypted).not.toContain("test@example.com");
    await expect(decryptData(encrypted, "backup-password")).resolves.toEqual(accounts);
  });

  it("rejects an incorrect password", async () => {
    const encrypted = await encryptData([{ email: "test@example.com" }], "correct");
    await expect(decryptData(encrypted, "incorrect")).rejects.toThrow("Decryption failed");
  });
});
