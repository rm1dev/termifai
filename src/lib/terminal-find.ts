import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import type { XtermTheme } from "./app-theme";

/** حالت تطبیق — یکی‌شون فعال می‌مونه، مثل ترمینال مک */
export type FindMatchMode = "contains" | "startsWith" | "endsWith";

export type FindPatternId =
  | "tab"
  | "paragraphBreak"
  | "lineBreak"
  | "pageBreak"
  | "anyCharacters"
  | "anyWordCharacters"
  | "wordBreak"
  | "whiteSpace"
  | "digits"
  | "email"
  | "url"
  | "ipAddress";

export type FindPart =
  | { kind: "text"; value: string }
  | { kind: "token"; id: FindPatternId };

export interface FindPatternDef {
  id: FindPatternId;
  /** برچسب کوتاه روی pill */
  pill: string;
  /** عنوان کامل تو منو */
  label: string;
  /** بخش منوی Match Pattern */
  section: "breaks" | "classes" | "data";
  /** آیکون/نماد کنار لیبل (اختیاری) */
  icon?: string;
  /** رنگ پس‌زمینهٔ pill */
  pillClass: string;
  regex: string;
}

export interface FindOptions {
  caseInsensitive: boolean;
  wrapAround: boolean;
  matchMode: FindMatchMode;
}

export const defaultFindOptions: FindOptions = {
  caseInsensitive: true,
  wrapAround: true,
  matchMode: "contains",
};

