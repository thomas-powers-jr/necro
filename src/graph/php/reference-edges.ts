import { readFile } from "node:fs/promises";
import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "../../syntactic/parse.js";
import type { EdgeKind, SymbolEdge } from "../types.js";
import {
  type DeclaredMethod,
  type DeclaredProperty,
  type DeclaredSymbolKind,
  extractDeclaredSymbols,
} from "./declared-symbols.js";
import type { PhpImport } from "./import-parser.js";
import { parsePhpImports } from "./import-parser.js";
import { resolvePhpClassReference } from "./resolve-import.js";

/** PHPUnit's real-world default: a test class file is named `*Test.php` (mirrors AC-4's documented fallback convention). */
const DEFAULT_PHP_TEST_FILE = /Test\.php$/;

export interface BuildPhpReferenceEdgesOptions {
  /** Classify a file as test (vs prod), for edge tagging. Defaults to a `*Test.php` filename match (PHPUnit convention). */
  isTestFile?: (filePath: string) => boolean;
}

const KIND_BY_NODE_TYPE: Record<string, DeclaredSymbolKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

/** A class/interface/trait/enum declaration node found while walking a file, paired with its computed FQCN — the node-reference counterpart to `extractDeclaredSymbols`' flattened `DeclaredSymbol` (T1 doesn't expose node refs, so this module re-walks independently; the namespace-tracking algorithm is deliberately identical to `declared-symbols.ts`'s so the two walks always agree on fqcn/kind pairs). */
interface TypeNodeRef {
  fqcn: string;
  kind: DeclaredSymbolKind;
  node: TsNode;
  body: TsNode | null;
}

/** Everything extracted from one file, parsed once and cached for the lifetime of a `buildPhpReferenceEdges` call. */
interface FileData {
  file: string;
  namespace: string;
  imports: PhpImport[];
  typeNodes: TypeNodeRef[];
  /** This file's TOP-LEVEL (script-level) statement nodes — see `collectTopLevelStatements`. */
  topLevelStatements: TsNode[];
}

/**
 * A class/interface/trait/enum's full resolved shape: T1's own methods/
 * properties (never inherited/composed — matching `DeclaredSymbol`) plus this
 * module's own structural resolution of its `use_declaration` (trait
 * composition), `base_clause` (inheritance, or interface `extends`), and
 * `class_interface_clause` (`implements`) targets, each resolved to an FQCN
 * via `resolvePhpClassReference` against *this type's own declaring file's*
 * namespace/imports — never the caller's (a property's declared-type text is
 * only meaningful relative to the file that wrote it).
 */
interface TypeInfo {
  fqcn: string;
  file: string;
  namespace: string;
  imports: PhpImport[];
  methods: DeclaredMethod[];
  properties: DeclaredProperty[];
  traitFqcns: string[];
  baseFqcns: string[];
  interfaceFqcns: string[];
}

