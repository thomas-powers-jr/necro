import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";

type Grammar = "typescript" | "tsx" | "python" | "php";

const parserPromises = new Map<Grammar, Promise<Parser>>();
let runtimeInit: Promise<void> | null = null;

/** JSX can appear in `.tsx`/`.jsx`; `.py` needs the Python grammar; `.php` needs the PHP grammar; every other extension parses as plain TypeScript. */
function grammarFor(file: string): Grammar {
  const ext = extname(file);
  if (ext === ".tsx" || ext === ".jsx") return "tsx";
  if (ext === ".py") return "python";
  if (ext === ".php") return "php";
  return "typescript";
}

/**
 * Lazily initialize a tree-sitter parser bound to the grammar `file`'s
 * extension needs. Heavy (WASM init + grammar load), so each grammar is
 * created once and cached — callers on the dead-code/`fix` paths never
 * trigger it. The grammar wasm is resolved at runtime from `node_modules`
 * (kept external; never bundled by esbuild). The plain `typescript` grammar
 * mis-parses JSX (reads `<div>` as a type assertion), so `.tsx`/`.jsx` use
 * the `tsx` grammar instead.
 */
export async function getParser(file: string): Promise<Parser> {
  const grammar = grammarFor(file);
  let promise = parserPromises.get(grammar);
  if (!promise) {
    promise = init(grammar);
    parserPromises.set(grammar, promise);
  }
  return promise;
}

function ensureRuntime(): Promise<void> {
  if (!runtimeInit) runtimeInit = Parser.init();
  return runtimeInit;
}

async function init(grammar: Grammar): Promise<Parser> {
  await ensureRuntime();
  const require = createRequire(import.meta.url);
  const grammarRoot = dirname(
    require.resolve("tree-sitter-wasms/package.json"),
  );
  const wasmPath = join(grammarRoot, "out", `tree-sitter-${grammar}.wasm`);
  const lang = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
