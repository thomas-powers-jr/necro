# Changelog

All notable changes to `@thomas-powers-jr/necro` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.7.0] — 2026-08-15

### Changed
- **npm scope moved to `@thomas-powers-jr/necro`.** The GitHub org this
  project lives under was renamed from `manehorizons` to `thomas-powers-jr`;
  the npm package follows the same rename. `@manehorizons/necro` is
  deprecated and points installers at the new name — existing installs keep
  working, but new installs/imports should use `@thomas-powers-jr/necro`.
- **Python is now scanned by default.** `.py` files are included in every
  scan out of the box — no `necro.config.json` needed. The real-repo
  accuracy gate (precision 0.90, recall 0.69 on a 46-case pip/httpie corpus)
  has cleared the default-on floor since 2026-07-18; Python findings remain
  capped at `likely` (never auto-fix eligible) until tier-stratified
  `certain`-tier accuracy is separately validated.

## [1.6.0] — 2026-07-21

### Added
- **Import-resolved initializer side-effect screen.** A `certain`-tier dead
  symbol whose initializer calls a known `node:fs`/`node:child_process` I/O
  export (resolved via real import bindings, not name matching — so a local
  function that happens to share a name like `readFileSync` is never
  flagged) is now demoted to `likely` instead of being auto-fix eligible,
  since removing it would change program behavior. Detects the call one
  level inside an immediately-invoked wrapper argument; constructors and
  factory calls are never flagged. Measured at precision 1.0 / recall 3-of-3
  against a 19-case hand-labeled real-world corpus (up from 19% precision
  for a naive "any call-shaped initializer" screen).

### Changed
- **Refactor verify skips npm-only default checks on Python edits.** A
  `god-function`/extract-duplicate proposal touching a `.py` file used to
  fall back to `DEFAULT_CHECKS` (`npm run typecheck` + `vitest`), guaranteeing
  a misleading red verdict. It's now reported `skipped` with a named reason
  instead. An explicit `--checks` override still runs as given, even against
  Python.

## [1.5.0] — 2026-07-20

### Added
- **Cobertura `coverage.xml` reader.** Coverage ingestion was lcov-only, so
  the "executed at runtime despite 0 static refs" contradiction signal could
  never fire for Python. `scan`/`fix` now also read a Cobertura report
  (Python's `coverage xml` output), auto-discovered at `coverage.xml` with a
  new `pythonCoveragePath` config override, merged with any lcov report.
- **TS/JS symbol→file edges.** A reached symbol now also marks its own file
  reached, so module-level top-level references in non-entry imported files
  propagate instead of going invisible. Bare side-effect imports
  (`import "./register.js"`, no binding) now also keep the imported module's
  executed contents alive via an explicit edge.

### Changed
- **`fix --write` verifies by default.** Each removal is now gated on
  `verify-removal`'s empirical build-green check (typecheck by default)
  before being applied — a removal that breaks the build is skipped, not
  deleted. `--no-verify` restores the old unconditional-delete behavior;
  `--checks` overrides the default typecheck-only check set.

### Fixed
- **Dirty-tree guard no longer trips on necro's own cache write.** `fix`'s
  scan step writes `.necro-cache/` into the target; the dirty-tree guard
  used to see that as an uncommitted change and refuse on an otherwise-clean
  repo. It now ignores `.necro-cache/` specifically.

## [1.4.0] — 2026-07-19

### Added
- **Library entry point.** The package now ships an importable library
  surface alongside the `necro` CLI. `package.json` gains `main`, `types`,
  and an `exports` map (`"."` → `dist/index.d.ts` + `dist/index.js`, plus a
  `./package.json` passthrough); `import { ... } from "@manehorizons/necro"`
  now resolves. Named exports only (no default export): `scan`, `explain`,
  `buildReachabilityModel`, `loadConfig`, and their associated types
  (`ScanResult`, `ScanOptions`, `ScanDiagnostics`, `Finding`,
  `ReachabilityModel`, `EntryResolution`, `EntryResolutionRecord`,
  `ExplainResult`, `ExplainOptions`, `ExplainSymbol`, `TraceNode`,
  `InboundRef`, `NecroConfig`, `LlmOptions`, `ClassifiedFinding`, `Tier`,
  `Verdict`, `EvidenceSignal`, `SymbolNode`). The build now runs
  `tsc -p tsconfig.build.json` after the existing esbuild CLI bundle to emit
  `dist/index.js` + `dist/index.d.ts`.

## [1.3.0] — 2026-07-18

### Added
- **Default file discovery now covers the whole JS/TS extension family.**
  `include` defaults to `["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
  "**/*.mts", "**/*.cts"]` (was `.ts`/`.tsx` only) — plain JS and JSX no
  longer need a hand-edited config to be scanned. Declaration-file skipping
  widened to match (`*.d.ts`, `*.d.mts`, `*.d.cts`).

### Fixed
- **JSX mis-parse in `.tsx`/`.jsx` files.** The syntactic parser used the
  plain `typescript` tree-sitter grammar for every file, which reads JSX
  (`<div>...</div>`) as a TypeScript type assertion — corrupting control-flow
  and token extraction inside any function containing JSX (`hasError: true`).
  The parser now dispatches to the `tsx` grammar for `.tsx`/`.jsx` files
  (already bundled via `tree-sitter-wasms`, no new dependency) and the plain
  `typescript` grammar for everything else.
- **`necro baseline` snapshots were not portable across machines/CI.**
  `findingKey`/`complexityKey` keyed each finding by its raw absolute-path
  symbol id, so a `.necro-baseline.json` committed on one machine would never
  match when `necro scan --fail-on` re-read it from a different absolute
  checkout path (e.g. a GitHub Actions runner) — silently un-baselining every
  pre-existing finding on the first CI run. Keys are now relative to the scan
  root, so a baseline committed anywhere matches everywhere.

## [1.2.0] — 2026-07-17

### Added
- **Fail-closed entry resolution.** When zero production entry points resolve
  on a non-empty codebase, `scan` demotes every dead-code finding to `maybe`
  (never auto-fix eligible), prints a warning banner naming the fix, and
  `fix --write` refuses (exit `3`) instead of guessing — closing a bug where
  necro's own repo (and any `dist/`-pointing manifest with a non-conventional
  source entry) collapsed to zero prod entries and made `fix --write` eligible
  to mass-delete correct code.
