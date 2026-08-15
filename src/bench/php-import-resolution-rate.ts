import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../config.js";
import { discoverFiles } from "../discover.js";
import { buildComposerAutoloadMap } from "../graph/php/composer-autoload.js";
import { readComposerManifest } from "../graph/php/composer-manifest.js";
import type { PhpImport } from "../graph/php/import-parser.js";
import { parsePhpImports } from "../graph/php/import-parser.js";

/**
 * Repo-internal measurement tool (Phase 74-01 AC-4), not part of the
 * published `necro` CLI. Run manually against a local checkout of a real PHP
 * repo (guzzle, phpunit) to record the resolver's import-resolution rate —
 * the design doc's Phase B "Done" bar is >=95% on both corpus repos. Not
 * wired into CI: the checkouts aren't vendored into this repo (see DRAFT
 * boundaries), mirroring `python-import-resolution-rate.ts`'s own precedent
 * exactly (phase 44-00 AC-7).
 *
 * Measured only over *local* class-kind `use` imports — see
 * `isLocalClassImportCandidate`.
 */

const PHP_CONFIG = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

export interface ResolutionRateResult {
  total: number;
  resolved: number;
  rate: number;
}

export interface RateArgs {
  repo: string;
}

/** Parse `--repo <path>`. Pure — no I/O. */
export function parseArgs(argv: string[]): RateArgs {
  const args: Partial<RateArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") args.repo = argv[++i];
  }
  if (!args.repo) throw new Error("--repo <path> is required");
  return { repo: args.repo };
}

/**
 * Whether a `use` import should count toward the measurement: it must be a
 * class-kind import (function/const imports never resolve via
 * psr-4/psr-0/classmap by design, AC-2 — counting them would measure a
 * deliberate scope limit, not resolver accuracy); its FQCN must not itself
 * be *known to be a namespace* (see `knownNamespaces`) rather than a class —
 * `use GuzzleHttp\Psr7;` with no trailing segment is valid PHP that imports
 * the *namespace* as a local alias (later used as a qualified-name prefix,
 * e.g. `Psr7\Utils::method()`), not a class; composer's autoloader is never
 * invoked for a bare namespace import, so counting it as an unresolved
 * class is a measurement artifact, not a resolver failure; and its
 * *containing* namespace must be one this repo's own autoload map actually
 * populates with at least one real, discovered class — derived from the map
 * itself (mirroring Python's `topLevelPackagesOf`), not re-derived from the
 * manifest's `psr-4` key set, so a classmap-only repo with no `psr-4` key
 * still classifies its own classes as local.
 *
 * Both refinements were forced by measuring against guzzle (phase 74-01
 * AC-4), not assumed up front:
 *
 * 1. Deliberately not a bare first-segment check: guzzlehttp/guzzle's own
 *    `composer.json` declares only `"GuzzleHttp\\": "src/"`, but its
 *    real-world imports also reference `GuzzleHttp\Psr7\*` and
 *    `GuzzleHttp\Promise\*` — separate Composer packages (guzzlehttp/psr7,
 *    guzzlehttp/promises) that merely share the "GuzzleHttp" namespace root
 *    by publisher convention, installed under `vendor/` and invisible to
 *    this resolver (out of scope by design — it only ever reads *this*
 *    package's own manifest). A first-segment check misclassifies every one
 *    of those as a local resolution failure. Checking the *containing*
 *    namespace against namespaces genuinely populated by discovered files
 *    fixes this: `GuzzleHttp\Psr7` never appears as a containing namespace
 *    among guzzle's own discovered classes, so `GuzzleHttp\Psr7\Message` is
 *    correctly excluded, while `GuzzleHttp` itself (containing many real
 *    classes) still correctly flags a genuinely-missing
 *    `GuzzleHttp\Something` reference as a real failure.
 * 2. That first fix alone still left `use GuzzleHttp\Psr7;`-shaped bare
 *    namespace imports counted as failures, since their *containing*
 *    namespace (`GuzzleHttp`, one segment up) genuinely is populated. The
 *    `knownNamespaces` check catches these: a namespace reveals itself
 *    either by being a strict prefix of some *other* imported FQCN
 *    anywhere in the repo (`GuzzleHttp\Psr7` is proven a namespace by the
 *    120 `GuzzleHttp\Psr7\*` imports elsewhere, even though those are
 *    excluded from `total` themselves), or by being independently populated
 *    in this repo's own map (`GuzzleHttp\Handler` is proven a namespace by
 *    `src/Handler/*.php` existing, with no cross-import evidence needed).
 *
 * `isResolved` is checked *first* and short-circuits both namespace checks —
 * found running against phpunit (AC-4), whose own `resolved` count dropped
 * when this ordering was missing: `PHPUnit\Framework\TestCase` is
 * *simultaneously* a real class (`src/Framework/TestCase.php`) and, quite
 * legitimately, a namespace container for its own sibling helper classes
 * (`PHPUnit\Framework\TestCase\ExceptionExpectation` under
 * `src/Framework/TestCase/`) — valid PHP, not a bug in phpunit. Cross-import
 * evidence alone can't distinguish "this FQCN is only ever a namespace" from
 * "this FQCN is a real class that *also* happens to root some unrelated
 * helper classes' namespace", so a class that genuinely resolves must always
 * count as resolved, regardless of what else references it as a prefix.
 */
