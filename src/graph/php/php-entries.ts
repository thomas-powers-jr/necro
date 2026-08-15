import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { EntrySource } from "../../engine/prod-entries.js";
import type { ComposerManifest } from "./composer-manifest.js";

/** `*Test.php` — PHPUnit's filename convention, used only when no `phpunit.xml`/`phpunit.xml.dist` is found (§2.3). */
const PHP_TEST_SUFFIX = /Test\.php$/;

export interface PhpEntryRecord {
  file: string;
  source: EntrySource;
}

export interface ResolvedPhpEntries {
  entries: Set<string>;
  records: PhpEntryRecord[];
  /** PHPUnit-resolved test files: entries, but for test reachability, not prod. */
  testEntries: Set<string>;
}

/**
 * Resolve PHP production and test entry roots: composer.json's `bin` field
 * (string or array-of-strings), `public/index.php` by filename convention,
 * and PHPUnit test paths (`phpunit.xml`/`phpunit.xml.dist`'s configured
 * `<testsuite>` `<directory>`/`<file>` entries, falling back to a
 * `*Test.php` filename convention only when neither config file exists —
 * §2.3). Mirrors `resolvePythonEntries`'s `{ entries, records, testEntries }`
 * shape (`../../engine/python-entries.ts`) so the two merge the same way in
 * `buildReachabilityModel`. Unlike Python's `pkg.mod:func` specs, none of
 * PHP's mechanisms name a specific function target — every record is a bare
 * file-path root, so (unlike `PythonEntryRecord`) there's no `symbolId`
 * field here.
 */
export async function resolvePhpEntries(
  root: string,
  files: string[],
  manifest: ComposerManifest,
): Promise<ResolvedPhpEntries> {
  const fileSet = new Set(files);
  const entries = new Set<string>();
  const testEntries = new Set<string>();
  const records: PhpEntryRecord[] = [];

  const add = (file: string, source: EntrySource): void => {
    if (!entries.has(file)) {
      entries.add(file);
      records.push({ file, source });
    }
  };

  // composer.json's `bin` field: direct, declarative script paths (§2.3) —
  // no dual-path mess like Python's pyproject/setup.cfg/setup.py split.
  // Tagged `composer-bin`, deliberately distinct from JS/TS's `manifest`
  // label (`package.json`'s own `bin` field): `model.ts`'s TS-library
  // quarantine seam filters `prodEntryRecords` on `source === "manifest"`
  // to build `resolvePublicApiIds`'s ts-morph entry surface, and a PHP bin
  // path landing in that filter would spuriously flip a mixed PHP+frontend
  // repo's TS-library guard on for no reason.
  for (const bin of manifest.bin) {
    const abs = join(root, bin);
    if (fileSet.has(abs)) add(abs, "composer-bin");
  }

  // `public/index.php` — the universal PHP web-entry convention, mirroring
  // Python's `wsgi.py`/`asgi.py`/`manage.py` conventional-filename layer
  // (reuses the same `convention` source label for the same reason: a
  // filename-based root, not a manifest field).
  const indexPhp = join(root, "public", "index.php");
  if (fileSet.has(indexPhp)) add(indexPhp, "convention");

  // PHPUnit test entries: a `phpunit.xml`/`phpunit.xml.dist` config's
  // `<testsuite>` paths when one exists (config file found wins outright,
  // even if it resolves to zero paths — no silent fallback underneath a
  // present-but-sparse config), else the `*Test.php` filename convention.
  const configured = await readPhpUnitTestPaths(root, fileSet);
  if (configured) {
    for (const file of configured) testEntries.add(file);
  } else {
    for (const file of files) {
      if (PHP_TEST_SUFFIX.test(file)) testEntries.add(file);
    }
  }

  return { entries, records, testEntries };
}

/**
 * Read `phpunit.xml` (falling back to `phpunit.xml.dist`, real PHPUnit
 * precedence — first found wins, they're never merged) and extract its
 * `<testsuite>` blocks' `<directory>`/`<file>` paths, expanded against the
 * already-discovered `fileSet` rather than a fresh filesystem walk (mirrors
 * `composer-autoload.ts`'s classmap-scanning convention). Returns `null`
 * only when neither config file exists — the signal `resolvePhpEntries`
 * uses to fall back to the `*Test.php` convention. A found-but-unparseable
 * or found-but-empty config returns an empty `Set`, not `null`: best-effort,
 * matching `composer-manifest.ts`'s "never throw" convention, but a present
 * config file still suppresses the filename-convention fallback per AC-4.
 */
async function readPhpUnitTestPaths(
  root: string,
  fileSet: Set<string>,
): Promise<Set<string> | null> {
  const xml = await readPhpUnitConfig(root);
  if (xml === null) return null;

  const suiteXml = extractTestSuiteBlocks(xml);
  const out = new Set<string>();

  for (const dir of extractElementTexts(suiteXml, "directory")) {
    const baseDir = resolve(join(root, dir));
    for (const file of fileSet) {
      if (file.endsWith(".php") && isUnderDir(baseDir, file)) out.add(file);
    }
  }

  for (const rel of extractElementTexts(suiteXml, "file")) {
    const abs = resolve(join(root, rel));
    if (fileSet.has(abs)) out.add(abs);
  }

  return out;
}

/** `phpunit.xml`'s raw text, or `phpunit.xml.dist`'s if the former doesn't exist, or `null` if neither does. */
async function readPhpUnitConfig(root: string): Promise<string | null> {
  for (const name of ["phpunit.xml", "phpunit.xml.dist"]) {
    try {
      return await readFile(join(root, name), "utf8");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Every `<testsuite>...</testsuite>` block's raw text, concatenated —
 * scoping `<directory>`/`<file>` extraction to just this region matters:
 * `phpunit.xml` also uses `<directory>` inside `<coverage><include>` for
 * code-coverage *source* dirs, a completely different semantic that must
 * never be read as a test root.
 */
function extractTestSuiteBlocks(xml: string): string {
  const blocks = xml.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g) ?? [];
  return blocks.join("\n");
}

/** Every `<tag>...</tag>` element's trimmed inner text within `xml` (no attribute parsing — narrow, hand-rolled, matches this project's "no new dependency for a narrow parsing need" convention). */
function extractElementTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "g");
  const out: string[] = [];
  let match: RegExpExecArray | null = re.exec(xml);
  while (match !== null) {
    const text = (match[1] ?? "").trim();
    if (text) out.push(text);
    match = re.exec(xml);
  }
  return out;
}

/** Whether absolute `file` is `baseDir` itself or nested under it. */
function isUnderDir(baseDir: string, file: string): boolean {
  return file === baseDir || file.startsWith(baseDir + sep);
}
