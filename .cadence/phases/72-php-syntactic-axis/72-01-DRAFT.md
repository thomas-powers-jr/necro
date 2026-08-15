---
phase: 72-php-syntactic-axis
id: 72-01
tier: standard
status: PENDING
---

# 72-01 — PHP syntactic axis (complexity/duplication/hotspots) — Phase A of php-support-design.md

## Objective

Port necro's syntactic axis (complexity, duplication, hotspots) to `.php`, gated behind explicit user config (not yet in `DEFAULT_CONFIG.include`) per `.cadence/intelligence/php-support-design.md` §4 Phase A and §2.7's "gated until the corpus gate passes" precedent from Python's own Phase A → phase 71 sequencing — using PHP grammar facts verified live against `tree-sitter-php.wasm` during design (design doc §2.1/§6), not assumed by analogy to JS or Python.

## Acceptance Criteria

### AC-1: `.php` files parse via the tree-sitter-php grammar
Given a `.php` source file
When `getParser(file)` (`src/syntactic/parse.ts:27-35`) is called, or `lowerSource`/`tokenize` run on it
Then the PHP grammar loads (`grammarFor` extended to map `.php` → a new `"php"` `Grammar` union member, `src/syntactic/parse.ts:5,11-16`) and parsing succeeds without throwing — today `grammarFor` falls through to `"typescript"` for any unrecognized extension including `.php`, which would silently mis-parse every construct

