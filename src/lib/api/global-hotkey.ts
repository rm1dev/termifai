import { call } from "./transport";

export type HotkeyBackend = "plugin" | "portal";

export interface HotkeyStatus {
  enabled: boolean;
  accelerator: string;
  backend: HotkeyBackend;
}

export function enableGlobalHotkey(accelerator: string): Promise<HotkeyStatus> {
  return call<HotkeyStatus>("enable_global_hotkey", { accelerator });
}

export function disableGlobalHotkey(): Promise<void> {
  return call<void>("disable_global_hotkey");
}

export function getGlobalHotkeyStatus(): Promise<HotkeyStatus | null> {
  return call<HotkeyStatus | null>("get_global_hotkey_status");
}
