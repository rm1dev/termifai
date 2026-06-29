import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import * as Select from "@radix-ui/react-select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";

interface SftpPermissionsDialogProps {
  open: boolean;
  sessionId: string;
  path: string;
  onClose: () => void;
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

export function SftpPermissionsDialog({ open, sessionId, path, onClose }: SftpPermissionsDialogProps) {
  const [grid, setGrid] = useState<PermGrid>(octalToGrid("755"));
  const [octalInput, setOctalInput] = useState("755");
  const [chmodRecursive, setChmodRecursive] = useState(false);
  const [users, setUsers] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState("root");
  const [selectedGroup, setSelectedGroup] = useState("root");
  const [chownRecursive, setChownRecursive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    Promise.all([
      invoke<{ permissions: number; owner: string; group: string }>("sftp_stat_remote", { sessionId, path }),
      invoke<{ users: string[]; groups: string[] }>("sftp_get_users_groups", { sessionId }),
    ])
      .then(([stat, ug]) => {
        const octal = (stat.permissions & 0o777).toString(8).padStart(3, "0");
        setOctalInput(octal);
        setGrid(octalToGrid(octal));
        setSelectedUser(stat.owner);
        setSelectedGroup(stat.group);
        setUsers(ug.users);
        setGroups(ug.groups);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
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
    try {
      await invoke("sftp_chmod", { sessionId, path, mode: octalInput, recursive: chmodRecursive });
    } catch (e) { setError(String(e)); }
  };

  const applyChown = async () => {
    try {
      await invoke("sftp_chown", { sessionId, path, user: selectedUser, group: selectedGroup, recursive: chownRecursive });
    } catch (e) { setError(String(e)); }
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

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none">
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
              <Button size="sm" className="mt-3" onClick={() => void applyChmod()}>Apply chmod</Button>

              <Separator className="my-5" />

              {/* Ownership */}
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ownership</p>
              <div className="space-y-3">
                {[
                  { label: "User", value: selectedUser, options: users, onChange: setSelectedUser },
                  { label: "Group", value: selectedGroup, options: groups, onChange: setSelectedGroup },
                ].map(({ label, value, options, onChange }) => (
                  <div key={label} className="flex items-center justify-between border-t border-border py-3">
                    <span className="text-sm text-muted-foreground">{label}</span>
                    <Select.Root value={value} onValueChange={onChange}>
                      <Select.Trigger className="flex h-8 w-36 items-center justify-between rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-[var(--color-brand-cyan)]">
                        <Select.Value />
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="z-[100] max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
                          <Select.Viewport>
                            {options.map((o) => (
                              <Select.Item key={o} value={o} className="flex cursor-pointer items-center px-3 py-1.5 text-sm text-foreground outline-none hover:bg-[var(--color-surface)] data-[highlighted]:bg-[var(--color-surface)]">
                                <Select.ItemText>{o}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={chownRecursive} onChange={(e) => setChownRecursive(e.target.checked)} className="h-3.5 w-3.5 rounded accent-[var(--color-brand-cyan)]" />
                  Recursive (-R)
                </label>
                <Button size="sm" onClick={() => void applyChown()}>Apply chown</Button>
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
