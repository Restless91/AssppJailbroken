import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import ProgressBar from "../common/ProgressBar";
import Spinner from "../common/Spinner";
import DownloadItem from "./DownloadItem";
import { useDownloads } from "../../hooks/useDownloads";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useToastStore } from "../../store/toast";
import { lookupApp } from "../../api/search";
import { storeIdToCountry } from "../../apple/config";
import { getAccountContext } from "../../utils/toast";
import { isNewerVersion } from "../../utils/version";
import type { DownloadTask } from "../../types";

type StatusFilter = "all" | DownloadTask["status"];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function DownloadList() {
  const { t } = useTranslation();
  const {
    tasks,
    loading,
    pauseDownload,
    resumeDownload,
    deleteDownload,
    hashToEmail,
  } = useDownloads();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const addToast = useToastStore((s) => s.addToast);
  const { accounts } = useAccounts();
  const { startDownload } = useDownloadAction();

  const [checkingAll, setCheckingAll] = useState(false);
  const cancelCheckRef = useRef(false);
  const [checkProgress, setCheckProgress] = useState({
    current: 0,
    total: 0,
    appName: "",
  });

  useEffect(() => {
    return () => {
      cancelCheckRef.current = true;
    };
  }, []);

  const filtered =
    filter === "all" ? tasks : tasks.filter((t) => t.status === filter);

  const sortedTasks = [...filtered].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  function handleDelete(id: string) {
    if (!confirm(t("downloads.deleteConfirm"))) return;

    const task = tasks.find((t) => t.id === id);
    if (task) {
      const accountEmail = hashToEmail[task.accountHash];
      const account = accounts.find((a) => a.email === accountEmail);
      const ctx = getAccountContext(account, t);

      addToast(
        t("toast.msg", { appName: task.software.name, ...ctx }),
        "success",
        t("toast.title.deleteSuccess"),
      );
    }

    deleteDownload(id);
  }

  function handleCancelCheck() {
    cancelCheckRef.current = true;
    setCheckingAll(false);
  }

  async function handleCheckAllUpdates() {
    cancelCheckRef.current = false;
    setCheckingAll(true);
    addToast(t("downloads.checkUpdatesStarted"), "info");
    let count = 0;
    const completedTasks = tasks.filter((t) => t.status === "completed");

    setCheckProgress({ current: 0, total: completedTasks.length, appName: "" });

    for (let i = 0; i < completedTasks.length; i++) {
      if (cancelCheckRef.current) break;

      const task = completedTasks[i];
      const accountEmail = hashToEmail[task.accountHash];
      const account = accounts.find((a) => a.email === accountEmail);

      setCheckProgress((prev) => ({ ...prev, appName: task.software.name }));

      if (!account) {
        setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
        continue;
      }

      try {
        await delay(1500);
        if (cancelCheckRef.current) break;

        const country = storeIdToCountry(account.store) ?? "US";
        const latestApp = await lookupApp(task.software.bundleID, country);

        if (
          latestApp &&
          isNewerVersion(latestApp.version, task.software.version)
        ) {
          await startDownload(account, latestApp);
          await deleteDownload(task.id);
          count++;
        }
      } catch {
        // Continue with next item
      }

      setCheckProgress((prev) => ({ ...prev, current: i + 1 }));
    }

    if (!cancelCheckRef.current) {
      await delay(500);
      if (!cancelCheckRef.current) {
        setCheckingAll(false);
        addToast(t("downloads.checkUpdatesCompleted", { count }), "success");
      }
    }
  }

  return (
    <PageContainer
      title={t("downloads.title")}
      action={
        <div className="flex gap-2">
          <button
            onClick={handleCheckAllUpdates}
            disabled={checkingAll}
            className="btn btn-ghost"
          >
            {checkingAll
              ? t("downloads.checkingUpdates")
              : t("downloads.checkUpdates")}
          </button>
          <Link
            to="/downloads/add"
            className="btn btn-primary"
          >
            {t("downloads.new")}
          </Link>
        </div>
      }
    >
      <div className="seg mb-4">
        {(
          [
            "all",
            "downloading",
            "pending",
            "paused",
            "injecting",
            "decrypting",
            "completed",
            "failed",
          ] as StatusFilter[]
        ).map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className="seg-btn"
            data-active={filter === status ? "true" : "false"}
          >
            {t(`downloads.status.${status}`)}
            {status !== "all" && (
              <span className="ml-1">
                ({tasks.filter((t) => t.status === status).length})
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="alert mb-4" data-tone="warning">
        {t("downloads.warning")}
      </div>

      {loading && tasks.length === 0 ? (
        <div className="py-12 text-center text-muted">
          {t("downloads.loading")}
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="empty-state my-4">
          <div className="empty-state-icon">
            <svg
              className="w-8 h-8"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-[15px] font-semibold text-ink">
            {filter === "all"
              ? t("downloads.emptyAll")
              : t("downloads.emptyFilter", {
                  status: t(`downloads.status.${filter}`),
                })}
          </h3>
          <p className="mb-6 max-w-sm text-[13px] text-muted">
            {filter === "all"
              ? t("downloads.emptyAllDesc")
              : t("downloads.emptyFilterDesc")}
          </p>
          {filter === "all" && (
            <Link
              to="/search"
              className="btn btn-primary"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              {t("downloads.searchApps")}
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {sortedTasks.map((task) => (
            <DownloadItem
              key={task.id}
              task={task}
              onPause={pauseDownload}
              onResume={resumeDownload}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <Modal
        open={checkingAll && checkProgress.total > 0}
        onClose={handleCancelCheck}
        title={t("downloads.checkingUpdates")}
      >
        <div className="space-y-4">
          <div className="flex justify-center text-accent">
            <Spinner />
          </div>
          <div className="text-center">
            <p className="truncate text-[13px] text-muted">
              {checkProgress.appName
                ? `${t("downloads.checkingApp")}${checkProgress.appName}`
                : "..."}
            </p>
            <p className="mt-1 font-mono text-[12px] text-muted">
              {checkProgress.current} / {checkProgress.total}
            </p>
          </div>
          <ProgressBar
            progress={
              checkProgress.total > 0
                ? (checkProgress.current / checkProgress.total) * 100
                : 0
            }
          />
          <p className="text-center text-[12px] text-subtle">
            {t("downloads.checkUpdatesDesc")}
          </p>
          <div className="flex justify-center">
            <button
              onClick={handleCancelCheck}
              className="btn btn-ghost"
            >
              {t("settings.data.cancel")}
            </button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}