/**
 * Build PHP reference edges: `member_call_expression` resolution through
 * typed parameters/properties and `$this` (one further level of recursive
 * property-access chasing), trait-composed method-call redirection, and
 * interface/base "virtual dispatch" pairing edges (see below). Fails closed
 * (no edge) on any unresolvable chain link — an untyped property, a dynamic
 * `$obj->$method()`/`$this->$prop` construct, a chain deeper than one
 * property hop, or a class outside `classToFile` (external/vendor) — never
 * guesses.
 *
 * **Interface/base "implementation" edges** (AC-2's `class_interface_clause`/
 * `base_clause` "produce implementation/inheritance edges" clause): since
 * `SymbolNode`s exist only at method/property grain (no class-level node),
 * these can't be file-to-file edges — a file-path target doesn't make any
 * individual method node reachable (`buildReachabilityModel` only roots a
 * file's *exported* declarations directly for actual entry files, never as a
 * side effect of a structural edge landing on a file). Instead, for every
 * method name a class/enum redeclares that also exists on an interface it
 * implements or a class it extends, this module emits an edge **from the
 * interface/base's own method node to the overriding class's own method
 * node** — soundness for virtual dispatch: `function f(Renderable $r) {
 * $r->render(); }` resolves the call to `Renderable::render()` (the only
 * thing statically known), so without this edge every concrete
 * `render()` override would be falsely reported dead. The reverse direction
 * (override -> abstract declaration) is intentionally not emitted: an
 * interface method is never independently "used" on its own.
 *
 * Trait composition (`use_declaration`) does **not** get this pairing
 * treatment — a composed method has no node of its own on the composing
 * class to pair with (T1 only extracts methods from each type's own
 * `declaration_list`), so a call to a composed method is instead resolved
 * (via the unified own-methods -> traits -> base -> interfaces fallback walk
 * in `findMethodOwner`) directly to the trait's own method node. That
 * fallback walk also transparently covers inherited-but-not-overridden
 * method calls (`$this->baseOnlyMethod()`) and multi-level trait composition
 * (a trait `use`-ing another trait) for free, even though no fixture in this
 * phase requires either.
 *
 * **Top-level (script) call-site resolution** (T10, a post-T8 finding): the
 * per-class loop above only walks `methodDeclsOf(typeNode.body)` — code
 * INSIDE a class/trait/interface/enum method. Every realistic PHP entry
 * point (a composer `bin` script, `public/index.php`) is the opposite shape:
 * a thin bootstrap with zero enclosing class — `$target = new
 * BinTarget(); $target->run();` — so without a second pass those calls were
 * invisible and the class they invoke could never be marked reachable. This
 * module also walks each file's TOP-LEVEL statements (outside every
 * class/interface/trait/enum body, see `collectTopLevelStatements`) for
 * `member_call_expression` sites, resolving `object:` through a
 * top-level-only local-variable-type environment built from direct `$var =
 * new ClassName();` assignments in the same top-level statement list (see
 * `buildTopLevelNewEnv`) — there is no `$this`/typed-parameter/typed-property
 * context at top level, so this is genuinely new resolution logic
 * (`resolveTopLevelObjectType`), not a reuse of `resolveObjectType`'s
 * param/property/`$this` cases; it handles only the bare `variable_name`
 * shape, no property-hop chaining (top-level code doesn't need it). "One
 * variable, one type": a variable qualifies only when it has exactly ONE
 * top-level assignment overall and that assignment is a direct `new`
 * expression — any second assignment (to the same class via `new`, a
 * different class, or a non-`new` expression) excludes the variable from the
 * environment entirely, matching this resolver's fail-closed discipline (no
 * control-flow/reassignment tracking, never guessed). Edges from this pass
 * are emitted `from: <bare file path>` (not a `SymbolNode` id) — the exact
 * shape `resolvePhpEntries`' records already seed into `model.ts`'s
 * `prodEntries`, so `computeReachability`'s BFS naturally traverses them.
 *
 * **Known, deliberate gaps** (none block AC-2; each is a documented, safe
 * simplification — flagged here so T3/T8 don't chase them as bugs):
 * - **Abstract methods terminate the chain.** T1's `extractMembers` matches
 *   `method_declaration` regardless of whether it has a `body:` field, so an
 *   `abstract public function foo();` re-declaration gets its own node. A
 *   call resolving through `findMethodOwner`/an interface-pairing edge that
 *   lands on an abstract re-declaration stops there — it does not
 *   additionally chase down to a concrete override further down the
 *   hierarchy. Under-approximation (a missed edge, not a wrong one) — the
 *   safe direction, but worth knowing when reading a truth table with an
 *   abstract base in the mix.
 * - **A typed parameter reassigned to a different type mid-body still
 *   resolves via its *declared* type.** `function run(Customer $c) { $c =
 *   $this->other; $c->charge(); }` resolves `$c->charge()` against
 *   `Customer`, not whatever `$this->other`'s real type is — this module
 *   does no data-flow/reassignment tracking. This is the one place this
 *   resolver over-approximates (a possible false edge) rather than fails
 *   closed; real-world PHP essentially never reassigns a typed parameter to
 *   an incompatible type, and the consequence (a method reported live that's
 *   actually dead) is the safe-for-dead-code-analysis direction.
 * - Not handled at all, by scope: nullsafe chains (`?->`), a chain whose
 *   `object:` is itself a call's return value (`$this->foo()->bar()`), and
 *   3+-level property-access chains — all fail closed via the same
 *   two-shape match in `resolveObjectType`, never guessed.
 */