// الگوهای email/url/ip رو از هایلایتر قرض گرفتیم تا نتیجه یکی باشه
const EMAIL_REGEX = String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b`;
const URL_REGEX =
  String.raw`(?:https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>\`]*[^\s"':,.!?{}|\\^~[\]\`()<>]`;
const IPV4_REGEX = String.raw`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b`;
const IPV6_REGEX =
  String.raw`\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b|\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b`;
const IP_ADDRESS_REGEX = String.raw`(?:${IPV4_REGEX})|(?:${IPV6_REGEX})`;

export const findPatterns: FindPatternDef[] = [
  {
    id: "tab",
    pill: "Tab",
    label: "Tab",
    section: "breaks",
    icon: "→",
    pillClass: "bg-[oklch(0.45_0.08_250)] text-white",
    regex: String.raw`\t`,
  },
  {
    id: "paragraphBreak",
    pill: "¶",
    label: "Paragraph Break",
    section: "breaks",
    icon: "¶",
    pillClass: "bg-[oklch(0.45_0.08_250)] text-white",
    regex: String.raw`\n\s*\n`,
  },
  {
    id: "lineBreak",
    pill: "↵",
    label: "Line Break",
    section: "breaks",
    icon: "↵",
    pillClass: "bg-[oklch(0.45_0.08_250)] text-white",
    regex: String.raw`\n`,
  },
  {
    id: "pageBreak",
    pill: "↵",
    label: "Page Break",
    section: "breaks",
    icon: "↵",
    pillClass: "bg-[oklch(0.45_0.08_250)] text-white",
    regex: String.raw`\f`,
  },
  {
    id: "anyCharacters",
    pill: "Any",
    label: "Any Characters",
    section: "classes",
    pillClass: "bg-[oklch(0.40_0.02_260)] text-foreground",
    // حداقل یه کاراکتر — .*? خالی عین macOS نیست و SearchAddon رو می‌ترکونه
    regex: String.raw`.+?`,
  },
  {
    id: "anyWordCharacters",
    pill: "Word",
    label: "Any Word Characters",
    section: "classes",
    pillClass: "bg-[oklch(0.40_0.02_260)] text-foreground",
    regex: String.raw`\w+`,
  },
  {
    id: "wordBreak",
    pill: "Break",
    label: "Word Break",
    section: "classes",
    pillClass: "bg-[oklch(0.40_0.02_260)] text-foreground",
    regex: String.raw`\b`,
  },
  {
    id: "whiteSpace",
    pill: "␣",
    label: "White Space",
    section: "classes",
    pillClass: "bg-[oklch(0.40_0.02_260)] text-foreground",
    regex: String.raw`\s+`,
  },
  {
    id: "digits",
    pill: "#",
    label: "Digits",
    section: "classes",
    pillClass: "bg-[oklch(0.40_0.02_260)] text-foreground",
    regex: String.raw`\d+`,
  },
  {
    id: "email",
    pill: "Email",
    label: "Email Address",
    section: "data",
    pillClass: "bg-[oklch(0.48_0.12_200)] text-white",
    regex: EMAIL_REGEX,
  },
  {
    id: "url",
    pill: "URL",
    label: "Web Address",
    section: "data",
    pillClass: "bg-[oklch(0.48_0.14_40)] text-white",
    regex: URL_REGEX,
  },
  {
    id: "ipAddress",
    pill: "IP",
    label: "IP Address",
    section: "data",
    pillClass: "bg-[oklch(0.48_0.10_150)] text-white",
    regex: IP_ADDRESS_REGEX,
  },
];

const patternById = new Map(findPatterns.map((p) => [p.id, p]));

export function getFindPattern(id: FindPatternId): FindPatternDef {
  return patternById.get(id)!;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * draft رو دقیقاً سر caretIndex بین parts می‌چسبونه.
 * caretIndex = 0 یعنی قبل از همه؛ = parts.length یعنی آخر (حالت قبلی).
 */
export function assembleFindParts(
  parts: FindPart[],
  draftText: string,
  caretIndex: number
): FindPart[] {
  const clamped = Math.max(0, Math.min(caretIndex, parts.length));
  if (!draftText) return parts.slice();
  return [
    ...parts.slice(0, clamped),
    { kind: "text", value: draftText },
    ...parts.slice(clamped),
  ];
}

/** کوئری توکنی رو به یه رشتهٔ regex برای SearchAddon تبدیل می‌کنه */
export function compileFindQuery(parts: FindPart[], matchMode: FindMatchMode): string {
  if (parts.length === 0) return "";

  let body = "";
  for (const part of parts) {
    if (part.kind === "text") {
      if (!part.value) continue;
      body += escapeRegex(part.value);
    } else {
      body += getFindPattern(part.id).regex;
    }
  }

  if (!body) return "";

  switch (matchMode) {
    case "startsWith":
      return `^${body}`;
    case "endsWith":
      return `${body}$`;
    default:
      return body;
  }
}

export function hasFindQuery(parts: FindPart[]): boolean {
  return parts.some((p) => (p.kind === "token" ? true : p.value.length > 0));
}

/** نمونهٔ کوتاه برای اینکه ببینیم regex فقط صفر-عرض match می‌ده یا نه */
const ZERO_WIDTH_PROBE = "a b 0";

/**
 * قبل از SearchAddon چک می‌کنیم کوئری معنی‌دار باشه:
 * - روی رشتهٔ خالی match نده (مثل .*? یا \\d*)
 * - اولین match روی probe طول صفر نداشته باشه (مثل \\b تنها)
 */
export function isSearchableFindQuery(
  query: string,
  caseInsensitive: boolean
): boolean {
  if (!query) return false;
  try {
    const flags = caseInsensitive ? "i" : "";
    if (new RegExp(query, flags).test("")) return false;

    const globalFlags = caseInsensitive ? "gi" : "g";
    const probeRe = new RegExp(query, globalFlags);
    const first = probeRe.exec(ZERO_WIDTH_PROBE);
    if (first && first[0].length === 0) return false;

    return true;
  } catch {
    return false;
  }
}

function selectionSpan(term: Terminal, start: BufferPos, end: BufferPos): number {
  return end.x - start.x + term.cols * (end.y - start.y);
}

/** اگه addon یه match صفر-عرض select کرد، decoration رو پاک کن */
function clearZeroWidthSelection(addon: SearchAddon, term: Terminal): boolean {
  const pos = term.getSelectionPosition();
  if (!pos) return false;
  if (selectionSpan(term, pos.start, pos.end) > 0) return false;
  addon.clearActiveDecoration();
  term.clearSelection();
  return true;
}

type Rgb = { r: number; g: number; b: number };

/** #RRGGBB یا #RRGGBBAA رو به RGB تبدیل می‌کنه */
function parseHexColor(hex: string): Rgb {
  const raw = hex.replace(/^#/, "");
  const rgb = raw.length >= 6 ? raw.slice(0, 6) : raw.padEnd(6, "0");
  return {
    r: Number.parseInt(rgb.slice(0, 2), 16),
    g: Number.parseInt(rgb.slice(2, 4), 16),
    b: Number.parseInt(rgb.slice(4, 6), 16),
  };
}

function parseHexAlpha(hex: string): number {
  const raw = hex.replace(/^#/, "");
  if (raw.length < 8) return 1;
  return Number.parseInt(raw.slice(6, 8), 16) / 255;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampRgb(color: Rgb): Rgb {
  return {
    r: clampChannel(color.r),
    g: clampChannel(color.g),
    b: clampChannel(color.b),
  };
}

function toHex(color: Rgb): string {
  const { r, g, b } = clampRgb(color);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return clampRgb({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function scaleToLuminance(color: Rgb, target: number): Rgb {
  const current = relativeLuminance(color);
  if (current <= 0) return color;
  const scale = target / current;
  return clampRgb({ r: color.r * scale, g: color.g * scale, b: color.b * scale });
}

/** selection شفاف تم رو روی پس‌زمینهٔ واقعی ترمینال opaque می‌کنه */
function opaqueSelectionFill(xterm: XtermTheme, mode: "Dark" | "Light"): Rgb {
  const canvas = parseHexColor(mode === "Dark" ? xterm.black : xterm.white);
  const tint = parseHexColor(xterm.selectionBackground);
  const alpha = parseHexAlpha(xterm.selectionBackground);
  return mix(canvas, tint, alpha);
}

/** حداکثر روشنایی پس‌زمینه وقتی متن روشن رویشه — برای WCAG ~3:1 */
function maxBgLuminanceForLightText(fg: Rgb, minContrast = 3): number {
  const fgL = relativeLuminance(fg);
  return Math.max(0, (fgL + 0.05) / minContrast - 0.05);
}

function pickMatchLuminance(xterm: XtermTheme, mode: "Dark" | "Light"): number {
  const fgSamples = [
    xterm.brightGreen,
    xterm.brightCyan,
    xterm.brightWhite,
    xterm.brightYellow,
    xterm.green,
    xterm.cyan,
    xterm.yellow,
    xterm.foreground,
  ].map(parseHexColor);

  const base = mode === "Dark" ? 0.14 : 0.19;
  let cap = base;
  for (const fg of fgSamples) {
    if (relativeLuminance(fg) > 0.2) {
      cap = Math.min(cap, maxBgLuminanceForLightText(fg) * 0.92);
    }
  }
  return Math.max(mode === "Dark" ? 0.09 : 0.14, cap);
}

function pickActiveLuminance(matchL: number, mode: "Dark" | "Light"): number {
  // selection رو clear می‌کنیم، پس active می‌تونه روشن‌تر باشه تا از بقیه جدا بشه
  const boosted = matchL + (mode === "Dark" ? 0.12 : 0.10);
  return Math.min(mode === "Dark" ? 0.30 : 0.34, Math.max(matchL + 0.06, boosted));
}

/**
 * رنگ‌های Find از پالت xterm تم میاد — SearchAddon فقط background/border
 * می‌پذیره، پس پس‌زمینهٔ نسبتاً تیره انتخاب می‌کنیم که متن ANSI روشن
 * (سبز، فیروزه‌ای، سفید، …) روش خوانا بمونه. تم روشن هم همین منطق رو
 * داره؛ متن پیش‌فرض تیره با border متمایز می‌شه.
 */
export function buildFindDecorations(
  xterm: XtermTheme,
  mode: "Dark" | "Light"
): NonNullable<ISearchOptions["decorations"]> {
  const accent = parseHexColor(xterm.blue);
  const warm = parseHexColor(xterm.yellow);
  const canvas = parseHexColor(mode === "Dark" ? xterm.black : xterm.white);
  const selectionFill = opaqueSelectionFill(xterm, mode);

  const matchL = pickMatchLuminance(xterm, mode);
  const activeL = pickActiveLuminance(matchL, mode);

  const baseTint = mix(selectionFill, accent, 0.42);
  let matchBg = scaleToLuminance(mix(canvas, baseTint, mode === "Dark" ? 0.62 : 0.48), matchL);
  // active: پایهٔ گرم از yellow تم (نه blue) تا از matchهای آبی جدا باشه
  const warmBase = mix(canvas, mix(warm, parseHexColor(xterm.red), 0.2), mode === "Dark" ? 0.58 : 0.45);
  let activeBg = scaleToLuminance(warmBase, activeL);

  const fgSamples = [
    xterm.foreground,
    xterm.brightGreen,
    xterm.brightCyan,
    xterm.brightWhite,
    xterm.brightYellow,
    xterm.green,
    xterm.cyan,
    xterm.yellow,
  ].map(parseHexColor);

  let matchTargetL = relativeLuminance(matchBg);
  let activeTargetL = relativeLuminance(activeBg);
  for (const fg of fgSamples) {
    if (contrastRatio(fg, matchBg) < 3) {
      matchTargetL = Math.min(matchTargetL, maxBgLuminanceForLightText(fg) * 0.9);
    }
    if (contrastRatio(fg, activeBg) < 3) {
      activeTargetL = Math.min(activeTargetL, maxBgLuminanceForLightText(fg) * 0.88);
    }
  }
  if (matchTargetL < relativeLuminance(matchBg)) {
    matchBg = scaleToLuminance(matchBg, matchTargetL);
  }
  if (activeTargetL < relativeLuminance(activeBg)) {
    activeBg = scaleToLuminance(activeBg, activeTargetL);
  }
  // scaleToLuminance کروما رو می‌کشه بیرون — کمی زرد تم برگردون، بعد دوباره کنتراست
  activeBg = mix(activeBg, warm, mode === "Dark" ? 0.22 : 0.14);
  for (const fg of fgSamples) {
    if (relativeLuminance(fg) > 0.25 && contrastRatio(fg, activeBg) < 3) {
      activeBg = scaleToLuminance(activeBg, maxBgLuminanceForLightText(fg) * 0.88);
    }
  }

  const matchHex = toHex(matchBg);
  const activeHex = toHex(activeBg);
  // فقط active border داشته باشه — با پچ non-overlapping دیگه خطوط
  // عمودی بین کاراکترها ساخته نمی‌شه (قبلاً از overlapping بود)
  const activeBorder = toHex(
    scaleToLuminance(mix(warm, parseHexColor(xterm.cursor), 0.45), mode === "Dark" ? 0.55 : 0.42)
  );

  return {
    matchBackground: matchHex,
    matchOverviewRuler: matchHex,
    activeMatchBackground: activeHex,
    activeMatchColorOverviewRuler: activeHex,
    activeMatchBorder: activeBorder,
  };
}

export function buildSearchOptions(
  caseInsensitive: boolean,
  xterm: XtermTheme,
  mode: "Dark" | "Light"
): ISearchOptions {
  return {
    regex: true,
    caseSensitive: !caseInsensitive,
    decorations: buildFindDecorations(xterm, mode),
  };
}

type InternalResult = { col: number; row: number; size: number; term: string };

type InternalEngine = {
  _terminal?: Terminal;
  find: (
    term: string,
    startRow: number,
    startCol: number,
    options?: ISearchOptions
  ) => InternalResult | undefined;
  _findInLine: (
    term: string,
    searchPosition: { startRow: number; startCol: number },
    searchOptions?: ISearchOptions,
    isReverseSearch?: boolean
  ) => InternalResult | undefined;
  __termifaiReversePatched?: boolean;
};

type InternalAddon = {
  _terminal?: Terminal;
  _engine?: InternalEngine;
  _decorationManager?: {
    createHighlightDecorations: (
      results: InternalResult[],
      decorations: NonNullable<ISearchOptions["decorations"]>
    ) => void;
    createActiveDecoration: (
      result: InternalResult,
      decorations: NonNullable<ISearchOptions["decorations"]>
    ) => { match: InternalResult; dispose: () => void } | undefined;
  };
  _resultTracker?: {
    searchResults?: InternalResult[];
    updateResults: (results: InternalResult[], limit: number) => void;
    clearSelectedDecoration: () => void;
    selectedDecoration?: { match: InternalResult; dispose: () => void };
  };
  _state?: {
    lastSearchOptions?: ISearchOptions;
  };
  _highlightLimit?: number;
  _highlightAllMatches?: (term: string, searchOptions: ISearchOptions) => void;
  activate?: (terminal: Terminal) => void;
  clearDecorations: (retainCachedSearchTerm?: boolean) => void;
  __termifaiHighlightPatched?: boolean;
  __termifaiActivatePatched?: boolean;
};

/**
 * باگ‌های overlapping در @xterm/addon-search@0.16:
 * ۱) highlight با col+1 جلو می‌ره
 * ۲) findPrevious / _updateMatches (بعد از تایپ) با reverse-regex پسوند کوتاه می‌ده
 */
export function patchSearchAddonNonOverlappingHighlights(): void {
  const proto = SearchAddon.prototype as unknown as InternalAddon;

  if (!proto.__termifaiHighlightPatched) {
    proto._highlightAllMatches = function (this: InternalAddon, term, searchOptions) {
      if (!this._terminal || !this._engine || !this._decorationManager || !this._resultTracker) {
        throw new Error("Cannot use addon until it has been loaded");
      }
      if (!term) {
        this.clearDecorations();
        return;
      }

      this.clearDecorations(true);

      const results: InternalResult[] = [];
      let prevResult: InternalResult | undefined;
      let result = this._engine.find(term, 0, 0, searchOptions);
      const limit = this._highlightLimit ?? 1000;
      const cols = this._terminal.cols;

      while (result && (prevResult?.row !== result.row || prevResult?.col !== result.col)) {
        if (results.length >= limit) break;
        prevResult = result;
        results.push(prevResult);

        // جلو رفتن با طول واقعی match — نه col+1
        let nextCol = prevResult.col + prevResult.size;
        let nextRow = prevResult.row;
        if (nextCol >= cols) {
          nextRow += Math.floor(nextCol / cols);
          nextCol = nextCol % cols;
        }
        result = this._engine.find(term, nextRow, nextCol, searchOptions);
      }

      this._resultTracker.updateResults(results, limit);
      if (searchOptions.decorations) {
        this._decorationManager.createHighlightDecorations(results, searchOptions.decorations);
      }
    };
    proto.__termifaiHighlightPatched = true;
  }

  // بعد از activate، engine هست — reverse regex رو پچ کن (شامل _updateMatches بعد از تایپ)
  if (!proto.__termifaiActivatePatched && typeof proto.activate === "function") {
    const originalActivate = proto.activate;
    proto.activate = function (this: InternalAddon, terminal: Terminal) {
      originalActivate.call(this, terminal);
      patchSearchEngineReverseRegex(this._engine);
    };
    proto.__termifaiActivatePatched = true;
  }
}

/**
 * reverse+regex با lastIndex-=len-1 کوتاه‌ترین پسوند رو برمی‌گردونه.
 * نتیجه‌ش رو به اولین match روبه‌جلو که همون نقطه رو پوشش بده گسترش می‌دیم.
 */
function patchSearchEngineReverseRegex(engine: InternalEngine | undefined): void {
  if (!engine?._findInLine || engine.__termifaiReversePatched) return;

  const original = engine._findInLine.bind(engine);

  engine._findInLine = function (
    term: string,
    searchPosition: { startRow: number; startCol: number },
    searchOptions: ISearchOptions = {},
    isReverseSearch = false
  ) {
    const result = original(term, searchPosition, searchOptions, isReverseSearch);
    if (!result || !isReverseSearch || !searchOptions.regex) return result;

    const terminal = engine._terminal;
    if (!terminal) return result;

    // ابتدای خط منطقی (unwrap)
    let lineStart = result.row;
    while (lineStart > 0) {
      const line = terminal.buffer.active.getLine(lineStart);
      if (!line?.isWrapped) break;
      lineStart -= 1;
    }

    let row = lineStart;
    let col = 0;
    for (let guard = 0; guard < 256; guard += 1) {
      const match = original(term, { startRow: row, startCol: col }, searchOptions, false);
      if (!match) break;

      // match کامل که نقطهٔ شروع نتیجهٔ reverse داخلش باشه
      if (
        match.row === result.row &&
        result.col >= match.col &&
        result.col < match.col + match.size
      ) {
        return match;
      }

      if (match.row > result.row || (match.row === result.row && match.col > result.col)) {
        break;
      }

      col = match.col + match.size;
      row = match.row;
      if (col >= terminal.cols) {
        row += 1;
        col = 0;
      }
    }

    return result;
  };

  engine.__termifaiReversePatched = true;
}

export interface FindResultMeta {
  index: number;
  count: number;
}

/**
 * findPrevious با regex overlapping کوتاه‌ترین پسوند رو می‌گیره
 * (مثلاً moghaddam@gmail.com به‌جای کل ایمیل). به match کاملِ لیست
 * highlight غیرهم‌پوشان snap می‌کنیم.
 * @returns ایندکس match کامل در لیست highlight؛ اگه پیدا نشد -1
 */
export function snapFindSelectionToCanonicalMatch(
  addon: SearchAddon,
  term: Terminal
): number {
  const internal = addon as unknown as InternalAddon;
  const results = internal._resultTracker?.searchResults;
  if (!results?.length) return -1;

  const pos = term.getSelectionPosition();
  if (!pos) return -1;

  const x = pos.start.x;
  const y = pos.start.y;
  const index = results.findIndex(
    (r) => r.row === y && x >= r.col && x < r.col + r.size
  );
  if (index < 0) return -1;
  const canonical = results[index]!;

  // همین الان روی match کاملیم — فقط ایندکس رو برگردون
  if (canonical.col === x && canonical.size === selectionSpan(term, pos.start, pos.end)) {
    return index;
  }

  const decorations = internal._state?.lastSearchOptions?.decorations;
  withFindSelectionSuppressed(() => {
    term.select(canonical.col, canonical.row, canonical.size);
    if (decorations && internal._decorationManager && internal._resultTracker) {
      internal._resultTracker.clearSelectedDecoration();
      const active = internal._decorationManager.createActiveDecoration(
        canonical,
        decorations
      );
      if (active) {
        internal._resultTracker.selectedDecoration = active;
      }
    }
  });
  return index;
}

/** بعد از Next/Previous، ایندکس واقعی رو از لیست highlight غیرهم‌پوشان بخون */
export function getFindResultMeta(addon: SearchAddon, term: Terminal): FindResultMeta {
  const internal = addon as unknown as InternalAddon;
  const results = internal._resultTracker?.searchResults ?? [];
  const count = results.length;
  if (count === 0) return { index: -1, count: 0 };

  const selected = internal._resultTracker?.selectedDecoration?.match;
  if (selected) {
    const exact = results.findIndex(
      (r) =>
        r.row === selected.row &&
        r.col === selected.col &&
        r.size === selected.size
    );
    if (exact >= 0) return { index: exact, count };

    const contained = results.findIndex(
      (r) =>
        r.row === selected.row &&
        selected.col >= r.col &&
        selected.col < r.col + r.size
    );
    if (contained >= 0) return { index: contained, count };
  }

  const pos = term.getSelectionPosition();
  const anchor = pos?.start ?? findSelectionAnchor?.start;
  if (anchor) {
    const byPos = results.findIndex(
      (r) =>
        r.row === anchor.y &&
        anchor.x >= r.col &&
        anchor.x < r.col + r.size
    );
    if (byPos >= 0) return { index: byPos, count };
  }

  return { index: -1, count };
}

interface BufferPos {
  x: number;
  y: number;
}

interface FindSelectionAnchor {
  start: BufferPos;
  end: BufferPos;
}

/** آخرین match پیدا شده — بعد از clearSelection برای incremental/wrap نگه می‌داریم */
let findSelectionAnchor: FindSelectionAnchor | null = null;

/**
 * موقع restore/find عمداً select می‌کنیم؛ onSelectionChange نباید همون لحظه
 * دوباره clear کنه وگرنه navigation خراب می‌شه. با counter تا nest امن باشه.
 */
let suppressFindSelectionClearDepth = 0;

/** وقتی Find بسته می‌شه anchor رو هم پاک کن */
export function clearFindSelectionAnchor(): void {
  findSelectionAnchor = null;
}

export function isFindSelectionClearSuppressed(): boolean {
  return suppressFindSelectionClearDepth > 0;
}

function withFindSelectionSuppressed<T>(fn: () => T): T {
  suppressFindSelectionClearDepth += 1;
  try {
    return fn();
  } finally {
    suppressFindSelectionClearDepth -= 1;
  }
}

/** قبل از findNext/findPrevious selection رو از anchor برگردون */
export function restoreFindSelectionAnchor(term: Terminal): void {
  if (!findSelectionAnchor) return;
  withFindSelectionSuppressed(() => {
    restoreSelection(term, findSelectionAnchor!.start, findSelectionAnchor!.end);
  });
}

/**
 * SearchAddon برای navigation به selection وابسته‌ست ولی selection روی
 * decoration می‌افته و FG رو سیاه می‌کنه — موقعیت رو save می‌کنیم و selection
 * رو پاک می‌کنیم تا فقط decoration بمونه.
 *
 * مهم: خود addon بعد از paste/write با _updateMatches دوباره select می‌کنه؛
 * باید از onSelectionChange هم صدا زده بشه.
 */
export function finalizeFindSelection(term: Terminal): void {
  if (suppressFindSelectionClearDepth > 0) return;
  const pos = term.getSelectionPosition();
  if (!pos) return;
  findSelectionAnchor = { start: pos.start, end: pos.end };
  withFindSelectionSuppressed(() => {
    term.clearSelection();
  });
}

function posBefore(a: BufferPos, b: BufferPos): boolean {
  return a.y < b.y || (a.y === b.y && a.x < b.x);
}

function restoreSelection(
  term: Terminal,
  start: BufferPos,
  end: BufferPos
): void {
  const size =
    end.x - start.x + term.cols * (end.y - start.y);
  if (size > 0) {
    term.select(start.x, start.y, size);
  }
}

/**
 * SearchAddon همیشه wrap می‌کنه؛ اگه wrapAround خاموش باشه و نتیجه
 * از نظر جهت «برگشته» باشه، selection قبلی رو برمی‌گردونیم.
 */
export function findNextWithWrap(
  addon: SearchAddon,
  term: Terminal,
  termStr: string,
  options: ISearchOptions,
  wrapAround: boolean,
  incremental = false
): boolean {
  const caseInsensitive = options.caseSensitive !== true;
  if (!termStr || !isSearchableFindQuery(termStr, caseInsensitive)) {
    addon.clearDecorations();
    term.clearSelection();
    clearFindSelectionAnchor();
    return false;
  }

  // کل عملیات find رو suppress کن تا onSelectionChange وسط کار clear نکنه
  const outcome = withFindSelectionSuppressed(() => {
    restoreFindSelectionAnchor(term);
    const prev = term.getSelectionPosition();
    const found = addon.findNext(termStr, { ...options, incremental });
    if (!found) return { ok: false as const };
    if (clearZeroWidthSelection(addon, term)) return { ok: false as const };
    // اگه regex پسوند کوتاه داده بود، به match کامل highlight snap کن
    snapFindSelectionToCanonicalMatch(addon, term);

    if (wrapAround || !prev) return { ok: true as const };

    const next = term.getSelectionPosition();
    if (!next) return { ok: true as const };

    // اگه نتیجه قبل از نقطهٔ شروع جستجوی جلو باشه، یعنی wrap شده
    const searchStart = prev.end;
    if (posBefore(next.start, searchStart)) {
      addon.clearActiveDecoration();
      restoreSelection(term, prev.start, prev.end);
      return { ok: false as const };
    }

    return { ok: true as const };
  });

  finalizeFindSelection(term);
  return outcome.ok;
}

export function findPreviousWithWrap(
  addon: SearchAddon,
  term: Terminal,
  termStr: string,
  options: ISearchOptions,
  wrapAround: boolean
): boolean {
  const caseInsensitive = options.caseSensitive !== true;
  if (!termStr || !isSearchableFindQuery(termStr, caseInsensitive)) {
    addon.clearDecorations();
    term.clearSelection();
    clearFindSelectionAnchor();
    return false;
  }

  const outcome = withFindSelectionSuppressed(() => {
    restoreFindSelectionAnchor(term);
    const prev = term.getSelectionPosition();
    const found = addon.findPrevious(termStr, options);
    if (!found) return { ok: false as const };
    if (clearZeroWidthSelection(addon, term)) return { ok: false as const };
    // Previous با regex overlapping فقط پسوند می‌ده — به کل match برگردون
    snapFindSelectionToCanonicalMatch(addon, term);

    if (wrapAround || !prev) return { ok: true as const };

    const next = term.getSelectionPosition();
    if (!next) return { ok: true as const };

    // برای previous: wrap یعنی نتیجه بعد از شروع قبلی باشه
    if (
      next.start.y > prev.start.y ||
      (next.start.y === prev.start.y && next.start.x > prev.start.x)
    ) {
      addon.clearActiveDecoration();
      restoreSelection(term, prev.start, prev.end);
      return { ok: false as const };
    }

    return { ok: true as const };
  });

  finalizeFindSelection(term);
  return outcome.ok;
}
