import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import {
  purchaseApp,
  startAppleDownload,
} from "../api/apple";
import { apiGet } from "../api/client";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>("/api/settings");
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    const result = await startAppleDownload(
      account,
      app,
      versionId,
    );
    await updateAccount(result.account);

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    const purchasedAccount = await purchaseApp(account, app);
    await updateAccount(purchasedAccount);

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
