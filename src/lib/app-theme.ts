import { emit } from "@tauri-apps/api/event";

export type AppThemeId =
  | "termifai-dark"
  | "termifai-light"
  | "dracula"
  | "nord"
  | "gruvbox-dark"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "solarized-dark"
  | "solarized-light"
  | "one-dark"
  | "rose-pine"
  | "kanagawa-wave";

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

interface AppThemeVariables {
  background: string;
  foreground: string;
  surface: string;
  surface2: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarActive: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  tabActive: string;
  tabInactive: string;
  brandCyan: string;
  brandOrange: string;
  brandYellow: string;
  brandGreen: string;
  brandRed: string;
}

export interface AppTheme {
  id: AppThemeId;
  name: string;
  detail: string;
  mode: "Dark" | "Light";
  preview: {
    background: string;
    border: string;
    lines: string[];
  };
  variables: AppThemeVariables;
  xterm: XtermTheme;
}

export const appThemeChangedEvent = "termifai:app-theme-changed";
export const appThemeStorageKey = "termifai:app-theme";

function vars({
  background,
  foreground,
  surface,
  surface2,
  primary,
  primaryForeground = background,
  mutedForeground,
  accent = surface2,
  border = "#ffffff14",
  input = "#ffffff1a",
  brandCyan = "#6be0e0",
  brandOrange = primary,
  brandYellow = "#ffcf6b",
  brandGreen = "#7ce0a9",
  brandRed = "#ff6b6b",
}: {
  background: string;
  foreground: string;
  surface: string;
  surface2: string;
  primary: string;
  primaryForeground?: string;
  mutedForeground: string;
  accent?: string;
  border?: string;
  input?: string;
  brandCyan?: string;
  brandOrange?: string;
  brandYellow?: string;
  brandGreen?: string;
  brandRed?: string;
}): AppThemeVariables {
  return {
    background,
    foreground,
    surface,
    surface2,
    sidebar: background,
    sidebarForeground: mutedForeground,
    sidebarActive: surface2,
    card: surface,
    cardForeground: foreground,
    popover: surface,
    popoverForeground: foreground,
    primary,
    primaryForeground,
    secondary: surface2,
    secondaryForeground: foreground,
    muted: surface2,
    mutedForeground,
    accent,
    accentForeground: foreground,
    destructive: brandRed,
    destructiveForeground: foreground,
    border,
    input,
    ring: primary,
    tabActive: surface2,
    tabInactive: surface,
    brandCyan,
    brandOrange,
    brandYellow,
    brandGreen,
    brandRed,
  };
}

function xterm(colors: Omit<XtermTheme, "background" | "cursorAccent" | "selectionBackground"> & {
  background?: string;
  cursorAccent?: string;
  selectionBackground?: string;
}): XtermTheme {
  return {
    background: colors.background ?? "#00000000",
    cursorAccent: colors.cursorAccent ?? "#0e1422",
    selectionBackground: colors.selectionBackground ?? "#3b82f655",
    ...colors,
  };
}

