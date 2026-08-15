import type { Node as TsNode } from "web-tree-sitter";
import { getParser } from "./parse.js";

/** A normalized token: its Type-2 form plus the 1-based source line. */
export interface Token {
  norm: string;
  line: number;
}

const IDENTIFIER_KINDS = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "type_identifier",
  "private_property_identifier",
  // PHP: one shared leaf node for variable/function/class/method names
  "name",
]);

const LITERAL_KINDS = new Set([
  "number",
  "string_fragment",
  "regex_pattern",
  "template_chars",
  "true",
  "false",
  // Python
  "integer",
  "float",
  "string_content",
  // PHP: `integer`/`float`/`string_content` above are already identical to
  // Python's node types, verified shared. `boolean` is PHP's single node for
  // both true/false (unlike JS's separate leaves) — folds to LIT to match
  // JS's true/false treatment. `null` is deliberately NOT added here — it
  // falls through to its own `null` token kind, matching how JS's `null`
  // and Python's `none` both stay unfolded rather than joining LIT.
  "boolean",
]);

/**
 * Tokenize a source file into a normalized (Type-2) stream: identifiers → `ID`,
 * literals → `LIT`, comments dropped, everything else keyed by its token kind.
 * This is the only duplication code that names tree-sitter/TS constructs.
 */
export async function tokenize(file: string, source: string): Promise<Token[]> {
  const parser = await getParser(file);
  const tree = parser.parse(source);
  if (!tree) return [];

  const tokens: Token[] = [];
  walk(tree.rootNode, tokens);
  return tokens;
}

function walk(node: TsNode, out: Token[]): void {
  if (node.type === "comment") return;
  if (node.childCount === 0) {
    const norm = normalize(node);
    if (norm !== null) out.push({ norm, line: node.startPosition.row + 1 });
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, out);
  }
}

function normalize(leaf: TsNode): string | null {
  if (leaf.type === "comment") return null;
  if (leaf.text === "") return null;
  if (IDENTIFIER_KINDS.has(leaf.type)) return "ID";
  if (LITERAL_KINDS.has(leaf.type)) return "LIT";
  return leaf.type;
}
