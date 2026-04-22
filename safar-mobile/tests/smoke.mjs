import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const appPath = path.resolve(process.cwd(), "App.tsx");
const app = fs.readFileSync(appPath, "utf8");
const lines = app.split("\n");

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("feed setup build screen duration stays 3 seconds", () => {
  assert.match(app, /const BUILD_SCREEN_MS = 3000;/);
});

test("legacy welcome toast symbols are removed", () => {
  const removedSymbols = [
    "WELCOME_TOAST_TEXT",
    "welcomeTypedText",
    "welcomeToastOpacity",
    "welcomeToastTranslateY",
    "welcomeChatToast",
  ];
  for (const symbol of removedSymbols) {
    assert.equal(
      app.includes(symbol),
      false,
      `Expected "${symbol}" to be removed from App.tsx`,
    );
  }
});

test("Pressables default to instant touch", () => {
  const hasInstant = (text) =>
    text.includes("PRESSABLE_INSTANT") || text.includes("unstable_pressDelay");

  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes("<Pressable")) continue;

    const trimmed = line.trim();
    if (trimmed === "<Pressable" || trimmed === "<Pressable>") {
      const next = lines[i + 1] ?? "";
      if (!hasInstant(line) && !hasInstant(next)) offenders.push(i + 1);
      continue;
    }

    if (/^\s*<Pressable\s/.test(line) && !hasInstant(line)) {
      offenders.push(i + 1);
    }
  }

  assert.equal(
    offenders.length,
    0,
    `Pressable(s) missing instant-touch props on lines: ${offenders.join(", ")}`,
  );
});

console.log("\nAll smoke tests passed.");
