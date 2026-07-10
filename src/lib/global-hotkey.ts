import type { ShortcutBinding } from "@/lib/shortcuts";
import type { HotkeyAction } from "@/lib/api/global-hotkey";

/** Legacy key (main-window only); per-action keys derive from it below. */
export const globalHotkeyStorageKey = "termifai:global-hotkey";

export interface GlobalHotkeySettings {
  enabled: boolean;
  binding: ShortcutBinding;
}

const defaultBindings: Record<HotkeyAction, ShortcutBinding> = {
  "main-window": {
    key: " ",
    code: "Space",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
  },
  "quick-terminal": {
    key: "`",
    code: "Backquote",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
  },
};

function storageKey(action: HotkeyAction): string {
  // Keeps the pre-existing main-window entry readable without migration.
  return action === "main-window"
    ? globalHotkeyStorageKey
    : `${globalHotkeyStorageKey}:${action}`;
}

export function defaultGlobalHotkeySettings(action: HotkeyAction): GlobalHotkeySettings {
  return { enabled: false, binding: defaultBindings[action] };
}

export function loadGlobalHotkeySettings(action: HotkeyAction): GlobalHotkeySettings {
  try {
    const stored = localStorage.getItem(storageKey(action));
    if (!stored) return defaultGlobalHotkeySettings(action);
    const parsed = JSON.parse(stored) as Partial<GlobalHotkeySettings>;
    if (!parsed.binding) return defaultGlobalHotkeySettings(action);
    return {
      enabled: Boolean(parsed.enabled),
      binding: parsed.binding,
    };
  } catch {
    return defaultGlobalHotkeySettings(action);
  }
}

export function saveGlobalHotkeySettings(action: HotkeyAction, settings: GlobalHotkeySettings) {
  localStorage.setItem(storageKey(action), JSON.stringify(settings));
}

/** Converts a recorded browser key combo into Tauri's accelerator syntax, e.g. "CmdOrCtrl+Shift+Space". */
export function bindingToAccelerator(binding: ShortcutBinding): string | null {
  const parts: string[] = [];
  if (binding.metaKey) parts.push("Super");
  if (binding.ctrlKey) parts.push("Ctrl");
  if (binding.altKey) parts.push("Alt");
  if (binding.shiftKey) parts.push("Shift");

  if (parts.length === 0) return null; // Global shortcuts must include a modifier.

  parts.push(acceleratorKey(binding.key));
  return parts.join("+");
}

function acceleratorKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();

  const known: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };
  return known[key] ?? key;
}
