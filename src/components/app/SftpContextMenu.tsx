import * as ContextMenu from "@radix-ui/react-context-menu";
import type { LocalFileEntry, RemoteFileEntry } from "./types";

interface SftpContextMenuProps {
  isLocal: boolean;
  isConnected: boolean;
  file: LocalFileEntry | RemoteFileEntry;
  hasClipboard: boolean;
  children: React.ReactNode;
  onOpen: () => void;
  onOpenWith: () => void;
  onDownload: () => void;
  onUpload: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onEditPermissions: () => void;
}

const itemCls = "flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-[var(--color-surface-2)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";
const sepCls = "my-1 h-px bg-border";

export function SftpContextMenu({
  isLocal, isConnected, file, hasClipboard, children,
  onOpen, onOpenWith, onDownload, onUpload, onCopy, onPaste,
  onRename, onDelete, onRefresh, onEditPermissions,
}: SftpContextMenuProps) {
  const isDir = file.is_dir;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl">

          {!isDir && (
            <>
              <ContextMenu.Item className={itemCls} onSelect={onOpen}>Open</ContextMenu.Item>
              <ContextMenu.Item className={itemCls} onSelect={onOpenWith}>Open With…</ContextMenu.Item>
              <ContextMenu.Separator className={sepCls} />
            </>
          )}

          {!isLocal && isConnected && (
            <ContextMenu.Item className={itemCls} onSelect={onDownload}>Download</ContextMenu.Item>
          )}
          {isLocal && (
            <ContextMenu.Item className={itemCls} disabled={!isConnected} onSelect={onUpload}>Upload</ContextMenu.Item>
          )}

          <ContextMenu.Item className={itemCls} onSelect={onCopy}>Copy</ContextMenu.Item>
          <ContextMenu.Item className={itemCls} disabled={!hasClipboard} onSelect={onPaste}>Paste</ContextMenu.Item>

          <ContextMenu.Separator className={sepCls} />

          <ContextMenu.Item className={itemCls} onSelect={onRename}>Rename</ContextMenu.Item>
          <ContextMenu.Item className={`${itemCls} text-red-400 data-[highlighted]:text-red-300`} onSelect={onDelete}>Delete</ContextMenu.Item>

          <ContextMenu.Separator className={sepCls} />
          <ContextMenu.Item className={itemCls} onSelect={onRefresh}>Refresh</ContextMenu.Item>

          {!isLocal && isConnected && (
            <>
              <ContextMenu.Separator className={sepCls} />
              <ContextMenu.Item className={itemCls} onSelect={onEditPermissions}>Edit Permissions</ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
