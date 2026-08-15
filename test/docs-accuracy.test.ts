import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");

const STALE_SUBSTRINGS = [
  "isn't corpus-validated",
  "isn't corpus-validated to the same bar",
  "hasn't been corpus-validated yet",
];

const DOC_FILES = [
  "README.md",
  "website/src/content/docs/guide/roadmap.md",
  "src/analyze/classify.ts",
];

// Phase 71 (AC-5): these three files carried the claim that Python's
// resolver "isn't corpus-validated yet" — false since phase 48 (2026-07-18)
// measured precision 0.90 / recall 0.69 against the 0.85/0.5 default-on
// floor. Real, automated assertion — not a manual read-through — so this
// AC can't silently regress the next time someone edits one of these files.
describe("docs accuracy — Python validation claim (AC-5)", () => {
  for (const file of DOC_FILES) {
    test(`${file} does not claim Python validation "hasn't happened yet"`, async () => {
      const content = await readFile(join(REPO_ROOT, file), "utf8");
      for (const stale of STALE_SUBSTRINGS) {
        expect(content).not.toContain(stale);
      }
    });
  }
});
