import { useTranslation } from "react-i18next";
import type { DownloadTask } from "../../types";

type Props = Pick<DownloadTask, "verification" | "sha256" | "errorCode"> & {
  compact?: boolean;
};

export default function VerificationSummary({ verification, sha256, errorCode, compact = false }: Props) {
  const { t } = useTranslation();
  if (!verification && !sha256 && !errorCode) return null;
  const verifiedText = verification
    ? t("downloads.verification.machO", { verified: verification.verifiedMachOCount, total: verification.scannedMachOCount })
    : null;

  if (compact) return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-muted">
      {verifiedText && <span className="rounded-md bg-success-soft px-2 py-1 text-success">{verifiedText}</span>}
      {sha256 && <code className="max-w-full truncate rounded-md bg-surface px-2 py-1 font-mono">SHA-256 {sha256.slice(0, 12)}…</code>}
      {errorCode && <code className="max-w-full truncate rounded-md bg-danger-soft px-2 py-1 font-mono text-danger">{errorCode}</code>}
    </div>
  );

  return (
    <section className="card card-pad" aria-labelledby="verification-title">
      <h3 id="verification-title" className="text-sm font-semibold text-ink">{t("downloads.verification.title")}</h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        {verifiedText && <div><dt className="detail-label">{t("downloads.verification.result")}</dt><dd className="detail-value mt-1 text-success">{verifiedText}</dd></div>}
        {errorCode && <div><dt className="detail-label">{t("downloads.verification.errorCode")}</dt><dd className="mt-1 break-all font-mono text-[12px] text-danger">{errorCode}</dd></div>}
        {sha256 && <div className="min-w-0 sm:col-span-2"><dt className="detail-label">SHA-256</dt><dd className="mt-1 break-all font-mono text-[12px] leading-5 text-ink">{sha256}</dd></div>}
      </dl>
    </section>
  );
}
