import type { IDecoration, Terminal } from "@xterm/xterm";
import type { XtermTheme } from "./app-theme";
import { publish } from "./api/transport";

export const semanticHighlightingStorageKey = "termifai:semantic-highlighting";
export const semanticHighlightingChangedEvent = "termifai:semantic-highlighting-changed";

// Enabled unless explicitly turned off — the feature ships on by default.
export function loadSemanticHighlighting(): boolean {
  try {
    return localStorage.getItem(semanticHighlightingStorageKey) !== "0";
  } catch {
    return true;
  }
}

export function saveSemanticHighlighting(enabled: boolean): void {
  try {
    localStorage.setItem(semanticHighlightingStorageKey, enabled ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(semanticHighlightingChangedEvent, { detail: enabled })
  );
  void publish(semanticHighlightingChangedEvent, enabled).catch(() => {
    /* Non-Tauri environments fall back to the window + storage events. */
  });
}

/**
 * Semantic highlighting for terminal output: URLs, IPs, file paths, emails,
 * UUIDs/hashes, timestamps and log-level keywords get a distinct foreground
 * color derived from the active theme's own xterm palette (so every theme
 * colors them differently but harmoniously).
 *
 * Implemented with xterm.js's decoration API (registerMarker +
 * registerDecoration with foregroundColor) — the same mechanism the search
 * addon uses for match highlighting. This recolors rendered cells without
 * touching the PTY byte stream, so it can never corrupt what programs
 * actually receive.
 */

interface HighlightRule {
  name: string;
  regex: RegExp;
  color: (theme: XtermTheme) => string;
}

// Order matters: earlier rules win when matches overlap (a URL contains
// slashes and colons that would otherwise also match the path/IP rules).
const rules: HighlightRule[] = [
  {
    name: "url",
    // Mirrors the WebLinksAddon matcher closely enough that what's clickable
    // is also what's colored.
    regex: /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g,
    color: (t) => t.brightBlue,
  },
  {
    name: "email",
    regex: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    color: (t) => t.brightCyan,
  },
  {
    name: "uuid",
    regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    color: (t) => t.brightMagenta,
  },
  {
    name: "timestamp",
    // ISO-ish dates with optional time/zone, or a standalone HH:MM:SS.
    regex: /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{2}:\d{2}:\d{2}\b/g,
    color: (t) => t.brightBlack,
  },
  {
    name: "ipv6",
    // Requires 4+ groups or a "::" so plain clock times don't match.
    regex: /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b|\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b/g,
    color: (t) => t.cyan,
  },
  {
    name: "ipv4",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
    color: (t) => t.cyan,
  },
  {
    name: "hash",
    // Git/docker-style hex ids; the lookahead requires at least one letter
    // so plain digit runs (PIDs, big numbers) don't match.
    regex: /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
    color: (t) => t.brightMagenta,
  },
  {
    name: "path",
    // Unix paths anchored at /, ~/, ./ or ../ with at least one segment,
    // plus Windows drive paths.
    regex: /(?:~|\.{1,2})?\/(?:[\w.@%+-]+\/)*[\w.@%+-]+\/?|\b[A-Za-z]:\\[\w.\\-]+/g,
    color: (t) => t.magenta,
  },
  {
    name: "log-error",
    regex: /\b(?:error|errors|failed|failure|fatal|panic|denied|exception|critical)\b/gi,
    color: (t) => t.red,
  },
  {
    name: "log-warn",
    regex: /\b(?:warn|warning|warnings|deprecated)\b/gi,
    color: (t) => t.yellow,
  },
  {
    name: "log-success",
    regex: /\b(?:success|successful|succeeded|passed|ok)\b/gi,
    color: (t) => t.green,
  },
];

interface LineRecord {
  text: string;
  decorations: IDecoration[];
}

const SCAN_DEBOUNCE_MS = 80;
// Upper bound on remembered lines: decorations in scrollback stay alive (they
// scrolled through the viewport once), but the bookkeeping map is pruned so a
// long-running session doesn't grow without bound.
const MAX_TRACKED_LINES = 4000;

export function attachSemanticHighlighter(
  term: Terminal,
  getTheme: () => XtermTheme
): { refresh: () => void; setEnabled: (enabled: boolean) => void; dispose: () => void } {
  // absolute buffer line -> what we last saw there
  const tracked = new Map<number, LineRecord>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let enabled = loadSemanticHighlighting();

  const disposeLine = (rec: LineRecord) => {
    for (const d of rec.decorations) d.dispose();
  };

  const scanViewport = () => {
    if (disposed || !enabled) return;
    const buf = term.buffer.active;
    // Decorations aren't supported in the alternate buffer (vim, etc.).
    if (buf.type === "alternate") return;
    const theme = getTheme();
    const cursorAbs = buf.baseY + buf.cursorY;

    for (let vy = 0; vy < term.rows; vy++) {
      const abs = buf.viewportY + vy;
      const line = buf.getLine(abs);
      if (!line) continue;
      const text = line.translateToString(true);

      const prev = tracked.get(abs);
      if (prev) {
        if (prev.text === text) continue;
        disposeLine(prev);
        tracked.delete(abs);
      }
      if (!text) continue;

      const decorations: IDecoration[] = [];
      const claimed: Array<[number, number]> = [];
      for (const rule of rules) {
        rule.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.regex.exec(text))) {
          const start = m.index;
          const end = start + m[0].length;
          if (m[0].length === 0) {
            rule.regex.lastIndex++;
            continue;
          }
          if (claimed.some(([s, e]) => start < e && end > s)) continue;
          const marker = term.registerMarker(abs - cursorAbs);
          if (!marker) continue;
          const deco = term.registerDecoration({
            marker,
            x: start,
            width: m[0].length,
            foregroundColor: rule.color(theme),
            layer: "top",
          });
          if (deco) {
            decorations.push(deco);
            claimed.push([start, end]);
          } else {
            marker.dispose();
          }
        }
      }
      tracked.set(abs, { text, decorations });
    }

    if (tracked.size > MAX_TRACKED_LINES) {
      const keys = [...tracked.keys()].sort((a, b) => a - b);
      for (const key of keys.slice(0, tracked.size - MAX_TRACKED_LINES)) {
        // Only the bookkeeping is dropped for old scrollback lines — their
        // decorations stay attached to their markers until trimmed.
        tracked.delete(key);
      }
    }
  };

  const schedule = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      scanViewport();
    }, SCAN_DEBOUNCE_MS);
  };

  const disposables = [
    term.onWriteParsed(schedule),
    term.onScroll(schedule),
    term.onResize(() => {
      // Reflow rewrites line wrapping, shifting absolute positions — a stale
      // map would pin decorations to the wrong columns. Start over.
      refresh();
    }),
  ];

  // Full re-scan with fresh colors; used on theme change.
  const refresh = () => {
    for (const rec of tracked.values()) disposeLine(rec);
    tracked.clear();
    schedule();
  };

  schedule();

  return {
    refresh,
    setEnabled: (next: boolean) => {
      if (next === enabled) return;
      enabled = next;
      if (next) {
        schedule();
      } else {
        for (const rec of tracked.values()) disposeLine(rec);
        tracked.clear();
      }
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const d of disposables) d.dispose();
      for (const rec of tracked.values()) disposeLine(rec);
      tracked.clear();
    },
  };
}
