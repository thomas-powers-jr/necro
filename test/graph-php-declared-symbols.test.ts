import { describe, expect, test } from "vitest";
import { extractDeclaredSymbols } from "../src/graph/php/declared-symbols.js";

describe("extractDeclaredSymbols (AC-1)", () => {
  test("a single namespaced class declaration", async () => {
    const source = `<?php
namespace App\\Models;

class User {}
`;
    const symbols = await extractDeclaredSymbols("/repo/src/Models/User.php", source);
    expect(symbols).toEqual([{ fqcn: "App\\Models\\User", kind: "class", file: "/repo/src/Models/User.php" }]);
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
      { fqcn: "App\\Contracts\\Renderable", kind: "interface", file: "/repo/x.php" },
      { fqcn: "App\\Contracts\\Sortable", kind: "trait", file: "/repo/x.php" },
      { fqcn: "App\\Contracts\\Status", kind: "enum", file: "/repo/x.php" },
      { fqcn: "App\\Contracts\\User", kind: "class", file: "/repo/x.php" },
    ]);
  });

  test("no namespace declaration: FQCN is the bare class name (global namespace)", async () => {
    const source = `<?php
class GlobalThing {}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([{ fqcn: "GlobalThing", kind: "class", file: "/repo/x.php" }]);
  });

  test("a plain top-level function declaration is excluded (composer classmap never autoloads bare functions)", async () => {
    const source = `<?php
namespace App;

function helper() {}
class Real {}
`;
    const symbols = await extractDeclaredSymbols("/repo/x.php", source);
    expect(symbols).toEqual([{ fqcn: "App\\Real", kind: "class", file: "/repo/x.php" }]);
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
      { fqcn: "App\\Models\\User", kind: "class", file: "/repo/x.php" },
      { fqcn: "GlobalThing", kind: "class", file: "/repo/x.php" },
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
    expect(symbols).toEqual([{ fqcn: "App\\Polyfill", kind: "class", file: "/repo/x.php" }]);
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
      { fqcn: "First\\A", kind: "class", file: "/repo/x.php" },
      { fqcn: "Second\\B", kind: "class", file: "/repo/x.php" },
    ]);
  });
});
