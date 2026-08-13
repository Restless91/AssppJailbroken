import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Spinner from "../common/Spinner";
import { useAccounts } from "../../hooks/useAccounts";
import { useToastStore } from "../../store/toast";
import { authenticate, AuthenticationError } from "../../api/apple";
import { getErrorMessage } from "../../utils/error";
import { generateDeviceId } from "../../apple/config";

const DEVICE_ID_STORAGE_PREFIX = "asspp.apple.deviceId.";
const LAST_DEVICE_ID_STORAGE_KEY = "asspp.apple.lastDeviceId";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function storageKeyForEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  return normalized ? `${DEVICE_ID_STORAGE_PREFIX}${normalized}` : null;
}

function readStoredDeviceId(email?: string): string | null {
  try {
    const emailKey = email ? storageKeyForEmail(email) : null;
    if (emailKey) {
      const value = window.localStorage.getItem(emailKey);
      if (value) return value;
    }
    return window.localStorage.getItem(LAST_DEVICE_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredDeviceId(email: string, deviceId: string) {
  try {
    window.localStorage.setItem(LAST_DEVICE_ID_STORAGE_KEY, deviceId);
    const emailKey = storageKeyForEmail(email);
    if (emailKey) {
      window.localStorage.setItem(emailKey, deviceId);
    }
  } catch {
    // localStorage may be unavailable in private browsing; login can still proceed.
  }
}

export default function AddAccountForm() {
  const navigate = useNavigate();
  const { addAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState(
    () => readStoredDeviceId() ?? generateDeviceId(),
  );
  const [needsCode, setNeedsCode] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (needsCode) return;
    const stored = readStoredDeviceId(email);
    if (stored && stored !== deviceId) {
      setDeviceId(stored);
    }
  }, [deviceId, email, needsCode]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const cleanedDeviceId = deviceId.replace(/[: ]/g, "");
      setDeviceId(cleanedDeviceId);
      writeStoredDeviceId(email, cleanedDeviceId);

      const account = await authenticate(
        email,
        password,
        needsCode && code ? code : undefined,
        undefined,
        cleanedDeviceId,
      );
      await addAccount(account);
      addToast(t("accounts.addForm.addSuccess"), "success");
      navigate("/accounts");
    } catch (err) {
      if (err instanceof AuthenticationError && err.codeRequired) {
        setNeedsCode(true);
        addToast(err.message, "error");
      } else {
        addToast(
          getErrorMessage(err, t("accounts.addForm.authFailed")),
          "error",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer title={t("accounts.addForm.title")}>
      <div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <section className="card card-pad space-y-4">
            <div>
              <label
                htmlFor="email"
                className="field-label"
              >
                {t("accounts.addForm.email")}
              </label>
              <input
                id="email"
                type="text"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                placeholder={t("accounts.addForm.emailPlaceholder")}
                className="field-input"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="field-label"
              >
                {t("accounts.addForm.password")}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="field-input"
              />
            </div>

            <div>
              <label
                htmlFor="deviceId"
                className="field-label"
              >
                {t("accounts.addForm.deviceId")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="deviceId"
                  type="text"
                  required
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={loading || needsCode}
                  className="field-input min-w-0 flex-1 font-mono"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextDeviceId = generateDeviceId();
                    setDeviceId(nextDeviceId);
                    writeStoredDeviceId(email, nextDeviceId);
                  }}
                  disabled={loading || needsCode}
                  className="btn btn-ghost btn-sm h-11 flex-shrink-0"
                >
                  {t("accounts.addForm.randomize")}
                </button>
              </div>
              <p className="field-hint">
                {t("accounts.addForm.deviceIdHelp")}
              </p>
            </div>

            {needsCode && (
              <div>
                <label
                  htmlFor="code"
                  className="field-label"
                >
                  {t("accounts.addForm.code")}
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={loading}
                  placeholder={t("accounts.addForm.codePlaceholder")}
                  className="field-input"
                  autoFocus
                />
                <p className="field-hint">
                  {t("accounts.addForm.codeHelp")}
                </p>
              </div>
            )}
          </section>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary"
            >
              {loading && <Spinner />}
              {needsCode
                ? t("accounts.addForm.verify")
                : t("accounts.addForm.signIn")}
            </button>
            <button
              type="button"
              onClick={() => navigate("/accounts")}
              disabled={loading}
              className="btn btn-ghost"
            >
              {t("accounts.addForm.cancel")}
            </button>
          </div>
        </form>
      </div>
    </PageContainer>
  );
}
