import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AppIcon from "../common/AppIcon";
import Badge from "../common/Badge";
import ProgressBar from "../common/ProgressBar";
import VerificationSummary from "./VerificationSummary";
import type { DownloadTask } from "../../types";

interface DownloadItemProps {
  task: DownloadTask;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function DownloadItem({
  task,
  onPause,
  onResume,
  onRetry,
  onDelete,
}: DownloadItemProps) {
  const { t } = useTranslation();

  const isActive =
    task.status === "downloading" ||
    task.status === "injecting" ||
    task.status === "decrypting";
  const canPause =
    task.status === "downloading" || task.status === "decrypting";
  const isPaused = task.status === "paused";
  const isCompleted = task.status === "completed";

  return (
    <div className="card p-3">
      <div className="flex gap-3">
        <AppIcon
          url={task.software.artworkUrl}
          name={task.software.name}
          size="sm"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Link
                to={`/downloads/${task.id}`}
                className="block truncate text-[13.5px] font-medium text-ink hover:text-accent"
              >
                {task.software.name}
              </Link>
              <p className="mt-0.5 text-[12px] text-muted">
                v{task.software.version}
              </p>
            </div>
            <div className="shrink-0 whitespace-nowrap flex items-center h-5 mt-0.5">
              <Badge status={task.status} />
            </div>
          </div>

          {(isActive || isPaused) && (
            <div className="mt-2.5">
              <ProgressBar progress={task.progress} />
              <div className="mt-1.5 flex justify-between text-[12px] font-medium text-muted">
                <span>{Math.round(task.progress)}%</span>
                {task.speed && isActive && <span>{task.speed}</span>}
              </div>
            </div>
          )}

          {task.status === "pending" && task.queuePosition != null && (
            <p className="mt-2 text-[12px] font-medium text-muted">
              {t("downloads.queuePosition", { position: task.queuePosition })}
            </p>
          )}

          {task.error && (
            <p className="alert mt-2 text-[12px]" data-tone="error">
              {task.error}
            </p>
          )}

          <VerificationSummary verification={task.verification} sha256={task.sha256} errorCode={task.errorCode} compact />

          <div className="flex flex-wrap gap-2 mt-3">
            {canPause && (
              <button
                onClick={() => onPause(task.id)}
                className="btn btn-ghost btn-sm"
              >
                {t("downloads.package.pause")}
              </button>
            )}
            {isPaused && (
              <button
                onClick={() => onResume(task.id)}
                className="btn btn-primary btn-sm"
              >
                {t("downloads.package.resume")}
              </button>
            )}
            {task.status === "failed" && task.canRetry && (
              <button
                onClick={() => onRetry(task.id)}
                className="btn btn-primary btn-sm"
              >
                {t("downloads.package.retry")}
              </button>
            )}
            {isCompleted && task.hasFile && (
              <Link
                to={`/downloads/${task.id}`}
                className="btn btn-ghost btn-sm"
              >
                {t("downloads.item.viewPackage")}
              </Link>
            )}
            <button
              onClick={() => onDelete(task.id)}
              className="btn btn-danger btn-sm"
            >
              {t("downloads.package.delete")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
