import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/engine/index.js";
import type { ClassifiedFinding } from "../src/analyze/classify.js";
import {
  meetsFloors,
  scoreRealrepoCases,
  type RealrepoCase,
  type RealrepoPair,
} from "../src/python/realrepo-eval.js";

/**
 * Phase 70's own AC-6 (rec-20260814-001): the dict-literal dispatch-table
 * taint fix must not regress the real-repo precision/recall floors that
 * test/python-realrepo-accuracy-gate.test.ts (phase 49) already enforces.
 * That file's own AC ids belong to phase 49, not this phase, so this is a
 * separate, phase-70-owned assertion reusing the same scoring machinery —
 * not a retitle of the shared gate.
 */
const FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/python-realrepo",
);
const CORPUS_PATH = join(FIXTURES_ROOT, "cases.json");

const PRECISION_FLOOR = 0.85;
const RECALL_FLOOR = 0.5;

async function loadCases(): Promise<RealrepoCase[]> {
  return JSON.parse(await readFile(CORPUS_PATH, "utf8")) as RealrepoCase[];
}

async function scanFixture(
  repoDir: string,
): Promise<Map<string, ClassifiedFinding>> {
  const config = await loadConfig(repoDir);
  const result = await scan(repoDir, config, { complexity: false });
  const byKey = new Map<string, ClassifiedFinding>();
  for (const finding of result.findings) {
    const relFile = relative(repoDir, finding.node.file)
      .split("\\")
      .join("/");
    byKey.set(`${relFile}:${finding.node.line}:${finding.node.name}`, finding);
  }
  return byKey;
}

describe("dict-literal dispatch taint fix — real-repo accuracy gate (AC-6)", () => {
  test("AC-6: precision/recall floors hold with the taint fix in place", async () => {
    const cases = await loadCases();
    const pipFindings = await scanFixture(join(FIXTURES_ROOT, "pip"));
    const httpieFindings = await scanFixture(join(FIXTURES_ROOT, "httpie"));

    const pairs: RealrepoPair[] = cases.map((c) => {
      const byKey =
        c.provenance.repo === "pypa/pip" ? pipFindings : httpieFindings;
      const key = `${c.provenance.file}:${c.provenance.line}:${c.provenance.symbol}`;
      return { case: c, finding: byKey.get(key) ?? null };
    });

    const metrics = scoreRealrepoCases(pairs);

    expect(
      metrics.precision,
      `precision ${metrics.precision.toFixed(3)} below floor ${PRECISION_FLOOR}`,
    ).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(
      metrics.recall,
      `recall ${metrics.recall.toFixed(3)} below floor ${RECALL_FLOOR}`,
    ).toBeGreaterThanOrEqual(RECALL_FLOOR);
    expect(meetsFloors(metrics, PRECISION_FLOOR, RECALL_FLOOR)).toBe(true);
  });
});
