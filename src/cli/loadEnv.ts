// Zero-dependency .env loader.
//
// Imported FIRST by main.ts (before config) so values in a local .env file are in
// process.env before anything reads them. Existing env vars are NOT overwritten, so
// real environment variables always win. No secrets ship in the repo; .env is
// git-ignored, and .env.example documents the available keys.

import fs from "node:fs";

/** Parse .env text into a key->value map. Pure + testable. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load a .env file (default ./.env) into process.env without overwriting existing vars. */
export function loadDotEnv(file = ".env"): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env — perfectly fine
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    // Treat an empty value (e.g. the `KEY=` placeholder lines in .env.example) as UNSET, so the
    // code's defaults apply. Otherwise an empty string would override a default — e.g. an empty
    // QWEN_HARNESS_MODELS_FILE made the path resolve to the project dir → "could not read".
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}

// Side effect: load ./.env on import so a simple `import "../cli/loadEnv.ts"` works.
loadDotEnv();
