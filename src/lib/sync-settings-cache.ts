import { syncCacheSettings } from "@/lib/api/sync";
import { getAppThemeUpdatedAt, loadAppTheme } from "@/lib/app-theme";
import {
  getTerminalAppearanceUpdatedAt,
  loadTerminalAppearance,
} from "@/lib/terminal-appearance";
import { getShortcutsUpdatedAt, loadShortcuts } from "@/lib/shortcuts";

/** Pushes the webview's localStorage settings into the Rust settings cache
 * so background auto-sync can include them without reading the DOM. */
export function pushSyncSettingsCache(): void {
  void syncCacheSettings({
    appTheme: {
      value: loadAppTheme().id,
      updatedAt: getAppThemeUpdatedAt(),
    },
    terminalAppearance: {
      value: loadTerminalAppearance(),
      updatedAt: getTerminalAppearanceUpdatedAt(),
    },
    shortcuts: {
      value: loadShortcuts(),
      updatedAt: getShortcutsUpdatedAt(),
    },
  }).catch(() => {
    /* Vault may still be locked / sync not configured. */
  });
}
