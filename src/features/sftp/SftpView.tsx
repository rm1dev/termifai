import { useCallback, useEffect, useRef, useState } from "react";
import { sftpCall, sftpTransfer } from "@/lib/api/sftp";
import { subscribe } from "@/lib/api/transport";
import {
  File,
  Folder,
  GripVertical,
  HardDrive,
  MoreVertical,
  Search,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AppTab, Host, LocalFileEntry, RemoteFileEntry, TransferProgress } from "@/components/app/types";
import { SftpContextMenu } from "@/components/app/SftpContextMenu";
import { SftpRenameDialog } from "@/components/app/SftpRenameDialog";
import { SftpPermissionsDialog } from "@/components/app/SftpPermissionsDialog";
import { SftpEmptyContextMenu } from "@/components/app/SftpEmptyContextMenu";
import { SftpNewFolderDialog } from "@/components/app/SftpNewFolderDialog";

function SftpConnectingOverlay({
  message, hostTitle, hostLabel, failed, error, onRetry, onChangeHost,
}: {
  message: string;
  hostTitle: string;
  hostLabel: string;
  failed: boolean;
  error: string | null;
  onRetry: () => void;
  onChangeHost: () => void;
}) {
  const accent = failed ? "oklch(0.55 0.18 25)" : "oklch(0.55 0.14 145)";
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background">
      {/* Icon with pulsing glow rings */}
      <div className="relative mb-8 flex items-center justify-center">
        {!failed && (
          <>
            <span
              className="absolute h-24 w-24 animate-ping rounded-full opacity-10"
              style={{ background: accent, animationDuration: "2s" }}
            />
            <span
              className="absolute h-16 w-16 animate-ping rounded-full opacity-15"
              style={{ background: accent, animationDuration: "2s", animationDelay: "0.4s" }}
            />
          </>
        )}
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{
            background: `color-mix(in oklab, ${accent} 18%, var(--color-surface))`,
            border: `1px solid color-mix(in oklab, ${accent} 35%, transparent)`,
            boxShadow: `0 0 32px color-mix(in oklab, ${accent} 20%, transparent)`,
          }}
        >
          <Folder className="h-7 w-7" style={{ color: accent }} />
        </div>
      </div>

      {/* Host info */}
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {hostTitle || "SFTP"}
      </h2>
      {hostLabel && (
        <p className="mt-1 text-xs text-muted-foreground">{hostLabel}</p>
      )}

      {/* Status / error */}
      {!failed ? (
        <p className="mt-6 text-xs text-muted-foreground">{message || "Connecting..."}</p>
      ) : (
        <div className="mt-6 flex w-full max-w-xs flex-col items-center gap-4">
          <p className="text-center text-xs text-red-400">{error}</p>
          <div className="flex w-full gap-2">
            <button
              className="flex-1 rounded-lg border border-border bg-[var(--color-surface-2)] py-2 text-xs font-semibold text-foreground hover:bg-white/5"
              onClick={onRetry}
            >
              Retry
            </button>
            <button
              className="flex-1 rounded-lg border border-border bg-[var(--color-surface-2)] py-2 text-xs font-semibold text-muted-foreground hover:bg-white/5"
              onClick={onChangeHost}
            >
              Change host
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Windows local paths look like "C:\Users\admin\Desktop"; everything else (macOS/Linux) uses "/".
function isWindowsLocalPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path);
}

function getLocalPathRoot(path: string): string {
  return isWindowsLocalPath(path) ? `${path.slice(0, 2)}\\` : "/";
}

function getLocalPathParts(path: string): string[] {
  if (isWindowsLocalPath(path)) {
    return path.slice(2).split(/[\\/]+/).filter(Boolean);
  }
  return path.split("/").filter(Boolean);
}

function joinLocalPath(path: string, parts: string[]): string {
  const sep = isWindowsLocalPath(path) ? "\\" : "/";
  return getLocalPathRoot(path) + parts.join(sep);
}

function isLocalPathAtRoot(path: string): boolean {
  return path === getLocalPathRoot(path);
}

function getLocalParentPath(path: string): string {
  return joinLocalPath(path, getLocalPathParts(path).slice(0, -1));
}

