import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LLM } from "../src/config.js";
import type { RefactorClient } from "../src/refactor/client.js";
import { runExtractDuplicate } from "../src/refactor/index.js";
import type { DuplicateProposal } from "../src/refactor/prompt.js";
import type { FileEdit, VerifyRunner } from "../src/refactor/verify.js";
import type { DuplicationFinding } from "../src/syntactic/types.js";

const A_BODY = ["import { db } from \"./db.js\";", "export function loadA() {", "  const r = db.query('a');", "  return r.id;", "}", ""].join("\n");
const B_BODY = ["import { db } from \"./db.js\";", "export function loadB() {", "  const r = db.query('b');", "  return r.id;", "}", ""].join("\n");

let writtenEdits: FileEdit[] = [];
const greenRunner = (): VerifyRunner => ({
  createWorktree: async () => "/wt",
  writeEdit: async (_wt, edit) => {
    writtenEdits.push(edit);
  },
  runCheck: async () => ({ ok: true, output: "" }),
  removeWorktree: async () => {},
});

describe("runExtractDuplicate (AC-1, AC-4)", () => {
  let dir: string;
  let a: string;
  let b: string;

  const proposalFor = (): DuplicateProposal => ({
    summary: "extract loadId",
    sharedFunction: "export function loadId(key) {\n  const r = db.query(key);\n  return r.id;\n}",
    sharedFunctionFile: a,
    edits: [
      { file: a, startLine: 3, endLine: 4, replacement: "  return loadId('a');" },
      { file: b, startLine: 3, endLine: 4, replacement: "  return loadId('b');" },
    ],
    rationale: "shared the query",
  });

  const finding = (): DuplicationFinding => ({
    tokens: 30,
    locations: [
      { file: a, startLine: 3, endLine: 4 },
      { file: b, startLine: 3, endLine: 4 },
    ],
  });

  const okClient = (): RefactorClient => ({
    propose: vi.fn(async () => ({ ok: false as const, reason: "n/a" })),
    proposeDuplicate: vi.fn(async () => ({ ok: true as const, proposal: proposalFor() })),
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "necro-dup-"));
    a = join(dir, "a.ts");
    b = join(dir, "b.ts");
    await writeFile(a, A_BODY);
    await writeFile(b, B_BODY);
    writtenEdits = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("proposes for clone groups, splices, attaches diff + badge (AC-1)", async () => {
    const client = okClient();
    const res = await runExtractDuplicate([finding()], DEFAULT_LLM, client, {
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(client.proposeDuplicate).toHaveBeenCalledTimes(1);
    expect(res.consideredCloneGroups).toBe(1);
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0]?.badge?.status).toBe("green");
    expect(res.outcomes[0]?.files?.map((f) => f.file).sort()).toEqual([a, b].sort());
    expect(res.outcomes[0]?.files?.some((f) => f.diff?.includes("loadId"))).toBe(true);
  });

  test("zero clone groups makes no client call and returns empty (AC-1)", async () => {
    const client = okClient();
    const res = await runExtractDuplicate([], DEFAULT_LLM, client, { verifyRunner: greenRunner(), repoRoot: dir });
    expect(client.proposeDuplicate).not.toHaveBeenCalled();
    expect(res.outcomes).toEqual([]);
    expect(res.consideredCloneGroups).toBe(0);
  });

  test("respects the limit (AC-1)", async () => {
    const client = okClient();
    const res = await runExtractDuplicate([finding(), finding(), finding()], DEFAULT_LLM, client, {
      limit: 1,
      verifyRunner: greenRunner(),
      repoRoot: dir,
    });
    expect(client.proposeDuplicate).toHaveBeenCalledTimes(1);
    expect(res.outcomes).toHaveLength(1);
  });

  test("does not mutate the finding (AC-4)", async () => {
    const f = finding();
    const snapshot = structuredClone(f);
    await runExtractDuplicate([f], DEFAULT_LLM, okClient(), { verifyRunner: greenRunner(), repoRoot: dir });
    expect(f).toEqual(snapshot);
  });

  test("never writes to the source files — suggest-only (AC-4)", async () => {
    const beforeA = await readFile(a, "utf8");
    const beforeB = await readFile(b, "utf8");
    await runExtractDuplicate([finding()], DEFAULT_LLM, okClient(), { verifyRunner: greenRunner(), repoRoot: dir });
    expect(await readFile(a, "utf8")).toBe(beforeA);
    expect(await readFile(b, "utf8")).toBe(beforeB);
  });

  test("writes every affected file's full content to the worktree, never a diff (AC-4)", async () => {
    await runExtractDuplicate([finding()], DEFAULT_LLM, okClient(), { verifyRunner: greenRunner(), repoRoot: dir });
    expect(writtenEdits).toHaveLength(2);
    const byFile = Object.fromEntries(writtenEdits.map((e) => [e.file, e.content]));
    expect(byFile["a.ts"]).toContain("export function loadId(key)");
    expect(byFile["b.ts"]).toMatch(/import \{ loadId \} from "\.\/a\.js";/);
  });

  test("records a failure (no throw) when the response can't be parsed (AC-4)", async () => {
    const client: RefactorClient = {
      propose: async () => ({ ok: false, reason: "n/a" }),
      proposeDuplicate: async () => ({ ok: false, reason: "unparseable" }),
    };
    const res = await runExtractDuplicate([finding()], DEFAULT_LLM, client, { verifyRunner: greenRunner(), repoRoot: dir });
    expect(res.outcomes[0]?.proposal).toBeNull();
    expect(res.outcomes[0]?.failure).toMatch(/unparseable/);
    expect(res.outcomes[0]?.badge).toBeNull();
  });

  test("records a failure (no throw) when the proposal can't be spliced (AC-4)", async () => {
    const bad: DuplicateProposal = {
      ...proposalFor(),
      // overlapping edits in a.ts → splice throws → recorded, not thrown
      edits: [
        { file: a, startLine: 2, endLine: 4, replacement: "x" },
        { file: a, startLine: 3, endLine: 5, replacement: "y" },
        { file: b, startLine: 3, endLine: 4, replacement: "  return loadId('b');" },
      ],
    };
    const client: RefactorClient = {
      propose: async () => ({ ok: false, reason: "n/a" }),
      proposeDuplicate: async () => ({ ok: true, proposal: bad }),
    };
    const res = await runExtractDuplicate([finding()], DEFAULT_LLM, client, { verifyRunner: greenRunner(), repoRoot: dir });
    expect(res.outcomes[0]?.files).toBeNull();
    expect(res.outcomes[0]?.failure).toMatch(/overlapping/);
    expect(res.outcomes[0]?.proposal).not.toBeNull(); // we got a proposal, splice failed
  });

  describe("Python + default checks (rec-20260719-006)", () => {
    let c: string;
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

    const proposalWithPython = (): DuplicateProposal => ({
      summary: "extract loadId",
      sharedFunction: "export function loadId(key) {\n  const r = db.query(key);\n  return r.id;\n}",
      sharedFunctionFile: a,
      edits: [
        { file: a, startLine: 3, endLine: 4, replacement: "  return loadId('a');" },
        { file: c, startLine: 2, endLine: 2, replacement: "    return loadId('c')" },
      ],
      rationale: "shared the query",
    });

    const findingWithPython = (): DuplicationFinding => ({
      tokens: 30,
      locations: [
        { file: a, startLine: 3, endLine: 4 },
        { file: c, startLine: 2, endLine: 2 },
      ],
    });

    beforeEach(async () => {
      c = join(dir, "c.py");
      await writeFile(c, "def load_c():\n    return db.query('c').id\n");
      checksSeen = [];
    });

    test("a clone group touching a Python location under default checks is skipped (AC-3)", async () => {
      const client: RefactorClient = {
        propose: vi.fn(async () => ({ ok: false as const, reason: "n/a" })),
        proposeDuplicate: vi.fn(async () => ({ ok: true as const, proposal: proposalWithPython() })),
      };
      const res = await runExtractDuplicate([findingWithPython()], DEFAULT_LLM, client, {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
      });
      expect(res.outcomes[0]?.badge).toEqual({
        status: "skipped",
        reason: expect.stringContaining("Python"),
      });
      expect(checksSeen).toEqual([]);
    });

    test("an explicit --checks override with a Python location still runs (AC-4)", async () => {
      const client: RefactorClient = {
        propose: vi.fn(async () => ({ ok: false as const, reason: "n/a" })),
        proposeDuplicate: vi.fn(async () => ({ ok: true as const, proposal: proposalWithPython() })),
      };
      const res = await runExtractDuplicate([findingWithPython()], DEFAULT_LLM, client, {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
        checks: ["pytest"],
      });
      expect(res.outcomes[0]?.badge?.status).toBe("green");
      expect(checksSeen).toEqual(["pytest"]);
    });
  });

  describe("PHP + default checks (T7, phase 75)", () => {
    let d: string;
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

    const proposalWithPhp = (): DuplicateProposal => ({
      summary: "extract loadId",
      sharedFunction: "export function loadId(key) {\n  const r = db.query(key);\n  return r.id;\n}",
      sharedFunctionFile: a,
      edits: [
        { file: a, startLine: 3, endLine: 4, replacement: "  return loadId('a');" },
        { file: d, startLine: 2, endLine: 2, replacement: "    return loadId('d');" },
      ],
      rationale: "shared the query",
    });

    const findingWithPhp = (): DuplicationFinding => ({
      tokens: 30,
      locations: [
        { file: a, startLine: 3, endLine: 4 },
        { file: d, startLine: 2, endLine: 2 },
      ],
    });

    beforeEach(async () => {
      d = join(dir, "d.php");
      await writeFile(d, "<?php\nfunction load_d() {\n  return db_query('d')['id'];\n}\n");
      checksSeen = [];
    });

    test("a clone group touching a PHP location under default checks is skipped (AC-3)", async () => {
      const client: RefactorClient = {
        propose: vi.fn(async () => ({ ok: false as const, reason: "n/a" })),
        proposeDuplicate: vi.fn(async () => ({ ok: true as const, proposal: proposalWithPhp() })),
      };
      const res = await runExtractDuplicate([findingWithPhp()], DEFAULT_LLM, client, {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
      });
      expect(res.outcomes[0]?.badge).toEqual({
        status: "skipped",
        reason: expect.stringContaining("PHP"),
      });
      expect(checksSeen).toEqual([]);
    });

    test("an explicit --checks override with a PHP location still runs (AC-4)", async () => {
      const client: RefactorClient = {
        propose: vi.fn(async () => ({ ok: false as const, reason: "n/a" })),
        proposeDuplicate: vi.fn(async () => ({ ok: true as const, proposal: proposalWithPhp() })),
      };
      const res = await runExtractDuplicate([findingWithPhp()], DEFAULT_LLM, client, {
        verifyRunner: recordingRunner(),
        repoRoot: dir,
        checks: ["phpunit"],
      });
      expect(res.outcomes[0]?.badge?.status).toBe("green");
      expect(checksSeen).toEqual(["phpunit"]);
    });
  });
});
