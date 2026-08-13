import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import {
  purchaseApp,
  startAppleDownload,
  startDefaultAppleDownload,
} from "../api/apple";
import { apiGet } from "../api/client";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

export type DownloadPreparationStage =
  | "checking"
  | "readingDescriptor"
  | "selectingHistory"
  | "confirming";

interface DownloadOptions {
  forceExtensionDecryption?: boolean;
  onPreparationStage?: (stage: DownloadPreparationStage) => void;
}

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
    account: Account | null | undefined,
    app: Software,
    versionId?: string,
    options?: DownloadOptions,
  ) {
    const ctx = account
      ? getAccountContext(account, t)
      : { userName: "iPhone 默认账户", appleId: "设备内账户" };
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

    options?.onPreparationStage?.("checking");
    const stageTimers = [
      window.setTimeout(
        () => options?.onPreparationStage?.("readingDescriptor"),
        700,
      ),
      window.setTimeout(
        () => options?.onPreparationStage?.("selectingHistory"),
        2_000,
      ),
      window.setTimeout(
        () => options?.onPreparationStage?.("confirming"),
        6_000,
      ),
    ];

    let task;
    try {
      if (account) {
        const result = await startAppleDownload(
          account,
          app,
          versionId,
          options?.forceExtensionDecryption,
        );
        await updateAccount(result.account);
        task = result.task;
      } else {
        const result = await startDefaultAppleDownload(
          app,
          versionId,
          options?.forceExtensionDecryption,
        );
        task = result.task;
      }
    } finally {
      stageTimers.forEach(window.clearTimeout);
    }

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
    return task;
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

  function toastDownloadError(account: Account | null | undefined, app: Software, error: unknown) {
    const ctx = account
      ? getAccountContext(account, t)
      : { userName: "iPhone 默认账户", appleId: "设备内账户" };
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
