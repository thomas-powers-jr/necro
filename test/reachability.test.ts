import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSymbolGraph } from "../src/graph/symbol-graph.js";
import {
  computeReachability,
  findTaintedFiles,
  tracePath,
} from "../src/analyze/reachability.js";
import type { ReachabilityResult } from "../src/analyze/reachability.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-reach-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function verdictOf(results: ReachabilityResult[], name: string): string {
  const r = results.find((x) => x.id.endsWith(`:${name}`));
  if (!r) throw new Error(`no result for ${name}`);
  return r.reachability;
}

describe("computeReachability (two-color)", () => {
  test("classifies alive, test-only, and dead", async () => {
    const index = await write(
      "src/index.ts",
      `import { liveUtil } from "./util";\nliveUtil();\n`,
    );
    const util = await write(
      "src/util.ts",
      `export function liveUtil() {}\nexport function testUtil() {}\n`,
    );
    const spec = await write(
      "src/util.test.ts",
      `import { testUtil } from "./util";\ntestUtil();\n`,
    );
    await write("src/orphan.ts", `export function orphan() {}\n`);

    const graph = buildSymbolGraph([
      index,
      util,
      spec,
      join(dir, "src/orphan.ts"),
    ]);

    const results = computeReachability({
      nodes: graph.nodes,
      edges: graph.edges,
      prodEntries: new Set([index]),
      testEntries: new Set([spec]),
    });

    expect(verdictOf(results, "liveUtil")).toBe("alive");
    expect(verdictOf(results, "testUtil")).toBe("test-only");
    expect(verdictOf(results, "orphan")).toBe("dead");
  });

  test("marks nodes in tainted files", () => {
    const results = computeReachability({
      nodes: [
        { id: "x.ts:1:a", name: "a", file: "x.ts", line: 1, exported: false },
      ],
      edges: [],
      prodEntries: new Set(),
      testEntries: new Set(),
      taintedFiles: new Set(["x.ts"]),
    });
    expect(results[0]?.tainted).toBe(true);
  });
});

describe("tracePath", () => {
  function idOf(graph: { nodes: { id: string }[] }, name: string): string {
    const n = graph.nodes.find((x) => x.id.endsWith(`:${name}`));
    if (!n) throw new Error(`no node for ${name}`);
    return n.id;
  }

  test("AC-1: returns the shortest prod witness chain entry -> symbol", async () => {
    const index = await write(
      "src/index.ts",
      `import { liveUtil } from "./util";\nliveUtil();\n`,
    );
    const util = await write(
      "src/util.ts",
      `export function liveUtil() {\n  helper();\n}\nfunction helper() {}\n`,
    );
    const graph = buildSymbolGraph([index, util]);

    const chain = tracePath(
      graph.edges,
      new Set([index]),
      idOf(graph, "helper"),
      (kind) => kind === "prod",
    );

    expect(chain).toEqual([index, idOf(graph, "liveUtil"), idOf(graph, "helper")]);
  });

  test("AC-1: a seed that is itself the target yields a single-node chain", () => {
    const chain = tracePath(
      [],
      new Set(["a.ts:1:root"]),
      "a.ts:1:root",
      () => true,
    );
    expect(chain).toEqual(["a.ts:1:root"]);
  });

  test("AC-3: prod-only filter returns null for a test-only symbol; all edges trace it", async () => {
    const index = await write("src/index.ts", `export function root() {}\n`);
    const util = await write(
      "src/util.ts",
      `export function testUtil() {}\n`,
    );
    const spec = await write(
      "src/util.test.ts",
      `import { testUtil } from "./util";\ntestUtil();\n`,
    );
    const graph = buildSymbolGraph([index, util, spec], {
      isTestFile: (f) => f.endsWith(".test.ts"),
    });
    const target = idOf(graph, "testUtil");

    expect(
      tracePath(graph.edges, new Set([index]), target, (kind) => kind === "prod"),
    ).toBeNull();

    const viaTest = tracePath(graph.edges, new Set([spec]), target, () => true);
    expect(viaTest?.[0]).toBe(spec);
    expect(viaTest?.[viaTest.length - 1]).toBe(target);
  });
});

