import type { OsKind } from "./types";

export function OsBadge({ os, size = 40 }: { os: OsKind; size?: number }) {
  const palette: Record<OsKind, { bg: string; ring: string }> = {
    ubuntu: { bg: "var(--color-brand-orange)", ring: "oklch(0.55 0.2 40)" },
    debian: { bg: "oklch(0.62 0.22 10)", ring: "oklch(0.5 0.22 10)" },
    centos: { bg: "var(--color-brand-yellow)", ring: "oklch(0.7 0.16 85)" },
    alpine: { bg: "oklch(0.6 0.18 230)", ring: "oklch(0.45 0.18 230)" },
    macos: { bg: "oklch(0.5 0.02 255)", ring: "oklch(0.4 0.02 255)" },
    windows: { bg: "oklch(0.6 0.16 230)", ring: "oklch(0.45 0.16 230)" },
  };
  const c = palette[os];
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(180deg, ${c.bg}, ${c.ring})`,
        boxShadow: "inset 0 1px 0 oklch(1 0 0 / 25%)",
      }}
    >
      <OsGlyph os={os} size={Math.round(size * 0.55)} />
    </div>
  );
}

function OsGlyph({ os, size }: { os: OsKind; size: number }) {
  // Simple stylized glyph circle — abstract distro representation
  if (os === "ubuntu" || os === "debian" || os === "centos" || os === "alpine") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="white" strokeOpacity="0.9" strokeWidth="1.6" />
        <circle cx="12" cy="4.5" r="1.8" fill="white" />
        <circle cx="5.5" cy="15.5" r="1.8" fill="white" />
        <circle cx="18.5" cy="15.5" r="1.8" fill="white" />
        <circle cx="12" cy="12" r="2.4" fill="white" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="white">
      <rect x="3" y="4" width="18" height="14" rx="2" />
    </svg>
  );
}
