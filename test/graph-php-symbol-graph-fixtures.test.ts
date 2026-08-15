import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";
import { scan } from "../src/engine/index.js";

const FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "php-symbol-graph",
);
const PHP_CONFIG = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

function rel(file: string, base: string): string {
  return file.startsWith(base) ? file.slice(base.length + 1) : file;
}

/**
 * End-to-end PHP fixture suite (75-01 T8, AC-7). Three real, on-disk fixture
 * repos under `test/fixtures/php-symbol-graph/` exercise every mechanism
 * T1-T6 built:
 *
 * - `app/` — the main narrative fixture: a typed-property `->` chain
 *   (T1+T2+T3), a trait-composed method call (T2's trait-edge-direction
 *   rule), a magic method tainting its file (T6), a composer `bin` entry +
 *   `public/index.php` convention entry + PHPUnit-resolved test file (T4),
 *   and a genuinely-unreferenced baseline method.
 * - `library/` — a library-shaped composer.json (T5's PSR-4-namespace
 *   quarantine). Kept as its own target: `isPhpLibrary` is vetoed by
 *   `public/index.php`'s presence, and a positive `isPhpLibrary` result
 *   quarantines *every* node under the package's own PSR-4 dirs, which would
 *   clobber `app/`'s "genuinely dead reads `likely`" baseline if the two
 *   were merged.
 * - `autoload-dev-gotcha/` — a minimal, isolated demonstration of a real
 *   T2 resolver limitation (see that describe block).
 *
 * IMPORTANT — this suite intentionally encodes one confirmed gap in T3/T4's
 * actual shipped wiring (the "KNOWN GAP" test below): a PHP method invoked
 * only from a composer-`bin`/`public/index.php` entry point currently reads
 * `dead`, not `alive`, because nothing ever seeds a PHP `SymbolNode` id into
 * `prodEntries` (verified directly against `model.ts`; see that test's own
 * comment for the full mechanism). That assertion is a *regression lock on
 * the current (wrong) behavior*, not a validation of it — if it ever starts
 * failing, the wiring was fixed, and this test's expectation should be
 * updated to `alive`/`likely`, not reverted back to `dead`.
 */
