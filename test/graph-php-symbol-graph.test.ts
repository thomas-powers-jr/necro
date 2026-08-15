import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildPhpSymbolGraph } from "../src/graph/php/symbol-graph.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-symgraph-"));
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

describe("buildPhpSymbolGraph — node collection (75-01 AC-1)", () => {
  test("a method becomes a SymbolNode using the `${file}:${line}:${name}` id shape", async () => {
    const file = await write(
      "User.php",
      ["<?php", "class User {", "  public function getName() {", "    return $this->name;", "  }", "}", ""].join(
        "\n",
      ),
    );
    const nodes = await buildPhpSymbolGraph([file]);
    expect(nodes).toEqual([
      { id: `${file}:3:getName`, name: "getName", file, line: 3, exported: true },
    ]);
  });

  test("a typed and an untyped property both become SymbolNodes, hand-computed ids/names/lines", async () => {
    const file = await write(
      "Order.php",
      ["<?php", "class Order {", "  public Customer $customer;", "  protected $untyped;", "}", ""].join("\n"),
    );
    const nodes = await buildPhpSymbolGraph([file]);
    expect(nodes).toEqual([
      { id: `${file}:3:customer`, name: "customer", file, line: 3, exported: true },
      { id: `${file}:4:untyped`, name: "untyped", file, line: 4, exported: true },
    ]);
  });

  test("methods and properties across class, interface, trait, and enum all collect into one flat node list", async () => {
    const file = await write(
      "Mixed.php",
      [
        "<?php",
        "class User {",
        "  public string $name;",
        "  public function getName() { return $this->name; }",
        "}",
        "",
        "interface Renderable {",
        "  public function render(): string;",
        "}",
        "",
        "trait Sortable {",
        "  protected $order;",
        "  public function sort() {}",
        "}",
        "",
        "enum Status {",
        "  case Active;",
        "  public function label(): string { return 'x'; }",
        "}",
        "",
      ].join("\n"),
    );
    const nodes = await buildPhpSymbolGraph([file]);
    expect(nodes.map((n) => ({ name: n.name, line: n.line })).sort((a, b) => a.line - b.line)).toEqual([
      { name: "name", line: 3 },
      { name: "getName", line: 4 },
      { name: "render", line: 8 },
      { name: "order", line: 12 },
      { name: "sort", line: 13 },
      { name: "label", line: 18 },
    ]);
    // Every node id follows the shared `${file}:${line}:${name}` shape and is exported.
    for (const node of nodes) {
      expect(node.id).toBe(`${file}:${node.line}:${node.name}`);
      expect(node.file).toBe(file);
      expect(node.exported).toBe(true);
    }
  });

  test("a class with no methods or properties contributes no nodes", async () => {
    const file = await write("Empty.php", ["<?php", "class Empty1 {}", ""].join("\n"));
    const nodes = await buildPhpSymbolGraph([file]);
    expect(nodes).toEqual([]);
  });

  test("nodes accumulate across multiple files", async () => {
    const fileA = await write(
      "A.php",
      ["<?php", "class A {", "  public function m() {}", "}", ""].join("\n"),
    );
    const fileB = await write(
      "B.php",
      ["<?php", "class B {", "  public function n() {}", "}", ""].join("\n"),
    );
    const nodes = await buildPhpSymbolGraph([fileA, fileB]);
    expect(nodes.map((n) => n.id).sort()).toEqual([`${fileA}:3:m`, `${fileB}:3:n`].sort());
  });
});
