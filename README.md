# Necro

**Find dead code with evidence, not guesses.** Necro is a local, free, polyglot
CLI that finds anti-pattern code and proposes LLM-assisted fixes — and refuses
to guess where pure-static tools can't.

> **Status: v1.6.0 — published on [npm](https://www.npmjs.com/package/@manehorizons/necro).**
> Necro analyzes **TypeScript/JavaScript and Python** across
> multiple axes — dead code (with confidence tiers, evidence chains, and the
> `test-only` verdict), complexity, risk hotspots, and duplication — plus safe
> dead-code removal (`fix`), a `baseline` / `// necro-ignore` suppression path,
> LLM triage of ambiguous findings (`triage`),
> LLM-assisted refactors (`refactor`), and a read-only [MCP server](#use-from-an-ai-agent-mcp)
> for AI agents (`mcp`), **SARIF output + `--fail-on` gating + a GitHub Action**
> for CI. More framework plugins are on the [roadmap](#roadmap).

## Why Necro

Every analysis axis already has a strong incumbent, but no free, local tool
combines them with fix reasoning across languages. Necro targets that gap:

**free + local + multi-axis + LLM-assisted-fix + polyglot.**

Dead code means "unreachable from any entry point." Pure-static tools must make
a binary alive/dead call and eat the false positive when unsure. Necro's edge is
**refusing to guess**:

- **Confidence tiers** — `certain` / `likely` / `maybe`. Ambiguous code is
  quarantined in `maybe`, not falsely killed.
- **Evidence chains** — every finding ships its reasoning (static references,
  package exports, dynamic-import taint) so you audit the verdict.
- **The `test-only` verdict** — production-dead code kept warm only by tests, a
  signal no incumbent surfaces cleanly.
- **Semantic, not textual** — dead-code detection runs on the TypeScript
  compiler API (via [ts-morph](https://ts-morph.com)), following re-exports,
  type-only imports, and barrel files.

## Install

Requires **Node.js ≥ 20**.

Install globally from npm:

```bash
npm install -g @manehorizons/necro
necro scan src/
```

Or run it with no install (handy for agents and CI):

```bash
npx -y @manehorizons/necro scan src/
```

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/manehorizons/necro
cd necro
npm install
npm run build      # bundles the CLI to dist/cli.js
node dist/cli.js scan src/
```

</details>

## Quickstart

Point `necro scan` at a directory (defaults to `.`):

```bash
necro scan src/
```

You get a summary line followed by one **evidence chain** per finding, sorted
worst-first:

```
3 findings (1 certain, 1 likely, 1 test-only)

deadFn  src/util.ts:2   tier: certain
  ✓ 0 static references (TS compiler)
  • coverage: not available
  ✓ not in package.json exports
  ✓ no dynamic-import taint in scope
  → safe to remove

lonelyExport  src/util.ts:3   tier: likely
  ✓ 0 static references (TS compiler)
  • coverage: not available
  ✓ not in package.json exports
  ✓ no dynamic-import taint in scope
  → exported but unused — confirm no external use, then remove

testUtil  src/util.ts:4   tier: maybe
  ✓ 0 production references
  ✗ referenced only in test files
  • coverage: not available
  → prod-dead — delete fn + test, or wire into prod
```

- **`deadFn`** is private and unreferenced → `certain`, safe to remove.
- **`lonelyExport`** is exported but unused internally → `likely` (might be used
  externally, so Necro asks you to confirm).
- **`testUtil`** is reached only via tests → the `test-only` verdict.

Below the dead-code findings, `scan` also prints **Complexity** (over-complex
functions — nesting, cyclomatic, cognitive, god-function), **Risk hotspots**
(CRAP score × git churn, ranked worst-first), and **Duplication** (Type-2
copy-paste clones) — each section omitted when empty.

### Acting on findings

```bash
necro fix src/                 # preview removal of certain-dead code (diff only)
necro fix src/ --write         # apply it (verifies each removal with typecheck first, by default; refuses on a dirty git tree; --force to override; --no-verify to skip verification)
necro baseline src/            # snapshot current findings so they stop gating --fail-on (adopt necro on a legacy codebase without failing CI on day one)
necro triage src/              # LLM-resolve the quarantined `maybe` findings (opt-in, Anthropic API)
necro refactor src/ --type god-function        # propose an LLM refactor, verified in a scratch worktree
necro refactor src/ --type extract-duplicate   # lift a shared function out of a clone
```

`triage` and `refactor` are opt-in and call the Anthropic API (set
`ANTHROPIC_API_KEY`, or `provider: "host-cli"` in `necro.config.json` to shell
out to an already-authenticated `claude` binary instead — no API key needed
inside a Claude Code session); `scan`, `fix`, and `baseline` are fully local
and free. `refactor` prints proposals — it never edits your files — and each
is verified (typecheck + tests) in a throwaway git worktree before you see it.

A single finding can also be suppressed inline, without touching the
baseline, by adding a `// necro-ignore` comment on the line above it:

```ts
// necro-ignore
export function legacyShim() {}
```

#### `fix` exit codes

`fix` uses a stable exit-code taxonomy so scripts and CI can branch on the
outcome without parsing output:

| Exit | Meaning |
|---|---|
| `0` | written, preview, or nothing to fix |
| `1` | unexpected error |
| `2` | refused — the git working tree has uncommitted changes (pass `--force` to override) |
| `3` | refused — 0 production entry points resolved (see **Fail-closed entry resolution** below) |

If both conditions hold (a dirty tree *and* unseeded reachability), exit `3`
wins — you need to fix entry resolution before a dirty-tree override is even
meaningful.

#### Fail-closed entry resolution

Necro seeds its dead-code sweep from your package's production entry points
(`package.json` `main`/`module`/`bin`/`exports`, dist→src mapped via
`tsconfig.json` `outDir`/`rootDir` when the manifest points at build output,
`package.json` `scripts` values, conventional names like `src/index.ts`, and
workspace member entries). If **none** of these resolve on a non-empty
codebase, reachability is unseeded — Necro can't tell what's actually dead —
so it fails closed: every dead-code finding is demoted to `maybe`
(never auto-fix eligible), a warning banner explains why, and `fix --write`
refuses with exit `3` instead of guessing. `necro scan` always reports what it
resolved and where from, under `diagnostics.entryResolution` (also in
`--json` and `--sarif` output as `runs[0].properties.entryResolution`).

To resolve the warning, do any one of:

1. Point `package.json` `main`/`module`/`bin`/`exports` at your real entry
   file (add a `tsconfig.json` `outDir`/`rootDir` so Necro can map `dist/`
   back to `src/`).
2. Add an `entries` field to `necro.config.json` (see **Configuration**).
3. Use a conventional entry filename (`index.ts`, `src/index.ts`, `main.ts`,
   `src/main.ts`).

### Output modes

```bash
necro scan src/ --json              # machine-readable JSON (for CI)
necro scan src/ --sarif necro.sarif # SARIF 2.1.0 for GitHub code-scanning
necro scan src/ --fail-on high      # exit non-zero on certain-dead code
necro scan src/ --top 10            # only the 10 worst findings
necro --version
```

A successful scan exits `0` regardless of findings (non-zero only on internal
error) **unless** `--fail-on <high|medium|low>` is set — then it exits `1` when a
finding at or above that severity exists. See
[CI integration](https://github.com/manehorizons/necro) for the SARIF + GitHub
Action setup.

## Use from an AI agent (MCP)

Necro runs as a read-only [MCP](https://modelcontextprotocol.io) server over
stdio, so an agent (Claude Code, Cursor, Codex, Windsurf) can call necro's
evidence-backed verdicts and verify its own edits in isolation — necro **never
edits your files and never wraps an LLM**:

```bash
necro mcp        # serves over stdio
```

Four read-only tools are exposed:

- **`necro_scan`** — the same findings as `necro scan --json` (dead-code tiers +
  evidence chains, complexity, hotspots, duplication).
- **`necro_verify`** — apply a set of `{file, content}` edits in a throwaway git
  worktree, run checks (default: typecheck + tests), and report `{ok, output}`.
  Your working tree is never touched.
- **`necro_verify_removal`** — for each named symbol, plan its deletion and
  verify independently in its own throwaway worktree; returns a per-symbol
  verdict (green/red/unresolved) so you can confirm a dead-code removal is
  safe before applying it.
- **`necro_explain`** — trace why a symbol is alive, test-only, or dead (the
  same JSON as `necro explain --json`); set `narrate: true` for an additive
  LLM plain-English explanation (needs an API key, degrades gracefully without one).

Register it with your agent (Claude Code example):

```bash
claude mcp add necro -- npx -y @manehorizons/necro mcp
```

Or by hand:

```json
{
  "mcpServers": {
    "necro": { "command": "npx", "args": ["-y", "@manehorizons/necro", "mcp"] }
  }
}
```

## Configuration

Necro runs zero-config. To customize which files it analyzes, add a
`necro.config.json` to your project root:

```json
{
  "include": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts", "**/*.cts"],
  "ignore": ["**/node_modules/**", "**/dist/**"],
  "entries": ["src/server.ts"]
}
```

Each key you set **replaces** its default. Declaration files (`*.d.ts`,
`*.d.mts`, `*.d.cts`) and the `node_modules`, `.git`, `dist`, `build`, and
`coverage` directories are always skipped.

`entries` is globs (relative to the scan target) declaring production entry
points directly — the canonical fix for the fail-closed warning banner when
none of Necro's automatic resolution (manifest, dist→src mapping, scripts,
conventional names, workspaces) finds one. Matched files are added as prod
roots with source `"config"` in `diagnostics.entryResolution`.

## How it works

A scan is a pipeline of small, independently tested stages:

```
discover files
  → build symbol graph        (ts-morph; the only language-specific part)
  → resolve entries           (prod entries + framework plugins)
  → two-color reachability    (+ taint)            ─┐ dead code → tiers
  → classify into tiers                             │
  → syntactic detectors       (tree-sitter)        ─┤ complexity · hotspots · duplication
  → score                     (CRAP × churn)        │
  → render (terminal / JSON)                       ─┘
```

Static analysis is always-on, deterministic, and free. The **LLM layer is
hybrid and on-demand** — `triage` and `refactor` call the Anthropic API only for
the findings you ask about, so cost scales with fixes requested, not codebase
size. Refactor proposals are verified (typecheck + tests) in a throwaway git
worktree before being shown, and necro computes the diff itself (the model
returns code, never a patch).

The **core invariant**: language-specific code lives only in the symbol-graph
adapter. Reachability, classification, scoring, and reporting are
language-agnostic — so adding a language (Python is planned) means writing one
new adapter, not touching the engine. Test files are recognized from your real
test-runner config (jest `--showConfig` / vitest), so test infrastructure is
never flagged dead. The same engine backs the [MCP server](#use-from-an-ai-agent-mcp),
which reuses `scan` and the worktree verifier without forking their logic.

See the [Architecture docs](#documentation) and
[`docs/necro-design-spec.md`](docs/necro-design-spec.md) for the full design.

## Documentation

A full documentation site (landing + guide + reference + architecture) lives in
[`website/`](website/), built with [Astro Starlight](https://starlight.astro.build).

Run it locally:

```bash
cd website
nvm use 22          # the docs site requires Node ≥ 22 (Astro 6)
npm install
npm run dev         # → http://localhost:4321/necro/
```

Or build and preview the static site:

```bash
npm run build       # outputs static HTML to website/dist/ (with search)
npm run preview
```

> The site is wired to deploy to GitHub Pages via
> [`.github/workflows/docs.yml`](.github/workflows/docs.yml); the deploy step is
> manual (`workflow_dispatch`) until Pages is enabled for the repository.

## Project layout

```
src/
├─ cli.ts                  commander CLI (scan · fix · triage · refactor · mcp)
├─ config.ts               necro.config.json loader
├─ discover.ts / glob.ts   file discovery
├─ engine/                 scan pipeline + prod-entry resolution
├─ graph/                  symbol graph (ts-morph) — the language adapter
├─ syntactic/              tree-sitter detectors: complexity, duplication, metrics
├─ plugins/                FrameworkPlugin contract + test-runner plugin
├─ analyze/                reachability, taint, tier classification, hotspots, coverage
├─ fix/                    safe certain-dead removal + dirty-tree guard
├─ triage/                 LLM resolution of `maybe` findings (Anthropic)
├─ refactor/              LLM refactors + scratch-worktree verification
├─ mcp/                    read-only MCP server (necro_scan, necro_verify)
└─ report/                 evidence chains, terminal/JSON output, sorting
test/                      vitest suite, mirroring src/
website/                   Astro Starlight documentation site
docs/necro-design-spec.md  the full design reference
```

## Development

Requires **Node.js ≥ 20** (the docs site under `website/` needs Node ≥ 22).

```bash
npm test            # vitest, single run
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit
npm run build       # bundle the CLI (esbuild)
```

Necro is built **test-first** (red → green → refactor) and planned with the
[CADENCE](https://github.com/manehorizons/cadence) draft → build → settle
workflow; phase artifacts live in `.cadence/`. Contributions that come with
tests and clear acceptance criteria match how the codebase is built.

## Roadmap

**Available today** (TypeScript/JavaScript and Python):

- Semantic **dead-code** detection — TS compiler API via ts-morph for
  TypeScript/JavaScript, a hand-rolled symbol graph + module resolver for
  Python (module resolution incl. `__init__.py` re-export chains,
  `pyproject.toml`/`setup.py`/`setup.cfg` entry points, pytest test-glob
  entries) — with confidence tiers, evidence chains, the `test-only` verdict,
  test-runner awareness (jest/vitest), and coverage ingestion (lcov for
  TS/JS, [Cobertura](https://cobertura.github.io/cobertura/) `coverage.xml`
  for Python). Python is included by default alongside TypeScript/JavaScript;
  findings are still capped at `likely` (never `certain`/auto-fix-eligible) —
  the resolver is corpus-validated (precision 0.90, recall 0.69 on a 46-case
  real-repo corpus, clearing the 0.85/0.5 floor) for report-only findings,
  but not yet to the bar auto-fix eligibility would need.
- **Complexity** detectors (nesting, cyclomatic, cognitive, god-function) with
  configurable thresholds.
- **Risk hotspots**: CRAP score (complexity² × (1 − coverage)³ + complexity) ×
  git churn, ranked worst-first.
- **Duplication**: Type-2 (renamed) clone detection, clamped to function
  boundaries — no jscpd.
- **`fix`**: safe removal of `certain`-dead code (preview by default, dirty-tree guard, verify-by-default typecheck gate before writing — `--no-verify` to skip).
- **`triage`**: LLM resolution of `maybe` findings (opt-in, Anthropic API).
- **`refactor`**: LLM god-function splits and extract-duplicate, verified in a
  scratch worktree.
- **`explain`**: traces why a symbol is alive, test-only, or dead, with an
  optional `--narrate` LLM plain-English layer (opt-in, Anthropic API).
- **`verify-removal`**: per-symbol build-green check in a throwaway worktree —
  confirms a removal is safe before you apply it.
- **`mcp`**: a read-only MCP server (`necro_scan`, `necro_verify`,
  `necro_verify_removal`, `necro_explain`) for AI agents.
- **Framework plugins**: Next.js (roots App-Router entry exports) and
  monorepo workspace-edge resolution.
- Output: terminal, `--json`, `--top N`.

**Planned** (not yet implemented):

| Area | Planned capability |
|---|---|
| Detectors | Cross-language & fuzzy (Type-3) clones; god-function responsibility clustering |
| Scoring | Per-line & recency-weighted churn, ownership weighting |
| Fixes | `test-only` auto-apply; cascading re-analysis after a fix |
| Frameworks | NestJS (DI), template-based plugins |
| Accuracy | Python `certain` tier (corpus validation to raise it off the `likely` cap) |

## License

[MIT](LICENSE) © manehorizons.
