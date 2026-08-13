import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        loading: "加载中",
        "auth.title": "访问密码",
        "auth.placeholder": "请输入访问密码",
        "auth.verifying": "验证中",
        "auth.submit": "解锁",
        "auth.error": "密码错误",
      })[key] ?? key,
  }),
}));

import PasswordGate from "../../src/components/Auth/PasswordGate";

describe("PasswordGate", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => array,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unlocks over plain HTTP when WebCrypto subtle is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({ required: true }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ ok: true }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PasswordGate>
        <div>设备后台</div>
      </PasswordGate>,
    );

    const input = await screen.findByPlaceholderText("请输入访问密码");
    await userEvent.type(input, "plain-http-password");
    await userEvent.click(screen.getByRole("button", { name: "解锁" }));

    await screen.findByText("设备后台");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/auth/verify");
    expect(JSON.parse(request[1].body)).toEqual({
      token: "23a55f52946a1ded6b422e2d051dc26618db620687e1d812b7283c2b6d40a83a",
    });
  });
});
