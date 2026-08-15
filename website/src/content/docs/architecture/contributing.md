---
title: Contributing
description: Dev setup, testing, and the workflow Necro is built with.
sidebar:
  order: 8
---

## Dev setup

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/thomas-powers-jr/necro
cd necro
npm install
```

| Command | What it does |
|---|---|
| `npm test` | Run the test suite (vitest, single run). |
| `npm run test:watch` | Run vitest in watch mode. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run build` | Bundle the CLI to `dist/cli.js` (esbuild). |

## Test-driven development

Necro is built test-first. The loop is red → green → refactor: write a failing
test, watch it fail for the right reason, write the minimal code to pass, then
clean up. Tests live in `test/` and mirror the
[modules](/necro/architecture/project-layout/) they cover. Prefer real code over
mocks; if something is hard to test, treat that as a design signal.

## The core invariant, restated

When adding a detector or feature, keep language-specific code in the
[symbol-graph adapter](/necro/architecture/symbol-graph/) only. Reachability,
classification, and reporting must stay language-agnostic — that's what lets the
same engine serve both TypeScript/JavaScript and Python today, and PHP next.

## How this project is planned

Necro is developed with **CADENCE**, a draft → build → settle workflow with
quality gates. Work is organized into phases under `.cadence/phases/`, each with
a SPEC (the contract: objective + acceptance criteria), a DRAFT (the task plan),
and a SUMMARY at settle. Tasks map to acceptance criteria and are committed
atomically. The dead-code engine was phase `01-dead-code`; these docs are phase
`02-docs`.

You don't need CADENCE to contribute — but if you open a PR, structuring it
around clear acceptance criteria and test-first commits matches how the codebase
is built.

## Docs

This site lives in `website/` (Astro Starlight) and is independent of the CLI
package. See the repo README and the
[design spec](https://github.com/thomas-powers-jr/necro/blob/main/docs/necro-design-spec.md)
for the full rationale behind the architecture.
