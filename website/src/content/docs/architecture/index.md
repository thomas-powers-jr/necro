---
title: Overview
description: How Necro is built, and the invariant that keeps it polyglot.
sidebar:
  order: 0
---

This section is for contributors. It explains how a scan flows through the
engine and the design rules that keep Necro extensible.

For the full rationale and locked decisions, see the
[design spec](https://github.com/thomas-powers-jr/necro/blob/main/docs/necro-design-spec.md)
in the repo.

## The pipeline

A scan is a pipeline of small, independently testable stages:

```
discover files
  → build symbol graph        (ts-morph; language-specific)
  → resolve entries           (prod entries + framework plugins)
  → two-color reachability    (+ taint)
  → classify into tiers
  → render (terminal / JSON)
```

Each stage is a focused module with a clear interface — see
[Project layout](/necro/architecture/project-layout/).

## The core invariant

> Language-specific code lives **only** in the symbol-graph adapter.

Detectors and the reachability/classification logic are language-agnostic. They
operate on a generic graph, never on TypeScript specifics. Adding a new language
means writing one new symbol-graph adapter — the rest of the engine is reused
unchanged. Python is the proof: its adapter is hand-rolled (no ts-morph
equivalent exists), yet feeds the same reachability/classification/evidence
pipeline unchanged. A detector that special-cases a language is a leak.

## Two IRs (by design)

The design calls for two intermediate representations:

1. **Symbol graph** — references, exports, reachability. Per-language, built by
   the language-native semantic tool (the TS compiler API) or, where none
   exists (Python), a hand-rolled resolver. **Implemented for both.**
2. **Syntactic IR** — block tree + branch counts for complexity/duplication
   detectors. Language-agnostic, tree-sitter-fed. **Implemented.**

## What exists today

The dead-code vertical slice (discovery, symbol graph, plugin/entry resolution,
two-color reachability with taint, tier classification, evidence chains,
terminal/JSON output) for both TypeScript/JavaScript and Python, plus the
tree-sitter syntactic detectors (complexity, duplication), CRAP × churn
hotspot scoring, safe dead-code removal (`fix`, verified by default), the LLM
`triage`/`refactor` layer, a read-only `mcp` server, and SARIF + `--fail-on`
CI gating. Still [planned](/necro/guide/roadmap/): more framework plugins,
Python's `certain` tier (currently capped at `likely`), and PHP.
