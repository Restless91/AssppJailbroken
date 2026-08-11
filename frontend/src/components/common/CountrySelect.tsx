import { useTranslation } from "react-i18next";

export default function CountrySelect({
  value,
  onChange,
  availableCountryCodes,
  allCountryCodes,
  disabled,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  availableCountryCodes: string[];
  allCountryCodes: string[];
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`field-input field-select ${className}`}
      disabled={disabled}
    >
      {availableCountryCodes.length > 0 && (
        <optgroup label={t("regions.available")}>
          {availableCountryCodes.map((c) => (
            <option key={`avail-${c}`} value={c}>
              {t(`countries.${c}`, c)} ({c})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={t("regions.all")}>
        {allCountryCodes.map((c) => (
          <option key={`all-${c}`} value={c}>
            {t(`countries.${c}`, c)} ({c})
          </option>
        ))}
      </optgroup>
    </select>
  );
}
