import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import { useAccounts } from "../../hooks/useAccounts";
import { apiGet } from "../../api/client";
import { accountHash } from "../../utils/account";

interface Stats {
  accounts: number;
  downloads: number;
  packages: number;
}

export default function HomePage() {
  const { t } = useTranslation();
  const { accounts } = useAccounts();
  const [stats, setStats] = useState<Stats>({
    accounts: 0,
    downloads: 0,
    packages: 0,
  });

  useEffect(() => {
    setStats((prev) => ({ ...prev, accounts: accounts.length }));

    if (accounts.length === 0) {
      setStats((prev) => ({ ...prev, downloads: 0, packages: 0 }));
      return;
    }

    let cancelled = false;

    (async () => {
      const hashes = await Promise.all(accounts.map((a) => accountHash(a)));
      if (cancelled) return;

      const params = new URLSearchParams({
        accountHashes: hashes.join(","),
      });

      const [downloads, packages] = await Promise.all([
        apiGet<any[]>(`/api/downloads?${params}`).catch(() => []),
        apiGet<any[]>(`/api/packages?${params}`).catch(() => []),
      ]);

      if (cancelled) return;

      setStats((prev) => ({
        ...prev,
        downloads: Array.isArray(downloads) ? downloads.length : 0,
        packages: Array.isArray(packages) ? packages.length : 0,
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [accounts]);

  return (
    <PageContainer>
      <div className="space-y-8">
        <div>
          <h1 className="page-title">
            {t("home.welcome")}
          </h1>
          <p className="page-subtitle">
            {t("home.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label={t("home.stats.accounts")} value={stats.accounts} />
          <StatCard label={t("home.stats.downloads")} value={stats.downloads} />
          <StatCard label={t("home.stats.packages")} value={stats.packages} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <ActionCard
            to="/accounts/add"
            title={t("home.actions.addAccount")}
            description={t("home.actions.addAccountDesc")}
          />
          <ActionCard
            to="/search"
            title={t("home.actions.searchApps")}
            description={t("home.actions.searchAppsDesc")}
          />
          <ActionCard
            to="/downloads"
            title={t("home.actions.viewDownloads")}
            description={t("home.actions.viewDownloadsDesc")}
          />
        </div>
      </div>
    </PageContainer>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card card-pad">
      <p className="text-[12.5px] font-medium text-muted">
        {label}
      </p>
      <p className="mt-1 text-[28px] font-semibold tracking-normal text-ink">
        {value}
      </p>
    </div>
  );
}

function ActionCard({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="list-row p-5"
    >
      <h3 className="text-[13.5px] font-semibold text-ink">
        {title}
      </h3>
      <p className="mt-1 text-[13px] text-muted">
        {description}
      </p>
    </Link>
  );
}
