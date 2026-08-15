import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  computeReachability,
  findTaintedFiles,
  type ReachabilityResult,
} from "../analyze/reachability.js";
import type { NecroConfig } from "../config.js";
import { discoverFiles } from "../discover.js";
import { globMatcher } from "../glob.js";
import { buildComposerAutoloadMap } from "../graph/php/composer-autoload.js";
import { readComposerManifest } from "../graph/php/composer-manifest.js";
import { findPhpTaintedFiles } from "../graph/php/dynamic-dispatch.js";
import { isPhpFile } from "../graph/php/language.js";
import { isPhpLibrary, resolvePhpPublicApiIds } from "../graph/php/library.js";
import { resolvePhpEntries } from "../graph/php/php-entries.js";
import { buildPhpReferenceEdges } from "../graph/php/reference-edges.js";
import { buildPhpSymbolGraph } from "../graph/php/symbol-graph.js";
import { isPythonFile } from "../graph/python/language.js";
import {
  buildPythonModuleMap,
  detectImportRoots,
} from "../graph/python/module-resolver.js";
import { buildPythonSymbolGraph } from "../graph/python/symbol-graph.js";
import { buildSymbolGraphCached } from "../graph/symbol-graph-cache.js";
import { resolvePublicApiIds } from "../graph/symbol-graph-public-api.js";
import type { SymbolEdge, SymbolGraph } from "../graph/types.js";
import { resolveEntries } from "../plugins/entry-resolver.js";
import { createNextjsPlugin } from "../plugins/nextjs/index.js";
import { createPytestPlugin } from "../plugins/pytest/index.js";
import { createRepoContext, detectPlugins } from "../plugins/registry.js";
import { createTestRunnerPlugin } from "../plugins/test-runner/index.js";
import type { FrameworkPlugin, RepoContext } from "../plugins/types.js";
import { type EntrySource, resolveProdEntries } from "./prod-entries.js";
import { resolvePythonEntries } from "./python-entries.js";
import { resolveWorkspaces } from "./workspaces.js";

const PLUGINS: FrameworkPlugin[] = [
  createTestRunnerPlugin(),
  createNextjsPlugin(),
  createPytestPlugin(),
];

/** One resolved production entry, for the `entryResolution` diagnostic (§2.1). */
export interface EntryResolutionRecord {
  /** Path relative to the scan target. */
  file: string;
  source: EntrySource;
}

/**
 * Fail-closed diagnostic (§2.1): how many production entries resolved, where
 * each came from, and whether reachability collapsed (zero entries on a
 * non-empty graph — the condition `classify()` demotes every `dead` finding
 * under, and `fix` refuses on).
 */
export interface EntryResolution {
  prodEntryCount: number;
  sources: EntryResolutionRecord[];
  collapsed: boolean;
}

/**
 * The shared reachability substrate: the symbol graph, the entry seeds, the
 * exact edge set fed to the two-color sweep (graph edges + plugin synthetic
 * edges), and the per-node verdicts. `scan` classifies findings from it;
 * `explain` traces witness chains through the same edges so a trace always
 * matches the verdict.
 */
export interface ReachabilityModel {
  /** Source files discovered under the target. */
  files: string[];
  /** Raw symbol graph (graph.edges does NOT include synthetic plugin edges). */
  graph: SymbolGraph;
  /** Edge set the sweep actually traversed: `graph.edges` + synthetic edges. */
  edges: SymbolEdge[];
  prodEntries: Set<string>;
  testEntries: Set<string>;
  taintedFiles: Set<string>;
  reachability: ReachabilityResult[];
  /** File contents (read once; reused by the complexity axis). */
  sources: Array<{ file: string; text: string }>;
  entryResolution: EntryResolution;
  /** Externally-consumable symbol ids in a library target (§2.3, phase 75 T5 for PHP) — quarantined to `maybe` by `classify()`. Covers Python (`isPythonLibrary`), TS/JS (`isTsLibrary`), and PHP (`isPhpLibrary`, PSR-4/PSR-0-namespace-scoped, `src/graph/php/library.ts`). Empty for non-library targets. */
  publicApiIds: Set<string>;
}