export async function buildPhpReferenceEdges(
  files: string[],
  classToFile: ReadonlyMap<string, string>,
  opts: BuildPhpReferenceEdgesOptions = {},
): Promise<SymbolEdge[]> {
  const isTestFile = opts.isTestFile ?? ((p) => DEFAULT_PHP_TEST_FILE.test(p));
  const edges: SymbolEdge[] = [];

  const fileDataCache = new Map<string, Promise<FileData>>();
  const getFileData = (file: string): Promise<FileData> => {
    let p = fileDataCache.get(file);
    if (!p) {
      p = loadFileData(file);
      fileDataCache.set(file, p);
    }
    return p;
  };

  const symbolsCache = new Map<
    string,
    ReturnType<typeof extractDeclaredSymbols>
  >();
  const getSymbols = (
    file: string,
  ): ReturnType<typeof extractDeclaredSymbols> => {
    let p = symbolsCache.get(file);
    if (!p) {
      p = readFile(file, "utf8").then((source) =>
        extractDeclaredSymbols(file, source),
      );
      symbolsCache.set(file, p);
    }
    return p;
  };

  const typeInfoCache = new Map<string, Promise<TypeInfo | null>>();
  const getTypeInfo = (fqcn: string): Promise<TypeInfo | null> => {
    let p = typeInfoCache.get(fqcn);
    if (!p) {
      p = resolveTypeInfo(fqcn);
      typeInfoCache.set(fqcn, p);
    }
    return p;
  };

  async function resolveTypeInfo(fqcn: string): Promise<TypeInfo | null> {
    const file = classToFile.get(fqcn);
    if (!file) return null; // external/vendor/unmapped -> fail closed
    const data = await getFileData(file);
    const typeNode = data.typeNodes.find((t) => t.fqcn === fqcn);
    if (!typeNode) return null;
    const symbols = await getSymbols(file);
    const symbol = symbols.find(
      (s) => s.fqcn === fqcn && s.kind === typeNode.kind,
    );
    if (!symbol) return null;
    return buildTypeInfo(file, data, typeNode, symbol, classToFile);
  }

  /** Chase `fqcn`'s method `methodName` through own methods -> composed traits -> base class(es) -> implemented/extended interfaces, in that order; fails closed (returns `null`) the moment `fqcn` itself is unresolvable. Cycle-guarded (`visited`) against circular trait/interface composition. */
  async function findMethodOwner(
    fqcn: string,
    methodName: string,
    visited: Set<string>,
  ): Promise<{ file: string; line: number; name: string } | null> {
    if (visited.has(fqcn)) return null;
    visited.add(fqcn);

    const info = await getTypeInfo(fqcn);
    if (!info) return null;

    const own = info.methods.find((m) => m.name === methodName);
    if (own) return { file: info.file, line: own.line, name: own.name };

    for (const t of info.traitFqcns) {
      const found = await findMethodOwner(t, methodName, visited);
      if (found) return found;
    }
    for (const b of info.baseFqcns) {
      const found = await findMethodOwner(b, methodName, visited);
      if (found) return found;
    }
    for (const i of info.interfaceFqcns) {
      const found = await findMethodOwner(i, methodName, visited);
      if (found) return found;
    }
    return null;
  }

  /**
   * Resolve a `member_call_expression`'s `object:` node to the FQCN it
   * statically refers to. Two shapes only, matching AC-2 exactly: a bare
   * `variable_name` (`$this` or a typed parameter/promoted-parameter,
   * resolved via `env`) is the base case; a `member_access_expression` whose
   * *own* `object:` is a bare `variable_name` is the one-further-level
   * property-access recursion (`$this->prop->method()` /
   * `$typedParam->prop->method()`) — resolved using the property's *own
   * declaring file's* namespace/imports (`getTypeInfo(innerFqcn)`), never
   * `ownInfo`'s. Anything deeper (the inner `object:` is itself a
   * `member_access_expression`), or a dynamic property/`name:` access
   * (`$obj->$prop`, `$obj->$method()`), fails closed per the Boundaries'
   * one-level cap.
   */
  async function resolveObjectType(
    node: TsNode,
    env: ReadonlyMap<string, string>,
    ownInfo: TypeInfo,
  ): Promise<string | null> {
    if (node.type === "variable_name") {
      const varName = variableNameText(node);
      if (varName === null) return null;
      if (varName === "this") return ownInfo.fqcn;
      const typeText = env.get(varName);
      if (!typeText) return null;
      return resolvePhpClassReference(
        typeText,
        ownInfo.namespace,
        ownInfo.imports,
        classToFile,
      ).fqcn;
    }

    if (node.type === "member_access_expression") {
      const inner = node.childForFieldName("object");
      if (inner?.type !== "variable_name") return null; // deeper chain -> fail closed
      const innerFqcn = await resolveObjectType(inner, env, ownInfo);
      if (!innerFqcn) return null;

      const nameField = node.childForFieldName("name");
      if (nameField?.type !== "name") return null; // dynamic property access -> fail closed

      const innerInfo = await getTypeInfo(innerFqcn);
      if (!innerInfo) return null; // external/vendor class -> fail closed

      const prop = innerInfo.properties.find((p) => p.name === nameField.text);
      if (!prop?.declaredType) return null; // untyped/unresolvable property -> fail closed

      return resolvePhpClassReference(
        prop.declaredType,
        innerInfo.namespace,
        innerInfo.imports,
        classToFile,
      ).fqcn;
    }

    return null;
  }

  for (const file of files) {
    const data = await getFileData(file);

    const symbols = await getSymbols(file);
    for (const typeNode of data.typeNodes) {
      const symbol = symbols.find(
        (s) => s.fqcn === typeNode.fqcn && s.kind === typeNode.kind,
      );
      if (!symbol) continue;

      const ownInfo = buildTypeInfo(file, data, typeNode, symbol, classToFile);
      const kind: EdgeKind = isTestFile(file) ? "test" : "prod";

      if (ownInfo.methods.length > 0 && typeNode.body) {
        for (const methodNode of methodDeclsOf(typeNode.body)) {
          const nameNode = methodNode.childForFieldName("name");
          const bodyNode = methodNode.childForFieldName("body");
          if (!nameNode || !bodyNode) continue; // no body (abstract/interface method) -> no calls to walk

          const fromId = `${file}:${nameNode.startPosition.row + 1}:${nameNode.text}`;
          const env = buildParamEnv(methodNode);

          const callSites: TsNode[] = [];
          collectCallSites(bodyNode, callSites);

          for (const call of callSites) {
            const objectNode = call.childForFieldName("object");
            const nameField = call.childForFieldName("name");
            if (!objectNode || !nameField || nameField.type !== "name")
              continue; // dynamic dispatch ($obj->$method()) -> fail closed

            const objFqcn = await resolveObjectType(objectNode, env, ownInfo);
            if (!objFqcn) continue;

            const target = await findMethodOwner(
              objFqcn,
              nameField.text,
              new Set(),
            );
            if (!target) continue;

            edges.push({
              from: fromId,
              to: `${target.file}:${target.line}:${target.name}`,
              kind,
            });
          }
        }
      }

      // Interface-implementation / inheritance pairing edges (see module
      // docstring): from the interface/base's own method node to this
      // type's own override/implementation of the same name, when one
      // exists.
      for (const targetFqcn of [
        ...ownInfo.baseFqcns,
        ...ownInfo.interfaceFqcns,
      ]) {
        const targetInfo = await getTypeInfo(targetFqcn);
        if (!targetInfo) continue; // external/vendor -> fail closed

        for (const targetMethod of targetInfo.methods) {
          const ownMethod = ownInfo.methods.find(
            (m) => m.name === targetMethod.name,
          );
          if (!ownMethod) continue;

          edges.push({
            from: `${targetInfo.file}:${targetMethod.line}:${targetMethod.name}`,
            to: `${file}:${ownMethod.line}:${ownMethod.name}`,
            kind,
          });
        }
      }
    }

    // Top-level (script) call-site resolution (T10, see module docstring for
    // the full mechanism). `from: file` is deliberately a bare file path,
    // not a `SymbolNode` id — there is no node for "the script itself"; this
    // matches the shape `resolvePhpEntries`' records seed into `model.ts`'s
    // `prodEntries`.
    const topLevelKind: EdgeKind = isTestFile(file) ? "test" : "prod";
    const topLevelEnv = buildTopLevelNewEnv(data.topLevelStatements);

    const topLevelCallSites: TsNode[] = [];
    for (const stmt of data.topLevelStatements) {
      // A top-level `function foo() { ... }` definition's body only
      // executes when the function is later CALLED, not merely by being
      // defined — walking into it here would over-claim a call as part of
      // "running this script" when it may never run. Not modifying the
      // shared `collectCallSites` (also used for method bodies, where a
      // nested `function_definition` is a rarer, differently-shaped
      // pre-existing case) — just skipping it as a top-level scan root.
      if (stmt.type === "function_definition") continue;
      collectCallSites(stmt, topLevelCallSites);
    }

    for (const call of topLevelCallSites) {
      const objectNode = call.childForFieldName("object");
      const nameField = call.childForFieldName("name");
      if (!objectNode || !nameField || nameField.type !== "name")
        continue; // dynamic dispatch ($obj->$method()) -> fail closed

      const objFqcn = resolveTopLevelObjectType(
        objectNode,
        topLevelEnv,
        data.namespace,
        data.imports,
        classToFile,
      );
      if (!objFqcn) continue;

      const target = await findMethodOwner(objFqcn, nameField.text, new Set());
      if (!target) continue;

      edges.push({
        from: file,
        to: `${target.file}:${target.line}:${target.name}`,
        kind: topLevelKind,
      });
    }
  }

  return edges;
}

