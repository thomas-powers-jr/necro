import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "../../syntactic/parse.js";

export type DeclaredSymbolKind = "class" | "interface" | "trait" | "enum";

/** A method declared directly in a class/interface/trait/enum's own body (name + 1-based declaration line). */
export interface DeclaredMethod {
  name: string;
  line: number;
}

/**
 * A property declared directly in a class/interface/trait's own body
 * (name + 1-based declaration line). `declaredType` is present only when the
 * property's `type:` field is itself a bare `named_type` node — e.g. `Bar
 * $bar` — not when it's wrapped (`?Bar $bar` is `optional_type`, `Bar|Baz
 * $bar` is `union_type`) or a scalar (`string $x` is `primitive_type`); those
 * shapes intentionally carry no `declaredType` here (live-verified against
 * `tree-sitter-php.wasm`, not assumed).
 */
export interface DeclaredProperty {
  name: string;
  line: number;
  declaredType?: string;
}

export interface DeclaredSymbol {
  fqcn: string;
  kind: DeclaredSymbolKind;
  file: string;
  /** Methods declared directly in this type's own body (never inherited/composed). */
  methods: DeclaredMethod[];
  /** Properties declared directly in this type's own body (never inherited/composed). */
  properties: DeclaredProperty[];
}

const KIND_BY_NODE_TYPE: Record<string, DeclaredSymbolKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

/**
 * Extract every class/interface/trait/enum declaration in a PHP file, tracking
 * the namespace each one is declared under — both the braceless (`namespace
 * X;`, applies to subsequent siblings until the next `namespace_definition`
 * or EOF) and braced (`namespace X { ... }`, scoped to its own body) forms.
 * Walks the whole tree, not just top-level children: composer's real classmap
 * generator finds declarations anywhere (e.g. a common polyfill pattern
 * declares a class inside `if (!class_exists(...)) { ... }`), so restricting
 * to direct top-level children would miss real, autoloadable declarations.
 */
export async function extractDeclaredSymbols(
  file: string,
  source: string,
): Promise<DeclaredSymbol[]> {
  const parser = await getParser(file);
  const tree = parser.parse(source);
  if (!tree) return [];

  const out: DeclaredSymbol[] = [];
  walkChildren(tree.rootNode, "", out, file);
  return out;
}

function firstChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

/**
 * Extract every `method_declaration` and `property_declaration` that is a
 * *direct* named child of `body` — a class/interface/trait's own
 * `declaration_list`, or an enum's own `enum_declaration_list` (a distinct
 * node type from `declaration_list`, live-verified against
 * `tree-sitter-php.wasm`; both are handled uniformly here since this walk
 * only matches by child node type, not by the container's own type). Never
 * recurses into a member's own body, so a method-body-local anonymous class
 * declaration's members are never misattributed to the enclosing type.
 */
function extractMembers(body: TsNode): {
  methods: DeclaredMethod[];
  properties: DeclaredProperty[];
} {
  const methods: DeclaredMethod[] = [];
  const properties: DeclaredProperty[] = [];

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    if (child.type === "method_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode)
        methods.push({
          name: nameNode.text,
          line: nameNode.startPosition.row + 1,
        });
      continue;
    }

    if (child.type === "property_declaration") {
      const typeNode = child.childForFieldName("type");
      const declaredType =
        typeNode?.type === "named_type" ? typeNode.text : undefined;

      for (let j = 0; j < child.namedChildCount; j++) {
        const element = child.namedChild(j);
        if (element?.type !== "property_element") continue;
        const varNode = firstChildOfType(element, "variable_name");
        const nameNode = varNode ? firstChildOfType(varNode, "name") : null;
        if (!nameNode) continue;
        properties.push({
          name: nameNode.text,
          line: nameNode.startPosition.row + 1,
          ...(declaredType !== undefined ? { declaredType } : {}),
        });
      }
    }
  }

  return { methods, properties };
}

function namespaceNameText(node: TsNode): string {
  const segments: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === "name") segments.push(child.text);
  }
  return segments.join("\\");
}

/** Walk `node`'s named children in order, threading a mutable "current namespace" through braceless `namespace_definition` siblings. */
function walkChildren(
  node: TsNode,
  ns: string,
  out: DeclaredSymbol[],
  file: string,
): void {
  let currentNs = ns;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    currentNs = walkNode(child, currentNs, out, file);
  }
}

function walkNode(
  node: TsNode,
  ns: string,
  out: DeclaredSymbol[],
  file: string,
): string {
  if (node.type === "namespace_definition") {
    const nameNode = firstChildOfType(node, "namespace_name");
    const nsName = nameNode ? namespaceNameText(nameNode) : "";
    const body = firstChildOfType(node, "compound_statement");
    if (body) {
      walkChildren(body, nsName, out, file);
      return ns;
    }
    return nsName;
  }

  const kind = KIND_BY_NODE_TYPE[node.type];
  if (kind) {
    const nameNode = firstChildOfType(node, "name");
    if (nameNode) {
      const body = node.childForFieldName("body");
      const { methods, properties } = body
        ? extractMembers(body)
        : { methods: [], properties: [] };
      out.push({
        fqcn: ns ? `${ns}\\${nameNode.text}` : nameNode.text,
        kind,
        file,
        methods,
        properties,
      });
    }
  }

  walkChildren(node, ns, out, file);
  return ns;
}