- `resolveProdEntries` now maps compiled manifest entries (`main`/`module`/
  `bin`/`exports`) back to their TypeScript source via `tsconfig.json`
  `outDir`/`rootDir` (one level of local `extends`), with a `dist|build|out →
  src` heuristic fallback when there's no tsconfig — both existence-gated
  against the scanned files, never guessing into undiscovered paths.
- `package.json` `scripts` values are mined for additional entry-point tokens
  (e.g. `"bench": "tsx src/bench.ts"`).
- `necro.config.json` gains an `entries: string[]` field — globs declaring
  production entry points directly, the canonical fix for the warning banner.
- `scan` reports `diagnostics.entryResolution` (`prodEntryCount`, per-entry
  `{file, source}`, `collapsed`) in terminal, `--json`, and `--sarif`
  (`runs[0].properties.entryResolution`) output.
- `fix`'s exit codes are now a documented public contract: `0`
  written/preview/nothing-to-fix, `1` unexpected error, `2` refused-dirty,
  `3` refused-no-entries (no-entries always wins over a dirty tree).
- **`necro explain <symbol>`** (CLI + MCP `necro_explain`). Traces the
  reachability witness chain for an alive symbol, or annotated inbound
  referrers for a dead one — the same structured result over CLI, `--json`,
  and the MCP tool (no logic fork).
- **`--narrate`** on `explain` (CLI + MCP `narrate: true`). Adds an additive
  LLM plain-English explanation of the verdict; degrades gracefully (static
  trace still renders, `narrative: null` in `--json`) when no API key is set.
- **`necro verify-removal <symbols...>`** (CLI + MCP `necro_verify_removal`).
  For each named symbol, plans its removal and verifies independently in its
  own throwaway git worktree — a per-symbol green/red/unresolved verdict
  proving a deletion keeps the build green before you apply it. `verify-removal`
  now exits non-zero when any symbol comes back red (previously always
  exited `0`, even on a red verdict).
- **`fix --write --verify`**: gates automatic removal on `verify-removal`'s
  per-symbol build-green check — only symbols that verify green are deleted;
  red or unresolved symbols are skipped, not removed blind.
- `fix --checks` and `verify-removal --checks` now accept a repeatable flag
  (`--checks "npm test" --checks "npm run lint"`) instead of comma-splitting a
  single value — a check command containing a comma is now run verbatim.
- **CI**: `.github/workflows/ci.yml` runs `typecheck` + `build` + `test` on
  every push to `main` and every pull request, closing the gap where the test
  suite previously only ran in the tag-triggered release job.

## [1.1.0] — 2026-06-11

### Added
- **CI/PR citizen.** `scan --sarif <file>` emits a schema-valid SARIF 2.1.0
  report for GitHub code-scanning.
- `scan --fail-on <high|medium|low>` gates the exit code on a unified severity
  scale (high = certain-dead; medium = likely-dead + complexity; low = the rest).
- A composite GitHub Action (`manehorizons/necro/.github/actions/necro`) that
  runs necro and uploads SARIF to code-scanning.

## [1.0.1] — 2026-06-11

### Changed
- Add this changelog. First release published through the automated
  tag → build → publish GitHub Actions workflow (with npm provenance);
  `1.0.0` was published by hand.

## [1.0.0] — 2026-06-11

First public release on npm as `@manehorizons/necro`.

### Added
- TypeScript dead-code analysis with confidence tiers (`certain` / `likely` /
  `maybe`), evidence chains, and the `test-only` verdict.
- Complexity, risk-hotspot (CRAP × git churn), and Type-2 duplication detectors.
- `fix` — safe removal of `certain`-dead code (preview by default, dirty-tree guard).
- `triage` — opt-in LLM resolution of `maybe` findings.
- `refactor` — LLM god-function splits and extract-duplicate, verified in a
  scratch worktree.
- `mcp` — read-only MCP server exposing `necro_scan` and `necro_verify` for AI agents.
