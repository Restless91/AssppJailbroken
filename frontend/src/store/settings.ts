import { create } from "zustand";
import { persist } from "zustand/middleware";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  defaultCountry: string;
  defaultEntity: "iPhone" | "iPad";
  theme: ThemeType;
  demoMode: boolean;
  setDefaultCountry: (country: string) => void;
  setDefaultEntity: (entity: "iPhone" | "iPad") => void;
  setTheme: (theme: ThemeType) => void;
  setDemoMode: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: "US",
      defaultEntity: "iPhone",
      theme: "system",
      demoMode: false,
      setDefaultCountry: (country) => set({ defaultCountry: country }),
      setDefaultEntity: (entity) => set({ defaultEntity: entity }),
      setTheme: (theme) => set({ theme }),
      setDemoMode: (demoMode) => set({ demoMode }),
    }),
    {
      name: "asspp-settings",
    },
  ),
);