### AC-2: Every PHP function-like form is captured as a `FunctionUnit`
Given PHP source containing a top-level function, a class method, a closure (`function() use (...) {}`), and an arrow function (`fn() => ...`)
When `lowerSource` walks the file
Then all four are captured — `FUNCTION_KINDS` (`src/syntactic/ir.ts:39-49`) needs `"method_declaration"` and `"anonymous_function_creation_expression"` added (verified via live grammar probe this session: PHP methods use `method_declaration`, **not** JS's `method_definition` — a one-letter false-friend); `"function_definition"` and `"arrow_function"` are already present and verified to be the exact node-type strings PHP's grammar emits for those two forms, so no change needed there. Also assert constructor-property-promotion params (`property_promotion_parameter`, distinct from `simple_parameter`) count toward `params` like any other parameter.

### AC-3: `categoryOf` correctly categorizes every PHP control-flow construct, including the ones that are NOT free reuses
Given PHP source with `if`/`elseif`/`else`, `foreach`, `switch`/`case`, and boolean operators in both symbol (`&&`/`||`/`??`) and word (`and`/`or`/`xor`) form
When `categoryOf` (`src/syntactic/ir.ts:52-92`) runs on each construct
Then: `elseif` counts as its own `branch` (verified this session: PHP's `else_if_clause` is a sibling `alternative:` clause of `if_statement`, same shape as Python's existing `elif_clause` case — a **new** case is needed, it is NOT free the way plain `if_statement` is); `foreach` counts as a `loop` (new `foreach_statement` case — `for_statement`/`while_statement`/`do_statement` are already free, verified identical node-type strings to the existing JS cases); `switch`'s `case_statement` counts as `case` (new case — verified distinct from `catch_clause`/ternary/`if_statement`, which are already free via existing identical node-type-string cases, verified this session, requiring zero new code); word-form `and`/`or`/`xor` are recognized as `boolean` alongside `&&`/`||`/`??` (verified this session: PHP uses the **same** `binary_expression` node and `operator` field for both forms — the existing operator-string check at `ir.ts:76-78` needs `"and"`/`"or"`/`"xor"` added to its match set, not a new case)

### AC-4: The `match` expression's arm-counting decision is made and tested, not left ambiguous
Given `.cadence/intelligence/php-support-design.md` §5.5 (`match_conditional_expression`/`match_default_expression` use node types distinct from `switch`'s `case_statement`, so this isn't resolved by node-type reuse)
When a PHP `match` expression with 2+ arms is hand-computed for cyclomatic complexity and compared against `categoryOf`'s actual output
Then the codebase encodes an explicit, tested decision (arms count as `case`, or they don't) — not silence. Document the decision and its rationale directly in this task's implementation (a comment at the relevant `categoryOf` case, or its deliberate absence), and cover it with a golden test either way.

### AC-5: `tokens.ts` tokenizes PHP identifiers and literals correctly
Given PHP source with variable references (`$foo`), function/class names, integer/float/boolean/null literals, single- and double-quoted strings, and comments (`//`, `#`, `/* */`)
When `tokenize` (`src/syntactic/tokens.ts:37-45`) walks the file
Then: the shared `name` leaf node (verified this session: used identically for variable names, function names, class names, method names — one node type, not per-context) is added to `IDENTIFIER_KINDS` (`tokens.ts:10-17`); `"boolean"` (verified this session: PHP's boolean literal is itself a single leaf node with that exact type string, unlike JS's separate `true`/`false` leaves — folds to `LIT` to match JS's true/false treatment) is added to `LITERAL_KINDS` (`tokens.ts:19-30`) — `"integer"`/`"float"`/`"string_content"` are already present and verified identical to PHP's grammar output, so free. **Correction made during implementation**: PHP's `"null"` leaf node is deliberately **NOT** added to `LITERAL_KINDS` — checking existing precedent (`test/tokens.test.ts`'s pre-existing Python test) showed JS's `null` and Python's `None` both already stay unfolded (their own token kind, not joined to `LIT`) rather than following `true`/`false`'s fold-to-`LIT` treatment; PHP's `null` follows that same established asymmetry, not the plan originally written here. All three comment forms are dropped (the existing `node.type === "comment"` check at `tokens.ts:48,61` already matches PHP's single unified `comment` node type for all three syntaxes, verified this session — no change needed). Note in the same task: PHP's `$` sigil is its own leaf token (type `"$"`, verified this session, a child of `variable_name` alongside the `name` leaf) — it is neither an identifier nor a literal, so it normalizes to its own literal token kind `"$"` via the existing fallthrough (`normalize()`'s `return leaf.type` default) and appears once per variable reference in the token stream; this is intentional (matches how JS/Python's own punctuation/operator leaves already fall through the same way) and needs no special-casing, but assert it explicitly in a test so a future reader doesn't mistake the extra `$` tokens for a bug.

### AC-6: `vendor/` is skipped like `node_modules/`
Given a target directory containing a `vendor/` subdirectory (composer's dependency-install dir, the PHP analog of `node_modules/`)
When `discoverFiles` walks the target
Then `vendor/` is skipped — verified this session: `SKIP_DIRS` (`src/discover.ts:6-17`) currently has no `vendor` entry at all, unlike Python's `.venv`/`__pycache__`/`.tox`/`.eggs` additions from its own Phase A/discovery work

### AC-7: Zero behavior change for TS/JS/Python repos
Given the existing TS/JS and Python test suites, and `DEFAULT_CONFIG.include` (`src/config.ts:83-92`) deliberately left untouched by this phase (PHP stays config-gated, matching Python's pre-phase-71 default-on gating — the flip is a later phase, mirroring phase 71)
When the full suite runs after this phase lands
Then it passes unchanged — a regression-guard test asserts `DEFAULT_CONFIG.include` still has no `**/*.php` entry, so a future phase's default-on flip is a deliberate, visible AC-red moment (matching `test/discover.test.ts:47`'s existing pattern for Python, per phase 71's AC-1) rather than a silent side effect of this phase

## Tasks

### T1: PHP grammar dispatch
- files: `src/syntactic/parse.ts`
- action: extend the `Grammar` union (`:5`) with `"php"`; extend `grammarFor()` (`:11-16`) to map `.php` → `"php"`; confirm `init()` (`:42-53`) needs no change since it already resolves `tree-sitter-${grammar}.wasm` generically from `tree-sitter-wasms`
- verify: new test asserting `getParser("x.php")` resolves without throwing and produces a working parser (parse a trivial `<?php echo 1;` snippet, assert a non-null tree)
- done: AC-1

### T2: `FUNCTION_KINDS` + `categoryOf` PHP arms
- files: `src/syntactic/ir.ts`
- action: add `"method_declaration"`, `"anonymous_function_creation_expression"` to `FUNCTION_KINDS` (`:39-49`); add `"else_if_clause"` (branch), `"foreach_statement"` (loop), `"case_statement"` (case) as new `categoryOf` cases (`:52-92`); extend the existing boolean-operator string check (`:76-78`) to also accept `"and"`/`"or"`/`"xor"`; resolve and implement the `match`-arm decision from AC-4
- verify: golden tests hand-computing cyclomatic complexity for a PHP snippet with nested `if`/`elseif`/`else`, `foreach`, `switch`/`case`, `match`, and mixed `&&`/`and` usage, asserting `categoryOf`'s output matches hand computation exactly (mirrors Python Phase A's own verification method for `elif`/`match` counting, design doc §4 Phase A)
- done: AC-2, AC-3, AC-4

### T3: `tokens.ts` PHP leaf kinds
- files: `src/syntactic/tokens.ts`
- action: add `"name"` to `IDENTIFIER_KINDS` (`:10-17`); add `"boolean"`, `"null"` to `LITERAL_KINDS` (`:19-30`)
- verify: new test tokenizing a PHP snippet with variables, a function name, literals, and a comment, asserting the resulting `Token[]` stream has the expected `ID`/`LIT`/passthrough-kind sequence, comments absent, and documents the per-variable `"$"` token explicitly (per AC-5's note)
- done: AC-5

### T4: `vendor/` skip + PHP-legitimate-dirname audit
- files: `src/discover.ts`
- action: add `"vendor"` to `SKIP_DIRS` (`:6-17`); per design doc §2.7's explicit callback to phase 71's `build/`-is-ambiguous lesson, audit the rest of `SKIP_DIRS`'s membership (`node_modules`, `.git`, `dist`, `coverage`, `__pycache__`, `.venv`, `venv`, `.tox`, `.eggs`) for any PHP-legitimate directory or package name — record the finding (even if "none found") in PROGRESS rather than silently skipping the check
- verify: new test with a `vendor/` dir containing a `.php` file, asserting it's not discovered; existing `discover.test.ts` AC-1/AC-2 (Python `build/` package vs. JS/TS `build/` output, phase 71) re-run unchanged to confirm no interaction
- done: AC-6

### T5: Regression guard + full verification
- files: `test/config.test.ts` (or wherever `DEFAULT_CONFIG` is currently asserted — check before adding a new file), plus a full-suite run
- action: new test asserting `DEFAULT_CONFIG.include` (`src/config.ts:83-92`) has no `**/*.php` entry after this phase; run full suite, typecheck, lint
- verify: `npm test`, `npm run typecheck`, `npm run lint` all green; the new regression-guard test passes; manually scan a small hand-written PHP fixture repo (a handful of files exercising T1-T4's constructs) via `necro scan` with an explicit `necro.config.json` `include: ["**/*.php"]` override, and document the spot-check output in PROGRESS (informal — Phase D's real-repo corpus is the enforced accuracy gate, not this phase)
- done: AC-7

## Boundaries

- DO NOT add `**/*.php` to `DEFAULT_CONFIG.include` (`src/config.ts:83-92`) — PHP discovery stays config-gated until a later phase's corpus-backed flip, mirroring the Python design doc's own §2.7 gating and phase 71's precedent for when to flip it.
- DO NOT build a real PHP symbol graph, reachability, or taint logic in `src/graph/`, `src/engine/model.ts`, or `src/analyze/reachability.ts` — that work is design doc §4 Phase C, not this phase. This phase is syntactic-axis only (complexity/duplication/hotspots). **Correction made during implementation (T5)**: a real crash was found via the manual spot-check — `scan()` always builds the reachability model first regardless of the complexity-axis flag (`src/engine/index.ts:56`), and before this phase `.php` files were unfiltered into `tsFiles`, so ts-morph's lenient parser produced partial declarations from PHP syntax and then crashed resolving references against them. A narrow, one-line-shaped exception was required: `src/graph/php/language.ts` (new, `isPhpFile`, mirroring `isPythonFile`) and excluding `.php` from `tsFiles` in `model.ts:132-146` the same way `.py` already is. This is crash-prevention only — PHP still contributes zero graph nodes and zero dead-code claims, matching this phase's intent; it does not build any new reachability/graph logic.
- DO NOT touch `src/engine/prod-entries.ts` or any entry-point resolution — design doc §4 Phase C/§2.3, not this phase.
- DO NOT build the composer.json PSR-4 autoload resolver — design doc §4 Phase B, not this phase.
- DO NOT touch `src/fix/remove.ts` or `src/refactor/index.ts`'s `DEFAULT_CHECKS`/refusal gating — design doc §2.4, deferred past v1 entirely; no PHP-specific refusal logic is needed yet since PHP dead-code findings don't exist until Phase C.
- DO NOT stand up the Phase D corpus (`test/php-realrepo-corpus.test.ts`, `test/fixtures/php-realrepo/`) — this phase's "spot-check" (T5) is informal and manual, not the enforced accuracy gate.
- DO NOT resolve design doc §5's open questions beyond §5.5 (match-arm counting, forced by this phase's own scope) — §5.1-5.4, 5.6-5.7 belong to later phases and are explicitly out of scope here.
- AC ids in this draft restart at 1, per this project's per-phase numbering convention — at settle time, confirm which FILE and test actually satisfied each AC id (not just that some test somewhere carries a matching `(AC-n)` tag), per the carried-forward gotcha from the phase-71 handoff: `cadence_verify_coverage`'s AC-id matching is a repo-wide token search, and low AC numbers collide with unrelated pre-existing tests across the suite.

## Recommendation

Backed by `rec-20260814-003` (status: candidate, converted to this phase) — landed via `/cadence-scout` session `scout-20260814-2138`, 2026-08-14. Design lineage: `.cadence/intelligence/php-support-design.md` §4 "Phase A — PHP syntactic axis" and §2.1 (verified grammar facts), §2.7 (discovery/config gating), §5.5 (match-arm open question this phase resolves). The full PHP-support plan is 5 phases (A-E); this draft scopes only Phase A, matching CADENCE grain and the precedent Python's own phased rollout (42→71) set.
