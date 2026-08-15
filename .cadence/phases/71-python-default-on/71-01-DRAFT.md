---
phase: 71-python-default-on
id: 71-01
tier: standard
status: PENDING
---

# 71-01 — Flip Python to default-on now that the accuracy floor is measured-cleared

## Objective

`.py` is still excluded from `DEFAULT_CONFIG.include` (`src/config.ts:84-91`) a year after the 2026-07 Python design doc's own stated default-on trigger — precision ≥0.85/recall ≥0.5 on the real-repo corpus — was cleared by phase 48 (currently measured live: precision 0.900, recall 0.692 on 46 cases); flip `.py` into the default include set, fix the `skipDirsFor` (`src/discover.ts:19-29`) regression this exposes (its `isPython` check currently assumes a config targets *either* JS/TS *or* Python, never both, so once Python is unconditionally in the default it would stop skipping `build/` for every plain JS/TS repo too), prove a mixed-language repo scans correctly under the new default with zero config, and correct the README/source comments that still claim the corpus validation "hasn't happened yet."

## Acceptance Criteria

### AC-1: `.py` is discovered with zero config
Given a target directory containing only a `.py` file, no `necro.config.json`
When `necro scan` runs (or `discoverFiles`/`loadConfig` are called directly) with no explicit `include` override
Then the `.py` file is discovered and classified — red at baseline first (today `DEFAULT_CONFIG.include` has no `*.py` entry, per `test/discover.test.ts:47`'s existing regression-guard test, which this AC supersedes and that test must be updated to assert the opposite)

### AC-2: `build/` still skips for a plain JS/TS repo under the new default (no regression)
Given a target directory with a `build/` subdirectory containing a `.ts` bundle output file, no `necro.config.json`, and the flipped `DEFAULT_CONFIG.include` (now containing both `*.ts` and `*.py` globs)
When `discoverFiles` walks the target with the default config
Then `build/` is still skipped and its contents are not discovered — this is `test/discover.test.ts:85`'s existing "AC-2" test, which goes red the moment `.py` is added to `DEFAULT_CONFIG.include` unless `skipDirsFor`'s `isPython` binary is replaced with a check that doesn't collapse to `true` for every default-config scan just because Python is now always present alongside JS/TS

### AC-3: `build/` still discovered for a real Python subpackage (no overcorrection)
Given the existing pip fixture shape — a `build/` directory that is itself a Python package (contains `__init__.py`, e.g. `test/fixtures/python-realrepo/pip/pip/_internal/operations/build/`)
When `discoverFiles` walks it under the new default config
Then its `.py` files are still discovered, not skipped — `test/discover.test.ts:74`'s existing "AC-1" test must keep passing unmodified; whatever replaces the `isPython` binary in `skipDirsFor` must distinguish "this specific `build/` dir is a real package" from "this specific `build/` dir is a bundler output dir" per-directory, not per-config (a per-config flag can't express "some `build/` dirs in this repo are packages and others might be output dirs")

### AC-4: A mixed TS+Python repo scans correctly under the unmodified default config
Given a target directory with both a `.ts` file and a `.py` file and no `necro.config.json` (so `scan()` runs on the bare `DEFAULT_CONFIG`, not a manually-constructed config)
When `necro`'s `scan()` entry point (`src/engine/index.ts`) runs end-to-end
Then both languages' symbols appear in the findings/graph with no id collisions — `test/model-python-merge.test.ts`'s existing coverage exercises this at the `buildReachabilityModel` level but only with a manually-overridden `config.include` (`test/model-python-merge.test.ts:28`); this AC closes the design doc's own flagged gap ("the graph merge in Phase C must be tested with both languages present, not just Python-only") at the real entry point, under the config an actual user gets for free

