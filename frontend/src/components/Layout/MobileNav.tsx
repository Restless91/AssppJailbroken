import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  HomeIcon,
  AccountsIcon,
  SearchIcon,
  DownloadsIcon,
  SettingsIcon,
} from "../common/icons";

const navItems = [
  { to: "/", label: "home", icon: HomeIcon },
  { to: "/accounts", label: "accounts", icon: AccountsIcon },
  { to: "/search", label: "search", icon: SearchIcon },
  { to: "/downloads", label: "downloads", icon: DownloadsIcon },
  { to: "/settings", label: "settings", icon: SettingsIcon },
];

export default function MobileNav() {
  const { t } = useTranslation();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-bg border-t border-border z-50 safe-bottom">
      <div className="flex justify-around items-center h-16 px-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className="mobile-nav-item"
          >
            <item.icon className="w-4 h-4" />
            <span>{t(`nav.${item.label}`)}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
