---
phase: 70-literal-dispatch-table-taint
id: 70-01
tier: standard
status: PENDING
---

# 70-01 — Suppress dynamic-dispatch taint for same-file dict-literal dispatch tables

## Objective

`findTaintedFiles`'s shared bracket-call heuristic (`reachability.ts:158`, `IDENT[IDENT2](`) taints a file as containing unresolvable dynamic dispatch even when `IDENT` is provably bound, in that same file, to a dict/object literal — the dispatch targets are then ordinary, already-tracked identifier references, not real dynamic dispatch — and `classify.ts:216` caps *every* symbol in a tainted file (not just exports) at `maybe`; narrow the heuristic to stop tainting on same-file literal-dict-backed dispatch tables, confirmed false-positive on 3 real call sites in the pip/httpie corpus (`commands/index.py`, `commands/cache.py`, `commands/configuration.py`, all `handler_map = self.handler_map(); ...; handler_map[action](...)` where `handler_map()` returns a literal dict of self-methods), while leaving genuinely unresolvable dispatch (getattr/importlib/eval, and cross-file-imported tables like httpie's `CLI_TASKS`) tainted exactly as today.

## Acceptance Criteria

### AC-1: Same-file literal-dict dispatch is not tainted
Given a synthetic fixture where a variable is assigned directly to a dict/object literal in the same file (`handler_map = {"a": f, "b": g}`) and later subscripted-and-called (`handler_map[action](...)`)
When `findTaintedFiles` runs over that file
Then the file is NOT included in the returned tainted set — red at baseline first (current regex taints it unconditionally)

### AC-2: Same-file method-returning-literal-dict dispatch is not tainted
Given a synthetic fixture matching the real pip shape — a zero-arg same-class method whose body is a single `return {...}` literal, called and stored (`handler_map = self.handler_map()`), then subscripted-and-called (`handler_map[action](...)`)
When `findTaintedFiles` runs over that file
Then the file is NOT included in the returned tainted set — red at baseline first

### AC-3: Genuinely unresolvable dispatch still taints (no overcorrection)
Given synthetic fixtures where the subscripted identifier is NOT resolvable to a same-file literal — an imported name, a function parameter, a dict built via loop/mutation (`d = {}; d[k] = v`), or comprehension-built — plus the existing getattr/importlib/eval patterns
When `findTaintedFiles` runs over each
Then every file remains in the tainted set, unchanged from current behavior

### AC-4: Real corpus proof — 3 pip files clear, 2 known-dynamic files stay tainted
Given the python-realrepo corpus (`test/fixtures/python-realrepo/pip/pip/_internal/commands/{index,cache,configuration}.py`, plus `commands/__init__.py` and `httpie/httpie/manager/core.py`)
When `findTaintedFiles` runs over the full corpus source set
Then `index.py`, `cache.py`, and `configuration.py` are NOT tainted (down from tainted today), while `commands/__init__.py` (genuinely dynamic `importlib.import_module`/`getattr` dispatch, unrelated pattern) and `manager/core.py` (cross-file-imported `CLI_TASKS` — out of scope, see Boundaries) both remain tainted — this test documents the fix's boundary, not just its win

### AC-5: Taint removal actually promotes symbol tier
Given a private, zero-reference symbol declared in one of the 3 now-untainted pip fixture files (or a synthetic equivalent if none exists in-corpus)
When `classify()` computes `deadTier` for that symbol
Then it is no longer capped at `maybe` by `result.tainted` and reaches the tier its own remaining properties earn — `likely`, not `certain`: `classify.ts:94-101`'s pre-existing Python hard cap (AC-6, phase 45) still applies independently of taint, so a Python symbol never reaches `certain`/auto-fix-eligible regardless of this fix; the fix only removes taint's *additional* `maybe` cap. Discovered at build time via `test/classify.test.ts:186-193`; the phase 65-parked framing this AC was first drafted against didn't account for it.

### AC-6: Real-repo accuracy gate does not regress (hard floor, not assumed)
Given `test/python-realrepo-accuracy-gate.test.ts`'s existing corpus and floors (`PRECISION_FLOOR = 0.85`, `RECALL_FLOOR = 0.5`)
When the fix lands and the gate runs
Then precision stays `>= 0.85` and recall stays `>= 0.5` — untainting promotes suppressed symbols from `maybe` toward `certain`/`likely`, which can newly misclassify anything in `cases.json` labeled alive as dead-tier, so this is measured, not assumed; if the gate goes red, this phase's response is phase 65's: park it (git stash / revert), report which corpus case flipped and why, do not tune thresholds to force it green in the same phase

