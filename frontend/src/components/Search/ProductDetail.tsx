import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSettingsStore } from "../../store/settings";
import { lookupApp } from "../../api/search";
import { getAccountOptionLabel } from "../../utils/accountDisplay";
import { storeIdToCountry } from "../../apple/config";
import type { Software } from "../../types";

export default function ProductDetail() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts } = useAccounts();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const { t } = useTranslation();
  const {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  } = useDownloadAction();

  const stateApp = (location.state as { app?: Software; country?: string })
    ?.app;
  const stateCountry = (location.state as { country?: string })?.country;
  const [country] = useState(stateCountry ?? "US");
  const [app, setApp] = useState<Software | null>(stateApp ?? null);
  const [loading, setLoading] = useState(!stateApp);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [loadingAction, setLoadingAction] = useState<
    "purchase" | "download" | null
  >(null);

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => storeIdToCountry(a.store) === country),
    [accounts, country],
  );

  const account = filteredAccounts.find((a) => a.email === selectedAccount);

  useEffect(() => {
    if (!stateApp && appId) {
      setLoading(true);
      lookupApp(appId, country)
        .then((result) => {
          setApp(result);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        });
    }
  }, [appId, stateApp, country]);

  useEffect(() => {
    if (
      filteredAccounts.length > 0 &&
      !filteredAccounts.some((a) => a.email === selectedAccount)
    ) {
      setSelectedAccount(filteredAccounts[0].email);
    }
  }, [filteredAccounts, selectedAccount]);

  if (loading) {
    return (
      <PageContainer title={t("search.product.title")}>
        <div className="py-12 text-center text-muted">{t("loading")}</div>
      </PageContainer>
    );
  }

  if (!app) {
    return (
      <PageContainer title={t("search.product.title")}>
        <p className="text-muted">{t("search.product.notFound")}</p>
      </PageContainer>
    );
  }

  async function handlePurchase() {
    if (!account || !app) return;
    setLoadingAction("purchase");
    try {
      await acquireLicense(account, app);
    } catch (e) {
      toastLicenseError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDownload() {
    if (!account || !app) return;
    setLoadingAction("download");
    try {
      await startDownload(account, app);
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <PageContainer>
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <AppIcon url={app.artworkUrl} name={app.name} size="lg" />
          <div className="flex-1 min-w-0">
            <h1 className="page-title">
              {app.name}
            </h1>
            <p className="page-subtitle">{app.artistName}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-[13px] text-muted">
              <span>{app.formattedPrice ?? t("search.product.free")}</span>
              <span>{app.primaryGenreName}</span>
              <span>v{app.version}</span>
              <span>
                {app.averageUserRating.toFixed(1)} ({app.userRatingCount}{" "}
                {t("search.product.ratings")})
              </span>
            </div>
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="alert" data-tone="warning">
            <Link to="/accounts/add" className="font-medium underline">
              {t("search.product.addAccountLink")}
            </Link>{" "}
            {t("search.product.addAccountPrompt")}
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="alert" data-tone="warning">
            {t("search.product.noAccountsForRegion")}
          </div>
        ) : (
          <div className="card card-pad space-y-4">
            <div>
              <label className="field-label">
                {t("search.product.account")}
              </label>
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className="field-input field-select"
                disabled={loadingAction !== null}
              >
                {filteredAccounts.map((a, index) => (
                  <option key={a.email} value={a.email}>
                    {getAccountOptionLabel(a, t, demoMode, index)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-3">
              {(app.price === undefined || app.price === 0) && (
                <button
                  onClick={handlePurchase}
                  disabled={loadingAction !== null}
                  className="btn btn-success"
                >
                  {loadingAction === "purchase"
                    ? t("search.product.processing")
                    : t("search.product.getLicense")}
                </button>
              )}
              <button
                onClick={handleDownload}
                disabled={loadingAction !== null}
                className="btn btn-primary"
              >
                {loadingAction === "download"
                  ? t("search.product.processing")
                  : t("search.product.download")}
              </button>
              <Link
                to={`/search/${app.id}/versions`}
                state={{ app, country }}
                className="btn btn-ghost"
              >
                {t("search.product.versionHistory")}
              </Link>
            </div>
          </div>
        )}

        <div className="card card-pad">
          <h2 className="mb-3 section-title">
            {t("search.product.details")}
          </h2>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <dt className="detail-label">
              {t("search.product.bundleId")}
            </dt>
            <dd className="detail-value">
              {app.bundleID}
            </dd>
            <dt className="detail-label">
              {t("search.product.version")}
            </dt>
            <dd className="detail-value">{app.version}</dd>
            <dt className="detail-label">
              {t("search.product.size")}
            </dt>
            <dd className="detail-value">
              {app.fileSizeBytes
                ? `${(parseInt(app.fileSizeBytes) / 1024 / 1024).toFixed(1)} MB`
                : "N/A"}
            </dd>
            <dt className="detail-label">
              {t("search.product.minOs")}
            </dt>
            <dd className="detail-value">
              {app.minimumOsVersion}
            </dd>
            <dt className="detail-label">
              {t("search.product.seller")}
            </dt>
            <dd className="detail-value">
              {app.sellerName}
            </dd>
            <dt className="detail-label">
              {t("search.product.released")}
            </dt>
            <dd className="detail-value">
              {new Date(app.releaseDate).toLocaleDateString()}
            </dd>
          </dl>
        </div>

        {app.description && (
          <div className="card card-pad">
            <h2 className="mb-3 section-title">
              {t("search.product.description")}
            </h2>
            <p className="whitespace-pre-line text-[13px] leading-6 text-muted">
              {app.description}
            </p>
          </div>
        )}

        {app.releaseNotes && (
          <div className="card card-pad">
            <h2 className="mb-3 section-title">
              {t("search.product.releaseNotes")}
            </h2>
            <p className="whitespace-pre-line text-[13px] leading-6 text-muted">
              {app.releaseNotes}
            </p>
          </div>
        )}

        {app.screenshotUrls && app.screenshotUrls.length > 0 && (
          <div className="card card-pad">
            <h2 className="mb-3 section-title">
              {t("search.product.screenshots")}
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {app.screenshotUrls.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`Screenshot ${i + 1}`}
                  className="h-48 sm:h-64 rounded-lg object-contain flex-shrink-0"
                  loading="lazy"
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