async function loadFileData(file: string): Promise<FileData> {
  const source = await readFile(file, "utf8");
  const { namespace, imports } = await parsePhpImports(file, source);

  const parser = await getParser(file);
  const tree = parser.parse(source);
  const typeNodes: TypeNodeRef[] = [];
  const topLevelStatements: TsNode[] = [];
  if (tree) {
    collectTypeNodes(tree.rootNode, "", typeNodes);
    collectTopLevelStatements(tree.rootNode, topLevelStatements);
  }

  return { file, namespace, imports, typeNodes, topLevelStatements };
}

function buildTypeInfo(
  file: string,
  data: FileData,
  typeNode: TypeNodeRef,
  symbol: { methods: DeclaredMethod[]; properties: DeclaredProperty[] },
  classToFile: ReadonlyMap<string, string>,
): TypeInfo {
  const baseClause = firstChildOfType(typeNode.node, "base_clause");
  const ifaceClause = firstChildOfType(typeNode.node, "class_interface_clause");

  return {
    fqcn: typeNode.fqcn,
    file,
    namespace: data.namespace,
    imports: data.imports,
    methods: symbol.methods,
    properties: symbol.properties,
    baseFqcns: resolveClauseTargets(
      baseClause,
      data.namespace,
      data.imports,
      classToFile,
    ),
    interfaceFqcns: resolveClauseTargets(
      ifaceClause,
      data.namespace,
      data.imports,
      classToFile,
    ),
    traitFqcns: typeNode.body
      ? resolveTraitTargets(
          typeNode.body,
          data.namespace,
          data.imports,
          classToFile,
        )
      : [],
  };
}

