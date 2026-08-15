---
title: Roadmap
description: What Necro does today and what's planned next.
sidebar:
  order: 11
---

Necro is in active development. This page is the honest line between **what
works now** and **what's planned** — nothing on the "planned" list is available
yet.

## Available today

- Semantic **dead-code** detection for TypeScript/JavaScript (compiler API via
  ts-morph) *and* Python (hand-rolled symbol graph + module resolver — no
  ts-morph equivalent exists for Python): module resolution (including
  `__init__.py` re-export chains), conventional/manifest entry points
  (`pyproject.toml` scripts, `setup.py`/`setup.cfg` console_scripts,
  `__main__`/`if __name__ == "__main__"`), pytest test-entry rooting, and
  library quarantine (a `pyproject.toml` with `[project]` + `[build-system]`
  treats every exported symbol as public API).
- Confidence tiers: [`certain` / `likely` / `maybe`](/necro/guide/understanding-results/) (Python is included by default; findings are still capped at `likely` — the resolver is corpus-validated at precision 0.90/recall 0.69 on a 46-case real-repo corpus, clearing the 0.85/0.5 default-on floor, but not yet to the bar `certain`/auto-fix eligibility would need).
- [Evidence chains](/necro/guide/evidence-chains/) on every finding.
- The [`test-only`](/necro/guide/test-only/) verdict.
- [Test-runner awareness](/necro/guide/framework-awareness/) (jest / vitest).
- [Coverage ingestion](/necro/reference/cli/#coverage): lcov for TS/JS, [Cobertura](https://cobertura.github.io/cobertura/) `coverage.xml` for Python — both folded into the evidence chain and tiers, and merged when both are present.
- [Safe fix](/necro/reference/cli/#necro-fix): `necro fix` removes `certain`-dead code — preview by default, `--write` to apply, verified (typecheck) before deleting by default, with a dirty git-tree guard.
- [Complexity detectors](/necro/guide/complexity/): nesting, cyclomatic, cognitive, and god-function (tree-sitter), with configurable thresholds.
- [Risk hotspots](/necro/guide/hotspots/): CRAP score (complexity × coverage) weighted by git churn, ranked worst-first.
- [Duplication](/necro/guide/duplication/): Type-2 (renamed) copy-paste clone detection (tree-sitter, no jscpd), clamped to function boundaries.
- [LLM triage](/necro/reference/cli/#necro-triage): `necro triage` resolves the quarantined `maybe` findings (opt-in, Anthropic API).
- [LLM refactors](/necro/reference/cli/#necro-refactor): `necro refactor` proposes god-function splits and extract-duplicate, each verified (typecheck + tests) in a scratch git worktree.
- `necro explain`: traces why a symbol is alive, test-only, or dead (the reachability witness chain), with an optional `--narrate` LLM plain-English layer (opt-in, needs an API key, degrades gracefully without one).
- `necro verify-removal`: per-symbol build-green check — plans a symbol's removal and verifies it independently in a throwaway git worktree before you apply it.
- [MCP server](/necro/reference/cli/#necro-mcp): `necro mcp` exposes four read-only tools (`necro_scan`, `necro_verify`, `necro_verify_removal`, `necro_explain`) so AI agents can call necro's verdicts and verify edits in isolation.
- Output modes: default terminal, `--json`, `--top N`, and [SARIF 2.1.0](/necro/guide/ci-integration/#sarif-output) (`--sarif <file>`) for GitHub code-scanning.
- [CI gating](/necro/guide/ci-integration/#gating-a-build): `--fail-on <high|medium|low>` exit gating plus a composite [GitHub Action](/necro/guide/ci-integration/#github-action).
- Framework plugins: Next.js (roots App-Router entry exports) and monorepo workspace-edge resolution.

## Planned

None of the following is implemented yet.

| Area | Planned capability |
|---|---|
| Accuracy | Python `certain` tier (corpus validation to raise it off the `likely` cap); istanbul-JSON coverage; cascading re-analysis after a fix |
| Detectors | Cross-language & fuzzy (Type-3) clones; god-function responsibility-clustering |
| Scoring | Per-line & recency-weighted churn, ownership weighting |
| Fixes | `test-only` auto-apply (report-only today); cascading re-analysis after a fix |
| Frameworks | NestJS (DI decorators), template-based plugins |
| Languages | PHP |

## Distribution

Necro ships as [`@thomas-powers-jr/necro`](https://www.npmjs.com/package/@thomas-powers-jr/necro)
on npm — `npm install -g @thomas-powers-jr/necro` or `npx -y @thomas-powers-jr/necro`.
See the [installation guide](/necro/guide/installation/).
