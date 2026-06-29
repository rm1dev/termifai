import React from "react";
import type { JSX } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { FolderPlus, RefreshCw } from "lucide-react";

interface SftpEmptyContextMenuProps {
  children: React.ReactNode;
  onNewFolder: () => void;
  onRefresh: () => void;
}

export function SftpEmptyContextMenu({ children, onNewFolder, onRefresh }: SftpEmptyContextMenuProps): JSX.Element {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-[var(--color-surface-2)] p-1 shadow-md"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm text-foreground outline-none hover:bg-[var(--color-surface)] data-[highlighted]:bg-[var(--color-surface)]"
            onSelect={onNewFolder}
          >
            <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            New Folder
          </ContextMenu.Item>
          <ContextMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm text-foreground outline-none hover:bg-[var(--color-surface)] data-[highlighted]:bg-[var(--color-surface)]"
            onSelect={onRefresh}
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            Refresh
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