/**
 * Discover files, build the symbol graph, resolve prod + plugin/test entries,
 * and run two-color reachability — the deterministic prelude shared by `scan`
 * and `explain`. Returns an empty-but-valid model when no source files exist.
 */
export async function buildReachabilityModel(
  targetPath: string,
  config: NecroConfig,
): Promise<ReachabilityModel> {
  const files = await discoverFiles(targetPath, config);
  if (files.length === 0) {
    return {
      files,
      graph: { nodes: [], edges: [] },
      edges: [],
      prodEntries: new Set(),
      testEntries: new Set(),
      taintedFiles: new Set(),
      reachability: [],
      sources: [],
      entryResolution: { prodEntryCount: 0, sources: [], collapsed: false },
      publicApiIds: new Set(),
    };
  }

  const ctx = await createRepoContext(targetPath);
  const detected = detectPlugins(PLUGINS, ctx);

  // Workspace members: alias map (so cross-package refs resolve) + entry files
  // (so executed member entries are rooted). Empty for single-package repos.
  const workspaces = await resolveWorkspaces(targetPath, files);

  // Plugin entries are split by kind: `test` globs seed test roots; `prod` globs
  // (e.g. Next.js file-routing) seed prod roots.
  const entrySpecs = resolveEntries(detected, ctx);
  const relToRoot = (abs: string) => relative(targetPath, abs);

  const testGlobs = entrySpecs
    .filter((e) => e.kind === "test")
    .map((e) => e.glob);
  const matchesTestGlob = globMatcher(testGlobs);
  const isTestFile = (abs: string) => matchesTestGlob(relToRoot(abs));
  const testEntries = new Set(files.filter(isTestFile));

  const prodGlobs = entrySpecs
    .filter((e) => e.kind === "prod")
    .map((e) => e.glob);
  const matchesProdGlob = globMatcher(prodGlobs);
  const pluginProdEntryFiles = new Set(
    files.filter((abs) => matchesProdGlob(relToRoot(abs))),
  );

  // Language partition (AC-5): the TS graph (ts-morph) covers everything but
  // `.py`/`.php`; the Python and PHP graphs are both hand-rolled (no ts-morph
  // equivalent exists for either). `.php` is excluded from `tsFiles` too
  // (phase 72-01) — ts-morph's parser is lenient enough that PHP class/method
  // syntax can produce partial, garbled declarations it treats as real, and
  // then crashes ("Could not find source file") trying to resolve references
  // against them via the underlying TS Program, which never recognized the
  // `.php` extension in the first place. As of phase 75, `.php` files
  // contribute real graph nodes/edges via their own pipeline
  // (`buildPhpSymbolGraph` for class/interface/trait/enum method+property
  // nodes, `buildPhpReferenceEdges` for trait/interface/typed-`->`-chain
  // reference edges, resolved against Phase B's composer-autoload
  // `classToFile` map) — PHP dead-code verdicts are real as of this phase.
  // PHP entry-point resolution (`resolvePhpEntries`, composer `bin`/
  // `public/index.php`/PHPUnit, below) and PHP library quarantine
  // (`isPhpLibrary`/`resolvePhpPublicApiIds`, `src/graph/php/library.ts`,
  // mirroring `isPythonLibrary`/`isTsLibrary` below) also landed this phase.
  // The syntactic axis (complexity/dup/hotspots) still sees `.php` files via
  // `sources`/`files` below, independent of this graph either way. Node ids
  // are file-path-based, so
  // concatenating graphs never collides.
  const pyFiles = files.filter(isPythonFile);
  const phpFiles = files.filter(isPhpFile);
  const tsFiles = files.filter((f) => !isPythonFile(f) && !isPhpFile(f));
  const tsGraph = await buildSymbolGraphCached(targetPath, tsFiles, {
    isTestFile,
    packagePaths: workspaces.packagePaths,
  });
  const pyRoots = detectImportRoots(targetPath, pyFiles);
  const pyModuleMap = buildPythonModuleMap(pyFiles, pyRoots);
  const { graph: pyGraph, starTaintedFiles } = await buildPythonSymbolGraph(
    pyFiles,
    pyModuleMap,
  );
  const composerManifest = await readComposerManifest(targetPath);
  const { classToFile: phpClassToFile } = await buildComposerAutoloadMap(
    targetPath,
    phpFiles,
    composerManifest,
  );
  const phpNodes = await buildPhpSymbolGraph(phpFiles);
  const phpEdges = await buildPhpReferenceEdges(phpFiles, phpClassToFile, {
    isTestFile,
  });
  const graph: SymbolGraph = {
    nodes: [...tsGraph.nodes, ...pyGraph.nodes, ...phpNodes],
    edges: [...tsGraph.edges, ...pyGraph.edges, ...phpEdges],
  };

  const syntheticEdges: SymbolEdge[] = detected.flatMap((p) =>
    p
      .resolveEdges(ctx, graph)
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
  );

  const { entries: prodEntries, records: prodEntryRecords } =
    await resolveProdEntries(targetPath, files, {
      configEntries: config.entries,
    });
  // A framework entry file is invoked by convention, not imported — so root the
  // symbols it *exports* (a file-path seed alone only roots module-top-level
  // references, not the declared-but-unreferenced exports). Genuinely-dead
  // non-entry symbols are untouched.
  for (const file of pluginProdEntryFiles) prodEntries.add(file);
  for (const node of graph.nodes) {
    if (node.exported && pluginProdEntryFiles.has(node.file))
      prodEntries.add(node.id);
  }
  // Symmetric fix for test-kind entry files (e.g. a pytest `test_*.py` file's
  // top-level `def test_foo():`): also invoked by convention, never via an
  // explicit reference, so its exported declarations need the same direct
  // rooting the prod side gets above — language-neutral, not Python-specific.
  for (const node of graph.nodes) {
    if (node.exported && isTestFile(node.file)) testEntries.add(node.id);
  }
  // Workspace member entry files are prod roots (file-path semantics, matching
  // the root package): keeps executed member entries alive. Cross-package
  // *consumed* symbols stay alive via resolved references, not by rooting — so
  // genuinely-unused member exports are still reported.
  for (const entry of workspaces.entryFiles) prodEntries.add(entry);

  // Python entry-point resolution (pyproject scripts, setup.cfg/setup.py
  // console_scripts, __main__/if-name-main modules, conventional filenames) —
  // additive, first-mechanism-wins merge into the same prod-entry diagnostic
  // (§2.3); conftest.py roots into testEntries instead.
  const pythonEntries = await resolvePythonEntries(
    targetPath,
    pyFiles,
    pyModuleMap,
    pyGraph.nodes,
  );
  for (const record of pythonEntries.records) {
    if (!prodEntries.has(record.file)) {
      prodEntries.add(record.file);
      prodEntryRecords.push(record);
    }
    // Seed the specific function too — a bare-file root has no edge into a
    // function merely defined there (§2.3, phase 48: `pkg.mod:func` specs
    // were silently seeding only the file, never the function itself).
    if (record.symbolId) prodEntries.add(record.symbolId);
  }
  for (const file of pythonEntries.testEntries) testEntries.add(file);

  // PHP entry-point resolution (composer `bin`, `public/index.php`
  // convention, PHPUnit `<testsuite>` config or `*Test.php` convention) —
  // additive, first-mechanism-wins merge into the same prod-entry
  // diagnostic (§2.3 PHP), mirroring the Python block above exactly.
  const phpEntries = await resolvePhpEntries(
    targetPath,
    phpFiles,
    composerManifest,
  );
  for (const record of phpEntries.records) {
    if (!prodEntries.has(record.file)) {
      prodEntries.add(record.file);
      prodEntryRecords.push(record);
    }
  }
  for (const file of phpEntries.testEntries) testEntries.add(file);
  // Unlike Python (module-level statement nodes exist) and unlike a bare
  // file-path prod seed, every PHP graph node is a class member (method or
  // property) — there is no file-level node a bare file-path testEntries
  // seed roots. Without this, a PHPUnit-resolved test file's own test
  // methods would read as dead despite the file itself being a registered
  // test entry. Mirrors the `isTestFile` node-rooting loop above
  // (`node.exported && isTestFile(node.file)`), scoped to PHP's
  // composer/PHPUnit-derived test files specifically.
  for (const node of graph.nodes) {
    if (phpEntries.testEntries.has(node.file)) testEntries.add(node.id);
  }
  // Prod-side mirror of the test-entry node-rooting loop directly above
  // (75-01 T9, post-T8 finding): a composer-bin/public/index.php entry file
  // that itself declares a class needs its own members rooted the same way,
  // for the same reason — a bare file-path prodEntries seed roots nothing
  // since PHP has no file-level graph node. No `node.exported` check here
  // (unlike the `pluginProdEntryFiles` loop above): `buildPhpSymbolGraph`
  // (T1) sets `exported: true` unconditionally on every PHP node, so the
  // check would always pass and carries no real meaning for PHP. This alone
  // does not fully seed PHP prod reachability — the realistic shape (a thin
  // bootstrap script that calls into a SEPARATELY-declared class) still
  // produces zero edges out of the entry file, since `buildPhpReferenceEdges`
  // never walks top-level script statements (T10's job, not this loop's).
  const phpProdEntryFiles = new Set(
    phpEntries.records.map((record) => record.file),
  );
  for (const node of graph.nodes) {
    if (phpProdEntryFiles.has(node.file)) prodEntries.add(node.id);
  }

  const toPosixRel = (abs: string) => relToRoot(abs).split("\\").join("/");
  const entryResolution = buildEntryResolution({
    prodEntryRecords,
    pluginProdEntryFiles,
    workspaceEntryFiles: workspaces.entryFiles,
    graphHasNodes: graph.nodes.length > 0,
    toPosixRel,
  });

  const sources = await readSources(files);
  const taintedFiles = new Set([
    ...findTaintedFiles(sources),
    ...starTaintedFiles,
    ...(await findPhpTaintedFiles(phpFiles)),
  ]);

  const edges = [...graph.edges, ...syntheticEdges];
  const reachability = computeReachability({
    nodes: graph.nodes,
    edges,
    prodEntries,
    testEntries,
    taintedFiles,
  });

  // Library quarantine (§2.3): a `pyproject.toml` with both `[project]` and
  // `[build-system]` is meant to be built/installed and consumed externally —
  // every exported Python symbol is public API, quarantined to `maybe` via
  // `classify()`'s existing (previously unwired) `publicApiIds` parameter.
  const pythonPublicApiIds = isPythonLibrary(ctx)
    ? new Set(pyGraph.nodes.filter((n) => n.exported).map((n) => n.id))
    : new Set<string>();

  // TS/JS mirror of the Python library quarantine above: a package.json with
  // a `name` that isn't `private` is meant to be published, so symbols
  // reachable from its resolved manifest/mapped entry surface (main/module/
  // bin/exports, barrel re-export chains included) are public API — external
  // consumers are invisible to static analysis, so quarantine to `maybe`
  // rather than certain-dead (phase 59).
  const manifestEntryFiles = prodEntryRecords
    .filter((r) => r.source === "manifest" || r.source === "mapped")
    .map((r) => r.file);
  const tsPublicApiIds =
    isTsLibrary(ctx) && manifestEntryFiles.length > 0
      ? resolvePublicApiIds(manifestEntryFiles, tsFiles)
      : new Set<string>();

  // PHP mirror of the two library quarantines above (phase 75 T5, AC-5): a
  // composer.json with a `name` field, whose `type` isn't the literal
  // string `"project"` (composer's own "this is an app skeleton" value),
  // and with no `public/index.php` web front-controller present, marks the
  // package a library — every symbol under its own declared PSR-4/PSR-0
  // namespace director(y/ies) is then public API. (`bin` deliberately plays
  // no part: real published libraries — e.g. `phpunit/phpunit` itself —
  // commonly ship a `bin/` script too, so its presence doesn't discriminate
  // "application" from "library" in practice; see `library.ts`'s doc
  // comment for the real-corpus check that ruled it out.) Unlike Python's
  // `.filter(n => n.exported)` mirror above, this can't filter on
  // `SymbolNode.exported` — `buildPhpSymbolGraph` sets it `true`
  // unconditionally for every PHP node (no visibility extraction in this
  // phase's scope), so that flag does no discriminating work here;
  // `resolvePhpPublicApiIds` instead scopes by each node's file path against
  // the manifest's own autoload directories. See `src/graph/php/library.ts`
  // for the full library-signal-selection rationale (candidates considered,
  // checked against a real `guzzlehttp/guzzle`/`phpunit/phpunit` corpus, and
  // why this one was chosen).
  const phpPublicApiIds = (await isPhpLibrary(targetPath, phpFiles))
    ? resolvePhpPublicApiIds(targetPath, phpNodes, composerManifest)
    : new Set<string>();

  const publicApiIds = new Set([
    ...pythonPublicApiIds,
    ...tsPublicApiIds,
    ...phpPublicApiIds,
  ]);

  return {
    files,
    graph,
    edges,
    prodEntries,
    testEntries,
    taintedFiles,
    reachability,
    sources,
    entryResolution,
    publicApiIds,
  };
}

