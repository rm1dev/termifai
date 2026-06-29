import React, { useState, useEffect } from "react";
import type { JSX } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface SftpNewFolderDialogProps {
  open: boolean;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function SftpNewFolderDialog({ open, onConfirm, onClose }: SftpNewFolderDialogProps): JSX.Element {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-[var(--color-surface-2)] p-5 shadow-xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className="mb-4 text-sm font-medium text-foreground">New Folder</Dialog.Title>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="Folder name"
            className="w-full rounded border border-border bg-[var(--color-surface)] px-3 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-[var(--color-brand-cyan)]"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim()}
              className="rounded bg-[var(--color-brand-cyan)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
