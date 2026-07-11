import { useCallback, useEffect, useRef, useState } from "react";
import { sftpCall, sftpTransfer } from "@/lib/api/sftp";
import { subscribe, subscribeOsDragDrop } from "@/lib/api/transport";
import {
  ChevronRight,
  Download,
  File,
  Folder,
  GripVertical,
  HardDrive,
  MoreVertical,
  Search,
  Server,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AppTab, Host, HostGroup, LocalFileEntry, RemoteFileEntry, TransferProgress, SftpConflictInfo } from "@/components/app/types";
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

function SftpDropOverlay({ label, accent, icon: Icon, domRef }: {
  label: string;
  accent: string;
  icon: typeof Download;
  domRef?: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={domRef}
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 backdrop-blur-[2px] transition-all duration-300 opacity-0"
      style={{
        background: `color-mix(in oklab, ${accent} 6%, rgba(15, 23, 42, 0.25))`,
        transform: "scale(0.95)",
      }}
    >
      {/* Outer dashed border container */}
      <div
        className="absolute inset-4 rounded-xl border-2 border-dashed transition-all duration-300"
        style={{
          borderColor: `color-mix(in oklab, ${accent} 40%, transparent)`,
        }}
      />
      
      {/* Central Glassmorphic Card */}
      <div
        className="relative flex flex-col items-center gap-4 rounded-2xl border px-10 py-8 shadow-2xl transition-all duration-300"
        style={{
          borderColor: `color-mix(in oklab, ${accent} 30%, rgba(255, 255, 255, 0.08))`,
          background: "rgba(30, 41, 59, 0.75)",
          boxShadow: `0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px color-mix(in oklab, ${accent} 15%, transparent)`,
        }}
      >
        {/* Pulsing Icon Wrapper */}
        <div
          className="relative flex h-16 w-16 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in oklab, ${accent} 15%, rgba(255, 255, 255, 0.03))`,
            border: `1px solid color-mix(in oklab, ${accent} 30%, transparent)`,
          }}
        >
          {/* Pulsing glow ring */}
          <div
            className="absolute inset-0 animate-ping rounded-full opacity-30"
            style={{
              background: accent,
              animationDuration: "2s",
            }}
          />
          <Icon className="relative h-7 w-7" style={{ color: accent }} />
        </div>

        {/* Text Details */}
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-sm font-semibold tracking-wide text-foreground uppercase">
            {label}
          </span>
          <span className="text-[10px] tracking-wide text-muted-foreground uppercase opacity-80">
            Release to transfer
          </span>
        </div>
      </div>
    </div>
  );
}

