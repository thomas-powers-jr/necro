import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-merge-"));
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

const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

describe("buildReachabilityModel — PHP symbol graph merge (75-01 T3, AC-1)", () => {
  test("a PHP-only target produces non-zero graph.nodes (Phase A's zero-node no-op is gone)", async () => {
    const file = await write(
      "src/Calculator.php",
      [
        "<?php",
        "namespace App;",
        "",
        "class Calculator {",
        "    public function classify(int $x): string {",
        "        return 'one';",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);

    expect(model.graph.nodes.length).toBeGreaterThan(0);
    expect(model.graph.nodes).toEqual([
      { id: `${file}:5:classify`, name: "classify", file, line: 5, exported: true },
    ]);

    // Deliberate, documented interim state (not a bug): PHP entry-point
    // resolution (composer `bin`/`public/index.php`/PHPUnit conventions) is
    // T4's job, not this task's — so a PHP-only target resolves zero prod
    // entries even though the graph now has real nodes. Before this task,
    // `collapsed` was `false` here (`graphHasNodes` was false too, since PHP
    // contributed no nodes at all — see `EntryResolution`'s own `collapsed`
    // formula, `out.length === 0 && graphHasNodes`). Now that PHP nodes are
    // real, this correctly flips to `true`: the same fail-closed diagnostic
    // TS/Python already rely on when reachability is unseeded. Pinned here so
    // T4 has a signal for when PHP entries start resolving and this flips
    // back to `false`.
    expect(model.entryResolution).toEqual({
      prodEntryCount: 0,
      sources: [],
      collapsed: true,
    });
  });

  test("T1 nodes + T2 edges both land in the merged graph: a composer-autoload-resolved method call produces a real SymbolEdge", async () => {
    await write(
      "composer.json",
      JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
    );
    const fooFile = await write(
      "src/Foo.php",
      [
        "<?php",
        "namespace App;",
        "",
        "class Foo {",
        "    public function used() {",
        "        return 1;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const barFile = await write(
      "src/Bar.php",
      [
        "<?php",
        "namespace App;",
        "",
        "class Bar {",
        "    public function run(Foo $f) {",
        "        $f->used();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);

    // Both classes' methods are nodes.
    const usedNode = model.graph.nodes.find(
      (n) => n.file === fooFile && n.name === "used",
    );
    const runNode = model.graph.nodes.find(
      (n) => n.file === barFile && n.name === "run",
    );
    expect(usedNode).toBeDefined();
    expect(runNode).toBeDefined();

    // The composer-autoload-resolved call from Bar::run to Foo::used is a
    // real edge in the merged graph.edges — proof T2's `classToFile` (built
    // via `readComposerManifest` + `buildComposerAutoloadMap`, this task's
    // wiring) actually reached `buildPhpReferenceEdges`, not just T1's nodes.
    expect(model.graph.edges).toContainEqual({
      from: runNode?.id,
      to: usedNode?.id,
      kind: "prod",
    });
  });

  test("a PHP file mixed with a TS file: TS behavior is unaffected by the PHP pipeline running alongside it", async () => {
    const tsFile = await write("src/index.ts", "export function tsFn() { return 1; }\n");
    const phpFile = await write(
      "src/Widget.php",
      "<?php\nclass Widget {\n    public function render() { return 'x'; }\n}\n",
    );
    const mixedConfig = { ...DEFAULT_CONFIG, include: ["**/*.ts", "**/*.php"] };

    const model = await buildReachabilityModel(dir, mixedConfig);

    expect(model.graph.nodes.some((n) => n.file === tsFile && n.name === "tsFn")).toBe(true);
    expect(model.graph.nodes.some((n) => n.file === phpFile && n.name === "render")).toBe(true);
  });
});
