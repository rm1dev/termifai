import type { ShortcutBinding } from "@/lib/shortcuts";

export const globalHotkeyStorageKey = "termifai:global-hotkey";

export interface GlobalHotkeySettings {
  enabled: boolean;
  binding: ShortcutBinding;
}

export const defaultGlobalHotkeyBinding: ShortcutBinding = {
  key: " ",
  code: "Space",
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: true,
};

export const defaultGlobalHotkeySettings: GlobalHotkeySettings = {
  enabled: false,
  binding: defaultGlobalHotkeyBinding,
};

export function loadGlobalHotkeySettings(): GlobalHotkeySettings {
  try {
    const stored = localStorage.getItem(globalHotkeyStorageKey);
    if (!stored) return defaultGlobalHotkeySettings;
    const parsed = JSON.parse(stored) as Partial<GlobalHotkeySettings>;
    if (!parsed.binding) return defaultGlobalHotkeySettings;
    return {
      enabled: Boolean(parsed.enabled),
      binding: parsed.binding,
    };
  } catch {
    return defaultGlobalHotkeySettings;
  }
}

export function saveGlobalHotkeySettings(settings: GlobalHotkeySettings) {
  localStorage.setItem(globalHotkeyStorageKey, JSON.stringify(settings));
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
