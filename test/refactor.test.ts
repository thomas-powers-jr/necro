import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LLM } from "../src/config.js";
import type { RefactorClient } from "../src/refactor/client.js";
import type { RefactorProposal } from "../src/refactor/prompt.js";
import { runRefactor } from "../src/refactor/index.js";
import type { FileEdit, VerifyRunner } from "../src/refactor/verify.js";
import type { ComplexityFinding, Detector } from "../src/syntactic/types.js";

const REPLACEMENT = [
  "export function big() {",
  "  return computeBig();",
  "}",
  "",
  "function computeBig() {",
  "  return 1;",
  "}",
].join("\n");

const PROPOSAL: RefactorProposal = {
  summary: "extract computeBig",
  newFunctions: ["computeBig"],
  replacement: REPLACEMENT,
  rationale: "moved the body into a helper",
};

const okClient = (): RefactorClient => ({
  propose: vi.fn(async () => ({ ok: true as const, proposal: PROPOSAL })),
  proposeDuplicate: vi.fn(async () => ({ ok: false as const, reason: "not exercised here" })),
});

let writtenEdits: FileEdit[] = [];
const greenRunner = (): VerifyRunner => ({
  createWorktree: async () => "/wt",
  writeEdit: async (_wt, edit) => {
    writtenEdits.push(edit);
  },
  runCheck: async () => ({ ok: true, output: "" }),
  removeWorktree: async () => {},
});

const finding = (file: string, name: string, detector: Detector = "god-function"): ComplexityFinding => ({
  detector,
  file,
  line: 1,
  name,
  value: 80,
  threshold: 50,
  message: `${detector} — flagged`,
});

