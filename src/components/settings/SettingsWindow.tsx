import { X, Palette, Keyboard, Minus, Plus, Check, Shield } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
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
import {
  clampTerminalFontSize,
  clampTerminalLineHeight,
  loadTerminalAppearance,
  saveTerminalAppearance,
  terminalFonts,
  type TerminalFont,
} from "@/lib/terminal-appearance";
import { toast } from "sonner";
import { vaultStatus, vaultLock, vaultChangeMasterPassword } from "@/lib/api/vault";
import type { VaultStatus } from "@/lib/api/vault";
import {
  appThemes,
  loadAppTheme,
  saveAppTheme,
  type AppThemeId,
} from "@/lib/app-theme";
import {
  eventToShortcutBinding,
  formatShortcut,
  loadShortcuts,
  resetShortcut,
  saveShortcuts,
  shortcutDefinitions,
  shortcutsChangedEvent,
  shortcutsStorageKey,
  type ShortcutActionId,
  type ShortcutMap,
} from "@/lib/shortcuts";

export function SettingsWindow() {
  const [terminalAppearance, setTerminalAppearance] = useState(loadTerminalAppearance);
  const [selectedThemeId, setSelectedThemeId] = useState(loadAppTheme().id);
  const [shortcuts, setShortcuts] = useState(loadShortcuts);
  const [editingShortcutId, setEditingShortcutId] = useState<ShortcutActionId | null>(null);
  const [vaultSt, setVaultSt] = useState<VaultStatus | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwLoading, setPwLoading] = useState(false);

  useEffect(() => {
    vaultStatus().then(setVaultSt).catch(console.error);
  }, []);

  const handleLock = async () => {
    try {
      await vaultLock();
      setVaultSt((s) => (s ? { ...s, unlocked: false } : s));
      toast.success("Vault locked");
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
  const resetShortcutToDefault = (actionId: ShortcutActionId) => {
    const nextShortcuts = resetShortcut(shortcuts, actionId);
    setShortcuts(nextShortcuts);
    saveShortcuts(nextShortcuts);
  };

  const isMac = platform === "macos";

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
        <Tabs defaultValue="theme" className="mx-auto max-w-3xl">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="theme" className="gap-2">
              <Palette className="h-4 w-4" />
              Theme
            </TabsTrigger>
            <TabsTrigger value="shortcuts" className="gap-2">
              <Keyboard className="h-4 w-4" />
              Shortcuts
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-2">
              <Shield className="h-4 w-4" />
              Security
            </TabsTrigger>
          </TabsList>

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

          </TabsContent>

          <TabsContent value="shortcuts" className="mt-4">
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

          <TabsContent value="security" className="mt-4 space-y-4 pb-10">
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

            {vaultSt?.initialized && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Vault Status</CardTitle>
                  <CardDescription className="text-xs">
                    {vaultSt.unlocked ? "Vault is unlocked." : "Vault is locked."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!vaultSt.unlocked}
                    onClick={() => void handleLock()}
                  >
                    Lock Vault
                  </Button>
                </CardContent>
              </Card>
            )}

            {vaultSt?.initialized && (
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
        </Tabs>
      </main>
    </div>
  );
}
