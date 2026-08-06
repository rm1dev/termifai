import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import type { XtermTheme } from "./app-theme";

/**
 * DOM overlay برای خطوط RTL (فارسی/عربی/عبری).
 *
 * مشکل: xterm موقع selection جزئی، spanها رو می‌شکنه و shaping حروف از بین می‌ره.
 * راه‌حل: خطوط RTL رو در رندرر DOM خود xterm مخفی می‌کنیم و یک لایه HTML شفاف
 * روش می‌کشیم که متن رو یک‌تکه (با shaping مرورگر) نشون بده.
 *
 * چون لایه شفافه:
 * - پس‌زمینه همون پس‌زمینه واقعی ترمیناله (هیچ رنگ جدایی paint نمی‌شه)
 * - مستطیل selection خود xterm از زیر دیده می‌شه — پس هایلایت حین درگ زنده‌ست
 *
 * کپی: ستون‌های selection در xterm «بصری»ان ولی بافر «منطقی»ه؛ با نگاشت
 * BiDi ساده (getRtlAwareSelection) متنی که واقعاً زیر هایلایته کپی می‌شه.
 */

export interface RtlOverlayHandle {
  refresh: () => void;
  dispose: () => void;
}

type CellDims = {
  cellW: number;
  cellH: number;
  top: number;
  left: number;
};

type CoreDims = {
  _core?: {
    _renderService?: {
      dimensions?: {
        css: {
          cell: { width: number; height: number };
          canvas?: { top?: number; left?: number };
        };
      };
    };
  };
};

const RTL_SCAN_FLOOR = 0x0590;

function isStrongRtlCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff) ||
    (cp >= 0x10800 && cp <= 0x10fff) ||
    (cp >= 0x1e800 && cp <= 0x1eeff)
  );
}

export function lineHasRtl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < RTL_SCAN_FLOOR) continue;
    let cp = unit;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (isStrongRtlCodePoint(cp)) return true;
  }
  return false;
}

// ── نگاشت منطقی ↔ بصری (BiDi ساده‌شده) ────────────────────────────────────

type BidiClass = "L" | "R" | "EN" | "N";

interface CellItem {
  chars: string;
  col: number;
  width: number;
  cls: BidiClass;
}

const NEUTRAL_RE = /^[\p{P}\p{S}\p{Z}\p{C}\p{M}\s]/u;

function classify(chars: string): BidiClass {
  const cp = chars.codePointAt(0);
  if (cp === undefined) return "N";
  // ارقام قبل از R چک می‌شن چون ۰-۹ عربی/فارسی داخل بازه RTL هستن
  if (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x0660 && cp <= 0x0669) ||
    (cp >= 0x06f0 && cp <= 0x06f9)
  ) {
    return "EN";
  }
  if (NEUTRAL_RE.test(chars)) return "N";
  if (isStrongRtlCodePoint(cp)) return "R";
  return "L";
}

/** سلول‌های یک خط بافر به‌صورت آیتم (کاراکتر + ستون + عرض)، بدون فاصله‌های انتهایی */
function lineItems(line: IBufferLine, workCell: IBufferCell): CellItem[] {
  const items: CellItem[] = [];
  let lastContent = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, workCell);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue;
    const raw = cell.getChars();
    const chars = raw || " ";
    if (raw && raw !== " ") lastContent = items.length;
    items.push({ chars, col: x, width, cls: classify(chars) });
  }
  return items.slice(0, lastContent + 1);
}

/**
 * ترتیب بصری آیتم‌ها: runهای RTL برعکس می‌شن (سطح پایه LTR)،
 * ارقام داخل run راست‌به‌چپ ترتیب خودشون رو نگه می‌دارن.
 */
function visualOrderItems(items: CellItem[]): CellItem[] {
  const n = items.length;
  if (n === 0) return items;

  // نزدیک‌ترین کاراکتر strong (L/R) قبل و بعد از هر آیتم
  const prevStrong: ("L" | "R")[] = new Array(n);
  const nextStrong: ("L" | "R")[] = new Array(n);
  let strong: "L" | "R" = "L";
  for (let i = 0; i < n; i++) {
    prevStrong[i] = strong;
    if (items[i].cls === "L" || items[i].cls === "R") strong = items[i].cls as "L" | "R";
  }
  strong = "L";
  for (let i = n - 1; i >= 0; i--) {
    nextStrong[i] = strong;
    if (items[i].cls === "L" || items[i].cls === "R") strong = items[i].cls as "L" | "R";
  }

  // خنثی‌ها و ارقام فقط وقتی بین دو R محصورن جزو جریان RTL حساب می‌شن
  const isRtlFlow = (i: number): boolean => {
    if (items[i].cls === "R") return true;
    if (items[i].cls === "L") return false;
    return prevStrong[i] === "R" && nextStrong[i] === "R";
  };

  const out: CellItem[] = [];
  let i = 0;
  while (i < n) {
    const rtl = isRtlFlow(i);
    let j = i;
    while (j < n && isRtlFlow(j) === rtl) j++;
    const run = items.slice(i, j);
    if (rtl) {
      run.reverse();
      // بلوک‌های عددی بعد از reverse باید ترتیب اصلی‌شون برگرده (اعداد LTR می‌مونن)
      let a = 0;
      while (a < run.length) {
        if (run[a].cls === "EN") {
          let b = a;
          while (b < run.length && run[b].cls === "EN") b++;
          for (let lo = a, hi = b - 1; lo < hi; lo++, hi--) {
            const tmp = run[lo];
            run[lo] = run[hi];
            run[hi] = tmp;
          }
          a = b;
        } else {
          a++;
        }
      }
    }
    out.push(...run);
    i = j;
  }
  return out;
}

