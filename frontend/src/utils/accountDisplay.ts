import type { TFunction } from "i18next";
import type { Account } from "../types";

const demoRoutePrefix = "demo-";

export function getAccountDisplayName(
  account: Account,
  t: TFunction,
  demoMode: boolean,
  index?: number,
): string {
  if (demoMode) {
    return getDemoAccountName(t, index);
  }

  const name = `${account.firstName} ${account.lastName}`.trim();
  return name || account.email;
}

export function getAccountDisplayEmail(
  account: Account,
  t: TFunction,
  demoMode: boolean,
): string {
  return demoMode ? t("demo.hidden") : account.email;
}

export function getAccountDisplayAppleId(
  account: Account,
  t: TFunction,
  demoMode: boolean,
): string {
  return demoMode ? t("demo.hidden") : account.appleId || account.email;
}

export function getAccountOptionLabel(
  account: Account,
  t: TFunction,
  demoMode: boolean,
  index?: number,
): string {
  if (demoMode) {
    return getDemoAccountName(t, index);
  }

  return `${getAccountDisplayName(account, t, false)} (${account.email})`;
}

export function getAccountRouteSegment(
  account: Account,
  demoMode: boolean,
  index: number,
): string {
  return demoMode
    ? `${demoRoutePrefix}${index + 1}`
    : encodeURIComponent(account.email);
}

export function findAccountIndexByRouteSegment(
  accounts: Account[],
  routeSegment: string,
): number {
  if (routeSegment.startsWith(demoRoutePrefix)) {
    const index = Number(routeSegment.slice(demoRoutePrefix.length)) - 1;
    return Number.isInteger(index) ? index : -1;
  }

  return accounts.findIndex((account) => account.email === routeSegment);
}

function getDemoAccountName(
  t: TFunction,
  index?: number,
): string {
  if (typeof index === "number") {
    return t("demo.accountNameWithNumber", { number: index + 1 });
  }

  return t("demo.accountName");
}
