---
phase: 69-documentation-sync-to-head-v1-6-0
id: 69-01
tier: standard
status: PENDING
---

# 69-01 — Documentation sync to HEAD (v1.6.0)

## Objective

Bring README.md and the website docs into sync with what's actually shipped at
v1.6.0 — README is badly stale (says "v1.2", frames Python as planned when it
shipped in phases 42-48), and `necro baseline`/`// necro-ignore` (phase 37) are
undocumented everywhere.

## Survey evidence (pre-drafting recon, this session)

- README.md line 7: `> **Status: v1.2 — published on npm.**` — actual npm/package.json version is 1.6.0.
- README.md line 3-14 tagline calls necro "polyglot" but line 14 says "Python
  [is] on the roadmap" — self-contradicting; Python shipped (phases 42-48,
  61, 62; `src/graph/python/`, `src/engine/python-entries.ts` exist and are tested).
- README.md Roadmap section (line 370-378) lists Python under "Planned (not
  yet implemented)" — false as of phase 48.
- `grep -rln "necro baseline\|necro-ignore" website/src/content/docs/ README.md`
  → zero matches. The `baseline` CLI command (`necro baseline --help` confirms
  it exists) and `// necro-ignore` inline suppression (phase 37, tested in
  `test/cli-baseline.test.ts`) are undocumented on both surfaces.
- README.md never mentions the `host-cli` LLM backend (phase 51,
  `src/llm/host-cli-client.ts`) as an alternative to `ANTHROPIC_API_KEY` for
  `triage`/`refactor` — website's `reference/configuration.md` already
  documents it correctly (lines 93-100), so this is README-only drift.
- By contrast, `website/src/content/docs/guide/roadmap.md` and `index.mdx`
  already correctly describe Python as shipped (capped at `likely` tier) and
  document Cobertura coverage — website is materially more current than
  README. Do not assume website needs the same version of every fix as README.