export function isLocalClassImportCandidate(
  fqcn: string,
  kind: string,
  isResolved: boolean,
  populatedNamespaces: ReadonlySet<string>,
  knownNamespaces: ReadonlySet<string>,
): boolean {
  if (kind !== "class") return false;
  if (isResolved) return true;
  if (knownNamespaces.has(fqcn)) return false;
  const segments = fqcn.split("\\");
  const containingNamespace = segments.slice(0, -1).join("\\");
  return populatedNamespaces.has(containingNamespace);
}

/** Every namespace prefix (at every depth) implied by `fqcns` — e.g. `App\Models\User` contributes both `App` and `App\Models`, not `App\Models\User` itself (a leaf, not a namespace). Shared by `populatedNamespaces` (derived from the built autoload map's own keys) and the cross-import namespace evidence in `knownNamespaces` (derived from every `use` import found repo-wide) — same computation, different input lists. */
function namespacePrefixesOf(fqcns: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const fqcn of fqcns) {
    const segments = fqcn.split("\\");
    for (let i = 1; i < segments.length; i++)
      out.add(segments.slice(0, i).join("\\"));
  }
  return out;
}

/** Walk every `.php` file under `repoPath`, parse every `use` import, and resolve each *local* class-kind candidate against the repo's own composer autoload map. Two passes: the first collects every class-kind import repo-wide (needed to detect namespace-alias-shaped imports via cross-import evidence, see `isLocalClassImportCandidate`); the second measures. */
export async function computeResolutionRate(
  repoPath: string,
): Promise<ResolutionRateResult> {
  const files = await discoverFiles(repoPath, PHP_CONFIG);
  const manifest = await readComposerManifest(repoPath);
  const autoloadMap = await buildComposerAutoloadMap(repoPath, files, manifest);
  const populatedNamespaces = namespacePrefixesOf(
    autoloadMap.classToFile.keys(),
  );

  const perFileImports: PhpImport[][] = [];
  const allImportedClassFqcns: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const { imports } = await parsePhpImports(file, source);
    perFileImports.push(imports);
    for (const imp of imports)
      if (imp.kind === "class") allImportedClassFqcns.push(imp.fqcn);
  }

  const knownNamespaces = new Set([
    ...populatedNamespaces,
    ...namespacePrefixesOf(allImportedClassFqcns),
  ]);

  let total = 0;
  let resolved = 0;
  for (const fileImports of perFileImports) {
    for (const imp of fileImports) {
      const isResolved = autoloadMap.classToFile.has(imp.fqcn);
      if (
        !isLocalClassImportCandidate(
          imp.fqcn,
          imp.kind,
          isResolved,
          populatedNamespaces,
          knownNamespaces,
        )
      )
        continue;
      total++;
      if (isResolved) resolved++;
    }
  }

  return { total, resolved, rate: total === 0 ? 0 : resolved / total };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { total, resolved, rate } = await computeResolutionRate(args.repo);
  console.log(
    `${args.repo}: ${resolved}/${total} use imports resolved (${(rate * 100).toFixed(1)}%)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