/** A `pyproject.toml` declaring both `[project]` and `[build-system]` is a distributable library (§2.3) — its exported symbols are externally consumable. */
function isPythonLibrary(ctx: RepoContext): boolean {
  return ctx.pyprojectHas("project") && ctx.pyprojectHas("build-system");
}

/** A `package.json` with a `name` that isn't `private` is a distributable library (phase 59) — its exported symbols are externally consumable. */
function isTsLibrary(ctx: RepoContext): boolean {
  return ctx.packageJsonHas("name") && !ctx.packageJsonPrivate();
}

/**
 * Merge every entry-resolution mechanism into one deduped, human-readable
 * diagnostic (§2.1): `resolveProdEntries`'s manifest/mapped/convention/
 * scripts/config records, plus framework-plugin and workspace-member roots
 * (both file-path seeds added directly to `prodEntries` above, not through
 * `resolveProdEntries`). First mechanism to claim a file wins its source label.
 */
function buildEntryResolution(input: {
  prodEntryRecords: Array<{ file: string; source: EntrySource }>;
  pluginProdEntryFiles: Set<string>;
  workspaceEntryFiles: string[];
  graphHasNodes: boolean;
  toPosixRel: (abs: string) => string;
}): EntryResolution {
  const seen = new Set<string>();
  const out: EntryResolutionRecord[] = [];
  const add = (abs: string, source: EntrySource) => {
    const file = input.toPosixRel(abs);
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, source });
  };

  for (const r of input.prodEntryRecords) add(r.file, r.source);
  for (const file of input.pluginProdEntryFiles) add(file, "plugin");
  for (const file of input.workspaceEntryFiles) add(file, "workspace");

  return {
    prodEntryCount: out.length,
    sources: out,
    collapsed: out.length === 0 && input.graphHasNodes,
  };
}

async function readSources(
  files: string[],
): Promise<Array<{ file: string; text: string }>> {
  return Promise.all(
    files.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
  );
}