/** `base_clause` (single for a class, possibly multiple for `interface X extends A, B`) / `class_interface_clause` targets: every direct `name`/`qualified_name` child, resolved to its FQCN via the declaring file's own namespace/imports. */
function resolveClauseTargets(
  clause: TsNode | null,
  namespace: string,
  imports: PhpImport[],
  classToFile: ReadonlyMap<string, string>,
): string[] {
  if (!clause) return [];
  const out: string[] = [];
  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i);
    if (!child || (child.type !== "name" && child.type !== "qualified_name"))
      continue;
    out.push(
      resolvePhpClassReference(child.text, namespace, imports, classToFile)
        .fqcn,
    );
  }
  return out;
}

/**
 * `use_declaration` trait-composition targets: every direct `use_declaration`
 * child of `body`, itself contributing every `name`/`qualified_name` child
 * (comma-separated multi-trait `use A, B;`, live-verified as two sibling
 * `name` children of one `use_declaration`). Deliberately excludes adaptation
 * blocks (`use A, B { A::foo insteadof B; }`) — live-verified as a distinct
 * `use_list` child, never a bare `name`/`qualified_name`, so the same type
 * filter that lets multi-trait declarations through excludes it for free.
 */
function resolveTraitTargets(
  body: TsNode,
  namespace: string,
  imports: PhpImport[],
  classToFile: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child?.type !== "use_declaration") continue;
    out.push(...resolveClauseTargets(child, namespace, imports, classToFile));
  }
  return out;
}

