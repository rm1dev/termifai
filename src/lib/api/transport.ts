import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type Event, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The only module allowed to import `@tauri-apps/api` directly. Every other
 * module — API wrappers, features, components — goes through `call`,
 * `subscribe`, and `publish` so that swapping the desktop IPC transport for a
 * different one (e.g. a WebSocket bridge for a future web/mobile build) only
 * requires reimplementing this file.
 */

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export function subscribe<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}

export function publish<T>(event: string, payload?: T): Promise<void> {
  return emit(event, payload);
}

export type { Event, UnlistenFn };
