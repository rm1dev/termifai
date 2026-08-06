import { useState, useEffect } from "react";
import { sftpCall } from "@/lib/api/sftp";
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface SftpPermissionsDialogProps {
  open: boolean;
  sessionId: string;
  path: string;
  onClose: () => void;
  /** بعد از اعمال موفق chmod/chown صدا زده می‌شه تا لیست ریموت رفرش بشه */
  onApplied?: () => void;
}

type PermBits = { r: boolean; w: boolean; x: boolean };
type PermGrid = { owner: PermBits; group: PermBits; others: PermBits };

function bitsToOctal(grid: PermGrid): string {
  const toNum = (b: PermBits) => (b.r ? 4 : 0) + (b.w ? 2 : 0) + (b.x ? 1 : 0);
  return `${toNum(grid.owner)}${toNum(grid.group)}${toNum(grid.others)}`;
}

function octalToGrid(octal: string): PermGrid {
  const pad = octal.padStart(3, "0");
  const toB = (n: number): PermBits => ({ r: !!(n & 4), w: !!(n & 2), x: !!(n & 1) });
  return {
    owner: toB(parseInt(pad[0] ?? "0")),
    group: toB(parseInt(pad[1] ?? "0")),
    others: toB(parseInt(pad[2] ?? "0")),
  };
}

function gridToSymbolic(grid: PermGrid): string {
  const s = (b: PermBits) => `${b.r ? "r" : "-"}${b.w ? "w" : "-"}${b.x ? "x" : "-"}`;
  return `-${s(grid.owner)}${s(grid.group)}${s(grid.others)}`;
}

