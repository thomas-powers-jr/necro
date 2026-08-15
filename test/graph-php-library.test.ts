import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ComposerManifest } from "../src/graph/php/composer-manifest.js";
import { isPhpLibrary, resolvePhpPublicApiIds } from "../src/graph/php/library.js";
import type { SymbolNode } from "../src/graph/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-library-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function manifest(overrides: Partial<ComposerManifest> = {}): ComposerManifest {
  return {
    autoload: { psr4: {}, psr0: {}, classmap: [], files: [] },
    autoloadDev: { psr4: {}, psr0: {}, classmap: [], files: [] },
    bin: [],
    ...overrides,
  };
}

describe("isPhpLibrary — signal selection (75-01 T5, AC-5)", () => {
  test("positive: name present, type=library, no public/index.php (matches real phpunit/phpunit and seld/phar-utils shape)", async () => {
    await write(
      "composer.json",
      JSON.stringify({ type: "library", name: "vendor/pkg", autoload: { "psr-4": { "App\\": "src/" } } }),
    );
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(true);
  });

  test("positive: name present, no type field at all — matches real guzzlehttp/guzzle's actual composer.json shape (no `type` key)", async () => {
    await write(
      "composer.json",
      JSON.stringify({ name: "guzzlehttp/guzzle", autoload: { "psr-4": { "GuzzleHttp\\": "src/" } } }),
    );
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(true);
  });

  test("positive: name present, type=library — `bin` is not examined at all (matches real phpunit/phpunit exactly, which ships bin/phpunit and is still a library)", async () => {
    await write(
      "composer.json",
      JSON.stringify({ type: "library", name: "phpunit/phpunit", bin: "bin/phpunit" }),
    );
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(true);
  });

  test("positive: a non-'library' custom ecosystem type (e.g. phpstan-extension) is not vetoed — only the literal 'project' type is", async () => {
    await write("composer.json", JSON.stringify({ type: "phpstan-extension", name: "ergebnis/phpstan-rules" }));
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(true);
  });

  test("negative: no composer.json at all", async () => {
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(false);
  });

  test("negative: composer.json present but no name field", async () => {
    await write("composer.json", JSON.stringify({ type: "library" }));
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(false);
  });

  test("negative: type=project (composer's own explicit application-skeleton declaration) vetoes regardless of name", async () => {
    await write("composer.json", JSON.stringify({ type: "project", name: "acme/my-app" }));
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(false);
  });

  test("negative: name present but public/index.php is present (real app-shape signal)", async () => {
    await write("composer.json", JSON.stringify({ name: "acme/my-app" }));
    const indexFile = await write("public/index.php", "<?php\n");
    const result = await isPhpLibrary(dir, [indexFile]);
    expect(result).toBe(false);
  });

  test("negative: malformed composer.json does not throw, treated as non-library", async () => {
    await write("composer.json", "{not valid json");
    const result = await isPhpLibrary(dir, []);
    expect(result).toBe(false);
  });
});

describe("resolvePhpPublicApiIds — PSR-4/PSR-0 namespace scoping (75-01 T5, AC-5)", () => {
  test("quarantines only nodes whose file falls under the package's own psr-4 dir", () => {
    const ownFile = join(dir, "src", "Widget.php");
    const otherFile = join(dir, "vendor-ish", "Other.php");
    const nodes: SymbolNode[] = [
      { id: `${ownFile}:5:doThing`, name: "doThing", file: ownFile, line: 5, exported: true },
      { id: `${otherFile}:5:doOther`, name: "doOther", file: otherFile, line: 5, exported: true },
    ];
    const m = manifest({ autoload: { psr4: { "App\\": ["src/"] }, psr0: {}, classmap: [], files: [] } });

    const ids = resolvePhpPublicApiIds(dir, nodes, m);

    expect(ids.has(nodes[0]!.id)).toBe(true);
    expect(ids.has(nodes[1]!.id)).toBe(false);
  });

  test("psr-0 dirs are also scoped in", () => {
    const ownFile = join(dir, "lib", "Legacy.php");
    const nodes: SymbolNode[] = [
      { id: `${ownFile}:1:run`, name: "run", file: ownFile, line: 1, exported: true },
    ];
    const m = manifest({ autoload: { psr4: {}, psr0: { App_: ["lib/"] }, classmap: [], files: [] } });

    const ids = resolvePhpPublicApiIds(dir, nodes, m);

    expect(ids.has(nodes[0]!.id)).toBe(true);
  });

  test("autoload-dev namespaces are NOT scoped in (test scaffolding, not published public surface)", () => {
    const testFile = join(dir, "tests", "WidgetTest.php");
    const nodes: SymbolNode[] = [
      { id: `${testFile}:1:testIt`, name: "testIt", file: testFile, line: 1, exported: true },
    ];
    const m = manifest({
      autoload: { psr4: {}, psr0: {}, classmap: [], files: [] },
      autoloadDev: { psr4: { "Tests\\": ["tests/"] }, psr0: {}, classmap: [], files: [] },
    });

    const ids = resolvePhpPublicApiIds(dir, nodes, m);

    expect(ids.size).toBe(0);
  });

  test("no autoload psr-4/psr-0 entries at all -> empty set", () => {
    const someFile = join(dir, "src", "X.php");
    const nodes: SymbolNode[] = [
      { id: `${someFile}:1:x`, name: "x", file: someFile, line: 1, exported: true },
    ];
    const ids = resolvePhpPublicApiIds(dir, nodes, manifest());
    expect(ids.size).toBe(0);
  });

  test("a psr-4 prefix mapped to the package root itself does not quarantine every file in the target (root-mapped-prefix guard)", () => {
    const ownFile = join(dir, "src", "Widget.php");
    const unrelatedFile = join(dir, "scripts", "Standalone.php");
    const nodes: SymbolNode[] = [
      { id: `${ownFile}:1:doThing`, name: "doThing", file: ownFile, line: 1, exported: true },
      { id: `${unrelatedFile}:1:outside`, name: "outside", file: unrelatedFile, line: 1, exported: true },
    ];
    // A root-mapped prefix ({"App\\": ""}) is a valid but unusual composer.json
    // shape — without the guard this would resolve to `dir` itself and match
    // every file in the scanned target.
    const m = manifest({ autoload: { psr4: { "App\\": [""] }, psr0: {}, classmap: [], files: [] } });

    const ids = resolvePhpPublicApiIds(dir, nodes, m);

    expect(ids.size).toBe(0);
  });
});
