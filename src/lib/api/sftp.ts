import { call, subscribe } from "./transport";

/** Generic typed call into any `sftp_*` (or related) Tauri command. */
export function sftpCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return call<T>(cmd, args);
}

/**
 * Runs a transfer command (`sftp_download` / `sftp_upload`) and resolves once
 * the backend emits `sftp:{sessionId}:transfer-done` for that session, mirroring
 * the progress events dispatched separately during the transfer.
 */
export async function sftpTransfer(
  sessionId: string,
  command: string,
  args: Record<string, string>,
): Promise<void> {
  let unlisten: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      subscribe<{ ok: boolean; error?: string }>(
        `sftp:${sessionId}:transfer-done`,
        (ev) => {
          unlisten?.();
          if (ev.payload.ok) resolve();
          else reject(new Error(ev.payload.error ?? "Transfer failed"));
        },
      )
        .then((fn) => {
          unlisten = fn;
          return sftpCall(command, args);
        })
        .catch((e: unknown) => {
          unlisten?.();
          reject(e);
        });
    });
  } finally {
    unlisten?.();
  }
}
