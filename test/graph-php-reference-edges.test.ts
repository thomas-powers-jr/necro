import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildPhpReferenceEdges } from "../src/graph/php/reference-edges.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-refedges-"));
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

describe("buildPhpReferenceEdges (75-01 AC-2)", () => {
  test("typed-parameter call: $param->method() resolves to the param type's method node", async () => {
    const customer = await write(
      "Customer.php",
      ["<?php", "class Customer {", "  public function charge() {}", "}", ""].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function run(Customer $c) {",
        "    $c->charge();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Customer", customer],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([customer, service], classToFile);
    expect(edges).toEqual([
      { from: `${service}:3:run`, to: `${customer}:3:charge`, kind: "prod" },
    ]);
  });

  test("$this-directed call: $this->method() resolves to a method on the same class", async () => {
    const file = await write(
      "Widget.php",
      [
        "<?php",
        "class Widget {",
        "  public function run() {",
        "    $this->helper();",
        "  }",
        "  public function helper() {}",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([["Widget", file]]);
    const edges = await buildPhpReferenceEdges([file], classToFile);
    expect(edges).toEqual([
      { from: `${file}:3:run`, to: `${file}:6:helper`, kind: "prod" },
    ]);
  });

  test("direct typed-property call via a typed parameter's own property: $param->prop->method()", async () => {
    const customer = await write(
      "Customer.php",
      ["<?php", "class Customer {", "  public function charge() {}", "}", ""].join("\n"),
    );
    const order = await write(
      "Order.php",
      [
        "<?php",
        "class Order {",
        "  public Customer $customer;",
        "}",
        "",
      ].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function run(Order $o) {",
        "    $o->customer->charge();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Customer", customer],
      ["Order", order],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([customer, order, service], classToFile);
    expect(edges).toEqual([
      { from: `${service}:3:run`, to: `${customer}:3:charge`, kind: "prod" },
    ]);
  });

  test("two-level chained call via $this: $this->prop->method(), property declared in a separate file — resolves using the property's OWN declaring file's namespace, not the caller's", async () => {
    const customer = await write(
      "Billing/Customer.php",
      [
        "<?php",
        "namespace Billing;",
        "class Customer {",
        "  public function charge() {}",
        "}",
        "",
      ].join("\n"),
    );
    const user = await write(
      "App/User.php",
      [
        "<?php",
        "namespace App;",
        "use Billing\\Customer;",
        "class User {",
        "  public Customer $customer;",
        "  public function run() {",
        "    $this->customer->charge();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Billing\\Customer", customer],
      ["App\\User", user],
    ]);
    const edges = await buildPhpReferenceEdges([customer, user], classToFile);
    expect(edges).toEqual([
      { from: `${user}:6:run`, to: `${customer}:4:charge`, kind: "prod" },
    ]);
  });

  test("trait-composed method call, trait declared in a separate file: edge targets the trait's own node, not a synthetic one on the composing class", async () => {
    const traitFile = await write(
      "Sortable.php",
      ["<?php", "trait Sortable {", "  public function sort() {}", "}", ""].join("\n"),
    );
    const classFile = await write(
      "Collection.php",
      [
        "<?php",
        "class Collection {",
        "  use Sortable;",
        "  public function run() {",
        "    $this->sort();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Sortable", traitFile],
      ["Collection", classFile],
    ]);
    const edges = await buildPhpReferenceEdges([traitFile, classFile], classToFile);
    expect(edges).toEqual([
      { from: `${classFile}:4:run`, to: `${traitFile}:3:sort`, kind: "prod" },
    ]);
  });

  test("multi-trait use_declaration (use A, B;): a call resolves through whichever composed trait actually declares the method", async () => {
    const traitA = await write(
      "A.php",
      ["<?php", "trait A {", "  public function fromA() {}", "}", ""].join("\n"),
    );
    const traitB = await write(
      "B.php",
      ["<?php", "trait B {", "  public function fromB() {}", "}", ""].join("\n"),
    );
    const classFile = await write(
      "Combo.php",
      [
        "<?php",
        "class Combo {",
        "  use A, B;",
        "  public function run() {",
        "    $this->fromA();",
        "    $this->fromB();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["A", traitA],
      ["B", traitB],
      ["Combo", classFile],
    ]);
    const edges = await buildPhpReferenceEdges([traitA, traitB, classFile], classToFile);
    expect(edges.sort((x, y) => x.to.localeCompare(y.to))).toEqual([
      { from: `${classFile}:4:run`, to: `${traitA}:3:fromA`, kind: "prod" },
      { from: `${classFile}:4:run`, to: `${traitB}:3:fromB`, kind: "prod" },
    ]);
  });

  test("interface-implementation edge: from the interface's own method node to the implementing class's own override, paired by name", async () => {
    const iface = await write(
      "Renderable.php",
      [
        "<?php",
        "interface Renderable {",
        "  public function render(): string;",
        "}",
        "",
      ].join("\n"),
    );
    const impl = await write(
      "Widget.php",
      [
        "<?php",
        "class Widget implements Renderable {",
        "  public function render(): string {",
        "    return 'x';",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Renderable", iface],
      ["Widget", impl],
    ]);
    const edges = await buildPhpReferenceEdges([iface, impl], classToFile);
    expect(edges).toEqual([
      { from: `${iface}:3:render`, to: `${impl}:3:render`, kind: "prod" },
    ]);
  });

  test("base_clause inheritance edge: from the base class's own method node to the subclass's own override, paired by name", async () => {
    const base = await write(
      "Base.php",
      ["<?php", "class Base {", "  public function greet() {}", "}", ""].join("\n"),
    );
    const sub = await write(
      "Sub.php",
      [
        "<?php",
        "class Sub extends Base {",
        "  public function greet() {}",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Base", base],
      ["Sub", sub],
    ]);
    const edges = await buildPhpReferenceEdges([base, sub], classToFile);
    expect(edges).toEqual([
      { from: `${base}:3:greet`, to: `${sub}:3:greet`, kind: "prod" },
    ]);
  });

  test("negative: untyped property — $this->untyped->method() produces no edge", async () => {
    const file = await write(
      "Foo.php",
      [
        "<?php",
        "class Foo {",
        "  public $bar;",
        "  public function run() {",
        "    $this->bar->baz();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([["Foo", file]]);
    const edges = await buildPhpReferenceEdges([file], classToFile);
    expect(edges).toEqual([]);
  });

  test("negative: external/vendor class — a typed parameter outside the composer map produces no edge", async () => {
    const file = await write(
      "Service.php",
      [
        "<?php",
        "use Vendor\\External;",
        "class Service {",
        "  public function run(External $e) {",
        "    $e->doThing();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map<string, string>([["Service", file]]);
    const edges = await buildPhpReferenceEdges([file], classToFile);
    expect(edges).toEqual([]);
  });

  test("negative: dynamic dispatch — $obj->$method() produces no edge", async () => {
    const file = await write(
      "Foo.php",
      [
        "<?php",
        "class Foo {",
        "  public function run(Foo $other) {",
        "    $method = 'bar';",
        "    $other->$method();",
        "  }",
        "  public function bar() {}",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([["Foo", file]]);
    const edges = await buildPhpReferenceEdges([file], classToFile);
    expect(edges).toEqual([]);
  });

  test("negative: chain deeper than one property hop fails closed", async () => {
    const c = await write(
      "C.php",
      ["<?php", "class C {", "  public function m() {}", "}", ""].join("\n"),
    );
    const b = await write(
      "B.php",
      ["<?php", "class B {", "  public C $c;", "}", ""].join("\n"),
    );
    const a = await write(
      "A.php",
      [
        "<?php",
        "class A {",
        "  public B $b;",
        "  public function run() {",
        "    $this->b->c->m();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["C", c],
      ["B", b],
      ["A", a],
    ]);
    const edges = await buildPhpReferenceEdges([c, b, a], classToFile);
    expect(edges).toEqual([]);
  });

  test("property_promotion_parameter: a direct in-constructor reference to a promoted parameter resolves (own decision, documented)", async () => {
    const foo = await write(
      "Foo.php",
      ["<?php", "class Foo {", "  public function bar() {}", "}", ""].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function __construct(private Foo $foo) {",
        "    $foo->bar();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Foo", foo],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([foo, service], classToFile);
    expect(edges).toEqual([
      { from: `${service}:3:__construct`, to: `${foo}:3:bar`, kind: "prod" },
    ]);
  });

  test("property_promotion_parameter is NOT recorded as a DeclaredProperty (T1 gap, documented): $this->foo->bar() still fails closed even though foo was promoted", async () => {
    const foo = await write(
      "Foo.php",
      ["<?php", "class Foo {", "  public function bar() {}", "}", ""].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function __construct(private Foo $foo) {}",
        "  public function run() {",
        "    $this->foo->bar();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Foo", foo],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([foo, service], classToFile);
    expect(edges).toEqual([]);
  });

  test("test-file classification: a call inside a *Test.php file is tagged kind: \"test\"", async () => {
    const foo = await write(
      "Foo.php",
      ["<?php", "class Foo {", "  public function bar() {}", "}", ""].join("\n"),
    );
    const test = await write(
      "FooTest.php",
      [
        "<?php",
        "class FooTest {",
        "  public function testBar(Foo $f) {",
        "    $f->bar();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Foo", foo],
      ["FooTest", test],
    ]);
    const edges = await buildPhpReferenceEdges([foo, test], classToFile);
    expect(edges).toEqual([
      { from: `${test}:3:testBar`, to: `${foo}:3:bar`, kind: "test" },
    ]);
  });

  test("anonymous-class methods inside a method body are not misattributed to the enclosing method", async () => {
    const foo = await write(
      "Foo.php",
      ["<?php", "class Foo {", "  public function bar() {}", "}", ""].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function run(Foo $f) {",
        "    $x = new class {",
        "      public function inner(Foo $f) {",
        "        $f->bar();",
        "      }",
        "    };",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Foo", foo],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([foo, service], classToFile);
    // The call lives inside the anonymous class's own `inner` method, not
    // `run` — `run` itself has no direct member_call_expression, so no edge
    // is produced from `run`'s node at all (the anonymous class's own
    // method never gets a SymbolNode either, matching T1's exclusion).
    expect(edges).toEqual([]);
  });

  test("node id parity: a resolved call-edge target matches a real id buildPhpSymbolGraph would produce for the target file", async () => {
    const { buildPhpSymbolGraph } = await import("../src/graph/php/symbol-graph.js");
    const customer = await write(
      "Customer.php",
      ["<?php", "class Customer {", "  public function charge() {}", "}", ""].join("\n"),
    );
    const service = await write(
      "Service.php",
      [
        "<?php",
        "class Service {",
        "  public function run(Customer $c) {",
        "    $c->charge();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["Customer", customer],
      ["Service", service],
    ]);
    const edges = await buildPhpReferenceEdges([customer, service], classToFile);
    const nodes = await buildPhpSymbolGraph([customer, service]);
    const nodeIds = new Set(nodes.map((n) => n.id));
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(nodeIds.has(edge.from)).toBe(true);
    }
  });

  test("node id parity, two classes in one file: a call resolving to the SECOND class's method still matches buildPhpSymbolGraph's id exactly (stresses the two independent fqcn/kind-tracking walks agreeing with each other)", async () => {
    const { buildPhpSymbolGraph } = await import("../src/graph/php/symbol-graph.js");
    const file = await write(
      "Multi.php",
      [
        "<?php",
        "class First {",
        "  public function noop() {}",
        "}",
        "",
        "class Second {",
        "  public function target() {}",
        "}",
        "",
        "class Caller {",
        "  public function run(Second $s) {",
        "    $s->target();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const classToFile = new Map([
      ["First", file],
      ["Second", file],
      ["Caller", file],
    ]);
    const edges = await buildPhpReferenceEdges([file], classToFile);
    const nodes = await buildPhpSymbolGraph([file]);
    const nodeIds = new Set(nodes.map((n) => n.id));

    expect(edges).toEqual([
      { from: `${file}:11:run`, to: `${file}:7:target`, kind: "prod" },
    ]);
    for (const edge of edges) {
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(nodeIds.has(edge.from)).toBe(true);
    }
  });

  describe("top-level script call-site resolution (75-01 T10, post-T8 finding)", () => {
    test("$var = new X(); $var->method(); at a file's top level (outside any class) resolves — edge `from` is the bare file path, not a synthetic node id", async () => {
      const target = await write(
        "Target.php",
        ["<?php", "class Target {", "  public function run() {}", "}", ""].join("\n"),
      );
      const script = await write(
        "bin/console.php",
        [
          "<?php",
          "$target = new Target();",
          "$target->run();",
          "",
        ].join("\n"),
      );
      const classToFile = new Map([["Target", target]]);
      const edges = await buildPhpReferenceEdges([target, script], classToFile);
      expect(edges).toEqual([
        { from: script, to: `${target}:3:run`, kind: "prod" },
      ]);
    });

    test("negative: top-level reassignment to a DIFFERENT class fails closed — no control-flow tracking, so an ambiguous variable is excluded entirely", async () => {
      const a = await write(
        "A.php",
        ["<?php", "class A {", "  public function m() {}", "}", ""].join("\n"),
      );
      const b = await write(
        "B.php",
        ["<?php", "class B {", "  public function m() {}", "}", ""].join("\n"),
      );
      const script = await write(
        "bin/console.php",
        [
          "<?php",
          "$x = new A();",
          "$x = new B();",
          "$x->m();",
          "",
        ].join("\n"),
      );
      const classToFile = new Map([
        ["A", a],
        ["B", b],
      ]);
      const edges = await buildPhpReferenceEdges([a, b, script], classToFile);
      expect(edges).toEqual([]);
    });

    test("negative: a top-level variable typed via something other than a direct `new` expression fails closed", async () => {
      const foo = await write(
        "Foo.php",
        ["<?php", "class Foo {", "  public function bar() {}", "}", ""].join("\n"),
      );
      const script = await write(
        "bin/console.php",
        [
          "<?php",
          "$x = someFunction();",
          "$x->bar();",
          "",
        ].join("\n"),
      );
      const classToFile = new Map([["Foo", foo]]);
      const edges = await buildPhpReferenceEdges([foo, script], classToFile);
      expect(edges).toEqual([]);
    });
  });
});
