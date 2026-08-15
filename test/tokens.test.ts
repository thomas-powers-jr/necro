import { describe, expect, test } from "vitest";
import { tokenize } from "../src/syntactic/tokens.js";

describe("tokenize (AC-1)", () => {
  test("renamed identifiers and changed literals normalize to the same stream", async () => {
    const a = await tokenize("/a.ts", "const total = price * 2;\n");
    const b = await tokenize("/b.ts", "const sum = cost * 99;\n");
    expect(a.map((t) => t.norm)).toEqual(b.map((t) => t.norm));
    expect(a.map((t) => t.norm)).toContain("ID");
    expect(a.map((t) => t.norm)).toContain("LIT");
  });

  test("comments produce no tokens", async () => {
    const withComment = await tokenize("/c.ts", "// a comment\nconst x = 1;\n");
    const without = await tokenize("/d.ts", "const x = 1;\n");
    expect(withComment.map((t) => t.norm)).toEqual(without.map((t) => t.norm));
  });

  test("keywords and punctuation are preserved by kind", async () => {
    const toks = (await tokenize("/e.ts", "if (x) {}\n")).map((t) => t.norm);
    expect(toks).toContain("if");
    expect(toks).toContain("{");
  });

  test("structurally different code yields different streams", async () => {
    const a = (await tokenize("/f.ts", "const x = 1;\n")).map((t) => t.norm);
    const b = (await tokenize("/g.ts", "function f() { return 1; }\n")).map((t) => t.norm);
    expect(a).not.toEqual(b);
  });
});

describe("tokenize — Python (AC-3)", () => {
  test("renamed identifiers and changed literals normalize to the same stream", async () => {
    const a = await tokenize("/a.py", "def f(a, b):\n    return a + b * 2\n");
    const b = await tokenize("/b.py", "def g(x, y):\n    return x + y * 9\n");
    expect(a.map((t) => t.norm)).toEqual(b.map((t) => t.norm));
    expect(a.map((t) => t.norm)).toContain("ID");
    expect(a.map((t) => t.norm)).toContain("LIT");
  });

  test("comments produce no tokens", async () => {
    const withComment = await tokenize("/c.py", "# a comment\nx = 1\n");
    const without = await tokenize("/d.py", "x = 1\n");
    expect(withComment.map((t) => t.norm)).toEqual(without.map((t) => t.norm));
  });

  test("integers, floats, and string content all normalize to LIT", async () => {
    const toks = (await tokenize("/e.py", 'x = 1\ny = 3.14\ns = "hi"\n')).map((t) => t.norm);
    // ID = LIT / ID = LIT / ID = <string open> LIT <string close>
    expect(toks.filter((t) => t === "LIT")).toHaveLength(3);
  });

  test("None stays its own kind, not folded into LIT (matches JS's null treatment)", async () => {
    const toks = (await tokenize("/n.py", "x = None\n")).map((t) => t.norm);
    expect(toks).toContain("none");
    expect(toks.filter((t) => t === "LIT")).toHaveLength(0);
  });
});

describe("tokenize — PHP (AC-5)", () => {
  test("renamed identifiers and changed literals normalize to the same stream", async () => {
    const a = await tokenize("/a.php", "<?php\nfunction f($a, $b) {\n    return $a + $b * 2;\n}\n");
    const b = await tokenize("/b.php", "<?php\nfunction g($x, $y) {\n    return $x + $y * 9;\n}\n");
    expect(a.map((t) => t.norm)).toEqual(b.map((t) => t.norm));
    expect(a.map((t) => t.norm)).toContain("ID");
    expect(a.map((t) => t.norm)).toContain("LIT");
  });

  test("comments produce no tokens (//, #, and /* */ forms)", async () => {
    const withSlash = await tokenize("/c1.php", "<?php\n// a comment\n$x = 1;\n");
    const withHash = await tokenize("/c2.php", "<?php\n# a comment\n$x = 1;\n");
    const withBlock = await tokenize("/c3.php", "<?php\n/* a comment */\n$x = 1;\n");
    const without = await tokenize("/d.php", "<?php\n$x = 1;\n");
    expect(withSlash.map((t) => t.norm)).toEqual(without.map((t) => t.norm));
    expect(withHash.map((t) => t.norm)).toEqual(without.map((t) => t.norm));
    expect(withBlock.map((t) => t.norm)).toEqual(without.map((t) => t.norm));
  });

  test("integers, floats, and single/double-quoted string content all normalize to LIT", async () => {
    const toks = (
      await tokenize("/e.php", "<?php\n$x = 1;\n$y = 3.14;\n$s = 'hi';\n$t = \"hi\";\n")
    ).map((t) => t.norm);
    expect(toks.filter((t) => t === "LIT")).toHaveLength(4);
  });

  test("boolean literals normalize to LIT (matches JS's true/false folding)", async () => {
    const toks = (await tokenize("/bool.php", "<?php\n$x = true;\n$y = false;\n")).map(
      (t) => t.norm,
    );
    expect(toks.filter((t) => t === "LIT")).toHaveLength(2);
  });

  test("null stays its own kind, not folded into LIT (matches JS's/Python's null/None treatment)", async () => {
    const toks = (await tokenize("/n.php", "<?php\n$x = null;\n")).map((t) => t.norm);
    expect(toks).toContain("null");
    expect(toks.filter((t) => t === "LIT")).toHaveLength(0);
  });

  test("a variable's $ sigil is its own token kind, not folded into ID or LIT, exactly once per variable reference", async () => {
    const toks = (await tokenize("/dollar.php", "<?php\n$x = $y + $z;\n")).map((t) => t.norm);
    // three variable references ($x, $y, $z) — exactly three "$" tokens, not
    // folded into ID/LIT and not duplicated per reference.
    expect(toks.filter((t) => t === "$")).toHaveLength(3);
  });

  test("function, class, method, and variable names all normalize to ID via the shared `name` node", async () => {
    const toks = (
      await tokenize("/names.php", "<?php\nclass Foo {\n    public function bar($baz) {}\n}\n")
    ).map((t) => t.norm);
    expect(toks.filter((t) => t === "ID").length).toBeGreaterThanOrEqual(3); // Foo, bar, baz
  });
});
