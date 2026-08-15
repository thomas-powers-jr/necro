import type { PhpImport } from "./import-parser.js";

export interface ResolvedPhpClass {
  /** The fully-qualified class name this reference resolved to. */
  fqcn: string;
  /** The file it resolves to via the autoload map, or `null` if unresolved. */
  file: string | null;
}

/**
 * Resolve a class-reference name (a `use` target, an `extends`/`implements`
 * clause, `new X()`, or the class side of `X::method()`) to its fully-
 * qualified name and, via `autoloadMap` (T2's `classToFile`), its file —
 * PHP's actual class-name resolution rules
 * (https://www.php.net/manual/en/language.namespaces.rules.php), not
 * assumed by analogy to JS's or Python's module resolution:
 *
 * 1. A leading-backslash name (`\Foo\Bar`) is always fully qualified —
 *    resolved directly, regardless of the current namespace or any `use`
 *    imports.
 * 2. Otherwise, the *first* segment is checked against `imports`' local
 *    names (class-kind only — function/const imports don't autoload
 *    class-like symbols this way): a match substitutes that import's FQCN
 *    for the first segment, with any remaining segments appended. This
 *    covers both the single-segment case (`Foo` after `use App\Foo;` — the
 *    single most common real-world pattern) and the qualified-relative case
 *    (`Sub\Foo` after `use App\Sub;`) with one rule, since PHP's own
 *    resolution algorithm treats them identically — only the *first*
 *    segment is ever import-substituted.
 * 3. If the first segment matches no import, the *whole* name is qualified
 *    by prepending the current namespace. Unlike PHP's function/const
 *    resolution, there is **no global-namespace fallback** for class names —
 *    an unqualified name with no matching import and no current namespace
 *    context still resolves to `CurrentNs\Name` (or just `Name` in the
 *    global namespace), never falls back to trying the bare name against
 *    the global namespace when a non-empty current namespace is active.
 */
export function resolvePhpClassReference(
  name: string,
  currentNamespace: string,
  imports: readonly PhpImport[],
  autoloadMap: ReadonlyMap<string, string>,
): ResolvedPhpClass {
  const fqcn = resolveFqcn(name, currentNamespace, imports);
  return { fqcn, file: autoloadMap.get(fqcn) ?? null };
}

function resolveFqcn(
  name: string,
  currentNamespace: string,
  imports: readonly PhpImport[],
): string {
  if (name.startsWith("\\")) return name.slice(1);

  const segments = name.split("\\");
  const first = segments[0] ?? name;
  const rest = segments.slice(1);

  const match = imports.find(
    (imp) => imp.kind === "class" && imp.localName === first,
  );
  if (match)
    return rest.length > 0 ? `${match.fqcn}\\${rest.join("\\")}` : match.fqcn;

  return currentNamespace ? `${currentNamespace}\\${name}` : name;
}
