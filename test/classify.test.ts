import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { classify } from "../src/analyze/classify.js";
import { findTaintedFiles } from "../src/analyze/reachability.js";
import type { ReachabilityResult } from "../src/analyze/reachability.js";
import type { SymbolNode } from "../src/graph/types.js";

function node(id: string, exported: boolean, file = `${id}.ts`): SymbolNode {
  return { id, name: id, file, line: 1, exported };
}

function reach(
  id: string,
  reachability: ReachabilityResult["reachability"],
  tainted = false,
): ReachabilityResult {
  return { id, reachability, tainted };
}

describe("classify", () => {
  test("private dead symbol → certain, auto-fix eligible", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("certain");
    expect(f?.verdict).toBe("dead");
    expect(f?.autoFixEligible).toBe(true);
  });

  test("exported dead symbol → likely, not auto-fixable", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("tainted dead candidate → maybe, never auto-fixed", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead", true)],
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("public-API dead symbol → maybe", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "dead")],
      publicApiIds: new Set(["a"]),
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("test-only symbol → test-only verdict, never auto-fixed", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "test-only")],
    });
    expect(f?.verdict).toBe("test-only");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("alive symbols are not reported as findings", () => {
    const findings = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "alive")],
    });
    expect(findings).toEqual([]);
  });
});

describe("classify with entryCollapse (AC-3)", () => {
  test("a private dead candidate that would be certain is demoted to maybe, not auto-fixable", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      entryCollapse: true,
    });
    expect(f?.verdict).toBe("dead");
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("an exported (likely) dead candidate is also demoted to maybe", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "dead")],
      entryCollapse: true,
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("prepends a truthful unseeded-reachability evidence signal ahead of the normal chain", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      entryCollapse: true,
    });
    expect(f?.evidence[0]).toEqual({
      ok: false,
      text: "0 production entry points resolved — reachability unseeded",
    });
    expect(f?.evidence.length).toBeGreaterThan(1); // the normal chain still follows
  });

  test("test-only findings are unaffected by entryCollapse", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "test-only")],
      entryCollapse: true,
    });
    expect(f?.verdict).toBe("test-only");
    expect(f?.evidence[0]?.text).not.toBe("0 production entry points resolved — reachability unseeded");
  });

  test("entryCollapse: false (or omitted) is byte-identical to phase-01 behavior", () => {
    const withFalse = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      entryCollapse: false,
    });
    const omitted = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
    });
    expect(withFalse).toEqual(omitted);
  });
});

describe("classify with coverage", () => {
  const evidenceText = (f: { evidence: { text: string }[] }) => f.evidence.map((e) => e.text);

  test("coverage miss keeps a private dead candidate certain + auto-fixable (AC-2)", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      coverage: () => ({ kind: "miss" }),
    });
    expect(f?.tier).toBe("certain");
    expect(f?.autoFixEligible).toBe(true);
    expect(f?.evidence).toContainEqual({ ok: true, text: "0 coverage hits (lcov)" });
  });

  test("runtime hits force a dead candidate to maybe, never auto-fixed (AC-3)", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      coverage: () => ({ kind: "hit", hits: 3 }),
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
    expect(evidenceText(f!)).toContainEqual(
      "executed at runtime (3 hits) despite 0 static refs — reached dynamically",
    );
  });

  test("coverage unavailable for a symbol leaves phase-01 behavior intact (AC-4)", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      coverage: () => ({ kind: "unavailable" }),
    });
    expect(f?.tier).toBe("certain");
    expect(f?.evidence).toContainEqual({ ok: null, text: "coverage: not available" });
  });

  test("no coverage fn supplied → byte-identical to phase 01 (coverage: not available) (AC-6)", () => {
    const [withFn] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      coverage: () => ({ kind: "unavailable" }),
    });
    const [without] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
    });
    expect(without).toEqual(withFn);
  });
});

describe("classify — Python tier cap (AC-6, phase 45)", () => {
  test("a private, zero-ref Python symbol is capped at likely, never certain", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.py")],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("the same shape for a TS symbol is unaffected — still reaches certain", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.ts")],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("certain");
    expect(f?.autoFixEligible).toBe(true);
  });

  test("an already-tainted Python symbol stays maybe (cap never raises a tier)", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.py")],
      reachability: [reach("a", "dead", true)],
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });
});

describe("classify — PHP tier cap (T7, phase 75)", () => {
  test("a private, zero-ref PHP symbol is capped at likely, never certain", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.php")],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("the same shape for a TS symbol is unaffected — still reaches certain", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.ts")],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("certain");
    expect(f?.autoFixEligible).toBe(true);
  });

  test("an already-tainted PHP symbol stays maybe (cap never raises a tier)", () => {
    const [f] = classify({
      nodes: [node("a", false, "pkg/mod.php")],
      reachability: [reach("a", "dead", true)],
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });
});

describe("classify — dict-literal dispatch taint fix integration (rec-20260814-001, AC-5)", () => {
  test("a private zero-ref symbol in the real pip cache.py fixture is promoted from maybe to likely once findTaintedFiles no longer taints the file — still not certain, per the pre-existing Python hard cap above", async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/python-realrepo/pip/pip/_internal/commands/cache.py",
    );
    const text = await readFile(fixture, "utf8");
    const tainted = findTaintedFiles([{ file: fixture, text }]);
    expect(tainted.has(fixture)).toBe(false); // the fix under test

    const [f] = classify({
      nodes: [node("helper", false, fixture)],
      reachability: [reach("helper", "dead", tainted.has(fixture))],
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);

    // Same symbol, taint forced back on: shows the delta the fix produces
    // (maybe -> likely), not just a tier that the Python cap alone explains.
    const [stillTainted] = classify({
      nodes: [node("helper", false, fixture)],
      reachability: [reach("helper", "dead", true)],
    });
    expect(stillTainted?.tier).toBe("maybe");
  });
});

describe("classify — initializerEffect demotion (phase 68)", () => {
  test("effectful initializer demotes a private dead symbol from certain to likely", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      initializerEffect: () => "effectful",
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);
    expect(f?.evidence.some((e) => e.text.includes("known I/O API"))).toBe(
      true,
    );
  });

  test("pure initializer leaves a private dead symbol at certain", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
      initializerEffect: () => "pure",
    });
    expect(f?.tier).toBe("certain");
    expect(f?.autoFixEligible).toBe(true);
  });

  test("absent resolver behaves exactly as before (unknown, tier unaffected)", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead")],
    });
    expect(f?.tier).toBe("certain");
    expect(f?.autoFixEligible).toBe(true);
    expect(
      f?.evidence.some((e) => e.text === "initializer side effects: not checked"),
    ).toBe(true);
  });

  test("an already-tainted symbol stays maybe regardless of initializer effect", () => {
    const [f] = classify({
      nodes: [node("a", false)],
      reachability: [reach("a", "dead", true)],
      initializerEffect: () => "effectful",
    });
    expect(f?.tier).toBe("maybe");
    expect(f?.autoFixEligible).toBe(false);
  });

  test("an exported symbol is already likely — effectful initializer doesn't change that", () => {
    const [f] = classify({
      nodes: [node("a", true)],
      reachability: [reach("a", "dead")],
      initializerEffect: () => "effectful",
    });
    expect(f?.tier).toBe("likely");
    expect(f?.autoFixEligible).toBe(false);
  });
});
