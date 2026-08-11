import { useTranslation } from "react-i18next";
import { SunIcon, MoonIcon, SystemIcon } from "../common/icons";
import { useSettingsStore } from "../../store/settings";

export default function MobileHeader() {
  const { t } = useTranslation();

  return (
    <>
      {/* Fixed positioning prevents a PWA overscroll gap while preserving safe-area padding. */}
      <header className="md:hidden fixed top-0 left-0 right-0 w-full bg-bg border-b border-border z-40 safe-top">
        <div className="flex items-center justify-between px-4 h-14">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-normal text-ink">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-ink text-[10px] font-bold text-on-ink">
              A
            </span>
            Asspp Web
          </h1>
          <ThemeToggle />
        </div>
      </header>
      {/* The spacer keeps page content below the fixed mobile header. */}
      <div className="md:hidden safe-top">
        <div className="h-14"></div>
      </div>
    </>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useSettingsStore();
  const { t } = useTranslation();

  const cycleTheme = () => {
    if (theme === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else setTheme("system");
  };

  return (
    <button
      onClick={cycleTheme}
      className="btn btn-ghost -mr-2 size-11 p-0"
      title={t(`theme.${theme}`)}
      aria-label={t(`theme.${theme}`)}
    >
      {theme === "light" && <SunIcon className="w-4 h-4" />}
      {theme === "dark" && <MoonIcon className="w-4 h-4" />}
      {theme === "system" && <SystemIcon className="w-4 h-4" />}
    </button>
  );
}
