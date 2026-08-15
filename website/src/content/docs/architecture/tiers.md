---
title: Confidence tiers
description: How reachability results become tiered findings.
sidebar:
  order: 4
---

Module: `src/analyze/classify.ts`.

`classify` turns reachability results into findings, assigning each non-alive
node exactly one [tier](/necro/guide/understanding-results/) and deciding
auto-fix eligibility.

```ts
function classify(input: {
  nodes: SymbolNode[];
  reachability: ReachabilityResult[];
  publicApiIds?: Set<string>;
}): ClassifiedFinding[];
```

## The decision

For a `dead` node:

```
tainted OR public API   → maybe   (autoFixEligible: false)
exported                 → likely  (autoFixEligible: false)
otherwise (private)      → certain (autoFixEligible: true)
```

A `test-only` node becomes a `test-only` verdict (tier `maybe`,
`autoFixEligible: false`) — report-only by
[locked decision](https://github.com/thomas-powers-jr/necro/blob/main/docs/necro-design-spec.md).
Alive nodes are not findings.

## Evidence is attached here

Crucially, `classify` attaches the **evidence signals** it evaluated to each
finding. The [evidence reporter](/necro/architecture/evidence/) only formats
them — it never re-derives them. This guarantees the rendered evidence can't
drift from the verdict.

```ts
interface ClassifiedFinding {
  node: SymbolNode;
  verdict: "dead" | "test-only";
  tier: "certain" | "likely" | "maybe";
  autoFixEligible: boolean;
  evidence: EvidenceSignal[];
}
```

## Coverage

The `certain` tier is strengthened by a coverage-miss signal when a report is
available — lcov for TS/JS, [Cobertura](https://cobertura.github.io/cobertura/)
`coverage.xml` for Python (see [Coverage](/necro/reference/cli/#coverage)).
A runtime hit on a 0-static-ref symbol contradicts the dead verdict and
demotes it to `maybe`. With no report, every chain shows
`• coverage: not available` and tiers rest on static signals alone.
