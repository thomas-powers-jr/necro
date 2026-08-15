import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globMatcher } from "../glob.js";
import { mapDistToSrc, readTsconfigMapping } from "./entry-mapping.js";

const CONVENTIONAL = [
  "index.ts",
  "index.tsx",
  "src/index.ts",
  "src/index.tsx",
  "main.ts",
  "src/main.ts",
];

/** Where a resolved production entry came from (§2.1 diagnostics). */
export type EntrySource =
  | "manifest"
  | "mapped"
  | "convention"
  | "scripts"
  | "config"
  | "plugin"
  | "workspace"
  | "pyproject-scripts"
  | "setup-config"
  | "dunder-main"
  | "composer-bin";

export interface ProdEntryRecord {
  /** Absolute path. */
  file: string;
  source: EntrySource;
}

export interface ResolveProdEntriesOptions {
  /** Check the hardcoded conventional names (`index.ts`, etc). Default true —
   * set false only to prove another resolution path works independently of it. */
  conventions?: boolean;
  /** Globs (relative to root) from `NecroConfig.entries` — the config escape hatch (§2.2). */
  configEntries?: string[];
}

export interface ResolvedProdEntries {
  entries: Set<string>;
  records: ProdEntryRecord[];
}

/**
 * Resolve production entry files: package.json `main`/`module`/`bin`/`exports`
 * (existence-checked directly, then dist→src mapped via tsconfig or a
 * heuristic fallback — §2.3) plus conventional source entries. Each resolved
 * file is recorded once, tagged with the mechanism that found it (first
 * mechanism wins the source label — manifest/mapped over convention).
 * These are the roots for prod-color reachability (§5 step 1).
 */
export async function resolveProdEntries(
  root: string,
  files: string[],
  opts: ResolveProdEntriesOptions = {},
): Promise<ResolvedProdEntries> {
  const fileSet = new Set(files);
  const entries = new Set<string>();
  const records: ProdEntryRecord[] = [];

  const add = (rel: string, source: EntrySource): void => {
    const abs = join(root, rel);
    if (entries.has(abs)) return;
    entries.add(abs);
    records.push({ file: abs, source });
  };

  const pkg = readPackageJson(root);

  const tsMapping = await readTsconfigMapping(root);
  for (const rel of manifestEntries(pkg)) {
    const abs = join(root, rel);
    if (fileSet.has(abs)) {
      add(rel, "manifest");
      continue;
    }
    const mapped = mapDistToSrc(rel, tsMapping, root, fileSet);
    if (mapped) add(mapped, "mapped");
  }

  if (opts.conventions !== false) {
    for (const rel of CONVENTIONAL) {
      if (fileSet.has(join(root, rel))) add(rel, "convention");
    }
  }

  for (const rel of scriptEntries(pkg, root, fileSet)) add(rel, "scripts");

  for (const rel of configEntries(root, files, opts.configEntries ?? []))
    add(rel, "config");

  return { entries, records };
}

function readPackageJson(root: string): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function manifestEntries(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  collectStrings(pkg.main, out);
  collectStrings(pkg.module, out);
  collectStrings(pkg.bin, out);
  collectStrings(pkg.exports, out);
  return out.map((p) => p.replace(/^\.\//, ""));
}

/**
 * Mine `package.json` `scripts` values for file tokens that resolve to a
 * scanned file (§2.4). Tokenization is whitespace-split after stripping
 * quotes — no shell parsing; false negatives are acceptable, but the
 * existence gate below prevents false positives.
 */
function scriptEntries(
  pkg: Record<string, unknown>,
  root: string,
  fileSet: Set<string>,
): string[] {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return [];

  const out: string[] = [];
  for (const value of Object.values(scripts as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    for (const token of value.split(/\s+/)) {
      const stripped = stripQuotes(token);
      if (!/\.[cm]?[jt]sx?$/.test(stripped)) continue;
      const rel = stripped.replace(/^\.\//, "");
      if (fileSet.has(join(root, rel))) out.push(rel);
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/** Resolve `NecroConfig.entries` globs against the discovered files (§2.2). */
function configEntries(
  root: string,
  files: string[],
  globs: string[],
): string[] {
  if (globs.length === 0) return [];
  const matches = globMatcher(globs);
  return files
    .filter((f) => matches(relative(root, f).split("\\").join("/")))
    .map((f) => relative(root, f));
}

/** Recursively collect string leaves from a manifest field (string | array | object). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
}
