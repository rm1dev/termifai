import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { vaultInit, vaultUnlock } from "@/lib/api/vault";
import { vaultInitFromSync } from "@/lib/api/sync";
import { LockKeyhole, ShieldCheck } from "lucide-react";

interface VaultGateProps {
  /** Whether a vault already exists (unlock) or must be created (setup). */
  initialized: boolean;
  /** Whether the gate's tab is currently visible (drives autofocus). */
  active: boolean;
  /** Called after a successful unlock or vault creation. */
  onUnlocked: () => void;
}

/**
 * Inline gate that covers the Hosts view while the vault is locked.
 * Unlike a modal, the protected content is never rendered behind it — a
 * wrong password simply keeps the gate in place with an inline error.
 */
export function VaultGate({ initialized, active, onUnlocked }: VaultGateProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const [restoreMode, setRestoreMode] = useState(false);
  const [restorePath, setRestorePath] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const submitRestore = async () => {
    setRestoreError(null);
    if (!restorePath.trim() || !restorePassword) return;
    setRestoreLoading(true);
    try {
      await vaultInitFromSync({ kind: "localDir", path: restorePath.trim() }, restorePassword);
      onUnlocked();
    } catch (e: unknown) {
      setRestoreError(String(e));
    } finally {
      setRestoreLoading(false);
    }
  };

  // The vaults tab stays mounted (display toggled), so the autoFocus attribute
  // can't fire when the gate mounts while hidden. Focus explicitly whenever the
  // tab becomes visible.
  useEffect(() => {
    if (active) passwordRef.current?.focus();
  }, [active]);

  const submit = async () => {
    setError(null);
    if (initialized) {
      if (!password) return;
      setLoading(true);
      try {
        await vaultUnlock(password);
        onUnlocked();
      } catch {
        setError("Wrong password. Please try again.");
        setPassword("");
      } finally {
        setLoading(false);
      }
      return;
    }
    // Setup flow
    if (password.length < 8) {
      setError("Master password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await vaultInit(password);
      onUnlocked();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (!initialized && restoreMode) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="w-80 rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl">
          <div className="mb-5 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-[var(--color-brand-cyan)]" />
            <h2 className="text-sm font-semibold text-foreground">Restore from Sync</h2>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Point this at the synced folder from your other device and enter the master password
            you use there. Nothing is created locally unless the password is correct.
          </p>
          <div className="space-y-3">
            <input
              type="text"
              autoFocus
              placeholder="/path/to/synced/folder"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
              value={restorePath}
              onChange={(e) => setRestorePath(e.target.value)}
            />
            <input
              type="password"
              placeholder="Master password (from your other device)"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
              value={restorePassword}
              onChange={(e) => setRestorePassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRestore();
              }}
            />
          </div>
          {restoreError && <p className="mt-2 text-xs text-red-400">{restoreError}</p>}
          <div className="mt-5 flex items-center justify-between">
            <button
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => { setRestoreMode(false); setRestoreError(null); }}
            >
              Back to create vault
            </button>
            <Button size="sm" onClick={() => void submitRestore()} disabled={restoreLoading}>
              {restoreLoading ? "Restoring…" : "Restore"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="w-80 rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          {initialized ? (
            <LockKeyhole className="h-5 w-5 text-[var(--color-brand-cyan)]" />
          ) : (
            <ShieldCheck className="h-5 w-5 text-[var(--color-brand-cyan)]" />
          )}
          <h2 className="text-sm font-semibold text-foreground">
            {initialized ? "Unlock Vault" : "Create Master Password"}
          </h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          {initialized
            ? "Enter your master password to decrypt host credentials."
            : "Your host passwords will be encrypted with this master password. It is not stored anywhere — keep it safe."}
        </p>
        <div className="space-y-3">
          <input
            ref={passwordRef}
            type="password"
            autoFocus
            placeholder="Master password"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {!initialized && (
            <input
              type="password"
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          )}
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-5 flex items-center justify-between">
          {!initialized ? (
            <button
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setRestoreMode(true)}
            >
              Restore from sync
            </button>
          ) : <span />}
          <Button size="sm" onClick={() => void submit()} disabled={loading}>
            {loading
              ? initialized
                ? "Unlocking…"
                : "Creating…"
              : initialized
                ? "Unlock"
                : "Create Vault"}
          </Button>
        </div>
      </div>
    </div>
  );
}
