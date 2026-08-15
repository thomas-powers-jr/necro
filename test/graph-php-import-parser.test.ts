import { describe, expect, test } from "vitest";
import { parsePhpImports } from "../src/graph/php/import-parser.js";

describe("parsePhpImports (AC-2)", () => {
  test("simple qualified use: `use Foo\\Bar;`", async () => {
    const source = `<?php
namespace App;

use Foo\\Bar;
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.namespace).toBe("App");
    expect(result.imports).toEqual([{ localName: "Bar", fqcn: "Foo\\Bar", kind: "class" }]);
  });

  test("single-segment use: `use Foo;` (bare `name`, no `qualified_name` wrapper)", async () => {
    const source = `<?php
use Foo;
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([{ localName: "Foo", fqcn: "Foo", kind: "class" }]);
  });

  test("aliased use: `use Foo\\Bar as Baz;`", async () => {
    const source = `<?php
use Foo\\Bar as Baz;
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([{ localName: "Baz", fqcn: "Foo\\Bar", kind: "class" }]);
  });

  test("grouped use: `use Foo\\Bar\\{Baz, Qux};`", async () => {
    const source = `<?php
use Foo\\Bar\\{Baz, Qux};
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([
      { localName: "Baz", fqcn: "Foo\\Bar\\Baz", kind: "class" },
      { localName: "Qux", fqcn: "Foo\\Bar\\Qux", kind: "class" },
    ]);
  });

  test("grouped use with an aliased clause: `use Foo\\{Bar as X, Baz};`", async () => {
    const source = `<?php
use Foo\\{Bar as X, Baz};
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([
      { localName: "X", fqcn: "Foo\\Bar", kind: "class" },
      { localName: "Baz", fqcn: "Foo\\Baz", kind: "class" },
    ]);
  });

  test("`use function`/`use const` are tagged with the right kind, distinguished from class imports", async () => {
    const source = `<?php
use function App\\Helpers\\format_date;
use const App\\Constants\\MAX_ITEMS;
use App\\Models\\User;
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([
      { localName: "format_date", fqcn: "App\\Helpers\\format_date", kind: "function" },
      { localName: "MAX_ITEMS", fqcn: "App\\Constants\\MAX_ITEMS", kind: "const" },
      { localName: "User", fqcn: "App\\Models\\User", kind: "class" },
    ]);
  });

  test("group-level `use function` prefix applies to every clause in the group", async () => {
    const source = `<?php
use function App\\Helpers\\{format_date, format_time};
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.imports).toEqual([
      { localName: "format_date", fqcn: "App\\Helpers\\format_date", kind: "function" },
      { localName: "format_time", fqcn: "App\\Helpers\\format_time", kind: "function" },
    ]);
  });

  test("no namespace declaration: global namespace (empty string), imports still parsed", async () => {
    const source = `<?php
use Foo\\Bar;
`;
    const result = await parsePhpImports("/repo/x.php", source);
    expect(result.namespace).toBe("");
    expect(result.imports).toEqual([{ localName: "Bar", fqcn: "Foo\\Bar", kind: "class" }]);
  });
});
