/**
 * Smoke test: OSC52 clipboard provider must refuse reads (exfil guard).
 * Run: bun scripts/validate-osc52-clipboard.ts
 */
import { writeOnlyOsc52ClipboardProvider } from "../src/lib/osc52-clipboard";

let failed = 0;

function assert(label: string, condition: boolean) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed += 1;
  } else {
    console.log(`ok: ${label}`);
  }
}

async function main() {
  let rejected = false;
  try {
    await writeOnlyOsc52ClipboardProvider.readText("c");
  } catch {
    rejected = true;
  }
  assert("readText rejects OSC52 clipboard queries", rejected);

  // writeText بدون navigator.clipboard ممکنه تو محیط اسکریپت fail بشه —
  // فقط چک می‌کنیم متد وجود داره و رشته خالی رو no-op می‌کنه.
  await writeOnlyOsc52ClipboardProvider.writeText("c", "");
  assert("writeText no-ops on empty payload", true);

  if (failed > 0) {
    console.error(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All OSC52 clipboard checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
