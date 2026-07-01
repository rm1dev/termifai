import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { vaultInit } from "@/lib/api/vault";
import { ShieldCheck } from "lucide-react";

interface VaultSetupDialogProps {
  open: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

export function VaultSetupDialog({ open, onSuccess, onCancel }: VaultSetupDialogProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (password.length < 8) {
      setError("Master password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await vaultInit(password);
      onSuccess();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-96 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none"
        >
          <div className="mb-5 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-[var(--color-brand-cyan)]" />
            <Dialog.Title className="text-sm font-semibold text-foreground">
              Create Master Password
            </Dialog.Title>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Your host passwords will be encrypted with this master password. It is not stored anywhere — keep it safe.
          </p>
          <div className="space-y-3">
            <input
              type="password"
              autoFocus
              placeholder="Master password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
            />
            <input
              type="password"
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
            />
          </div>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={loading}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={loading}>
              {loading ? "Creating…" : "Create Vault"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
