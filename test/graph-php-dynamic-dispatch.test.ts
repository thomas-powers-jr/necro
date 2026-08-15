import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";
import { findPhpTaintedFiles } from "../src/graph/php/dynamic-dispatch.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-dyndispatch-"));
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

describe("findPhpTaintedFiles — AST-based dynamic-dispatch taint detector (75-01 AC-3)", () => {
  describe("magic methods", () => {
    const magicMethods = [
      "__call",
      "__callStatic",
      "__get",
      "__set",
      "__isset",
      "__unset",
      "__invoke",
    ];

    for (const name of magicMethods) {
      test(`AC-3: a class declaring ${name} taints its file`, async () => {
        const file = await write(
          "Widget.php",
          [
            "<?php",
            "class Widget {",
            `  public function ${name}() {}`,
            "}",
            "",
          ].join("\n"),
        );
        const tainted = await findPhpTaintedFiles([file]);
        expect(tainted.has(file)).toBe(true);
      });
    }
  });

  describe("call_user_func family", () => {
    test("AC-3: an unqualified call_user_func(...) call taints its file", async () => {
      const file = await write(
        "Dispatch.php",
        [
          "<?php",
          "class Dispatch {",
          "  public function run($cb) {",
          "    call_user_func($cb);",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });

    test("AC-3: an unqualified call_user_func_array(...) call taints its file", async () => {
      const file = await write(
        "Dispatch.php",
        [
          "<?php",
          "class Dispatch {",
          "  public function run($cb, $args) {",
          "    call_user_func_array($cb, $args);",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });

    test("AC-3: a call inside a namespace body (unqualified, resolves via PHP's global fallback) still taints", async () => {
      const file = await write(
        "Dispatch.php",
        [
          "<?php",
          "namespace App;",
          "class Dispatch {",
          "  public function run($cb) {",
          "    call_user_func($cb);",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });

    test("AC-3: a fully-qualified \\call_user_func(...) reference taints", async () => {
      const file = await write(
        "Dispatch.php",
        [
          "<?php",
          "namespace App;",
          "class Dispatch {",
          "  public function run($cb) {",
          "    \\call_user_func($cb);",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });

    test("does NOT flag a partially-qualified reference to a different, user-defined function of the same name (Other\\call_user_func)", async () => {
      const file = await write(
        "Dispatch.php",
        [
          "<?php",
          "namespace App;",
          "class Dispatch {",
          "  public function run($cb) {",
          "    Other\\call_user_func($cb);",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(false);
    });
  });

  describe("dynamic variable name ($$var)", () => {
    test("AC-3: a $$var dynamic variable reference taints its file", async () => {
      const file = await write(
        "Dynamic.php",
        [
          "<?php",
          "class Dynamic {",
          "  public function run($name) {",
          "    $x = $$name;",
          "    return $x;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });
  });

  describe("dynamic method-call dispatch ($obj->$method())", () => {
    test("AC-3: $obj->$method() (variable name field) taints its file", async () => {
      const file = await write(
        "Widget.php",
        [
          "<?php",
          "class Widget {",
          "  public function run($obj, $method) {",
          "    $obj->$method();",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(true);
    });

    test("an ordinary static $obj->method() call does NOT taint", async () => {
      const file = await write(
        "Widget.php",
        [
          "<?php",
          "class Widget {",
          "  public function run($obj) {",
          "    $obj->method();",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(false);
    });
  });

  describe("negative fixtures — the exact raw-text-regex false positive this AST-based approach avoids", () => {
    test("AC-3: the literal text call_user_func appearing only inside a comment and a string literal does NOT taint", async () => {
      const file = await write(
        "Clean.php",
        [
          "<?php",
          "class Clean {",
          "  // this comment mentions call_user_func but never calls it",
          "  public function run() {",
          '    $note = "call_user_func is not invoked here";',
          "    return $note;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(false);
    });

    test("a method named __construct and a method named callUserFunc (near-miss names) do NOT taint — set membership is exact, not substring/prefix", async () => {
      const file = await write(
        "Clean.php",
        [
          "<?php",
          "class Clean {",
          "  public function __construct() {}",
          "  public function callUserFunc() {}",
          "  public function call_user_func_helper() {}",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(false);
    });

    test("an entirely ordinary file with no dynamic dispatch does NOT taint", async () => {
      const file = await write(
        "Plain.php",
        [
          "<?php",
          "class Plain {",
          "  public function greet($name) {",
          "    return \"hello \" . $name;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      const tainted = await findPhpTaintedFiles([file]);
      expect(tainted.has(file)).toBe(false);
    });
  });

  test("only the file containing dynamic dispatch is tainted, not every file passed in", async () => {
    const dirty = await write(
      "Dirty.php",
      ["<?php", "class Dirty {", "  public function __get($n) {}", "}", ""].join(
        "\n",
      ),
    );
    const clean = await write(
      "Clean.php",
      ["<?php", "class Clean {", "  public function run() {}", "}", ""].join(
        "\n",
      ),
    );
    const tainted = await findPhpTaintedFiles([dirty, clean]);
    expect(tainted.has(dirty)).toBe(true);
    expect(tainted.has(clean)).toBe(false);
  });

  describe("buildReachabilityModel wiring (75-01 T6, AC-3)", () => {
    const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

    test("a PHP file with a magic method comes back tainted through the full model, not just the standalone detector", async () => {
      const file = await write(
        "Widget.php",
        [
          "<?php",
          "class Widget {",
          "  public function __get($name) {",
          "    return null;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const model = await buildReachabilityModel(dir, config);

      expect(model.taintedFiles.has(file)).toBe(true);
      const node = model.reachability.find((r) =>
        model.graph.nodes.find((n) => n.id === r.id)?.file === file,
      );
      expect(node?.tainted).toBe(true);
    });

    test("an ordinary PHP file with no dynamic dispatch is NOT tainted through the full model (proves the wiring isn't a rubber stamp)", async () => {
      const file = await write(
        "Plain.php",
        ["<?php", "class Plain {", "  public function run() {}", "}", ""].join(
          "\n",
        ),
      );

      const model = await buildReachabilityModel(dir, config);

      expect(model.taintedFiles.has(file)).toBe(false);
    });
  });
});
