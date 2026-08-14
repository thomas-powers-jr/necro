import { isPythonFile } from "../graph/python/language.js";
import type { SymbolEdge, SymbolNode } from "../graph/types.js";

export type Reachability = "alive" | "test-only" | "dead";

export interface ReachabilityResult {
  id: string;
  reachability: Reachability;
  /** Node lives in a region with dynamic dispatch — downstream tiering treats it as ambiguous. */
  tainted: boolean;
}

export interface ReachabilityInput {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  /** Prod roots (symbol ids or module file paths), alive by definition. */
  prodEntries: Set<string>;
  /** Test roots (symbol ids or module file paths). */
  testEntries: Set<string>;
  /** Files containing dynamic dispatch; nodes in them are marked tainted. */
  taintedFiles?: Set<string>;
}

/**
 * Two-color mark-and-sweep (§6):
 *   1. prod entries → BFS over prod edges      → reachedByProd
 *   2. all entries  → BFS over prod+test edges → reachedByAny
 * A node in reachedByProd is `alive`; in reachedByAny but not prod is `test-only`;
 * in neither is a `dead` candidate.
 */
export function computeReachability(
  input: ReachabilityInput,
): ReachabilityResult[] {
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  const taintedFiles = input.taintedFiles ?? new Set<string>();

  const reachedByProd = bfs(
    input.edges,
    input.prodEntries,
    nodeIds,
    (kind) => kind === "prod",
  );
  const reachedByAny = bfs(
    input.edges,
    union(input.prodEntries, input.testEntries),
    nodeIds,
    () => true,
  );

  return input.nodes.map((node) => ({
    id: node.id,
    reachability: classify(node.id, reachedByProd, reachedByAny),
    tainted: taintedFiles.has(node.file),
  }));
}

function classify(
  id: string,
  reachedByProd: Set<string>,
  reachedByAny: Set<string>,
): Reachability {
  if (reachedByProd.has(id)) return "alive";
  if (reachedByAny.has(id)) return "test-only";
  return "dead";
}

/**
 * BFS over edges from the seed roots, following only edges whose kind passes
 * `allow`. Seeds that are themselves node ids count as reached.
 */
function bfs(
  edges: SymbolEdge[],
  seeds: Set<string>,
  nodeIds: Set<string>,
  allow: (kind: SymbolEdge["kind"]) => boolean,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!allow(edge.kind)) continue;
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const reached = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (nodeIds.has(seed)) reached.add(seed);
    queue.push(seed);
  }

  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

function union<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a, ...b]);
}

/**
 * Reconstruct the shortest witness chain (`entry → … → target`) by breadth-first
 * search with parent tracking, following only edges whose kind passes `allow`
 * (the same predicate `computeReachability` uses, so a trace matches its verdict).
 * Returns the chain of ids from the reaching seed to `target`, or `null` if no
 * allowed path exists. A seed that is itself the target yields `[target]`.
 */
