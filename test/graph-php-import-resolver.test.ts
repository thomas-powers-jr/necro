import { describe, expect, test } from "vitest";
import { resolvePhpClassReference } from "../src/graph/php/resolve-import.js";

describe("resolvePhpClassReference (AC-3)", () => {
  test("leading-backslash name is always fully qualified, regardless of namespace or imports", () => {
    const map = new Map([["Foo\\Bar", "/repo/src/Foo/Bar.php"]]);
    const result = resolvePhpClassReference("\\Foo\\Bar", "App\\Models", [], map);
    expect(result).toEqual({ fqcn: "Foo\\Bar", file: "/repo/src/Foo/Bar.php" });
  });

  test("unqualified name with no matching import: qualified by the current namespace, no global fallback", () => {
    const map = new Map([["App\\Models\\Foo", "/repo/src/Models/Foo.php"]]);
    const result = resolvePhpClassReference("Foo", "App\\Models", [], map);
    expect(result).toEqual({ fqcn: "App\\Models\\Foo", file: "/repo/src/Models/Foo.php" });
  });

  test("unqualified name matching a `use` import's local name resolves via that import (the common real-world pattern)", () => {
    const map = new Map([["App\\Models\\User", "/repo/src/Models/User.php"]]);
    const imports = [{ localName: "User", fqcn: "App\\Models\\User", kind: "class" as const }];
    const result = resolvePhpClassReference("User", "App\\Http\\Controllers", imports, map);
    expect(result).toEqual({ fqcn: "App\\Models\\User", file: "/repo/src/Models/User.php" });
  });

  test("qualified relative name whose first segment matches an import: substitutes the import's FQCN, keeps the remainder", () => {
    const map = new Map([["App\\Sub\\Foo", "/repo/src/Sub/Foo.php"]]);
    const imports = [{ localName: "Sub", fqcn: "App\\Sub", kind: "class" as const }];
    const result = resolvePhpClassReference("Sub\\Foo", "App\\Other", imports, map);
    expect(result).toEqual({ fqcn: "App\\Sub\\Foo", file: "/repo/src/Sub/Foo.php" });
  });

  test("qualified relative name whose first segment matches no import: resolves relative to the current namespace", () => {
    const map = new Map([["App\\Other\\Sub\\Foo", "/repo/src/Other/Sub/Foo.php"]]);
    const result = resolvePhpClassReference("Sub\\Foo", "App\\Other", [], map);
    expect(result).toEqual({ fqcn: "App\\Other\\Sub\\Foo", file: "/repo/src/Other/Sub/Foo.php" });
  });

  test("function/const imports never satisfy a class-reference match, even with the same local name", () => {
    const map = new Map<string, string>();
    const imports = [{ localName: "User", fqcn: "App\\Helpers\\User", kind: "function" as const }];
    const result = resolvePhpClassReference("User", "App\\Models", imports, map);
    expect(result.fqcn).toBe("App\\Models\\User");
  });

  test("unresolvable reference (a PHP built-in with no local declaration) returns a computed FQCN with `file: null`", () => {
    const map = new Map<string, string>();
    const result = resolvePhpClassReference("Exception", "App\\Models", [], map);
    expect(result).toEqual({ fqcn: "App\\Models\\Exception", file: null });
  });

  test("unresolvable reference outside this repo's own autoload map (e.g. a vendor dependency) returns `file: null`", () => {
    const map = new Map([["App\\Models\\User", "/repo/src/Models/User.php"]]);
    const result = resolvePhpClassReference("\\Some\\Vendor\\Package", "App\\Models", [], map);
    expect(result).toEqual({ fqcn: "Some\\Vendor\\Package", file: null });
  });

  test("global namespace (empty current namespace): unqualified name with no import resolves to itself", () => {
    const map = new Map([["Foo", "/repo/Foo.php"]]);
    const result = resolvePhpClassReference("Foo", "", [], map);
    expect(result).toEqual({ fqcn: "Foo", file: "/repo/Foo.php" });
  });
});
