import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "../../syntactic/parse.js";

export type PhpImportKind = "class" | "function" | "const";

export interface PhpImport {
  /** Name bound into the importing file's namespace. */
  localName: string;
  fqcn: string;
  kind: PhpImportKind;
}

export interface PhpFileImports {
  /**
   * The file's current namespace, `""` for the global namespace. Assumes a
   * single namespace declaration per file (the last one seen wins if there
   * are more) — the overwhelmingly common modern PSR-4 convention this
   * phase's corpus (guzzle, phpunit) uses. Braced multi-namespace-per-file
   * blocks (`namespace A { ... } namespace B { ... }`) are not separately
   * scoped; a real (rare) multi-namespace file would misattribute `use`
   * declarations across blocks to one `namespace` value. Documented
   * limitation, not exercised by this phase's real-repo corpus.
   */
  namespace: string;
  imports: PhpImport[];
}

/** Parse a PHP file's `namespace` declaration and every `use` import, anywhere in the tree (including inside a braced namespace body). */
export async function parsePhpImports(
  file: string,
  source: string,
): Promise<PhpFileImports> {
  const parser = await getParser(file);
  const tree = parser.parse(source);
  if (!tree) return { namespace: "", imports: [] };

  const imports: PhpImport[] = [];
  const nsRef = { value: "" };
  walk(tree.rootNode, imports, nsRef);
  return { namespace: nsRef.value, imports };
}

function walk(
  node: TsNode,
  imports: PhpImport[],
  nsRef: { value: string },
): void {
  if (node.type === "namespace_definition") {
    const nameNode = firstChildOfType(node, "namespace_name");
    nsRef.value = nameNode ? namespaceNameText(nameNode) : "";
  } else if (node.type === "namespace_use_declaration") {
    imports.push(...parseUseDeclaration(node));
    return;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, imports, nsRef);
  }
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

/** The full dotted text of a `qualified_name` node — its optional `namespace_name_as_prefix` segments, followed by its trailing `name` segment. */
function qualifiedNameText(qualified: TsNode): string {
  const segments: string[] = [];
  for (let i = 0; i < qualified.namedChildCount; i++) {
    const child = qualified.namedChild(i);
    if (!child) continue;
    if (child.type === "namespace_name_as_prefix") {
      const nsName = firstChildOfType(child, "namespace_name");
      if (nsName) segments.push(namespaceNameText(nsName));
    } else if (child.type === "name") {
      segments.push(child.text);
    }
  }
  return segments.join("\\");
}

function aliasOf(node: TsNode): string | null {
  const aliasNode = firstChildOfType(node, "namespace_aliasing_clause");
  if (!aliasNode) return null;
  return firstChildOfType(aliasNode, "name")?.text ?? null;
}

function lastSegmentOf(dotted: string): string {
  const segments = dotted.split("\\");
  return segments[segments.length - 1] ?? dotted;
}

/**
 * `function`/`const` distinguishes composer-autoloadable class-like imports
 * from function/const imports (which `psr-4`/`psr-0`/`classmap` never
 * autoload — only a `files`-autoload script can define them). Verified live:
 * the keyword, when present, is an unnamed token child of
 * `namespace_use_declaration` itself (not a named field), immediately after
 * `use` and before the clause/group — checked declaration-wide rather than
 * positionally, since a grouped `use function Foo\{bar, baz};` applies the
 * keyword once for the whole group, not per clause. Per-clause mixed-kind
 * groups (`use Foo\{ClassA, function bar};`, valid but rare PHP) are not
 * handled — every clause in such a group would be misclassified as `kind:
 * "class"` — an accepted, documented limitation.
 */
function declarationKind(node: TsNode): PhpImportKind {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.isNamed) continue;
    if (child.type === "function") return "function";
    if (child.type === "const") return "const";
  }
  return "class";
}

function parseUseDeclaration(node: TsNode): PhpImport[] {
  const kind = declarationKind(node);

  const clause = firstChildOfType(node, "namespace_use_clause");
  if (clause) {
    const imp = parseSimpleClause(clause, kind);
    return imp ? [imp] : [];
  }

  const group = firstChildOfType(node, "namespace_use_group");
  if (group) {
    const prefixNode = firstChildOfType(node, "namespace_name");
    const prefix = prefixNode ? namespaceNameText(prefixNode) : "";
    const out: PhpImport[] = [];
    for (let i = 0; i < group.namedChildCount; i++) {
      const clauseNode = group.namedChild(i);
      if (clauseNode?.type !== "namespace_use_group_clause") continue;
      const imp = parseGroupClause(clauseNode, prefix, kind);
      if (imp) out.push(imp);
    }
    return out;
  }

  return [];
}

function parseSimpleClause(
  clause: TsNode,
  kind: PhpImportKind,
): PhpImport | null {
  const alias = aliasOf(clause);

  const qualified = firstChildOfType(clause, "qualified_name");
  if (qualified) {
    const fqcn = qualifiedNameText(qualified);
    return { localName: alias ?? lastSegmentOf(fqcn), fqcn, kind };
  }

  const bare = firstChildOfType(clause, "name");
  if (bare) return { localName: alias ?? bare.text, fqcn: bare.text, kind };

  return null;
}

function parseGroupClause(
  clauseNode: TsNode,
  prefix: string,
  kind: PhpImportKind,
): PhpImport | null {
  const nameNode = firstChildOfType(clauseNode, "namespace_name");
  if (!nameNode) return null;
  const suffix = namespaceNameText(nameNode);
  const fqcn = prefix ? `${prefix}\\${suffix}` : suffix;
  const alias = aliasOf(clauseNode);
  return { localName: alias ?? lastSegmentOf(suffix), fqcn, kind };
}
