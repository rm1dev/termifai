const ua = navigator.userAgent.toLowerCase();

export const platform: "macos" | "windows" | "linux" =
  ua.includes("win") ? "windows" :
  ua.includes("mac") ? "macos" :
  "linux";

export const isMac = platform === "macos";
