---
title: CI integration
description: Run Necro in a pipeline with machine-readable output.
sidebar:
  order: 10
---

Necro's `--json` output makes it easy to consume in CI.

```bash
necro scan src/ --json
```

This prints an object with four axes — `findings` (dead code), `complexity`
(syntactic detectors), `hotspots` (risk ranking), and `duplication` (clones):

```json
{
  "findings": [
    {
      "name": "deadFn",
      "file": "/repo/src/util.ts",
      "line": 2,
      "tier": "certain",
      "verdict": "dead",
      "autoFixEligible": true,
      "evidence": [
        { "ok": true, "text": "0 static references (TS compiler)" }
      ]
    }
  ],
  "complexity": [
    {
      "detector": "nesting",
      "file": "/repo/src/util.ts",
      "line": 9,
      "name": "tangled",
      "value": 4,
      "threshold": 3,
      "message": "nesting depth 4 > 3"
    }
  ],
  "hotspots": [
    {
      "name": "tangled",
      "file": "/repo/src/util.ts",
      "line": 9,
      "complexity": 12,
      "coverage": 0.2,
      "crap": 99.7,
      "churn": 9,
      "risk": 897.3
    }
  ],
  "duplication": [
    {
      "tokens": 60,
      "locations": [
        { "file": "/repo/src/a.ts", "startLine": 1, "endLine": 9 },
        { "file": "/repo/src/b.ts", "startLine": 20, "endLine": 28 }
      ]
    }
  ]
}
```

## Gating a build

`--fail-on <severity>` exits non-zero when a finding at or above the threshold
exists, on one unified `high > medium > low` scale:

| Severity | SARIF level | Findings |
|---|---|---|
| `high` | `error` | dead-code `certain` |
| `medium` | `warning` | dead-code `likely`; complexity (all detectors) |
| `low` | `note` | dead-code `maybe`, `test-only`; duplication; hotspots |

```bash
# fail the build only on certain-dead code
necro scan src/ --fail-on high
```

`--fail-on high` gates on certain-dead only; `medium` adds likely-dead and
complexity; `low` fails on anything. It composes with `--json`, `--sarif`, and
the human report.

## SARIF output

`--sarif <file>` writes a schema-valid **SARIF 2.1.0** report that GitHub
code-scanning accepts, so findings show up inline on the PR:

```bash
necro scan src/ --sarif necro.sarif
```

## GitHub Action

A composite Action wraps scan + SARIF upload. Point it at your source and pick a
gate:

```yaml
permissions:
  contents: read
  security-events: write # required to upload SARIF

jobs:
  necro:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: thomas-powers-jr/necro/.github/actions/necro@v1
        with:
          path: src
          fail-on: high # high | medium | low; empty to surface-only
```

Inputs: `path` (default `.`), `fail-on` (default `high`; empty to never fail),
`sarif-file` (default `necro.sarif`), `version` (default `latest`), `upload`
(default `true`). Use `--top N` to cap output when you only care about the worst
offenders.
