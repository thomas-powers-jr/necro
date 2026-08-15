import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { SymbolNode } from "../types.js";
import type {
  ComposerManifest,
  ComposerPrefixMap,
} from "./composer-manifest.js";

/**
 * Library-signal rationale (AC-5, 75-01 T5).
 *
 * The risk asymmetry that drives this choice: `publicApiIds` membership
 * quarantines a symbol to tier `maybe` (`classify.ts`'s `deadTier`) — it is
 * NOT suppressed, still reported, just not auto-fix-eligible and not
 * `certain`/`likely`. So a false "yes" (an application repo misdetected as
 * a library) merely demotes real dead-code findings to a lower-confidence
 * tier — a mild failure, findings still surface. A false "no" (a real
 * library not detected as one) is far worse: the library's own exported
 * API, unreferenced *within* the package because its consumers are
 * external and invisible to static analysis, gets reported as ordinary
 * dead code — i.e. the tool tells a library author to delete their public
 * API. Recall on library detection matters more than precision here; this
 * shaped every choice below.
 *
 * Candidates considered, evaluated against a real corpus (`guzzlehttp/
 * guzzle`, `phpunit/phpunit`, and phpunit's own dependency tree —
 * `composer.json` files already present on this machine from a prior PHP
 * benchmark session; no network access was available or used):
 *
 *  - Composer's own explicit `"type": "library"` field, required: rejected.
 *    `guzzlehttp/guzzle`'s real `composer.json` has NO `type` field at all
 *    (it inherits composer's own default, which the schema documents as
 *    `library`) — requiring the literal string would misclassify one of
 *    PHP's most widely-depended-on libraries as "not a library", exactly
 *    the dangerous false-negative direction above. Rejected outright once
 *    checked against real data, not just reasoned about in the abstract.
 *
 *  - Absence of app-shape via `bin` being empty: rejected after checking
 *    real data. `phpunit/phpunit`'s real `composer.json` has BOTH
 *    `"type": "library"` AND a non-empty `bin` (`bin/phpunit`) — it is
 *    unambiguously a published, `composer require`-able library that also
 *    happens to ship a CLI entry point. Several of its own dependencies in
 *    the same corpus follow the identical shape (dev-tooling libraries like
 *    phpstan/php-cs-fixer/composer-normalize all conventionally ship a
 *    `bin/` script alongside their library code). Treating `bin`
 *    non-emptiness as a negative library signal would have misclassified
 *    this project's own future Phase D benchmark subject (`phpunit/
 *    phpunit`) as non-library. Dropped entirely — `bin` presence doesn't
 *    discriminate "application" from "library" in practice.
 *
 *  - Vetoing on any non-`"library"` explicit `type` value: also rejected
 *    after checking real data. Composer's `type` field is open-ended in
 *    practice — real published libraries in this same dependency tree use
 *    ecosystem-specific custom values (`phpstan-extension`,
 *    `composer-plugin`) that are not the literal string `"library"` but are
 *    still unambiguously reusable, externally-depended-on packages, not
 *    applications. Vetoing on "anything other than the literal string
 *    `library`" would misclassify all of these. The one `type` value
 *    composer's own docs single out as the actual opposite of a library is
 *    `"project"` (an application skeleton, e.g. what `composer
 *    create-project` scaffolds) — that specific value is kept as a veto;
 *    every other value (including absent) is treated as at-least-neutral.
 *
 *  - A bare top-level `name` field: kept, but not alone (per the packet's
 *    own caution — `name` is required for a Packagist-published package,
 *    but is also commonly present on plain application repos, e.g. for
 *    `composer show`/tooling identification). Combined with the
 *    `public/index.php`-absence check below, it's the recall-favoring
 *    signal this project's corrected asymmetry calls for: nearly every real
 *    library declares `name` (Packagist requires it to publish), and the
 *    conjunctive app-shape check below is what filters out plain
 *    applications that also happen to declare one.
 *
 *  - `public/index.php` presence as a negative signal: kept. Unlike `bin`,
 *    this withstood the real-corpus check — neither `guzzle` nor `phpunit`
 *    ship a `public/` directory (a reusable package has no reason to ship
 *    its own web front-controller; that convention belongs to the
 *    *consuming* deployed application, not a distributed library). This
 *    remains the one app-shape signal actually worth vetoing on.
 *
 * Chosen v1 signal: `name` present AND `type` is not literally `"project"`
 * AND no `public/index.php` — a conjunction of a positive identity signal,
 * an explicit-application veto, and a real app-shape veto, tuned toward
 * recall on true libraries per the asymmetry above. Mirrors this project's
 * existing conjunctive precedent for library detection (`isPythonLibrary`
 * in `model.ts` requires BOTH `[project]` and `[build-system]`), adapted
 * for PHP's different, more open-ended manifest shape and re-derived from
 * real data rather than assumed by analogy.
 *
 * `composer.json`'s `type`/`name` fields are read directly here (a second,
 * narrow read of the file) rather than added to `ComposerManifest`
 * (`composer-manifest.ts`): that module's parsed shape is scoped to what
 * the autoload/entry-point pipelines actually consume (psr-4/psr-0/
 * classmap/files/bin), and `type`/`name` have no relevance there — they're
 * library-detection-only signals, so they stay local to this module.
 * `ComposerManifest`'s `bin` field ended up not needed by the chosen signal
 * (see above) — `isPhpLibrary` below takes no `ComposerManifest` parameter
 * at all as a result. `resolvePhpPublicApiIds` further down still takes one,
 * for its `psr-4`/`psr-0` autoload block.
 */
