---
title: Project layout
description: The src/ module map.
sidebar:
  order: 7
---

Every module is small and focused — easy to test in isolation and to hold in
context while editing.

```
src/
├─ cli.ts                       commander CLI (necro scan)
├─ config.ts                    loadConfig — necro.config.json
├─ discover.ts                  file discovery (include/ignore)
├─ glob.ts                      picomatch-backed glob matcher
├─ engine/
│  ├─ index.ts                  scan() — the pipeline
│  └─ prod-entries.ts           production entry resolution
├─ graph/
│  ├─ types.ts                  SymbolNode / SymbolEdge / SymbolGraph
│  └─ symbol-graph.ts           buildSymbolGraph (ts-morph)
├─ plugins/
│  ├─ types.ts                  FrameworkPlugin, RepoContext, EntrySpec…
│  ├─ registry.ts               createRepoContext, detectPlugins
│  ├─ entry-resolver.ts         resolveEntries
│  └─ test-runner/
│     ├─ index.ts               the test-runner plugin
│     └─ config-resolution.ts   jest/vitest config resolution
├─ analyze/
│  ├─ reachability.ts           two-color mark-and-sweep + taint
│  └─ classify.ts              tiers + verdicts + evidence
└─ report/
   ├─ evidence.ts               evidence-chain renderer
   ├─ terminal.ts               default human report
   ├─ json.ts                   --json serializer
   └─ sort.ts                   worst-first ordering
```

## Layers

- **CLI / config / discovery** — input handling.
- **graph** — the language-specific adapters (TypeScript/JavaScript via
  ts-morph, Python hand-rolled; the only place language specifics live; see
  the [core invariant](/necro/architecture/)).
- **plugins** — framework awareness via the
  [plugin contract](/necro/architecture/plugins/).
- **analyze** — language-agnostic [reachability](/necro/architecture/reachability/)
  and [classification](/necro/architecture/tiers/).
- **report** — [evidence](/necro/architecture/evidence/) and output modes.

Tests mirror the modules under `test/*.test.ts` (vitest).