function SftpCancelOverlay({ domRef }: { domRef?: React.RefObject<HTMLDivElement | null> }) {
  const accent = "oklch(0.65 0.02 240)"; // Premium neutral slate gray
  return (
    <div
      ref={domRef}
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 backdrop-blur-[2px] transition-all duration-300 opacity-0"
      style={{
        background: "rgba(15, 23, 42, 0.15)",
      }}
    >
      {/* Outer dashed border container */}
      <div
        className="cancel-border absolute inset-4 rounded-xl border-2 border-dashed transition-all duration-300"
        style={{
          borderColor: "rgba(156, 163, 175, 0.25)",
        }}
      />

      {/* Central Box */}
      <div
        className="cancel-box relative flex flex-col items-center gap-3 rounded-2xl border px-8 py-5 shadow-2xl transition-all duration-300"
        style={{
          opacity: 0,
          transform: "scale(0.95)",
          borderColor: `color-mix(in oklab, ${accent} 30%, rgba(255, 255, 255, 0.08))`,
          background: "rgba(30, 41, 59, 0.85)",
          boxShadow: `0 20px 50px rgba(0, 0, 0, 0.5), 0 0 30px color-mix(in oklab, ${accent} 10%, transparent)`,
        }}
      >
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in oklab, ${accent} 15%, rgba(255,255,255,0.03))`,
            border: `1px solid color-mix(in oklab, ${accent} 35%, transparent)`,
          }}
        >
          <X className="h-5 w-5" style={{ color: accent }} />
        </div>
        <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
          Drop to cancel
        </span>
      </div>
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

// Last path segment, handling both "/" and "\" separators (remote paths, macOS/Linux
// local paths, Windows local paths, and OS-dropped paths all pass through here).
function pathBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "file";
}

// Tauri types OS drag positions as "physical" pixels but passes wry's raw
// values through unconverted (PhysicalPosition::new(x as _, y as _)). wry
// reports LOGICAL (CSS) pixels on macOS (NSView coords) and Linux (GTK coords),
// and true PHYSICAL pixels only on Windows (WebView2 client coords) — see
// tauri-apps/tauri#10744. Normalize to CSS/client pixels for DOM hit-testing.
const IS_WINDOWS = navigator.userAgent.includes("Windows");
function osDragToClient(pos: { x: number; y: number }): { x: number; y: number } {
  const scale = IS_WINDOWS ? window.devicePixelRatio || 1 : 1;
  return { x: pos.x / scale, y: pos.y / scale };
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
  const [allGroups, setAllGroups] = useState<HostGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
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
      sftpCall<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts")
        .then((v) => {
          setAllHosts(v.hosts);
          setAllGroups(v.groups || []);
        })
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
  // remoteDragOver: highlight while an OS drag (Finder/Explorer) hovers the remote pane.
  const [remoteDragOver, setRemoteDragOver] = useState(false);
  // paneDrag: pointer-based drag between panes. HTML5 drag & drop is unusable
  // here — Tauri's native drag handler consumes drops before WKWebView/WebView2
  // ever dispatches DOM "drop" events — so we implement dragging ourselves.
  const paneDragRef = useRef<{
    source: "local" | "remote";
    paths: string[];
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const paneRectsRef = useRef<{ local: DOMRect; remote: DOMRect } | null>(null);
  const suppressClickRef = useRef(false);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const localDropOverlayRef = useRef<HTMLDivElement | null>(null);
  const localCancelOverlayRef = useRef<HTMLDivElement | null>(null);
  const remoteDropOverlayRef = useRef<HTMLDivElement | null>(null);
  const remoteCancelOverlayRef = useRef<HTMLDivElement | null>(null);
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
  const localPaneRef = useRef<HTMLDivElement>(null);
  const remotePaneRef = useRef<HTMLDivElement>(null);

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

  const [conflict, setConflict] = useState<SftpConflictInfo | null>(null);
  const [conflictApplyAll, setConflictApplyAll] = useState(false);

  useEffect(() => {
    if (!isConnected) return;
    const unlisten = subscribe<SftpConflictInfo>(`sftp:${sftpSessionId}:conflict`, (ev) => {
      setConflictApplyAll(false);
      setConflict(ev.payload);
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [isConnected, sftpSessionId]);

  const resolveConflict = (base: "overwrite" | "skip" | "cancel") => {
    const decision = base === "cancel" ? "cancel" : conflictApplyAll ? `${base}_all` : base;
    void sftpCall("sftp_resolve_conflict", { sessionId: sftpSessionId, decision })
      .catch((e: unknown) => toast.error(String(e)));
    setConflict(null);
  };

  // Latest transfer handlers, readable from the mount-once effects below.
  const transferRef = useRef<{ upload: (p: string[]) => void; download: (p: string[]) => void }>({
    upload: () => {},
    download: () => {},
  });
  transferRef.current = {
    upload: (paths) => { if (isConnected) void handleUpload(paths); },
    download: (paths) => { if (isConnected) void handleDownload(paths); },
  };
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  // Which pane (if any) contains the given CLIENT (CSS px) coordinates.
  // Hidden panes (inactive tab, display:none) report a zero-size rect.
  const hitTestPane = (x: number, y: number): "local" | "remote" | null => {
    if (paneRectsRef.current) {
      const { local, remote } = paneRectsRef.current;
      if (x >= local.left && x <= local.right && y >= local.top && y <= local.bottom) {
        return "local";
      }
      if (x >= remote.left && x <= remote.right && y >= remote.top && y <= remote.bottom) {
        return "remote";
      }
      return null;
    }
    const panes = [
      ["local", localPaneRef.current],
      ["remote", remotePaneRef.current],
    ] as const;
    for (const [pane, el] of panes) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return pane;
      }
    }
    return null;
  };
  const hitTestPaneRef = useRef(hitTestPane);
  hitTestPaneRef.current = hitTestPane;

  // OS-level drag-drop (files/folders dragged from Finder/Explorer): HTML5 drop
  // events carry no real paths in Tauri, so we listen to the webview drag-drop
  // event and hit-test the remote pane to decide whether to upload.
  useEffect(() => {
    const unlisten = subscribeOsDragDrop((ev) => {
      if (ev.type === "enter" || ev.type === "over") {
        const p = osDragToClient(ev.position);
        setRemoteDragOver(isConnectedRef.current && hitTestPaneRef.current(p.x, p.y) === "remote");
      } else if (ev.type === "leave") {
        setRemoteDragOver(false);
      } else if (ev.type === "drop") {
        setRemoteDragOver(false);
        if (ev.paths.length > 0) {
          const p = osDragToClient(ev.position);
          if (hitTestPaneRef.current(p.x, p.y) === "remote") {
            transferRef.current.upload(ev.paths);
          }
        }
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Pointer-based drag between panes: armed on row mousedown, becomes an active
  // drag after ~8px of movement, transfers on mouseup over the opposite pane.
  const beginPaneDrag = (source: "local" | "remote", path: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const selected = source === "local" ? selectedLocal : selectedRemote;
    const paths = selected.has(path) ? [...selected] : [path];
    paneDragRef.current = { source, paths, startX: e.clientX, startY: e.clientY, active: false };
    if (localPaneRef.current && remotePaneRef.current) {
      paneRectsRef.current = {
        local: localPaneRef.current.getBoundingClientRect(),
        remote: remotePaneRef.current.getBoundingClientRect(),
      };
    }
  };

  useEffect(() => {
    const updateDragUI = (source: "local" | "remote", over: "local" | "remote" | null) => {
      // Reset defaults
      if (localDropOverlayRef.current) {
        localDropOverlayRef.current.style.opacity = "0";
        localDropOverlayRef.current.style.transform = "scale(0.95)";
      }
      if (remoteDropOverlayRef.current) {
        remoteDropOverlayRef.current.style.opacity = "0";
        remoteDropOverlayRef.current.style.transform = "scale(0.95)";
      }
      if (localCancelOverlayRef.current) {
        localCancelOverlayRef.current.style.opacity = "0";
        const box = localCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-box");
        const border = localCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-border");
        if (box) { box.style.opacity = "0"; box.style.transform = "scale(0.95)"; }
        if (border) border.style.borderColor = "rgba(156, 163, 175, 0.25)";
        localCancelOverlayRef.current.style.background = "rgba(15, 23, 42, 0.15)";
      }
      if (remoteCancelOverlayRef.current) {
        remoteCancelOverlayRef.current.style.opacity = "0";
        const box = remoteCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-box");
        const border = remoteCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-border");
        if (box) { box.style.opacity = "0"; box.style.transform = "scale(0.95)"; }
        if (border) border.style.borderColor = "rgba(156, 163, 175, 0.25)";
        remoteCancelOverlayRef.current.style.background = "rgba(15, 23, 42, 0.15)";
      }
      if (localPaneRef.current) localPaneRef.current.style.background = "";
      if (remotePaneRef.current) remotePaneRef.current.style.background = "";

      // Apply active styles
      const cancelAccent = "oklch(0.65 0.02 240)";
      if (source === "local") {
        if (localCancelOverlayRef.current) {
          localCancelOverlayRef.current.style.opacity = "1";
          if (over === "local") {
            const box = localCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-box");
            const border = localCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-border");
            if (box) { box.style.opacity = "1"; box.style.transform = "scale(1)"; }
            if (border) border.style.borderColor = cancelAccent;
            localCancelOverlayRef.current.style.background = `color-mix(in oklab, ${cancelAccent} 12%, rgba(15, 23, 42, 0.45))`;
          }
        }
        if (over === "remote") {
          if (remoteDropOverlayRef.current) {
            remoteDropOverlayRef.current.style.opacity = "1";
            remoteDropOverlayRef.current.style.transform = "scale(1)";
          }
          if (remotePaneRef.current) {
            remotePaneRef.current.style.background = "color-mix(in oklab, oklch(0.45 0.12 145) 5%, transparent)";
          }
        }
      } else if (source === "remote") {
        if (remoteCancelOverlayRef.current) {
          remoteCancelOverlayRef.current.style.opacity = "1";
          if (over === "remote") {
            const box = remoteCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-box");
            const border = remoteCancelOverlayRef.current.querySelector<HTMLDivElement>(".cancel-border");
            if (box) { box.style.opacity = "1"; box.style.transform = "scale(1)"; }
            if (border) border.style.borderColor = cancelAccent;
            remoteCancelOverlayRef.current.style.background = `color-mix(in oklab, ${cancelAccent} 12%, rgba(15, 23, 42, 0.45))`;
          }
        }
        if (over === "local") {
          if (localDropOverlayRef.current) {
            localDropOverlayRef.current.style.opacity = "1";
            localDropOverlayRef.current.style.transform = "scale(1)";
          }
          if (localPaneRef.current) {
            localPaneRef.current.style.background = "color-mix(in oklab, oklch(0.55 0.18 230) 5%, transparent)";
          }
        }
      }
    };

    const onMove = (e: MouseEvent) => {
      const d = paneDragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 8) return;
        d.active = true;
        
        // Drag starts: setup initial ghost and overlays
        if (dragGhostRef.current) {
          dragGhostRef.current.textContent = d.paths.length === 1 ? "1 item" : `${d.paths.length} items`;
          dragGhostRef.current.style.opacity = "1";
          dragGhostRef.current.style.transform = `translate3d(${e.clientX + 14}px, ${e.clientY + 14}px, 0)`;
        }
        if (paneContainerRef.current) {
          paneContainerRef.current.style.userSelect = "none";
          paneContainerRef.current.style.cursor = "copy";
        }
      }
      e.preventDefault();

      if (dragGhostRef.current) {
        dragGhostRef.current.style.transform = `translate3d(${e.clientX + 14}px, ${e.clientY + 14}px, 0)`;
      }

      const target = hitTestPaneRef.current(e.clientX, e.clientY);
      updateDragUI(d.source, target);
    };

    const cancelDrag = () => {
      paneDragRef.current = null;
      paneRectsRef.current = null;
      
      // Reset everything directly in DOM
      if (dragGhostRef.current) dragGhostRef.current.style.opacity = "0";
      if (localDropOverlayRef.current) {
        localDropOverlayRef.current.style.opacity = "0";
        localDropOverlayRef.current.style.transform = "scale(0.95)";
      }
      if (remoteDropOverlayRef.current) {
        remoteDropOverlayRef.current.style.opacity = "0";
        remoteDropOverlayRef.current.style.transform = "scale(0.95)";
      }
      if (localCancelOverlayRef.current) localCancelOverlayRef.current.style.opacity = "0";
      if (remoteCancelOverlayRef.current) remoteCancelOverlayRef.current.style.opacity = "0";
      if (localPaneRef.current) localPaneRef.current.style.background = "";
      if (remotePaneRef.current) remotePaneRef.current.style.background = "";
      if (paneContainerRef.current) {
        paneContainerRef.current.style.userSelect = "";
        paneContainerRef.current.style.cursor = "";
      }
    };

    const onUp = (e: MouseEvent) => {
      const d = paneDragRef.current;
      const target = hitTestPaneRef.current(e.clientX, e.clientY);
      cancelDrag();
      if (!d?.active) return;
      
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      
      if (d.source === "local" && target === "remote") transferRef.current.upload(d.paths);
      else if (d.source === "remote" && target === "local") transferRef.current.download(d.paths);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const d = paneDragRef.current;
        if (d && d.active) {
          cancelDrag();
        }
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cancelDrag);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cancelDrag);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
    if (suppressClickRef.current) return; // click that ended a pane drag
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
    if (suppressClickRef.current) return; // click that ended a pane drag
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
        const fileName = pathBaseName(rp);
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
        const fileName = pathBaseName(lp);
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
    sftpCall<{ hosts: Host[]; groups: HostGroup[] }>("list_hosts").then((v) => {
      setAllHosts(v.hosts);
      setAllGroups(v.groups || []);
    }).catch(() => {});
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

  // Pane highlights: (remote only) an OS file drag hovering the remote pane.
  const remoteDropTarget = remoteDragOver;

  const renderHostItem = (h: Host) => (
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
  );

  const renderSftpGroupNode = (groupId: string | null, depth: number): React.ReactNode => {
    const subGroups = allGroups.filter(g => g.parentId === groupId);
    const groupHosts = allHosts.filter(h => groupId ? h.groupId === groupId : !h.groupId);

    const hasContent = subGroups.length > 0 || groupHosts.length > 0;
    if (!hasContent) return null;

    if (groupId) {
      const group = allGroups.find(g => g.id === groupId);
      if (!group) return null;
      const isOpen = !collapsedGroups[groupId];
      const totalItems = subGroups.length + groupHosts.length;
      return (
        <div key={groupId} className="flex flex-col">
          <button
            type="button"
            onClick={() => setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-[var(--color-surface-2)]"
            style={{ paddingLeft: `${depth * 12 + 16}px` }}
          >
            <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
            <Folder className="h-3.5 w-3.5 shrink-0 text-[oklch(0.7_0.13_230)]" />
            <span className="text-xs font-semibold text-foreground truncate">{group.name}</span>
            <span className="text-[10px] text-muted-foreground">({totalItems})</span>
          </button>
          {isOpen && (
            <div className="flex flex-col">
              {subGroups.map(sg => renderSftpGroupNode(sg.id, depth + 1))}
              {groupHosts.map(h => (
                <div key={h.id} style={{ paddingLeft: `${(depth + 1) * 12}px` }}>
                  {renderHostItem(h)}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div key="root-group">
        {subGroups.map(sg => renderSftpGroupNode(sg.id, depth))}
        {groupHosts.map(h => renderHostItem(h))}
      </div>
    );
  };

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col transition-colors"
    >
      {/* Drag ghost for pointer-based pane-to-pane drags */}
      <div
        ref={dragGhostRef}
        className="pointer-events-none fixed z-50 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs font-medium text-foreground shadow-lg opacity-0 transition-opacity duration-150"
        style={{
          left: 0,
          top: 0,
          willChange: "transform",
        }}
      />
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
        ref={localPaneRef}
        className="relative flex flex-col border-r border-border overflow-hidden transition-colors"
        style={{ width: `${localWidthPct}%` }}
      >
        <SftpDropOverlay label="Drop to download here" accent="oklch(0.55 0.18 230)" icon={Download} domRef={localDropOverlayRef} />
        <SftpCancelOverlay domRef={localCancelOverlayRef} />
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
                    onMouseDown={(e) => beginPaneDrag("local", f.path, e)}
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
        ref={remotePaneRef}
        className={`relative flex flex-col overflow-hidden transition-colors ${remoteDropTarget ? "bg-[oklch(0.45_0.12_145)]/5" : ""}`}
        style={{ width: `calc(100% - ${localWidthPct}% - 24px)` }}
      >
        {remoteDragOver && (
          <div className="pointer-events-none absolute inset-0 z-30">
            <SftpDropOverlay label="Drop to upload here" accent="oklch(0.45 0.12 145)" icon={Upload} />
          </div>
        )}
        <SftpDropOverlay label="Drop to upload here" accent="oklch(0.45 0.12 145)" icon={Upload} domRef={remoteDropOverlayRef} />
        <SftpCancelOverlay domRef={remoteCancelOverlayRef} />
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
              {hostQuery ? (
                allHosts
                  .filter((h) => {
                    const q = hostQuery.toLowerCase();
                    return h.name.toLowerCase().includes(q) || h.hostname.toLowerCase().includes(q) || h.user.toLowerCase().includes(q);
                  })
                  .map((h) => renderHostItem(h))
              ) : (
                renderSftpGroupNode(null, 0)
              )}
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
                        onMouseDown={(e) => beginPaneDrag("remote", f.path, e)}
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
                      overwrite: true,
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

      {/* Transfer conflict dialog */}
      <AlertDialog.Root open={conflict !== null}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-[var(--color-surface-2)] p-5 shadow-xl">
            <AlertDialog.Title className="text-sm font-medium text-foreground">
              {conflict?.kind === "dir" ? "Folder already exists" : "File already exists"}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">"{conflict?.file_name}"</span>{" "}
              already exists at the {conflict?.direction === "upload" ? "remote" : "local"} destination.
              {conflict?.kind === "dir"
                ? " Merging will keep its contents and overwrite files with the same name."
                : " Overwriting will replace the existing file."}
            </AlertDialog.Description>
            {conflict && conflict.kind === "file" && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium text-foreground">Existing</div>
                  <div className="text-muted-foreground">{conflict.existing_size != null ? formatBytes(conflict.existing_size) : "—"}</div>
                  <div className="text-muted-foreground">{conflict.existing_modified ?? "—"}</div>
                </div>
                <div className="rounded-md border border-border p-2">
                  <div className="mb-1 font-medium text-foreground">Replacing with</div>
                  <div className="text-muted-foreground">{conflict.incoming_size != null ? formatBytes(conflict.incoming_size) : "—"}</div>
                  <div className="text-muted-foreground">{conflict.incoming_modified ?? "—"}</div>
                </div>
              </div>
            )}
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={conflictApplyAll}
                onChange={(e) => setConflictApplyAll(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-brand-cyan)]"
              />
              Apply to all remaining conflicts
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => resolveConflict("cancel")}
              >
                Cancel transfer
              </button>
              <button
                autoFocus
                className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-white/5"
                onClick={() => resolveConflict("skip")}
              >
                Skip
              </button>
              <button
                className="rounded bg-[var(--color-brand-cyan)] px-3 py-1.5 text-sm font-medium text-black"
                onClick={() => resolveConflict("overwrite")}
              >
                {conflict?.kind === "dir" ? "Merge" : "Overwrite"}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

