import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";

interface SftpRenameDialogProps {
  open: boolean;
  currentName: string;
  onConfirm: (newName: string) => void;
  onClose: () => void;
}

export function SftpRenameDialog({ open, currentName, onConfirm, onClose }: SftpRenameDialogProps) {
  const [value, setValue] = useState(currentName);

  useEffect(() => {
    if (open) setValue(currentName);
  }, [open, currentName]);

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentName) onConfirm(trimmed);
    else onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-[var(--color-surface)] p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="mb-4 text-sm font-semibold text-foreground">Rename</Dialog.Title>
          <input
            autoFocus
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)] focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
              if (e.key === "Escape") onClose();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleConfirm}>Rename</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
