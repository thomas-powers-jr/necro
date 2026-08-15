import { describe, expect, test } from "vitest";
import { lowerSource } from "../src/syntactic/ir.js";

describe("lowerSource (AC-1)", () => {
  test("lowers a function to name, line, loc, params, and control nodes with depth", async () => {
    const src = [
      "function f(a, b, c) {", // line 1
      "  if (a) {", //            depth 0 branch
      "    for (const x of b) {", // depth 1 loop
      "      while (x) {", //       depth 2 loop
      "        c();", //
      "      }", //
      "    }", //
      "  }", //
      "}", //                    line 9
    ].join("\n");

    const [unit] = await lowerSource("/x.ts", src);

    expect(unit?.name).toBe("f");
    expect(unit?.line).toBe(1);
    expect(unit?.loc).toBe(9);
    expect(unit?.params).toBe(3);

    const depths = unit!.controlNodes.map((c) => c.depth).sort();
    expect(depths).toEqual([0, 1, 2]); // if@0, for@1, while@2
    expect(unit!.controlNodes.every((c) => c.nests)).toBe(true);
  });

  test("records short-circuit operators as non-nesting boolean nodes", async () => {
    const [unit] = await lowerSource("/y.ts", "function g(a, b) {\n  return a && b || a;\n}\n");
    const booleans = unit!.controlNodes.filter((c) => c.category === "boolean");
    expect(booleans.length).toBeGreaterThanOrEqual(2);
    expect(booleans.every((c) => c.nests === false)).toBe(true);
  });

  test("nested functions are separate units, not folded into the parent", async () => {
    const units = await lowerSource("/z.ts", "function outer() {\n  function inner() {}\n}\n");
    expect(units.map((u) => u.name).sort()).toEqual(["inner", "outer"]);
  });

  test("a .jsx file with conditional JSX rendering parses via the tsx grammar and finds both a boolean (&&) and a ternary control node (AC-2)", async () => {
    // Regression guard: the plain `typescript` grammar mis-parses `<span>` as a
    // type assertion and swallows the ternary entirely (confirmed manually —
    // before the tsx-grammar dispatch fix this test found only the `boolean`
    // node, never `ternary`).
    const src = [
      "export function Panel({ show, name }) {", // line 1
      "  return (",
      '    <div className="panel">',
      "      {show && <span>{name}</span>}",
      "      {show ? <strong>{name}</strong> : null}",
      "    </div>",
      "  );",
      "}",
    ].join("\n");

    const [unit] = await lowerSource("/panel.jsx", src);
    const categories = unit!.controlNodes.map((c) => c.category).sort();
    expect(categories).toEqual(["boolean", "ternary"]);
  });
});

describe("lowerSource — Python (AC-2)", () => {
  test("an if/elif/elif/else chain counts each elif as its own branch, not collapsed or double-counted", async () => {
    const src = [
      "def classify(x):", // line 1
      "    if x == 1:",
      "        return 'one'",
      "    elif x == 2:",
      "        return 'two'",
      "    elif x == 3:",
      "        return 'three'",
      "    else:",
      "        return 'other'",
    ].join("\n");

    const [unit] = await lowerSource("/classify.py", src);
    const branches = unit!.controlNodes.filter((c) => c.category === "branch");
    // one `if_statement` + two `elif_clause` = 3 branch nodes. Python's grammar
    // holds every `elif_clause` as a direct sibling child of the *same*
    // `if_statement` node (unlike JS's `else if`, which the JS grammar
    // represents as a genuinely nested `if` inside the previous one's
    // `alternative` — confirmed by probing this codebase's existing JS
    // else-if handling, which produces depths [0,1,2]). So the `if_statement`
    // itself is depth 0, and both `elif_clause`s land at depth 1 (children of
    // that one if_statement) — not progressively deeper. This is a correct
    // reflection of Python's flatter elif structure, not a mapping bug.
    expect(branches).toHaveLength(3);
    expect(branches.map((b) => b.depth).sort()).toEqual([0, 1, 1]);
  });

  test("and/or lower to non-nesting boolean nodes; not lowers to nothing (matches JS's unary ! treatment)", async () => {
    const [unit] = await lowerSource(
      "/bools.py",
      "def f(a, b):\n    return a and b or not a\n",
    );
    const booleans = unit!.controlNodes.filter((c) => c.category === "boolean");
    expect(booleans.length).toBeGreaterThanOrEqual(2);
    expect(booleans.every((c) => c.nests === false)).toBe(true);
  });

  test("a conditional expression (ternary) lowers to a nesting ternary node", async () => {
    const [unit] = await lowerSource("/tern.py", "def f(a, b):\n    return a if b else b\n");
    const ternaries = unit!.controlNodes.filter((c) => c.category === "ternary");
    expect(ternaries).toHaveLength(1);
    expect(ternaries[0]!.nests).toBe(true);
  });

  test("for/while lower to loop; except lowers to catch; match/case lowers to case", async () => {
    const src = [
      "def f(a):", // line 1
      "    for x in range(a):", // loop @0
      "        while x > 0:", //     loop @1
      "            x -= 1",
      "    try:",
      "        pass",
      "    except ValueError:", //   catch @0
      "        pass",
      "    match a:",
      "        case 1:", //          case @1 (inside match_statement's block)
      "            pass",
    ].join("\n");

    const [unit] = await lowerSource("/ctrl.py", src);
    const categories = unit!.controlNodes.map((c) => c.category).sort();
    expect(categories).toEqual(["case", "catch", "loop", "loop"]);
  });

  test("a comprehension's for/if clauses lower to loop/branch", async () => {
    const [unit] = await lowerSource(
      "/comp.py",
      "def f(a):\n    return [i for i in range(a) if i > 5]\n",
    );
    const categories = unit!.controlNodes.map((c) => c.category).sort();
    expect(categories).toEqual(["branch", "loop"]);
  });

  test("function_definition (incl. async def and methods) and lambda are recognized as function units", async () => {
    const src = [
      "class Foo:",
      "    def method(self, x):",
      "        return x",
      "",
      "async def bar():",
      "    pass",
      "",
      "lam = lambda x: x + 1",
    ].join("\n");

    const units = await lowerSource("/units.py", src);
    expect(units.map((u) => u.name).sort()).toEqual(["(anonymous)", "bar", "method"]);
  });

  test("a decorated function is still found by the recursive walk (decorated_definition wraps it)", async () => {
    const src = ["@staticmethod", "def helper(a):", "    return a"].join("\n");
    const units = await lowerSource("/deco.py", src);
    expect(units.map((u) => u.name)).toEqual(["helper"]);
  });
});

