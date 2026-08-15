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

  test("a .php file does not crash the ts-morph graph and contributes real graph nodes (phase 75: PHP symbol graph)", async () => {
    // Discovered empirically during phase 72-01's manual spot-check: before
    // that fix, model.ts's tsFiles filter was `!isPythonFile(f)`, which left
    // .php files routed into buildSymbolGraphCached (ts-morph) — ts-morph
    // cannot open a .php path, so buildReachabilityModel threw
    // "Could not find source file" for any config that included PHP. `.php`
    // is still excluded from `tsFiles` (same crash hazard, still real), but
    // as of phase 75 it is no longer a zero-node no-op: `.php` files are fed
    // through their own hand-rolled pipeline (`buildPhpSymbolGraph` +
    // `buildPhpReferenceEdges`, T1/T2) instead, the same way `.py` already
    // is via its own pipeline. This test was updated in place (not left as a
    // regression) because "PHP contributes zero nodes" was this exact test's
    // premise, and that premise is precisely what phase 75 (T3) changes.
    const tsFile = await write("src/index.ts", "export function tsFn() { return 1; }\n");
    // Realistic PHP class shape — a bare `function phpFn(){}` snippet doesn't
    // reproduce the ts-morph crash (TS's parser error-recovers past the
    // `<?php` line and finds nothing declaration-shaped to index); a
    // `class`/`namespace` body is close enough to valid TS syntax that
    // ts-morph's lenient parser extracts real-looking declarations and then
    // crashes trying to resolve references against them. Matches the actual
    // spot-check repro, and also gives the PHP pipeline a real method node.
    const phpFile = await write(
      "src/Calculator.php",
      "<?php\nnamespace App;\n\nclass Calculator {\n    public function classify(int $x): string {\n        return 'one';\n    }\n}\n",
    );
    const config = { ...DEFAULT_CONFIG, include: ["**/*.ts", "**/*.php"] };

    const model = await buildReachabilityModel(dir, config);
    const names = model.graph.nodes.map((n) => n.name);
    expect(names).toContain("tsFn");
    // PHP no longer contributes zero graph nodes as of this phase (AC-1).
    expect(model.graph.nodes.some((n) => n.file === phpFile)).toBe(true);
    expect(
      model.graph.nodes.find((n) => n.file === phpFile && n.name === "classify"),
    ).toEqual({
      id: `${phpFile}:5:classify`,
      name: "classify",
      file: phpFile,
      line: 5,
      exported: true,
    });
    expect(model.graph.nodes.some((n) => n.file === tsFile)).toBe(true);
  });
});
