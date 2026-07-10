import { X, Palette, Keyboard, Minus, Plus, Check, Shield, RefreshCw, PanelTop, Settings } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask as askDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { publish } from "@/lib/api/transport";
import { platform } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  clampTerminalFontSize,
  clampTerminalLineHeight,
  getTerminalAppearanceUpdatedAt,
  loadTerminalAppearance,
  saveTerminalAppearance,
  terminalAppearanceStorageKey,
  terminalFonts,
  type TerminalAppearance,
  type TerminalFont,
} from "@/lib/terminal-appearance";
import { toast } from "sonner";
import { vaultStatus, vaultChangeMasterPassword, getLockPolicy, setLockPolicy } from "@/lib/api/vault";
import type { VaultStatus, LockPolicy } from "@/lib/api/vault";
import {
  syncGetConfig,
  syncSetConfig,
  syncNow,
  syncDisconnect,
  syncConnectProvider,
  type SyncBackendConfig,
  type SyncStatus,
} from "@/lib/api/sync";
import { listHosts, saveHost } from "@/lib/api/hosts";
import type { Host } from "@/components/app/types";
import {
  appThemeStorageKey,
  appThemes,
  getAppThemeUpdatedAt,
  loadAppTheme,
  saveAppTheme,
  type AppThemeId,
} from "@/lib/app-theme";
import {
  eventToShortcutBinding,
  formatShortcut,
  getShortcutsUpdatedAt,
  loadShortcuts,
  resetShortcut,
  saveShortcuts,
  shortcutDefinitions,
  shortcutsChangedEvent,
  shortcutsStorageKey,
  type ShortcutActionId,
  type ShortcutMap,
} from "@/lib/shortcuts";
import {
  bindingToAccelerator,
  loadGlobalHotkeySettings,
  saveGlobalHotkeySettings,
  type GlobalHotkeySettings,
} from "@/lib/global-hotkey";
import {
  disableGlobalHotkey,
  enableGlobalHotkey,
  type HotkeyAction,
  type HotkeyStatus,
} from "@/lib/api/global-hotkey";
import {
  getQuickTerminalInfo,
  setQuickTerminalEdge,
  setQuickTerminalEnabled,
  setQuickTerminalOpacity,
  type QuickTerminalEdge,
} from "@/lib/api/quick-terminal";
import { Slider } from "@/components/ui/slider";
import {
  getGeneralSettings,
  setGeneralSettings,
  isAutostartEnabled,
  setAutostartEnabled as setAutostartEnabledApi,
} from "@/lib/api/terminal";