describe("PHP symbol graph — end-to-end fixture suite (75-01 T8, AC-7)", () => {
  const appDir = join(FIXTURES_ROOT, "app");

  test("app fixture: hand-computed truth table matches necro scan() exactly", async () => {
    const { findings, diagnostics } = await scan(appDir, PHP_CONFIG, {
      complexity: false,
    });

    // Hand-computed truth table (see the fixture files' own doc comments for
    // why each symbol lands where it does). Every declared method/property in
    // the fixture is accounted for — asserting the exact set, not a subset,
    // is the point of "matches that truth table exactly" (AC-7).
    const actual = findings
      .map((f) => ({
        file: rel(f.node.file, appDir),
        name: f.node.name,
        verdict: f.verdict,
        tier: f.tier,
        autoFixEligible: f.autoFixEligible,
      }))
      .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));

    const expected = [
      // Orphan::neverCalled — the negative-case baseline: no caller anywhere
      // (prod, test, or trait/interface dispatch), no taint, not public API.
      // Proves the truth table isn't "everything defaults to live." Tier
      // `likely` (never `certain`) is the OBSERVED baseline for every
      // exported PHP node — `buildPhpSymbolGraph` (T1) sets `exported: true`
      // unconditionally, so `classify.ts`'s `deadTier` returns `likely` at
      // its `node.exported` check before T7's AC-6 tier cap
      // (`rawTier === "certain" && isPhpFile(...) -> "likely"`) is ever
      // consulted — the cap is redundant given this fixture's shapes, not
      // exercised by it. T7's own dedicated unit coverage
      // (`test/classify.test.ts`'s "classify — PHP tier cap" describe block,
      // built with `exported: false`) is what actually exercises the cap;
      // this fixture just pins the real end-to-end baseline.
      { file: "src/Orphan.php", name: "neverCalled", verdict: "dead", tier: "likely", autoFixEligible: false },

      // Worker::work — genuinely dead too (nobody calls $worker->work()),
      // living alongside Worker's trait-composed, very-much-alive `log()`
      // (which has no node of its own on Worker at all — see below). A
      // second baseline, incidental to the trait-composition case.
      { file: "src/Worker.php", name: "work", verdict: "dead", tier: "likely", autoFixEligible: false },

      // BinTarget::run — no longer a finding at all (75-01 T10 fixed the
      // KNOWN GAP: `bin/console.php`'s top-level `$target = new
      // BinTarget(); $target->run();` now produces a real edge, and
      // `bin/console.php` is a resolved prod entry, so `run` reads `alive`
      // and `classify()` never emits a finding for an alive node). See the
      // dedicated test below for the full mechanism.

      // MagicBox declares __call (T6's magic-method taint) — the WHOLE FILE
      // is tainted (file-granular, not member-granular), so every member of
      // MagicBox reads `maybe`, not `likely`, even members with nothing to
      // do with the dynamic dispatch itself ($data, a plain property with no
      // resolvable declared type; unreferenced(), a plain method).
      { file: "src/MagicBox.php", name: "data", verdict: "dead", tier: "maybe", autoFixEligible: false },
      { file: "src/MagicBox.php", name: "__call", verdict: "dead", tier: "maybe", autoFixEligible: false },
      { file: "src/MagicBox.php", name: "unreferenced", verdict: "dead", tier: "maybe", autoFixEligible: false },

      // The typed-property `->` chain + trait-composition case (T1+T2+T3
      // wiring — see the dedicated edge-level test below for the actual
      // edges). tests/AppTest.php is resolved as a test entry (T4, `*Test.php`
      // convention, no phpunit.xml present), so its own two methods AND its
      // two typed properties are all directly rooted into testEntries
      // (model.ts's PHP-test-entry node-rooting loop, mirroring the
      // pluginProdEntryFiles precedent) — trivially `test-only`, not because
      // anything calls them, but because being IN a resolved test-entry file
      // roots every node in it regardless of kind (method or property).
      { file: "tests/AppTest.php", name: "caller", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      { file: "tests/AppTest.php", name: "worker", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      { file: "tests/AppTest.php", name: "renderable", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      { file: "tests/AppTest.php", name: "testInvokesGreeter", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      { file: "tests/AppTest.php", name: "testCallsTraitMethod", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      { file: "tests/AppTest.php", name: "testRendersThroughInterface", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      // Caller::invoke — reached from testInvokesGreeter via a direct
      // `$this->caller->invoke(...)` typed-property call. (invoke()'s own
      // typed-PARAMETER call `$greeter->greet()` is a second, independent
      // T2 resolution shape chained onto the first — but Greeter::greet
      // itself is no longer a finding: `public/index.php`'s top-level
      // `$greeter = new Greeter(); echo $greeter->greet();` is ALSO a real
      // edge as of 75-01 T10, and `public/index.php` is a resolved prod
      // entry, so `greet` reads `alive` via that independent path,
      // regardless of this test-only one.)
      { file: "src/Caller.php", name: "invoke", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      // Loggable::log — the trait-composition case. Worker never redeclares
      // `log()`, so `Worker::log` has no SymbolNode of its own; the call
      // `$this->worker->log("hi")` resolves DIRECTLY to Loggable's own node
      // (T2's documented "no synthetic node on the composing class" rule).
      { file: "src/Loggable.php", name: "log", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      // The interface-implementation "virtual dispatch" pairing case.
      // `$this->renderable->render()` (renderable typed as the INTERFACE)
      // resolves the direct call edge to `Renderable::render` — the only
      // statically-known target (interface methods are bodiless but still
      // get a SymbolNode, per T1). This is genuinely the highest-stakes T2
      // mechanism: without the pairing edge below, EVERY concrete
      // implementation of an interface-typed call site would falsely read
      // dead.
      { file: "src/Renderable.php", name: "render", verdict: "test-only", tier: "maybe", autoFixEligible: false },
      // HtmlRenderer::render — reached only via the pairing edge
      // (`Renderable::render` -> `HtmlRenderer::render`), never by direct
      // call-site resolution (nothing in this fixture calls
      // `$htmlRenderer->render()` on the concrete type). If this reads
      // `dead` instead of `test-only`, the pairing edge stopped firing
      // end-to-end (it otherwise only has unit-level coverage in
      // `test/graph-php-reference-edges.test.ts`).
      { file: "src/HtmlRenderer.php", name: "render", verdict: "test-only", tier: "maybe", autoFixEligible: false },
    ].sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));

    expect(actual).toEqual(expected);
    expect(findings.length).toBe(expected.length);

    // entryResolution.collapsed reads false here — but see the KNOWN GAP
    // test below for why that's a misleading diagnostic for PHP specifically.
    expect(diagnostics.entryResolution.collapsed).toBe(false);
  });

  test("app fixture: typed-property `->` chain, trait composition, and interface-implementation pairing produce real edges in the merged graph (T1+T2+T3 wiring)", async () => {
    const model = await buildReachabilityModel(appDir, PHP_CONFIG);
    const id = (file: string, line: number, name: string) =>
      `${join(appDir, file)}:${line}:${name}`;

    // Exactly 7 edges in this fixture: the typed-property chain
    // (AppTest -> Caller -> Greeter), the trait-composition call
    // (AppTest -> Loggable, directly — never a synthetic Worker::log node),
    // the interface case's TWO edges — the direct call-site edge
    // (AppTest -> Renderable, the interface's own node) plus the separate
    // pairing edge (Renderable -> HtmlRenderer) that carries reachability on
    // to the concrete implementation — and, as of 75-01 T10 (fixing the
    // KNOWN GAP below), the top-level script edges from `bin/console.php`
    // and `public/index.php`: `from` is deliberately the bare entry-file
    // path, not a `file:line:name` id (there is no node for "the script
    // itself" — see `buildPhpReferenceEdges`'s module docstring).
    const binConsole = join(appDir, "bin/console.php");
    const publicIndex = join(appDir, "public/index.php");
    expect(model.graph.edges).toEqual(
      expect.arrayContaining([
        { from: id("src/Caller.php", 15, "invoke"), to: id("src/Greeter.php", 7, "greet"), kind: "prod" },
        { from: id("tests/AppTest.php", 29, "testInvokesGreeter"), to: id("src/Caller.php", 15, "invoke"), kind: "prod" },
        { from: id("tests/AppTest.php", 34, "testCallsTraitMethod"), to: id("src/Loggable.php", 13, "log"), kind: "prod" },
        { from: id("tests/AppTest.php", 46, "testRendersThroughInterface"), to: id("src/Renderable.php", 19, "render"), kind: "prod" },
        { from: id("src/Renderable.php", 19, "render"), to: id("src/HtmlRenderer.php", 8, "render"), kind: "prod" },
        { from: binConsole, to: id("src/BinTarget.php", 17, "run"), kind: "prod" },
        { from: publicIndex, to: id("src/Greeter.php", 7, "greet"), kind: "prod" },
      ]),
    );
    expect(model.graph.edges).toHaveLength(7);

    // No edge ever targets Worker itself (`use Loggable;` doesn't create a
    // synthetic Worker::log node) — confirms the "resolves to the trait's
    // own file" half of T2's documented rule, not just its existence.
    const workerFile = join(appDir, "src/Worker.php");
    expect(model.graph.edges.some((e) => e.to.startsWith(`${workerFile}:`))).toBe(false);
  });

  test("FIXED (was KNOWN GAP): a method invoked ONLY from a composer-`bin`/`public/index.php` entry point now reads alive — 75-01 T10", async () => {
    // Mechanism, verified directly against `src/engine/model.ts` and
    // `src/graph/php/reference-edges.ts` (not inferred): `resolvePhpEntries`
    // (T4) resolves `bin/console.php` and `public/index.php` into
    // `prodEntries` as BARE FILE PATHS (`model.ts`'s
    // `for (const record of phpEntries.records) { ... prodEntries.add(record.file) ... }`).
    // Until 75-01 T10, `buildPhpReferenceEdges` (T2) only extracted call
    // sites from INSIDE a class method's own body
    // (`methodDeclsOf(typeNode.body)`) — it never walked top-level script
    // statements at all, so `bin/console.php`'s `$target = new BinTarget();
    // $target->run();` (realistic composer `bin`-script code) produced ZERO
    // edges, and no PHP node id sourced from composer-bin/public/index.php
    // could ever reach `alive`.
    //
    // T10 fixed this: `buildPhpReferenceEdges` now also walks each file's
    // TOP-LEVEL statements (outside every class/interface/trait/enum body)
    // for `member_call_expression` sites, resolving `object:` through a
    // top-level-only `$var = new ClassName();` environment. The resulting
    // edge is `from: <bare file path>` (matching `prodEntries`' own bare
    // file-path seed shape for these entries — see the edge-level test
    // above for the literal edges), so `computeReachability`'s prod BFS now
    // reaches `BinTarget::run` (via `bin/console.php`) and, independently,
    // `Greeter::greet` (via `public/index.php`).
    //
    // This test previously asserted the CURRENT-AT-THE-TIME (wrong) `dead`
    // verdict as a regression lock, with an explicit instruction to update
    // the expectation — not revert it — once the gap was fixed. This is
    // that update: `run` is asserted `alive` both directly
    // (`buildReachabilityModel`'s own `reachability` array) and indirectly
    // (an alive node is never a `classify()` finding — `run` no longer
    // appears in `findings` at all).
    const { findings, diagnostics } = await scan(appDir, PHP_CONFIG, {
      complexity: false,
    });

    expect(diagnostics.entryResolution.sources).toContainEqual({
      file: "bin/console.php",
      source: "composer-bin",
    });
    expect(diagnostics.entryResolution.sources).toContainEqual({
      file: "public/index.php",
      source: "convention",
    });
    // `collapsed` is computed from whether any prod-entry FILE resolved at
    // all (it did: 2 of them), not from whether that entry actually rooted
    // any graph node — this diagnostic was already `false` before T10 too,
    // so it's unaffected by this fix; asserted here for completeness.
    expect(diagnostics.entryResolution.collapsed).toBe(false);

    // `run` is alive now, so `classify()` never emits a finding for it
    // (`classify.ts`: `if (!node || result.reachability === "alive") continue;`).
    const finding = findings.find((f) => f.node.name === "run");
    expect(finding).toBeUndefined();

    // Positive confirmation, straight from reachability, not just an
    // absence of a finding: `BinTarget::run`'s own node id reads `alive` in
    // `buildReachabilityModel`'s `reachability` array.
    const model = await buildReachabilityModel(appDir, PHP_CONFIG);
    const runId = `${join(appDir, "src/BinTarget.php")}:17:run`;
    const runResult = model.reachability.find((r) => r.id === runId);
    expect(runResult).toBeDefined();
    expect(runResult?.reachability).toBe("alive");
  });

  test("library fixture: a dead PSR-4-namespace method in a library package quarantines to maybe (T5, AC-5)", async () => {
    const libDir = join(FIXTURES_ROOT, "library");
    // `entries: ["lib/Bootstrap.php"]` is an unrelated prod entry, purely so
    // `entryResolution.collapsed` is false — isolating this assertion to the
    // quarantine mechanism alone (mirrors `scan-php-library-quarantine.test.ts`'s
    // established `Bootstrap.php` precedent, reused here against real
    // on-disk fixture files instead of an inline mkdtemp repo).
    const libConfig = { ...PHP_CONFIG, entries: ["lib/Bootstrap.php"] };

    const { findings, diagnostics } = await scan(libDir, libConfig, {
      complexity: false,
    });

    expect(diagnostics.entryResolution.collapsed).toBe(false);
    const finding = findings.find((f) => f.node.name === "doThing");
    expect(finding).toBeDefined();
    expect(finding?.verdict).toBe("dead");
    // Without library quarantine this would read `likely` (same shape as
    // `Orphan::neverCalled` in the app fixture) — `maybe` here is the
    // observable proof `resolvePhpPublicApiIds` (T5) actually fired.
    expect(finding?.tier).toBe("maybe");
    expect(finding?.autoFixEligible).toBe(false);
  });

  describe("autoload-dev-gotcha fixture: a known T2 resolver limitation, documented on purpose (not routed around)", () => {
    // The task packet's own flagged gotcha, verified directly this session:
    // T2's one-property-hop `->` resolution (`$this->prop->method()`) needs
    // to look up the CALLING class's own declared-property types via
    // `getTypeInfo(ownFqcn)` — which requires `classToFile.get(ownFqcn)` to
    // succeed, which requires the calling class's OWN file to be covered by
    // SOME composer autoload psr-4 block (`autoload` or `autoload-dev`).
    // This fixture's `composer.json` deliberately maps `App\` (`src/`) but
    // nothing else — `scripts/Caller.php` (namespace `Scripts\`) is covered
    // by neither `autoload` nor `autoload-dev`. `Caller::invoke()`'s call
    // `$this->service->run()` is otherwise a perfectly ordinary, resolvable
    // one-property-hop call to a well-mapped target (`Service::run`, under
    // `App\`) — it silently produces NO edge anyway, purely because the
    // CALLER's own file isn't in the map. (The `app/` fixture above avoids
    // this by declaring `autoload-dev` for `Tests\` — see that fixture's
    // `tests/AppTest.php` doc comment.)
    test("a one-property-hop call from a class outside every psr-4 prefix produces zero edges, even though the target resolves fine on its own", async () => {
      const gotchaDir = join(FIXTURES_ROOT, "autoload-dev-gotcha");
      const model = await buildReachabilityModel(gotchaDir, PHP_CONFIG);

      // Both nodes exist (T1 doesn't care about autoload coverage) —
      // confirms this is specifically an edge-resolution gap, not a
      // discovery/node-extraction one.
      expect(
        model.graph.nodes.some((n) => n.file === join(gotchaDir, "scripts/Caller.php") && n.name === "invoke"),
      ).toBe(true);
      expect(
        model.graph.nodes.some((n) => n.file === join(gotchaDir, "src/Service.php") && n.name === "run"),
      ).toBe(true);

      // The call site exists in the source (`$this->service->run()`) but
      // produces no edge at all.
      expect(model.graph.edges).toHaveLength(0);
    });
  });
});
