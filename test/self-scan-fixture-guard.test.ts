import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { discoverFiles } from "../src/discover.js";

const REPO_ROOT = join(import.meta.dirname, "..");

// Phase 71 (AC-8): this repo's own root necro.config.json sets no
// include/ignore, so it falls back to DEFAULT_CONFIG — same as any repo
// with no config at all. Now that Python is default-on, a bare `necro scan`
// (or `necro scan .`) at this repo's root would otherwise newly walk into
// test/fixtures/python-realrepo (227 vendored pip/httpie files) and
// test/fixtures/python-module-resolver (21 more) as if they were this
// repo's own source. Scoped to .py — test/fixtures/ already contains
// .ts/.js fixtures discovered today, unrelated to this phase.
describe("necro's own repo-root scan does not pull in vendored Python fixtures (AC-8)", () => {
  test("discoverFiles at the repo root, using this repo's real config, finds zero .py files under test/fixtures/", async () => {
    const config = await loadConfig(REPO_ROOT);
    const files = await discoverFiles(REPO_ROOT, config);
    const fixturePyFiles = files.filter(
      (f) => f.includes(`${join("test", "fixtures")}${"/"}`) && f.endsWith(".py"),
    );
    expect(fixturePyFiles).toEqual([]);
  });
});