/** Select قابل‌جستجو با Popover + Command — مناسب لیست‌های بلند یوزر/گروه */
function SearchableSelect({
  value,
  options,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  // اگه مقدار فعلی توی لیست نباشه (LDAP و…) خالی نشون نده
  const opts = options.includes(value) || !value ? options : [value, ...options];

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-8 w-44 items-center justify-between rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)]"
        >
          <span className="truncate">{value || "—"}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[100] w-44 p-0"
        align="end"
        // فوکوس اتومات نده که دیالوگ پرنت قاطی نکنه
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <Command>
          <CommandInput placeholder={placeholder} className="h-9" />
          <CommandList className="max-h-48">
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {opts.map((o) => (
                <CommandItem
                  key={o}
                  value={o}
                  onSelect={(v) => {
                    // cmdk گاهی value رو lowercase می‌کنه؛ اصل گزینه رو از لیست پیدا کن
                    const match = opts.find((x) => x.toLowerCase() === v.toLowerCase()) ?? o;
                    onChange(match);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-3.5 w-3.5", value === o ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function SftpPermissionsDialog({ open, sessionId, path, onClose, onApplied }: SftpPermissionsDialogProps) {
  const [grid, setGrid] = useState<PermGrid>(octalToGrid("755"));
  const [octalInput, setOctalInput] = useState("755");
  const [chmodRecursive, setChmodRecursive] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState("root");
  const [selectedGroup, setSelectedGroup] = useState("root");
  const [chownRecursive, setChownRecursive] = useState(false);
  const [currentUser, setCurrentUser] = useState("");
  const [applying, setApplying] = useState<"chmod" | "chown" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // پشت‌سرهم، نه Promise.all — سشن SSH یکی‌ست و موازی‌سازی کانال باز/بست بیشتر می‌کنه
    (async () => {
      try {
        const stat = await sftpCall<{ permissions: number; owner: string; group: string }>(
          "sftp_stat_remote",
          { sessionId, path },
        );
        if (cancelled) return;
        const octal = (stat.permissions & 0o777).toString(8).padStart(3, "0");
        setOctalInput(octal);
        setGrid(octalToGrid(octal));
        setSelectedUser(stat.owner);
        setSelectedGroup(stat.group);

        const ug = await sftpCall<{ users: string[]; groups: string[]; currentUser: string }>(
          "sftp_get_users_groups",
          { sessionId },
        );
        if (cancelled) return;
        setUsers(ug.users);
        setGroups(ug.groups);
        setCurrentUser(ug.currentUser);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, sessionId, path]);

  const handleGridChange = (role: keyof PermGrid, bit: keyof PermBits, val: boolean) => {
    const next = { ...grid, [role]: { ...grid[role], [bit]: val } };
    setGrid(next);
    setOctalInput(bitsToOctal(next));
  };

  const handleOctalChange = (v: string) => {
    setOctalInput(v);
    if (/^[0-7]{3}$/.test(v)) setGrid(octalToGrid(v));
  };

  const applyChmod = async () => {
    // اعتبارسنجی سمت کلاینت؛ مقدار نامعتبر (مثل 888) نباید بره سمت سرور
    if (!/^[0-7]{3,4}$/.test(octalInput)) {
      setError(`Invalid octal mode: "${octalInput}"`);
      return;
    }
    setApplying("chmod");
    setError(null);
    try {
      await sftpCall("sftp_chmod", { sessionId, path, mode: octalInput, recursive: chmodRecursive });
      toast.success("Permissions updated");
      onApplied?.();
    } catch (e) { setError(String(e)); }
    finally { setApplying(null); }
  };

  const applyChown = async () => {
    setApplying("chown");
    setError(null);
    try {
      await sftpCall("sftp_chown", { sessionId, path, user: selectedUser, group: selectedGroup, recursive: chownRecursive });
      toast.success("Ownership updated");
      onApplied?.();
    } catch (e) { setError(String(e)); }
    finally { setApplying(null); }
  };

  const rows: { label: string; role: keyof PermGrid }[] = [
    { label: "Owner", role: "owner" },
    { label: "Group", role: "group" },
    { label: "Others", role: "others" },
  ];
  const cols: { label: string; bit: keyof PermBits }[] = [
    { label: "Read", bit: "r" },
    { label: "Write", bit: "w" },
    { label: "Execute", bit: "x" },
  ];

  // کلیک روی لایهٔ dismissِ Select/Popover (که روی دیالوگ پهن شده) نباید خود دیالوگ رو ببنده
  const blockOutsideDismiss = (e: Event) => {
    e.preventDefault();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[480px] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none"
          onPointerDownOutside={blockOutsideDismiss}
          onInteractOutside={blockOutsideDismiss}
        >
          <Dialog.Title className="mb-5 text-sm font-semibold text-foreground">Edit Permissions</Dialog.Title>

          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

          {!loading && (
            <>
              {/* File Access */}
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">File Access</p>
              <div className="mb-1 grid grid-cols-4 text-xs font-medium text-muted-foreground">
                <div />
                {cols.map((c) => <div key={c.bit} className="text-center">{c.label}</div>)}
              </div>
              {rows.map((row) => (
                <div key={row.role} className="grid grid-cols-4 items-center border-t border-border py-3">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  {cols.map((col) => (
                    <div key={col.bit} className="flex justify-center">
                      <Switch.Root
                        checked={grid[row.role][col.bit]}
                        onCheckedChange={(v) => handleGridChange(row.role, col.bit, v)}
                        className="relative inline-flex h-5 w-9 cursor-pointer rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-[var(--color-brand-cyan)] data-[state=unchecked]:bg-muted outline-none"
                      >
                        <Switch.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
                      </Switch.Root>
                    </div>
                  ))}
                </div>
              ))}

              <div className="mt-3 flex items-center gap-3">
                <input
                  className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-center text-sm font-mono text-foreground outline-none focus:border-[var(--color-brand-cyan)]"
                  value={octalInput}
                  onChange={(e) => handleOctalChange(e.target.value)}
                  maxLength={3}
                />
                <span className="font-mono text-sm text-muted-foreground">{gridToSymbolic(grid)}</span>
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={chmodRecursive} onChange={(e) => setChmodRecursive(e.target.checked)} className="h-3.5 w-3.5 rounded accent-[var(--color-brand-cyan)]" />
                  Recursive (-R)
                </label>
              </div>
              <Button size="sm" className="mt-3" disabled={applying !== null} onClick={() => void applyChmod()}>
                {applying === "chmod" ? "Applying…" : "Apply chmod"}
              </Button>

              <Separator className="my-5" />

              {/* Ownership */}
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ownership</p>
              {/* chown فقط با روت جواب می‌ده؛ به یوزر غیرروت هشدار می‌دیم که fail می‌شه */}
              {currentUser && currentUser !== "root" && (
                <p className="mb-3 text-[11px] leading-relaxed text-amber-400/90">
                  Logged in as «{currentUser}» — changing ownership requires root. chmod also only works on files you own.
                </p>
              )}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-t border-border py-3">
                  <span className="text-sm text-muted-foreground">User</span>
                  <SearchableSelect
                    value={selectedUser}
                    options={users}
                    onChange={setSelectedUser}
                    placeholder="Search user…"
                  />
                </div>
                <div className="flex items-center justify-between border-t border-border py-3">
                  <span className="text-sm text-muted-foreground">Group</span>
                  <SearchableSelect
                    value={selectedGroup}
                    options={groups}
                    onChange={setSelectedGroup}
                    placeholder="Search group…"
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Button size="sm" disabled={applying !== null} onClick={() => void applyChown()}>
                  {applying === "chown" ? "Applying…" : "Apply chown"}
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={chownRecursive} onChange={(e) => setChownRecursive(e.target.checked)} className="h-3.5 w-3.5 rounded accent-[var(--color-brand-cyan)]" />
                  Recursive (-R)
                </label>
              </div>
            </>
          )}

          <div className="mt-5 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
