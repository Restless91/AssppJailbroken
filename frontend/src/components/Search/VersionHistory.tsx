import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import {
  getVersionMetadata,
  listHistoricalVersions,
  listVersions,
  type HistoricalVersionListResponse,
  type HistoricalVersionRecord,
} from "../../api/apple";
import { getAccountOptionLabel } from "../../utils/accountDisplay";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";
import type { Software, VersionMetadata } from "../../types";

const PROVIDERS = ["auto", "timbrd", "agzy", "bilin", "apple"] as const;
const CACHE_PREFIX = "asspp:historical-versions:";
const CACHE_TTL = 6 * 60 * 60 * 1000;

export default function VersionHistory() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts, updateAccount } = useAccounts();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { startDownload, toastDownloadError } = useDownloadAction();

  const stateApp = (location.state as { app?: Software; country?: string })
    ?.app;
  const stateCountry = (location.state as { country?: string })?.country;
  const country = stateCountry ?? "US";

  const [app] = useState<Software | null>(stateApp ?? null);
  const [selectedAccount, setSelectedAccount] = useState("");

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => storeIdToCountry(a.store) === country),
    [accounts, country],
  );
  const [versions, setVersions] = useState<string[]>([]);
  const [records, setRecords] = useState<Record<string, HistoricalVersionRecord>>({});
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>("auto");
  const [resolvedProvider, setResolvedProvider] = useState("");
  const [providerErrors, setProviderErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [manualVersionId, setManualVersionId] = useState("");
  const [versionMeta, setVersionMeta] = useState<
    Record<string, VersionMetadata>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState<Record<string, boolean>>({});
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (
      filteredAccounts.length > 0 &&
      !filteredAccounts.some((a) => a.email === selectedAccount)
    ) {
      setSelectedAccount(filteredAccounts[0].email);
    }
  }, [filteredAccounts, selectedAccount]);

  const account = filteredAccounts.find((a) => a.email === selectedAccount);

  function applyHistory(result: HistoricalVersionListResponse, cached = false) {
    setRecords(Object.fromEntries(result.records.map((record) => [record.versionId, record])));
    setVersions(result.records.map((record) => record.versionId));
    setResolvedProvider(result.provider);
    setProviderErrors(result.errors ?? []);
    setNotice(t(cached || result.cached ? "search.versions.cached" : "search.versions.loaded", {
      count: result.records.length,
      provider: providerLabel(result.provider),
    }));
  }

  async function handleLoadVersions(selectedProvider = provider, force = false) {
    if (!app) return;
    setLoading(true);
    setProviderErrors([]);
    setNotice("");
    try {
      if (selectedProvider !== "apple") {
        const cached = readCache(app.id, selectedProvider);
        if (cached && !force) {
          applyHistory(cached, true);
          return;
        }
        const history = await listHistoricalVersions(app, selectedProvider);
        if (history.records.length > 0) {
          writeCache(app.id, selectedProvider, history);
          applyHistory(history);
          return;
        }
        setProviderErrors(history.errors ?? []);
      }
      if (!account) throw new Error(t("search.versions.accountRequired"));
      const result = await listVersions(account, app);
      setRecords({});
      setVersions(sortVersionIds(result.versions));
      setResolvedProvider("apple");
      setNotice(t("search.versions.appleLoaded", { count: result.versions.length }));
      await updateAccount(result.account);
    } catch (e) {
      addToast(getErrorMessage(e, t("search.versions.loadFailed")), "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (app) void handleLoadVersions("auto");
    // Initial history lookup is keyed only by the selected app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id]);

  async function handleLoadMeta(versionId: string) {
    if (!account || !app || versionMeta[versionId]) return;
    setLoadingMeta((prev) => ({ ...prev, [versionId]: true }));
    try {
      const result = await getVersionMetadata(account, app, versionId);
      setVersionMeta((prev) => ({ ...prev, [versionId]: result.metadata }));
      await updateAccount(result.account);
    } catch {
      // Silently fail for individual version metadata
    } finally {
      setLoadingMeta((prev) => ({ ...prev, [versionId]: false }));
    }
  }

  async function handleDownloadVersion(versionId: string) {
    if (!account || !app) {
      addToast(t("search.versions.accountRequired"), "error");
      return;
    }
    setDownloadingVersion(versionId);
    try {
      await startDownload(account, app, versionId);
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setDownloadingVersion(null);
    }
  }

  if (!app) {
    return (
      <PageContainer title={t("search.versions.title")}>
        <p className="text-muted">{t("search.versions.unavailable")}</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t("search.versions.title")}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <AppIcon url={app.artworkUrl} name={app.name} size="md" />
          <div>
            <h2 className="text-[13.5px] font-medium text-ink">
              {app.name}
            </h2>
            <p className="text-[12.5px] text-muted">
              {app.bundleID}
            </p>
          </div>
        </div>

        {accounts.length > 0 && filteredAccounts.length === 0 ? (
          <div className="alert" data-tone="warning">
            {t("search.product.noAccountsForRegion")}
          </div>
        ) : (
          filteredAccounts.length > 0 && (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="field-label">
                  {t("search.versions.account")}
                </label>
                <select
                  value={selectedAccount}
                  onChange={(e) => setSelectedAccount(e.target.value)}
                  className="field-input field-select"
                >
                  {filteredAccounts.map((a, index) => (
                    <option key={a.email} value={a.email}>
                      {getAccountOptionLabel(a, t, demoMode, index)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => handleLoadVersions()}
                disabled={loading || !account}
                className="btn btn-primary"
              >
                {loading
                  ? t("search.versions.loading")
                  : t("search.versions.load")}
              </button>
            </div>
          )
        )}

        <div className="card card-pad space-y-4">
          <div>
            <label className="field-label">{t("search.versions.source")}</label>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {PROVIDERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setProvider(value);
                    void handleLoadVersions(value);
                  }}
                  className={`btn btn-sm ${provider === value ? "btn-primary" : "btn-ghost"}`}
                >
                  {providerLabel(value)}
                </button>
              ))}
            </div>
          </div>
          {resolvedProvider && (
            <p className="text-[12px] text-muted">
              {t("search.versions.currentSource", { provider: providerLabel(resolvedProvider) })}
            </p>
          )}
          {notice && <div className="alert" data-tone="success">{notice}</div>}
          {providerErrors.length > 0 && (
            <div className="alert" data-tone="warning">
              {t("search.versions.partialFailure")}: {providerErrors.slice(0, 3).join("；")}
            </div>
          )}
          {provider !== "apple" && versions.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => handleLoadVersions(provider, true)}>
              {t("search.versions.refresh")}
            </button>
          )}
        </div>

        <div className="card card-pad">
          <label className="field-label">{t("search.versions.manualId")}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="field-input flex-1" inputMode="numeric" value={manualVersionId} onChange={(event) => setManualVersionId(event.target.value)} placeholder="888611633" />
            <button className="btn btn-primary" disabled={!manualVersionId.trim() || downloadingVersion !== null} onClick={() => handleDownloadVersion(manualVersionId.trim())}>
              {t("search.versions.download")}
            </button>
          </div>
        </div>

        {versions.length > 0 && (
          <div className="card divide-y divide-border overflow-hidden">
            {versions.map((versionId) => {
              const meta = versionMeta[versionId];
              const record = records[versionId];
              const isLoadingMeta = loadingMeta[versionId];
              const isDownloading = downloadingVersion === versionId;

              return (
                <div
                  key={versionId}
                  className="flex items-center justify-between gap-3 p-4"
                >
                  <div>
                    <p className="text-[13.5px] font-medium text-ink">
                      {record?.version || meta?.displayVersion
                        ? `v${record?.version ?? meta?.displayVersion}`
                        : `ID: ${versionId}`}
                    </p>
                    <p className="break-all text-[12px] text-muted">
                      {t("search.versions.versionId")}: {versionId}
                      {record?.sizeText ? ` · ${record.sizeText}` : ""}
                    </p>
                    {meta?.releaseDate && !record && (
                      <p className="text-[12px] text-muted">
                        {new Date(meta.releaseDate).toLocaleDateString()}
                      </p>
                    )}
                    {!record?.version && !meta && !isLoadingMeta && account && (
                      <button
                        onClick={() => handleLoadMeta(versionId)}
                        className="py-1 text-[12px] text-link"
                      >
                        {t("search.versions.loadDetails")}
                      </button>
                    )}
                    {isLoadingMeta && (
                      <span className="text-[12px] text-subtle">
                        {t("search.versions.loading")}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDownloadVersion(versionId)}
                    disabled={isDownloading || downloadingVersion !== null}
                    className="btn btn-primary btn-sm"
                  >
                    {isDownloading
                      ? t("search.versions.downloading")
                      : t("search.versions.download")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function providerLabel(provider: string) {
  return provider === "auto" ? "Auto" : provider === "apple" ? "Apple" : provider[0].toUpperCase() + provider.slice(1);
}

function sortVersionIds(ids: string[]) {
  return [...ids].sort((a, b) => Number(b) - Number(a));
}

function cacheKey(appId: number | string, provider: string) {
  return `${CACHE_PREFIX}${appId}:${provider}`;
}

function readCache(appId: number | string, provider: string): HistoricalVersionListResponse | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(appId, provider)) ?? "null") as
      | { savedAt: number; result: HistoricalVersionListResponse }
      | null;
    if (!value || Date.now() - value.savedAt > CACHE_TTL) return null;
    return value.result;
  } catch {
    return null;
  }
}

function writeCache(appId: number | string, provider: string, result: HistoricalVersionListResponse) {
  try {
    localStorage.setItem(cacheKey(appId, provider), JSON.stringify({ savedAt: Date.now(), result }));
  } catch {
    // History remains usable when storage is unavailable.
  }
}
