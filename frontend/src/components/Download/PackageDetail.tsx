import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import Badge from "../common/Badge";
import ProgressBar from "../common/ProgressBar";
import Modal from "../common/Modal";
import DownloadLog from "./DownloadLog";
import VerificationSummary from "./VerificationSummary";
import { useDownloads } from "../../hooks/useDownloads";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { getInstallInfo } from "../../api/install";
import { getAccessToken } from "../Auth/PasswordGate";
import { listVersions } from "../../api/apple";
import { lookupApp } from "../../api/search";
import { getAccountOptionLabel } from "../../utils/accountDisplay";
import { getAccountContext } from "../../utils/toast";
import { isNewerVersion } from "../../utils/version";
import { storeIdToCountry } from "../../apple/config";
import type { Software } from "../../types";

export default function PackageDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    tasks,
    fetchTasks,
    deleteDownload,
    pauseDownload,
    resumeDownload,
    hashToEmail,
  } = useDownloads();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { accounts, updateAccount } = useAccounts();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const { startDownload } = useDownloadAction();

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [latestApp, setLatestApp] = useState<Software | null>(null);
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [downloadAction, setDownloadAction] = useState<
    "device" | "simulator" | null
  >(null);

  const task = tasks.find((t) => t.id === id);

  if (!task) {
    return (
      <PageContainer title={t("downloads.package.title")}>
        <div className="py-12 text-center text-muted">
          {tasks.length === 0 ? t("loading") : t("downloads.package.notFound")}
        </div>
      </PageContainer>
    );
  }

  const packageTask = task;
  const isActive =
    task.status === "downloading" ||
    task.status === "injecting" ||
    task.status === "decrypting";
  const canPause =
    task.status === "downloading" || task.status === "decrypting";
  const isPaused = task.status === "paused";
  const isCompleted = task.status === "completed";
  const installInfo = isCompleted ? getInstallInfo(task.id) : null;

  const accountEmail = hashToEmail[task.accountHash];
  const accountIndex = accounts.findIndex((a) => a.email === accountEmail);
  const account = accountIndex >= 0 ? accounts[accountIndex] : undefined;
  const ctx = getAccountContext(account, t);
  const appName = task.software.name;
  const accountLabel = account
    ? getAccountOptionLabel(account, t, demoMode, accountIndex)
    : demoMode
      ? t("demo.hidden")
      : accountEmail || task.accountHash;

  function toastAction(titleKey: string, type: "success" | "info" = "info") {
    addToast(t("toast.msg", { appName, ...ctx }), type, t(titleKey));
  }

  async function handleDelete() {
    if (!confirm(t("downloads.package.deleteConfirm"))) return;
    await deleteDownload(task!.id);
    toastAction("toast.title.deleteSuccess", "success");
    navigate("/downloads");
  }

  async function handleShare(e: React.MouseEvent) {
    e.preventDefault();
    if (!installInfo) return;

    const urlToShare = installInfo.installUrl;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(urlToShare);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = urlToShare;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
    } catch (err) {
      console.warn("Clipboard fallback failed:", err);
    }

    addToast(
      t("toast.msgShare", { appName, ...ctx }),
      "success",
      t("toast.title.shareAcquired"),
    );

    if (navigator.share) {
      try {
        await navigator.share({ text: urlToShare });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        console.warn("Native share failed or aborted by user:", error);
      }
    }
  }

  async function handleCheckUpdate() {
    if (!task || !account) return;
    setCheckingUpdate(true);
    try {
      const country = storeIdToCountry(account.store) ?? "US";
      const app = await lookupApp(task.software.bundleID, country);

      if (app && isNewerVersion(app.version, task.software.version)) {
        setLatestApp(app);
        const result = await listVersions(account, app);
        setAvailableVersions(result.versions);
        await updateAccount(result.account);
        setSelectedVersion(result.versions[0] || "");
        setShowUpdateModal(true);
      } else {
        addToast(t("downloads.package.noUpdate"), "info");
      }
    } catch {
      addToast(t("downloads.package.checkUpdateFailed"), "error");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleConfirmUpdate() {
    if (!task || !account || !latestApp) return;
    setShowUpdateModal(false);
    try {
      const isLatest =
        availableVersions.length > 0 &&
        selectedVersion === availableVersions[0];
      await startDownload(
        account,
        latestApp,
        isLatest ? undefined : selectedVersion,
      );
      await deleteDownload(task.id);
      navigate("/downloads");
    } catch {
      addToast(t("downloads.package.updateFailed"), "error");
    }
  }

  function packageDownloadURL(target: "device" | "simulator") {
    const endpoint = target === "simulator" ? "simulator-file" : "file";
    const params = new URLSearchParams({
      accountHash: packageTask.accountHash,
    });
    const accessToken = getAccessToken();
    if (accessToken) {
      params.set("accessToken", accessToken);
    }
    return `/api/packages/${packageTask.id}/${endpoint}?${params}`;
  }

  function handleDownloadIpa(target: "device" | "simulator") {
    const titleKey =
      target === "simulator"
        ? "toast.title.downloadSimulatorIpaStarted"
        : "toast.title.downloadIpaStarted";

    setDownloadAction(target);
    toastAction(titleKey);
    if (target === "simulator") {
      void fetchTasks();
      const refreshInterval = window.setInterval(() => {
        void fetchTasks();
      }, 1000);
      window.setTimeout(() => {
        window.clearInterval(refreshInterval);
        void fetchTasks();
        setDownloadAction(null);
      }, 120000);
      return;
    }

    window.setTimeout(() => {
      setDownloadAction(null);
    }, 1000);
  }

  return (
    <PageContainer title={t("downloads.package.title")}>
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <AppIcon
            url={task.software.artworkUrl}
            name={task.software.name}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <h2 className="page-title break-words">
              {task.software.name}
            </h2>
            <p className="page-subtitle">
              {task.software.artistName}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Badge status={task.status} />
              <span className="text-[13px] text-muted">
                v{task.software.version}
              </span>
            </div>
          </div>
        </div>

        {(isActive || isPaused) && (
          <div>
            <ProgressBar progress={task.progress} />
            <div className="mt-1 flex justify-between text-[13px] text-muted">
              <span>{Math.round(task.progress)}%</span>
              {task.speed && isActive && <span>{task.speed}</span>}
            </div>
          </div>
        )}

        {task.error && (
          <p className="alert" data-tone="error">{task.error}</p>
        )}

        <VerificationSummary
          verification={task.verification}
          sha256={task.sha256}
          errorCode={task.errorCode}
        />

        {task.decryptCheckpoint && !isCompleted && (
          <div className="card card-pad text-sm">
            <div className="flex justify-between gap-4">
              <span className="detail-label">{t("downloads.checkpoint.title")}</span>
              <span className="detail-value">
                {t("downloads.checkpoint.progress", {
                  completed: task.decryptCheckpoint.completedMachOCount,
                  total: task.decryptCheckpoint.totalMachOCount ?? "?",
                })}
              </span>
            </div>
            <div className="mt-2 flex justify-between gap-4 text-muted">
              <span>{t("downloads.checkpoint.batch", { size: task.decryptCheckpoint.batchSize })}</span>
              <span>{t("downloads.checkpoint.attempt", { count: task.decryptCheckpoint.attempt })}</span>
            </div>
            {task.decryptCheckpoint.currentPath && (
              <p className="mt-2 truncate font-mono text-xs text-muted">
                {task.decryptCheckpoint.currentPath}
              </p>
            )}
          </div>
        )}

        {((task.logs?.length ?? 0) > 0 ||
          isActive ||
          downloadAction === "simulator") && (
          <DownloadLog lines={task.logs} />
        )}

        <div className="card card-pad">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="detail-label flex-shrink-0">
                {t("downloads.package.bundleId")}
              </dt>
              <dd className="detail-value ml-4 min-w-0 truncate">
                {task.software.bundleID}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="detail-label flex-shrink-0">
                {t("downloads.package.version")}
              </dt>
              <dd className="detail-value">
                {task.software.version}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="detail-label flex-shrink-0">
                {t("downloads.package.account")}
              </dt>
              <dd className="detail-value ml-4 min-w-0 truncate">
                {accountLabel}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="detail-label flex-shrink-0">
                {t("downloads.package.created")}
              </dt>
              <dd className="detail-value">
                {new Date(task.createdAt).toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            {isCompleted && (
              <>
                <button
                  onClick={handleCheckUpdate}
                  disabled={checkingUpdate}
                  className="btn btn-ghost"
                >
                  {checkingUpdate
                    ? t("downloads.package.checkingUpdate")
                    : t("downloads.package.checkUpdate")}
                </button>
                {installInfo && (
                  <>
                    <a
                      href={installInfo.installUrl}
                      onClick={() => toastAction("toast.title.installStarted")}
                      className="btn btn-success"
                    >
                      {t("downloads.package.install")}
                    </a>

                    <div className="relative group flex items-center">
                      <button
                        onClick={handleShare}
                        className="btn btn-accent cursor-pointer"
                      >
                        {t("downloads.package.share")}
                      </button>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-all duration-200 z-50 pointer-events-none">
                        <div className="flex flex-col items-center rounded-[14px] border border-border-strong bg-elevated p-2 shadow-[0_20px_50px_-24px_rgba(0,0,0,0.5)]">
                          <QRCodeSVG
                            value={installInfo.installUrl}
                            size={128}
                            className="mb-1"
                          />
                          <span className="mt-1 whitespace-nowrap text-[12px] text-muted">
                            {t("downloads.package.scan")}
                          </span>
                          <div className="absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-border-strong bg-elevated"></div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
                <a
                  href={packageDownloadURL("device")}
                  onClick={() => handleDownloadIpa("device")}
                  className="btn btn-primary"
                >
                  {t("downloads.package.downloadIpa")}
                </a>
                <a
                  href={packageDownloadURL("simulator")}
                  onClick={() => handleDownloadIpa("simulator")}
                  className="btn btn-ghost"
                >
                  {t("downloads.package.downloadSimulatorIpa")}
                </a>
              </>
            )}
            {canPause && (
              <button
                onClick={() => pauseDownload(task.id)}
                className="btn btn-ghost"
              >
                {t("downloads.package.pause")}
              </button>
            )}
            {isPaused && (
              <button
                onClick={() => resumeDownload(task.id)}
                className="btn btn-primary"
              >
                {t("downloads.package.resume")}
              </button>
            )}
            <button
              onClick={handleDelete}
              className="btn btn-danger"
            >
              {t("downloads.package.delete")}
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        title={t("downloads.package.updateAvailable")}
      >
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            {t("downloads.package.updatePrompt", {
              version: latestApp?.version,
            })}
          </p>
          {availableVersions.length > 0 && (
            <div>
              <label className="field-label">
                {t("downloads.package.selectVersion")}
              </label>
              <select
                value={selectedVersion}
                onChange={(e) => setSelectedVersion(e.target.value)}
                className="field-input field-select"
              >
                {availableVersions.map((v, i) => (
                  <option key={v} value={v}>
                    {i === 0
                      ? t("downloads.package.latestVersion", { id: v })
                      : v}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setShowUpdateModal(false)}
              className="btn btn-ghost"
            >
              {t("settings.data.cancel")}
            </button>
            <button
              onClick={handleConfirmUpdate}
              className="btn btn-primary"
            >
              {t("downloads.package.update")}
            </button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}