/** Direct `method_declaration` children of a type's `body` (`declaration_list` or `enum_declaration_list`), matching T1's `extractMembers` grain — never a nested member's own body. */
function methodDeclsOf(body: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child?.type === "method_declaration") out.push(child);
  }
  return out;
}

/**
 * Named children of the file's root (`program`) — or, threaded through a
 * `namespace_definition`, its namespace body — that are genuine top-level
 * (script-level) statements: everything EXCEPT a class/interface/trait/enum
 * declaration (handled by the existing per-class loop above; skipped here,
 * children not visited, to avoid double-processing) and everything except a
 * braced `namespace_definition` itself (its body is walked in its place, at
 * the same top level, mirroring `collectTypeNodes`'s own namespace-threading
 * rule so the two walks agree on what "top level" means for the same file).
 * An unbraced `namespace X;` declaration contributes no statement of its own
 * but doesn't end the walk — its later siblings are still top-level. This is
 * a SHALLOW, direct-children-only walk (unlike `collectTypeNodes`'s
 * unbounded recursion, and unlike `collectCallSites`'s unbounded descent) —
 * a statement nested inside a block (an `if`/`for`/`function_definition`
 * body) is never itself a top-level statement, only whichever wrapping
 * statement node directly under the root/namespace body contains it is
 * (e.g. the whole `if_statement`) — matching the task's own scope: PHP's
 * realistic composer-bin/`public/index.php` shape is a flat sequence of
 * top-level statements, not nested function/class definitions.
 */
function collectTopLevelStatements(node: TsNode, out: TsNode[]): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "namespace_definition") {
      const body = firstChildOfType(child, "compound_statement");
      if (body) collectTopLevelStatements(body, out);
      continue; // unbraced (no body) -> contributes nothing itself, but the loop continues to later siblings
    }
    if (KIND_BY_NODE_TYPE[child.type]) continue; // class/interface/trait/enum -> the existing per-class loop's job
    out.push(child);
  }
}

