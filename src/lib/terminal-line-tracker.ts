/**
 * ردیاب متنی که کاربر روی خط فعلی شل تایپ کرده.
 *
 * بافر xterm تا وقتی PTY اکو نکنه به‌روز نمیشه؛ برای keyword expand و
 * گیت کردن command/script snippet ها مجبوریم از خودِ keystroke ها پیگیری کنیم.
 * قبلاً هر بایتی (از جمله Ctrl+C) به خط اضافه می‌شد و تشخیص «خط خالیه؟» می‌ترکید.
 */

export type LineTrackerState = {
  /** متن printable که از کیبورد/پیست دیدیم (بدون پرامپت شل) */
  text: string;
  /**
   * شل خودش محتوای خط رو عوض کرده (مثلاً تاریخچه با ↑/↓).
   * از این لحظه تا Enter/Ctrl+C دیگه به text خالی اعتماد نمی‌کنیم.
   */
  shellOwnsLine: boolean;
};

export function emptyLineTracker(): LineTrackerState {
  return { text: "", shellOwnsLine: false };
}

/** ↑/↓ و PageUp/PageDown — معمولاً تاریخچه/جستجوی شل */
const SHELL_LINE_MUTATING_CSI =
  /^\x1b(?:\[[AB]|O[AB]|\[[45]~|\[[0-9]*;[0-9]*[AB])/;

export function isAtLineStart(state: LineTrackerState): boolean {
  return !state.shellOwnsLine && state.text.length === 0;
}

/** آیا این تکه داده، خط ورودی رو از سمت شل جابه‌جا می‌کنه؟ */
export function isShellLineMutatingEscape(data: string): boolean {
  return SHELL_LINE_MUTATING_CSI.test(data);
}

/**
 * یک تکه ورودی خام (از onData یا تزریق مستقیم مثل paste) رو روی state اعمال کن.
 * Escape sequence های کامل (که با ESC شروع می‌شن) رو جدا با
 * `applyEscapeToLineTracker` بده.
 */
export function applyRawInputToLineTracker(
  state: LineTrackerState,
  data: string
): LineTrackerState {
  let text = state.text;
  let shellOwnsLine = state.shellOwnsLine;

  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;

    if (ch === "\r" || ch === "\n") {
      text = "";
      shellOwnsLine = false;
      continue;
    }

    // Backspace / DEL
    if (ch === "\x7f" || ch === "\b") {
      text = text.slice(0, -1);
      continue;
    }

    // Ctrl+C (interrupt) / Ctrl+U (kill line) — شل خط رو خالی می‌کنه
    if (ch === "\x03" || ch === "\x15") {
      text = "";
      shellOwnsLine = false;
      continue;
    }

    // Ctrl+W — آخرین کلمه رو بکش
    if (ch === "\x17") {
      text = text.replace(/\S+\s*$/, "");
      continue;
    }

    // بقیه کنترل‌کاراکترها رو برای ردیابی نادیده بگیر (نباید «تایپ‌شده» حساب شن)
    if (code < 32) {
      continue;
    }

    text += ch;
  }

  return { text, shellOwnsLine };
}

export function applyEscapeToLineTracker(
  state: LineTrackerState,
  data: string
): LineTrackerState {
  if (isShellLineMutatingEscape(data)) {
    return { ...state, shellOwnsLine: true };
  }
  return state;
}

/** تزریق متن به PTY بدون عبور از onData (paste، drag-drop، text snippet) */
export function applyInjectedTextToLineTracker(
  state: LineTrackerState,
  text: string
): LineTrackerState {
  // دستور کامل با Enter آخر → بعدش خط تازه‌ست
  if (text.endsWith("\r") || text.endsWith("\n")) {
    return applyRawInputToLineTracker(state, text);
  }
  return applyRawInputToLineTracker(state, text);
}
