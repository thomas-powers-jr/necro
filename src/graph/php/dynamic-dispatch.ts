import { readFile } from "node:fs/promises";
import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "../../syntactic/parse.js";

/**
 * PHP's magic methods — invoked implicitly by the engine on property/method
 * access, `isset()`/`unset()`, or `$obj(...)` call syntax, never through an
 * ordinary reference the static graph can see. A class declaring one of
 * these is, by definition, reachable through call shapes this analyzer
 * cannot trace — so the whole file is tainted rather than trying (and
 * failing) to model the implicit dispatch.
 */
const MAGIC_METHOD_NAMES = new Set([
  "__call",
  "__callStatic",
  "__get",
  "__set",
  "__isset",
  "__unset",
  "__invoke",
]);

/** PHP's reflection-style call builtins: the callee is itself a runtime value (string/array/Closure), so the static graph has nothing to resolve against. */
const DYNAMIC_CALL_FUNCTIONS = new Set([
  "call_user_func",
  "call_user_func_array",
]);

/**
 * AST-based PHP dynamic-dispatch taint detector (phase 75 T6, AC-3).
 *
 * Deliberately **not** wired into `reachability.ts`'s `findTaintedFiles` as a
 * same-shape `PHP_ONLY_TAINT_PATTERNS: RegExp[]` array alongside
 * `JS_ONLY_TAINT_PATTERNS`/`PYTHON_ONLY_TAINT_PATTERNS`: those run as raw-text
 * regexes over whole-file source (`readSources` — comments and string
 * literals included), so a regex matching the literal text `call_user_func`
 * would false-positive on a comment or string containing it. This walks the
 * actual parsed AST and only matches nodes in real code position — see the
 * negative fixtures in `test/graph-php-dynamic-dispatch.test.ts`.
 *
 * Architecturally, this also has to live outside `findTaintedFiles` for a
 * simpler reason: `getParser` (`../../syntactic/parse.js`) is async (it loads
 * a WASM grammar), and `findTaintedFiles` is a synchronous, hot,
 * regex-only function shared by JS/TS and Python. Rather than making that
 * function (and both its existing call sites in `test/reachability.test.ts`
 * and `test/classify.test.ts`) async for every language just to support PHP,
 * this mirrors the exact precedent `buildPythonSymbolGraph`'s
 * `starTaintedFiles` already set: a separate async pass, computed once in
 * `buildReachabilityModel` (`src/engine/model.ts`) and unioned into the
 * model's `taintedFiles` the same way `starTaintedFiles` is. JS/TS and
 * Python's `findTaintedFiles` behavior is untouched by this file.
 *
 * Matches four shapes, live-verified against `web-tree-sitter` +
 * `tree-sitter-php.wasm` (the same loading path `src/syntactic/parse.ts`
 * uses):
 *
 * - `method_declaration` nodes whose `name:` field text is one of PHP's
 *   magic methods (`MAGIC_METHOD_NAMES` above) — magic methods have no
 *   distinct node type in this grammar, so this is a name-text match on an
 *   ordinary declaration node.
 * - `function_call_expression` nodes calling `call_user_func`/
 *   `call_user_func_array` by name — matched on the `function:` field, which
 *   is `name` for an unqualified call (`call_user_func(...)`, including one
 *   written inside a namespace body — PHP's own fallback-to-global-function
 *   rule for unqualified calls means the grammar still gives this the bare
 *   `name` type) and `qualified_name` for a fully-qualified reference
 *   (`\call_user_func(...)`). A *partially*-qualified reference
 *   (`Other\call_user_func(...)`) is deliberately excluded: without a
 *   leading `\` that resolves relative to the current namespace to a
 *   different, user-defined function that merely shares the builtin's name —
 *   not the reflection-style builtin this detector cares about — so treating
 *   it as a match would be a false positive, not a safe over-approximation.
 * - `dynamic_variable_name` nodes (`$$name`) anywhere — a genuinely distinct
 *   node type in this grammar; presence alone taints, no field to inspect.
 * - `member_call_expression` nodes whose `name:` field is not the plain
 *   `name` node type — i.e. `$obj->$method()`. Checked as `!== "name"`
 *   (matching every non-static shape the grammar allows for this field:
 *   `variable_name`, `dynamic_variable_name`, `expression`) rather than
 *   `=== "variable_name"` alone, deliberately mirroring the fail-closed
 *   check `src/graph/php/reference-edges.ts`'s call-site resolution already
 *   uses for the identical field. Keeping the two checks the same shape
 *   matters: if they ever disagreed, the worst case is a call T2 can't
 *   resolve (so the callee method looks dead) that T6 also doesn't taint (so
 *   no `maybe` demotion happens) — a false certain-dead, which is exactly
 *   the failure this detector exists to prevent.
 */
export async function findPhpTaintedFiles(
  phpFiles: string[],
): Promise<Set<string>> {
  const tainted = new Set<string>();
  for (const file of phpFiles) {
    const source = await readFile(file, "utf8");
    const parser = await getParser(file);
    const tree = parser.parse(source);
    if (tree && hasDynamicDispatch(tree.rootNode)) {
      tainted.add(file);
    }
  }
  return tainted;
}

function hasDynamicDispatch(node: TsNode): boolean {
  if (node.type === "method_declaration") {
    const nameField = node.childForFieldName("name");
    if (nameField && MAGIC_METHOD_NAMES.has(nameField.text)) return true;
  } else if (node.type === "function_call_expression") {
    const fnField = node.childForFieldName("function");
    if (fnField && callsDynamicDispatchFunction(fnField)) return true;
  } else if (node.type === "dynamic_variable_name") {
    return true;
  } else if (node.type === "member_call_expression") {
    const nameField = node.childForFieldName("name");
    if (nameField && nameField.type !== "name") return true;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && hasDynamicDispatch(child)) return true;
  }
  return false;
}

/**
 * Whether a `function_call_expression`'s `function:` field names
 * `call_user_func`/`call_user_func_array` as the actual global builtin —
 * either unqualified (`name`) or fully-qualified with a leading `\`
 * (`qualified_name` text `\call_user_func`). See the module docstring for why
 * a partially-qualified reference is excluded.
 */
function callsDynamicDispatchFunction(fnField: TsNode): boolean {
  if (fnField.type === "name") return DYNAMIC_CALL_FUNCTIONS.has(fnField.text);
  if (fnField.type === "qualified_name" && fnField.text.startsWith("\\")) {
    return DYNAMIC_CALL_FUNCTIONS.has(fnField.text.slice(1));
  }
  return false;
}
