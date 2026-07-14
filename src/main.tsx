import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { subscribe } from "@/lib/api/transport";
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
const QuickTerminalWindow = lazy(() =>
  import("@/components/quick-terminal/QuickTerminalWindow").then((m) => ({
    default: m.QuickTerminalWindow,
  }))
);

applyAppTheme(loadAppTheme());
window.addEventListener("storage", (event) => {
  if (event.key === appThemeStorageKey) {
    applyAppTheme(loadAppTheme());
  }
});
void subscribe<AppTheme>(appThemeChangedEvent, (event) => {
  applyAppTheme(event.payload);
}).catch(() => {
  /* Non-Tauri environments rely on storage events. */
});

// Focus rings only for real keyboard navigation. The browser's
// :focus-visible heuristic turns the ring on for a mouse-focused element as
// soon as any key (e.g. Space) is pressed; styles.css suppresses rings
// unless this class marks the user as Tab-navigating.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Tab") document.documentElement.classList.add("user-is-tabbing");
  },
  true,
);
window.addEventListener(
  "pointerdown",
  () => document.documentElement.classList.remove("user-is-tabbing"),
  true,
);

// Prevent Ctrl+scroll and pinch-to-zoom in the webview
window.addEventListener("wheel", (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
window.addEventListener("gesturestart", (e) => e.preventDefault());
window.addEventListener("gesturechange", (e) => e.preventDefault());

// Suppress the native webview context menu (Reload/Inspect) in release builds.
// Custom in-app context menus still work: they handle the event on their own
// targets before this window-level listener runs.
if (import.meta.env.PROD) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

const params = new URLSearchParams(window.location.search);
const windowKind = params.get("window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense>
      {windowKind === "settings" ? (
        <SettingsWindow />
      ) : windowKind === "quick-terminal" ? (
        <QuickTerminalWindow />
      ) : (
        <AppShell />
      )}
    </Suspense>
    <Toaster />
  </StrictMode>
);
