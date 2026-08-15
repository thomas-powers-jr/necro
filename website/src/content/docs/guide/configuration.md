---
title: Configuration
description: Configure which files Necro analyzes.
sidebar:
  order: 8
---

Necro runs zero-config. To customize which files it analyzes, add a
`necro.config.json` to your project root.

```json title="necro.config.json"
{
  "include": ["**/*.ts", "**/*.tsx"],
  "ignore": ["**/node_modules/**", "**/dist/**"]
}
```

## Keys

| Key | Type | Default | Description |
|---|---|---|---|
| `include` | `string[]` | `["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts", "**/*.cts", "**/*.py"]` | Globs of files to analyze. |
| `ignore` | `string[]` | `["**/node_modules/**", "**/dist/**"]` | Globs to exclude. |
| `entries` | `string[]` | none | Globs declaring production entry points directly — the fix for the fail-closed entry-resolution warning when automatic resolution finds none. |

Each key you set **replaces** its default (values are merged per key, not
concatenated). If you set `ignore`, include the defaults you still want:

```json title="necro.config.json"
{
  "ignore": ["**/node_modules/**", "**/dist/**", "**/*.generated.ts"]
}
```

Declaration files (`*.d.ts`) and the directories `node_modules`, `.git`,
`dist`, `build`, and `coverage` are always skipped.

## What's not configurable yet

Confidence-tier cutoffs (what counts as `certain` vs. `likely` vs. `maybe`)
aren't user-tunable yet. Entry-point overrides (`entries`) and per-detector
thresholds (`complexity`) already are.

See the full [configuration reference](/necro/reference/configuration/) for the
authoritative key list.
