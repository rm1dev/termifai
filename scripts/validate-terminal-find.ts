/**
 * Smoke test for terminal find pattern compilation and zero-width guards.
 * Run: bun scripts/validate-terminal-find.ts
 */
import { appThemes } from "../src/lib/app-theme";
import {
  assembleFindParts,
  buildFindDecorations,
  compileFindQuery,
  findPatterns,
  getFindPattern,
  isSearchableFindQuery,
  type FindPart,
} from "../src/lib/terminal-find";

let failed = 0;

function assert(label: string, condition: boolean) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed += 1;
  } else {
    console.log(`ok: ${label}`);
  }
}

function parseHexColor(hex: string) {
  const raw = hex.replace(/^#/, "").slice(0, 6);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }) {
  const linear = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(fg: { r: number; g: number; b: number }, bg: { r: number; g: number; b: number }) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const theme of appThemes) {
  const deco = buildFindDecorations(theme.xterm, theme.mode);
  const matchBg = parseHexColor(deco.matchBackground!);
  const activeBg = parseHexColor(deco.activeMatchBackground!);
  const fgSamples = [
    theme.xterm.foreground,
    theme.xterm.brightGreen,
    theme.xterm.brightCyan,
    theme.xterm.brightWhite,
    theme.xterm.brightYellow,
  ].map(parseHexColor);

  for (const fg of fgSamples) {
    const fgL = relativeLuminance(fg);
    const matchL = relativeLuminance(matchBg);
    const activeL = relativeLuminance(activeBg);
    // فقط وقتی متن واقعاً روشن‌تر از پس‌زمینهٔ هایلایت باشه چک می‌کنیم
    if (fgL > 0.25 && fgL > matchL + 0.02) {
      assert(
        `${theme.id} match contrast >= 3.0`,
        contrastRatio(fg, matchBg) >= 3
      );
    }
    if (fgL > 0.25 && fgL > activeL + 0.02) {
      assert(
        `${theme.id} active contrast >= 3.0`,
        contrastRatio(fg, activeBg) >= 3
      );
    }
  }

  assert(
    `${theme.id} no matchBorder on inactive (avoids grid noise)`,
    deco.matchBorder === undefined
  );
  assert(
    `${theme.id} active has border for distinction`,
    typeof deco.activeMatchBorder === "string" && deco.activeMatchBorder.length > 0
  );
  assert(
    `${theme.id} active visibly distinct from match`,
    deco.activeMatchBackground !== deco.matchBackground
  );
}

{
  const parts: FindPart[] = [
    { kind: "text", value: "foo" },
    { kind: "token", id: "email" },
  ];
  const mid = assembleFindParts(parts, "bar", 1);
  assert(
    "assembleFindParts inserts draft before last token",
    mid.length === 3 &&
      mid[0].kind === "text" &&
      mid[0].value === "foo" &&
      mid[1].kind === "text" &&
      mid[1].value === "bar" &&
      mid[2].kind === "token"
  );
  const end = assembleFindParts(parts, "bar", 2);
  assert(
    "assembleFindParts appends draft at end",
    end.length === 3 && end[2].kind === "text" && end[2].value === "bar"
  );
  assert(
    "assembleFindParts empty draft keeps parts",
    assembleFindParts(parts, "", 1).length === 2
  );
}

// Email باید word-boundary داشته باشه (مثل هایلایتر)
assert(
  "email regex has word boundaries",
  getFindPattern("email").regex.startsWith("\\b") && getFindPattern("email").regex.endsWith("\\b")
);

// Any Characters must require at least one character
assert(
  "anyCharacters regex is .+?",
  getFindPattern("anyCharacters").regex === ".+?"
);

const anyOnly = compileFindQuery([{ kind: "token", id: "anyCharacters" }], "contains");
assert("anyCharacters alone compiles", anyOnly === ".+?");
assert(
  "anyCharacters alone is searchable",
  isSearchableFindQuery(anyOnly, true)
);
assert(
  "anyCharacters does not match empty string",
  !new RegExp(anyOnly).test("")
);

// Old .*? behavior would match empty and flood highlights
assert(
  "legacy .*? matches empty (sanity)",
  new RegExp(".*?").test("")
);
assert(
  "legacy .*? alone would be rejected by guard",
  !isSearchableFindQuery(".*?", true)
);

// Word break alone is zero-width — must be rejected
const wordBreakOnly = compileFindQuery([{ kind: "token", id: "wordBreak" }], "contains");
assert("wordBreak compiles to \\b", wordBreakOnly === "\\b");
assert(
  "wordBreak alone is not searchable",
  !isSearchableFindQuery(wordBreakOnly, true)
);

// Combined patterns should still work
const textThenAny = compileFindQuery(
  [
    { kind: "text", value: "ls" },
    { kind: "token", id: "anyCharacters" },
  ],
  "contains"
);
assert("text + anyCharacters compiles", textThenAny === "ls.+?");
assert(
  "text + anyCharacters is searchable",
  isSearchableFindQuery(textThenAny, true)
);

const wordWithBreaks = compileFindQuery(
  [
    { kind: "token", id: "wordBreak" },
    { kind: "text", value: "foo" },
    { kind: "token", id: "wordBreak" },
  ],
  "contains"
);
assert(
  "wordBreak + text + wordBreak is searchable",
  isSearchableFindQuery(wordWithBreaks, true)
);

// Useful class tokens stay searchable
for (const id of ["anyWordCharacters", "whiteSpace", "digits", "email", "url", "ipAddress"] as const) {
  const q = compileFindQuery([{ kind: "token", id }], "contains");
  assert(`${id} alone is searchable`, isSearchableFindQuery(q, true));
}

// Every pattern definition should compile without throwing
for (const p of findPatterns) {
  const q = compileFindQuery([{ kind: "token", id: p.id }], "contains");
  assert(`${p.id} produces non-empty query`, q.length > 0);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}

console.log("\nAll terminal-find pattern checks passed.");
process.exit(0);
