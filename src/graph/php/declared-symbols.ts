import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "../../syntactic/parse.js";

export type DeclaredSymbolKind = "class" | "interface" | "trait" | "enum";

export interface DeclaredSymbol {
  fqcn: string;
  kind: DeclaredSymbolKind;
  file: string;
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
    if (nameNode)
      out.push({
        fqcn: ns ? `${ns}\\${nameNode.text}` : nameNode.text,
        kind,
        file,
      });
  }

  walkChildren(node, ns, out, file);
  return ns;
}
