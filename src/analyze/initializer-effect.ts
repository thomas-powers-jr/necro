import type { SourceFile } from "ts-morph";
import { Node, Project, SyntaxKind } from "ts-morph";
import { isPhpFile } from "../graph/php/language.js";
import { isPythonFile } from "../graph/python/language.js";
import { collectDeclarations } from "../graph/symbol-graph.js";
import type { SymbolNode } from "../graph/types.js";

/** Whether a symbol's initializer may run I/O with an externally observable effect. */
export type InitializerEffect = "pure" | "effectful" | "unknown";

/**
 * Actually-I/O-performing exports of `node:fs`/`node:child_process` — deliberately
 * narrow (e.g. excludes `existsSync`, a read-only probe with no side effect) so
 * this screen only fires on operations that mutate disk state, spawn a process,
 * or can throw on a missing file (phase 68, evidence from phase 67's corpus).
 */
const DENYLIST: Record<string, ReadonlySet<string> | undefined> = {
  "node:fs": new Set([
    "readFileSync",
    "readFile",
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "appendFile",
    "unlinkSync",
    "unlink",
    "mkdirSync",
    "mkdir",
    "rmSync",
    "rm",
    "rmdirSync",
    "rmdir",
    "renameSync",
    "rename",
    "copyFileSync",
    "copyFile",
  ]),
  "node:child_process": new Set([
    "execSync",
    "exec",
    "execFileSync",
    "execFile",
    "spawnSync",
    "spawn",
    "fork",
  ]),
};
DENYLIST.fs = DENYLIST["node:fs"];
DENYLIST["node:fs/promises"] = DENYLIST["node:fs"];
DENYLIST["fs/promises"] = DENYLIST["node:fs"];
DENYLIST.child_process = DENYLIST["node:child_process"];

/**
 * Builds an `initializerEffect` resolver for one scan. The source-file cache is
 * scoped to the returned closure (not module-global) so a long-running host
 * (e.g. the MCP server) never accumulates parsed files across scans.
 */
export function createInitializerEffectResolver(): (
  node: SymbolNode,
) => InitializerEffect {
  const sourceFiles = new Map<string, SourceFile | null>();

  const getSourceFile = (file: string): SourceFile | null => {
    const cached = sourceFiles.get(file);
    if (cached !== undefined) return cached;
    let sf: SourceFile | null;
    try {
      const project = new Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true },
      });
      sf = project.addSourceFileAtPath(file);
    } catch {
      sf = null;
    }
    sourceFiles.set(file, sf);
    return sf;
  };

  return (node: SymbolNode): InitializerEffect => {
    if (isPythonFile(node.file)) return "unknown";
    if (isPhpFile(node.file)) return "unknown";
    const sf = getSourceFile(node.file);
    if (!sf) return "unknown";
    return initializerEffectForDeclaration(sf, node.name, node.line);
  };
}

/**
 * Core resolution logic, decoupled from disk I/O so it can be exercised
 * directly against an in-memory `SourceFile` in tests.
 */
export function initializerEffectForDeclaration(
  sf: SourceFile,
  name: string,
  line: number,
): InitializerEffect {
  const decl = collectDeclarations(sf).find(
    (d) => d.name === name && d.nameNode.getStartLineNumber() === line,
  );
  if (!decl || !Node.isVariableDeclaration(decl.declNode)) return "unknown";
  const initializer = decl.declNode.getInitializer();
  if (!initializer) return "pure";
  if (isFunctionLike(initializer)) return "pure"; // uninvoked function definition
  return containsDenylistedCall(initializer, 1) ? "effectful" : "pure";
}

function isFunctionLike(n: Node): boolean {
  return Node.isArrowFunction(n) || Node.isFunctionExpression(n);
}

function getFunctionBody(fn: Node): Node | undefined {
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))
    return fn.getBody();
  return undefined;
}

/**
 * Walks the initializer looking for a call that resolves to the I/O denylist.
 * `NewExpression`s are opaque (never inspected, never effectful — AC-3: every
 * constructor call in the phase-67 corpus was a false positive). Descends into
 * a function body found as a call's argument or callee exactly one level (the
 * `run(() => { ...fs.readFileSync... })` wrapper shape from the `cert` corpus
 * case) — no deeper, to avoid re-deriving phase 65's blast-radius failure.
 */
function containsDenylistedCall(root: Node, fnDepthRemaining: number): boolean {
  if (Node.isNewExpression(root)) return false;
  if (Node.isCallExpression(root) && isDenylistedCallee(root)) return true;
  for (const child of root.getChildren()) {
    if (isFunctionLike(child)) {
      if (fnDepthRemaining <= 0) continue;
      const body = getFunctionBody(child);
      if (body && containsDenylistedCall(body, fnDepthRemaining - 1))
        return true;
      continue;
    }
    if (containsDenylistedCall(child, fnDepthRemaining)) return true;
  }
  return false;
}

function isDenylistedCallee(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const expr = call.getExpression();

  if (Node.isIdentifier(expr)) {
    const binding = resolveImportBinding(expr);
    if (!binding) return false;
    return DENYLIST[binding.moduleName]?.has(binding.importedName) ?? false;
  }

  if (Node.isPropertyAccessExpression(expr)) {
    const object = expr.getExpression();
    if (!Node.isIdentifier(object)) return false;
    const binding = resolveImportBinding(object);
    if (!binding) return false;
    return DENYLIST[binding.moduleName]?.has(expr.getName()) ?? false;
  }

  return false;
}

/**
 * Resolves an identifier to the module it's imported from. `importedName` is
 * the *original* exported name for a named import (survives local aliasing,
 * e.g. `readFileSync as rfs`), or `"*"` for a namespace/default import — a
 * sentinel that never matches a denylist entry on its own, so a bare call
 * through a namespace binding correctly falls through to "not denylisted"
 * (the member-access branch above is what checks namespace-import calls).
 */
function resolveImportBinding(
  identifier: Node,
): { moduleName: string; importedName: string } | undefined {
  if (!Node.isIdentifier(identifier)) return undefined;
  const decls = identifier.getSymbol()?.getDeclarations() ?? [];
  for (const decl of decls) {
    if (Node.isImportSpecifier(decl)) {
      const importDecl = decl.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration,
      );
      const moduleName = importDecl?.getModuleSpecifierValue();
      if (!moduleName) continue;
      return { moduleName, importedName: decl.getName() };
    }
    if (Node.isNamespaceImport(decl) || Node.isImportClause(decl)) {
      const importDecl = decl.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration,
      );
      const moduleName = importDecl?.getModuleSpecifierValue();
      if (!moduleName) continue;
      return { moduleName, importedName: "*" };
    }
  }
  return undefined;
}
