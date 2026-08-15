import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-entries-merge-"));
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

const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

describe("buildReachabilityModel — PHP entry-point resolution merge (75-01 T4, AC-4)", () => {
  test("composer bin + public/index.php resolve into prodEntries via the same first-mechanism-wins merge as Python", async () => {
    await write(
      "composer.json",
      JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } }, bin: "bin/console.php" }),
    );
    const binFile = await write("bin/console.php", "<?php\necho 'hi';\n");
    const indexFile = await write("public/index.php", "<?php\nrequire 'x';\n");

    const model = await buildReachabilityModel(dir, config);

    expect(model.prodEntries.has(binFile)).toBe(true);
    expect(model.prodEntries.has(indexFile)).toBe(true);
    const sources = model.entryResolution.sources;
    expect(sources.some((s) => s.source === "composer-bin")).toBe(true);
    expect(sources.some((s) => s.source === "convention")).toBe(true);
    // No longer collapsed now that PHP entries actually resolve (pinned in
    // model-php-merge.test.ts, T3, as the signal this phase flips).
    expect(model.entryResolution.collapsed).toBe(false);
  });

  test("a PHPUnit-resolved test file's own test methods are test-reachable, not just the file itself", async () => {
    // PHP graph nodes are class members, never file-level nodes — a bare
    // file-path testEntries seed alone roots nothing. This proves the
    // model.ts node-rooting loop actually fires for PHP's PHPUnit-derived
    // test files (mirrors the isTestFile-plugin node-rooting loop already
    // proven for TS/Python entry files).
    const testFile = await write(
      "tests/CalculatorTest.php",
      [
        "<?php",
        "namespace Tests;",
        "",
        "class CalculatorTest {",
        "    public function testAddsTwoNumbers() {",
        "        return 1;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);

    // No phpunit.xml present -> falls back to the *Test.php convention.
    expect(model.testEntries.has(testFile)).toBe(true);

    const testMethodNode = model.graph.nodes.find(
      (n) => n.file === testFile && n.name === "testAddsTwoNumbers",
    );
    expect(testMethodNode).toBeDefined();
    expect(model.testEntries.has(testMethodNode?.id ?? "")).toBe(true);

    const verdict = model.reachability.find((r) => r.id === testMethodNode?.id);
    // Rooted directly as a test entry (not via any prod edge) -> test-only,
    // not dead. Before the node-rooting fix, this method had no seed at all
    // (only the file path was in testEntries) and would read `dead`.
    expect(verdict?.reachability).toBe("test-only");
  });

  test("a composer-bin/public/index.php entry file that itself declares a class roots that class's own methods into prodEntries (75-01 T9, AC-4, AC-7)", async () => {
    // Mirrors the PHPUnit test-entry node-rooting case above, but for prod:
    // PHP graph nodes are class members, never file-level nodes, so a bare
    // file-path prodEntries seed (the pre-T9 behavior) roots nothing when the
    // entry file itself declares a class. An unusual but grammatically legal
    // PHP shape — a real composer `bin` script or `public/index.php` more
    // typically bootstraps into a separately-declared class (T10's job) —
    // but this proves the node-rooting mechanism itself works.
    await write(
      "composer.json",
      JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } }, bin: "public/index.php" }),
    );
    const indexFile = await write(
      "public/index.php",
      [
        "<?php",
        "class Foo {",
        "    public function bar() {",
        "        return 1;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);

    const barNode = model.graph.nodes.find(
      (n) => n.file === indexFile && n.name === "bar",
    );
    expect(barNode).toBeDefined();
    expect(model.prodEntries.has(barNode?.id ?? "")).toBe(true);

    const verdict = model.reachability.find((r) => r.id === barNode?.id);
    // Rooted directly as a prod entry -> alive, not dead. Before the T9
    // node-rooting fix, this method had no seed at all (only the file path
    // was in prodEntries, and nothing references `bar()`) and read `dead`.
    expect(verdict?.reachability).toBe("alive");
  });

  test("a PHPUnit-resolved test method reached via a called production method roots that production method as test-reachable", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        autoload: { "psr-4": { "App\\": "src/" } },
        "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
      }),
    );
    const calcFile = await write(
      "src/Calculator.php",
      [
        "<?php",
        "namespace App;",
        "",
        "class Calculator {",
        "    public function add(int $a, int $b): int {",
        "        return $a + $b;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    // The reference-edge resolver (T2) resolves `->` chains through a typed
    // parameter/property annotation or `$this` — not local-variable type
    // inference from `new X()` — so the call is routed through a typed
    // `$this->calc` property, the supported one-level property-access shape.
    await write(
      "tests/CalculatorTest.php",
      [
        "<?php",
        "namespace Tests;",
        "",
        "use App\\Calculator;",
        "",
        "class CalculatorTest {",
        "    private Calculator $calc;",
        "    public function testAdd() {",
        "        $this->calc->add(1, 2);",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);

    const addNode = model.graph.nodes.find(
      (n) => n.file === calcFile && n.name === "add",
    );
    expect(addNode).toBeDefined();
    const verdict = model.reachability.find((r) => r.id === addNode?.id);
    // Reached transitively from the rooted test method via the
    // composer-autoload-resolved `$c->add(...)` call edge (T2) — test-only
    // (not `dead`), since the only path to it is via the test root.
    expect(verdict?.reachability).toBe("test-only");
  });
});
