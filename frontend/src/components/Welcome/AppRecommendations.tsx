import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AppIcon from "../common/AppIcon";
import { getRecommendations, type AppRecommendation } from "../../api/recommendations";

export default function AppRecommendations({ country }: { country: string }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<AppRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setApps(await getRecommendations(country));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section aria-labelledby="app-recommendations-title" className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id="app-recommendations-title" className="section-title">{t("home.recommendations.title")}</h2>
          <p className="mt-1 text-[13px] text-muted">{t("home.recommendations.subtitle", { country })}</p>
        </div>
        <Link to="/search" className="btn btn-ghost min-h-11 shrink-0">{t("home.recommendations.more")}</Link>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={t("loading")}>
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="card h-[88px] animate-pulse" aria-hidden="true" />
          ))}
        </div>
      ) : failed ? (
        <div className="card card-pad flex flex-col items-start gap-3" role="status">
          <p className="text-[13px] text-muted">{t("home.recommendations.failed")}</p>
          <button type="button" onClick={() => void load()} className="btn btn-ghost min-h-11">{t("home.recommendations.retry")}</button>
        </div>
      ) : apps.length === 0 ? (
        <p className="card card-pad text-[13px] text-muted">{t("home.recommendations.empty")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {apps.map((app) => (
            <Link
              key={app.id}
              to={`/search/${app.id}`}
              state={{ country }}
              className="list-row min-h-[88px] p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t("home.recommendations.open", { name: app.name, rank: app.rank })}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-5 shrink-0 text-center text-[12px] font-semibold tabular-nums text-subtle">{app.rank}</span>
                <AppIcon url={app.artworkUrl} name={app.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-ink">{app.name}</p>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted">{app.artistName}</p>
                  {app.genreName && <p className="mt-1 truncate text-[11.5px] text-subtle">{app.genreName}</p>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