- `website/src/content/docs/reference/cli.md` documents 6 of necro's 8
  commands (scan, explain, verify-removal, fix, triage, refactor, mcp — no,
  that's 7; `baseline` is the 8th and missing) — confirmed via
  `grep -n "^## \`necro" reference/cli.md` vs `node dist/cli.js --help`.
- MCP tool count: README says "Four read-only tools" — verified accurate via
  `grep -rn "\"necro_" src/mcp/tools/*.ts` (necro_scan, necro_verify,
  necro_verify_removal, necro_explain — still exactly 4). No change needed there.
- `docs/necro-design-spec.md` opening note explicitly disclaims itself as
  "not a status report," but its own one-paragraph footnote still says
  "SARIF, more framework plugins, and Python remain planned" — all three have
  shipped, so even the disclaimer note is now wrong.
- `CHANGELOG.md` top entry is already `[1.6.0] — 2026-07-21`, matching HEAD —
  spot-checked current, no gap found.
- `docs/launch/`, `docs/slice1-handoffs/`, `docs/superpowers/` are dated,
  point-in-time planning artifacts (launch runbook, npm setup, slice1
  handoff) — not living reference docs. Out of scope; do not touch.

## Acceptance Criteria

### AC-1: README version + polyglot framing corrected
Given README.md's status line and tagline
When read against `package.json` version (1.6.0) and shipped Python support
Then the status line reads the current npm version, and the tagline/status no
longer contradicts itself about Python being both "polyglot" and "planned"

### AC-2: README documents `baseline` and `necro-ignore`
Given the "Acting on findings" section of README.md
When a reader looks for how to suppress or snapshot findings
Then `necro baseline` and `// necro-ignore` are documented with the same
depth as `fix`/`triage`/`refactor` (purpose, one example command each)

### AC-3: README Roadmap section matches shipped reality
Given README's "Planned (not yet implemented)" table
When compared to website's `guide/roadmap.md` (already correct)
Then README's roadmap table no longer lists Python as planned, and instead
reflects the same shipped/planned split roadmap.md already documents
(Python shipped, capped at `likely`; certain-tier accuracy still planned)

### AC-4: README documents the host-cli LLM backend
Given README's `triage`/`refactor` description ("opt-in ... Anthropic API")
When a reader wants to run triage/refactor without an API key inside a
Claude Code session
Then README mentions `provider: "host-cli"` as documented in website's
`reference/configuration.md`, with a one-line pointer or summary

### AC-5: website docs gain `necro baseline` + `necro-ignore` coverage
Given `website/src/content/docs/reference/cli.md` documents 7 of 8 commands
When the missing command is added
Then `reference/cli.md` gains a `## necro baseline` section (arguments,
options, exit code — matching the style of the other command sections) and
`// necro-ignore` suppression is documented somewhere reachable from the
guide nav (new short guide page or an addition to an existing closely-related
page — implementer's call, but it must be linked from `guide/index.md` or
equivalent if new)

### AC-6: design-spec status footnote corrected
Given `docs/necro-design-spec.md`'s opening note (lines ~2-7)
When compared to shipped reality (SARIF, framework plugins, Python all shipped)
Then only that one footnote paragraph is corrected to stop claiming shipped
features as planned — no other edits to the historical design document

## Tasks

### T1: Fix README status line, tagline, and Roadmap table
- files: `README.md`
- action: update the `Status:` line to 1.6.0; resolve the polyglot/Python
  self-contradiction in the tagline; move Python out of the "Planned" table
  and into "Available today" (capped at `likely`, matching roadmap.md's framing)
- verify: manual re-read; `grep -c "v1.2" README.md` → 0; `grep -n "Python" README.md` shows it under shipped, not planned
- done: AC-1, AC-3

### T2: Document `baseline` + `necro-ignore` in README
- files: `README.md`
- action: add `necro baseline` and `// necro-ignore` to the "Acting on findings" section, one example command each, consistent with existing fix/triage/refactor entries
- verify: manual re-read against `necro baseline --help` and `test/cli-baseline.test.ts` behavior
- done: AC-2

### T3: Document host-cli backend in README
- files: `README.md`
- action: add a short mention of `provider: "host-cli"` near the triage/refactor Anthropic-API-key note, pointing to Configuration section
- verify: manual re-read
- done: AC-4

### T4: Add `necro baseline` section to website CLI reference
- files: `website/src/content/docs/reference/cli.md`
- action: add `## necro baseline` following the existing per-command section style (arguments, options, exit code) sourced from `src/cli.ts`'s baseline command definition
- verify: manual re-read against `src/cli.ts`; section list now covers all 8 commands
- done: AC-5

### T5: Document `necro-ignore` suppression on the website
- files: `website/src/content/docs/guide/` (new or existing page, implementer's call), `website/src/content/docs/guide/index.md` (nav link if new page)
- action: document the `// necro-ignore` comment convention (from `test/cli-baseline.test.ts` behavior) reachable via guide nav
- verify: manual re-read; nav link resolves if a new page was added
- done: AC-5

### T6: Correct design-spec status footnote
- files: `docs/necro-design-spec.md`
- action: rewrite only the opening footnote paragraph (currently claims SARIF/framework-plugins/Python "remain planned") to state they've shipped; leave the rest of the document untouched
- verify: `git diff docs/necro-design-spec.md` shows a single-paragraph change
- done: AC-6

### T7: Confirm CHANGELOG currency (verification only)
- files: `CHANGELOG.md`
- action: none expected — re-confirm top entry is `[1.6.0]` and matches HEAD; if a real gap is found, note it as a deviation rather than silently editing scope
- verify: `head -10 CHANGELOG.md`
- done: AC-7

## Boundaries

- DO NOT touch `docs/launch/`, `docs/slice1-handoffs/`, `docs/superpowers/` — dated historical artifacts, not living docs.
- DO NOT edit source code (`src/`) — documentation only, this phase.
- DO NOT rewrite `docs/necro-design-spec.md` beyond the single footnote paragraph in T6.
- DO NOT add new features or change CLI behavior to "match" docs — docs follow code, not the reverse.
- If AC-5's website suppression doc turns out to already exist somewhere unindexed by the earlier grep, verify with a second targeted search before creating a duplicate page.
