import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-py-merge-"));
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

describe("buildReachabilityModel — mixed-language merge (AC-5)", () => {
  test("both TS and Python nodes appear in the merged graph with no id collision", async () => {
    const tsFile = await write("src/index.ts", "export function tsFn() { return 1; }\n");
    const pyFile = await write("pkg/mod.py", "def py_fn():\n    pass\n");
    await write("necro.config.json", JSON.stringify({ include: ["**/*.ts", "**/*.py"] }));
    const config = { ...DEFAULT_CONFIG, include: ["**/*.ts", "**/*.py"] };

    const model = await buildReachabilityModel(dir, config);
    const names = model.graph.nodes.map((n) => n.name).sort();
    expect(names).toContain("tsFn");
    expect(names).toContain("py_fn");

    const ids = model.graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no collisions

    const tsNode = model.graph.nodes.find((n) => n.name === "tsFn");
    const pyNode = model.graph.nodes.find((n) => n.name === "py_fn");
    expect(tsNode?.file).toBe(tsFile);
    expect(pyNode?.file).toBe(pyFile);
  });

  test("a Python-only target still produces a valid model with no TS files", async () => {
    await write("mod.py", "def only_py():\n    pass\n");
    const config = { ...DEFAULT_CONFIG, include: ["**/*.py"] };
    const model = await buildReachabilityModel(dir, config);
    expect(model.graph.nodes.some((n) => n.name === "only_py")).toBe(true);
  });

  test("a .php file does not crash the ts-morph graph and contributes zero nodes (Phase A: no PHP dead-code claims yet)", async () => {
    // Discovered empirically during phase 72-01's manual spot-check: before
    // this fix, model.ts's tsFiles filter was `!isPythonFile(f)`, which left
    // .php files routed into buildSymbolGraphCached (ts-morph) — ts-morph
    // cannot open a .php path, so buildReachabilityModel threw
    // "Could not find source file" for any config that included PHP. This is
    // a narrow, deliberate exception to this draft's own "do not touch
    // model.ts" boundary: PHP's syntactic axis (complexity/dup/hotspots,
    // this phase's actual scope) is unusable end-to-end via the real `scan()`
    // entry point without it, since scan() always builds the reachability
    // model first (src/engine/index.ts:56) regardless of the complexity-axis
    // flag. The fix excludes .php from ts-morph the same way Python already
    // is — it does NOT build a real PHP symbol graph (that's Phase C).
    const tsFile = await write("src/index.ts", "export function tsFn() { return 1; }\n");
    // Realistic PHP class shape — a bare `function phpFn(){}` snippet doesn't
    // reproduce the crash (TS's parser error-recovers past the `<?php` line
    // and finds nothing declaration-shaped to index); a `class`/`namespace`
    // body is close enough to valid TS syntax that ts-morph's lenient parser
    // extracts real-looking declarations and then crashes trying to resolve
    // references against them. Matches the actual spot-check repro.
    const phpFile = await write(
      "src/Calculator.php",
      "<?php\nnamespace App;\n\nclass Calculator {\n    public function classify(int $x): string {\n        return 'one';\n    }\n}\n",
    );
    const config = { ...DEFAULT_CONFIG, include: ["**/*.ts", "**/*.php"] };

    const model = await buildReachabilityModel(dir, config);
    const names = model.graph.nodes.map((n) => n.name);
    expect(names).toContain("tsFn");
    expect(model.graph.nodes.some((n) => n.file === phpFile)).toBe(false);
    expect(model.graph.nodes.some((n) => n.file === tsFile)).toBe(true);
  });
});
