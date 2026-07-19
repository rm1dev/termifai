import type { IBufferLine, IDecoration, Terminal } from "@xterm/xterm";
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
 *
 * Performance note: decorations are kept ONLY for the visible viewport.
 * Keeping them alive in scrollback (the old behaviour) made high-volume
 * structured logs — docker compose logs, access logs full of IPs/paths —
 * pile up tens of thousands of decorations and stall the whole UI.
 *
 * Contrast note: decorations use layer "bottom", skip the cursor line, and
 * skip any line that still has inverse/reverse-video cells. Shells
 * (zsh/fish/…) paint bracketed-paste with reverse-video; after Ctrl+C the
 * cancelled line is no longer the cursor line but often keeps those cells,
 * so decorating paths/IPs on top made paste unreadable again.
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

/** شل برای paste از reverse video استفاده می‌کنه؛ روی اون FG تزئینی نذار */
function lineHasInverse(line: IBufferLine): boolean {
  if (line.length === 0) return false;
  const scratch = line.getCell(0);
  if (!scratch) return false;
  for (let x = 0; x < line.length; x++) {
    if (line.getCell(x, scratch)?.isInverse()) return true;
  }
  return false;
}

const SCAN_DEBOUNCE_MS = 80;
// وقتی استریم سنگینه (لاگ داکر و مشابه) اسکن رو عقب بنداز تا صف write خالی بشه
const BUSY_DEBOUNCE_MS = 250;
const BUSY_WRITE_WINDOW_MS = 200;
const BUSY_WRITE_THRESHOLD = 8;
const IDLE_RESUME_MS = 180;

export function attachSemanticHighlighter(
  term: Terminal,
  getTheme: () => XtermTheme
): { refresh: () => void; setEnabled: (enabled: boolean) => void; dispose: () => void } {
  // فقط خط‌های داخل viewport رو نگه می‌داریم — اسکرول‌بک decoration نمی‌خواد
  const tracked = new Map<number, LineRecord>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let enabled = loadSemanticHighlighting();
  let writeStamps: number[] = [];
  let busy = false;

  const disposeLine = (rec: LineRecord) => {
    for (const d of rec.decorations) d.dispose();
  };

  const clearAll = () => {
    for (const rec of tracked.values()) disposeLine(rec);
    tracked.clear();
  };

  const noteWrite = () => {
    const now = performance.now();
    writeStamps.push(now);
    // فقط پنجرهٔ اخیر رو نگه دار
    const cutoff = now - BUSY_WRITE_WINDOW_MS;
    while (writeStamps.length > 0 && writeStamps[0]! < cutoff) {
      writeStamps.shift();
    }
    const wasBusy = busy;
    busy = writeStamps.length >= BUSY_WRITE_THRESHOLD;
    // وسط سیل خروجی، decorationهای قبلی هم هزینهٔ رندرن — پاکشون کن
    if (busy && !wasBusy && tracked.size > 0) clearAll();

    // بعد از آخرین write صبر کن؛ اگه دیگه چیزی نیومد، هایلایت رو برگردون
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      const was = busy;
      busy = false;
      writeStamps = [];
      if (was) schedule(true);
    }, IDLE_RESUME_MS);
  };

  const scanViewport = () => {
    if (disposed || !enabled) return;
    const buf = term.buffer.active;
    // Decorations aren't supported in the alternate buffer (vim, etc.).
    if (buf.type === "alternate") {
      clearAll();
      return;
    }
    // هنوز در حال بمباران خروجی هستیم — اسکن رو بگذار برای idle
    if (busy) return;

    const theme = getTheme();
    const cursorAbs = buf.baseY + buf.cursorY;
    const visible = new Set<number>();

    for (let vy = 0; vy < term.rows; vy++) {
      const abs = buf.viewportY + vy;
      visible.add(abs);
      // خط فعلی ورودی (paste/typing) رو هایلایت نکن — با reverse-video شل قاطی می‌شه
      if (abs === cursorAbs) {
        const live = tracked.get(abs);
        if (live) {
          disposeLine(live);
          tracked.delete(abs);
        }
        continue;
      }
      const line = buf.getLine(abs);
      if (!line) continue;
      // بعد از Ctrl+C خط paste‌شده هنوز inverse داره؛ روش decoration نذار
      if (lineHasInverse(line)) {
        const inv = tracked.get(abs);
        if (inv) {
          disposeLine(inv);
          tracked.delete(abs);
        }
        continue;
      }
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
            // زیر selection/paste-highlight تا متن همیشه خوانا بمونه
            layer: "bottom",
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

    // خط‌هایی که از viewport خارج شدن رو واقعاً dispose کن، نه فقط از Map حذف
    for (const [abs, rec] of tracked) {
      if (!visible.has(abs)) {
        disposeLine(rec);
        tracked.delete(abs);
      }
    }
  };

  const schedule = (force = false) => {
    if (disposed || !enabled) return;
    if (timer) {
      if (!force) return;
      clearTimeout(timer);
      timer = null;
    }
    const delay = busy ? BUSY_DEBOUNCE_MS : SCAN_DEBOUNCE_MS;
    timer = setTimeout(() => {
      timer = null;
      scanViewport();
    }, delay);
  };

  const onWrite = () => {
    noteWrite();
    schedule();
  };

  const disposables = [
    term.onWriteParsed(onWrite),
    term.onScroll(() => schedule()),
    term.onResize(() => {
      // Reflow rewrites line wrapping, shifting absolute positions — a stale
      // map would pin decorations to the wrong columns. Start over.
      refresh();
    }),
  ];

  // Full re-scan with fresh colors; used on theme change.
  const refresh = () => {
    clearAll();
    busy = false;
    writeStamps = [];
    schedule(true);
  };

  schedule();

  return {
    refresh,
    setEnabled: (next: boolean) => {
      if (next === enabled) return;
      enabled = next;
      if (next) {
        schedule(true);
      } else {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        clearAll();
        busy = false;
        writeStamps = [];
      }
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      for (const d of disposables) d.dispose();
      clearAll();
    },
  };
}