/**
 * A top-level script's local `new`-typed variable environment: variable name
 * (no `$`) -> raw class-name text, built from direct `$var = new
 * ClassName();` assignments among `statements` (a file's TOP-LEVEL statement
 * list, per `collectTopLevelStatements` — never a nested assignment inside
 * an `if`/`for` block, matching the task's "direct... in the same top-level
 * statement list" scope). "One variable, one type, no reassignment/
 * control-flow tracking" is enforced literally: a variable qualifies only
 * when it has EXACTLY ONE top-level assignment overall (of any shape) and
 * that lone assignment is a direct `new ClassName()`/`new Qualified\Name()`
 * expression — a second assignment anywhere at top level (to the same class
 * again, to a different class, or to any non-`new` expression, e.g. `$x =
 * someFunction();`) excludes the variable from the environment entirely,
 * never guessing which assignment is "current" at the call site. A dynamic
 * class name (`new $cls()`) also fails closed (its class-name child is
 * `variable_name`, not `name`/`qualified_name` — see
 * `classNameOfNewExpression`), same as `resolveClauseTargets`'s existing
 * `name`/`qualified_name` filter elsewhere in this module.
 */
function buildTopLevelNewEnv(
  statements: readonly TsNode[],
): Map<string, string> {
  const counts = new Map<string, number>();
  const newClassText = new Map<string, string>();

  for (const stmt of statements) {
    if (stmt.type !== "expression_statement") continue;
    const assign = stmt.namedChild(0);
    if (assign?.type !== "assignment_expression") continue;

    const left = assign.childForFieldName("left");
    if (left?.type !== "variable_name") continue;
    const varName = variableNameText(left);
    if (varName === null) continue;

    counts.set(varName, (counts.get(varName) ?? 0) + 1);

    const right = assign.childForFieldName("right");
    const classNameNode =
      right?.type === "object_creation_expression"
        ? classNameOfNewExpression(right)
        : null;
    if (classNameNode) newClassText.set(varName, classNameNode.text);
  }

  const env = new Map<string, string>();
  for (const [varName, count] of counts) {
    if (count !== 1) continue; // reassigned (to anything) at top level -> fail closed, no guessing
    const classText = newClassText.get(varName);
    if (classText) env.set(varName, classText);
  }
  return env;
}

/** `object_creation_expression`'s class-name child — always its first named child, live-verified as either a bare `name` or a `qualified_name`; a dynamic class name (`new $cls()`) is a `variable_name` there instead and returns `null` (fail closed, no synthetic-name guessing). No dedicated field name exists for this child (verified live against the grammar). */
function classNameOfNewExpression(objectCreation: TsNode): TsNode | null {
  const child = objectCreation.namedChild(0);
  if (child && (child.type === "name" || child.type === "qualified_name"))
    return child;
  return null;
}

/**
 * Resolve a top-level `member_call_expression`'s `object:` node to the FQCN
 * it statically refers to — the top-level counterpart of `resolveObjectType`,
 * deliberately NOT a reuse of it: there is no `$this` at top level (no
 * enclosing class) and no typed-parameter/typed-property context, so this
 * only handles the bare `variable_name` case (via `env`, built by
 * `buildTopLevelNewEnv`) — no property-hop chaining (`$var->prop->method()`)
 * either, since the realistic composer-bin/`public/index.php` shape this
 * task targets doesn't need it (scoped narrowly on purpose, matching the
 * task's own guidance).
 */
function resolveTopLevelObjectType(
  node: TsNode,
  env: ReadonlyMap<string, string>,
  namespace: string,
  imports: readonly PhpImport[],
  classToFile: ReadonlyMap<string, string>,
): string | null {
  if (node.type !== "variable_name") return null; // no $this, no member-access chaining at top level -> fail closed
  const varName = variableNameText(node);
  if (varName === null) return null;
  const typeText = env.get(varName);
  if (!typeText) return null;
  return resolvePhpClassReference(typeText, namespace, imports, classToFile)
    .fqcn;
}

