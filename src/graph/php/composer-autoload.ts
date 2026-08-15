import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  ComposerManifest,
  ComposerPrefixMap,
} from "./composer-manifest.js";
import { extractDeclaredSymbols } from "./declared-symbols.js";

export interface ComposerAutoloadMap {
  /** FQCN -> absolute file path. */
  classToFile: Map<string, string>;
  /** Absolute paths of unconditionally-included (`files` autoload) scripts — not namespace-derived, composer runs these on every autoload. */
  filesAutoload: string[];
}

/**
 * Build a namespace/class -> file map from a composer manifest (T1) against
 * an already-discovered `.php` file set (T2's own filesystem scope is
 * limited to that set — `vendor/`'s exclusion from `discoverFiles`, phase
 * 72's T4, stays the single source of truth for what's in scope; classmap
 * scanning below filters this same set rather than walking the filesystem
 * independently).
 */
export async function buildComposerAutoloadMap(
  root: string,
  files: string[],
  manifest: ComposerManifest,
): Promise<ComposerAutoloadMap> {
  const classToFile = new Map<string, string>();

  addPrefixEntries(classToFile, root, files, manifest.autoload.psr4, "psr4");
  addPrefixEntries(classToFile, root, files, manifest.autoloadDev.psr4, "psr4");
  addPrefixEntries(classToFile, root, files, manifest.autoload.psr0, "psr0");
  addPrefixEntries(classToFile, root, files, manifest.autoloadDev.psr0, "psr0");

  await addClassmapEntries(
    classToFile,
    root,
    files,
    manifest.autoload.classmap,
  );
  await addClassmapEntries(
    classToFile,
    root,
    files,
    manifest.autoloadDev.classmap,
  );

  const filesAutoload = [
    ...manifest.autoload.files,
    ...manifest.autoloadDev.files,
  ].map((f) => resolve(join(root, f)));

  return { classToFile, filesAutoload };
}

type PrefixConvention = "psr4" | "psr0";

/** Path relative to `baseDir`, or `null` if `file` isn't under it (or is directory-equal, or ends up absolute — no traversal escape). */
function relativeUnder(baseDir: string, file: string): string | null {
  const rel = relative(baseDir, file);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return rel;
}

function stripPhpExt(rel: string): string {
  return rel.endsWith(".php") ? rel.slice(0, -".php".length) : rel;
}

/**
 * PSR-4: composer strips the matched prefix from the class name before
 * appending the remainder to the base dir, so the reverse direction
 * re-prepends the prefix to the path-derived remainder.
 */
function psr4Fqcn(prefix: string, rel: string): string | null {
  const segments = stripPhpExt(rel).split(sep);
  if (segments.some((s) => s === "")) return null;
  return prefix + segments.join("\\");
}

/**
 * PSR-0: unlike PSR-4, composer does NOT strip the prefix — the *whole*
 * class name (with `\` and, for the final segment, `_` both converted to
 * directory separators) is appended to the base dir, so reconstructing the
 * class name from `rel` never re-prepends `prefix`; it only decides *how* to
 * fold `rel`'s segments back together, keyed off the prefix's own style:
 * namespace-style (`Vendor\Sub\`) mirrors PSR-4 exactly (segments join with
 * `\`), while flat/legacy-style (`Zend_`, the pre-5.3 convention PSR-0 was
 * designed for) folds every nested directory segment into one
 * underscore-joined class name, matching composer's actual reverse-lookup
 * behavior for that style. Real-world PSR-0 declarations are one style or
 * the other per prefix, not mixed, so this is unambiguous for both canonical
 * cases. Not handled (accepted limitation, not exercised by this phase's
 * corpus): a namespace-style class whose *own* final segment legitimately
 * contains a literal underscore composer would have converted — this is
 * genuinely ambiguous from the file path alone with no further signal.
 */
function psr0Fqcn(prefix: string, rel: string): string | null {
  const segments = stripPhpExt(rel).split(sep);
  if (segments.some((s) => s === "")) return null;
  return prefix.endsWith("\\") ? segments.join("\\") : segments.join("_");
}

/** Longest-prefix-first, mirroring composer's own longest-match resolution and `module-resolver.ts`'s `roots.sort((a,b) => b.length - a.length)` precedent — a shorter, overlapping prefix must never clobber a more specific one's entry. */
function addPrefixEntries(
  out: Map<string, string>,
  root: string,
  files: string[],
  prefixMap: ComposerPrefixMap,
  convention: PrefixConvention,
): void {
  const prefixes = Object.keys(prefixMap).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    for (const dir of prefixMap[prefix] ?? []) {
      const baseDir = resolve(join(root, dir));
      for (const file of files) {
        if (!file.endsWith(".php")) continue;
        const rel = relativeUnder(baseDir, file);
        if (rel === null) continue;
        const fqcn =
          convention === "psr4" ? psr4Fqcn(prefix, rel) : psr0Fqcn(prefix, rel);
        if (fqcn && !out.has(fqcn)) out.set(fqcn, file);
      }
    }
  }
}

/** Classmap entries aren't namespace-derived — scan candidate files (filtered from the already-discovered set, a directory entry or an exact file match) and read each one's real declared FQCN via T3. */
async function addClassmapEntries(
  out: Map<string, string>,
  root: string,
  files: string[],
  classmapPaths: string[],
): Promise<void> {
  const candidates = new Set<string>();
  for (const p of classmapPaths) {
    const abs = resolve(join(root, p));
    for (const file of files) {
      if (!file.endsWith(".php")) continue;
      if (file === abs || relativeUnder(abs, file) !== null)
        candidates.add(file);
    }
  }

  for (const file of candidates) {
    const source = await readFile(file, "utf8");
    const symbols = await extractDeclaredSymbols(file, source);
    for (const sym of symbols) {
      if (!out.has(sym.fqcn)) out.set(sym.fqcn, sym.file);
    }
  }
}
