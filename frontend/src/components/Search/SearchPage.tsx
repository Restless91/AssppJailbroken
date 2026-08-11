import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import CountrySelect from "../common/CountrySelect";
import { useSearch } from "../../hooks/useSearch";
import { useAccounts } from "../../hooks/useAccounts";
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { firstAccountCountry } from "../../utils/account";
import { countryCodeMap, storeIdToCountry } from "../../apple/config";

export default function SearchPage() {
  const { t } = useTranslation();
  const { defaultCountry, defaultEntity } = useSettingsStore();
  const { accounts } = useAccounts();
  const initialCountry = firstAccountCountry(accounts) ?? defaultCountry;
  const addToast = useToastStore((s) => s.addToast);

  const {
    term,
    country,
    entity,
    results,
    loading,
    error,
    search,
    setSearchParam,
  } = useSearch();

  useEffect(() => {
    if (error) {
      addToast(error, "error");
    }
  }, [error, addToast]);

  useEffect(() => {
    if (!country && initialCountry) setSearchParam({ country: initialCountry });
    if (!entity && defaultEntity) setSearchParam({ entity: defaultEntity });
  }, [country, initialCountry, entity, defaultEntity, setSearchParam]);

  const activeCountry = country || initialCountry;
  const activeEntity = entity || defaultEntity;

  const availableCountryCodes = Array.from(
    new Set(
      accounts
        .map((a) => storeIdToCountry(a.store))
        .filter(Boolean) as string[],
    ),
  ).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const allCountryCodes = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    search(term.trim(), activeCountry, activeEntity);
  }

  return (
    <PageContainer title={t("search.title")}>
      <form onSubmit={handleSubmit} className="space-y-4 mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={term}
            onChange={(e) => setSearchParam({ term: e.target.value })}
            placeholder={t("search.placeholder")}
            className="field-input flex-1"
          />
          <button
            type="submit"
            disabled={loading || !term.trim()}
            className="btn btn-primary"
          >
            {loading ? t("search.searching") : t("search.button")}
          </button>
        </div>
        <div className="flex w-full gap-3 overflow-hidden">
          <CountrySelect
            value={activeCountry}
            onChange={(c) => setSearchParam({ country: c })}
            availableCountryCodes={availableCountryCodes}
            allCountryCodes={allCountryCodes}
            className="w-1/2 truncate"
          />
          <select
            value={activeEntity}
            onChange={(e) => setSearchParam({ entity: e.target.value })}
            className="field-input field-select w-1/2 truncate"
          >
            <option value="iPhone">iPhone</option>
            <option value="iPad">iPad</option>
          </select>
        </div>
      </form>

      {results.length === 0 && !loading && !error && (
        <div className="empty-state">
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
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-[15px] font-semibold text-ink">
            {t("search.empty")}
          </h3>
          <p className="max-w-sm text-[13px] text-muted">
            {t("search.emptyDesc")}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {results.map((app) => (
          <Link
            key={app.id}
            to={`/search/${app.id}`}
            state={{ app, country: activeCountry }}
            className="list-row p-4"
          >
            <div className="flex items-center gap-4">
              <AppIcon url={app.artworkUrl} name={app.name} size="md" />
              <div className="flex-1 min-w-0">
                <p className="truncate text-[13.5px] font-medium text-ink">
                  {app.name}
                </p>
                <p className="truncate text-[12.5px] text-muted">
                  {app.artistName}
                </p>
                <div className="mt-1 flex items-center gap-3 text-[11.5px] text-subtle">
                  <span>{app.formattedPrice ?? t("search.free")}</span>
                  <span>{app.primaryGenreName}</span>
                  <span>
                    {app.averageUserRating.toFixed(1)} ({app.userRatingCount})
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </PageContainer>
  );
}