describe("findTaintedFiles", () => {
  test("flags files with a non-literal dynamic import", () => {
    const tainted = findTaintedFiles([
      { file: "dyn.ts", text: "const m = await import(`./${name}`);" },
      { file: "clean.ts", text: 'import { x } from "./x";' },
    ]);
    expect(tainted.has("dyn.ts")).toBe(true);
    expect(tainted.has("clean.ts")).toBe(false);
  });

  test("flags Python files with dynamic-dispatch patterns (AC-4)", () => {
    const tainted = findTaintedFiles([
      { file: "getattr.py", text: "getattr(obj, name)()" },
      { file: "importlib.py", text: "import importlib\nimportlib.import_module(name)" },
      { file: "globals.py", text: "globals()[name]()" },
      { file: "dunder.py", text: "class C:\n    def __getattr__(self, name):\n        pass" },
      { file: "eval.py", text: "eval(user_input)" },
      { file: "exec.py", text: "exec(user_code)" },
      { file: "clean.py", text: "def helper():\n    return 1\n" },
    ]);
    expect(tainted.has("getattr.py")).toBe(true);
    expect(tainted.has("importlib.py")).toBe(true);
    expect(tainted.has("globals.py")).toBe(true);
    expect(tainted.has("dunder.py")).toBe(true);
    expect(tainted.has("eval.py")).toBe(true);
    expect(tainted.has("exec.py")).toBe(true);
    expect(tainted.has("clean.py")).toBe(false);
  });

  test("does NOT flag Python's ordinary multi-line parenthesized import as dynamic dispatch (phase 48 regression)", () => {
    const tainted = findTaintedFiles([
      {
        file: "multiline_import.py",
        text: "from pip._internal.utils.misc import (\n    build_netloc,\n    build_url_from_netloc,\n)\n",
      },
    ]);
    expect(tainted.has("multiline_import.py")).toBe(false);
  });

  test("still flags a genuinely dynamic JS import even shaped like the Python false positive", () => {
    const tainted = findTaintedFiles([{ file: "dyn2.ts", text: "const m = import(\n    moduleName\n);" }]);
    expect(tainted.has("dyn2.ts")).toBe(true);
  });

  describe("dict-literal dispatch tables (rec-20260814-001)", () => {
    test("AC-1: same-file direct dict-literal assignment is not tainted", () => {
      const tainted = findTaintedFiles([
        {
          file: "direct.py",
          text: [
            "def run(action, args):",
            "    handler_map = {",
            '        "a": do_a,',
            '        "b": do_b,',
            "    }",
            "    handler_map[action](args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("direct.py")).toBe(false);
    });

    test("AC-2: same-file method-returning-literal-dict is not tainted (real pip shape)", () => {
      const tainted = findTaintedFiles([
        {
          file: "method.py",
          text: [
            "class IndexCommand(Command):",
            "    def handler_map(self):",
            "        return {",
            '            "versions": self.get_available_package_versions,',
            "        }",
            "",
            "    def run(self, options, args):",
            "        handler_map = self.handler_map()",
            "        action = args[0]",
            "        handler_map[action](options, args[1:])",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("method.py")).toBe(false);
    });

    test("AC-3: an imported dispatch table (not bound in this file) still taints", () => {
      const tainted = findTaintedFiles([
        {
          file: "imported.py",
          text: [
            "from tasks import CLI_TASKS",
            "",
            "def dispatch(action, env, args):",
            "    return CLI_TASKS[action](env, args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("imported.py")).toBe(true);
    });

    test("AC-3: a dispatch table bound from a function parameter still taints", () => {
      const tainted = findTaintedFiles([
        {
          file: "param.py",
          text: [
            "def dispatch(handler_map, action, args):",
            "    handler_map[action](args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("param.py")).toBe(true);
    });

    test("AC-3: a dict built via post-hoc mutation still taints", () => {
      const tainted = findTaintedFiles([
        {
          file: "mutated.py",
          text: [
            "d = {}",
            'd["a"] = do_a',
            "def dispatch(action, args):",
            "    d[action](args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("mutated.py")).toBe(true);
    });

    test("AC-3: a comprehension-built dict still taints", () => {
      const tainted = findTaintedFiles([
        {
          file: "comprehension.py",
          text: [
            "handler_map = {name: fn for name, fn in pairs}",
            "def dispatch(action, args):",
            "    handler_map[action](args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("comprehension.py")).toBe(true);
    });

    test("AC-3: a dict(...) call-built table still taints (dict() is out of scope)", () => {
      const tainted = findTaintedFiles([
        {
          file: "dictcall.py",
          text: [
            "handler_map = dict(a=do_a, b=do_b)",
            "def dispatch(action, args):",
            "    handler_map[action](args)",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("dictcall.py")).toBe(true);
    });

    test("AC-3: globals()[name]() still taints — receiver is a call, not a bare identifier", () => {
      const tainted = findTaintedFiles([
        { file: "globals2.py", text: "globals()[name]()" },
      ]);
      expect(tainted.has("globals2.py")).toBe(true);
    });

    test("AC-3: an attribute-chain receiver (self.tbl[k](...)) still taints", () => {
      const taintedSelf = findTaintedFiles([
        {
          file: "attr_self.py",
          text: [
            "class C:",
            "    def dispatch(self, action, args):",
            "        self.tbl[action](args)",
          ].join("\n"),
        },
      ]);
      expect(taintedSelf.has("attr_self.py")).toBe(true);

      const taintedMod = findTaintedFiles([
        {
          file: "attr_mod.py",
          text: ["def dispatch(action, args):", "    mod.tbl[action](args)"].join(
            "\n",
          ),
        },
      ]);
      expect(taintedMod.has("attr_mod.py")).toBe(true);
    });

    test("AC-3: the same literal-dict shape in a .ts file still taints (Python-only suppression)", () => {
      const tainted = findTaintedFiles([
        {
          file: "direct.ts",
          text: [
            "const handlerMap = {",
            "  a: doA,",
            "  b: doB,",
            "};",
            "handlerMap[action](args);",
          ].join("\n"),
        },
      ]);
      expect(tainted.has("direct.ts")).toBe(true);
    });

    test("AC-4: real python-realrepo corpus — 3 pip dict-literal sites clear, 2 genuinely-dynamic sites stay tainted", async () => {
      const testDir = dirname(fileURLToPath(import.meta.url));
      const root = join(
        testDir,
        "fixtures/python-realrepo/pip/pip/_internal/commands",
      );
      const httpieCore = join(
        testDir,
        "fixtures/python-realrepo/httpie/httpie/manager/core.py",
      );
      const files = {
        index: join(root, "index.py"),
        cache: join(root, "cache.py"),
        configuration: join(root, "configuration.py"),
        commandsInit: join(root, "__init__.py"),
        httpieCore,
      };
      const sources = await Promise.all(
        Object.entries(files).map(async ([key, file]) => ({
          key,
          file,
          text: await readFile(file, "utf8"),
        })),
      );
      const tainted = findTaintedFiles(
        sources.map(({ file, text }) => ({ file, text })),
      );

      expect(tainted.has(files.index)).toBe(false);
      expect(tainted.has(files.cache)).toBe(false);
      expect(tainted.has(files.configuration)).toBe(false);
      // Genuinely dynamic (importlib.import_module + getattr, string keys) — unrelated pattern, untouched by this fix.
      expect(tainted.has(files.commandsInit)).toBe(true);
      // CLI_TASKS is imported from a different file — cross-file resolution is out of scope (see Boundaries).
      expect(tainted.has(files.httpieCore)).toBe(true);
    });
  });
});
