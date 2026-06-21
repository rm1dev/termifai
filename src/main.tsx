import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/components/app/AppShell";
import { SettingsWindow } from "@/components/settings/SettingsWindow";
import { Toaster } from "@/components/ui/sonner";
import {
  appThemeChangedEvent,
  appThemeStorageKey,
  applyAppTheme,
  loadAppTheme,
  type AppTheme,
} from "@/lib/app-theme";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const Root = params.get("window") === "settings" ? SettingsWindow : AppShell;

applyAppTheme(loadAppTheme());
window.addEventListener("storage", (event) => {
  if (event.key === appThemeStorageKey) {
    applyAppTheme(loadAppTheme());
  }
});
void listen<AppTheme>(appThemeChangedEvent, (event) => {
  applyAppTheme(event.payload);
}).catch(() => {
  /* Non-Tauri environments rely on storage events. */
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
    <Toaster />
  </StrictMode>
);
