import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { vaultUnlock } from "@/lib/api/vault";
import { LockKeyhole } from "lucide-react";

interface VaultUnlockDialogProps {
  open: boolean;
  onSuccess: () => void;
}

export function VaultUnlockDialog({ open, onSuccess }: VaultUnlockDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleUnlock = async () => {
    if (!password) return;
    setError(null);
    setLoading(true);
    try {
      await vaultUnlock(password);
      onSuccess();
    } catch {
      setError("Wrong password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="mb-5 flex items-center gap-3">
            <LockKeyhole className="h-5 w-5 text-[var(--color-brand-cyan)]" />
            <Dialog.Title className="text-sm font-semibold text-foreground">
              Unlock Vault
            </Dialog.Title>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Enter your master password to decrypt host credentials.
          </p>
          <input
            type="password"
            autoFocus
            placeholder="Master password"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleUnlock();
            }}
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end">
            <Button size="sm" onClick={() => void handleUnlock()} disabled={loading}>
              {loading ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