## Tasks

### T1: Resolve same-file literal-dict bindings before counting a bracket-call match as taint
- files: `src/analyze/reachability.ts`
- action: `SHARED_TAINT_PATTERNS`' bracket-call regex (`/\[\s*[A-Za-z_$][\w$]*\s*\]\s*\(/`) matches starting at the `[` — it does not capture the receiver identifier before it. Widen the match (or re-scan leftward from the match offset for a preceding `[A-Za-z_$][\w$]*` identifier) to actually extract `IDENT` in `IDENT[IDENT2](`. Only then, and only for files that already have a bracket-call hit (parse lazily — do not add an unconditional second parse pass over every file; phases 57/58 exist because whole-repo parse cost is a known sensitivity here), use the existing shared parser (`getParser()` from `src/syntactic/parse.js`, same infra as `src/graph/python/import-parser.ts`) to check whether `IDENT` is bound, in the same file, to (a) a direct `IDENT = {...}` literal assignment, or (b) — Python only — a same-class zero-arg method whose entire body is a single `return {...}` literal, itself called and stored (`IDENT = self.method()`). `{...}`-literal only — no `dict(...)` calls; all four observed real sites are `{...}` literals and `dict(...)` is unevidenced surface, out of scope. If resolvable, that match does not count toward tainting; if any other taint pattern still matches the file (bracket-call or otherwise), the file stays tainted. `JS_ONLY_TAINT_PATTERNS` and `PYTHON_ONLY_TAINT_PATTERNS` (getattr/importlib/eval/dynamic import) are untouched — this only narrows the shared bracket-call pattern.
- verify: synthetic fixture unit tests for the resolvable and unresolvable shapes
- done: AC-1, AC-2, AC-3

### T2: Real-corpus regression test
- files: new/extended test in `test/` exercising `findTaintedFiles` directly against `test/fixtures/python-realrepo/pip/pip/_internal/commands/{index,cache,configuration,__init__}.py` and `test/fixtures/python-realrepo/httpie/httpie/manager/core.py`
- action: assert the exact tainted/untainted membership described in AC-4
- verify: assertion test, red at baseline first
- done: AC-4

### T3: classify-level proof
- files: test alongside `src/analyze/classify.ts`'s existing tests
- action: add a case proving a symbol's tier is no longer taint-capped once its file clears
- verify: assertion test
- done: AC-5

### T4: Full verification
- files: n/a
- action: run full suite, typecheck, lint, and the real-repo accuracy gate
- verify: `npm test`, `npm run typecheck`, `npm run lint` all green; `python-realrepo-accuracy-gate` passes its existing floors per AC-6
- done: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6

## Boundaries

- DO NOT attempt cross-file import resolution for the dispatch-table binding (httpie's `CLI_TASKS` is imported from `httpie.manager.tasks`, not defined locally) — out of scope for this phase; `manager/core.py` stays tainted, and AC-4 asserts that explicitly rather than leaving it unchecked.
- DO NOT touch `JS_ONLY_TAINT_PATTERNS` or `PYTHON_ONLY_TAINT_PATTERNS` (getattr/importlib/eval/dynamic-import) — this phase narrows the shared bracket-call pattern only.
- DO NOT revisit rec-20260719-004 or the taint-direction question (whether taint should apply to the containing file vs. the dispatch target) — that's the separate, already-parked phase 65/investigation; this phase removes a false trigger, it does not change taint's direction or propagation model.
- DO NOT resolve dispatch tables built via loops, comprehensions, or post-hoc mutation (`d = {}; d[k] = v`) — literal-expression-only (`{...}`) is the scoped floor; `dict(...)` calls are also out of scope (unevidenced); anything else stays tainted (see AC-3).
- DO NOT regenerate or re-source the python-realrepo corpus fixtures — reuse the existing pip/httpie files as-is.
- DO NOT tune `PRECISION_FLOOR`/`RECALL_FLOOR` or hand-edit `cases.json` labels to force AC-6 green — if the accuracy gate regresses, park the change per phase 65's precedent and report the flipped case instead.

## Recommendation

Backed by `rec-20260814-001` (status: accepted) — see evidence `ev-20260814-002` for the same grep/corpus proof used in this draft.
