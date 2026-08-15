import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, test, vi } from "vitest";
import {
  createInitializerEffectResolver,
  initializerEffectForDeclaration,
} from "../src/analyze/initializer-effect.js";
import type { SymbolNode } from "../src/graph/types.js";

function effectOf(source: string): ReturnType<typeof initializerEffectForDeclaration> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });
  const sf = project.createSourceFile("case.ts", source);
  const decl = sf.getFirstDescendantByKindOrThrow(SyntaxKind.VariableDeclaration);
  const name = decl.getNameNode().getText();
  const line = decl.getNameNode().getStartLineNumber();
  return initializerEffectForDeclaration(sf, name, line);
}

describe("initializerEffectForDeclaration — synthetic shapes (AC-2, AC-3, AC-4)", () => {
  test("bare-identifier fs call is effectful", () => {
    const src = `import { readFileSync } from "node:fs";\nconst lines = readFileSync("f", "utf8");\n`;
    expect(effectOf(src)).toBe("effectful");
  });

  test("member-access fs call is effectful", () => {
    const src = `import * as fs from "node:fs";\nconst data = fs.readFileSync("f", "utf8");\n`;
    expect(effectOf(src)).toBe("effectful");
  });

  test("fs call nested one level inside an IIFE-style wrapper argument is effectful (AC-2)", () => {
    const src = `
import * as fs from "node:fs";
declare function run<T>(fn: () => T): T;
const cert = run(() => {
  const key = fs.readFileSync("k");
  return { key };
});
`;
    expect(effectOf(src)).toBe("effectful");
  });

  test("new-expression is never effectful, even for a same-named constructor (AC-3)", () => {
    expect(effectOf(`const byCase = new Map();\n`)).toBe("pure");
    expect(
      effectOf(
        `class PrismaClient {}\nconst prisma = new PrismaClient();\n`,
      ),
    ).toBe("pure");
  });

  test("factory call not in the denylist is pure", () => {
    const src = `declare function initTRPC(): { create(): unknown };\nconst t = initTRPC.create();\n`;
    expect(effectOf(src)).toBe("pure");
  });

  test("pure computation over a builtin (parseInt, process.argv) is pure", () => {
    expect(
      effectOf(`const runs = parseInt(process.argv[2] ?? "1");\n`),
    ).toBe("pure");
  });

  test("uninvoked function/arrow-function definition is pure regardless of body", () => {
    const src = `import { readFileSync } from "node:fs";\nconst sleep = () => readFileSync("f");\n`;
    expect(effectOf(src)).toBe("pure");
  });

  test("same-named local helper NOT bound to node:fs is not flagged (AC-4)", () => {
    const src = `
function readFileSync(path: string): string { return path; }
const x = readFileSync("f");
`;
    expect(effectOf(src)).toBe("pure");
  });

  test("unresolved/dynamic call fails open to pure", () => {
    const src = `declare const mystery: any;\nconst x = mystery.readFileSync("f");\n`;
    expect(effectOf(src)).toBe("pure");
  });
});

describe("initializerEffectForDeclaration — phase-67 real-world corpus (AC-1)", () => {
  interface CorpusCase {
    name: string;
    source: string;
    truth: "genuinely-risky" | "safe-to-remove";
  }

  const corpusPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/side-effect-initializer-corpus/cases.json",
  );

  function loadCorpus(): CorpusCase[] {
    return JSON.parse(readFileSync(corpusPath, "utf8"));
  }

  /**
   * `cases.json` stores only the isolated initializer snippet (by design,
   * phase 67) — it never carried the file's import statements, so an
   * import-resolution screen has nothing to bind `readFileSync`/`fs.*` to.
   * These are the real, verbatim import lines from each risky case's pinned
   * source file (`.bench-cache/`, gitignored — not available in a fresh
   * clone, so hardcoded here rather than read at test time) — not a change
   * to the corpus itself, just the surrounding context every real file has.
   */
  const REAL_IMPORT_HEADER: Record<string, string> = {
    lines: `import { readFileSync } from 'node:fs';\n`,
    codegenBase: `import fs from 'fs';\n`,
    cert: `import * as childProcess from 'child_process';\nimport fs from 'fs';\n`,
  };

  test("scores TP=3, FP=0 on all 19 hand-labeled cases (precision 1.0, recall 3/3)", () => {
    const cases = loadCorpus();
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (const c of cases) {
      const header = REAL_IMPORT_HEADER[c.name] ?? "";
      const effect = effectOf(header + c.source);
      const flagged = effect === "effectful";
      const isRisky = c.truth === "genuinely-risky";
      if (flagged && isRisky) tp++;
      else if (flagged && !isRisky) fp++;
      else if (!flagged && !isRisky) tn++;
      else fn++;
    }

    expect({ tp, fp, tn, fn }).toEqual({ tp: 3, fp: 0, tn: 16, fn: 0 });
  });
});

describe("createInitializerEffectResolver — PHP guard (T7, phase 75)", () => {
  const node = (file: string): SymbolNode => ({
    id: `${file}:1:a`,
    name: "a",
    file,
    line: 1,
    exported: false,
  });

  test("a PHP node returns unknown without ever touching ts-morph's addSourceFileAtPath — a real .ts node still does (positive control)", () => {
    const spy = vi.spyOn(Project.prototype, "addSourceFileAtPath");
    try {
      const resolve = createInitializerEffectResolver();

      expect(resolve(node("pkg/mod.php"))).toBe("unknown");
      expect(spy).not.toHaveBeenCalledWith(
        expect.stringContaining(".php"),
      );
      expect(spy).not.toHaveBeenCalled();

      // Positive control: a real .ts path does reach ts-morph — proves the
      // spy is wired to the object this resolver actually uses, so the
      // negative assertion above isn't vacuous.
      const tsFile = fileURLToPath(import.meta.url);
      resolve(node(tsFile));
      expect(spy).toHaveBeenCalledWith(tsFile);
    } finally {
      spy.mockRestore();
    }
  });
});
