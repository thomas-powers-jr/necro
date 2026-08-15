import { readFile } from "node:fs/promises";
import type { SymbolNode } from "../types.js";
import { extractDeclaredSymbols } from "./declared-symbols.js";

/**
 * Build the PHP symbol graph's *nodes* — one `SymbolNode` per method and
 * property declared directly in a class/interface/trait/enum's own body
 * (never the type declaration itself). This is the inverse of Python's
 * granularity (`buildPythonSymbolGraph` emits nodes for top-level
 * declarations and explicitly excludes methods, "parity with TS"): PHP's
 * dead-code target unit is the class member, since a PHP class is almost
 * always reachable via autoloading the moment anything references it, while
 * individual unused methods/properties are the real signal.
 *
 * A 2-step pipeline (extract → resolve), not Python's 3-step
 * `detectImportRoots` → `buildPythonModuleMap` → `buildPythonSymbolGraph`:
 * Phase B's composer-autoload map already does the work of Python's first
 * two steps, so this module needs no module-map argument.
 *
 * Edges are a separate concern — T2 (`reference-edges.ts`, not yet built)
 * resolves trait/interface/typed-`->`-chain references separately; this
 * module only maps T1's extended `extractDeclaredSymbols` output onto the
 * shared `SymbolNode` id shape (`${file}:${line}:${name}`,
 * `src/graph/types.ts`).
 *
 * `exported` is `true` for every node: this task extracts no
 * visibility/modifier information (out of AC-1's scope — only name+line for
 * methods, name+line+declaredType for properties), so every member is
 * treated the same conservative way the rest of this project treats
 * ambiguous PHP data — never assumed `certain`-tier-safe, matching AC-6's
 * unconditional PHP tier cap (`classify.ts`'s `isPhpFile` branch caps
 * `certain` to `likely` regardless of this flag).
 */
export async function buildPhpSymbolGraph(
  files: string[],
): Promise<SymbolNode[]> {
  const nodes: SymbolNode[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const symbols = await extractDeclaredSymbols(file, source);

    for (const symbol of symbols) {
      for (const method of symbol.methods) {
        nodes.push({
          id: `${file}:${method.line}:${method.name}`,
          name: method.name,
          file,
          line: method.line,
          exported: true,
        });
      }
      for (const property of symbol.properties) {
        nodes.push({
          id: `${file}:${property.line}:${property.name}`,
          name: property.name,
          file,
          line: property.line,
          exported: true,
        });
      }
    }
  }

  return nodes;
}