export const appThemes: AppTheme[] = [
  {
    id: "termifai-dark",
    name: "Termifai Dark",
    detail: "Default · Deep navy",
    mode: "Dark",
    preview: {
      background: "#171a24",
      border: "#7ce0a9",
      lines: ["#7ce0a9", "#ffcf6b", "#6ba9ff", "#d39bff"],
    },
    variables: vars({
      background: "#171c29",
      foreground: "#e7eef7",
      surface: "#202637",
      surface2: "#2a3144",
      primary: "#ff9f43",
      mutedForeground: "#97a2b8",
    }),
    xterm: xterm({
      foreground: "#4db380",
      cursor: "#7ce0a9",
      black: "#0e1422",
      red: "#ff6b6b",
      green: "#7ce0a9",
      yellow: "#ffcf6b",
      blue: "#6ba9ff",
      magenta: "#d39bff",
      cyan: "#6be0e0",
      white: "#e7eef7",
      brightBlack: "#5b6478",
      brightRed: "#ff8585",
      brightGreen: "#9ff0bf",
      brightYellow: "#ffe08a",
      brightBlue: "#8bbcff",
      brightMagenta: "#e0b8ff",
      brightCyan: "#8df0f0",
      brightWhite: "#ffffff",
    }),
  },
  {
    id: "termifai-light",
    name: "Termifai Light",
    detail: "Light · Soft contrast",
    mode: "Light",
    preview: {
      background: "#f4f6fb",
      border: "#4f7cff",
      lines: ["#1f2937", "#4f7cff", "#2f9e44", "#c2410c"],
    },
    variables: vars({
      background: "#f4f6fb",
      foreground: "#111827",
      surface: "#ffffff",
      surface2: "#e8edf7",
      primary: "#4f7cff",
      primaryForeground: "#ffffff",
      mutedForeground: "#64748b",
      accent: "#dbe5ff",
      border: "#1118271a",
      input: "#1118271f",
      brandCyan: "#0891b2",
      brandOrange: "#ea580c",
      brandYellow: "#ca8a04",
      brandGreen: "#16a34a",
      brandRed: "#dc2626",
    }),
    xterm: xterm({
      foreground: "#111827",
      cursor: "#2563eb",
      black: "#111827",
      red: "#dc2626",
      green: "#16a34a",
      yellow: "#ca8a04",
      blue: "#2563eb",
      magenta: "#9333ea",
      cyan: "#0891b2",
      white: "#f8fafc",
      brightBlack: "#64748b",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#eab308",
      brightBlue: "#3b82f6",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#ffffff",
    }),
  },
  {
    id: "dracula",
    name: "Dracula",
    detail: "Vibrant · Purple accent",
    mode: "Dark",
    preview: {
      background: "#282a36",
      border: "#bd93f9",
      lines: ["#f8f8f2", "#ff79c6", "#50fa7b", "#8be9fd"],
    },
    variables: vars({
      background: "#282a36",
      foreground: "#f8f8f2",
      surface: "#343746",
      surface2: "#44475a",
      primary: "#bd93f9",
      mutedForeground: "#b6b6c8",
      brandCyan: "#8be9fd",
      brandOrange: "#ffb86c",
      brandYellow: "#f1fa8c",
      brandGreen: "#50fa7b",
      brandRed: "#ff5555",
    }),
    xterm: xterm({
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    }),
  },
  {
    id: "nord",
    name: "Nord",
    detail: "Cool · Low glare",
    mode: "Dark",
    preview: {
      background: "#2e3440",
      border: "#88c0d0",
      lines: ["#d8dee9", "#81a1c1", "#a3be8c", "#b48ead"],
    },
    variables: vars({
      background: "#2e3440",
      foreground: "#eceff4",
      surface: "#3b4252",
      surface2: "#434c5e",
      primary: "#88c0d0",
      mutedForeground: "#aeb9cc",
      brandCyan: "#8fbcbb",
      brandOrange: "#d08770",
      brandYellow: "#ebcb8b",
      brandGreen: "#a3be8c",
      brandRed: "#bf616a",
    }),
    xterm: xterm({
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    }),
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    detail: "Warm · Retro contrast",
    mode: "Dark",
    preview: {
      background: "#282828",
      border: "#d79921",
      lines: ["#ebdbb2", "#cc241d", "#98971a", "#458588"],
    },
    variables: vars({
      background: "#282828",
      foreground: "#ebdbb2",
      surface: "#32302f",
      surface2: "#3c3836",
      primary: "#d79921",
      mutedForeground: "#bdae93",
      brandCyan: "#689d6a",
      brandOrange: "#fe8019",
      brandYellow: "#fabd2f",
      brandGreen: "#b8bb26",
      brandRed: "#fb4934",
    }),
    xterm: xterm({
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    }),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    detail: "Neon · High focus",
    mode: "Dark",
    preview: {
      background: "#1a1b26",
      border: "#7aa2f7",
      lines: ["#c0caf5", "#f7768e", "#9ece6a", "#bb9af7"],
    },
    variables: vars({
      background: "#1a1b26",
      foreground: "#c0caf5",
      surface: "#24283b",
      surface2: "#2f3549",
      primary: "#7aa2f7",
      mutedForeground: "#9aa5ce",
      brandCyan: "#7dcfff",
      brandOrange: "#ff9e64",
      brandYellow: "#e0af68",
      brandGreen: "#9ece6a",
      brandRed: "#f7768e",
    }),
    xterm: xterm({
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    }),
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    detail: "Pastel · Soft dark",
    mode: "Dark",
    preview: {
      background: "#1e1e2e",
      border: "#cba6f7",
      lines: ["#cdd6f4", "#f38ba8", "#a6e3a1", "#89b4fa"],
    },
    variables: vars({
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      surface: "#313244",
      surface2: "#45475a",
      primary: "#cba6f7",
      mutedForeground: "#a6adc8",
      brandCyan: "#89dceb",
      brandOrange: "#fab387",
      brandYellow: "#f9e2af",
      brandGreen: "#a6e3a1",
      brandRed: "#f38ba8",
    }),
    xterm: xterm({
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    }),
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    detail: "Classic · Balanced",
    mode: "Dark",
    preview: {
      background: "#002b36",
      border: "#2aa198",
      lines: ["#839496", "#dc322f", "#859900", "#268bd2"],
    },
    variables: vars({
      background: "#002b36",
      foreground: "#839496",
      surface: "#073642",
      surface2: "#0b4552",
      primary: "#2aa198",
      mutedForeground: "#93a1a1",
      brandCyan: "#2aa198",
      brandOrange: "#cb4b16",
      brandYellow: "#b58900",
      brandGreen: "#859900",
      brandRed: "#dc322f",
    }),
    xterm: xterm({
      foreground: "#839496",
      cursor: "#93a1a1",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    }),
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    detail: "Classic · Daylight",
    mode: "Light",
    preview: {
      background: "#fdf6e3",
      border: "#268bd2",
      lines: ["#657b83", "#dc322f", "#859900", "#6c71c4"],
    },
    variables: vars({
      background: "#fdf6e3",
      foreground: "#657b83",
      surface: "#eee8d5",
      surface2: "#e4dcc8",
      primary: "#268bd2",
      primaryForeground: "#fdf6e3",
      mutedForeground: "#839496",
      accent: "#eee8d5",
      border: "#002b361f",
      input: "#002b3624",
      brandCyan: "#2aa198",
      brandOrange: "#cb4b16",
      brandYellow: "#b58900",
      brandGreen: "#859900",
      brandRed: "#dc322f",
    }),
    xterm: xterm({
      foreground: "#657b83",
      cursor: "#586e75",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    }),
  },
  {
    id: "one-dark",
    name: "One Dark",
    detail: "Editor · Familiar",
    mode: "Dark",
    preview: {
      background: "#282c34",
      border: "#61afef",
      lines: ["#abb2bf", "#e06c75", "#98c379", "#c678dd"],
    },
    variables: vars({
      background: "#282c34",
      foreground: "#abb2bf",
      surface: "#313640",
      surface2: "#3b414d",
      primary: "#61afef",
      mutedForeground: "#8b95a7",
      brandCyan: "#56b6c2",
      brandOrange: "#d19a66",
      brandYellow: "#e5c07b",
      brandGreen: "#98c379",
      brandRed: "#e06c75",
    }),
    xterm: xterm({
      foreground: "#abb2bf",
      cursor: "#abb2bf",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    }),
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    detail: "Muted · Elegant",
    mode: "Dark",
    preview: {
      background: "#191724",
      border: "#c4a7e7",
      lines: ["#e0def4", "#eb6f92", "#31748f", "#f6c177"],
    },
    variables: vars({
      background: "#191724",
      foreground: "#e0def4",
      surface: "#1f1d2e",
      surface2: "#26233a",
      primary: "#c4a7e7",
      mutedForeground: "#908caa",
      brandCyan: "#9ccfd8",
      brandOrange: "#f6c177",
      brandYellow: "#ebbcba",
      brandGreen: "#31748f",
      brandRed: "#eb6f92",
    }),
    xterm: xterm({
      foreground: "#e0def4",
      cursor: "#e0def4",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#eb6f92",
      brightGreen: "#31748f",
      brightYellow: "#f6c177",
      brightBlue: "#9ccfd8",
      brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba",
      brightWhite: "#e0def4",
    }),
  },
  {
    id: "kanagawa-wave",
    name: "Kanagawa Wave",
    detail: "Ink · Calm contrast",
    mode: "Dark",
    preview: {
      background: "#1f1f28",
      border: "#7e9cd8",
      lines: ["#dcd7ba", "#c34043", "#76946a", "#957fb8"],
    },
    variables: vars({
      background: "#1f1f28",
      foreground: "#dcd7ba",
      surface: "#2a2a37",
      surface2: "#363646",
      primary: "#7e9cd8",
      mutedForeground: "#a6a69c",
      brandCyan: "#7aa89f",
      brandOrange: "#ffa066",
      brandYellow: "#c0a36e",
      brandGreen: "#76946a",
      brandRed: "#c34043",
    }),
    xterm: xterm({
      foreground: "#dcd7ba",
      cursor: "#c8c093",
      black: "#16161d",
      red: "#c34043",
      green: "#76946a",
      yellow: "#c0a36e",
      blue: "#7e9cd8",
      magenta: "#957fb8",
      cyan: "#6a9589",
      white: "#c8c093",
      brightBlack: "#727169",
      brightRed: "#e82424",
      brightGreen: "#98bb6c",
      brightYellow: "#e6c384",
      brightBlue: "#7fb4ca",
      brightMagenta: "#938aa9",
      brightCyan: "#7aa89f",
      brightWhite: "#dcd7ba",
    }),
  },
];

