import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { LlmOptions } from "../config.js";
import { isPhpFile } from "../graph/php/language.js";
import { isPythonFile } from "../graph/python/language.js";
import type {
  ComplexityFinding,
  DuplicationFinding,
} from "../syntactic/types.js";
import type { RefactorClient } from "./client.js";
import { contextForFinding, dupContextForFinding } from "./context.js";
import {
  buildDuplicatePrompt,
  buildRefactorPrompt,
  type DuplicateProposal,
  type RefactorProposal,
} from "./prompt.js";
import {
  computeUnifiedDiff,
  type DuplicateSpliceResult,
  spliceDuplicate,
  spliceLines,
} from "./splice.js";
import {
  type VerifyBadge,
  type VerifyRunner,
  verifyEdits,
  verifyProposal,
} from "./verify.js";

/** The default checks run against a proposal in the scratch worktree. */
export const DEFAULT_CHECKS = ["npm run typecheck", "npx vitest run"];

/** `DEFAULT_CHECKS` are npm-based and don't apply to Python — verifying a
 * Python edit against them is guaranteed to fail for reasons unrelated to the
 * proposal. Skipped (not run) whenever the caller left `checks` unset; an
 * explicit `--checks` override is trusted as-is, even against Python. */
const PYTHON_DEFAULT_CHECKS_SKIP_REASON =
  "default checks are npm-based (typecheck+tests) and don't apply to Python — pass --checks explicitly (e.g. pytest) to verify";

/** Same rationale as {@link PYTHON_DEFAULT_CHECKS_SKIP_REASON}, for PHP (T7,
 * phase 75) — kept as its own constant/message so the Python skip reason
 * never gets diluted into a generic "not TS" string. */
const PHP_DEFAULT_CHECKS_SKIP_REASON =
  "default checks are npm-based (typecheck+tests) and don't apply to PHP — pass --checks explicitly (e.g. phpunit) to verify";

/**
 * The default-checks skip reason for a set of touched files, or `undefined`
 * when none of them are Python/PHP (checks should run normally). `isMatch`
 * lets both call sites — one file (`runRefactor`) and several locations
 * (`runExtractDuplicate`) — share this without either duplicating the
 * Python-then-PHP precedence or flattening into a deeper nested ternary.
 */
function defaultChecksSkipReason(
  isMatch: (predicate: (file: string) => boolean) => boolean,
): string | undefined {
  if (isMatch(isPythonFile)) return PYTHON_DEFAULT_CHECKS_SKIP_REASON;
  if (isMatch(isPhpFile)) return PHP_DEFAULT_CHECKS_SKIP_REASON;
  return undefined;
}

/** One god-function finding and the model's suggested split. The original
 * `finding` is carried unchanged — refactor never mutates it. */
export interface RefactorOutcome {
  finding: ComplexityFinding;
  model: string;
  /** The suggested split (incl. `replacement` code), or `null` when unparseable. */
  proposal: RefactorProposal | null;
  /** A necro-computed unified diff for display (always applies); `null` on failure. */
  diff: string | null;
  /** Verification badge; `null` when there was no proposal (or no runner). */
  badge: VerifyBadge | null;
  /** Set when `proposal` is null — why parsing failed. */
  failure?: string;
}

export interface RefactorRunResult {
  outcomes: RefactorOutcome[];
  /** How many god-function findings the scan produced. */
  consideredGodFunctions: number;
}

export interface RefactorRunOptions {
  /** Max god-function findings to propose splits for in one run (default 1). */
  limit?: number;
  /** Checks run in the scratch worktree (default: typecheck + tests). */
  checks?: string[];
  /** Injected verify runner; when omitted, verification is skipped (`badge: null`). */
  verifyRunner?: VerifyRunner;
  /** Repo root, for the worktree-relative edit path (default: cwd). */
  repoRoot?: string;
}

/**
 * Propose god-function splits — **suggest-only**. Selects only `god-function`
 * findings (up to `limit`), asks the injected client for the rewritten function
 * code, splices it into the file to get full new content, computes a clean diff
 * for display, and (with a verify runner) verifies the new content in a throwaway
 * worktree. Nothing here mutates a finding, writes a source file, or changes any
 * tier — the result is advice.
 */
