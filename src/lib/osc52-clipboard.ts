import type { IClipboardProvider } from "@xterm/addon-clipboard";

/**
 * Provider برای ClipboardAddon (OSC52).
 * نوشتن مجاز است (yank از tmux/nvim به کلیپ‌بورد سیستم)، ولی خوندن عمداً
 * قطع شده: کوئری `\e]52;c;?\a` از ریموت نباید محتوای کلیپ‌بورد لوکال رو
 * از طریق terminal.input → writeToSession به PTY برگردونه.
 */
export const writeOnlyOsc52ClipboardProvider: IClipboardProvider = {
  readText(_selection: string): Promise<string> {
    return Promise.reject(new Error("OSC52 clipboard read is disabled"));
  },
  async writeText(_selection: string, text: string): Promise<void> {
    if (!text) return;
    await navigator.clipboard.writeText(text);
  },
};
