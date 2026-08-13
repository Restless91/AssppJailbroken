import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import Spinner from "../common/Spinner";
import { useAccounts } from "../../hooks/useAccounts";
import {
  useDownloadAction,
  type DownloadPreparationStage,
} from "../../hooks/useDownloadAction";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import {
  getVersionMetadata,
  listHistoricalVersions,
  listVersions,
  type HistoricalVersionRecord,
  type HistoricalVersionListResponse,
} from "../../api/apple";
import { getAccountOptionLabel } from "../../utils/accountDisplay";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";
import type { Software, VersionMetadata } from "../../types";

const VERSION_PROVIDERS = [
  { value: "auto", label: "自动" },
  { value: "timbrd", label: "Timbrd" },
  { value: "agzy", label: "Agzy" },
  { value: "bilin", label: "Bilin" },
  { value: "apple", label: "Apple" },
];

const HISTORY_CACHE_PREFIX = "asspp:historical-versions:";
const HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
  const [versionRecords, setVersionRecords] = useState<
    Record<string, HistoricalVersionRecord>
  >({});
  const [versionMeta, setVersionMeta] = useState<
    Record<string, VersionMetadata>
  >({});
  const [selectedProvider, setSelectedProvider] = useState("auto");
  const [resolvedProvider, setResolvedProvider] = useState("");
  const [providerErrors, setProviderErrors] = useState<string[]>([]);
  const [historyNotice, setHistoryNotice] = useState("");
  const [manualVersionId, setManualVersionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState<Record<string, boolean>>({});
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(
    null,
  );
  const [preparation, setPreparation] = useState<
    | { stage: DownloadPreparationStage }
    | { stage: "ready"; version: string; minOs: string }
    | null
  >(null);

  useEffect(() => {
    if (
      filteredAccounts.length > 0 &&
      !filteredAccounts.some((a) => a.email === selectedAccount)
    ) {
      setSelectedAccount(filteredAccounts[0].email);
    }
  }, [filteredAccounts, selectedAccount]);

  useEffect(() => {
    if (app) {
      void handleLoadVersions("auto");
    }
    // Load once for the selected app; later source switching is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id]);

  const account = filteredAccounts.find((a) => a.email === selectedAccount);

  function applyHistoricalResponse(
    historical: HistoricalVersionListResponse,
    fromCache = false,
  ) {
    const records = historical.records.reduce<
      Record<string, HistoricalVersionRecord>
    >((acc, record) => {
      acc[record.versionId] = record;
      return acc;
    }, {});
    setVersionRecords(records);
    setVersions(historical.records.map((record) => record.versionId));
    setResolvedProvider(historical.provider);
    setProviderErrors(historical.errors ?? []);
    setVersionMeta((prev) => {
      const next = { ...prev };
      for (const record of historical.records) {
        next[record.versionId] = {
          displayVersion: record.version,
          releaseDate: record.date ?? "",
        };
      }
      return next;
    });
    setHistoryNotice(
      fromCache || historical.cached
        ? `已从缓存加载 ${historical.records.length} 个版本，来源 ${providerLabel(historical.provider)}。`
        : `已加载 ${historical.records.length} 个版本，来源 ${providerLabel(historical.provider)}。`,
    );
  }

  async function handleLoadVersions(
    provider = selectedProvider,
    forceRefresh = false,
  ) {
    if (!app) return;
    setLoading(true);
    setProviderErrors([]);
    setHistoryNotice("");
    try {
      if (provider !== "apple") {
        const cached = readHistoricalCache(app.id, provider);
        if (cached && !forceRefresh) {
          applyHistoricalResponse(cached, true);
          return;
        }

        const historical = await listHistoricalVersions(app, provider);
        if (historical.records.length > 0) {
          writeHistoricalCache(app.id, provider, historical);
          if (historical.provider !== provider) {
            writeHistoricalCache(app.id, historical.provider, historical);
          }
          applyHistoricalResponse(historical);
          return;
        }
        setProviderErrors(historical.errors ?? []);
      }

      if (!account) {
        throw new Error("Apple 源需要先选择可用账号");
      }
      const result = await listVersions(account, app);
      setVersionRecords({});
      setVersions(sortVersionIds(result.versions));
      setResolvedProvider("apple");
      setHistoryNotice(`已从 Apple 账号源加载 ${result.versions.length} 个版本 ID，可按需补齐详情。`);
      await updateAccount(result.account);
    } catch (e) {
      addToast(getErrorMessage(e, t("search.versions.loadFailed")), "error");
    } finally {
      setLoading(false);
    }
  }

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
      addToast("下载历史版本需要先配置可用 Apple ID 账号", "error");
      return;
    }
    setDownloadingVersion(versionId);
    setPreparation({ stage: "checking" });
    try {
      const task = await startDownload(account, app, versionId, {
        onPreparationStage: (stage) => setPreparation({ stage }),
      });
      if (task) {
        setPreparation({
          stage: "ready",
          version: task.software.version,
          minOs: task.software.minimumOsVersion,
        });
        window.setTimeout(() => setPreparation(null), 8_000);
      }
    } catch (e) {
      setPreparation(null);
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
          <div className="space-y-3">
            {filteredAccounts.length > 0 && (
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
                  disabled={loading || (selectedProvider === "apple" && !account)}
                  className="btn btn-primary"
                >
                  {loading
                    ? t("search.versions.loading")
                    : t("search.versions.load")}
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-muted">来源</span>
              <div className="inline-flex overflow-hidden rounded-full border border-border bg-surface-subtle p-1">
                {VERSION_PROVIDERS.map((provider) => (
                  <button
                    key={provider.value}
                    type="button"
                    onClick={() => {
                      setSelectedProvider(provider.value);
                      void handleLoadVersions(provider.value);
                    }}
                    disabled={loading}
                    className={`rounded-full px-3 py-1 text-[12px] transition ${
                      selectedProvider === provider.value
                        ? "bg-ink text-surface"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
              {resolvedProvider && (
                <span className="text-[12px] text-subtle">
                  当前：{providerLabel(resolvedProvider)}
                </span>
              )}
              {app && selectedProvider !== "apple" && versions.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleLoadVersions(selectedProvider, true)}
                  disabled={loading}
                  className="text-[12px] text-link"
                >
                  强制刷新
                </button>
              )}
            </div>

            {historyNotice && (
              <div className="alert" data-tone="success">
                {historyNotice}
              </div>
            )}

            {providerErrors.length > 0 && (
              <div className="alert" data-tone="warning">
                <div className="font-medium">部分来源不可用，已自动尝试其它来源。</div>
                <div className="mt-1 text-[12px]">
                  {providerErrors.slice(0, 3).join("；")}
                </div>
              </div>
            )}
          </div>
        )}

        {accounts.length === 0 && (
          <div className="space-y-3">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="field-label">来源</label>
                <select
                  value={selectedProvider}
                  onChange={(e) => {
                    setSelectedProvider(e.target.value);
                    void handleLoadVersions(e.target.value);
                  }}
                  className="field-input field-select"
                >
                  {VERSION_PROVIDERS.filter((p) => p.value !== "apple").map(
                    (provider) => (
                      <option key={provider.value} value={provider.value}>
                        {provider.label}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <button
                onClick={() => handleLoadVersions()}
                disabled={loading}
                className="btn btn-primary"
              >
                {loading
                  ? t("search.versions.loading")
                  : t("search.versions.load")}
              </button>
            </div>
          </div>
        )}

        <div className="card p-4">
          <label className="field-label">手动输入版本 ID</label>
          <div className="mt-2 flex gap-3">
            <input
              value={manualVersionId}
              onChange={(event) => setManualVersionId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && manualVersionId.trim()) {
                  void handleDownloadVersion(manualVersionId.trim());
                }
              }}
              className="field-input flex-1"
              inputMode="numeric"
              placeholder="例如：888611633"
            />
            <button
              type="button"
              onClick={() => handleDownloadVersion(manualVersionId.trim())}
              disabled={!manualVersionId.trim() || downloadingVersion !== null}
              className="btn btn-primary"
            >
              下载
            </button>
          </div>
          <p className="mt-2 text-[12px] text-muted">
            如果历史源没有补出版本号，也可以直接填版本 ID 下载。
          </p>
        </div>

        {preparation && (
          <div
            className="alert flex items-start gap-3"
            data-tone={preparation.stage === "ready" ? "success" : "warning"}
            role="status"
            aria-live="polite"
          >
            {preparation.stage !== "ready" && <Spinner />}
            <div>
              <div className="font-semibold">
                {preparation.stage === "ready"
                  ? t("search.product.compatibilityReady", {
                      version: preparation.version,
                      minOs: preparation.minOs,
                    })
                  : t("search.product.preparingDownload")}
              </div>
              {preparation.stage !== "ready" && (
                <div className="mt-1">
                  {t(`search.product.${
                    preparation.stage === "checking"
                      ? "compatibilityChecking"
                      : preparation.stage === "readingDescriptor"
                        ? "descriptorReading"
                        : preparation.stage === "selectingHistory"
                          ? "historySelecting"
                          : "compatibilityConfirming"
                  }`)}
                </div>
              )}
            </div>
          </div>
        )}

        {versions.length > 0 && (
          <div className="card divide-y divide-border overflow-hidden">
            {versions.map((versionId) => {
              const meta = versionMeta[versionId];
              const record = versionRecords[versionId];
              const isLoadingMeta = loadingMeta[versionId];
              const isDownloading = downloadingVersion === versionId;
              const displayVersion = record?.version ?? meta?.displayVersion;

              return (
                <div
                  key={versionId}
                  className="flex items-center justify-between p-4"
                >
                  <div>
                    <p className="text-[13.5px] font-medium text-ink">
                      {displayVersion ? `v${displayVersion}` : `ID: ${versionId}`}
                    </p>
                    <p className="text-[12px] text-muted">
                      版本 ID：{versionId}
                      {record?.sizeText ? ` · ${record.sizeText}` : ""}
                      {record?.source ? ` · ${providerLabel(record.source)}` : ""}
                    </p>
                    {meta?.releaseDate && !record && (
                      <p className="text-[12px] text-muted">
                        {new Date(meta.releaseDate).toLocaleDateString()}
                      </p>
                    )}
                    {!displayVersion && !isLoadingMeta && account && (
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

function providerLabel(value: string) {
  return VERSION_PROVIDERS.find((provider) => provider.value === value)?.label ?? value;
}

function sortVersionIds(ids: string[]) {
  return [...ids].sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return rightNumber - leftNumber;
    }
    return right.localeCompare(left);
  });
}

function historicalCacheKey(appId: number | string, provider: string) {
  return `${HISTORY_CACHE_PREFIX}${appId}:${provider}`;
}

function readHistoricalCache(
  appId: number | string,
  provider: string,
): HistoricalVersionListResponse | null {
  try {
    const raw = window.localStorage.getItem(historicalCacheKey(appId, provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      savedAt?: number;
      response?: HistoricalVersionListResponse;
    };
    if (
      !parsed.savedAt ||
      !parsed.response ||
      Date.now() - parsed.savedAt > HISTORY_CACHE_TTL_MS
    ) {
      window.localStorage.removeItem(historicalCacheKey(appId, provider));
      return null;
    }
    return parsed.response;
  } catch {
    return null;
  }
}

function writeHistoricalCache(
  appId: number | string,
  provider: string,
  response: HistoricalVersionListResponse,
) {
  try {
    window.localStorage.setItem(
      historicalCacheKey(appId, provider),
      JSON.stringify({ savedAt: Date.now(), response }),
    );
  } catch {
    // localStorage may be unavailable in private browsing; ignore.
  }
}