/** متنی که «بصری» زیر ستون‌های [sx, ex) این خطه — خروجی به ترتیب منطقی (خوانا) */
function extractVisualRange(
  line: IBufferLine,
  workCell: IBufferCell,
  sx: number,
  ex: number
): string {
  const items = lineItems(line, workCell);
  const visual = visualOrderItems(items);
  const picked: CellItem[] = [];
  let vc = 0;
  for (const it of visual) {
    const start = vc;
    vc += it.width;
    if (start < ex && vc > sx) picked.push(it);
  }
  picked.sort((a, b) => a.col - b.col);
  return picked.map((it) => it.chars).join("");
}

/**
 * جایگزین term.getSelection برای کپی: روی خطوط RTL، متنی که کاربر «می‌بینه»
 * انتخاب کرده برمی‌گردونه نه بایت‌های همون ستون‌ها در بافر منطقی.
 */
export function getRtlAwareSelection(term: Terminal): string {
  const native = term.getSelection();
  const sel = term.getSelectionPosition();
  if (!sel || !native) return native;

  const buf = term.buffer.active;
  let hasRtl = false;
  for (let y = sel.start.y; y <= sel.end.y; y++) {
    const line = buf.getLine(y);
    if (line && lineHasRtl(line.translateToString(true))) {
      hasRtl = true;
      break;
    }
  }
  if (!hasRtl) return native;

  const workCell = buf.getNullCell();
  const parts: string[] = [];
  for (let y = sel.start.y; y <= sel.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const sx = y === sel.start.y ? sel.start.x : 0;
    const ex = y === sel.end.y ? sel.end.x : term.cols;
    const text = line.translateToString(true);
    const segment = lineHasRtl(text)
      ? extractVisualRange(line, workCell, sx, ex)
      : line.translateToString(true, sx, ex);
    parts.push(segment);
    // خط‌های wrap شده ادامه همون خطن — newline نذار
    const nextWrapped = y < sel.end.y && (buf.getLine(y + 1)?.isWrapped ?? false);
    if (y < sel.end.y && !nextWrapped) parts.push("\n");
  }
  return parts.join("");
}

// ── رنگ‌ها ──────────────────────────────────────────────────────────────────

