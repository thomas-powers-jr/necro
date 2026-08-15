import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scan } from "../src/engine/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-lib-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<void> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

const widgetSource = [
  "<?php",
  "namespace App;",
  "",
  "class Widget {",
  "    public function doThing() {",
  "        return 1;",
  "    }",
  "}",
  "",
].join("\n");

describe("necro scan — PHP library publicApiIds quarantine (75-01 T5, AC-5)", () => {
  test("a dead PSR-4-namespace method in a library package quarantines to maybe, never auto-fix eligible", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        type: "library",
        name: "vendor/pkg",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);
    // Unrelated prod entry (config.entries, not composer bin/public-index) so
    // entryResolution isn't collapsed — isolating the assertion to the
    // quarantine mechanism, exactly as scan-python-library-quarantine.test.ts
    // does for Python via [project.scripts].
    await write("src/Bootstrap.php", "<?php\necho 'boot';\n");

    const config = {
      ...DEFAULT_CONFIG,
      include: ["**/*.php"],
      entries: ["src/Bootstrap.php"],
    };
    const { findings, diagnostics } = await scan(dir, config);

    expect(diagnostics.entryResolution.collapsed).toBe(false);
    const finding = findings.find((f) => f.node.name === "doThing");
    expect(finding).toBeDefined();
    expect(finding?.tier).toBe("maybe");
    expect(finding?.autoFixEligible).toBe(false);
  });

  test("the same dead method in a non-library (application-shaped) repo is not quarantined by this mechanism", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        name: "acme/my-app",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);
    await write("src/Bootstrap.php", "<?php\necho 'boot';\n");
    // public/index.php is the app-shape veto — without it this composer.json
    // (name present, no `type`) would itself read as a library per the
    // guzzlehttp/guzzle-shaped positive case.
    await write("public/index.php", "<?php\nrequire 'x';\n");

    const config = {
      ...DEFAULT_CONFIG,
      include: ["**/*.php"],
      entries: ["src/Bootstrap.php"],
    };
    const { findings, diagnostics } = await scan(dir, config);

    expect(diagnostics.entryResolution.collapsed).toBe(false);
    const finding = findings.find((f) => f.node.name === "doThing");
    expect(finding).toBeDefined();
    // PHP nodes are unconditionally `exported: true` (T1) and not tainted/
    // public-API here, so `deadTier` lands on `likely` (never `certain` —
    // T7's PHP tier cap is moot here since `likely` is already below it).
    expect(finding?.tier).toBe("likely");
  });
});