### AC-5: Docs and comments stop claiming the corpus validation hasn't happened
Given README.md's "Available today" Python line and `website/src/content/docs/guide/roadmap.md:22` (both carry the identical stale claim, "isn't corpus-validated to the [same/TS plane's] bar yet" — the website copy is a mirror of README's, per phase 69's own sync precedent) and `classify.ts:94-96`'s comment ("the resolver's recall/precision hasn't been corpus-validated yet (Phase D)")
When a new test reads these three files directly and asserts the stale substrings are absent
Then it passes — this is a real, automated assertion, not a manual read-through. Every AC id in this draft (1 through 7) already appears as a tag in some unrelated pre-existing test title (`python-realrepo-accuracy-gate.test.ts` tags AC-5/AC-6 in its own numbering, `model-python-merge.test.ts` tags AC-5, `discover.test.ts` tags AC-1/AC-2/AC-4 — confirmed via `grep -rohE "AC-[0-9]+" test/ | sort -u`, which returns AC-1 through AC-9, i.e. collisions are structurally unavoidable at this phase's AC-numbering scale, not something this draft can dodge by picking different numbers). A bare `satisfied: true` from `cadence_verify_coverage` proves nothing for any AC here — at settle time, check which FILE and test actually matched each AC id, and confirm it's the phase-71-authored test (or the specific existing test named in that AC's own text above), not an unrelated coincidence

### AC-6: The `config.include`-sniff pattern has no second site
Given the concern that another call site might independently derive "is this a Python scan" from `config.include` the same fragile way `discover.ts:26` does (which would carry the identical always-true-after-the-flip bug)
When a repo-wide search runs (`grep -rn '\*\.py' src/ --include='*.ts' | grep -v '\.test\.'` and `grep -rn 'config\.include' src/ --include='*.ts'`)
Then `discover.ts:26` is confirmed the only site performing this check — already verified during drafting (2026-08-14): the only other `*.py`/`config.include` hits are unrelated glob literals and comments (pytest plugin glob, bench script's explicit `PY_CONFIG`). Re-run at T2 time in case intervening changes added a new one; this AC is process/evidence, not new code

### AC-7: Real-repo accuracy gate does not regress (measured, not assumed)
Given `test/python-realrepo-accuracy-gate.test.ts`'s existing corpus and floors (precision ≥0.85, recall ≥0.5) — its fixtures each pin their own `necro.config.json` (`include: ["**/*.py"]`), so they're not expected to be affected by the `DEFAULT_CONFIG` change, but this must be confirmed by running it, not assumed from reading the fixture configs
When the flip lands
Then the gate still passes its existing floors unchanged

### AC-8: necro's own repo-root scan doesn't newly pull in vendored Python fixtures
Given necro's own root `necro.config.json` sets only `entries` today, no `include`/`ignore` — so `loadConfig` falls back to `DEFAULT_CONFIG.include`/`.ignore` for this repo, same as any repo with no config at all — and `test/fixtures/python-realrepo/` (227 vendored pip/httpie `.py` files) plus `test/fixtures/python-module-resolver/` (21 more) both sit under this repo's own `test/` tree
When a bare `necro scan .` (or `necro scan` with no path, or any tool/script that calls `loadConfig`+`discoverFiles`/`scan` at this repo's root) runs after T1 lands
Then it does NOT discover those 248 vendored fixture files as if they were this repo's own source — confirmed by test, not assumed; the existing CI self-scan (`.github/workflows/necro-scan.yml`, `path: src`) is already unaffected either way since `test/` sits outside `src/`'s walk root, but an unscoped `necro scan .` (the CLI's own default path input) is not, and nothing today prevents someone from running it that way

## Tasks

### T1: Flip the default include set
- files: `src/config.ts`
- action: add `"**/*.py"` to `DEFAULT_CONFIG.include` (`src/config.ts:84-91`)
- verify: `test/discover.test.ts:47`'s regression-guard test now correctly asserts `.py` IS discoverable by default (update its assertion and name, and explicitly re-tag its title `(AC-1)` — `:74`'s pre-existing phase-56 test already carries that tag, which would satisfy a bare AC-id search without this rewritten test being tagged at all; both must carry it so settle's "which file matched" check lands on this phase's own change, not just the coincidence)
- done: AC-1

### T2: Fix `skipDirsFor`'s now-broken `isPython` binary
- files: `src/discover.ts`
- action: `skipDirsFor` (`src/discover.ts:25-29`) currently derives a repo-wide `isPython` flag from `config.include.some(glob => glob.includes("*.py"))` and uses it to decide, for the *entire scan*, whether `build/` is skipped. Once T1 lands, every default-config scan has a `*.py` glob present, so this flag is always `true` and `build/` never skips for anyone — including pure JS/TS repos. Replace the per-config decision with a per-directory one: when the walk encounters a directory literally named `build`, only skip it if it does NOT look like a real Python package (e.g. does not directly contain `__init__.py` — matches the real evidence case, `pip/_internal/operations/build/__init__.py`); otherwise skip it as a conventional JS/TS build-output dir. This requires a cheap one-`readdir`-away peek at walk time rather than a config-level flag, and composes correctly regardless of what `config.include` contains.
- verify: `test/discover.test.ts`'s existing AC-1 (`:74`, Python `build/` package — must still discover) and AC-2 (`:85`, JS/TS `build/` output — must still skip) tests both pass simultaneously under the new flipped default config; AC-2 is red at baseline immediately after T1 alone, before this task lands
- done: AC-2, AC-3

### T3: Prove the mixed-language default-config path end-to-end
- files: new test alongside `test/model-python-merge.test.ts` or `test/engine-index.test.ts` (whichever suite already exercises `scan()` directly — check before adding a new file)
- action: a target with both a `.ts` and a `.py` file, no `necro.config.json`, scanned via the real `scan()` entry point with the bare `DEFAULT_CONFIG` (not a manually-constructed config like the existing merge test uses) — assert both languages' findings appear, no id collisions
- verify: new assertion test, red at baseline before T1 (today `.py` isn't discovered by default at all)
- done: AC-4

### T4: Correct stale docs and comments, prove it with a real test
- files: `README.md` (the "Available today" Python bullet, `~line 366-367`), `website/src/content/docs/guide/roadmap.md:22` (mirrors README's claim verbatim, per phase 69's sync precedent), `src/analyze/classify.ts` (comment at `:94-96`), `package.json` (`keywords`, currently missing `"python"` — design doc §4 Phase E scope names `package.json` explicitly), `CHANGELOG.md` (new entry — every shipped feature in the current file gets one, e.g. the 1.6.0 initializer-effect entry), plus a new test file (e.g. `test/docs-accuracy.test.ts`)
- action: replace the "isn't corpus-validated to the TS plane's bar yet" / "hasn't been corpus-validated yet (Phase D)" language in README + website roadmap + the classify.ts comment with the actual measured phase-48 numbers and current default-on status (do NOT change the surrounding claim about the `likely` cap itself — see Boundaries — only correct the factual claim about whether validation happened); add `"python"` to `package.json` keywords; add a CHANGELOG entry for the default-on flip. The new test reads README.md, the website roadmap page, and classify.ts from disk and asserts the stale substrings ("isn't corpus-validated", "hasn't been corpus-validated yet") are absent from all three — tag its title/describe block `(AC-5)` so settle's AC↔test check has a real, new, phase-71-authored match instead of only the pre-existing unrelated `(AC-5)` hits in `python-realrepo-accuracy-gate.test.ts`/`model-python-merge.test.ts`
- verify: the new test passes; manual read of the CHANGELOG/package.json diffs (no test coverage needed for those two, they're additive not corrective)
- done: AC-5

### T5: Full verification
- files: n/a
- action: run full suite, typecheck, lint, and the real-repo accuracy gate explicitly; re-run the two repo-wide greps from AC-6
- verify: `npm test`, `npm run typecheck`, `npm run lint` all green; `python-realrepo-accuracy-gate` passes its existing floors per AC-7; greps confirm `discover.ts` is still the only `config.include`-Python-sniff site per AC-6
- done: AC-6, AC-7

### T6: Guard necro's own repo-root config against its vendored Python fixtures
- files: `necro.config.json` (repo root)
- action: add an `ignore` entry excluding `test/fixtures/**` (this repo's own scan target only — NOT a `DEFAULT_CONFIG.ignore` change, which would affect every downstream user's repo; other users' `test/fixtures/` dirs are theirs to include or not) — plus a small new test that loads this repo's actual root config via `loadConfig(repoRoot)` and asserts `discoverFiles`/`scan` at the repo root returns zero `.py` files under `test/fixtures/` specifically (scope the assertion to `.py`, matching AC-8 — `test/fixtures/` already contains plenty of `.ts`/`.js` fixture files discovered today, unrelated to this phase; don't assert "zero files total," that conflates a pre-existing TS/JS fixture-visibility question this phase isn't scoped to fix with the new Python-specific one it is)
- verify: new assertion test, red at baseline immediately after T1 (before this task lands, a bare repo-root scan would newly pick up the 248 vendored `.py` fixture files)
- done: AC-8

## Boundaries

- DO NOT lift `classify.ts:94-101`'s `certain`-tier hard cap for Python (phase 45's own AC-6, unrelated to this draft's AC-6) — the design doc's own §5 open question 1 explicitly recommends staying report-only ("the dangerous surface stays off the new language until the corpus history is longer") until there's more corpus history than one measurement. This phase only flips *discovery* default-on; Python `fix --write`/`verify-removal` eligibility is untouched and stays exactly as restrictive as today.
- DO NOT re-run or re-tune the Python corpus (`test/fixtures/python-realrepo/cases.json`) — reuse it as-is; this phase reports the existing measurement, it doesn't produce a new one.
- DO NOT touch `pythonCoveragePath`, the Cobertura reader, or any other Python-plane feature unrelated to default-on discovery.
- DO NOT change `SKIP_DIRS`'s membership (`.venv`, `__pycache__`, `.tox`, `.eggs`, etc.) — only `build/`'s per-directory special case is in scope.
- DO NOT touch `JS_ONLY_TAINT_PATTERNS`/`PYTHON_ONLY_TAINT_PATTERNS` or anything in `reachability.ts` — unrelated to discovery/config.
- DO NOT tune `PRECISION_FLOOR`/`RECALL_FLOOR` or hand-edit `cases.json` labels to force AC-7 green — if the accuracy gate regresses, park the change per phase 65's precedent and report which corpus case flipped and why, rather than forcing it green in the same phase.
- DO NOT do a full `website/` docs re-sync (phase 69-sized effort) — only the one mirrored stale claim at `website/src/content/docs/guide/roadmap.md:22` is in scope, because it's the exact same sentence README's own AC-5 fix corrects, not a broader freshness pass.
- DO NOT handle PEP 420 implicit namespace packages (a `build/`-named or any other directory that's a real Python package without an `__init__.py`) — T2's per-directory heuristic will misclassify one as a bundler output dir and skip it. The design doc's own post-v1 backlog already parks "namespace packages" out of scope; this phase inherits that boundary rather than re-deciding it.
- rec-20260814-002's original summary bundled lifting the `certain`-tier cap together with the default-on flip; this phase does only the flip. The cap-lift half is tracked separately as `rec-20260814-008` (landed during drafting) so it doesn't silently disappear from the ledger when this rec converts/settles.
- ACCEPTED, NOT FIXED: a TS/JS repo with incidental Python (a `scripts/deploy.py`, a vendored tool, a stray fixture) will, after this phase, surface those symbols as `likely`-tier findings by default for users who never asked for Python analysis — the empirical mixed-repo check run during drafting only exercised the degenerate "everything is dead" case (a 2-file repo with no manifest/entries), not this noisier realistic case. No suppression/detection-of-"this repo isn't really a Python project" logic is in scope here — that's a real UX question (e.g. "only include `.py` if a Python manifest is present") deliberately left for a future rec/phase rather than decided under this one's evidence.

## Recommendation

Backed by `rec-20260814-002` (status: candidate, converted to this phase) — landed via `/cadence-scout` session `scout-20260814-2138`, 2026-08-14. Design lineage: `.cadence/intelligence/python-support-design.md` §4 "Phase E — Ecosystem polish + claim" and §5 open questions 2 and 4 (accuracy floor for the README claim; default-on timing — "gate `.py` discovery behind config until Phase D passes, then flip"). Phase D (phase 48, 2026-07-18) already passed; this phase executes the deferred flip plus the regression it exposes.
