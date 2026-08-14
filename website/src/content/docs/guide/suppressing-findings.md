---
title: Suppressing findings
description: Adopt Necro on an existing codebase, or ignore one finding, without failing CI.
sidebar:
  order: 8.5
---

Necro gives you two ways to keep a finding from gating `--fail-on`, for two
different situations.

## Adopting Necro on an existing codebase: `necro baseline`

Running Necro on a mature codebase for the first time can surface hundreds of
pre-existing findings — you don't want CI to fail on day one over debt that
predates the tool. `necro baseline` snapshots every current finding into
`.necro-baseline.json`; anything in that file is excluded from `--fail-on`
(it still prints in a normal `scan`, just doesn't gate).

```bash
necro baseline src/
```

Commit `.necro-baseline.json` so CI and local runs share the same baseline. A
finding introduced **after** baselining still shows and still gates — the
baseline is a snapshot, not a permanent exemption for that location. See the
[CLI reference](/necro/reference/cli/#necro-baseline) for the full command.

## Ignoring a single finding: `// necro-ignore`

To suppress one specific finding without touching the baseline — a
deliberate dead export, a shim kept for a reason Necro can't see — add a
`// necro-ignore` comment on the line directly above it:

```ts
// necro-ignore
export function legacyShim() {}
```

The finding for `legacyShim` is suppressed unconditionally, with no baseline
file involved. Use this for one-off, deliberate exceptions; use `baseline`
for bulk adoption.
