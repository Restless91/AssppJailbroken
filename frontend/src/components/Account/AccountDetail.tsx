import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Spinner from "../common/Spinner";
import { useAccounts } from "../../hooks/useAccounts";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { authenticate, AuthenticationError } from "../../api/apple";
import {
  findAccountIndexByRouteSegment,
  getAccountDisplayAppleId,
  getAccountDisplayEmail,
  getAccountDisplayName,
  getAccountRouteSegment,
} from "../../utils/accountDisplay";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";

export default function AccountDetail() {
  const { email } = useParams<{ email: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    accounts,
    loading: storeLoading,
    loadAccounts,
    updateAccount,
    removeAccount,
  } = useAccounts();
  const demoMode = useSettingsStore((s) => s.demoMode);
  const addToast = useToastStore((s) => s.addToast);

  const [showDelete, setShowDelete] = useState(false);
  const [reauthing, setReauthing] = useState(false);
  const [reauthCode, setReauthCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const routeSegment = email ? decodeURIComponent(email) : "";
  const accountIndex = findAccountIndexByRouteSegment(
    accounts,
    routeSegment,
  );
  const account = accountIndex >= 0 ? accounts[accountIndex] : undefined;

  useEffect(() => {
    if (!demoMode || accountIndex < 0 || !account) return;
    const demoRouteSegment = getAccountRouteSegment(account, true, accountIndex);
    if (routeSegment !== demoRouteSegment) {
      navigate(`/accounts/${demoRouteSegment}`, { replace: true });
    }
  }, [account, accountIndex, demoMode, navigate, routeSegment]);

  if (storeLoading) {
    return (
      <PageContainer title={t("accounts.title")}>
        <div className="py-12 text-center text-muted">{t("loading")}</div>
      </PageContainer>
    );
  }

  if (!account) {
    return (
      <PageContainer title={t("accounts.title")}>
        <div className="text-center py-12">
          <p className="mb-4 text-muted">{t("accounts.detail.notFound")}</p>
          <button
            onClick={() => navigate("/accounts")}
            className="text-link"
          >
            {t("accounts.detail.back")}
          </button>
        </div>
      </PageContainer>
    );
  }

  async function handleReauth() {
    if (!account) return;
    setReauthing(true);

    try {
      const updated = await authenticate(
        account.email,
        account.password,
        needsCode && reauthCode ? reauthCode : undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      await updateAccount(updated);
      setNeedsCode(false);
      setReauthCode("");
      addToast(t("accounts.detail.reauthSuccess"), "success");
    } catch (err) {
      if (err instanceof AuthenticationError && err.codeRequired) {
        setNeedsCode(true);
        addToast(err.message, "error");
      } else {
        addToast(
          getErrorMessage(err, t("accounts.detail.reauthFailed")),
          "error",
        );
      }
    } finally {
      setReauthing(false);
    }
  }

  async function handleDelete() {
    if (!account) return;
    await removeAccount(account.email);
    addToast(t("accounts.detail.deleteSuccess"), "success");
    navigate("/accounts");
  }

  const countryCode = storeIdToCountry(account.store);
  const displayRegion = countryCode
    ? `${t(`countries.${countryCode}`, countryCode)} (${account.store})`
    : account.store;

  return (
    <PageContainer title={t("accounts.detail.title")}>
      <div className="max-w-lg space-y-6">
        <section className="card card-pad">
          <dl className="space-y-4">
            <DetailRow
              label={t("accounts.detail.name")}
              value={getAccountDisplayName(account, t, demoMode, accountIndex)}
            />
            <DetailRow
              label={t("accounts.detail.email")}
              value={getAccountDisplayEmail(account, t, demoMode)}
            />
            <DetailRow
              label={t("accounts.detail.appleId")}
              value={getAccountDisplayAppleId(account, t, demoMode)}
            />
            <DetailRow
              label={t("accounts.detail.storeRegion")}
              value={displayRegion}
            />
            <DetailRow
              label={t("accounts.detail.dsid")}
              value={account.directoryServicesIdentifier}
            />
            <DetailRow
              label={t("accounts.detail.deviceId")}
              value={account.deviceIdentifier}
            />
            {account.pod && (
              <DetailRow label={t("accounts.detail.pod")} value={account.pod} />
            )}
          </dl>
        </section>

        {needsCode && (
          <section className="card card-pad">
            <label
              htmlFor="reauth-code"
              className="field-label"
            >
              {t("accounts.detail.code")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="reauth-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={reauthCode}
                onChange={(e) => setReauthCode(e.target.value)}
                disabled={reauthing}
                placeholder="000000"
                className="field-input flex-1"
                autoFocus
              />
              <button
                onClick={handleReauth}
                disabled={reauthing || !reauthCode}
                className="btn btn-primary"
              >
                {reauthing && <Spinner />}
                {t("accounts.detail.verify")}
              </button>
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleReauth}
            disabled={reauthing}
            className="btn btn-primary"
          >
            {reauthing && <Spinner />}
            {t("accounts.detail.reauth")}
          </button>

          {!showDelete ? (
            <button
              onClick={() => setShowDelete(true)}
              className="btn btn-danger"
            >
              {t("accounts.detail.delete")}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">
                {t("accounts.detail.areYouSure")}
              </span>
              <button
                onClick={handleDelete}
                className="btn btn-danger"
              >
                {t("accounts.detail.confirmDelete")}
              </button>
              <button
                onClick={() => setShowDelete(false)}
                className="btn btn-ghost"
              >
                {t("accounts.detail.cancel")}
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => navigate("/accounts")}
          className="btn btn-ghost mt-2"
        >
          {t("accounts.detail.back")}
        </button>
      </div>
    </PageContainer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="detail-label">
        {label}
      </dt>
      <dd className="detail-value">
        {value || "--"}
      </dd>
    </div>
  );
}