export const defaultAppTheme = appThemes[0];

const variableNames: Record<keyof AppThemeVariables, string> = {
  background: "--background",
  foreground: "--foreground",
  surface: "--surface",
  surface2: "--surface-2",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarActive: "--sidebar-active",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
  tabActive: "--tab-active",
  tabInactive: "--tab-inactive",
  brandCyan: "--brand-cyan",
  brandOrange: "--brand-orange",
  brandYellow: "--brand-yellow",
  brandGreen: "--brand-green",
  brandRed: "--brand-red",
};

export function getAppTheme(themeId: string | null | undefined) {
  return appThemes.find((theme) => theme.id === themeId) ?? defaultAppTheme;
}

export function loadAppTheme() {
  try {
    return getAppTheme(localStorage.getItem(appThemeStorageKey));
  } catch {
    return defaultAppTheme;
  }
}

export function applyAppTheme(theme: AppTheme) {
  const root = document.documentElement;

  for (const [key, cssVariable] of Object.entries(variableNames) as [
    keyof AppThemeVariables,
    string,
  ][]) {
    root.style.setProperty(cssVariable, theme.variables[key]);
  }

  root.dataset.theme = theme.id;
  root.dataset.themeMode = theme.mode.toLowerCase();
}

export function saveAppTheme(themeId: AppThemeId) {
  const theme = getAppTheme(themeId);

  localStorage.setItem(appThemeStorageKey, theme.id);
  applyAppTheme(theme);
  window.dispatchEvent(
    new CustomEvent<AppTheme>(appThemeChangedEvent, {
      detail: theme,
    })
  );

  void emit(appThemeChangedEvent, theme).catch(() => {
    /* Non-Tauri environments fall back to localStorage + storage events. */
  });
}
