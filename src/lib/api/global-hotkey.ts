import { call } from "./transport";

export type HotkeyBackend = "service";
export type HotkeyAction = "main-window" | "quick-terminal";

export interface HotkeyStatus {
  enabled: boolean;
  accelerator: string;
  backend: HotkeyBackend;
}

export function enableGlobalHotkey(
  action: HotkeyAction,
  accelerator: string,
): Promise<HotkeyStatus> {
  return call<HotkeyStatus>("enable_global_hotkey", { action, accelerator });
}

export function disableGlobalHotkey(action: HotkeyAction): Promise<void> {
  return call<void>("disable_global_hotkey", { action });
}

export function getGlobalHotkeyStatus(): Promise<Partial<Record<HotkeyAction, HotkeyStatus>>> {
  return call<Partial<Record<HotkeyAction, HotkeyStatus>>>("get_global_hotkey_status");
}
