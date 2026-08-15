import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ReachabilityModel } from "../src/engine/model.js";
import type { FileEdit, VerifyRunner } from "../src/refactor/verify.js";

/**
 * `verifyRemovals` resolves symbols against `buildReachabilityModel`'s graph
 * — but PHP contributes zero graph nodes today (no PHP symbol graph exists
 * yet; that's this whole phase's premise, per `isPhpFile`'s own doc comment
 * in `src/graph/php/language.ts`). A real `.php` fixture query would never
 * reach `verify-removal.ts`'s `isPhpFile` refusal branch — `resolveQuery`
 * would return zero matches first ("no matching symbol"), so the guard would
 * be untestable (and unreachable) through the real model. Mocking
 * `buildReachabilityModel` to return a synthetic PHP node is what lets this
 * test actually exercise the refusal branch, ahead of the PHP symbol graph
 * this phase builds later (T3).
 */
vi.mock("../src/engine/model.js", () => ({
  buildReachabilityModel: vi.fn(
    async (): Promise<ReachabilityModel> => ({
      files: ["mod.php"],
      graph: {
        nodes: [
          { id: "mod.php:1:dead_php", name: "dead_php", file: "mod.php", line: 1, exported: true },
        ],
        edges: [],
      },
      edges: [],
      prodEntries: new Set(),
      testEntries: new Set(),
      taintedFiles: new Set(),
      reachability: [{ id: "mod.php:1:dead_php", reachability: "dead", tainted: false }],
      sources: [],
      entryResolution: { prodEntryCount: 0, sources: [], collapsed: false },
      publicApiIds: new Set(),
    }),
  ),
}));

// Imported after the mock so `verifyRemovals` picks up the mocked model.
const { verifyRemovals } = await import("../src/engine/verify-removal.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-verify-removal-php-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Same shape as the fake runner factory in `verify-removal.test.ts` — a
 * fresh runner per symbol, tracked so the test can assert none was built. */
function fakeRunnerFactory(calls: { roots: string[] }) {
  return (root: string): VerifyRunner => {
    calls.roots.push(root);
    return {
      createWorktree: async () => "/wt",
      writeEdit: async (_wt: string, _edit: FileEdit) => {},
      runCheck: async () => ({ ok: true, output: "" }),
      removeWorktree: async () => {},
    };
  };
}

describe("verify-removal — PHP refusal (T7, phase 75)", () => {
  test("a PHP symbol query is refused with a clear message, and no worktree is spun up", async () => {
    const calls = { roots: [] as string[] };

    const results = await verifyRemovals(dir, DEFAULT_CONFIG, ["dead_php"], {
      repoRoot: dir,
      checks: ["typecheck"],
      runnerFactory: fakeRunnerFactory(calls),
    });

    expect(results).toEqual([
      {
        symbol: "dead_php",
        status: "unresolved",
        output:
          "PHP removal is not supported yet — necro's PHP support is report/explain/triage only",
        resolvedId: "mod.php:1:dead_php",
      },
    ]);
    expect(calls.roots).toHaveLength(0); // no worktree ever created for the refused symbol
  });
});