export function tracePath(
  edges: SymbolEdge[],
  entries: Set<string>,
  target: string,
  allow: (kind: SymbolEdge["kind"]) => boolean,
): string[] | null {
  if (entries.has(target)) return [target];

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!allow(edge.kind)) continue;
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const parent = new Map<string, string>();
  const visited = new Set<string>(entries);
  const queue: string[] = [...entries];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, current);
      if (next === target) {
        const path = [target];
        let cur: string | undefined = target;
        for (let p = parent.get(cur); p !== undefined; p = parent.get(cur)) {
          path.unshift(p);
          cur = p;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

// Shared across languages: both JS/TS and Python have `eval`.
const SHARED_TAINT_PATTERNS: RegExp[] = [
  /\beval\s*\(/, // eval
];

// string/computed dispatch: obj[name]() — also covers Python's globals()[name]().
// Optionally captures a bare identifier receiver immediately before `[` (no
// intervening `.`/`)`/`]`) so a same-file literal-dict binding can suppress
// this specific match; an unresolved or absent receiver still taints, so this
// stays a superset of the old receiver-blind pattern.
const BRACKET_CALL_TAINT_PATTERN =
  /([A-Za-z_$][\w$]*)?\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*\(/g;

// JS/TS-only: a bare `import(...)` call is a dynamic-import expression there.
// Excluded from Python, where the identical text shape — `import (\n    Name,`
// — is ordinary, fully-static multi-line `from x import (...)` syntax.
const JS_ONLY_TAINT_PATTERNS: RegExp[] = [
  /import\s*\(\s*`[^`]*\$\{/, // dynamic import with template interpolation
  /import\s*\(\s*[A-Za-z_$]/, // dynamic import of a variable
];

const PYTHON_ONLY_TAINT_PATTERNS: RegExp[] = [
  /\bgetattr\s*\(/, // dynamic attribute access
  /\bimportlib\b/, // importlib.import_module(...) dynamic import
  /__getattr__/, // module/class dynamic-attribute dispatch hook
  /\bexec\s*\(/, // exec
];

/**
 * A same-file dict-literal binding for `ident` makes a bracket-call match
 * resolvable: its values are ordinary identifier references the graph
 * already tracks, so it isn't the unresolvable dispatch this taint exists
 * for (rec-20260814-001). Scoped to the evidenced Python real-corpus shapes
 * only (pip's `handler_map = self.handler_map()` / `return {...}` pattern) —
 * no JS/TS corpus evidence exists for this, so JS/TS bracket-calls keep
 * tainting unconditionally, matching the pre-fix behavior.
 */
/**
 * Whether the `{` at `openBraceIndex` opens a genuine literal-dict body:
 * non-empty (an empty `{}` later populated by mutation, e.g.
 * `d = {}; d["a"] = v`, must NOT resolve — that's exactly the
 * unresolvable-at-a-glance shape this taint guards) and not a comprehension
 * (`{k: v for k, v in pairs}` has runtime-computed, not enumerable, values).
 */
function isLiteralDictBody(text: string, openBraceIndex: number): boolean {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = text.slice(openBraceIndex + 1, i);
        return body.trim().length > 0 && !/\bfor\b/.test(body);
      }
    }
  }
  return false; // unbalanced — bail conservatively, leave tainted
}

function isSameFileLiteralDictBinding(
  file: string,
  text: string,
  ident: string,
): boolean {
  if (!isPythonFile(file)) return false;
  const id = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // (a) direct literal assignment: `ident = {...}`.
  const directAssign = new RegExp(`(^|\\n)\\s*${id}\\s*=\\s*\\{`).exec(text);
  if (directAssign) {
    const openBrace = directAssign.index + directAssign[0].length - 1;
    if (isLiteralDictBody(text, openBrace)) return true;
  }

  // (b) `ident = self.ident()` where `def ident(self...):` returns a literal
  // dict — the real pip shape. Independent of (a): either succeeding
  // suppresses; (a) failing must not short-circuit (b).
  const selfCallAssign = new RegExp(
    `(^|\\n)\\s*${id}\\s*=\\s*self\\s*\\.\\s*${id}\\s*\\(\\s*\\)`,
  );
  const methodReturnsDict = new RegExp(
    `def\\s+${id}\\s*\\([^)]*\\)\\s*(->[^:\\n]+)?:\\s*\\n\\s*return\\s*\\{`,
  ).exec(text);
  if (selfCallAssign.test(text) && methodReturnsDict) {
    const openBrace = methodReturnsDict.index + methodReturnsDict[0].length - 1;
    if (isLiteralDictBody(text, openBrace)) return true;
  }

  return false;
}

/** Whether the file has at least one bracket-call dispatch site the graph can't resolve. */
function hasUnresolvedBracketDispatch(file: string, text: string): boolean {
  BRACKET_CALL_TAINT_PATTERN.lastIndex = 0;
  let match = BRACKET_CALL_TAINT_PATTERN.exec(text);
  while (match) {
    const receiver = match[1];
    if (!receiver || !isSameFileLiteralDictBinding(file, text, receiver)) {
      return true;
    }
    match = BRACKET_CALL_TAINT_PATTERN.exec(text);
  }
  return false;
}

/** Detect files containing dynamic dispatch the static graph cannot resolve. */
export function findTaintedFiles(
  sources: Array<{ file: string; text: string }>,
): Set<string> {
  const tainted = new Set<string>();
  for (const { file, text } of sources) {
    const languagePatterns = isPythonFile(file)
      ? PYTHON_ONLY_TAINT_PATTERNS
      : JS_ONLY_TAINT_PATTERNS;
    const patterns = [...SHARED_TAINT_PATTERNS, ...languagePatterns];
    if (
      patterns.some((re) => re.test(text)) ||
      hasUnresolvedBracketDispatch(file, text)
    ) {
      tainted.add(file);
    }
  }
  return tainted;
}
