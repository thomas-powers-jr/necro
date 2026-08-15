import { describe, expect, test } from "vitest";
import { getParser } from "../src/syntactic/parse.js";

const JSX_SNIPPET = `export function Widget({ name }) {
  if (name) {
    return <div className="widget">{name}</div>;
  }
  return null;
}
`;

describe("getParser (AC-2)", () => {
  test("parses JSX in a .tsx file without error", async () => {
    const parser = await getParser("/comp.tsx");
    const tree = parser.parse(JSX_SNIPPET);
    expect(tree?.rootNode.hasError).toBe(false);
  });

  test("parses JSX in a .jsx file without error", async () => {
    const parser = await getParser("/comp.jsx");
    const tree = parser.parse(JSX_SNIPPET);
    expect(tree?.rootNode.hasError).toBe(false);
  });

  test("still parses plain .ts source without error", async () => {
    const parser = await getParser("/plain.ts");
    const tree = parser.parse("export function f(a: number): number { return a + 1; }\n");
    expect(tree?.rootNode.hasError).toBe(false);
  });

  test("still parses plain .js source without error", async () => {
    const parser = await getParser("/plain.js");
    const tree = parser.parse("export function f(a) { return a + 1; }\n");
    expect(tree?.rootNode.hasError).toBe(false);
  });

  test("parses Python source covering every construct AC-1 lists, without error (AC-1)", async () => {
    const parser = await getParser("/mod.py");
    const src = `def top(a, b=1, *args, **kwargs):
    if a:
        pass
    elif b:
        pass
    for x in range(10):
        while x > 0:
            x -= 1
    try:
        pass
    except ValueError:
        pass
    y = a if b else b
    z = a and b or not a
    result = [i for i in range(10) if i > 5]
    match a:
        case 1:
            pass
        case _:
            pass

class Foo:
    def method(self, x):
        return x

async def bar():
    pass

lam = lambda x: x + 1
`;
    const tree = parser.parse(src);
    expect(tree?.rootNode.hasError).toBe(false);
  });

  test("parses PHP source covering every construct AC-1 lists, without error (AC-1)", async () => {
    const parser = await getParser("/mod.php");
    const src = `<?php
namespace Foo\\Bar;

use Foo\\Bar\\Baz;

interface Shape { public function area(): float; }
trait Greet { public function hello() { echo "hi"; } }

class Point implements Shape {
    public function __construct(private float $x, private float $y = 0.0) {}

    public function area(): float {
        if ($this->x) {
            return $this->x;
        } elseif ($this->y) {
            return $this->y;
        } else {
            return 0.0;
        }
    }

    public static function doIt(int $n): int {
        $total = 0;
        foreach (range(1, $n) as $i) {
            $total += $i;
        }
        for ($j = 0; $j < $n; $j++) {
            $total++;
        }
        while ($total > 1000) {
            $total--;
        }
        switch ($n) {
            case 1:
                break;
            default:
                break;
        }
        $y = match($n) {
            1, 2 => 'a',
            default => 'b',
        };
        try {
            $total += 1;
        } catch (\\Exception $e) {
            $total = 0;
        } finally {
            echo "done";
        }
        $t = $total ? $total : 0;
        $ok = $total && $n || $total and $n or !$n;
        return $total;
    }
}

$c = function($x) use ($n) { return $x + $n; };
$a = fn($x) => $x * 2;

function top($a, $b = 1) {
    return $a + $b;
}
`;
    const tree = parser.parse(src);
    expect(tree?.rootNode.hasError).toBe(false);
  });
});
