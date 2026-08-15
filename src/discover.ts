import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { NecroConfig } from "./config.js";
import { globMatcher } from "./glob.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".eggs",
]);

/**
 * `build` is only a build-output dir in JS/TS projects — in Python it's a
 * legitimate subpackage name (e.g. pip's `pip/_internal/operations/build/`).
 * Deciding this per-`config` (as opposed to per-directory) doesn't compose:
 * `DEFAULT_CONFIG.include` now targets both JS/TS and Python at once, so a
 * single repo can have real `build/` bundler output *and* a real `build/`
 * Python subpackage in different places. Decide per-directory instead: a
 * `build/` dir that directly contains `__init__.py` is a Python package
 * (don't skip); otherwise treat it as a conventional build-output dir (skip).
 */
async function isPythonPackageDir(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, "__init__.py"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk `target` and return absolute paths of source files matching
 * `config.include` and not `config.ignore`. Declaration files (`*.d.ts`,
 * `*.d.mts`, `*.d.cts`, `*.pyi`) are skipped.
 */
export async function discoverFiles(
  target: string,
  config: NecroConfig,
): Promise<string[]> {
  const include = globMatcher(config.include);
  const ignore = globMatcher(config.ignore);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name === "build" && !(await isPythonPackageDir(abs)))
          continue;
        const rel = relative(target, abs);
        if (ignore(rel)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.d\.(ts|mts|cts)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".pyi")) continue;
      const rel = relative(target, abs);
      if (include(rel) && !ignore(rel)) out.push(abs);
    }
  }

  await walk(target);
  return out;
}