export function SettingsWindow() {
  const [terminalAppearance, setTerminalAppearance] = useState(loadTerminalAppearance);
  const [selectedThemeId, setSelectedThemeId] = useState(loadAppTheme().id);
  const [mainWindowOpacity, setMainWindowOpacity] = useState(() => {
    try {
      const stored = localStorage.getItem("termifai:main-window-opacity");
      return stored ? parseFloat(stored) : 0.7;
    } catch {
      return 0.7;
    }
  });
  const [shortcuts, setShortcuts] = useState(loadShortcuts);
  const [editingShortcutId, setEditingShortcutId] = useState<ShortcutActionId | null>(null);
  const [hotkeys, setHotkeys] = useState<Record<HotkeyAction, GlobalHotkeySettings>>(() => ({
    "main-window": loadGlobalHotkeySettings("main-window"),
    "quick-terminal": loadGlobalHotkeySettings("quick-terminal"),
  }));
  const [editingHotkeyAction, setEditingHotkeyAction] = useState<HotkeyAction | null>(null);
  const [hotkeyBusy, setHotkeyBusy] = useState(false);
  const [hotkeyErrors, setHotkeyErrors] = useState<Partial<Record<HotkeyAction, string>>>({});
  const [hotkeyStatus, setHotkeyStatus] = useState<Partial<Record<HotkeyAction, HotkeyStatus>>>({});
  const [quickTerminal, setQuickTerminal] = useState<{
    enabled: boolean;
    edge: QuickTerminalEdge;
    opacity: number;
    wayland: boolean;
  }>({ enabled: false, edge: "top", opacity: 1, wayland: false });
  const [vaultSt, setVaultSt] = useState<VaultStatus | null>(null);
  const [lockPolicy, setLockPolicyState] = useState<LockPolicy>("on_restart");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [syncStatusState, setSyncStatusState] = useState<SyncStatus | null>(null);
  const [syncBackendKind, setSyncBackendKind] = useState<SyncBackendConfig["kind"]>("localDir");
  const [localDirPath, setLocalDirPath] = useState("");
  const [sftpHostId, setSftpHostId] = useState("");
  const [sftpRemotePath, setSftpRemotePath] = useState("~/.termifai/sync");
  const [syncableHosts, setSyncableHosts] = useState<Host[]>([]);
  const [syncSshKeysToggle, setSyncSshKeysToggle] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [providerConnecting, setProviderConnecting] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNeedsPassword, setSyncNeedsPassword] = useState(false);
  const [syncPassword, setSyncPassword] = useState("");

  const [runInBackground, setRunInBackground] = useState(true);
  const [autostartEnabled, setAutostartEnabled] = useState(true);

  useEffect(() => {
    void getGeneralSettings().then((s) => setRunInBackground(s.runInBackground));
    void isAutostartEnabled().then((enabled) => setAutostartEnabled(enabled));
  }, []);

  const handleRunInBackgroundChange = (checked: boolean) => {
    setRunInBackground(checked);
    void setGeneralSettings({ runInBackground: checked }).then(() => {
      toast.success(
        checked
          ? "App will continue running in the background"
          : "App will exit completely when closed"
      );
    });
  };

  const handleAutostartChange = (checked: boolean) => {
    setAutostartEnabled(checked);
    void setAutostartEnabledApi(checked).then(() => {
      toast.success(
        checked
          ? "Startup autostart enabled"
          : "Startup autostart disabled"
      );
    });
  };

  const refreshSyncStatus = () => {
    syncGetConfig()
      .then((status) => {
        setSyncStatusState(status);
        setSyncSshKeysToggle(status.syncSshKeys);
        if (status.backend?.kind === "localDir") setLocalDirPath(status.backend.path);
        if (status.backend?.kind === "sftp") {
          setSftpHostId(status.backend.hostId);
          setSftpRemotePath(status.backend.remotePath);
        }
      })
      .catch(console.error);
  };

  const refreshSyncableHosts = () => {
    listHosts().then(({ hosts: h }) => setSyncableHosts(h)).catch(console.error);
  };

  useEffect(() => {
    refreshSyncStatus();
    refreshSyncableHosts();
    // This window is created once at startup and only hidden/shown afterwards,
    // so mount-time data goes stale. Opening it always focuses it — refetch on
    // every focus so hosts added/edited in the main window show up here.
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        refreshSyncStatus();
        refreshSyncableHosts();
      }
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncBackendLabel = (backend: SyncBackendConfig): string => {
    switch (backend.kind) {
      case "localDir":
        return `Local folder — ${backend.path}`;
      case "googleDrive":
        return "Google Drive";
      case "dropbox":
        return "Dropbox";
      case "sftp": {
        const host = syncableHosts.find((h) => h.id === backend.hostId);
        return `My Server (SFTP) — ${host?.name ?? backend.hostId} : ${backend.remotePath}`;
      }
    }
  };

  const runSync = async (masterPassword?: string) => {
    setSyncError(null);
    setSyncLoading(true);
    try {
      const result = await syncNow({
        masterPassword,
        appTheme: { value: loadAppTheme().id, updatedAt: getAppThemeUpdatedAt() },
        terminalAppearance: { value: loadTerminalAppearance(), updatedAt: getTerminalAppearanceUpdatedAt() },
        shortcuts: { value: loadShortcuts(), updatedAt: getShortcutsUpdatedAt() },
      });

      if (typeof result.appTheme.value === "string") {
        saveAppTheme(result.appTheme.value as AppThemeId);
        if (result.appTheme.updatedAt) {
          localStorage.setItem(`${appThemeStorageKey}:updatedAt`, result.appTheme.updatedAt);
        }
        setSelectedThemeId(result.appTheme.value as AppThemeId);
      }
      if (result.terminalAppearance.value) {
        const appearance = result.terminalAppearance.value as TerminalAppearance;
        saveTerminalAppearance(appearance);
        if (result.terminalAppearance.updatedAt) {
          localStorage.setItem(`${terminalAppearanceStorageKey}:updatedAt`, result.terminalAppearance.updatedAt);
        }
        setTerminalAppearance(appearance);
      }
      if (result.shortcuts.value) {
        const merged = result.shortcuts.value as ShortcutMap;
        saveShortcuts(merged);
        if (result.shortcuts.updatedAt) {
          localStorage.setItem(`${shortcutsStorageKey}:updatedAt`, result.shortcuts.updatedAt);
        }
        setShortcuts(merged);
      }

      setSyncNeedsPassword(false);
      setSyncPassword("");
      refreshSyncStatus();
      toast.success("Synced");
    } catch (e: unknown) {
      if (String(e).includes("master_password_required")) {
        setSyncNeedsPassword(true);
      } else {
        setSyncError(String(e));
      }
    } finally {
      setSyncLoading(false);
    }
  };

  const handleBrowseLocalDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a sync folder",
      });
      if (typeof selected === "string") setLocalDirPath(selected);
    } catch (e: unknown) {
      setSyncError(String(e));
    }
  };

  const handleConnectSync = async () => {
    setSyncError(null);
    try {
      if (syncBackendKind === "localDir") {
        if (!localDirPath.trim()) return;
        await syncSetConfig({ kind: "localDir", path: localDirPath.trim() }, syncSshKeysToggle);
      } else if (syncBackendKind === "sftp") {
        if (!sftpHostId || !sftpRemotePath.trim()) return;
        await syncSetConfig(
          { kind: "sftp", hostId: sftpHostId, remotePath: sftpRemotePath.trim() },
          syncSshKeysToggle,
        );
        // Mark the chosen host so it shows the sync-server badge in Hosts.
        const host = syncableHosts.find((h) => h.id === sftpHostId);
        if (host && !host.syncServer) {
          await saveHost({ ...host, syncServer: true }, host.id).catch(() => {});
        }
      } else {
        setProviderConnecting(true);
        await syncConnectProvider(syncBackendKind === "googleDrive" ? "google" : "dropbox");
        await syncSetConfig({ kind: syncBackendKind }, syncSshKeysToggle);
      }
      refreshSyncStatus();
      toast.success("Sync backend connected");
    } catch (e: unknown) {
      setSyncError(String(e));
    } finally {
      setProviderConnecting(false);
    }
  };

  const handleDisconnectSync = async (deleteRemote: boolean) => {
    setSyncError(null);
    try {
      await syncDisconnect(deleteRemote);
      refreshSyncStatus();
      toast.success("Disconnected");
    } catch (e: unknown) {
      setSyncError(String(e));
    }
  };

  useEffect(() => {
    const refresh = () => {
      vaultStatus().then((s) => {
        setVaultSt(s);
        setLockPolicyState(s.lockPolicy);
      }).catch(console.error);
    };
    refresh();
    getLockPolicy().then(setLockPolicyState).catch(console.error);
    // The settings window is reused (shown/hidden), so the component mounts
    // once while the vault is still locked. Refresh whenever the window
    // regains focus to reflect lock/unlock changes made from the main window.
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) refresh();
      })
      .then((fn) => { unlisten = fn; })
      .catch(console.error);
    return () => unlisten?.();
  }, []);

  const handleSetLockPolicy = async (policy: LockPolicy) => {
    try {
      await setLockPolicy(policy);
      setLockPolicyState(policy);
      toast.success("Lock policy updated");
    } catch (e: unknown) {
      toast.error(String(e));
    }
  };

  const handleChangePw = async () => {
    if (newPw.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { setPwError("Passwords do not match."); return; }
    setPwError(null);
    setPwLoading(true);
    try {
      await vaultChangeMasterPassword(oldPw, newPw);
      setOldPw(""); setNewPw(""); setConfirmPw("");
      toast.success("Master password changed");
    } catch (e: unknown) {
      setPwError(String(e));
    } finally {
      setPwLoading(false);
    }
  };

  useEffect(() => {
    const previousBackground = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => {
      document.body.style.backgroundColor = previousBackground;
    };
  }, []);
  useEffect(() => {
    const onStorageChanged = (event: StorageEvent) => {
      if (event.key === shortcutsStorageKey) {
        setShortcuts(loadShortcuts());
      }
    };

    window.addEventListener("storage", onStorageChanged);
    return () => window.removeEventListener("storage", onStorageChanged);
  }, []);
  useEffect(() => {
    if (!editingShortcutId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (
        event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setEditingShortcutId(null);
        return;
      }

      const binding = eventToShortcutBinding(event);
      if (!binding) return;

      const nextShortcuts = {
        ...shortcuts,
        [editingShortcutId]: binding,
      };

      setShortcuts(nextShortcuts);
      saveShortcuts(nextShortcuts);
      setEditingShortcutId(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editingShortcutId, shortcuts]);
  useEffect(() => {
    if (!editingHotkeyAction) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (
        event.key === "Escape" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setEditingHotkeyAction(null);
        return;
      }

      const binding = eventToShortcutBinding(event);
      if (!binding) return;
      const accelerator = bindingToAccelerator(binding);
      if (!accelerator) return; // require at least one modifier

      const action = editingHotkeyAction;
      const otherAction: HotkeyAction =
        action === "main-window" ? "quick-terminal" : "main-window";
      if (accelerator === bindingToAccelerator(hotkeys[otherAction].binding)) {
        setEditingHotkeyAction(null);
        setHotkeyErrors((errors) => ({
          ...errors,
          [action]:
            "This combination is already used by the other global hotkey — choose a different one.",
        }));
        return;
      }

      setEditingHotkeyAction(null);
      void applyHotkey(action, { ...hotkeys[action], binding });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editingHotkeyAction, hotkeys]);
  useEffect(() => {
    getQuickTerminalInfo()
      .then((info) => {
        setQuickTerminal({
          enabled: info.settings.enabled,
          edge: info.settings.edge,
          opacity: info.settings.opacity,
          wayland: info.wayland,
        });
        // The panel switch also owns the hotkey's enabled state.
        setHotkeys((all) => ({
          ...all,
          "quick-terminal": { ...all["quick-terminal"], enabled: info.settings.enabled },
        }));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const onShortcutChanged = (event: Event) => {
      setShortcuts((event as CustomEvent<ShortcutMap>).detail);
    };

    window.addEventListener(shortcutsChangedEvent, onShortcutChanged);
    return () => window.removeEventListener(shortcutsChangedEvent, onShortcutChanged);
  }, []);

  const closeWindow = () => {
    getCurrentWindow().hide().catch((err) =>
      console.error("hide settings window failed:", err)
    );
  };
  const updateFontFamily = (fontFamily: TerminalFont) => {
    const nextAppearance = { ...terminalAppearance, fontFamily };
    setTerminalAppearance(nextAppearance);
    saveTerminalAppearance(nextAppearance);
  };
  const updateFontSize = (fontSize: number) => {
    const nextAppearance = {
      ...terminalAppearance,
      fontSize: clampTerminalFontSize(fontSize),
    };
    setTerminalAppearance(nextAppearance);
    saveTerminalAppearance(nextAppearance);
  };
  const updateLineHeight = (lineHeight: number) => {
    const nextAppearance = {
      ...terminalAppearance,
      lineHeight: clampTerminalLineHeight(lineHeight),
    };
    setTerminalAppearance(nextAppearance);
    saveTerminalAppearance(nextAppearance);
  };
  const updateTheme = (themeId: AppThemeId) => {
    setSelectedThemeId(themeId);
    saveAppTheme(themeId);
  };
  const applyMainWindowOpacity = (opacity: number) => {
    const clamped = Math.min(1.0, Math.max(0.3, opacity));
    setMainWindowOpacity(clamped);
    try {
      localStorage.setItem("termifai:main-window-opacity", clamped.toString());
      window.dispatchEvent(new Event("storage"));
      void publish("main-window:opacity-changed", clamped).catch(() => {});
    } catch {}
  };
  const resetShortcutToDefault = (actionId: ShortcutActionId) => {
    const nextShortcuts = resetShortcut(shortcuts, actionId);
    setShortcuts(nextShortcuts);
    saveShortcuts(nextShortcuts);
  };

  const applyHotkey = async (action: HotkeyAction, next: GlobalHotkeySettings) => {
    setHotkeyErrors((errors) => ({ ...errors, [action]: undefined }));
    setHotkeyBusy(true);
    try {
      if (next.enabled) {
        const accelerator = bindingToAccelerator(next.binding);
        if (!accelerator) {
          throw new Error("Choose a combination that includes a modifier key.");
        }
        const status = await enableGlobalHotkey(action, accelerator);
        setHotkeyStatus((statuses) => ({ ...statuses, [action]: status }));
      } else {
        await disableGlobalHotkey(action);
        setHotkeyStatus((statuses) => ({ ...statuses, [action]: undefined }));
      }
      setHotkeys((all) => ({ ...all, [action]: next }));
      saveGlobalHotkeySettings(action, next);
    } catch (error) {
      setHotkeyErrors((errors) => ({
        ...errors,
        [action]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setHotkeyBusy(false);
    }
  };

  // Single switch for the whole feature: it enables the panel AND registers
  // its global hotkey in one go (there is no separate hotkey switch).
  const applyQuickTerminalEnabled = async (enabled: boolean) => {
    if (enabled && quickTerminal.wayland) {
      // The compositor silently ignores toplevel positioning on most Wayland
      // desktops (notably GNOME), so make the user opt in explicitly.
      const confirmed = await askDialog(
        "On your Wayland desktop this feature is known to be unreliable: " +
          "GNOME does not let apps position their own windows, so the panel may " +
          "not appear attached to the screen edge (KDE and wlroots-based " +
          "compositors usually work). Enable anyway?",
        { title: "Quick Terminal on Wayland", kind: "warning" },
      );
      if (!confirmed) return;
    }
    setHotkeyErrors((errors) => ({ ...errors, "quick-terminal": undefined }));
    setHotkeyBusy(true);
    try {
      if (enabled) {
        const binding = hotkeys["quick-terminal"].binding;
        const accelerator = bindingToAccelerator(binding);
        if (!accelerator) {
          throw new Error("Set a hotkey combination that includes a modifier key first.");
        }
        const status = await enableGlobalHotkey("quick-terminal", accelerator);
        setHotkeyStatus((statuses) => ({ ...statuses, "quick-terminal": status }));
      } else {
        await disableGlobalHotkey("quick-terminal");
        setHotkeyStatus((statuses) => ({ ...statuses, "quick-terminal": undefined }));
      }
      await setQuickTerminalEnabled(enabled);
      setQuickTerminal((qt) => ({ ...qt, enabled }));
      const nextHotkey = { ...hotkeys["quick-terminal"], enabled };
      setHotkeys((all) => ({ ...all, "quick-terminal": nextHotkey }));
      saveGlobalHotkeySettings("quick-terminal", nextHotkey);
    } catch (error) {
      setHotkeyErrors((errors) => ({
        ...errors,
        "quick-terminal": error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setHotkeyBusy(false);
    }
  };

  const applyQuickTerminalOpacity = (opacity: number) => {
    setQuickTerminal((qt) => ({ ...qt, opacity }));
    void setQuickTerminalOpacity(opacity).catch(() => {});
  };

  const applyQuickTerminalEdge = async (edge: QuickTerminalEdge) => {
    try {
      await setQuickTerminalEdge(edge);
      setQuickTerminal((qt) => ({ ...qt, edge }));
    } catch {
      /* leave state unchanged */
    }
  };

  const isMac = platform === "macos";

  const renderHotkeyRow = (
    action: HotkeyAction,
    title: string,
    description: string,
    { showSwitch = true }: { showSwitch?: boolean } = {},
  ) => {
    const settings = hotkeys[action];
    const error = hotkeyErrors[action];
    return (
      <>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-1 text-xs text-muted-foreground">{description}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex min-w-28 justify-end gap-1.5">
              {editingHotkeyAction === action ? (
                <span className="rounded-md border border-primary bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
                  Press keys...
                </span>
              ) : (
                formatShortcut(settings.binding).map((key, i) => (
                  <kbd
                    key={`${action}-${i}`}
                    className="rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-muted-foreground shadow-sm"
                  >
                    {key}
                  </kbd>
                ))
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={hotkeyBusy}
              onClick={() => setEditingHotkeyAction(action)}
            >
              Change
            </Button>
            {showSwitch && (
              <Switch
                checked={settings.enabled}
                disabled={hotkeyBusy}
                onCheckedChange={(checked) =>
                  void applyHotkey(action, { ...settings, enabled: checked })
                }
              />
            )}
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </>
    );
  };

  return (
    <div className={`flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground ${isMac ? "rounded-lg" : ""}`}>
      <header className="relative flex h-8 shrink-0 items-center border-b border-border bg-[var(--color-surface)] select-none">
        {/* Drag region covers the full header but excludes button areas */}
        <div className="absolute inset-0" data-tauri-drag-region />

        {isMac ? (
          <button
            onClick={closeWindow}
            className="relative z-10 ml-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff5f57] text-[#7a1f1b] hover:text-[#7a1f1b]/90"
            aria-label="Close Settings"
          >
            <X className="h-2.5 w-2.5 opacity-0 hover:opacity-100" />
          </button>
        ) : (
          <button
            onClick={closeWindow}
            className="relative z-10 ml-auto flex h-full w-10 items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors"
            aria-label="Close Settings"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        <h1 className="absolute inset-0 flex items-center justify-center text-[13px] font-medium leading-none text-foreground pointer-events-none">Settings</h1>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-5">
        <Tabs defaultValue="general" className="mx-auto max-w-3xl">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="general" className="gap-2">
              <Settings className="h-4 w-4" />
              General
            </TabsTrigger>
            <TabsTrigger value="theme" className="gap-2">
              <Palette className="h-4 w-4" />
              Theme
            </TabsTrigger>
            <TabsTrigger value="shortcuts" className="gap-2">
              <Keyboard className="h-4 w-4" />
              Shortcuts
            </TabsTrigger>
            <TabsTrigger value="quick-terminal" className="gap-2">
              <PanelTop className="h-4 w-4" />
              Quick Terminal
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-2">
              <Shield className="h-4 w-4" />
              Security
            </TabsTrigger>
            <TabsTrigger value="sync" className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Sync
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Settings className="h-4 w-4 text-[var(--color-brand-green)]" />
                  General Settings
                </CardTitle>
                <CardDescription>
                  Configure app behavior on launch and exit.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      Run at Startup
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground leading-relaxed">
                      Start the application automatically when you log into your system. This is required for your global hotkeys and Quick Terminal to function seamlessly in the background without needing to launch the app manually.
                    </div>
                  </div>
                  <Switch
                    checked={autostartEnabled}
                    onCheckedChange={handleAutostartChange}
                  />
                </div>

                <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      Run in Background
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground leading-relaxed">
                      Closing the main window will hide it and keep the application running in the system tray. This allows the hotkey daemon to remain active and respond to your shortcuts. If disabled, closing the window will completely exit the application and its background services.
                    </div>
                  </div>
                  <Switch
                    checked={runInBackground}
                    onCheckedChange={handleRunInBackgroundChange}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="theme" className="mt-4 space-y-6 pb-10">
            {/* Font and Size Settings */}
            <div className="rounded-xl bg-[var(--color-card)] p-5">
              <div className="relative mb-6">
                <Select
                  value={terminalAppearance.fontFamily}
                  onValueChange={(value) => updateFontFamily(value as TerminalFont)}
                >
                  <SelectTrigger className="h-11 border-border bg-transparent text-base text-foreground shadow-none focus:ring-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {terminalFonts.map((font) => (
                      <SelectItem key={font} value={font}>
                        {font}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-base font-medium text-foreground">Text Size</span>
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9 rounded-md border-0 bg-[var(--color-surface-2)] text-foreground hover:bg-accent"
                    onClick={() => updateFontSize(terminalAppearance.fontSize - 1)}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <div className="flex h-9 w-12 items-center justify-center rounded-md border border-border bg-transparent text-sm font-medium text-foreground">
                    {terminalAppearance.fontSize}
                  </div>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9 rounded-md border-0 bg-[var(--color-surface-2)] text-foreground hover:bg-accent"
                    onClick={() => updateFontSize(terminalAppearance.fontSize + 1)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-base font-medium text-foreground">Line Height</span>
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9 rounded-md border-0 bg-[var(--color-surface-2)] text-foreground hover:bg-accent"
                    onClick={() => updateLineHeight(terminalAppearance.lineHeight - 0.1)}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <div className="flex h-9 w-12 items-center justify-center rounded-md border border-border bg-transparent text-sm font-medium text-foreground">
                    {terminalAppearance.lineHeight.toFixed(1)}
                  </div>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9 rounded-md border-0 bg-[var(--color-surface-2)] text-foreground hover:bg-accent"
                    onClick={() => updateLineHeight(terminalAppearance.lineHeight + 0.1)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Terminal Theme */}
            <div className="rounded-xl bg-[var(--color-card)] p-5">
              <h2 className="text-base font-semibold mb-5 text-foreground">Terminal theme</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {appThemes.map((theme) => {
                  const isActive = selectedThemeId === theme.id;

                  return (
                  <button
                    key={theme.id}
                    onClick={() => updateTheme(theme.id)}
                    className={`flex cursor-pointer items-center gap-4 rounded-xl p-3 transition-colors ${
                      isActive
                        ? "bg-[var(--color-surface-2)] ring-1 ring-primary/40"
                        : "hover:bg-[var(--color-surface-2)]/50"
                    }`}
                  >
                    <div
                      className="flex h-12 w-[72px] shrink-0 flex-col overflow-hidden rounded-[8px] border-[1.5px]"
                      style={{
                        backgroundColor: theme.preview.background,
                        borderColor: theme.preview.border,
                      }}
                    >
                      <div className="flex h-full flex-col justify-between p-2 gap-[3px]">
                        <div
                          className="h-1.5 w-full rounded-[2px]"
                          style={{ backgroundColor: theme.preview.lines[0] }}
                        />
                        <div className="flex gap-1 h-1.5">
                          <div
                            className="h-full w-[60%] rounded-[2px]"
                            style={{ backgroundColor: theme.preview.lines[1] }}
                          />
                          <div
                            className="h-full w-[35%] rounded-[2px]"
                            style={{ backgroundColor: theme.preview.lines[2] }}
                          />
                        </div>
                        <div
                          className="h-1.5 w-[80%] rounded-[2px]"
                          style={{ backgroundColor: theme.preview.lines[3] }}
                        />
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span
                        className={`text-sm font-medium ${
                          isActive ? "text-primary" : "text-foreground"
                        }`}
                      >
                        {theme.name}
                      </span>
                      <span
                        className={`text-left text-xs font-medium ${
                          isActive ? "text-primary" : "text-muted-foreground"
                        }`}
                      >
                        {theme.detail}
                      </span>
                    </div>
                    {isActive && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                  );
                })}
              </div>
            </div>

            {/* Window Transparency */}
            <div className="rounded-xl bg-[var(--color-card)] p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-base font-medium text-foreground">Window transparency</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    How see-through the main Termifai window is. 100% is fully opaque.
                  </div>
                </div>
                <div className="flex w-48 shrink-0 items-center gap-3">
                  <Slider
                    min={30}
                    max={100}
                    step={5}
                    value={[Math.round(mainWindowOpacity * 100)]}
                    onValueChange={([value]) => applyMainWindowOpacity(value / 100)}
                  />
                  <span className="w-10 text-right font-mono text-xs text-muted-foreground">
                    {Math.round(mainWindowOpacity * 100)}%
                  </span>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="shortcuts" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Keyboard className="h-4 w-4 text-[var(--color-brand-green)]" />
                  Global Hotkeys
                </CardTitle>
                <CardDescription>
                  Configure system-wide shortcuts to toggle Termifai windows from anywhere, even when other applications have focus.
                  {!isMac && (
                    <span className="block mt-1">
                      On Linux with Wayland, enabling these will show a system confirmation dialog asking you to approve the shortcut.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {renderHotkeyRow(
                  "main-window",
                  "Toggle Main Window",
                  "Toggle the visibility of the primary Termifai shell window.",
                )}
                {renderHotkeyRow(
                  "quick-terminal",
                  "Toggle Quick Terminal",
                  "Slide the Quick Terminal panel in or out.",
                  { showSwitch: false },
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Keyboard className="h-4 w-4 text-[var(--color-brand-green)]" />
                  Shortcuts
                </CardTitle>
                <CardDescription>
                  Change keyboard shortcuts used for common Termifai actions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {shortcutDefinitions.map((shortcut) => (
                    <div
                      key={shortcut.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{shortcut.label}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {shortcut.description}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="flex min-w-28 justify-end gap-1.5">
                          {editingShortcutId === shortcut.id ? (
                            <span className="rounded-md border border-primary bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
                              Press keys...
                            </span>
                          ) : (
                            formatShortcut(shortcuts[shortcut.id]).map((key) => (
                              <kbd
                                key={`${shortcut.id}-${key}`}
                                className="rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-muted-foreground shadow-sm"
                              >
                                {key}
                              </kbd>
                            ))
                          )}
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingShortcutId(shortcut.id)}
                        >
                          Change
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => resetShortcutToDefault(shortcut.id)}
                        >
                          Reset
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="quick-terminal" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <PanelTop
                    className={`h-4 w-4 ${quickTerminal.wayland ? "text-red-500" : "text-[var(--color-brand-green)]"}`}
                  />
                  Quick Terminal
                </CardTitle>
                <CardDescription>
                  A slide-in terminal panel anchored to a screen edge, summoned from anywhere
                  with its own global hotkey. Off by default.
                  {quickTerminal.wayland && (
                    <span className="mt-1 block text-red-500">
                      Your system is running Wayland: most Wayland desktops (notably GNOME) do
                      not let apps position their own windows, so the panel may not attach to
                      the screen edge correctly.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div
                  className={`flex items-center justify-between gap-4 rounded-lg border px-4 py-3 ${
                    quickTerminal.wayland ? "border-red-500/50" : "border-border"
                  }`}
                >
                  <div className="min-w-0">
                    <div
                      className={`text-sm font-medium ${quickTerminal.wayland ? "text-red-500" : ""}`}
                    >
                      Enable Quick Terminal
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Turns the panel on and registers its global hotkey.
                    </div>
                  </div>
                  <Switch
                    checked={quickTerminal.enabled}
                    disabled={hotkeyBusy}
                    onCheckedChange={(checked) => void applyQuickTerminalEnabled(checked)}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Screen edge</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Where the panel slides in from. Left/right default to ⅓ of the screen
                      width, top/bottom to ½ of the height; drag the panel's inner edge to
                      resize.
                    </div>
                  </div>
                  <Select
                    value={quickTerminal.edge}
                    onValueChange={(edge) => void applyQuickTerminalEdge(edge as QuickTerminalEdge)}
                  >
                    <SelectTrigger className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top">Top</SelectItem>
                      <SelectItem value="bottom">Bottom</SelectItem>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Panel transparency</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      How see-through the panel is. 100% is fully opaque.
                    </div>
                  </div>
                  <div className="flex w-48 shrink-0 items-center gap-3">
                    <Slider
                      min={30}
                      max={100}
                      step={5}
                      value={[Math.round(quickTerminal.opacity * 100)]}
                      onValueChange={([value]) => applyQuickTerminalOpacity(value / 100)}
                    />
                    <span className="w-10 text-right font-mono text-xs text-muted-foreground">
                      {Math.round(quickTerminal.opacity * 100)}%
                    </span>
                  </div>
                </div>

                {renderHotkeyRow(
                  "quick-terminal",
                  "Quick Terminal hotkey",
                  "The system-wide shortcut that opens or closes the panel.",
                  { showSwitch: false },
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="mt-4 space-y-4 pb-10">
            {/* Vault must be unlocked to access these settings */}
            {vaultSt?.initialized && !vaultSt.unlocked && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Vault Locked</CardTitle>
                  <CardDescription className="text-xs">
                    Unlock the vault from the Hosts tab to change these settings.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            {/* Lock Policy */}
            {vaultSt?.initialized && vaultSt.unlocked && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Ask for Master Password</CardTitle>
                  <CardDescription className="text-xs">
                    When should the app ask for your master password?
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {(
                    [
                      { value: "on_restart", label: "After system restart", desc: "Stay unlocked between app launches; ask again after logout or restart" },
                      { value: "on_screen_lock", label: "After screen lock", desc: "Lock the vault whenever the screen is locked" },
                      { value: "on_app_close", label: "After closing the app", desc: "Always ask when reopening the app" },
                      { value: "never", label: "Never", desc: "Stay unlocked indefinitely — only lock manually" },
                    ] as { value: LockPolicy; label: string; desc: string }[]
                  ).map(({ value, label, desc }) => (
                    <button
                      key={value}
                      onClick={() => void handleSetLockPolicy(value)}
                      className={`flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                        lockPolicy === value
                          ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]/10"
                          : "border-border hover:border-muted-foreground/40"
                      }`}
                    >
                      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                        lockPolicy === value
                          ? "border-[var(--color-brand-cyan)]"
                          : "border-muted-foreground/40"
                      }`}>
                        {lockPolicy === value && (
                          <span className="h-2 w-2 rounded-full bg-[var(--color-brand-cyan)]" />
                        )}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-foreground">{label}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}

            {vaultSt && !vaultSt.initialized && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Password Vault</CardTitle>
                  <CardDescription className="text-xs">
                    No vault created yet. Open the main window to set up a master password.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            {vaultSt?.initialized && vaultSt.unlocked && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Change Master Password</CardTitle>
                  <CardDescription className="text-xs">
                    Re-encrypts the vault key. All host passwords remain intact.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <input
                    type="password"
                    placeholder="Current password"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                  />
                  <input
                    type="password"
                    placeholder="New password"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                  />
                  <input
                    type="password"
                    placeholder="Confirm new password"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleChangePw(); }}
                  />
                  {pwError && <p className="text-xs text-red-400">{pwError}</p>}
                  <Button size="sm" onClick={() => void handleChangePw()} disabled={pwLoading}>
                    {pwLoading ? "Saving…" : "Change Password"}
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="sync" className="mt-4 space-y-4 pb-10">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Sync Backend</CardTitle>
                <CardDescription className="text-xs">
                  Sync hosts, snippets, port forwards, and settings across your devices — via a
                  local folder, Google Drive, Dropbox, or a host you already manage over SSH.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {syncStatusState?.backend ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Connected: <span className="text-foreground">{syncBackendLabel(syncStatusState.backend)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last synced:{" "}
                      {syncStatusState.lastSyncAt
                        ? new Date(syncStatusState.lastSyncAt).toLocaleString()
                        : "never"}{" "}
                      (blob v{syncStatusState.lastSyncedBlobVersion})
                    </p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {(
                        [
                          { kind: "localDir", label: "Local Folder" },
                          { kind: "googleDrive", label: "Google Drive" },
                          { kind: "dropbox", label: "Dropbox" },
                          { kind: "sftp", label: "My Server" },
                        ] as { kind: SyncBackendConfig["kind"]; label: string }[]
                      ).map(({ kind, label }) => (
                        <button
                          key={kind}
                          onClick={() => setSyncBackendKind(kind)}
                          className={`rounded-lg border px-3 py-2 text-center text-xs font-medium transition-colors ${
                            syncBackendKind === kind
                              ? "border-[var(--color-brand-cyan)] bg-[var(--color-brand-cyan)]/10 text-foreground"
                              : "border-border text-muted-foreground hover:border-muted-foreground/40"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {syncBackendKind === "localDir" && (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="/path/to/synced/folder"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                          value={localDirPath}
                          onChange={(e) => setLocalDirPath(e.target.value)}
                        />
                        <Button size="sm" variant="outline" onClick={() => void handleBrowseLocalDir()}>
                          Browse…
                        </Button>
                      </div>
                    )}

                    {(syncBackendKind === "googleDrive" || syncBackendKind === "dropbox") && (
                      <p className="text-xs text-muted-foreground">
                        Clicking Connect opens your browser to authorize access. Data is encrypted
                        with your master password before upload — {syncBackendKind === "googleDrive" ? "Google" : "Dropbox"} never
                        sees host passwords or SSH keys in plaintext.
                      </p>
                    )}

                    {syncBackendKind === "sftp" && (
                      <>
                        <Select value={sftpHostId} onValueChange={setSftpHostId}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Choose a host to sync through" />
                          </SelectTrigger>
                          <SelectContent>
                            {syncableHosts.map((h) => (
                              <SelectItem key={h.id} value={h.id}>
                                {h.name} ({h.user}@{h.hostname})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <input
                          type="text"
                          placeholder="Remote path"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                          value={sftpRemotePath}
                          onChange={(e) => setSftpRemotePath(e.target.value)}
                        />
                      </>
                    )}

                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={syncSshKeysToggle}
                        onChange={(e) => setSyncSshKeysToggle(e.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-[var(--color-brand-cyan)]"
                      />
                      Also sync SSH private keys (stored encrypted, off by default)
                    </label>
                    <Button
                      size="sm"
                      onClick={() => void handleConnectSync()}
                      disabled={
                        providerConnecting ||
                        (syncBackendKind === "localDir" && !localDirPath.trim()) ||
                        (syncBackendKind === "sftp" && (!sftpHostId || !sftpRemotePath.trim()))
                      }
                    >
                      {providerConnecting ? "Connecting…" : "Connect"}
                    </Button>
                  </>
                )}

                {syncError && <p className="text-xs text-red-400">{syncError}</p>}
              </CardContent>
            </Card>

            {syncStatusState?.backend && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Sync Now</CardTitle>
                  <CardDescription className="text-xs">
                    Merges local changes with the remote copy and applies the result immediately.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {syncNeedsPassword && (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Enter your master password to sync (only asked once per session unless the
                        vault&apos;s lock policy clears the cache).
                      </p>
                      <input
                        type="password"
                        placeholder="Master password"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
                        value={syncPassword}
                        onChange={(e) => setSyncPassword(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void runSync(syncPassword); }}
                      />
                    </>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void runSync(syncNeedsPassword ? syncPassword : undefined)}
                      disabled={syncLoading}
                    >
                      {syncLoading ? "Syncing…" : "Sync Now"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleDisconnectSync(false)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
