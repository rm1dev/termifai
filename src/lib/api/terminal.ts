import { call, subscribe, type UnlistenFn } from "./transport";

export interface CreateSessionRequest {
  cwd: string;
  initialCommand: string | null;
  hostId: string | null;
  readyMarker: string | null;
}

export interface SessionInfo {
  id: string;
  label: string;
}

export function createSession(request: CreateSessionRequest): Promise<SessionInfo> {
  return call<SessionInfo>("create_session", { ...request });
}

export function writeToSession(sessionId: string, data: string): Promise<void> {
  return call<void>("write_to_session", { sessionId, data });
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return call<void>("resize_session", { sessionId, cols, rows });
}

export function closeSession(sessionId: string): Promise<void> {
  return call<void>("close_session", { sessionId });
}

export function runSnippetScript(
  sessionId: string,
  title: string,
  script: string,
): Promise<void> {
  return call<void>("run_snippet_script", { sessionId, title, script });
}

/** `T` is left to the caller since each window defines its own connection-stage/status unions. */
export function onConnectionStatus<T>(
  readyMarker: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return subscribe<T>(`term:${readyMarker}:connection-status`, (event) => handler(event.payload));
}

export function onSessionOutput(
  sessionId: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return subscribe<string>(`term:${sessionId}:output`, (event) => handler(event.payload));
}

export function onSessionExited(sessionId: string, handler: () => void): Promise<UnlistenFn> {
  return subscribe<boolean>(`term:${sessionId}:exited`, () => handler());
}

export function openSettingsWindow(): Promise<void> {
  return call<void>("open_settings_window");
}

export function quitApp(): Promise<void> {
  return call<void>("quit_app");
}

export interface GeneralSettings {
  runInBackground: boolean;
}

export function getGeneralSettings(): Promise<GeneralSettings> {
  return call<GeneralSettings>("get_general_settings");
}

export function setGeneralSettings(settings: GeneralSettings): Promise<void> {
  return call<void>("set_general_settings", { settings });
}

export function isAutostartEnabled(): Promise<boolean> {
  return call<boolean>("is_autostart_enabled");
}

export function setAutostartEnabled(enabled: boolean): Promise<void> {
  return call<void>("set_autostart_enabled", { enabled });
}

export function forceQuitApp(): Promise<void> {
  return call<void>("force_quit_app");
}
