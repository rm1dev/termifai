import { emit } from "@tauri-apps/api/event";

export type ShortcutActionId =
  | "new-terminal"
  | "close-tab"
  | "next-tab"
  | "previous-tab"
  | "open-settings";

export interface ShortcutBinding {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutDefinition {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultBinding: ShortcutBinding;
}

export type ShortcutMap = Record<ShortcutActionId, ShortcutBinding>;

export const shortcutsChangedEvent = "termifai:shortcuts-changed";
export const shortcutsStorageKey = "termifai:shortcuts";

export const shortcutDefinitions: ShortcutDefinition[] = [
  {
    id: "new-terminal",
    label: "New terminal",
    description: "Open a new local terminal tab",
    defaultBinding: binding("t", { metaKey: true, code: "KeyT" }),
  },
  {
    id: "close-tab",
    label: "Close tab",
    description: "Close the current tab when possible",
    defaultBinding: binding("w", { metaKey: true, code: "KeyW" }),
  },
  {
    id: "next-tab",
    label: "Next tab",
    description: "Switch to the tab on the right",
    defaultBinding: binding("]", { metaKey: true, shiftKey: true, code: "BracketRight" }),
  },
  {
    id: "previous-tab",
    label: "Previous tab",
    description: "Switch to the tab on the left",
    defaultBinding: binding("[", { metaKey: true, shiftKey: true, code: "BracketLeft" }),
  },
  {
    id: "open-settings",
    label: "Open settings",
    description: "Open or focus the Settings window",
    defaultBinding: binding(",", { metaKey: true, code: "Comma" }),
  },
];

export const defaultShortcuts = shortcutDefinitions.reduce((acc, definition) => {
  acc[definition.id] = definition.defaultBinding;
  return acc;
}, {} as ShortcutMap);

function binding(
  key: string,
  modifiers: Partial<Omit<ShortcutBinding, "key">> = {}
): ShortcutBinding {
  return {
    key,
    code: modifiers.code,
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

export function eventToShortcutBinding(event: KeyboardEvent): ShortcutBinding | null {
  const key = keyFromEvent(event);

  if (!key) return null;

  return {
    key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

export function formatShortcut(binding: ShortcutBinding) {
  const keys = [];

  if (binding.metaKey) keys.push("⌘");
  if (binding.ctrlKey) keys.push("Ctrl");
  if (binding.altKey) keys.push("⌥");
  if (binding.shiftKey) keys.push("⇧");
  keys.push(formatKey(binding.key));

  return keys;
}

export function isShortcutMatch(event: KeyboardEvent, binding: ShortcutBinding) {
  const eventKey = keyFromEvent(event);
  const bindingKey = normalizeKey(binding.key);

  return (
    eventKey === bindingKey &&
    (!binding.code || event.code === binding.code) &&
    event.metaKey === binding.metaKey &&
    event.ctrlKey === binding.ctrlKey &&
    event.altKey === binding.altKey &&
    event.shiftKey === binding.shiftKey
  );
}

export function loadShortcuts(): ShortcutMap {
  try {
    const stored = localStorage.getItem(shortcutsStorageKey);
    if (!stored) return defaultShortcuts;

    const parsed = JSON.parse(stored) as Partial<ShortcutMap>;

    return shortcutDefinitions.reduce((acc, definition) => {
      acc[definition.id] = isShortcutBinding(parsed[definition.id])
        ? parsed[definition.id]
        : definition.defaultBinding;
      return acc;
    }, {} as ShortcutMap);
  } catch {
    return defaultShortcuts;
  }
}

export function saveShortcuts(shortcuts: ShortcutMap) {
  localStorage.setItem(shortcutsStorageKey, JSON.stringify(shortcuts));
  window.dispatchEvent(
    new CustomEvent<ShortcutMap>(shortcutsChangedEvent, {
      detail: shortcuts,
    })
  );

  void emit(shortcutsChangedEvent, shortcuts).catch(() => {
    /* Non-Tauri environments fall back to localStorage + storage events. */
  });
}

export function resetShortcut(shortcuts: ShortcutMap, actionId: ShortcutActionId) {
  const definition = shortcutDefinitions.find((item) => item.id === actionId);
  if (!definition) return shortcuts;

  return {
    ...shortcuts,
    [actionId]: definition.defaultBinding,
  };
}

function isShortcutBinding(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ShortcutBinding>;

  return (
    typeof candidate.key === "string" &&
    typeof candidate.metaKey === "boolean" &&
    typeof candidate.ctrlKey === "boolean" &&
    typeof candidate.altKey === "boolean" &&
    typeof candidate.shiftKey === "boolean"
  );
}

function normalizeKey(key: string) {
  if (!key || key === "Meta" || key === "Control" || key === "Alt" || key === "Shift") {
    return "";
  }

  return key.length === 1 ? key.toLowerCase() : key;
}

function keyFromEvent(event: KeyboardEvent) {
  if (event.code.startsWith("Key") && event.code.length === 4) {
    return event.code.slice(3).toLowerCase();
  }

  if (event.code.startsWith("Digit") && event.code.length === 6) {
    return event.code.slice(5);
  }

  return normalizeKey(event.key);
}

function formatKey(key: string) {
  if (key === " ") return "Space";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "Escape") return "Esc";
  if (key === "Backspace") return "⌫";
  if (key === "Delete") return "⌦";
  if (key === "Enter") return "↵";

  return key.length === 1 ? key.toUpperCase() : key;
}
