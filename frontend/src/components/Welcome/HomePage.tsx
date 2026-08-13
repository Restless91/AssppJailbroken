import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import { useAccounts } from "../../hooks/useAccounts";
import { apiGet } from "../../api/client";
import { topApps } from "../../api/search";
import { firstAccountCountry } from "../../utils/account";
import { accountHash } from "../../utils/account";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import type { Software } from "../../types";

interface Stats {
  accounts: number;
  downloads: number;
  packages: number;
}

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { accounts } = useAccounts();
  const defaultCountry = useSettingsStore((s) => s.defaultCountry);
  const addToast = useToastStore((s) => s.addToast);
  const rankingCountry = useMemo(
    () => firstAccountCountry(accounts) ?? defaultCountry ?? "CN",
    [accounts, defaultCountry],
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [popularApps, setPopularApps] = useState<Software[]>([]);
  const [popularLoading, setPopularLoading] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    setPopularLoading(true);

    topApps(rankingCountry, 24)
      .then((apps) => {
        if (!cancelled) setPopularApps(apps);
      })
      .catch((error) => {
        if (!cancelled) {
          setPopularApps([]);
          addToast(
            error instanceof Error ? error.message : t("home.popular.loadFailed"),
            "error",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPopularLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rankingCountry, addToast, t]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = searchTerm.trim();
    if (!term) return;
    navigate(`/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(rankingCountry)}`);
  }

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

        <form onSubmit={handleSearch} className="card card-pad space-y-3">
          <div>
            <h2 className="section-title">
              {t("home.search.title")}
            </h2>
            <p className="page-subtitle">
              {t("home.search.subtitle")}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t("search.placeholder")}
              className="field-input flex-1"
            />
            <button
              type="submit"
              disabled={!searchTerm.trim()}
              className="btn btn-primary"
            >
              {t("search.button")}
            </button>
          </div>
        </form>

        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="page-title text-[22px] sm:text-[24px]">
                {t("home.popular.title")}
              </h2>
              <p className="page-subtitle">
                {t("home.popular.subtitle", { country: rankingCountry.toUpperCase() })}
              </p>
            </div>
            <Link to="/search" className="btn btn-ghost btn-sm">
              {t("home.popular.searchMore")}
            </Link>
          </div>

          {popularLoading ? (
            <div className="card card-pad text-center text-muted">
              {t("home.popular.loading")}
            </div>
          ) : popularApps.length === 0 ? (
            <div className="empty-state">
              <h3 className="mb-2 text-[15px] font-semibold text-ink">
                {t("home.popular.empty")}
              </h3>
              <p className="max-w-sm text-[13px] text-muted">
                {t("home.popular.emptyDesc")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {popularApps.map((app, index) => (
                <Link
                  key={`${app.id}-${index}`}
                  to={`/search/${app.id}`}
                  state={{ app, country: rankingCountry }}
                  className="list-row p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-8 shrink-0 text-center text-[12px] font-semibold text-muted">
                      #{app.rank ?? index + 1}
                    </div>
                    <AppIcon url={app.artworkUrl} name={app.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-ink">
                        {app.name}
                      </p>
                      <p className="truncate text-[12.5px] text-muted">
                        {app.artistName}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-subtle">
                        <span>{app.formattedPrice ?? t("search.free")}</span>
                        {app.primaryGenreName && <span>{app.primaryGenreName}</span>}
                        {app.version && <span>v{app.version}</span>}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
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
