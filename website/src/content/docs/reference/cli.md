---
title: CLI
description: Necro command-line reference.
sidebar:
  order: 1
---

```
necro [options] [command]
```

Install with `npm install -g @thomas-powers-jr/necro`, or invoke via `npx necro …`.
Examples below use `necro` for brevity.

## Global options

| Option | Description |
|---|---|
| `-V`, `--version` | Print the version and exit. |
| `-h`, `--help` | Show help and exit. |

## `necro scan`

Scan a path for anti-pattern code.

```
necro scan [path] [options]
```

### Arguments

| Argument | Default | Description |
|---|---|---|
| `[path]` | `.` | Directory or file to scan. |

### Options

| Option | Description |
|---|---|
| `--json` | Emit findings as JSON instead of the terminal report. |
| `--sarif <file>` | Write a SARIF 2.1.0 report to `<file>` for GitHub code-scanning / CI tooling. |
| `--fail-on <severity>` | Exit non-zero if a finding at or above `high` \| `medium` \| `low` exists (see [severity mapping](#fail-on-severity)). |
| `--top <n>` | Show only the worst `N` findings (after worst-first sort). |
| `--coverage <path>` | Path to an lcov report. Defaults to `coverage/lcov.info`; overrides the `coveragePath` config key. |
| `-h`, `--help` | Show help for `scan`. |

### Coverage

When an [lcov](https://github.com/linux-test-project/lcov) report and/or a
[Cobertura](https://cobertura.github.io/cobertura/) `coverage.xml` report
(Python's `coverage xml` output) is present, `scan` folds runtime coverage
into each finding's evidence chain. necro **reads existing reports only** — it
never runs your test suite. The two formats are independent and merge when
both are found: lcov via `--coverage <path>` → the `coveragePath` config key →
the default `coverage/lcov.info`; Cobertura via the `pythonCoveragePath`
config key → the default `coverage.xml`. A missing report is silently ignored
per format; an unreadable one prints a warning and the scan proceeds without
that format's coverage.

Each finding then shows one of three coverage states:

| State | Evidence line | Effect |
|---|---|---|
| Miss | `✓ 0 coverage hits (lcov)` | Strengthens the dead verdict; a private, untainted candidate stays `certain`. |
| Runtime hit | `✗ executed at runtime (N hits) despite 0 static refs — reached dynamically` | A 0-static-ref symbol that ran is downgraded to `maybe` and never auto-removed. |
| Not available | `• coverage: not available` | The symbol's file or line isn't in the report; tiers are unaffected. |

With no report at all, every finding renders `coverage: not available` — coverage
is purely additive and never changes behavior when absent.

### Output

By default, `scan` prints a summary line followed by one
[evidence chain](/necro/guide/evidence-chains/) per dead-code finding, sorted
worst-first (`certain` → `likely` → `maybe` → `test-only`), then a
[`Complexity`](/necro/guide/complexity/) section listing over-complex functions,
a [`Risk hotspots`](/necro/guide/hotspots/) ranking, and a
[`Duplication`](/necro/guide/duplication/) section of copy-paste clones (each
omitted when empty). With `--json`, it prints an object with four arrays —
`findings` (dead code), `complexity`, `hotspots`, and `duplication` — see
[CI integration](/necro/guide/ci-integration/) for the shape. `--top N` caps the
dead-code findings; the other sections follow their own limits.

### Exit code

`scan` exits `0` on a successful run regardless of findings, unless `--fail-on`
is set. A non-zero exit is also returned on an internal error.

### Fail-on severity

`--fail-on <severity>` exits `1` if any finding is at or above the threshold,
using one unified scale across all four axes:

| Severity | SARIF level | Findings |
|---|---|---|
| `high` | `error` | dead-code `certain` |
| `medium` | `warning` | dead-code `likely`; complexity (all detectors) |
| `low` | `note` | dead-code `maybe`, `test-only`; duplication; hotspots |

`--fail-on high` fails only on certain-dead code; `--fail-on medium` adds
likely-dead and complexity; `--fail-on low` fails on anything. `--fail-on` and
`--sarif` compose with `--json` and the human report.

## `necro explain`

Explain why a symbol is alive, test-only, or dead — traces the reachability
witness chain for an alive symbol, or annotated inbound referrers for a dead
one. Read-only; never edits your files.

```
necro explain <symbol> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `<symbol>` | Symbol to explain: `name`, `file:name`, or `file:line:name`. |

### Options

| Option | Description |
|---|---|
| `--json` | Emit the explanation as JSON. |
| `--narrate` | Add an LLM plain-English explanation of the verdict (needs `ANTHROPIC_API_KEY`). Additive — the deterministic trace still renders, and `--json` output carries `narrative: null`, if the key is missing. |
| `-h`, `--help` | Show help for `explain`. |

### Exit code

`explain` exits `0` when the symbol resolves to a single match, `1` when the
query is ambiguous or can't be resolved.

## `necro verify-removal`

Verify whether deleting each named symbol keeps the build green. For every
symbol, `verify-removal` plans its removal and checks it independently in its
own throwaway git worktree (your working tree is never touched) — the
empirical backbone behind `fix --write`'s default verify gate.

```
necro verify-removal <symbols...> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `<symbols...>` | One or more symbols to test-remove: `name`, `file:name`, or `file:line:name`. |

### Options

| Option | Description |
|---|---|
| `--json` | Emit the per-symbol verdicts as JSON. |
| `--checks <cmd>` | Check command to run after the simulated removal (repeatable — pass `--checks` multiple times to run several commands; default: typecheck + tests). A command containing a comma runs verbatim, not split. |
| `-h`, `--help` | Show help for `verify-removal`. |

### Exit code

`verify-removal` exits `1` if any symbol's removal breaks the build (a `red`
verdict) — the headline CI-gating use case. An all-`unresolved` or all-`green`
result exits `0`; "couldn't determine" is not treated as unsafe.

## `necro fix`

Safely remove `certain`-dead code. `fix` reuses the same detection as `scan`,
then removes **only** `certain`-tier (auto-fix-eligible) symbols — `likely`,
`maybe`, and `test-only` findings are never touched. Removals go through the TS
compiler API (ts-morph), not text editing, so the edited file stays valid.

```
necro fix [path] [options]
```

### Arguments

| Argument | Default | Description |
|---|---|---|
| `[path]` | `.` | Directory or file to fix. |

### Options

| Option | Description |
|---|---|
| `--write` | Apply the removals to disk. **Without it, `fix` only previews** a unified diff and changes nothing. |
| `--force` | Bypass the dirty git-tree guard. |
| `--no-verify` | Skip the empirical build-green gate before deleting (on by default — see **Safety model** below). |
| `--checks <cmd>` | Check command for the verify gate (repeatable; default: `npm run typecheck`). A command containing a comma runs verbatim, not split. |
| `--coverage <path>` | Path to an lcov report, same as `scan` — keeps tiers consistent between the two. |
| `-h`, `--help` | Show help for `fix`. |

### Safety model

- **Preview by default.** `necro fix` prints the diff of what *would* be removed and writes nothing until you add `--write`.
- **Verify by default.** With `--write`, each removal is gated on [`verify-removal`](#necro-verify-removal)'s empirical build-green check (an isolated worktree per symbol, typecheck by default) before it's applied — a symbol whose removal breaks the build is skipped, not deleted. Pass `--no-verify` to restore unconditional deletion (faster, less safe); `--checks` overrides the default typecheck-only check set.
- **Dirty-tree guard.** With `--write`, `fix` refuses if the git working tree has uncommitted changes (git is your undo) — commit/stash first, or pass `--force`. If the target isn't a git repo, it warns that there's no undo and proceeds.
- **Single pass.** `fix` removes what's `certain`-dead in one scan; it does not re-analyze to chase code that becomes dead *after* a removal. Re-run `fix` to catch the next layer. Cascading re-analysis is [planned](/necro/guide/roadmap/).

### Exit code

`fix` exits `0` on every successful run (preview, write, or nothing-to-fix).

## `necro baseline`

Snapshot current dead-code and complexity findings so they stop gating
`--fail-on` — for adopting necro on an existing codebase without failing CI
on day one. Baselined findings are excluded from `--fail-on`'s check but
still print in a normal `scan`; a new finding introduced after baselining
still shows and still gates.

```
necro baseline [path]
```

### Arguments

| Argument | Default | Description |
|---|---|---|
| `[path]` | `.` | Directory or file to scan. |

### Options

| Option | Description |
|---|---|
| `-h`, `--help` | Show help for `baseline`. |

Writes `.necro-baseline.json` to the scanned directory, recording a stable
key (file + name + kind) per current finding. Commit this file so CI and
local runs share the same baseline.

### Exit code

`baseline` exits `0` on every successful run.

## `necro triage`

LLM-resolve the quarantined `maybe` findings — advisory and opt-in. `triage`
scans (or reads a prior `scan --json` document), then asks the Anthropic API to
adjudicate each `maybe` with a recommendation and rationale. It **never edits
your code**; it only annotates findings. Requires `ANTHROPIC_API_KEY`.

```
necro triage [path] [options]
```

### Options

| Option | Description |
|---|---|
| `--input <file>` | Triage a prior `necro scan --json` document instead of re-scanning. |
| `--json` | Emit triaged findings as JSON. |
| `-h`, `--help` | Show help for `triage`. |

## `necro refactor`

Suggest LLM-assisted refactors — advisory and opt-in. `refactor` prints
proposals and **never edits your files**. Each proposal is verified (typecheck +
tests) in a throwaway git worktree before you see it, so a badged-green proposal
is known to compile and pass tests. necro computes the diff itself (the model
returns code, not a patch). Requires `ANTHROPIC_API_KEY`.

```
necro refactor [path] [options]
```

### Options

| Option | Description |
|---|---|
| `--type <type>` | `god-function` (split an over-complex function) or `extract-duplicate` (lift a shared function out of a clone). Default `god-function`. |
| `--limit <n>` | Max findings to propose refactors for (default 1). |
| `--no-verify` | Skip scratch-worktree verification (typecheck + tests). |
| `--json` | Emit proposals as JSON. |
| `-h`, `--help` | Show help for `refactor`. |

## `necro mcp`

Run necro as a read-only [MCP](https://modelcontextprotocol.io) server over
stdio, so an AI agent (Claude Code, Cursor, Codex, Windsurf) can call necro's
verdicts and verify its own edits. necro **never edits your files and never
wraps an LLM** on this path.

```
necro mcp
```

Four read-only tools are exposed:

| Tool | Input | Returns |
|---|---|---|
| `necro_scan` | `{ path?, top?, coverage? }` | The same JSON as `necro scan --json` — dead-code tiers + evidence chains, complexity, hotspots, duplication. |
| `necro_verify` | `{ edits: {file, content}[], checks? }` | Applies the full-file edits in a throwaway git worktree, runs the checks (default: typecheck + tests), and returns `{ ok, output }`. Your working tree is never touched. |
| `necro_verify_removal` | `{ symbols: string[], path?, checks? }` | For each symbol, plans its removal and verifies it in its own throwaway git worktree. Returns a per-symbol verdict — green (safe to delete), red (breaks the build), or unresolved. |
| `necro_explain` | `{ symbol, path?, narrate? }` | The same JSON as `necro explain --json` — the reachability witness chain for a symbol. Set `narrate: true` for an additive LLM plain-English explanation (needs an API key, degrades gracefully without one). |

Register it with your agent (Claude Code example):

```json
{
  "mcpServers": {
    "necro": { "command": "npx", "args": ["-y", "@thomas-powers-jr/necro", "mcp"] }
  }
}
```

:::note[Opt-in & cost]
`scan`, `fix`, `explain`, `verify-removal`, and `mcp` are fully local and free
(`explain --narrate` is the one opt-in exception — see below). `triage` and
`refactor` call the Anthropic API and run only when you invoke them — set
`ANTHROPIC_API_KEY` first. SARIF output and `--fail-on` gating are shipped;
see [CI integration](/necro/guide/ci-integration/).
:::
