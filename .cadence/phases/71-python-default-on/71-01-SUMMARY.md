# SETTLE Summary — 71-01

**Completed:** 2026-08-14T23:03:48.110Z
**Content hash (sha256):** bec6013ab80243f875cfb4fbf8974ba87017aad179df73d02f39b057c411d0ea

## Acceptance Criteria

- AC-1: PASS (assertion) — src/config.ts DEFAULT_CONFIG.include now has **/*.py; test/discover.test.ts:47 (AC-1) asserts it directly
- AC-2: PASS (assertion) — src/discover.ts's isPythonPackageDir per-directory check; test/discover.test.ts (AC-2) — build/ with .ts bundle still skipped under the flipped default config
- AC-3: PASS (assertion) — test/discover.test.ts:74 (pre-existing AC-1 tag, now with real __init__.py fixture) plus new no-overcorrection test tagged (AC-3) — both prove build/-as-real-package still discovered, build/-without-__init__.py still skipped
- AC-4: PASS (assertion) — test/engine.test.ts new 'AC-4: a mixed TS+Python repo scans correctly under the unmodified default config' test, real scan() entry point, bare DEFAULT_CONFIG, no id collisions
- AC-5: PASS (assertion) — README.md + website roadmap.md + classify.ts comment corrected; new test/docs-accuracy.test.ts (AC-5) asserts stale substrings absent from all three, real automated check
- AC-6: PASS (assertion) — repo-wide grep confirms discover.ts's config.include-Python-sniff pattern is now fully removed (not just singular) — T2 replaced it with the per-directory check entirely
- AC-7: PASS (assertion) — test/python-realrepo-accuracy-gate.test.ts (pre-existing AC-5/AC-6 tags) still passes unchanged floors — precision 0.900, recall 0.692
- AC-8: PASS (assertion) — necro.config.json ignore now excludes test/fixtures/**; new test/self-scan-fixture-guard.test.ts (AC-8) confirms zero .py files discovered there from repo root; additionally empirically confirmed via git-stash A/B compare that the CI self-scan (path: src) returns byte-identical finding counts (6) before and after this phase's changes

## Tasks

- T1: DONE — Added "**/*.py" to DEFAULT_CONFIG.include (src/config.ts). Updated test/discover.test.ts:47's regression-guard test to assert the opposite, tagged (AC-1). Confirmed red-then-green on that test. As predicted by AC-2/T2, this now breaks test/discover.test.ts's "still skips build/ under the default JS/TS-only config (AC-2)" test — expected, fixed in T2.
- T2: DONE — Replaced skipDirsFor's per-config isPython binary with a per-directory isPythonPackageDir(dir) check (stat for __init__.py directly inside a "build" dir) in src/discover.ts. Updated test/discover.test.ts: renamed AC-2 test for accuracy, added __init__.py to the AC-1 Python-package build/ fixture (matches real pip evidence shape) plus a new no-overcorrection test for build/ without __init__.py. Full suite (127 files, 818 tests) green after T1+T2 — no other regressions surfaced.
- T3: DONE — Added a new test to test/engine.test.ts (already exercised scan() with DEFAULT_CONFIG, natural home) proving a mixed TS+Python repo scans correctly via the real scan() entry point under the bare, unmodified DEFAULT_CONFIG — no manual config override, unlike model-python-merge.test.ts's existing coverage at the buildReachabilityModel level. Tagged (AC-4). Passes.
- T4: DONE — Corrected the stale "isn't corpus-validated yet" claim in README.md, website/src/content/docs/guide/roadmap.md (mirrored line), and classify.ts's comment (also updated to reference rec-20260814-008 for the still-open certain-tier question). Added "python" to package.json keywords and an [Unreleased] CHANGELOG entry. New test/docs-accuracy.test.ts asserts the stale substrings are absent from all three files, tagged (AC-5) — real automated check, not manual read-through. Passes.
- T5: DONE — npm test: 129 files / 823 tests passed, 6 skipped (up from 127/818 pre-phase — 2 new test files). npm run typecheck: clean. npm run lint: clean (biome auto-fixed one formatting line in discover.ts). python-realrepo-accuracy-gate: precision/recall floors hold unchanged. Repo-wide greps for AC-6: the config.include-Python-sniff pattern is now fully gone from discover.ts (T2 replaced it with per-directory isPythonPackageDir), not just confirmed singular — even stronger than the AC required.
- T6: DONE — Added "test/fixtures/**" to necro.config.json's ignore list (repo-root only, not DEFAULT_CONFIG.ignore — preserves node_modules/dist too). New test/self-scan-fixture-guard.test.ts loads this repo's real config via loadConfig and asserts discoverFiles at repo root finds zero .py files under test/fixtures/, scoped to .py per advisor guidance (test/fixtures/ already has .ts/.js fixtures unrelated to this phase). Red-then-green confirmed, tagged (AC-8).

## Gate provenance

- draft-read: ran
- structural-verifier: ran
- boundary-scan: skipped — boundaryEnforcement is not "block"
- task-verify-required: ran
- build-test-must-pass: skipped — no test command configured — build-test-must-pass cannot verify your tests ran; this settle will NOT confirm the suite passes. Set verification.testCommand in .cadence/config.json to enable real enforcement.
- test-coverage: ran
- interactive-verdict: skipped — not requested (no --deep / --interactive, not in gate set)
- deep-verify: skipped — not requested (no --deep / --interactive, not in gate set)
- code-review: skipped — not in the active tier × profile gate set
- security-audit: skipped — not in the active tier × profile gate set

## Assurance

- overall: weak
- evidence tally: ai-verified=0, executed=0, assertion=8, mention=0, unverified=0

## Decisions

_(none)_

## Deferred

_(none)_

## Skill audit

_(none)_

## State at settle

- loop position before settle: BUILD
- revision: 1102
- session subagent spawns: 183