describe("lowerSource — PHP (AC-2, AC-3, AC-4)", () => {
  test("an if/elseif/elseif/else chain counts each elseif as its own branch, not collapsed or double-counted", async () => {
    const src = `<?php
function classify($x) {
    if ($x == 1) {
        return 'one';
    } elseif ($x == 2) {
        return 'two';
    } elseif ($x == 3) {
        return 'three';
    } else {
        return 'other';
    }
}
`;
    const [unit] = await lowerSource("/classify.php", src);
    const branches = unit!.controlNodes.filter((c) => c.category === "branch");
    // Same shape as Python's elif: PHP's `else_if_clause` is a sibling
    // `alternative:` clause of the same `if_statement`, not a nested if.
    expect(branches).toHaveLength(3);
  });

  test("&&/||/?? lower to non-nesting boolean nodes", async () => {
    const [unit] = await lowerSource(
      "/bools_symbol.php",
      "<?php\nfunction f($a, $b) {\n    return ($a && $b) || ($a ?? $b);\n}\n",
    );
    const booleans = unit!.controlNodes.filter((c) => c.category === "boolean");
    // `&&` x1, `||` x1, `??` x1 = 3
    expect(booleans).toHaveLength(3);
    expect(booleans.every((c) => c.nests === false)).toBe(true);
  });

  test("word-form and/or/xor lower to non-nesting boolean nodes, isolated from any symbol-form operator", async () => {
    const [unit] = await lowerSource(
      "/bools_word.php",
      "<?php\nfunction f($a, $b) {\n    $x = $a and $b;\n    $y = $a or $b;\n    $z = $a xor $b;\n    return $x;\n}\n",
    );
    const booleans = unit!.controlNodes.filter((c) => c.category === "boolean");
    // exactly one `and`, one `or`, one `xor`, no symbol-form operator present
    // at all — this test would fail if and/or/xor weren't recognized, unlike
    // a mixed test where symbol-form operators alone clear a >= threshold.
    expect(booleans).toHaveLength(3);
    expect(booleans.every((c) => c.nests === false)).toBe(true);
  });

  test("a ternary (conditional_expression) lowers to a nesting ternary node", async () => {
    const [unit] = await lowerSource(
      "/tern.php",
      "<?php\nfunction f($a, $b) {\n    return $a ? $a : $b;\n}\n",
    );
    const ternaries = unit!.controlNodes.filter((c) => c.category === "ternary");
    expect(ternaries).toHaveLength(1);
    expect(ternaries[0]!.nests).toBe(true);
  });

  test("foreach/for/while lower to loop; catch lowers to catch; switch case lowers to case", async () => {
    const src = `<?php
function f($items) {
    foreach ($items as $i) {
        while ($i > 0) {
            $i--;
        }
    }
    for ($j = 0; $j < 10; $j++) {
        echo $j;
    }
    try {
        doIt();
    } catch (\\Exception $e) {
        handle($e);
    }
    switch ($items) {
        case 1:
            break;
        default:
            break;
    }
}
`;
    const [unit] = await lowerSource("/ctrl.php", src);
    const categories = unit!.controlNodes.map((c) => c.category).sort();
    // 3 loops (foreach/while/for), 1 catch, 1 case — the switch's `default:`
    // does NOT count, mirroring the pre-existing switch_case/default_clause
    // asymmetry already established for JS/Python (no default case at all).
    expect(categories).toEqual(["case", "catch", "loop", "loop", "loop"]);
  });

  test("match arms count as case (each arm is a genuine decision point, mirroring switch's case_statement); the default arm does not (mirrors switch's uncounted default)", async () => {
    const src = `<?php
function f($n) {
    return match($n) {
        1, 2 => 'a',
        3 => 'b',
        default => 'c',
    };
}
`;
    const [unit] = await lowerSource("/match.php", src);
    const cases = unit!.controlNodes.filter((c) => c.category === "case");
    expect(cases).toHaveLength(2);
  });

  test("function_definition, method_declaration, anonymous_function_creation_expression, and arrow_function are all recognized as function units", async () => {
    const src = `<?php
class Foo {
    public function method($x) {
        return $x;
    }
}

$closure = function($x) use ($n) { return $x + $n; };
$arrow = fn($x) => $x * 2;

function top($a, $b = 1) {
    return $a + $b;
}
`;
    const units = await lowerSource("/units.php", src);
    expect(units.map((u) => u.name).sort()).toEqual([
      "(anonymous)",
      "(anonymous)",
      "method",
      "top",
    ]);
  });

  test("constructor property promotion params count toward params like any other parameter", async () => {
    const src = `<?php
class Point {
    public function __construct(private float $x, private float $y = 0.0) {}
}
`;
    const [unit] = await lowerSource("/point.php", src);
    expect(unit!.params).toBe(2);
  });
});
