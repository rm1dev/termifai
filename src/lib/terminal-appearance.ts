import { publish } from "./api/transport";

export const terminalFonts = [
  "Source Code Pro",
  "Source Code Pro Medium",
  "Fira Mono",
  "Fira Mono Medium",
  "Inconsolata-g",
  "Anonymous Pro",
  "Ubuntu Mono",
  "Droid Sans Mono",
  "Dejavu Sans Mono",
  "PT Mono",
  "Cascadia Code",
  "Fira Code",
  "JetBrains Mono",
  "Meslo",
  "Vazir Code",
] as const;

export type TerminalFont = (typeof terminalFonts)[number];

export interface TerminalAppearance {
  fontFamily: TerminalFont;
  fontSize: number;
  lineHeight: number;
}

export const terminalAppearanceChangedEvent = "termifai:terminal-appearance-changed";
export const terminalAppearanceStorageKey = "termifai:terminal-appearance";

export const defaultTerminalAppearance: TerminalAppearance = {
  fontFamily: "Vazir Code",
  fontSize: 12,
  lineHeight: 1.1,
};

const fallbackFontFamily = "ui-monospace, monospace";

export function getTerminalFontStack(fontFamily: string) {
  return `"${fontFamily}", ${fallbackFontFamily}`;
}

export async function ensureTerminalFontLoaded(appearance: TerminalAppearance) {
  const fontFamily = getTerminalFontStack(appearance.fontFamily);
  const fontSize = clampTerminalFontSize(appearance.fontSize);

  try {
    await document.fonts.load(`${fontSize}px ${fontFamily}`);
  } catch {
    /* Font loading is best-effort; xterm will still attempt to render. */
  }
}

export function loadTerminalAppearance(): TerminalAppearance {
  try {
    const stored = localStorage.getItem(terminalAppearanceStorageKey);
    if (!stored) return defaultTerminalAppearance;

    const parsed = JSON.parse(stored) as Partial<TerminalAppearance>;
    const fontFamily = terminalFonts.includes(parsed.fontFamily as TerminalFont)
      ? (parsed.fontFamily as TerminalFont)
      : defaultTerminalAppearance.fontFamily;
    const fontSize =
      typeof parsed.fontSize === "number" && Number.isFinite(parsed.fontSize)
        ? clampTerminalFontSize(parsed.fontSize)
        : defaultTerminalAppearance.fontSize;
    const lineHeight =
      typeof parsed.lineHeight === "number" && Number.isFinite(parsed.lineHeight)
        ? clampTerminalLineHeight(parsed.lineHeight)
        : defaultTerminalAppearance.lineHeight;

    return { fontFamily, fontSize, lineHeight };
  } catch {
    return defaultTerminalAppearance;
  }
}

export function getTerminalAppearanceUpdatedAt(): string | undefined {
  return localStorage.getItem(`${terminalAppearanceStorageKey}:updatedAt`) ?? undefined;
}

export function saveTerminalAppearance(appearance: TerminalAppearance) {
  const normalized = {
    ...appearance,
    fontSize: clampTerminalFontSize(appearance.fontSize),
    lineHeight: clampTerminalLineHeight(appearance.lineHeight),
  };

  localStorage.setItem(terminalAppearanceStorageKey, JSON.stringify(normalized));
  localStorage.setItem(`${terminalAppearanceStorageKey}:updatedAt`, new Date().toISOString());
  window.dispatchEvent(
    new CustomEvent<TerminalAppearance>(terminalAppearanceChangedEvent, {
      detail: normalized,
    })
  );

  void publish(terminalAppearanceChangedEvent, normalized).catch(() => {
    /* Non-Tauri environments fall back to localStorage + storage events. */
  });

  void import("@/lib/sync-settings-cache").then((m) => m.pushSyncSettingsCache());
}

export function clampTerminalFontSize(fontSize: number) {
  return Math.min(24, Math.max(8, fontSize));
}

export function clampTerminalLineHeight(lineHeight: number) {
  return Math.min(2, Math.max(1, Number(lineHeight.toFixed(1))));
}