export function SftpView({ tab }: { tab: AppTab }) {
  const [localPath, setLocalPath] = useState("/");
  const [localFiles, setLocalFiles] = useState<LocalFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Rows own the only real scroll area (both axes); the breadcrumb+header strip above them
  // has no scrollbar of its own — its scrollLeft is mirrored from the rows viewport so the
  // two stay in sync horizontally while only the rows scroll vertically.
  const localHeaderRef = useRef<HTMLDivElement>(null);
  const localRowsRootRef = useRef<HTMLDivElement>(null);
  const remoteHeaderRef = useRef<HTMLDivElement>(null);
  const remoteRowsRootRef = useRef<HTMLDivElement>(null);

  const [sftpSessionId] = useState(() => `sftp-${tab.id}-${Date.now()}`);
  const [pickedHostId, setPickedHostId] = useState<string | undefined>(tab.sftpHostId);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [hostQuery, setHostQuery] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  // Start in "connecting" immediately if a host is pre-selected — avoids first-render flash
  const [isConnecting, setIsConnecting] = useState(!!tab.sftpHostId);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectStage, setConnectStage] = useState<"connecting" | "handshaking" | "authenticating" | "ready">("connecting");
  const [connectMessage, setConnectMessage] = useState(tab.sftpHostId ? "Opening TCP connection..." : "");
  const [connectLogs, setConnectLogs] = useState<string[]>([]);
  // Use tab.title so host name shows immediately without waiting for host list load
  const [connectHostTitle, setConnectHostTitle] = useState(tab.sftpHostId ? (tab.title || "SFTP") : "");
  const [connectHostLabel, setConnectHostLabel] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [watchedFile, setWatchedFile] = useState<{ tmpPath: string; remotePath: string; changed: boolean } | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ targets: string[]; isLocal: boolean; label: string } | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<"local" | "remote" | null>(null);

  // Load hosts for picker (only when no host is pre-selected)
  useEffect(() => {
    if (!tab.sftpHostId) {
      sftpCall<{ hosts: Host[] }>("list_hosts")
        .then((v) => setAllHosts(v.hosts))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [lastLocalClick, setLastLocalClick] = useState<string | null>(null);
  const [lastRemoteClick, setLastRemoteClick] = useState<string | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [transferOverall, setTransferOverall] = useState<{ current: number; total: number; fileName: string } | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [localDragOver, setLocalDragOver] = useState(false);
  const [remoteDragOver, setRemoteDragOver] = useState(false);
  const [showHiddenLocal, setShowHiddenLocal] = useState(false);
  const [showHiddenRemote, setShowHiddenRemote] = useState(false);
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const [remoteMenuOpen, setRemoteMenuOpen] = useState(false);
  const [localClipboard, setLocalClipboard] = useState<string[]>([]);
  const [remoteClipboard, setRemoteClipboard] = useState<string[]>([]);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string; isLocal: boolean } | null>(null);
  const [permTarget, setPermTarget] = useState<string | null>(null);
  const [openWithTarget, setOpenWithTarget] = useState<{ path: string; isLocal: boolean } | null>(null);
  const [openWithApp, setOpenWithApp] = useState("");

  // Resizable divider — 50% default
  const [localWidthPct, setLocalWidthPct] = useState(50);
  const paneContainerRef = useRef<HTMLDivElement>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const container = paneContainerRef.current;
    if (!container) return;
    const stripWidth = 48;
    const containerWidth = container.getBoundingClientRect().width - stripWidth;
    const startPct = localWidthPct;

    const onMove = (mv: MouseEvent) => {
      const delta = mv.clientX - startX;
      const newPct = Math.max(20, Math.min(80, startPct + (delta / containerWidth) * 100));
      setLocalWidthPct(newPct);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [localWidthPct]);

  // Listen for progress events
  useEffect(() => {
    if (!isConnected) return;
    const unlisten = subscribe<TransferProgress>(`sftp:${sftpSessionId}:progress`, (event) => {
      setTransferProgress(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isConnected, sftpSessionId]);

  // Listen for file-changed events (remote watch)
  useEffect(() => {
    if (!sftpSessionId) return;
    const unlisten = subscribe<{ tmp_path: string; remote_path: string }>(
      `sftp:${sftpSessionId}:file-changed`,
      (ev) => {
        setWatchedFile({
          tmpPath: ev.payload.tmp_path,
          remotePath: ev.payload.remote_path,
          changed: true,
        });
      }
    );
    return () => { void unlisten.then((fn) => fn()); };
  }, [sftpSessionId]);

  const handleLocalClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && lastLocalClick) {
      const paths = localFiles.map((f) => f.path);
      const a = paths.indexOf(lastLocalClick);
      const b = paths.indexOf(path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedLocal(new Set(paths.slice(lo, hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedLocal((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
    } else {
      if (selectedLocal.size === 1 && selectedLocal.has(path)) {
        setSelectedLocal(new Set());
        setLastLocalClick(null);
        return;
      }
      setSelectedLocal(new Set([path]));
    }
    setLastLocalClick(path);
  };

  const handleRemoteClick = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey && lastRemoteClick) {
      const paths = remoteFiles.map((f) => f.path);
      const a = paths.indexOf(lastRemoteClick);
      const b = paths.indexOf(path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedRemote(new Set(paths.slice(lo, hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedRemote((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
    } else {
      if (selectedRemote.size === 1 && selectedRemote.has(path)) {
        setSelectedRemote(new Set());
        setLastRemoteClick(null);
        return;
      }
      setSelectedRemote(new Set([path]));
    }
    setLastRemoteClick(path);
  };

  const handleDownload = async (paths?: string[]) => {
    const targets = paths ?? [...selectedRemote];
    if (targets.length === 0 || !isConnected) return;
    setTransferError(null);
    setTransferProgress(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        const rp = targets[i];
        const fileName = rp.split("/").pop() ?? "file";
        setTransferOverall({ current: i + 1, total: targets.length, fileName });
        await sftpTransfer(sftpSessionId, "sftp_download", {
          sessionId: sftpSessionId,
          remotePath: rp,
          localPath: joinLocalPath(localPath, [...getLocalPathParts(localPath), fileName]),
        });
      }
      await loadLocalDir(localPath);
    } catch (e) {
      if (!String(e).includes("Cancelled")) {
        setTransferError(String(e));
      } else {
        setTransferOverall(null);
        setTransferProgress(null);
      }
    } finally {
      setTransferProgress(null);
      setTransferOverall(null);
    }
  };

  const handleUpload = async (paths?: string[]) => {
    const targets = paths ?? [...selectedLocal];
    if (targets.length === 0 || !isConnected) return;
    setTransferError(null);
    setTransferProgress(null);
    try {
      for (let i = 0; i < targets.length; i++) {
        const lp = targets[i];
        const fileName = lp.split("/").pop() ?? "file";
        setTransferOverall({ current: i + 1, total: targets.length, fileName });
        await sftpTransfer(sftpSessionId, "sftp_upload", {
          sessionId: sftpSessionId,
          localPath: lp,
          remotePath: `${remotePath}/${fileName}`,
        });
      }
      await loadRemoteDir(remotePath);
    } catch (e) {
      if (!String(e).includes("Cancelled")) {
        setTransferError(String(e));
      } else {
        setTransferOverall(null);
        setTransferProgress(null);
      }
    } finally {
      setTransferProgress(null);
      setTransferOverall(null);
    }
  };

  const handleOpenLocal = (path: string) => {
    void sftpCall("sftp_open_local", { path });
  };

  const handleOpenWithLocal = (path: string, app: string) => {
    void sftpCall("sftp_open_with_local", { path, app });
  };

  const handleOpenRemote = async (path: string) => {
    const tmpPath = await sftpCall<string>("sftp_open_remote", { sessionId: sftpSessionId, remotePath: path });
    await sftpCall("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath, remotePath: path });
  };

  const handleCopyLocal = (paths: string[]) => setLocalClipboard(paths);
  const handlePasteLocal = () => {
    if (!localClipboard.length) return;
    void sftpCall("sftp_copy_local", { paths: localClipboard, destDir: localPath })
      .then(() => loadLocalDir(localPath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleCopyRemote = (paths: string[]) => setRemoteClipboard(paths);
  const handlePasteRemote = () => {
    if (!remoteClipboard.length || !remotePath) return;
    void sftpCall("sftp_copy_remote", { sessionId: sftpSessionId, paths: remoteClipboard, destDir: remotePath })
      .then(() => loadRemoteDir(remotePath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleDeleteLocal = (paths: string[]) => {
    void sftpCall("sftp_delete_local", { paths })
      .then(() => loadLocalDir(localPath))
      .catch((e: unknown) => toast.error(String(e)));
  };

  const handleRenameConfirm = async (newName: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.isLocal) {
        await sftpCall("sftp_rename_local", { path: renameTarget.path, newName });
        await loadLocalDir(localPath);
      } else {
        const dir = renameTarget.path.substring(0, renameTarget.path.lastIndexOf("/")) || "/";
        await sftpCall("sftp_rename_remote", {
          sessionId: sftpSessionId,
          fromPath: renameTarget.path,
          toPath: `${dir}/${newName}`,
        });
        if (remotePath) await loadRemoteDir(remotePath);
      }
    } catch (e) { toast.error(String(e)); }
    setRenameTarget(null);
  };

  const connectCleanupRef = useRef<(() => void) | null>(null);

  const performDisconnect = () => {
    void sftpCall("sftp_disconnect", { sessionId: sftpSessionId }).catch(() => {});
    setIsConnected(false);
    setPickedHostId(undefined);
    setConnectError(null);
    setRemoteFiles([]);
    sftpCall<{ hosts: Host[] }>("list_hosts").then((v) => setAllHosts(v.hosts)).catch(() => {});
  };

  const handleConnect = async (hostId?: string, hostObj?: Host) => {
    const targetHostId = hostId ?? pickedHostId;
    if (!targetHostId) return;
    if (hostId) setPickedHostId(hostId);

    const resolvedHost = hostObj ?? allHosts.find((h) => h.id === targetHostId);
    setConnectHostTitle(resolvedHost?.name || resolvedHost?.hostname || "SFTP");
    setConnectHostLabel(resolvedHost ? `${resolvedHost.user}@${resolvedHost.hostname}:${resolvedHost.port}` : "");

    setIsConnecting(true);
    setConnectError(null);
    setConnectMessage("Connecting...");
    setConnectLogs([]);

    // Subscribe to progress + done events before firing the command
    const [unlistenProgress, unlistenDone] = await Promise.all([
      subscribe<{ stage: string; message: string }>(`sftp:${sftpSessionId}:connect`, (ev) => {
        setConnectMessage(ev.payload.message);
      }),
      subscribe<{ ok: boolean; remote_path?: string; error?: string }>(`sftp:${sftpSessionId}:done`, async (ev) => {
        connectCleanupRef.current?.();
        connectCleanupRef.current = null;
        if (ev.payload.ok && ev.payload.remote_path) {
          setIsConnected(true);
          await loadRemoteDir(ev.payload.remote_path);
        } else {
          setConnectError(ev.payload.error ?? "Connection failed");
        }
        setIsConnecting(false);
      }),
    ]);

    const cleanup = () => { unlistenProgress(); unlistenDone(); };
    connectCleanupRef.current = cleanup;

    // Command returns immediately — actual connection runs in Rust background thread
    try {
      await sftpCall("sftp_connect_from_host", { hostId: targetHostId, sessionId: sftpSessionId });
    } catch (e) {
      // Only fires if credential resolution fails (before background spawn)
      cleanup();
      connectCleanupRef.current = null;
      setConnectError(String(e));
      setIsConnecting(false);
    }
  };

  const loadRemoteDir = async (path: string) => {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const files = await sftpCall<RemoteFileEntry[]>("sftp_list_remote", {
        sessionId: sftpSessionId,
        path,
      });
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (e) {
      setRemoteError(String(e));
    } finally {
      setRemoteLoading(false);
    }
  };

  // Auto-connect on mount if hostId is pre-set
  useEffect(() => {
    if (tab.sftpHostId && !isConnected) {
      void handleConnect();
    }
    return () => {
      connectCleanupRef.current?.();
      connectCleanupRef.current = null;
      void sftpCall("sftp_disconnect", { sessionId: sftpSessionId }).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLocalDir = async (path: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const files = await sftpCall<LocalFileEntry[]>("sftp_list_local", { path });
      setLocalFiles(files);
      setLocalPath(path);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  };

  useEffect(() => {
    sftpCall<string>("get_home_dir")
      .then((home) => loadLocalDir(home))
      .catch(() => loadLocalDir(localPath));
  }, []); // load on mount

  const localParent = getLocalParentPath(localPath);
  const localPathParts = getLocalPathParts(localPath);

  // Mirror the rows' horizontal scroll position onto the (non-scrolling) breadcrumb+header
  // strip above them, so the two stay in sync without nesting a second ScrollArea (nesting
  // broke flex-1 height sizing — Radix's Viewport wraps children in a `display:table` div,
  // which isn't a flex container, so the inner rows ScrollArea could no longer fill its
  // parent's remaining height and vertical scrolling stopped working).
  useEffect(() => {
    const viewport = localRowsRootRef.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    const header = localHeaderRef.current;
    if (!viewport || !header) return;
    const onScroll = () => { header.scrollLeft = viewport.scrollLeft; };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const viewport = remoteRowsRootRef.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    const header = remoteHeaderRef.current;
    if (!viewport || !header) return;
    const onScroll = () => { header.scrollLeft = viewport.scrollLeft; };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [isConnected]);

  // Reset to the start (Name column visible) whenever the path changes, rather than
  // keeping whatever horizontal scroll offset was left over from the previous folder.
  useEffect(() => {
    const viewport = localRowsRootRef.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    if (viewport) viewport.scrollLeft = 0;
    if (localHeaderRef.current) localHeaderRef.current.scrollLeft = 0;
  }, [localPath]);

  useEffect(() => {
    const viewport = remoteRowsRootRef.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    if (viewport) viewport.scrollLeft = 0;
    if (remoteHeaderRef.current) remoteHeaderRef.current.scrollLeft = 0;
  }, [remotePath]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Transfer progress — fixed bottom sheet, does not affect layout */}
      {(transferOverall || transferError) && (
        <div className="fixed bottom-0 left-0 right-0 z-40 flex h-12 items-center gap-3 border-t border-border bg-[var(--color-surface-2)] px-4 text-xs shadow-[0_-4px_24px_rgba(0,0,0,0.3)]">
          {transferError ? (
            <span className="text-red-400">{transferError}</span>
          ) : transferOverall ? (() => {
            const filePct = transferProgress && transferProgress.total_bytes > 0
              ? transferProgress.bytes_transferred / transferProgress.total_bytes
              : 0;
            const overallPct = transferOverall.total > 1
              ? ((transferOverall.current - 1 + filePct) / transferOverall.total) * 100
              : filePct * 100;
            return (
              <>
                {transferOverall.total > 1 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {transferOverall.current}/{transferOverall.total}
                  </span>
                )}
                <span className="min-w-0 truncate text-muted-foreground">{transferOverall.fileName}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-[var(--color-brand-cyan)] transition-all"
                    style={{ width: `${Math.round(overallPct)}%` }}
                  />
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {Math.round(overallPct)}%
                </span>
                <button
                  className="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void sftpCall("sftp_cancel_transfer", { sessionId: sftpSessionId })}
                >
                  Cancel
                </button>
              </>
            );
          })() : null}
        </div>
      )}
      <div ref={paneContainerRef} className="flex min-h-0 flex-1">
      {/* Local pane */}
      <div
        className={`flex flex-col border-r border-border overflow-hidden transition-colors ${localDragOver ? "bg-[var(--color-brand-cyan)]/5" : ""}`}
        style={{ width: `${localWidthPct}%` }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setLocalDragOver(true); }}
        onDragLeave={() => setLocalDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setLocalDragOver(false);
          const data = e.dataTransfer.getData("application/x-sftp-remote");
          if (data) {
            const paths: string[] = JSON.parse(data);
            void handleDownload(paths);
          }
        }}
      >
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-[oklch(0.55_0.18_230)]">
              <Folder className="h-3 w-3 text-white" />
            </span>
            Local
          </div>
          <div className="relative">
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
              onClick={() => setLocalMenuOpen((v) => !v)}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
            {localMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setLocalMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <button
                    className="flex w-full items-center justify-between px-3 py-2 text-xs text-foreground hover:bg-[var(--color-surface)]"
                    onClick={() => { setShowHiddenLocal((v) => !v); setLocalMenuOpen(false); }}
                  >
                    Show hidden files
                    <span className={`h-3.5 w-3.5 rounded border ${showHiddenLocal ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]" : "border-border"}`} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Breadcrumb + column headers stay pinned above the file list; their scrollLeft is
            mirrored from the rows ScrollArea (see the sync effect above) so they visually track
            its horizontal position without needing a scrollbar of their own. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={localHeaderRef} className="overflow-hidden">
            <div className="flex min-w-[560px] items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
              <button
                className="hover:text-foreground"
                onClick={() => void loadLocalDir(getLocalPathRoot(localPath))}
              >
                <HardDrive className="h-3.5 w-3.5" />
              </button>
              {localPathParts.map((part, i) => {
                const partPath = joinLocalPath(localPath, localPathParts.slice(0, i + 1));
                return (
                  <span key={partPath} className="flex items-center gap-1">
                    <span className="opacity-40">›</span>
                    <button
                      className="hover:text-foreground"
                      onClick={() => void loadLocalDir(partPath)}
                    >
                      {part}
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>
            </div>
          </div>
          <SftpEmptyContextMenu
            onNewFolder={() => setNewFolderTarget("local")}
            onRefresh={() => void loadLocalDir(localPath)}
          >
          <ScrollArea ref={localRowsRootRef} orientation="both" className="min-w-0 flex-1" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedLocal(new Set()); setLastLocalClick(null); } }}>
            {localLoading && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
            )}
            {localError && (
              <div className="px-4 py-8 text-center text-sm text-red-400">{localError}</div>
            )}
            {!localLoading && !localError && (
              <>
                {!isLocalPathAtRoot(localPath) && (
                  <div
                    className="grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] cursor-pointer items-center px-4 py-2 text-sm hover:bg-[var(--color-surface)]"
                    onDoubleClick={() => void loadLocalDir(localParent)}
                  >
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Folder className="h-4 w-4 text-[oklch(0.7_0.13_230)]" />
                      ..
                    </div>
                    <div /><div /><div />
                  </div>
                )}
                {localFiles.filter((f) => showHiddenLocal || !f.name.startsWith(".")).map((f) => (
                  <SftpContextMenu
                    key={f.path}
                    isLocal={true}
                    isConnected={isConnected}
                    file={f}
                    hasClipboard={localClipboard.length > 0}
                    onOpen={() => handleOpenLocal(f.path)}
                    onOpenWith={() => setOpenWithTarget({ path: f.path, isLocal: true })}
                    onDownload={() => {}}
                    onUpload={() => void handleUpload(selectedLocal.has(f.path) ? [...selectedLocal] : [f.path])}
                    onCopy={() => handleCopyLocal(selectedLocal.size > 0 ? [...selectedLocal] : [f.path])}
                    onPaste={handlePasteLocal}
                    onRename={() => setRenameTarget({ path: f.path, name: f.name, isLocal: true })}
                    onDelete={() => {
                      const targets = selectedLocal.has(f.path) ? [...selectedLocal] : [f.path];
                      const allEntries = localFiles;
                      const label = targets.length === 1
                        ? (allEntries.find((e) => e.path === targets[0])?.name ?? targets[0])
                        : (() => {
                            const dirs = targets.filter((p) => allEntries.find((e) => e.path === p)?.is_dir).length;
                            const files = targets.length - dirs;
                            const parts = [];
                            if (files > 0) parts.push(`${files} file${files > 1 ? "s" : ""}`);
                            if (dirs > 0) parts.push(`${dirs} folder${dirs > 1 ? "s" : ""}`);
                            return parts.join(" and ");
                          })();
                      setTimeout(() => setDeleteConfirm({ targets, isLocal: true, label }), 0);
                    }}
                    onRefresh={() => void loadLocalDir(localPath)}
                    onEditPermissions={() => {}}
                  >
                  <div
                    draggable={!f.is_dir}
                    onDragStart={(e) => {
                      const toDrag = selectedLocal.has(f.path) ? [...selectedLocal].filter((p) => !localFiles.find((lf) => lf.path === p)?.is_dir) : [f.path];
                      e.dataTransfer.setData("application/x-sftp-local", JSON.stringify(toDrag));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className={`grid min-w-[560px] grid-cols-[1fr_180px_100px_80px] cursor-pointer items-center px-4 py-2 text-sm ${
                      selectedLocal.has(f.path)
                        ? "bg-[var(--color-brand-cyan)]/10 ring-1 ring-inset ring-[var(--color-brand-cyan)]/20"
                        : "hover:bg-[var(--color-surface)]"
                    }`}
                    onClick={(e) => handleLocalClick(e, f.path)}
                    onDoubleClick={() => {
                      if (f.is_dir) void loadLocalDir(f.path);
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-foreground">
                      {f.is_dir
                        ? <Folder className="h-4 w-4 shrink-0 text-[oklch(0.7_0.13_230)]" />
                        : <File   className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      {f.name}
                    </div>
                    <div className="text-xs text-muted-foreground">{f.modified ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {f.size != null ? formatBytes(f.size) : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{f.is_dir ? "folder" : "file"}</div>
                  </div>
                  </SftpContextMenu>
                ))}
              </>
            )}
          </ScrollArea>
          </SftpEmptyContextMenu>
        </div>
      </div>

      {/* Resizable divider */}
      <div
        className="flex w-6 flex-shrink-0 cursor-col-resize items-center justify-center border-r border-border bg-[var(--color-surface)] select-none"
        onMouseDown={onDividerMouseDown}
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      {/* Remote pane */}
      <div
        className={`flex flex-col overflow-hidden transition-colors ${remoteDragOver ? "bg-[oklch(0.45_0.12_145)]/5" : ""}`}
        style={{ width: `calc(100% - ${localWidthPct}% - 24px)` }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setRemoteDragOver(true); }}
        onDragLeave={() => setRemoteDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRemoteDragOver(false);
          const data = e.dataTransfer.getData("application/x-sftp-local");
          if (data) {
            const paths: string[] = JSON.parse(data);
            void handleUpload(paths);
          }
        }}
      >
        <div className="flex h-11 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-[oklch(0.45_0.12_145)]">
              <Folder className="h-3 w-3 text-white" />
            </span>
            Remote
          </div>
          <div className="flex items-center gap-2">
            {isConnected && (
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  if (transferOverall !== null) {
                    setShowDisconnectConfirm(true);
                  } else {
                    performDisconnect();
                  }
                }}
              >
                Disconnect
              </button>
            )}
            <div className="relative">
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground"
                onClick={() => setRemoteMenuOpen((v) => !v)}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {remoteMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRemoteMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                    <button
                      className="flex w-full items-center justify-between px-3 py-2 text-xs text-foreground hover:bg-[var(--color-surface)]"
                      onClick={() => { setShowHiddenRemote((v) => !v); setRemoteMenuOpen(false); }}
                    >
                      Show hidden files
                      <span className={`h-3.5 w-3.5 rounded border ${showHiddenRemote ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]" : "border-border"}`} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Not connected — host picker (no host selected yet) */}
        {!isConnected && !isConnecting && !pickedHostId && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <p className="mb-2 text-xs text-muted-foreground">Select a host to connect</p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  placeholder="Search hosts..."
                  value={hostQuery}
                  onChange={(e) => setHostQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {allHosts.length === 0 && (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">No saved hosts</div>
              )}
              {allHosts
                .filter((h) => {
                  const q = hostQuery.toLowerCase();
                  return !q || h.name.toLowerCase().includes(q) || h.hostname.toLowerCase().includes(q) || h.user.toLowerCase().includes(q);
                })
                .map((h) => (
                  <button
                    key={h.id}
                    className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-[var(--color-surface)]"
                    onClick={() => void handleConnect(h.id, h)}
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[var(--color-surface-2)]">
                      <Server className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{h.name || h.hostname}</div>
                      <div className="truncate text-xs text-muted-foreground">{h.user}@{h.hostname}:{h.port}</div>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Connecting — XTerminal-style step indicator */}
        {(isConnecting || (!isConnected && pickedHostId)) && <SftpConnectingOverlay
          message={connectMessage}
          hostTitle={connectHostTitle}
          hostLabel={connectHostLabel}
          failed={!isConnecting && !!connectError}
          error={connectError}
          onRetry={() => void handleConnect()}
          onChangeHost={() => { setPickedHostId(undefined); setConnectError(null); setConnectLogs([]); }}
        />}

        {/* Connected file browser */}
        {isConnected && (
          <>
            {/* Breadcrumb + column headers stay pinned above the file list; their scrollLeft is
                mirrored from the rows ScrollArea (see the sync effect above) so they visually
                track its horizontal position without needing a scrollbar of their own. */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div ref={remoteHeaderRef} className="overflow-hidden">
                <div className="flex min-w-[500px] items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  <button className="hover:text-foreground" onClick={() => void loadRemoteDir("/")}>
                    <HardDrive className="h-3.5 w-3.5" />
                  </button>
                  {remotePath.split("/").filter(Boolean).map((part, i, arr) => {
                    const partPath = "/" + arr.slice(0, i + 1).join("/");
                    return (
                      <span key={partPath} className="flex items-center gap-1">
                        <span className="opacity-40">›</span>
                        <button className="hover:text-foreground" onClick={() => void loadRemoteDir(partPath)}>
                          {part}
                        </button>
                      </span>
                    );
                  })}
                </div>
                <div className="grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span>
                </div>
              </div>
              <SftpEmptyContextMenu
                onNewFolder={() => setNewFolderTarget("remote")}
                onRefresh={() => remotePath && void loadRemoteDir(remotePath)}
              >
              <ScrollArea ref={remoteRowsRootRef} orientation="both" className="min-w-0 flex-1" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedRemote(new Set()); setLastRemoteClick(null); } }}>
                {remoteLoading && (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
                )}
                {remoteError && (
                  <div className="px-4 py-8 text-center text-sm text-red-400">{remoteError}</div>
                )}
                {!remoteLoading && !remoteError && (
                  <>
                    {remotePath !== "/" && (
                      <div
                        className="grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] cursor-pointer items-center px-4 py-2 text-sm hover:bg-[var(--color-surface)]"
                        onDoubleClick={() => {
                          const parent = remotePath.split("/").slice(0, -1).join("/") || "/";
                          void loadRemoteDir(parent);
                        }}
                      >
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Folder className="h-4 w-4 text-[oklch(0.65_0.12_145)]" />
                          ..
                        </div>
                        <div /><div /><div />
                      </div>
                    )}
                    {remoteFiles.filter((f) => showHiddenRemote || !f.name.startsWith(".")).map((f) => (
                      <SftpContextMenu
                        key={f.path}
                        isLocal={false}
                        isConnected={isConnected}
                        file={f}
                        hasClipboard={remoteClipboard.length > 0}
                        onOpen={() => void handleOpenRemote(f.path).catch((e: unknown) => toast.error(String(e)))}
                        onOpenWith={() => setOpenWithTarget({ path: f.path, isLocal: false })}
                        onDownload={() => void handleDownload(selectedRemote.has(f.path) ? [...selectedRemote] : [f.path])}
                        onUpload={() => {}}
                        onCopy={() => handleCopyRemote(selectedRemote.size > 0 ? [...selectedRemote] : [f.path])}
                        onPaste={handlePasteRemote}
                        onRename={() => setRenameTarget({ path: f.path, name: f.name, isLocal: false })}
                        onDelete={() => {
                          const targets = selectedRemote.has(f.path) ? [...selectedRemote] : [f.path];
                          const allEntries = remoteFiles;
                          const label = targets.length === 1
                            ? (allEntries.find((e) => e.path === targets[0])?.name ?? targets[0])
                            : (() => {
                                const dirs = targets.filter((p) => allEntries.find((e) => e.path === p)?.is_dir).length;
                                const files = targets.length - dirs;
                                const parts = [];
                                if (files > 0) parts.push(`${files} file${files > 1 ? "s" : ""}`);
                                if (dirs > 0) parts.push(`${dirs} folder${dirs > 1 ? "s" : ""}`);
                                return parts.join(" and ");
                              })();
                          setTimeout(() => setDeleteConfirm({ targets, isLocal: false, label }), 0);
                        }}
                        onRefresh={() => remotePath && void loadRemoteDir(remotePath)}
                        onEditPermissions={() => setPermTarget(f.path)}
                      >
                      <div
                        draggable={!f.is_dir}
                        onDragStart={(e) => {
                          const toDrag = selectedRemote.has(f.path) ? [...selectedRemote].filter((p) => !remoteFiles.find((rf) => rf.path === p)?.is_dir) : [f.path];
                          e.dataTransfer.setData("application/x-sftp-remote", JSON.stringify(toDrag));
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        className={`grid min-w-[500px] grid-cols-[1fr_160px_90px_70px] cursor-pointer items-center px-4 py-2 text-sm ${
                          selectedRemote.has(f.path)
                            ? "bg-[oklch(0.45_0.12_145)]/10 ring-1 ring-inset ring-[oklch(0.45_0.12_145)]/20"
                            : "hover:bg-[var(--color-surface)]"
                        }`}
                        onClick={(e) => handleRemoteClick(e, f.path)}
                        onDoubleClick={() => {
                          if (f.is_dir) void loadRemoteDir(f.path);
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-foreground">
                          {f.is_dir
                            ? <Folder className="h-4 w-4 shrink-0 text-[oklch(0.65_0.12_145)]" />
                            : <File   className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          {f.name}
                          {f.is_symlink && <span className="text-[10px] text-muted-foreground">→</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{f.modified ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {f.size != null ? formatBytes(f.size) : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {f.is_symlink ? "symlink" : f.is_dir ? "folder" : "file"}
                        </div>
                      </div>
                      </SftpContextMenu>
                    ))}
                  </>
                )}
              </ScrollArea>
              </SftpEmptyContextMenu>
            </div>
          </>
        )}

        {/* Remote file watch bar */}
        {watchedFile?.changed && (
          <div className="flex h-10 flex-shrink-0 items-center justify-between border-t border-border bg-[var(--color-surface)] px-4">
            <span className="text-xs text-muted-foreground">
              <span className="mr-1 text-foreground">{watchedFile.remotePath.split("/").pop()}</span>
              was modified locally
            </span>
            <div className="flex gap-2">
              <button
                className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void sftpCall("sftp_stop_watch", { tmpPath: watchedFile.tmpPath });
                  setWatchedFile(null);
                }}
              >
                Reject
              </button>
              <button
                className="rounded bg-[oklch(0.45_0.12_145)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[oklch(0.5_0.12_145)]"
                onClick={async () => {
                  try {
                    await sftpTransfer(sftpSessionId, "sftp_upload", {
                      sessionId: sftpSessionId,
                      localPath: watchedFile.tmpPath,
                      remotePath: watchedFile.remotePath,
                    });
                    await sftpCall("sftp_stop_watch", { tmpPath: watchedFile.tmpPath });
                    setWatchedFile(null);
                    if (remotePath) await loadRemoteDir(remotePath);
                  } catch (e) { toast.error(String(e)); }
                }}
              >
                Upload
              </button>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* Rename dialog */}
      <SftpRenameDialog
        open={renameTarget !== null}
        currentName={renameTarget?.name ?? ""}
        onConfirm={(n) => void handleRenameConfirm(n)}
        onClose={() => setRenameTarget(null)}
      />

      {/* Edit Permissions dialog */}
      <SftpPermissionsDialog
        open={permTarget !== null}
        sessionId={sftpSessionId}
        path={permTarget ?? ""}
        onClose={() => setPermTarget(null)}
      />

      {/* Open With dialog */}
      {openWithTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-xl border border-border bg-[var(--color-surface)] p-5 shadow-xl">
            <p className="mb-3 text-sm font-semibold text-foreground">Open With</p>
            <input
              autoFocus
              placeholder="App name or path…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)]"
              value={openWithApp}
              onChange={(e) => setOpenWithApp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && openWithApp.trim()) {
                  if (openWithTarget.isLocal) handleOpenWithLocal(openWithTarget.path, openWithApp.trim());
                  else void sftpCall("sftp_open_remote", { sessionId: sftpSessionId, remotePath: openWithTarget.path })
                    .then((tmp) => sftpCall("sftp_open_with_local", { path: tmp as string, app: openWithApp.trim() }).then(() => tmp))
                    .then((tmp) => sftpCall("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath: tmp as string, remotePath: openWithTarget.path }))
                    .catch((e: unknown) => toast.error(String(e)));
                  setOpenWithTarget(null);
                  setOpenWithApp("");
                }
                if (e.key === "Escape") { setOpenWithTarget(null); setOpenWithApp(""); }
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setOpenWithTarget(null); setOpenWithApp(""); }}>Cancel</button>
              <button
                className="rounded bg-[var(--color-brand-cyan)] px-3 py-1.5 text-xs font-medium text-black"
                onClick={() => {
                  if (openWithApp.trim()) {
                    if (openWithTarget.isLocal) {
                      handleOpenWithLocal(openWithTarget.path, openWithApp.trim());
                    } else {
                      const app = openWithApp.trim();
                      const target = openWithTarget;
                      sftpCall<string>("sftp_open_remote", { sessionId: sftpSessionId, remotePath: target.path })
                        .then((tmp) => sftpCall("sftp_open_with_local", { path: tmp, app }).then(() => tmp))
                        .then((tmp) => sftpCall("sftp_watch_remote", { sessionId: sftpSessionId, tmpPath: tmp as string, remotePath: target.path }))
                        .catch((e: unknown) => toast.error(String(e)));
                    }
                  }
                  setOpenWithTarget(null); setOpenWithApp("");
                }}
              >Open</button>
            </div>
          </div>
        </div>
      )}

      {/* New folder dialog */}
      <SftpNewFolderDialog
        open={newFolderTarget !== null}
        onConfirm={(name) => {
          if (newFolderTarget === "local") {
            void sftpCall("sftp_mkdir_local", { path: joinLocalPath(localPath, [...getLocalPathParts(localPath), name]) })
              .then(() => loadLocalDir(localPath))
              .catch((e: unknown) => toast.error(String(e)));
          } else if (newFolderTarget === "remote" && remotePath) {
            void sftpCall("sftp_mkdir_remote", { sessionId: sftpSessionId, path: `${remotePath}/${name}` })
              .then(() => loadRemoteDir(remotePath))
              .catch((e: unknown) => toast.error(String(e)));
          }
        }}
        onClose={() => setNewFolderTarget(null)}
      />

      {/* Disconnect-during-transfer confirmation */}
      <AlertDialog.Root open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-[var(--color-surface-2)] p-5 shadow-xl">
            <AlertDialog.Title className="text-sm font-medium text-foreground">Delete</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
              {deleteConfirm && deleteConfirm.targets.length === 1
                ? <>Are you sure you want to delete <span className="font-medium text-foreground">"{deleteConfirm.label}"</span>? This action cannot be undone.</>
                : <>Are you sure you want to delete <span className="font-medium text-foreground">{deleteConfirm?.label}</span>? This action cannot be undone.</>
              }
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
                  onClick={() => {
                    if (!deleteConfirm) return;
                    if (deleteConfirm.isLocal) {
                      handleDeleteLocal(deleteConfirm.targets);
                    } else {
                      void sftpCall("sftp_delete_remote", { sessionId: sftpSessionId, paths: deleteConfirm.targets })
                        .then(() => {
                          if (remotePath) loadRemoteDir(remotePath);
                        })
                        .catch((e: unknown) => toast.error(String(e)));
                    }
                    setDeleteConfirm(null);
                  }}
                >
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={showDisconnectConfirm} onOpenChange={setShowDisconnectConfirm}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-[var(--color-surface-2)] p-5 shadow-xl">
            <AlertDialog.Title className="text-sm font-medium text-foreground">Transfer in progress</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
              Cancelling will interrupt the current transfer. This may leave a partial file on the remote server.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                  Keep transferring
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
                  onClick={() => {
                    void sftpCall("sftp_cancel_transfer", { sessionId: sftpSessionId });
                    setShowDisconnectConfirm(false);
                    performDisconnect();
                  }}
                >
                  Cancel transfer &amp; disconnect
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