/**
 * Every `member_call_expression` anywhere in a method body, including nested
 * inside another call's own `object:`/`arguments:` (each resolved
 * independently). Stops descent at a nested `method_declaration` — the only
 * way one appears while already inside a method body is an anonymous class
 * (`new class { ... }`, whose members sit directly under an
 * `object_creation_expression`'s own `declaration_list`, live-verified) —
 * whose `$this` refers to a *different* object than the enclosing method's,
 * so its calls must never be attributed to the enclosing method. Closures
 * (`anonymous_function_creation_expression`) are walked normally: PHP binds
 * a non-`static` closure's `$this` to the enclosing method's own object, so
 * `$this`-directed calls inside one are correctly the enclosing method's.
 */
function collectCallSites(node: TsNode, out: TsNode[]): void {
  if (node.type === "method_declaration") return;
  if (node.type === "member_call_expression") out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectCallSites(child, out);
  }
}

/**
 * A method's typed-parameter environment: variable name (no `$`) -> raw
 * declared-type text, for every `simple_parameter` *and*
 * `property_promotion_parameter` whose `type:` field is a bare `named_type`
 * (matching T1's own `declaredType` rule — `optional_type`/`union_type`/
 * `primitive_type` carry no usable class type). Promoted-parameter inclusion
 * is a deliberate, documented decision (not T1's scope): it makes a
 * constructor-body reference to the parameter itself (`$foo->bar()` inside
 * `__construct(private Foo $foo) {}`) resolve, while `$this->foo->bar()`
 * anywhere else still fails closed, since T1 never records a promoted
 * parameter as a `DeclaredProperty` — only `property_declaration` nodes are.
 */
function buildParamEnv(methodDecl: TsNode): Map<string, string> {
  const env = new Map<string, string>();
  const params = methodDecl.childForFieldName("parameters");
  if (!params) return env;

  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i);
    if (
      !param ||
      (param.type !== "simple_parameter" &&
        param.type !== "property_promotion_parameter")
    )
      continue;

    const typeNode = param.childForFieldName("type");
    if (typeNode?.type !== "named_type") continue;

    const nameNode = param.childForFieldName("name");
    if (!nameNode) continue;
    const varName = variableNameText(nameNode);
    if (varName === null) continue;

    env.set(varName, typeNode.text);
  }

  return env;
}

/** `variable_name`'s inner `name` child's text — no leading `$` (matches T1's own unwrapping convention). */
function variableNameText(variableName: TsNode): string | null {
  return firstChildOfType(variableName, "name")?.text ?? null;
}

function firstChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

function namespaceNameText(node: TsNode): string {
  const segments: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === "name") segments.push(child.text);
  }
  return segments.join("\\");
}

/**
 * Walk `node`'s named children, threading a mutable "current namespace"
 * through braceless `namespace_definition` siblings, capturing every class/
 * interface/trait/enum declaration node (+ its `body` field) paired with its
 * computed FQCN. Deliberately mirrors `declared-symbols.ts`'s own
 * `walkChildren`/`walkNode` namespace-tracking algorithm exactly (not
 * exported from there, so duplicated here) so this walk's fqcn/kind pairs
 * always agree with `extractDeclaredSymbols`' output for the same file.
 */
function collectTypeNodes(node: TsNode, ns: string, out: TypeNodeRef[]): void {
  let currentNs = ns;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    currentNs = visitForTypeNodes(child, currentNs, out);
  }
}

function visitForTypeNodes(
  node: TsNode,
  ns: string,
  out: TypeNodeRef[],
): string {
  if (node.type === "namespace_definition") {
    const nameNode = firstChildOfType(node, "namespace_name");
    const nsName = nameNode ? namespaceNameText(nameNode) : "";
    const body = firstChildOfType(node, "compound_statement");
    if (body) {
      collectTypeNodes(body, nsName, out);
      return ns;
    }
    return nsName;
  }

  const kind = KIND_BY_NODE_TYPE[node.type];
  if (kind) {
    const nameNode = firstChildOfType(node, "name");
    if (nameNode) {
      out.push({
        fqcn: ns ? `${ns}\\${nameNode.text}` : nameNode.text,
        kind,
        node,
        body: node.childForFieldName("body"),
      });
    }
  }

  collectTypeNodes(node, ns, out);
  return ns;
}
