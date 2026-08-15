import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { discoverFiles } from "../src/discover.js";
import { buildComposerAutoloadMap } from "../src/graph/php/composer-autoload.js";
import { readComposerManifest } from "../src/graph/php/composer-manifest.js";
import { parsePhpImports } from "../src/graph/php/import-parser.js";
import { resolvePhpClassReference } from "../src/graph/php/resolve-import.js";

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "php-composer-resolver");
const PHP_CONFIG = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

/** End-to-end: discover real files on disk, parse the composer manifest, build the autoload map, parse `file`'s namespace/imports, resolve every `use` import against the map. */
async function resolveFixture(fixtureDir: string, file: string) {
  const root = join(FIXTURES_ROOT, fixtureDir);
  const files = await discoverFiles(root, PHP_CONFIG);
  const manifest = await readComposerManifest(root);
  const autoloadMap = await buildComposerAutoloadMap(root, files, manifest);
  const filePath = join(root, file);
  const source = await readFile(filePath, "utf8");
  const parsed = await parsePhpImports(filePath, source);
  return { autoloadMap, parsed };
}

describe("PHP composer resolver — fixture trees, end-to-end (AC-1, AC-2, AC-3)", () => {
  test("a `use` import resolves to its target file via the composer.json psr-4 map", async () => {
    const { autoloadMap, parsed } = await resolveFixture("basic-app", "src/Http/Controllers/UserController.php");
    expect(parsed.namespace).toBe("App\\Http\\Controllers");
    expect(parsed.imports).toEqual([{ localName: "User", fqcn: "App\\Models\\User", kind: "class" }]);
    expect(autoloadMap.classToFile.get("App\\Models\\User")).toBe(
      join(FIXTURES_ROOT, "basic-app", "src", "Models", "User.php"),
    );
  });

  test("an unqualified body reference matching a `use` import resolves via that import (T5, fed the fixture's real parsed imports)", async () => {
    const { autoloadMap, parsed } = await resolveFixture("basic-app", "src/Http/Controllers/UserController.php");
    const result = resolvePhpClassReference("User", parsed.namespace, parsed.imports, autoloadMap.classToFile);
    expect(result).toEqual({
      fqcn: "App\\Models\\User",
      file: join(FIXTURES_ROOT, "basic-app", "src", "Models", "User.php"),
    });
  });

  test("an unqualified body reference with no matching import resolves relative to the current namespace (`extends BaseController`)", async () => {
    const { autoloadMap, parsed } = await resolveFixture("basic-app", "src/Http/Controllers/UserController.php");
    const result = resolvePhpClassReference("BaseController", parsed.namespace, parsed.imports, autoloadMap.classToFile);
    expect(result).toEqual({
      fqcn: "App\\Http\\Controllers\\BaseController",
      file: join(FIXTURES_ROOT, "basic-app", "src", "Http", "Controllers", "BaseController.php"),
    });
  });

  test("missing composer.json: discovery and parsing still succeed, autoload map is empty, nothing throws", async () => {
    const { autoloadMap, parsed } = await resolveFixture("no-manifest", "src/Standalone.php");
    expect(parsed.namespace).toBe("");
    expect(autoloadMap.classToFile.size).toBe(0);
  });
});

describe("PHP composer resolver — reachability wiring (75-01 T3, AC-1)", () => {
  // This guard used to assert the opposite ("model.ts does not import any of
  // this phase's resolver modules — wiring composer resolution into the
  // reachability graph is Phase C, not this phase"). Phase C is this phase
  // (75-01 T3): `buildReachabilityModel` now builds `phpFiles`' `classToFile`
  // map via `readComposerManifest` + `buildComposerAutoloadMap` and feeds it
  // to `buildPhpReferenceEdges`, so the two composer-resolution entry points
  // are imported directly. `declared-symbols`/`import-parser`/`resolve-import`
  // stay unimported by `model.ts` itself (T1/T2's own modules reach them
  // internally, one layer down) — this phase's direct-import surface is just
  // the two composer modules, matched below.
  test("src/engine/model.ts imports the composer-manifest and composer-autoload modules to build PHP's `classToFile` map", async () => {
    const modelSource = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "model.ts"), "utf8");
    for (const modulePath of ["graph/php/composer-manifest", "graph/php/composer-autoload"]) {
      expect(modelSource).toContain(modulePath);
    }
  });
});
