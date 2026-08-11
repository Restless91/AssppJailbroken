import { useEffect } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import { useAccountsStore } from "../../store/accounts";
import { useSettingsStore } from "../../store/settings";
import {
  getAccountDisplayEmail,
  getAccountDisplayName,
  getAccountRouteSegment,
} from "../../utils/accountDisplay";
import { storeIdToCountry } from "../../apple/config";

export default function AccountList() {
  const { t } = useTranslation();
  const { accounts, loading, loadAccounts } = useAccountsStore();
  const demoMode = useSettingsStore((s) => s.demoMode);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  return (
    <PageContainer
      title={t("accounts.title")}
      action={
        <Link
          to="/accounts/add"
          className="btn btn-primary"
        >
          {t("accounts.add")}
        </Link>
      }
    >
      {loading ? (
        <div className="py-12 text-center text-muted">
          {t("accounts.loading")}
        </div>
      ) : accounts.length === 0 ? (
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
                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-[15px] font-semibold text-ink">
            {t("accounts.empty")}
          </h3>
          <p className="mb-6 max-w-sm text-[13px] text-muted">
            {t("accounts.emptyDesc")}
          </p>
          <Link
            to="/accounts/add"
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
                d="M12 4.5v15m7.5-7.5h-15"
              />
            </svg>
            {t("accounts.addFirst")}
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((account, index) => {
            const countryCode =
              storeIdToCountry(account.store) || account.store;

            return (
              <NavLink
                key={account.email}
                to={`/accounts/${getAccountRouteSegment(account, demoMode, index)}`}
                className="list-row p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13.5px] font-medium text-ink">
                      {getAccountDisplayName(account, t, demoMode, index)}
                    </p>
                    <p className="text-[12.5px] text-muted">
                      {getAccountDisplayEmail(account, t, demoMode)}
                    </p>
                  </div>
                  <div className="text-[12.5px] text-subtle">
                    {t(`countries.${countryCode}`, countryCode)}
                  </div>
                </div>
              </NavLink>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