describe("runRefactor (AC-1, AC-4)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "necro-refrun-"));
    file = join(dir, "svc.ts");
    await writeFile(file, "export function big() {\n  return 1;\n}\n");
    writtenEdits = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("proposes only for god-function findings, never others (AC-1)", async () => {
    const client = okClient();
    const res = await runRefactor(
      [finding(file, "big", "god-function"), finding(file, "tangled", "cyclomatic")],
      DEFAULT_LLM,
      client,
      { limit: 10, verifyRunner: greenRunner(), repoRoot: dir },
    );
    expect(client.propose).toHaveBeenCalledTimes(1);
    expect(res.outcomes.map((o) => o.finding.name)).toEqual(["big"]);
    expect(res.consideredGodFunctions).toBe(1);
  });

  test("zero god-function findings makes no client call and returns empty (AC-1)", async () => {
    const client = okClient();
    const res = await runRefactor([finding(file, "tangled", "cyclomatic")], DEFAULT_LLM, client, {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(client.propose).not.toHaveBeenCalled();
    expect(res.outcomes).toEqual([]);
    expect(res.consideredGodFunctions).toBe(0);
  });

  test("respects the limit (AC-1)", async () => {
    const client = okClient();
    const res = await runRefactor(
      [finding(file, "a"), finding(file, "b"), finding(file, "c")],
      DEFAULT_LLM,
      client,
      { limit: 1, verifyRunner: greenRunner(), repoRoot: dir },
    );
    expect(client.propose).toHaveBeenCalledTimes(1);
    expect(res.outcomes).toHaveLength(1);
  });

  test("does not mutate the finding (AC-4)", async () => {
    const f = finding(file, "big");
    const snapshot = structuredClone(f);
    await runRefactor([f], DEFAULT_LLM, okClient(), { verifyRunner: greenRunner(), repoRoot: dir });
    expect(f).toEqual(snapshot);
  });

  test("never writes to the source file — suggest-only (AC-4)", async () => {
    const before = await readFile(file, "utf8");
    await runRefactor([finding(file, "big")], DEFAULT_LLM, okClient(), {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("splices the replacement into full file content for verification, never a diff (AC-4)", async () => {
    await runRefactor([finding(file, "big")], DEFAULT_LLM, okClient(), {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(writtenEdits).toHaveLength(1);
    expect(writtenEdits[0]?.file).toBe("svc.ts");
    expect(writtenEdits[0]?.content).toContain("function computeBig()");
    expect(writtenEdits[0]?.content).toContain("export function big()");
  });

  test("attaches the badge and a necro-computed diff for display (AC-4)", async () => {
    const res = await runRefactor([finding(file, "big")], DEFAULT_LLM, okClient(), {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(res.outcomes[0]?.badge?.status).toBe("green");
    expect(res.outcomes[0]?.proposal?.replacement).toContain("computeBig");
    expect(res.outcomes[0]?.diff).toContain("computeBig"); // necro generated the diff
  });

  test("records a failure (no throw) when the model response can't be parsed (AC-4)", async () => {
    const client: RefactorClient = {
      propose: async () => ({ ok: false, reason: "unparseable" }),
      proposeDuplicate: async () => ({ ok: false, reason: "n/a" }),
    };
    const res = await runRefactor([finding(file, "big")], DEFAULT_LLM, client, {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(res.outcomes[0]?.proposal).toBeNull();
    expect(res.outcomes[0]?.failure).toMatch(/unparseable/);
    expect(res.outcomes[0]?.badge).toBeNull();
  });

  describe("Python + default checks (rec-20260719-006)", () => {
    let pyFile: string;
    let checksSeen: string[];
    const recordingRunner = (): VerifyRunner => ({
      createWorktree: async () => "/wt",
      writeEdit: async () => {},
      runCheck: async (_wt, command) => {
        checksSeen.push(command);
        return { ok: true, output: "" };
      },
      removeWorktree: async () => {},
    });

    beforeEach(async () => {
      pyFile = join(dir, "svc.py");
      await writeFile(pyFile, "def big():\n    return 1\n");
      checksSeen = [];
    });

    test("a Python finding under default checks is skipped, never runs npm checks (AC-1)", async () => {
      const res = await runRefactor([finding(pyFile, "big")], DEFAULT_LLM, okClient(), {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
      });
      expect(res.outcomes[0]?.badge).toEqual({
        status: "skipped",
        reason: expect.stringContaining("Python"),
      });
      expect(checksSeen).toEqual([]);
    });

    test("a TypeScript finding under default checks is unaffected (AC-2)", async () => {
      const res = await runRefactor([finding(file, "big")], DEFAULT_LLM, okClient(), {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
      });
      expect(res.outcomes[0]?.badge?.status).toBe("green");
      expect(checksSeen.length).toBeGreaterThan(0);
    });

    test("an explicit --checks override against Python still runs (AC-4)", async () => {
      const res = await runRefactor([finding(pyFile, "big")], DEFAULT_LLM, okClient(), {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
        checks: ["pytest"],
      });
      expect(res.outcomes[0]?.badge?.status).toBe("green");
      expect(checksSeen).toEqual(["pytest"]);
    });
  });

  describe("PHP + default checks (T7, phase 75)", () => {
    let phpFile: string;
    let checksSeen: string[];
    const recordingRunner = (): VerifyRunner => ({
      createWorktree: async () => "/wt",
      writeEdit: async () => {},
      runCheck: async (_wt, command) => {
        checksSeen.push(command);
        return { ok: true, output: "" };
      },
      removeWorktree: async () => {},
    });

    beforeEach(async () => {
      phpFile = join(dir, "svc.php");
      await writeFile(phpFile, "<?php\nfunction big() {\n  return 1;\n}\n");
      checksSeen = [];
    });

    test("a PHP finding under default checks is skipped, never runs npm checks (AC-1)", async () => {
      const res = await runRefactor([finding(phpFile, "big")], DEFAULT_LLM, okClient(), {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
      });
      expect(res.outcomes[0]?.badge).toEqual({
        status: "skipped",
        reason: expect.stringContaining("PHP"),
      });
      expect(checksSeen).toEqual([]);
    });

    test("an explicit --checks override against PHP still runs (AC-4)", async () => {
      const res = await runRefactor([finding(phpFile, "big")], DEFAULT_LLM, okClient(), {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
        checks: ["phpunit"],
      });
      expect(res.outcomes[0]?.badge?.status).toBe("green");
      expect(checksSeen).toEqual(["phpunit"]);
    });
  });
});
