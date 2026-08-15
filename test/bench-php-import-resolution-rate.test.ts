import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { computeResolutionRate, isLocalClassImportCandidate, parseArgs } from "../src/bench/php-import-resolution-rate.js";

const RESOLVER_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "php-composer-resolver");
const RATE_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "php-bench-resolution-rate");

describe("parseArgs", () => {
  test("parses --repo", () => {
    expect(parseArgs(["--repo", "/some/path"])).toEqual({ repo: "/some/path" });
  });

  test("throws without --repo", () => {
    expect(() => parseArgs([])).toThrow("--repo");
  });
});

describe("computeResolutionRate (AC-4)", () => {
  test("aggregates resolved/total across every local `use` import in a fixture tree", async () => {
    const result = await computeResolutionRate(join(RESOLVER_FIXTURES, "basic-app"));
    expect(result).toEqual({ total: 1, resolved: 1, rate: 1 });
  });

  test("use imports of namespaces this repo never declared are excluded as non-local, not counted as failures", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "external-only"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });

  test("a reference into a namespace with zero discovered sibling files is excluded as non-local, not a failure (mirrors guzzle's real GuzzleHttp\\Psr7\\*/GuzzleHttp\\Promise\\* pattern — separate composer packages sharing a namespace root, empirically discovered running this harness against guzzle, AC-4)", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "missing-target"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });

  test("a reference into an otherwise-populated namespace (real siblings exist) to a target that doesn't exist still counts as a real failure", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "same-namespace-missing"));
    expect(result).toEqual({ total: 1, resolved: 0, rate: 0 });
  });

  test("a bare namespace-alias import (`use App\\External;`) is excluded, proven a namespace by another import elsewhere referencing a sub-symbol of it (cross-import evidence, mirrors guzzle's `use GuzzleHttp\\Psr7;`, AC-4)", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "namespace-alias-cross-import"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });

  test("a bare namespace-alias import for this repo's own namespace is excluded, proven a namespace by the repo's own map (self-evidenced, no cross-import needed, mirrors guzzle's `use GuzzleHttp\\Handler;`, AC-4)", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "namespace-alias-self-evidenced"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });

  test("a class that is ALSO a namespace prefix for real sibling helper classes still counts as resolved (regression: phpunit's own PHPUnit\\Framework\\TestCase, both a real class and a namespace container, AC-4)", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "class-also-namespace-prefix"));
    expect(result).toEqual({ total: 2, resolved: 2, rate: 1 });
  });

  test("function-kind use imports are excluded even when their namespace is local", async () => {
    const result = await computeResolutionRate(join(RATE_FIXTURES, "function-import"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });

  test("missing composer.json: empty autoload map means nothing is ever local, total stays 0", async () => {
    const result = await computeResolutionRate(join(RESOLVER_FIXTURES, "no-manifest"));
    expect(result).toEqual({ total: 0, resolved: 0, rate: 0 });
  });
});

describe("isLocalClassImportCandidate", () => {
  // "App" and "App\Models" are populated because some discovered class lives
  // directly in each (mirrors what `namespacePrefixesOf` would derive from a
  // map containing e.g. "App\Consumer" and "App\Models\User").
  const populated = new Set(["App", "App\\Models"]);
  // No cross-import evidence in most cases below — `knownNamespaces` starts
  // as just `populated` unless a test says otherwise.

  test("a resolved class-kind import whose containing namespace is populated is local", () => {
    expect(isLocalClassImportCandidate("App\\Models\\User", "class", true, populated, populated)).toBe(true);
  });

  test("an unresolved class-kind import whose containing namespace has zero discovered siblings is not local", () => {
    expect(isLocalClassImportCandidate("App\\Psr7\\Message", "class", false, populated, populated)).toBe(false);
  });

  test("an unresolved class-kind import entirely outside every populated namespace is not local", () => {
    expect(isLocalClassImportCandidate("Vendor\\External\\Thing", "class", false, populated, populated)).toBe(false);
  });

  test("function/const imports are never local, even resolved with a populated containing namespace", () => {
    expect(isLocalClassImportCandidate("App\\format", "function", true, populated, populated)).toBe(false);
    expect(isLocalClassImportCandidate("App\\MAX", "const", true, populated, populated)).toBe(false);
  });

  test("an unresolved bare namespace-alias import is excluded even though its containing namespace is populated, when it's itself a known namespace", () => {
    // "App\Handler" would otherwise pass the containing-namespace ("App") check.
    const knownNamespaces = new Set([...populated, "App\\Handler"]);
    expect(isLocalClassImportCandidate("App\\Handler", "class", false, populated, knownNamespaces)).toBe(false);
  });

  test("a RESOLVED import always counts as local, even when it's also a known namespace elsewhere (a class can legitimately root its own sibling helpers' namespace)", () => {
    const knownNamespaces = new Set([...populated, "App\\TestCase"]);
    expect(isLocalClassImportCandidate("App\\TestCase", "class", true, populated, knownNamespaces)).toBe(true);
  });
});