export async function runRefactor(
  complexity: ComplexityFinding[],
  llm: LlmOptions,
  client: RefactorClient,
  opts: RefactorRunOptions = {},
): Promise<RefactorRunResult> {
  const godFunctions = complexity.filter((f) => f.detector === "god-function");
  const limit = opts.limit ?? 1;
  const selected = godFunctions.slice(0, Math.max(limit, 0));

  if (selected.length === 0) {
    return { outcomes: [], consideredGodFunctions: godFunctions.length };
  }

  const checks = opts.checks ?? DEFAULT_CHECKS;
  const usingDefaultChecks = opts.checks === undefined;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const outcomes: RefactorOutcome[] = [];
  for (const finding of selected) {
    const context = await contextForFinding(finding, llm.snippetRadius);
    const result = await client.propose(buildRefactorPrompt(context));
    if (!result.ok) {
      outcomes.push({
        finding,
        model: llm.model,
        proposal: null,
        diff: null,
        badge: null,
        failure: result.reason,
      });
      continue;
    }

    const original = await readFile(finding.file, "utf8");
    const newContent = spliceLines(
      original,
      finding.line,
      context.snippet.endLine,
      result.proposal.replacement,
    );
    const diff = await computeUnifiedDiff(original, newContent);

    const skipReason = usingDefaultChecks
      ? defaultChecksSkipReason((pred) => pred(finding.file))
      : undefined;
    const badge = !opts.verifyRunner
      ? null
      : skipReason
        ? { status: "skipped" as const, reason: skipReason }
        : await verifyProposal(
            { file: relative(repoRoot, finding.file), content: newContent },
            checks,
            opts.verifyRunner,
          );

    outcomes.push({
      finding,
      model: llm.model,
      proposal: result.proposal,
      diff,
      badge,
    });
  }

  return { outcomes, consideredGodFunctions: godFunctions.length };
}

// ── extract-duplicate ───────────────────────────────────────────────────────

/** One clone group and the model's suggested extraction. The original `finding`
 * is carried unchanged — refactor never mutates it. */
export interface ExtractDuplicateOutcome {
  finding: DuplicationFinding;
  model: string;
  /** The suggested extraction, or `null` when unparseable / un-spliceable. */
  proposal: DuplicateProposal | null;
  /** Per-file new content + necro-computed diff; `null` on failure. */
  files: DuplicateSpliceResult[] | null;
  /** Verification badge; `null` when there was no proposal (or no runner). */
  badge: VerifyBadge | null;
  /** Set when `proposal`/`files` is null — why it failed. */
  failure?: string;
}

export interface ExtractDuplicateRunResult {
  outcomes: ExtractDuplicateOutcome[];
  /** How many clone groups the scan produced. */
  consideredCloneGroups: number;
}

export interface ExtractDuplicateRunOptions {
  /** Max clone groups to propose extractions for in one run (default 1). */
  limit?: number;
  /** Checks run in the scratch worktree (default: typecheck + tests). */
  checks?: string[];
  /** Injected verify runner; when omitted, verification is skipped (`badge: null`). */
  verifyRunner?: VerifyRunner;
  /** Repo root, for the worktree-relative edit paths (default: cwd). */
  repoRoot?: string;
}

/**
 * Propose extract-duplicate refactors — **suggest-only**. Selects clone groups
 * (up to `limit`), asks the injected client for a shared function + per-site call
 * code, splices it across the affected files to get full new content, computes a
 * clean diff per file, and (with a verify runner) verifies the combined edit set
 * in a throwaway worktree. Nothing here mutates a finding, writes a source file,
 * or changes any tier — the result is advice. A bad response or an
 * un-spliceable proposal is recorded as a failed outcome, never thrown.
 */
export async function runExtractDuplicate(
  duplication: DuplicationFinding[],
  llm: LlmOptions,
  client: RefactorClient,
  opts: ExtractDuplicateRunOptions = {},
): Promise<ExtractDuplicateRunResult> {
  const limit = opts.limit ?? 1;
  const selected = duplication.slice(0, Math.max(limit, 0));
  if (selected.length === 0) {
    return { outcomes: [], consideredCloneGroups: duplication.length };
  }

  const checks = opts.checks ?? DEFAULT_CHECKS;
  const usingDefaultChecks = opts.checks === undefined;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const outcomes: ExtractDuplicateOutcome[] = [];

  for (const finding of selected) {
    const context = await dupContextForFinding(finding);
    const result = await client.proposeDuplicate(
      buildDuplicatePrompt(context),
      finding,
    );
    if (!result.ok) {
      outcomes.push({
        finding,
        model: llm.model,
        proposal: null,
        files: null,
        badge: null,
        failure: result.reason,
      });
      continue;
    }

    let files: DuplicateSpliceResult[];
    try {
      const originals = new Map<string, string>();
      for (const file of new Set(finding.locations.map((l) => l.file))) {
        originals.set(file, await readFile(file, "utf8"));
      }
      files = await spliceDuplicate(originals, result.proposal);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcomes.push({
        finding,
        model: llm.model,
        proposal: result.proposal,
        files: null,
        badge: null,
        failure: reason,
      });
      continue;
    }

    const skipReason = usingDefaultChecks
      ? defaultChecksSkipReason((pred) =>
          finding.locations.some((l) => pred(l.file)),
        )
      : undefined;
    const badge = !opts.verifyRunner
      ? null
      : skipReason
        ? { status: "skipped" as const, reason: skipReason }
        : await verifyEdits(
            files.map((f) => ({
              file: relative(repoRoot, f.file),
              content: f.newContent,
            })),
            checks,
            opts.verifyRunner,
          );

    outcomes.push({
      finding,
      model: llm.model,
      proposal: result.proposal,
      files,
      badge,
    });
  }

  return { outcomes, consideredCloneGroups: duplication.length };
}
