import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  HomeIcon,
  AccountsIcon,
  SearchIcon,
  DownloadsIcon,
  SettingsIcon,
  SunIcon,
  MoonIcon,
  SystemIcon,
} from "../common/icons";
import { useSettingsStore } from "../../store/settings";

const navItems = [
  { to: "/", label: "home", icon: HomeIcon },
  { to: "/accounts", label: "accounts", icon: AccountsIcon },
  { to: "/search", label: "search", icon: SearchIcon },
  { to: "/downloads", label: "downloads", icon: DownloadsIcon },
  { to: "/settings", label: "settings", icon: SettingsIcon },
];

export default function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside className="hidden md:flex md:flex-col md:w-56 bg-bg border-r border-border h-screen sticky top-0">
      <div className="p-5">
        <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-normal text-ink">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-ink text-[10px] font-bold text-on-ink">
            A
          </span>
          Asspp Web
        </h1>
      </div>
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto" aria-label="Page">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className="sidebar-nav-item gap-3"
          >
            <item.icon className="w-4 h-4" />
            {t(`nav.${item.label}`)}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-border">
        <ThemeToggle />
      </div>
    </aside>
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
      className="sidebar-nav-item gap-3"
      title={t(`theme.${theme}`)}
    >
      {theme === "light" && <SunIcon className="w-4 h-4" />}
      {theme === "dark" && <MoonIcon className="w-4 h-4" />}
      {theme === "system" && <SystemIcon className="w-4 h-4" />}
      <span>{t(`theme.${theme}`)}</span>
    </button>
  );
}
