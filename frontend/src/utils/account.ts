import { storeIdToCountry } from "../apple/config";
import type { Account } from "../types";
import { sha256Hex } from "./sha256";

function normalizeStorefront(store?: string): string | undefined {
  if (!store) return undefined;
  const [storeId] = store.split("-");
  return storeId || undefined;
}

export function accountStoreCountry(
  account?: Account | null,
): string | undefined {
  const storeId = normalizeStorefront(account?.store);
  if (!storeId) return undefined;
  return storeIdToCountry(storeId);
}

export function firstAccountCountry(accounts: Account[]): string | undefined {
  for (const account of accounts) {
    const country = accountStoreCountry(account);
    if (country) return country;
  }
  return undefined;
}

export async function accountHash(account: Account): Promise<string> {
  const source =
    account.directoryServicesIdentifier || account.appleId || account.email;
  return sha256Hex(source);
}
