import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { explain } from "../src/engine/explain.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-explain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<void> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

/**
 * A 2-hop call chain, entirely PHP: `ServiceTest::testChain()` (a PHPUnit
 * `*Test.php`-convention-resolved test entry) calls `$this->service->foo()`
 * (a typed-property `->` call into `ServiceA`), which itself calls
 * `$this->other->bar()` (a second typed-property `->` call into
 * `ServiceB`). `composer.json` declares `autoload-dev` for `Tests\`
 * alongside `autoload` for `App\` — without it, `ServiceTest`'s own
 * one-property-hop call would silently produce no edge at all (see
 * `test/graph-php-symbol-graph-fixtures.test.ts`'s `autoload-dev-gotcha`
 * fixture for an isolated demonstration of exactly that failure).
 */
async function writeFixture(): Promise<void> {
  await write(
    "composer.json",
    JSON.stringify({
      autoload: { "psr-4": { "App\\": "src/" } },
      "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
    }),
  );
  await write(
    "src/ServiceB.php",
    [
      "<?php",
      "namespace App;",
      "",
      "class ServiceB {",
      "    public function bar(): string {",
      "        return 'target';",
      "    }",
      "",
      "    public function deadMethod(): string {",
      "        return 'never called';",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  await write(
    "src/ServiceA.php",
    [
      "<?php",
      "namespace App;",
      "",
      "class ServiceA {",
      "    private ServiceB $other;",
      "",
      "    public function foo(): string {",
      "        return $this->other->bar();",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  await write(
    "tests/ServiceTest.php",
    [
      "<?php",
      "namespace Tests;",
      "",
      "use App\\ServiceA;",
      "",
      "class ServiceTest {",
      "    private ServiceA $service;",
      "",
      "    public function testChain(): string {",
      "        return $this->service->foo();",
      "    }",
      "}",
      "",
    ].join("\n"),
  );
}

describe("explain — PHP symbols (75-01 T8, AC-7)", () => {
  test("a test-reachable PHP symbol resolves with a 2-hop witness chain (entry -> edge -> edge -> target), proving T2's edges feed explain, not just classify", async () => {
    await writeFixture();
    const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

    const result = await explain(dir, config, "bar");
    if (result.status !== "resolved") throw new Error(`expected resolved, got ${result.status}`);

    // NOT "alive": verified directly this session (see
    // graph-php-symbol-graph-fixtures.test.ts's KNOWN GAP test) that no
    // composer-bin/public-index.php/config prod-entry mechanism currently
    // roots any PHP SymbolNode id into `prodEntries` — only PHP TEST entries
    // get that treatment (`model.ts`'s `phpEntries.testEntries` node-rooting
    // loop). So a genuine prod-`alive` PHP trace isn't constructible against
    // the current wiring at all; `test-only` is the strongest non-dead
    // verdict achievable for any PHP fixture today, and `explain()`'s
    // `test-only` branch runs the identical `tracePath` mechanism over
    // `union(prodEntries, testEntries)` that the `alive` branch would use
    // over `prodEntries` alone — so this still proves exactly what this test
    // exists to prove (T2's edges feeding `explain`'s witness reconstruction,
    // not just `classify`'s reachability coloring).
    expect(result.reachability).toBe("test-only");
    expect(result.tainted).toBe(false);
    expect(result.witness).not.toBeNull();

    const chain = result.witness ?? [];
    // entry (rooted test method) -> edge -> intermediate method -> edge -> target.
    expect(chain.map((n) => n.name)).toEqual(["testChain", "foo", "bar"]);
    expect(chain[chain.length - 1]?.id).toBe(result.symbol.id);
    expect(chain[0]?.file).toMatch(/ServiceTest\.php$/);
    expect(chain[1]?.file).toMatch(/ServiceA\.php$/);
    expect(chain[2]?.file).toMatch(/ServiceB\.php$/);
  });

  test("a dead PHP symbol reports unreachable with no witness chain", async () => {
    await writeFixture();
    const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

    const result = await explain(dir, config, "deadMethod");
    if (result.status !== "resolved") throw new Error(`expected resolved, got ${result.status}`);

    expect(result.reachability).toBe("dead");
    expect(result.witness).toBeNull();
    expect(result.inbound).toEqual([]);
  });
});
