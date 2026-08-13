import { create } from "zustand";
import { openDB, type IDBPDatabase } from "idb";
import { apiPost } from "../api/client";
import type { Account } from "../types";

const DB_NAME = "asspp-accounts";
const STORE_NAME = "accounts";
const AUTH_VERIFIED_EVENT = "asspp-auth-verified";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "email" });
        }
      },
    });
  }
  return dbPromise;
}

async function mirrorAccounts(accounts: Account[]): Promise<void> {
  try {
    await apiPost("/api/account/all/import", { accounts });
  } catch {
    // IndexedDB remains the source of truth for the personal UI. Mirroring is
    // best-effort because it can run before the password gate is unlocked.
  }
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: () => Promise<void>;
  addAccount: (account: Account) => Promise<void>;
  removeAccount: (email: string) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: true,

  loadAccounts: async () => {
    set({ loading: true });
    const db = await getDB();
    const accounts = await db.getAll(STORE_NAME);
    set({ accounts, loading: false });
    await mirrorAccounts(accounts);
  },

  addAccount: async (account: Account) => {
    const db = await getDB();
    await db.put(STORE_NAME, account);
    const accounts = [
      ...get().accounts.filter((a) => a.email !== account.email),
      account,
    ];
    set({ accounts });
    await mirrorAccounts(accounts);
  },

  removeAccount: async (email: string) => {
    const db = await getDB();
    await db.delete(STORE_NAME, email);
    const accounts = get().accounts.filter((a) => a.email !== email);
    set({ accounts });
    await mirrorAccounts(accounts);
  },

  updateAccount: async (account: Account) => {
    const db = await getDB();
    await db.put(STORE_NAME, account);
    const accounts = get().accounts.map((a) =>
      a.email === account.email ? account : a,
    );
    set({ accounts });
    await mirrorAccounts(accounts);
  },
}));

// Auto-load accounts on import
useAccountsStore.getState().loadAccounts();

window.addEventListener(AUTH_VERIFIED_EVENT, () => {
  void useAccountsStore.getState().loadAccounts();
});