export async function isPhpLibrary(
  root: string,
  files: string[],
): Promise<boolean> {
  const meta = await readComposerMeta(root);
  if (meta === null) return false;
  if (meta.name === null) return false;
  if (meta.type === "project") return false;
  if (hasPublicIndexPhp(root, files)) return false;
  return true;
}

interface ComposerMeta {
  type: string | null;
  name: string | null;
}

/** Best-effort read of composer.json's top-level `type`/`name` fields only — mirrors `composer-manifest.ts`'s never-throw convention (missing file or malformed JSON returns `null`; either field being absent/non-string resolves to `null` for that field alone). */
async function readComposerMeta(root: string): Promise<ComposerMeta | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, "composer.json"), "utf8");
  } catch {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  return {
    type: typeof obj.type === "string" ? obj.type : null,
    name: typeof obj.name === "string" ? obj.name : null,
  };
}

/** `public/index.php`'s presence in the already-discovered file set — the same app-shape convention `resolvePhpEntries` roots as a prod entry (`php-entries.ts`), reused here as a negative library signal (withstood the real-corpus check above, unlike `bin`). */
function hasPublicIndexPhp(root: string, files: string[]): boolean {
  const indexPhp = join(root, "public", "index.php");
  return files.includes(indexPhp);
}

/**
 * Scope a library's public-API quarantine to symbols declared under the
 * package's OWN declared PSR-4/PSR-0 namespace directories (§AC-5).
 *
 * Unlike Python's mirror (`pyGraph.nodes.filter((n) => n.exported)` in
 * `model.ts`), this cannot filter on `SymbolNode.exported`: PHP's
 * `buildPhpSymbolGraph` sets `exported: true` unconditionally on every node
 * (documented in `symbol-graph.ts` as a conservative default — no
 * visibility extraction is in this phase's scope), so that flag does no
 * discriminating work for PHP. Filtering on it verbatim would quarantine
 * every PHP symbol in the entire scanned target the moment `isPhpLibrary`
 * returns true, including symbols with nothing to do with the library's own
 * namespace. Instead, this filters by whether a node's *file* falls under
 * one of the package's own `composer.json` `autoload.psr4`/`autoload.psr0`
 * prefix directories — directly available on the already-parsed
 * `ComposerManifest` (T1's `readComposerManifest`).
 *
 * Deliberately scoped to the production `autoload` block only, not
 * `autoloadDev`: `autoload-dev` declares test-suite namespaces (e.g.
 * `Tests\` -> `tests/`), which are never the library's *published* public
 * surface — quarantining test-suite symbols as "public API" would be a
 * category error, not a conservative default.
 *
 * `classmap`/`files` autoload entries are intentionally excluded from this
 * scoping too: they are file-path-driven, not namespace-driven, so "the
 * package's own declared PSR-4 namespace(s)" (AC-5's literal wording)
 * doesn't apply to them.
 *
 * A prefix mapped to the package root itself (e.g. `{"App\\": ""}` or
 * `{"App\\": "."}`, valid but unusual composer.json shapes) is explicitly
 * excluded from `ownNamespaceDirs`: without the guard, its resolved
 * directory equals `root`, and every file in the scanned target would test
 * as "under" it — silently reproducing the exact "quarantine everything"
 * hazard this function exists to avoid (the same failure mode as naively
 * copying Python's `.filter(n => n.exported)` pattern, just reached through
 * a different, narrower door). Note this guard deliberately accepts the
 * opposite, milder failure in the one real (if unusual) case a package
 * legitimately roots its namespace at the repo root: that package's symbols
 * get zero quarantine instead of correct quarantine — a false "no" on
 * *this specific sub-mechanism*, the direction this file's top rationale
 * otherwise argues is the dangerous one. It's still the right v1 trade:
 * "misses quarantining one unusually-shaped package" is a far smaller
 * blast radius than "quarantines every file in every scanned PHP repo that
 * happens to use this shape," which is what dropping the guard would risk.
 */
export function resolvePhpPublicApiIds(
  root: string,
  nodes: SymbolNode[],
  manifest: ComposerManifest,
): Set<string> {
  const ownDirs = [
    ...ownNamespaceDirs(root, manifest.autoload.psr4),
    ...ownNamespaceDirs(root, manifest.autoload.psr0),
  ];
  if (ownDirs.length === 0) return new Set<string>();

  const ids = new Set<string>();
  for (const node of nodes) {
    if (ownDirs.some((dir) => isUnderDir(dir, node.file))) ids.add(node.id);
  }
  return ids;
}

function ownNamespaceDirs(
  root: string,
  prefixMap: ComposerPrefixMap,
): string[] {
  const rootResolved = resolve(root);
  const dirs: string[] = [];
  for (const dirList of Object.values(prefixMap)) {
    for (const dir of dirList) {
      const resolved = resolve(join(root, dir));
      if (resolved === rootResolved) continue; // root-mapped prefix guard, see doc comment
      dirs.push(resolved);
    }
  }
  return dirs;
}

/** Whether absolute `file` is `baseDir` itself or nested under it — matches `php-entries.ts`'s own `isUnderDir` helper exactly. */
function isUnderDir(baseDir: string, file: string): boolean {
  const rel = relative(baseDir, file);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
