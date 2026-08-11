import type { TFunction } from "i18next";
import { storeIdToCountry } from "../apple/config";
import { useSettingsStore } from "../store/settings";
import {
  getAccountDisplayEmail,
  getAccountDisplayName,
} from "./accountDisplay";
import type { Account } from "../types";

export interface AccountContext {
  userName: string;
  appleId: string;
  country: string;
}

/**
 * Extract display-friendly account context for toast notifications.
 * Centralises the repeated pattern of building userName / appleId / country.
 */
export function getAccountContext(
  account: Account | undefined,
  t: TFunction,
): AccountContext {
  if (!account) {
    return { userName: "Unknown", appleId: "Unknown", country: "Unknown" };
  }
  const demoMode = useSettingsStore.getState().demoMode;
  const userName = getAccountDisplayName(account, t, demoMode);
  const appleId = getAccountDisplayEmail(account, t, demoMode);
  const rawCountryCode = storeIdToCountry(account.store) || "";
  const country = rawCountryCode
    ? t(`countries.${rawCountryCode}`, rawCountryCode)
    : account.store;
  return { userName, appleId, country };
}
