import { describe, it, expect } from "vitest";
import {
  findAccountIndexByRouteSegment,
  getAccountDisplayAppleId,
  getAccountDisplayEmail,
  getAccountDisplayName,
  getAccountOptionLabel,
  getAccountRouteSegment,
} from "../../src/utils/accountDisplay";
import type { Account } from "../../src/types";

const t = ((key: string, options?: { number?: number }) => {
  if (key === "demo.accountName") return "Demo Account";
  if (key === "demo.accountNameWithNumber") {
    return `Demo Account ${options?.number}`;
  }
  if (key === "demo.hidden") return "Hidden";
  return key;
}) as any;

const account: Account = {
  email: "test@example.com",
  password: "password",
  appleId: "test@example.com",
  store: "143441-1,29",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "123",
  cookies: [],
  deviceIdentifier: "abcdef123456",
};

describe("utils/accountDisplay", () => {
  it("should show real account identity when demo mode is disabled", () => {
    expect(getAccountDisplayName(account, t, false)).toBe("Test User");
    expect(getAccountDisplayEmail(account, t, false)).toBe("test@example.com");
    expect(getAccountDisplayAppleId(account, t, false)).toBe(
      "test@example.com",
    );
    expect(getAccountOptionLabel(account, t, false)).toBe(
      "Test User (test@example.com)",
    );
  });

  it("should hide account identity when demo mode is enabled", () => {
    expect(getAccountDisplayName(account, t, true, 0)).toBe("Demo Account 1");
    expect(getAccountDisplayEmail(account, t, true)).toBe("Hidden");
    expect(getAccountDisplayAppleId(account, t, true)).toBe("Hidden");
    expect(getAccountOptionLabel(account, t, true, 0)).toBe("Demo Account 1");
  });

  it("should use demo route segments without exposing email", () => {
    expect(getAccountRouteSegment(account, true, 2)).toBe("demo-3");
    expect(getAccountRouteSegment(account, false, 2)).toBe(
      "test%40example.com",
    );
  });

  it("should resolve demo route segments to account indexes", () => {
    expect(findAccountIndexByRouteSegment([account], "demo-1")).toBe(0);
    expect(
      findAccountIndexByRouteSegment([account], "test@example.com"),
    ).toBe(0);
  });
});
