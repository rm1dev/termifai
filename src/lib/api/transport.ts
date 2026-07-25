import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type Event, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

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

/**
 * OS-level file drag-drop over this webview (e.g. dragging files from
 * Finder/Explorer). HTML5 drop events never expose real filesystem paths in
 * Tauri, so this is the only way to receive them. `position` is in PHYSICAL
 * pixels — divide by `window.devicePixelRatio` before hit-testing DOM rects.
 */
export type OsDragDropEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

export function subscribeOsDragDrop(
  handler: (ev: OsDragDropEvent) => void,
): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => handler(e.payload as OsDragDropEvent));
}

export type { Event, UnlistenFn };
