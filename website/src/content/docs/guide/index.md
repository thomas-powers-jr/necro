---
title: Guide
description: Using Necro to find anti-pattern code in your TypeScript project.
sidebar:
  order: 0
  label: Overview
---

Necro is a local, free CLI that finds **dead code** in TypeScript/JavaScript
and Python — and, unlike pure-static tools, refuses to guess where it can't be
sure. Each finding comes with a confidence tier and an **evidence chain** you
can audit.

This guide walks from install to reading results to wiring Necro into CI.

## Start here

- **[Introduction](/necro/guide/introduction/)** — what Necro finds and why.
- **[Installation](/necro/guide/installation/)** — get it running (from source today).
- **[Quickstart](/necro/guide/quickstart/)** — your first scan and how to read it.

## Understanding what you see

- **[Confidence tiers](/necro/guide/understanding-results/)** — `certain` / `likely` / `maybe`.
- **[Evidence chains](/necro/guide/evidence-chains/)** — the reasoning behind each verdict.
- **[The `test-only` verdict](/necro/guide/test-only/)** — prod-dead, kept warm by tests.
- **[Dead code & reachability](/necro/guide/reachability/)** — how Necro decides.

## Configure and integrate

- **[Configuration](/necro/guide/configuration/)** — `necro.config.json`.
- **[Suppressing findings](/necro/guide/suppressing-findings/)** — `necro baseline` and `// necro-ignore`.
- **[Framework awareness](/necro/guide/framework-awareness/)** — jest / vitest.
- **[CI integration](/necro/guide/ci-integration/)** — JSON output for pipelines.
- **[Roadmap](/necro/guide/roadmap/)** — what's planned next.
