import { useTranslation } from "react-i18next";
import type { DecryptEvent } from "../../types";

interface DecryptSummaryProps {
  events?: DecryptEvent[];
  compact?: boolean;
}

export function summarizeDecryptEvents(events: DecryptEvent[]) {
  const uniqueCount = (kind: string, status: string) =>
    new Set(
      events
        .filter((event) => event.kind === kind && event.status === status)
        .map((event) => event.path || event.message),
    ).size;
  const report = [...events].reverse().find((event) => event.kind === "report");
  const permissionLabel = report
    ? report.reportTotal !== undefined &&
      report.reportTotal > 0 &&
      report.reportDecrypted === report.reportTotal &&
      report.reportRemaining === 0 &&
      report.reportMainRemaining === 0 &&
      report.reportFrameworkRemaining === 0 &&
      report.reportExtensionRemaining === 0
      ? "full"
      : "partial"
    : null;

  return {
    main: uniqueCount("main", "decrypted"),
    frameworks: uniqueCount("framework", "decrypted"),
    frameworkSkipped:
      report?.reportFrameworkRemaining ?? uniqueCount("framework", "skipped"),
    extensions: uniqueCount("extension", "decrypted"),
    extensionSkipped:
      report?.reportExtensionRemaining ?? uniqueCount("extension", "skipped"),
    report,
    permissionLabel,
  };
}

export default function DecryptSummary({ events = [], compact = false }: DecryptSummaryProps) {
  const { t } = useTranslation();
  if (events.length === 0) return null;

  const {
    main,
    frameworks,
    frameworkSkipped,
    extensions,
    extensionSkipped,
    report,
    permissionLabel,
  } = summarizeDecryptEvents(events);

  if (compact) {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        {permissionLabel && <span className={`rounded-full px-2 py-0.5 ${permissionLabel === "full" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{t(`downloads.decrypt.${permissionLabel}Permission`)}</span>}
        {main > 0 && <span className="rounded-full bg-success-soft px-2 py-0.5 text-success">{t("downloads.decrypt.mainOk")}</span>}
       {frameworks > 0 && <span className="rounded-full bg-success-soft px-2 py-0.5 text-success">{t("downloads.decrypt.frameworksOk", { count: frameworks })}</span>}
        {frameworkSkipped > 0 && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">{t("downloads.decrypt.frameworksSkipped", { count: frameworkSkipped })}</span>}
       {extensions > 0 && <span className="rounded-full bg-success-soft px-2 py-0.5 text-success">{t("downloads.decrypt.extensionsOk", { count: extensions })}</span>}
        {extensionSkipped > 0 && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">{t("downloads.decrypt.extensionsSkipped", { count: extensionSkipped })}</span>}
      </div>
    );
  }

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="section-title">{t("downloads.decrypt.title")}</h3>
        {permissionLabel && <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${permissionLabel === "full" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{t(`downloads.decrypt.${permissionLabel}Permission`)}</span>}
      </div>
      <div className="mt-3 grid gap-2 text-[13px] sm:grid-cols-3">
        <div className="rounded-[14px] border border-border bg-muted/20 p-3">
          <div className="text-muted">{t("downloads.decrypt.main")}</div>
          <div className="mt-1 font-semibold text-success">{main > 0 ? t("downloads.decrypt.decrypted") : t("downloads.decrypt.notReported")}</div>
        </div>
        <div className="rounded-[14px] border border-border bg-muted/20 p-3">
          <div className="text-muted">{t("downloads.decrypt.frameworks")}</div>
         <div className="mt-1 font-semibold text-success">{t("downloads.decrypt.decryptedCount", { count: frameworks })}</div>
          {frameworkSkipped > 0 && <div className="mt-1 text-warning">{t("downloads.decrypt.skippedCount", { count: frameworkSkipped })}</div>}
       </div>
        <div className="rounded-[14px] border border-border bg-muted/20 p-3">
          <div className="text-muted">{t("downloads.decrypt.extensions")}</div>
          {extensions > 0 && (
            <div className="mt-1 font-semibold text-success">
              {t("downloads.decrypt.decryptedCount", { count: extensions })}
            </div>
          )}
          {extensionSkipped > 0 && (
            <div className={`${extensions > 0 ? "mt-1" : "mt-1 font-semibold"} text-warning`}>
              {t("downloads.decrypt.skippedCount", { count: extensionSkipped })}
            </div>
          )}
          {extensions === 0 && extensionSkipped === 0 && (
            <div className="mt-1 font-semibold text-muted">
              {t("downloads.decrypt.notReported")}
            </div>
          )}
        </div>
      </div>
      {report && (
        <p className="mt-3 rounded-[12px] bg-muted/20 px-3 py-2 text-[12px] text-muted">
          {report.message}
        </p>
      )}
    </div>
  );
}
