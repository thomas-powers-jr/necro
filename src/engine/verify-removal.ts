import { relative } from "node:path";
import type { ClassifiedFinding } from "../analyze/classify.js";
import type { NecroConfig } from "../config.js";
import { planRemovalOf } from "../fix/remove.js";
import { isPhpFile } from "../graph/php/language.js";
import { isPythonFile } from "../graph/python/language.js";
import { DEFAULT_CHECKS } from "../refactor/index.js";
import {
  type FileEdit,
  gitWorktreeRunner,
  type VerifyRunner,
  verifyEdits,
} from "../refactor/verify.js";
import { resolveQuery } from "./explain.js";
import { buildReachabilityModel } from "./model.js";

/** The verdict of verifying one symbol's removal. */
export interface RemovalVerdict {
  /** The original query string, echoed back. */
  symbol: string;
  /**
   * `green` — deleting it kept the build green. `red` — a check failed.
   * `unresolved` — the query matched zero or multiple symbols, or no removable
   * declaration was found (nothing was verified).
   */
  status: "green" | "red" | "unresolved";
  /** The failing check output for `red`; a short reason for `unresolved`. */
  output?: string;
  /** The resolved symbol id, when the query matched exactly one. */
  resolvedId?: string;
}

export interface VerifyRemovalOptions {
  /** Build the worktree runner for a repo root (injected for tests). */
  runnerFactory?: (repoRoot: string) => VerifyRunner;
  /** Checks run in each throwaway worktree (default: typecheck + tests). */
  checks?: string[];
  /**
   * Repo root the worktrees branch off (file edits are relativized to it).
   * Defaults to `targetPath` — pass the git toplevel when the target is a subdir.
   */
  repoRoot?: string;
  /** Called before each symbol is verified (1-based `index`), e.g. for CLI
   * stderr progress. Omit for today's silent behavior — opt-in, not ambient. */
  onProgress?: (symbol: string, index: number, total: number) => void;
}

/**
 * For each symbol query, plan its removal with the ts-morph removal engine and
 * verify it **independently** in its own throwaway git worktree: does deleting
 * symbol X keep the build green? Resolution and planning run once over a shared
 * reachability model; verification gets a fresh worktree per symbol so one
 * red verdict never taints another. The user's working tree is never touched.
 */
export async function verifyRemovals(
  targetPath: string,
  config: NecroConfig,
  symbols: string[],
  opts: VerifyRemovalOptions = {},
): Promise<RemovalVerdict[]> {
  const runnerFactory = opts.runnerFactory ?? gitWorktreeRunner;
  const checks = opts.checks ?? DEFAULT_CHECKS;
  const repoRoot = opts.repoRoot ?? targetPath;

  const model = await buildReachabilityModel(targetPath, config);

  const verdicts: RemovalVerdict[] = [];
  for (const [i, symbol] of symbols.entries()) {
    opts.onProgress?.(symbol, i + 1, symbols.length);
    const matches = resolveQuery(model.graph.nodes, symbol);
    if (matches.length !== 1) {
      verdicts.push({
        symbol,
        status: "unresolved",
        output: matches.length === 0 ? "no matching symbol" : "ambiguous query",
      });
      continue;
    }

    const node = matches[0] as (typeof matches)[number];
    if (isPythonFile(node.file)) {
      verdicts.push({
        symbol,
        status: "unresolved",
        output:
          "Python removal is not supported yet — necro's Python support is report/explain/triage only",
        resolvedId: node.id,
      });
      continue;
    }
    if (isPhpFile(node.file)) {
      verdicts.push({
        symbol,
        status: "unresolved",
        output:
          "PHP removal is not supported yet — necro's PHP support is report/explain/triage only",
        resolvedId: node.id,
      });
      continue;
    }

    const edits = planRemovalOf([
      { file: node.file, name: node.name, line: node.line },
    ]);
    if (edits.length === 0) {
      verdicts.push({
        symbol,
        status: "unresolved",
        output: "no removable declaration",
        resolvedId: node.id,
      });
      continue;
    }

    const fileEdits: FileEdit[] = edits.map((e) => ({
      file: relative(repoRoot, e.file),
      content: e.after,
    }));
    const badge = await verifyEdits(fileEdits, checks, runnerFactory(repoRoot));
    verdicts.push(
      badge.status === "green"
        ? { symbol, status: "green", resolvedId: node.id }
        : { symbol, status: "red", output: badge.output, resolvedId: node.id },
    );
  }
  return verdicts;
}

/**
 * {@link verifyRemovals} for `ClassifiedFinding`s instead of raw symbol
 * strings — queries each finding by its own node id (`file:line:name`), which
 * always resolves to exactly that declaration. Lets `fix --verify` (phase 29)
 * gate a removal on the same empirical build-green check `verify-removal`
 * already performs, without hand-building query strings.
 */
export async function verifyFindings(
  targetPath: string,
  config: NecroConfig,
  findings: ClassifiedFinding[],
  opts: VerifyRemovalOptions = {},
): Promise<RemovalVerdict[]> {
  return verifyRemovals(
    targetPath,
    config,
    findings.map((f) => f.node.id),
    opts,
  );
}