function hexRgb(n: number): string {
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgb(${r},${g},${b})`;
}

function palette256(idx: number, base: string[]): string {
  if (idx < 16) return base[idx] ?? base[7] ?? "#e5e5e5";
  if (idx < 232) {
    const i = idx - 16;
    const r = Math.floor(i / 36) * 51;
    const g = Math.floor((i % 36) / 6) * 51;
    const b = (i % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const gray = (idx - 232) * 10 + 8;
  return `rgb(${gray},${gray},${gray})`;
}

function buildAnsi16(theme: XtermTheme): string[] {
  return [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
}

function cellFg(cell: IBufferCell, theme: XtermTheme, ansi16: string[]): string {
  if (cell.isFgDefault()) return theme.foreground;
  if (cell.isFgRGB()) return hexRgb(cell.getFgColor());
  if (cell.isFgPalette()) return palette256(cell.getFgColor(), ansi16);
  return theme.foreground;
}

function cellBg(cell: IBufferCell, theme: XtermTheme, ansi16: string[]): string | null {
  if (cell.isBgDefault()) return null;
  if (cell.isBgRGB()) return hexRgb(cell.getBgColor());
  if (cell.isBgPalette()) return palette256(cell.getBgColor(), ansi16);
  return null;
}

/** برای inverse لازمه یه رنگ پس‌زمینه واقعی داشته باشیم (تم ممکنه transparent باشه) */
function resolveOpaqueBg(themeBg: string): string {
  const raw = (themeBg || "").trim();
  const transparent =
    !raw ||
    raw === "transparent" ||
    /^#([0-9a-f]{6}|[0-9a-f]{3})00$/i.test(raw) ||
    /^rgba?\([^)]*,\s*0\s*\)$/i.test(raw);
  if (!transparent) return raw;
  const cssBg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  return cssBg || "#1a1b26";
}

// ── لایه overlay ────────────────────────────────────────────────────────────

function getCellDims(term: Terminal, screen: HTMLElement): CellDims {
  const d = (term as unknown as CoreDims)._core?._renderService?.dimensions?.css;
  if (d?.cell?.width && d.cell.height) {
    return {
      cellW: d.cell.width,
      cellH: d.cell.height,
      top: d.canvas?.top ?? 0,
      left: d.canvas?.left ?? 0,
    };
  }
  if (term.rows > 0 && term.cols > 0 && screen.clientWidth > 0) {
    return {
      cellW: screen.clientWidth / term.cols,
      cellH: screen.clientHeight / term.rows,
      top: 0,
      left: 0,
    };
  }
  return { cellW: 8, cellH: 17, top: 0, left: 0 };
}

function styleKey(fg: string, bg: string | null, bold: boolean, dim: boolean, italic: boolean): string {
  return `${fg}|${bg ?? ""}|${bold ? 1 : 0}${dim ? 1 : 0}${italic ? 1 : 0}`;
}

const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";

function isWordSeparator(chars: string, separators: string): boolean {
  const first = chars[0];
  return first === undefined || separators.includes(first);
}

export function attachRtlOverlay(
  term: Terminal,
  getTheme: () => XtermTheme
): RtlOverlayHandle {
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  const rootEl = term.element as HTMLElement | null;
  if (!screen || !rootEl) {
    return { refresh: () => {}, dispose: () => {} };
  }

  const overlay = document.createElement("div");
  overlay.className = "termifai-rtl-overlay";
  overlay.setAttribute("aria-hidden", "true");
  screen.appendChild(overlay);

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const workCell = term.buffer.active.getNullCell();

  // ردیف‌های DOM خود xterm — روی خطوط RTL مخفی می‌شن تا متن دوبار رندر نشه
  const setRowVisibility = (hiddenRows: Set<number>) => {
    const rows = screen.querySelector(".xterm-rows");
    if (!rows) return false;
    const children = rows.children;
    for (let i = 0; i < children.length; i++) {
      (children[i] as HTMLElement).style.visibility = hiddenRows.has(i) ? "hidden" : "";
    }
    return true;
  };

  const clear = () => {
    overlay.replaceChildren();
    setRowVisibility(new Set());
  };

  const paint = () => {
    if (disposed) return;

    const buf = term.buffer.active;
    // vim و TUIها: دست نزن
    if (buf.type === "alternate") {
      clear();
      return;
    }

    const theme = getTheme();
    const ansi16 = buildAnsi16(theme);
    const dims = getCellDims(term, screen);
    const fontFamily = term.options.fontFamily || "monospace";
    const fontSize = term.options.fontSize || 12;
    const absCursor = buf.baseY + buf.cursorY;
    let inverseBg: string | null = null;

    overlay.replaceChildren();
    const hiddenRows = new Set<number>();

    for (let vy = 0; vy < term.rows; vy++) {
      const absY = buf.viewportY + vy;
      const line = buf.getLine(absY);
      if (!line) continue;

      const text = line.translateToString(true);
      if (!text || !lineHasRtl(text)) continue;

      hiddenRows.add(vy);

      const lineEl = document.createElement("div");
      lineEl.className = "termifai-rtl-line";
      lineEl.style.top = `${dims.top + vy * dims.cellH}px`;
      lineEl.style.left = `${dims.left}px`;
      lineEl.style.height = `${dims.cellH}px`;
      lineEl.style.lineHeight = `${dims.cellH}px`;
      lineEl.style.fontSize = `${fontSize}px`;
      lineEl.style.fontFamily = fontFamily;

      let currentSpan: HTMLSpanElement | null = null;
      let currentKey = "";

      const cols = Math.min(line.length, term.cols);
      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x, workCell);
        if (!cell) continue;
        const width = cell.getWidth();
        if (width === 0) continue;

        const chars = cell.isInvisible() ? " ".repeat(width) : cell.getChars() || " ".repeat(width);
        const bold = !!cell.isBold();
        const dim = !!cell.isDim();
        const italic = !!cell.isItalic();
        let fg = cellFg(cell, theme, ansi16);
        let bg = cellBg(cell, theme, ansi16);
        if (cell.isInverse()) {
          // پس‌زمینه پیش‌فرض ممکنه transparent باشه — یه بار resolve کن
          if (inverseBg === null) inverseBg = resolveOpaqueBg(theme.background);
          const swappedFg = bg ?? inverseBg;
          bg = fg;
          fg = swappedFg;
        }
        const isRtlChar = isStrongRtlCodePoint(chars.codePointAt(0) || 0) || (chars.charCodeAt(0) >= 0x0600 && chars.charCodeAt(0) <= 0x06ff);
        const key = styleKey(fg, bg, bold, dim, italic) + (isRtlChar ? "|RTL" : "|LTR");

        const forceNewSpan = !isRtlChar;

        if (!currentSpan || key !== currentKey || forceNewSpan) {
          currentSpan = document.createElement("span");
          currentSpan.style.color = fg;
          if (bg) currentSpan.style.backgroundColor = bg;
          if (bold) currentSpan.style.fontWeight = "bold";
          if (dim) currentSpan.style.opacity = "0.55";
          if (italic) currentSpan.style.fontStyle = "italic";
          
          if (!isRtlChar) {
            currentSpan.style.display = "inline-block";
            currentSpan.style.width = `${dims.cellW * width}px`;
            currentSpan.style.textAlign = "center";
          }
          
          lineEl.appendChild(currentSpan);
          currentKey = key;
        }
        currentSpan.textContent = (currentSpan.textContent || "") + chars;
      }

      // کرسر داخل ردیف مخفی‌شده گمه — خودمون می‌کشیم
      if (absY === absCursor) {
        const cursor = document.createElement("div");
        cursor.className = "termifai-rtl-cursor";
        cursor.style.left = `${buf.cursorX * dims.cellW}px`;
        cursor.style.width = `${Math.max(1, dims.cellW)}px`;
        cursor.style.background = theme.cursor || theme.foreground;
        lineEl.appendChild(cursor);
      }

      overlay.appendChild(lineEl);
    }

    setRowVisibility(hiddenRows);
  };

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      paint();
    }, 16);
  };

  // Cmd+C بومی (WebKit) از مسیر داخلی xterm کپی می‌کنه که از نگاشت ما خبر نداره؛
  // تو فاز capture جلوش رو می‌گیریم و متن نگاشت‌شده رو می‌ذاریم
  const onCopy = (ev: ClipboardEvent) => {
    if (!term.hasSelection() || !ev.clipboardData) return;
    const mapped = getRtlAwareSelection(term);
    if (!mapped) return;
    ev.clipboardData.setData("text/plain", mapped);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  rootEl.addEventListener("copy", onCopy, true);

  // دابل‌کلیک: xterm مرز کلمه رو روی بافر منطقی حساب می‌کنه که با چیدمان بصری
  // خطوط RTL نمی‌خونه — بعد از انتخابِ خودش، کلمه بصری زیر کلیک رو select می‌کنیم
  const onDblClick = (ev: MouseEvent) => {
    const buf = term.buffer.active;
    if (buf.type === "alternate") return;
    const dims = getCellDims(term, screen);
    if (dims.cellW <= 0 || dims.cellH <= 0) return;
    const rect = screen.getBoundingClientRect();
    const clickCol = Math.floor((ev.clientX - rect.left - dims.left) / dims.cellW);
    const vy = Math.floor((ev.clientY - rect.top - dims.top) / dims.cellH);
    if (vy < 0 || vy >= term.rows || clickCol < 0) return;
    const absY = buf.viewportY + vy;
    const line = buf.getLine(absY);
    if (!line) return;
    const text = line.translateToString(true);
    if (!text || !lineHasRtl(text)) return;

    const visual = visualOrderItems(lineItems(line, workCell));
    const separators = term.options.wordSeparator ?? DEFAULT_WORD_SEPARATORS;

    // آیتم زیر کلیک در مختصات بصری
    const starts: number[] = [];
    let vc = 0;
    let idx = -1;
    for (let i = 0; i < visual.length; i++) {
      starts.push(vc);
      if (clickCol >= vc && clickCol < vc + visual[i].width) idx = i;
      vc += visual[i].width;
    }
    if (idx < 0 || isWordSeparator(visual[idx].chars, separators)) return;

    let a = idx;
    let b = idx;
    while (a > 0 && !isWordSeparator(visual[a - 1].chars, separators)) a--;
    while (b + 1 < visual.length && !isWordSeparator(visual[b + 1].chars, separators)) b++;
    const startCol = starts[a];
    const endCol = starts[b] + visual[b].width;
    term.select(startCol, absY, endCol - startCol);
  };
  screen.addEventListener("dblclick", onDblClick);

  const disposables = [
    term.onWriteParsed(schedule),
    term.onScroll(schedule),
    term.onResize(schedule),
  ];

  // رندر اول بعد از layout
  requestAnimationFrame(schedule);

  return {
    refresh: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      paint();
    },
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const d of disposables) d.dispose();
      rootEl.removeEventListener("copy", onCopy, true);
      screen.removeEventListener("dblclick", onDblClick);
      clear();
      overlay.remove();
    },
  };
}
