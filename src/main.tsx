import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { Toaster } from "@/components/ui/sonner";
import {
  appThemeChangedEvent,
  appThemeStorageKey,
  applyAppTheme,
  loadAppTheme,
  type AppTheme,
} from "@/lib/app-theme";
import "./styles.css";

const AppShell = lazy(() =>
  import("@/components/app/AppShell").then((m) => ({ default: m.AppShell }))
);
const SettingsWindow = lazy(() =>
  import("@/components/settings/SettingsWindow").then((m) => ({ default: m.SettingsWindow }))
);

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

// Prevent Ctrl+scroll and pinch-to-zoom in the webview
window.addEventListener("wheel", (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
window.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("gesturechange", (e) => e.preventDefault());

const params = new URLSearchParams(window.location.search);
const isSettings = params.get("window") === "settings";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense>
      {isSettings ? <SettingsWindow /> : <AppShell />}
    </Suspense>
    <Toaster />
  </StrictMode>
);
