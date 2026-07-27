import { readText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * خوندن کلیپ‌بورد از مسیر native (پلاگین Tauri) به‌جای navigator.clipboard:
 * WebKit توی macOS برای هر readText یه حباب تأیید «Paste» نشون می‌ده که
 * کاربر باید دوباره روش کلیک کنه. مسیر native از پروسه Rust می‌خونه و
 * هیچ prompt‌ای نداره. توی پیش‌نمایش مرورگر (bun run dev) که Tauri نیست،
 * به API خود مرورگر برمی‌گردیم.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}
