---
title: Installation
description: Install Necro and run it against your project.
sidebar:
  order: 2
---

Necro requires **Node.js ≥ 20**.

## From npm (recommended)

Install the global `necro` command:

```bash
npm install -g @thomas-powers-jr/necro
necro scan src/
```

Or run it without installing — ideal for agents and CI:

```bash
npx -y @thomas-powers-jr/necro scan src/
```

The rest of this guide writes commands as `necro …`; substitute
`npx -y @thomas-powers-jr/necro …` if you prefer not to install globally.

## From source

```bash
git clone https://github.com/thomas-powers-jr/necro
cd necro
npm install
npm run build
```

This produces a bundled CLI at `dist/cli.js`; run it with `node dist/cli.js scan src/`.

## Verify

```bash
necro --version
necro scan --help
```

Next: run your first scan in the [Quickstart](/necro/guide/quickstart/).
