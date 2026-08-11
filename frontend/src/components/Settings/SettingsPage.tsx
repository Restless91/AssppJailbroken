import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Modal from "../common/Modal";
import { useAccountsStore } from "../../store/accounts";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { apiGet } from "../../api/client";
import { encryptData, decryptData } from "../../utils/crypto";
import { countryCodeMap } from "../../apple/config";
import type { Account } from "../../types";

interface ServerInfo {
  uptime?: number;
  buildCommit?: string;
  buildDate?: string;
  port?: number;
  dataDir?: string;
  publicBaseUrl?: string;
  disableHttpsRedirect?: boolean;
  autoCleanupDays?: number;
  autoCleanupMaxMB?: number;
  maxDownloadMB?: number;
  downloadThreads?: number;
}

const entityTypes = [
  { value: "software", label: "iPhone" },
  { value: "iPadSoftware", label: "iPad" },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { accounts, addAccount, updateAccount } = useAccountsStore();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const setDemoMode = useSettingsStore((s) => s.setDemoMode);
  const addToast = useToastStore((s) => s.addToast);

  const [country, setCountry] = useState(
    () => localStorage.getItem("asspp-default-country") || "US",
  );
  const [entity, setEntity] = useState(
    () => localStorage.getItem("asspp-default-entity") || "software",
  );
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirmPassword, setExportConfirmPassword] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFileData, setImportFileData] = useState("");

  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [pendingAccounts, setPendingAccounts] = useState<Account[]>([]);
  const [conflictStats, setConflictStats] = useState({ conflict: 0, new: 0 });

  useEffect(() => {
    localStorage.setItem("asspp-default-country", country);
  }, [country]);

  useEffect(() => {
    localStorage.setItem("asspp-default-entity", entity);
  }, [entity]);

  useEffect(() => {
    apiGet<ServerInfo>("/api/settings")
      .then(setServerInfo)
      .catch(() => setServerInfo(null));
  }, []);

  const sortedCountries = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const handleExport = async () => {
    if (exportPassword !== exportConfirmPassword) {
      addToast(t("settings.data.passwordMismatch"), "error");
      return;
    }
    try {
      const encrypted = await encryptData(accounts, exportPassword);
      const blob = new Blob([encrypted], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "asspp-accounts.enc";
      a.click();
      URL.revokeObjectURL(url);

      setExportModalOpen(false);
      setExportPassword("");
      setExportConfirmPassword("");
      addToast(t("settings.data.exportSuccess"), "success");
    } catch {
      addToast(t("settings.data.exportFailed"), "error");
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setImportFileData(content);
      setImportModalOpen(true);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImport = async () => {
    try {
      const parsed = await decryptData(importFileData, importPassword);
      if (!Array.isArray(parsed)) throw new Error("Invalid format");
      const valid = parsed.filter(
        (item: any) =>
          item &&
          typeof item === "object" &&
          typeof item.email === "string" &&
          item.email.length > 0,
      ) as Account[];
      if (valid.length === 0) throw new Error("No valid accounts found");

      if (accounts.length === 0) {
        for (const acc of valid) {
          await addAccount(acc);
        }
        addToast(t("settings.data.importSuccess"), "success");
        setImportModalOpen(false);
        setImportPassword("");
      } else {
        let conflictCount = 0;
        let newCount = 0;
        valid.forEach((imported) => {
          if (accounts.some((a) => a.email === imported.email)) conflictCount++;
          else newCount++;
        });

        if (conflictCount > 0) {
          setConflictStats({ conflict: conflictCount, new: newCount });
          setPendingAccounts(valid);
          setImportModalOpen(false);
          setImportPassword("");
          setConflictModalOpen(true);
        } else {
          for (const acc of valid) {
            await addAccount(acc);
          }
          addToast(t("settings.data.importSuccess"), "success");
          setImportModalOpen(false);
          setImportPassword("");
        }
      }
    } catch {
      addToast(t("settings.data.incorrectPassword"), "error");
    }
  };

  const handleResolveConflict = async (overwrite: boolean) => {
    for (const imported of pendingAccounts) {
      const exists = accounts.some((a) => a.email === imported.email);
      if (exists) {
        if (overwrite) await updateAccount(imported);
      } else {
        await addAccount(imported);
      }
    }
    setConflictModalOpen(false);
    setPendingAccounts([]);
    addToast(t("settings.data.importSuccess"), "success");
  };

  const handleDemoModeChange = (enabled: boolean) => {
    setDemoMode(enabled);
    addToast(
      t(enabled ? "settings.demo.enabled" : "settings.demo.disabled"),
      "success",
    );
  };

  return (
    <PageContainer title={t("settings.title")}>
      <div className="space-y-6">
        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.language.title")}
          </h2>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="language"
                className="field-label"
              >
                {t("settings.language.label")}
              </label>
              <select
                id="language"
                value={i18n.resolvedLanguage || "en-US"}
                onChange={async (e) => {
                  const newLang = e.target.value;
                  await i18n.changeLanguage(newLang);
                  addToast(t("settings.language.changed"), "success");
                }}
                className="field-input field-select"
              >
                <option value="en-US">English (US)</option>
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="ru">Русский</option>
              </select>
            </div>
          </div>
        </section>

        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.demo.title")}
          </h2>
          <label
            htmlFor="demo-mode"
            className="flex items-center justify-between gap-4 cursor-pointer"
          >
            <div>
              <span className="block text-[13px] font-medium text-ink">
                {t("settings.demo.label")}
              </span>
              <span className="mt-1 block text-[13px] text-muted">
                {t("settings.demo.description")}
              </span>
            </div>
            <input
              id="demo-mode"
              type="checkbox"
              checked={demoMode}
              onChange={(e) => handleDemoModeChange(e.target.checked)}
              className="sr-only peer"
            />
            <span className="switch-track" />
          </label>
        </section>

        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.defaults.title")}
          </h2>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="country"
                className="field-label"
              >
                {t("settings.defaults.country")}
              </label>
              <select
                id="country"
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value);
                  addToast(t("settings.defaults.countryChanged"), "success");
                }}
                className="field-input field-select"
              >
                {sortedCountries.map((code) => (
                  <option key={code} value={code}>
                    {t(`countries.${code}`, code)} ({code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="entity"
                className="field-label"
              >
                {t("settings.defaults.entity")}
              </label>
              <select
                id="entity"
                value={entity}
                onChange={(e) => {
                  setEntity(e.target.value);
                  addToast(t("settings.defaults.entityChanged"), "success");
                }}
                className="field-input field-select"
              >
                {entityTypes.map((et) => (
                  <option key={et.value} value={et.value}>
                    {et.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.server.title")}
          </h2>
          {serverInfo ? (
            <div className="space-y-6">
              <dl className="space-y-3">
                {serverInfo.uptime != null && (
                  <div>
                    <dt className="detail-label">
                      {t("settings.server.uptime")}
                    </dt>
                    <dd className="detail-value">
                      {formatUptime(serverInfo.uptime)}
                    </dd>
                  </div>
                )}
              </dl>

              <div>
                <h3 className="section-title mb-3">
                  {t("settings.server.configuration")}
                </h3>
                <dl className="space-y-3">
                  <div>
                    <dt className="detail-label">
                      PORT
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.port}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      DATA_DIR
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.dataDir}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      PUBLIC_BASE_URL
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.publicBaseUrl || (
                        <span className="text-subtle italic">
                          {t("settings.server.notSet")}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.disableHttpsRedirect
                        ? t("settings.server.enabled")
                        : t("settings.server.disabled")}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      AUTO_CLEANUP_DAYS
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.autoCleanupDays ||
                        t("settings.server.disabled")}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      AUTO_CLEANUP_MAX_MB
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.autoCleanupMaxMB ||
                        t("settings.server.disabled")}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      MAX_DOWNLOAD_MB
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.maxDownloadMB ||
                        t("settings.server.disabled")}
                    </dd>
                  </div>
                  <div>
                    <dt className="detail-label">
                      DOWNLOAD_THREADS
                    </dt>
                    <dd className="detail-value font-mono">
                      {serverInfo.downloadThreads ?? 8}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              {t("settings.server.offline")}
            </p>
          )}
        </section>

        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.data.title")}
          </h2>
          <p className="mb-4 text-[13px] text-muted">
            {t("settings.data.description")}
          </p>

          <div className="flex flex-wrap gap-3 mb-6">
            <button
              onClick={() => setExportModalOpen(true)}
              className="btn btn-ghost"
            >
              {t("settings.data.exportBtn")}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn btn-success"
            >
              {t("settings.data.importBtn")}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".enc"
              onChange={handleFileSelect}
            />
          </div>

          <button
            onClick={() => {
              if (!confirm(t("settings.data.confirm"))) return;
              localStorage.clear();
              indexedDB.deleteDatabase("asspp-accounts");
              addToast(t("settings.data.cleared"), "success");
              setTimeout(() => {
                window.location.href = "/";
              }, 1000);
            }}
            className="btn btn-danger"
          >
            {t("settings.data.button")}
          </button>
        </section>

        <section className="card card-pad">
          <h2 className="section-title mb-4">
            {t("settings.about.title")}
          </h2>
          <p className="text-[13px] text-muted">
            {t("settings.about.description")}
          </p>
          {serverInfo && (
            <dl className="mt-3 space-y-2">
              {serverInfo.buildCommit &&
                serverInfo.buildCommit !== "unknown" && (
                  <div>
                    <dt className="text-[12px] font-medium text-subtle">
                      {t("settings.about.buildCommit")}
                    </dt>
                    <dd className="font-mono text-[12px] text-muted">
                      {serverInfo.buildCommit.slice(0, 7)}
                    </dd>
                  </div>
                )}
              {serverInfo.buildDate && serverInfo.buildDate !== "unknown" && (
                <div>
                  <dt className="text-[12px] font-medium text-subtle">
                    {t("settings.about.buildDate")}
                  </dt>
                  <dd className="text-[12px] text-muted">
                    {new Date(serverInfo.buildDate).toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </section>
      </div>

      <Modal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title={t("settings.data.exportBtn")}
      >
        <div className="space-y-4">
          <div>
            <label className="field-label">
              {t("settings.data.passwordPrompt")}
            </label>
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              className="field-input"
            />
          </div>
          <div>
            <label className="field-label">
              {t("settings.data.passwordConfirm")}
            </label>
            <input
              type="password"
              value={exportConfirmPassword}
              onChange={(e) => setExportConfirmPassword(e.target.value)}
              className="field-input"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={() => setExportModalOpen(false)}
            className="btn btn-ghost"
          >
            {t("settings.data.cancel")}
          </button>
          <button
            onClick={handleExport}
            disabled={!exportPassword || !exportConfirmPassword}
            className="btn btn-primary"
          >
            {t("settings.data.confirmBtn")}
          </button>
        </div>
      </Modal>

      <Modal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        title={t("settings.data.importBtn")}
      >
        <div className="space-y-4">
          <div>
            <label className="field-label">
              {t("settings.data.passwordPrompt")}
            </label>
            <input
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              className="field-input"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={() => setImportModalOpen(false)}
            className="btn btn-ghost"
          >
            {t("settings.data.cancel")}
          </button>
          <button
            onClick={handleImport}
            disabled={!importPassword}
            className="btn btn-primary"
          >
            {t("settings.data.confirmBtn")}
          </button>
        </div>
      </Modal>

      <Modal
        open={conflictModalOpen}
        onClose={() => setConflictModalOpen(false)}
        title={t("settings.data.conflictTitle")}
      >
        <p className="mb-6 text-[13px] text-muted">
          {t("settings.data.conflictDesc", {
            conflict: conflictStats.conflict,
            new: conflictStats.new,
          })}
        </p>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => handleResolveConflict(true)}
            className="btn btn-danger w-full"
          >
            {t("settings.data.conflictOverwrite")}
          </button>
          <button
            onClick={() => handleResolveConflict(false)}
            className="btn btn-ghost w-full"
          >
            {t("settings.data.conflictSkip")}
          </button>
          <button
            onClick={() => setConflictModalOpen(false)}
            className="btn btn-ghost mt-2 w-full"
          >
            {t("settings.data.cancel")}
          </button>
        </div>
      </Modal>
    </PageContainer>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}
