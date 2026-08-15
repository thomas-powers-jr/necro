import { describe, expect, test } from "vitest";
import { extractDeclaredSymbols } from "../src/graph/php/declared-symbols.js";

describe("extractDeclaredSymbols (AC-1)", () => {
  test("a single namespaced class declaration", async () => {
    const source = `<?php
namespace App\\Models;

class User {}
`;
    const symbols = await extractDeclaredSymbols("/repo/src/Models/User.php", source);
    expect(symbols).toEqual([
      { fqcn: "App\\Models\\User", kind: "class", file: "/repo/src/Models/User.php", methods: [], properties: [] },
    ]);
  });

  test("interface, trait, and enum declarations, all four kinds in one file", async () => {
    const source = `<?php
namespace App\\Contracts;

interface Renderable {}
trait Sortable {}
enum Status { case Active; case Inactive; }
class User implements Renderable {
  use Sortable;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "App\\Contracts\\Renderable", kind: "interface", file: "/repo/x.php", methods: [], properties: [] },
      { fqcn: "App\\Contracts\\Sortable", kind: "trait", file: "/repo/x.php", methods: [], properties: [] },
      { fqcn: "App\\Contracts\\Status", kind: "enum", file: "/repo/x.php", methods: [], properties: [] },
      {
        fqcn: "App\\Contracts\\User",
        kind: "class",
        file: "/repo/x.php",
        methods: [],
        properties: [],
      },
    ]);
  });

  test("no namespace declaration: FQCN is the bare class name (global namespace)", async () => {
    const source = `<?php
class GlobalThing {}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "GlobalThing", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
    ]);
  });

  test("a plain top-level function declaration is excluded (composer classmap never autoloads bare functions)", async () => {
    const source = `<?php
namespace App;

function helper() {}
class Real {}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "App\\Real", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
    ]);
  });

  test("braced namespace blocks scope declarations to their own body, including anonymous global `namespace { ... }`", async () => {
    const source = `<?php
namespace App\\Models {
  class User {}
}
namespace {
  class GlobalThing {}
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "App\\Models\\User", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
      { fqcn: "GlobalThing", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
    ]);
  });

  test("a class declared conditionally (polyfill pattern) is still found, nested inside an if-block", async () => {
    const source = `<?php
namespace App;

if (!class_exists('Polyfill')) {
  class Polyfill {}
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "App\\Polyfill", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
    ]);
  });

  test("a braceless namespace applies to subsequent siblings only, not declarations before it (invalid PHP in practice, but the walk must not retroactively apply it)", async () => {
    const source = `<?php
namespace First;
class A {}
namespace Second;
class B {}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      { fqcn: "First\\A", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
      { fqcn: "Second\\B", kind: "class", file: "/repo/x.php", methods: [], properties: [] },
    ]);
  });
});

describe("extractDeclaredSymbols — method and property extraction (75-01 AC-1)", () => {
  test("methods (name+line) are extracted from a class's own declaration_list", async () => {
    const source = `<?php
class User {
  public function getName() {
    return $this->name;
  }

  private function helper() {}
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "User",
        kind: "class",
        file: "/repo/x.php",
        methods: [
          { name: "getName", line: 3 },
          { name: "helper", line: 7 },
        ],
        properties: [],
      },
    ]);
  });

  test("a class-typed property (named_type) captures the class name as its declared type; an untyped property does not", async () => {
    const source = `<?php
class Order {
  public Customer $customer;
  protected $untyped;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Order",
        kind: "class",
        file: "/repo/x.php",
        methods: [],
        properties: [
          { name: "customer", line: 3, declaredType: "Customer" },
          { name: "untyped", line: 4 },
        ],
      },
    ]);
  });

  test("a scalar-typed property is `primitive_type`, not `named_type` — grammar fact live-verified against tree-sitter-php.wasm, not assumed — so no declaredType is captured", async () => {
    const source = `<?php
class User {
  public string $name;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "User",
        kind: "class",
        file: "/repo/x.php",
        methods: [],
        properties: [{ name: "name", line: 3 }],
      },
    ]);
  });

  test("nullable (optional_type) and union-typed properties do not count as a `named_type` field, so no declaredType is captured", async () => {
    const source = `<?php
class Thing {
  public ?Baz $baz;
  public int|string $union;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Thing",
        kind: "class",
        file: "/repo/x.php",
        methods: [],
        properties: [
          { name: "baz", line: 3 },
          { name: "union", line: 4 },
        ],
      },
    ]);
  });

  test("multiple property_element children on one property_declaration statement are each their own property, sharing the declared type", async () => {
    const source = `<?php
class Point {
  public Coordinate $x, $y;
  public $a, $b;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Point",
        kind: "class",
        file: "/repo/x.php",
        methods: [],
        properties: [
          { name: "x", line: 3, declaredType: "Coordinate" },
          { name: "y", line: 3, declaredType: "Coordinate" },
          { name: "a", line: 4 },
          { name: "b", line: 4 },
        ],
      },
    ]);
  });

  test("interface method declarations (no body) are still extracted (name+line)", async () => {
    const source = `<?php
interface Renderable {
  public function render(): string;
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Renderable",
        kind: "interface",
        file: "/repo/x.php",
        methods: [{ name: "render", line: 3 }],
        properties: [],
      },
    ]);
  });

  test("trait methods and properties are extracted the same as a class's", async () => {
    const source = `<?php
trait Sortable {
  protected $order;
  public function sort() {}
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Sortable",
        kind: "trait",
        file: "/repo/x.php",
        methods: [{ name: "sort", line: 4 }],
        properties: [{ name: "order", line: 3 }],
      },
    ]);
  });

  test("enum methods are extracted from its own enum_declaration_list body (not a declaration_list — grammar fact verified live against tree-sitter-php.wasm, not assumed)", async () => {
    const source = `<?php
enum Status {
  case Active;
  case Inactive;

  public function label(): string {
    return "x";
  }
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Status",
        kind: "enum",
        file: "/repo/x.php",
        methods: [{ name: "label", line: 6 }],
        properties: [],
      },
    ]);
  });

  test("a `base_clause`/`class_interface_clause` (extends/implements) and `abstract`, and an enum's backed-type/implements clause, don't displace the `body:` field member extraction hinges on — live-verified, not assumed", async () => {
    const source = `<?php
abstract class Repo extends Base implements Countable {
  public readonly Customer $customer;
  public function find() {}
}

enum Status: string implements HasLabel {
  case Active = 'a';
  public function label(): string { return 'x'; }
}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([
      {
        fqcn: "Repo",
        kind: "class",
        file: "/repo/x.php",
        methods: [{ name: "find", line: 4 }],
        properties: [{ name: "customer", line: 3, declaredType: "Customer" }],
      },
      {
        fqcn: "Status",
        kind: "enum",
        file: "/repo/x.php",
        methods: [{ name: "label", line: 9 }],
        properties: [],
      },
    ]);
  });
});
