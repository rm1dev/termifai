import { useEffect, useRef, useState } from "react";
import { ChevronDown, X, type LucideIcon } from "lucide-react";

export function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-popover p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ModalActions({ onClose, onConfirm, confirmDisabled, confirmLabel }: { onClose: () => void; onConfirm: () => void; confirmDisabled?: boolean; confirmLabel: string }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      <button onClick={onClose} className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground">
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        className="h-8 rounded-md bg-[var(--color-brand-orange)] px-3 text-xs font-semibold text-[var(--color-primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50 hover:enabled:opacity-90"
      >
        {confirmLabel}
      </button>
    </div>
  );
}

export function ToolbarButton({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground/90 hover:bg-[var(--color-surface-2)]">
      {icon}
      <span>{label}</span>
      {hint && <span className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground">i</span>}
    </button>
  );
}

export function IconButton({ icon, title, active, onClick }: { icon: React.ReactNode; title: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-md",
        active ? "bg-[var(--color-surface-2)] text-foreground" : "text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground",
      ].join(" ")}
    >
      {icon}
    </button>
  );
}

interface SplitMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}
export function SplitButton({
  primary,
  onPrimary,
  menu,
}: {
  primary: React.ReactNode;
  onPrimary?: () => void;
  menu?: SplitMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="flex h-7 overflow-hidden rounded-md bg-[var(--color-surface-2)] text-xs font-medium">
        <button
          onClick={onPrimary}
          className="flex items-center gap-1 px-2.5 text-foreground hover:bg-white/5"
        >
          {primary}
        </button>
        <div className="w-px bg-border" />
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center px-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && menu && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
          {menu.map((it) => (
            <button
              key={it.label}
              onClick={() => { setOpen(false); it.onClick(); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-[var(--color-surface-2)]"
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  cta,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  cta?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-surface-2)]">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{subtitle}</p>
      {cta && (
        <button className="mt-5 rounded-md bg-[var(--color-brand-orange)] px-4 py-2 text-xs font-semibold text-[var(--color-primary-foreground)] hover:opacity-90">
          {cta}
        </button>
      )}
    </div>
  );
}

export function HostModalSectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="text-sm font-semibold text-foreground">{title}</span>
    </div>
  );
}

export function HostModalRow({
  label,
  children,
  rightText,
}: {
  label: string;
  children: React.ReactNode;
  rightText?: string;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {children}
        {rightText && <span className="text-sm text-muted-foreground">{rightText}</span>}
      </div>
    </div>
  );
}

export function HostModalInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      dir="ltr"
      className={[
        "h-8 w-40 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-orange)]/40",
        props.className,
      ].filter(Boolean).join(" ")}
    />
  );
}

export function HostModalToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={[
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-[var(--color-brand-orange)]" : "bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "left-[18px]" : "left-0.5",
        ].join(" ")}
      />
    </button>
  );
}
