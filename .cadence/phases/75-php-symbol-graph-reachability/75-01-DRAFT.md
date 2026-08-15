---
phase: 75-php-symbol-graph-reachability
id: 75-01
tier: complex
status: PENDING
---

# 75-01 — PHP symbol graph + reachability integration

## Objective

Build the PHP symbol graph — class/interface/trait/enum symbol tables extending Phase B's `declared-symbols`/`composer-autoload` output, trait/interface/typed-`->`-chain reference edges, an AST-based dynamic-dispatch taint detector, composer-`bin`/`public/index.php`/PHPUnit entry-point resolution, and PSR-4-namespace library quarantine — and wire it into `buildReachabilityModel` as a third hardcoded partition (`php-support-design.md` §5.7, resolved this session: extend, don't generalize), replacing PHP's current zero-graph-nodes no-op with fixture-verified dead-code verdicts, while closing the 4 real gaps this session's `isPythonFile`-site audit found (tier cap, `verify-removal` refusal, `refactor` default-checks fallthrough, and the ts-morph-crash-hazard `initializer-effect` guard) so PHP files stop being silently mishandled the moment real PHP nodes exist.

## Acceptance Criteria

### AC-1: PHP symbol table + graph nodes extend Phase B's output, merged as a third `buildReachabilityModel` partition
Given Phase B's `extractDeclaredSymbols` (`src/graph/php/declared-symbols.ts:29-104`, today FQCN+kind+file per class/interface/trait/enum) and `buildComposerAutoloadMap` (`src/graph/php/composer-autoload.ts:24-55`, `classToFile: Map<FQCN, absPath>`)
When the PHP symbol-table builder extends symbol extraction to each class/interface/trait/enum's own methods (name+line) and typed properties (name+line+declared type, when a `type: named_type` field is present)
Then every extracted method/property becomes a `SymbolNode` using the existing `${file}:${line}:${name}` id shape (`src/graph/types.ts:5-15`, unchanged), and `buildReachabilityModel` gains a third `phpFiles` partition branch (today: `pyFiles`/`tsFiles` only, `src/engine/model.ts:145-146`) feeding these nodes into `graph.nodes`/`graph.edges` alongside `tsGraph`/`pyGraph` — a 2-step pipeline (extract → resolve), not Python's 3-step `detectImportRoots`→`buildPythonModuleMap`→`buildPythonSymbolGraph`, since Phase B's composer-autoload map already does the work of Python's first two steps.

### AC-2: Reference edges — trait composition, interface implementation, typed `->` (including chained) method-call resolution
Given the grammar facts this session live-probed fresh against `tree-sitter-php.wasm` (not assumed by analogy to the design doc): trait composition is `use_declaration` inside a class's `declaration_list` with bare `name` children; interface implementation is a sibling `class_interface_clause` and inheritance is `base_clause`, both under `body:`; a typed property is `property_declaration` → `type: named_type` + `property_element` → `variable_name`; a typed parameter is `simple_parameter` → `type: named_type` + `name: variable_name`; a method call is `member_call_expression{object, name, arguments}`, and chained calls (`$this->bar->doThing()`) nest via `object:` being a `member_access_expression` whose own `object:` resolves down to a `variable_name`
When the reference-edge resolver walks a method body
Then: `use_declaration` targets resolve the named trait (via the composer autoload map) to its own file and apply T1's method extraction there, and a call to a trait-composed method produces a reference edge **directly to the trait's own method `SymbolNode`** (in the trait's file, per the existing `${file}:${line}:${name}` id shape) — no synthetic method node is created on the composing class, since T1 only extracts methods from each type's own `declaration_list` and a trait's methods live in the trait's file, not the composing class's; `class_interface_clause`/`base_clause` targets produce implementation/inheritance edges; a `member_call_expression` whose `object:` chain resolves — through a typed parameter/property annotation, `$this`, or one further level of recursive property-access walking — to a class with a matching method name produces a reference edge to that method; any chain link that can't be statically resolved (untyped property, external/vendor class outside the composer map, a dynamic `$obj->$method()` construct) fails closed — no edge is guessed, matching this project's existing dead-code-safety-first convention.

### AC-3: Dynamic-dispatch / magic-method detection is AST-based, not a raw-text-regex fallthrough
Given `findTaintedFiles` (`src/analyze/reachability.ts:262-270`) today dispatches only `isPythonFile(file) ? PYTHON_ONLY_TAINT_PATTERNS : JS_ONLY_TAINT_PATTERNS` — no PHP branch exists, so `.php` files (already included in `sources = readSources(files)` at line 225) are silently scanned against JS's dead `import(...)` regex today: a harmless no-op only because PHP contributes zero graph nodes, becoming a live false-negative source (dynamically-dispatched PHP code misclassified as dead) the instant AC-1's nodes ship — and this session's live grammar probe found PHP's magic-method surface (`__call`/`__get`/`__set`/`__callStatic`/etc., `call_user_func`/`call_user_func_array`) is **not** structurally distinct (both are ordinary `method_declaration`/`function_call_expression` nodes, matched by name text only), while `$$var` (`dynamic_variable_name`) and `$obj->$method()` (`member_call_expression` whose `name:` field is a `variable_name` instead of bare `name`) **are** structurally distinct
When the PHP tainted-file detector runs
Then it walks the already-parsed AST (the same tree built for AC-1/AC-2, not a fresh raw-text pass) matching magic-method/`call_user_func` names only within real `method_declaration`/`function_call_expression` positions plus the two structurally-distinct shapes above, taints the containing file, and is wired into `findTaintedFiles`'s dispatch as a real third branch — immune to comment/string-literal false positives a raw-text regex pass would carry, resolving design doc §5.3 in favor of AST-based for PHP specifically (JS/Python's existing regex approach is unchanged, out of scope here).

### AC-4: PHP entry-point resolution — composer `bin`, `public/index.php`, PHPUnit test globs
Given composer.json's `bin` field is not currently parsed (`src/graph/php/composer-manifest.ts:7-19` reads only `autoload`/`autoload-dev`), no `public/index.php` or PHPUnit test-glob handling exists today (confirmed absent), and Python's shape to mirror (`src/engine/python-entries.ts:20-56`: `ResolvedPythonEntries{entries,records,testEntries}` / `PythonEntryRecord{file,source,symbolId?}`)
When PHP entry-point resolution runs
Then composer.json's `bin` field's target file(s) (string or array-of-strings), `public/index.php` by filename convention, and PHPUnit test globs (from `phpunit.xml`/`phpunit.xml.dist`'s configured test-suite paths, falling back to a `*Test.php` filename convention when no config file is found) resolve into a `ResolvedPhpEntries` shape mirroring Python's `entries`/`records`/`testEntries`, merged into `buildReachabilityModel`'s `prodEntries`/`testEntries` the same additive, first-mechanism-wins way `resolvePythonEntries`'s output is merged today (`src/engine/model.ts:194-214`).

### AC-5: Library quarantine — coarse PSR-4-namespace-is-public rule
Given PHP has no `package.json`-style `private` boolean and no underscore-privacy convention (design doc §5.4), and `src/graph/symbol-graph-public-api.ts:16-51`'s barrel-chain-walk approach is confirmed ts-morph-specific, not reusable
When a PHP package is identified as a library — this task's own implementation decision, proposed default: a composer.json with a top-level `name` field (required only for Packagist-published packages, the closest composer-native analogue to npm's "has a name and isn't private"), to be double-checked against real composer.json examples during implementation, not assumed correct from this draft alone
Then every symbol in the package's own declared PSR-4 namespace(s) is treated as public API and quarantined to `maybe` via `classify()`'s existing `publicApiIds` parameter (same mechanism as Python's `pythonPublicApiIds`, `src/engine/model.ts:240-262`), coarse and namespace-wide — no `@internal` PHPDoc-tag granularity in v1, deferred per design doc §5.4 to a later refinement if a future corpus shows it's needed.

### AC-6: Safety gates close the 4 real `isPythonFile`-audit gaps
Given this session's full 8-site `isPythonFile` audit found 4 sites where a missing `isPhpFile` branch is a real gap once AC-1 ships real PHP nodes: `src/analyze/classify.ts:105`'s tier cap (`rawTier === "certain" && isPythonFile(...) ? "likely" : rawTier`, AC-6/phase-45 precedent), `src/engine/verify-removal.ts:80`'s refusal gate (currently silently wrong for PHP — `isPythonFile('.php')` is `false`, so removal would silently proceed on PHP symbols absent this fix), `src/refactor/index.ts:124,248`'s default-checks fallthrough, and `src/analyze/initializer-effect.ts:80`'s short-circuit-to-`"unknown"` guard (safety-critical: without it, ts-morph's `addSourceFileAtPath` runs on `.php` files — the exact garbled-declaration/crash hazard `src/engine/model.ts:133-144`'s own comment documents as the reason `.php` is excluded from `tsFiles`)
When each of the 4 sites gains an `isPhpFile(...)` branch mirroring its existing `isPythonFile(...)` branch
Then: the tier cap applies to PHP unconditionally from this phase's first commit (PHP's own Phase D accuracy corpus doesn't exist yet, so there's no floor-verified basis to trust `certain` tier the way Python's cap eventually earned); `fix`/`verify-removal` refuse PHP symbols with a clear message, matching Python's existing refusal UX exactly; `initializer-effect.ts` never invokes ts-morph on a `.php` file, eliminating the crash hazard, verified by asserting `addSourceFileAtPath` is never called with a `.php` path.

### AC-7: End-to-end correctness, `explain`, and zero regression
Given a synthetic PHP fixture repo built for this phase, covering AC-1 through AC-6's mechanisms (classes/interfaces/traits, typed-property chains, magic methods, composer `bin`/PHPUnit entries, a library-shaped package, and a case exercising each of the 4 safety gates)
When `necro scan` runs against the fixture repo and `necro explain` runs against a PHP symbol
Then scan verdicts match a hand-computed truth table exactly (dead/live/maybe per fixture symbol), `explain` produces a correct reachability trace for a PHP symbol (entry → edges → target, same shape as existing TS/Python `explain` output), and the full existing test suite — including both TS and Python `-corpus`/`-accuracy-gate` precision/recall gates — passes unchanged, confirming zero behavior change for non-PHP repos.

## Tasks

### T1: PHP symbol table extension
- files: `src/graph/php/declared-symbols.ts`, new `src/graph/php/symbol-graph.ts`
- action: extend declared-symbol extraction to walk each class/interface/trait/enum's `declaration_list` for `method_declaration` (name+line) and `property_declaration` (name+line+declared type when `type: named_type` is present); build `phpGraph.nodes` using the existing `SymbolNode` id shape
- verify: unit tests on fixture PHP files with methods, typed and untyped properties, asserting extracted node ids/names/lines match hand computation
- done: AC-1

### T2: Reference-edge resolver — trait/interface/typed `->` chains
- files: new `src/graph/php/reference-edges.ts`
- action: walk each method body's `member_call_expression` nodes, resolving `object:` chains via typed parameter/property annotations and `$this` (recursing one further level through property-access chains); walk `use_declaration`/`class_interface_clause`/`base_clause` for trait-composition/implementation/inheritance edges; for a `use_declaration`, resolve the named trait to its file via the composer autoload map and apply T1's method extraction there so composed-method calls can target the trait's own node (per AC-2's Then clause — edges point at the trait's file, not a synthetic node on the composing class); fail closed (no edge) whenever a chain link is unresolvable
- verify: fixture tests for a direct typed-property call, a typed-parameter call, a `$this`-directed call, a two-level chained call (`$this->prop->method()`), a trait-composed method call **where the trait is declared in a separate file from the composing class** (asserting the edge targets the trait file's node, not a synthetic one), an interface-implementation edge, and negative cases (untyped property, external/vendor class) asserting no edge is produced
- done: AC-2

### T3: `model.ts` wiring — `phpFiles` partition + graph merge
- files: `src/engine/model.ts`
- action: add a `phpFiles = files.filter(isPhpFile)` partition alongside `pyFiles`/`tsFiles` (today `model.ts:145-146`); feed T1/T2's `phpGraph` into `graph.nodes`/`graph.edges` alongside `tsGraph`/`pyGraph`; update the `133-144` comment — PHP no longer contributes zero graph nodes as of this phase
- verify: existing full suite green (TS/Python behavior byte-for-byte unchanged); a PHP fixture repo shows non-zero `graph.nodes` where it showed zero before this phase
- done: AC-1

### T4: PHP entry-point resolution
- files: `src/graph/php/composer-manifest.ts`, new `src/graph/php/php-entries.ts`, `src/engine/model.ts`
- action: extend composer-manifest parsing to cover the manifest's `bin` field (string or array-of-strings) into resolved file paths; detect `public/index.php` by filename convention; parse `phpunit.xml`/`phpunit.xml.dist`'s configured test-suite paths into `testEntries`, falling back to a `*Test.php` filename convention when no config file is found; return `ResolvedPhpEntries{entries, records, testEntries}` mirroring `src/engine/python-entries.ts:20-56`'s shape; wire the result into `model.ts`'s `prodEntries`/`testEntries` the same additive, first-mechanism-wins way `resolvePythonEntries`'s output is merged today (`194-214`)
- verify: fixture tests for each entry source (`bin` string, `bin` array, `public/index.php` present/absent, `phpunit.xml` present with a custom test dir, no `phpunit.xml` falling back to the `*Test.php` convention)
- done: AC-4

### T5: PHP library detection + PSR-4-namespace quarantine
- files: new `src/graph/php/library.ts`, `src/engine/model.ts` (merge)
- action: implement `isPhpLibrary(ctx)` — evaluate candidate composer.json signals empirically before picking one (a bare top-level `name` field is near-universal, including in non-library application repos, so it's likely too weak alone; consider `"type": "library"` (composer's own field) and/or the *absence* of an app shape such as `bin`/`public/index.php` as stronger discriminators) and document the chosen signal's rationale in `SUMMARY.md`'s `## Decisions` section, matching this project's established correction-documentation convention; when a package is identified as a library, quarantine every symbol in its own declared PSR-4 namespace(s) to `maybe` via `classify()`'s existing `publicApiIds` parameter (mirrors Python's `pythonPublicApiIds`, `model.ts:240-262`)
- verify: fixture tests for the chosen library signal (positive: a library-shaped composer.json; negative: an application-shaped one) asserting PSR-4-namespace symbols are quarantined to `maybe` only in the positive case
- done: AC-5

### T6: AST-based dynamic-dispatch taint detector
- files: `src/analyze/reachability.ts` (dispatch site), new `src/graph/php/dynamic-dispatch.ts`
- action: build a PHP-specific AST-walk detector matching `method_declaration` name fields against the magic-method set (`__call`, `__callStatic`, `__get`, `__set`, `__isset`, `__unset`, `__invoke`), `function_call_expression` name fields against `call_user_func`/`call_user_func_array`, `dynamic_variable_name` node presence, and `member_call_expression` nodes whose `name:` field is a `variable_name`; wire it into `findTaintedFiles`'s `isPythonFile(file) ? ... : ...` dispatch (`reachability.ts:262-270`) as a real third branch, replacing today's silent PHP-falls-into-`JS_ONLY_TAINT_PATTERNS` fallthrough
- verify: fixture tests for each magic-method/dynamic-dispatch shape asserting the containing file is tainted, plus a negative fixture with the literal text `call_user_func` appearing only inside a comment/string literal, asserting it is **not** tainted — the exact comment/string-literal false positive a raw-text regex pass would produce
- done: AC-3

### T7: Safety gates — close the 4 `isPythonFile`-audit gaps
- files: `src/analyze/classify.ts:105`, `src/engine/verify-removal.ts:80`, `src/refactor/index.ts:124,248`, `src/analyze/initializer-effect.ts:80`
- action: add an `isPhpFile(...)` branch mirroring each site's existing `isPythonFile(...)` branch exactly (same message/behavior shape, PHP substituted for Python)
- verify: unit tests per site — tier cap caps a `certain`-tier PHP finding to `likely`; `verify-removal` refuses a PHP symbol with the same message shape as Python's; `refactor`'s default checks skip PHP findings the same way; `initializer-effect` returns `"unknown"` for a PHP node, asserted via a spy/mock that `addSourceFileAtPath` is never invoked with a `.php` path
- done: AC-6

### T8: End-to-end fixture suite + explain trace + full regression
- files: new `test/graph-php-symbol-graph-fixtures.test.ts`, `test/fixtures/php-symbol-graph/**`
- action: build the synthetic PHP fixture repo (AC-7's scope), hand-compute its truth table, wire an end-to-end scan test asserting exact verdicts, add an explain-trace test for a PHP symbol (extend the existing explain test file, wherever it lives), run the full existing suite
- verify: fixture suite green with hand-computed truth table matching exactly; `explain` test asserts a correct trace; full existing suite (all languages, both accuracy-gate tests) green unchanged
- done: AC-7

### T9: PHP prod entry-file node-rooting (post-T8 finding)
- files: `src/engine/model.ts`
- action: Mirror the existing pluginProdEntryFiles node-rooting pattern (model.ts:203-207, comment: 'a file-path seed alone only roots module-top-level references, not the declared-but-unreferenced exports') and the existing PHP testEntries node-rooting loop (model.ts:268, if (phpEntries.testEntries.has(node.file)) testEntries.add(node.id)) for PHP prod entries: for each node in graph.nodes whose file matches one of phpEntries.records' file paths, add node.id directly to prodEntries. This is the prod-side mirror of the fix that already exists for PHP test entries and for plugin-detected framework entries.
- verify: Fixture where a composer-bin/public-index.php entry file itself declares a class with a method (an unusual but grammatically legal PHP shape) - that method reads alive after this fix, proving the node-rooting mechanism works. Full suite green, no TS/Python/existing-PHP-test regression.
- done: AC-4, AC-7

### T10: Top-level script call-site resolution (post-T8 finding)
- files: `src/graph/php/reference-edges.ts`
- action: Extend buildPhpReferenceEdges to also walk each file's TOP-LEVEL statements (outside every class/interface/trait/enum body) for member_call_expression call sites - today it only walks methodDeclsOf(typeNode.body), so realistic bootstrap-script code (composer bin scripts, public/index.php: $x = new Foo(); $x->bar();) produces zero edges regardless of T9's fix. New capability needed: a local-variable-type environment built from top-level $var = new ClassName(); assignments in the same file (there is no $this/typed-parameter/typed-property context at top level, so this is genuinely new resolution logic, not a reuse of resolveObjectType's existing param/property/$this cases) - scope to direct $var = new X(); assignments in the same top-level statement list, one variable one type, no reassignment/control-flow tracking, fail closed on anything else (conditional assignment, a variable typed by a function return, etc.) matching this resolver's existing fail-closed discipline. Emit edges with from: <bare absolute file path> (not a SymbolNode id - matches the bare-file-path shape phpEntries.records already seeds into prodEntries, so computeReachability's BFS naturally traverses them without needing a real node id at the source, per how the existing pluginProdEntryFiles/testEntries file-path-seed mechanism already works elsewhere in this codebase).
- verify: Fixture mirroring T8's own KNOWN GAP case exactly (a bin/console.php-shaped script: $target = new BinTarget(); $target->run();, BinTarget declared in a separate file) - after T9+T10, BinTarget::run() reads alive, not dead. T8's own 'KNOWN GAP' regression-lock test (test/graph-php-symbol-graph-fixtures.test.ts) is updated to reflect the fixed behavior, not left asserting the old wrong verdict. Fixture tests for the new local-variable-type environment: single new-assignment resolves, reassignment to a different type fails closed, a variable typed via something other than a direct new expression fails closed. Full suite green.
- done: AC-2, AC-7

## Boundaries

- DO NOT implement PHP `fix --write` or a PHP removal-execution engine — design doc's explicit post-v1 backlog (§4); T6 only adds the refusal gate, never enablement.
- DO NOT build a Laravel/Symfony `FrameworkPlugin`, DI/autowiring-aware taint, or any framework-convention taint list — design doc §5 open question 2, explicitly deferred to a dedicated future phase. If this phase's own fixture/testing work surfaces real DI-driven false positives, file it via `cadence recommendation_add` rather than solving it inline.
- DO NOT build or tune the Phase D accuracy corpus (guzzle/phpunit real-repo precision/recall harness) or wire an enforced CI gate — this phase's Done bar is the fixture-level truth table only (AC-7); Phase D owns real-repo numbers.
- DO NOT flip `.php` default-on in `DEFAULT_CONFIG.include` (`src/config.ts`) — Phase E's concern.
- DO NOT touch PHP coverage ingestion (`parseCobertura` wiring) — Phase E's concern.
- DO NOT implement `@internal` PHPDoc-tag library-quarantine granularity — v1 uses the coarse whole-namespace-is-public rule only (AC-5); note the `@internal` refinement as a later candidate, not this phase's work.
- DO NOT change JS/Python's existing regex-based `findTaintedFiles` patterns or dispatch shape beyond adding the new PHP branch — AC-3's AST-based approach is PHP-specific per design doc §5.3; do not retroactively convert JS/Python to AST-based here.
- DO NOT attempt the `LanguageGraphPlugin` generalization of `buildReachabilityModel` — §5.7 resolved this session (extend the hardcoded partition instead, keeping the PHP branch's shape deliberately parallel to Python's for a later mechanical extraction). File the generalization itself via `cadence recommendation_add` if warranted; it is not in scope here.
- DO NOT resolve `->` chains beyond one further level of recursive typed-property walking (AC-2) — a chain that breaks on an untyped/unresolvable link fails closed; it does not attempt heuristic guessing.

## Recommendation

Continues `.cadence/intelligence/php-support-design.md` §4 "Phase C — PHP symbol graph + reachability integration" directly, following Phase A (`72-php-syntactic-axis`) and Phase B (`74-php-composer-resolver`). §5.7's architecture question (extend the hardcoded `model.ts` partition vs. generalize to a `LanguageGraphPlugin` interface) is resolved this session — verified against `model.ts`'s actual 3 per-language regions (partition/merge, entry integration, library quarantine): a graph-building-only interface would cover just the first, so generalizing now pays a full pure-refactor regression cost while still leaving PHP hardcoded in two of three sites. §5.3's AST-vs-regex question is resolved via this session's live grammar probe: AST-based for PHP, because matching happens on structural fields immune to comment/string-literal false positives, not because every magic-method pattern is a uniquely-typed node. §5.4's library-quarantine-granularity question is only partially resolved — v1 uses the coarse whole-PSR-4-namespace rule (matching the design doc's own recommendation), but the actual "what signals this composer package is a library" implementation decision is genuinely open: a bare composer.json `name` field is near-universal (including in non-library application repos) and is likely too weak alone, so T5 must evaluate `"type": "library"` and/or the absence of an app shape (`bin`/`public/index.php`) as stronger candidates and document the chosen signal's rationale in SUMMARY, not assume `name` alone is correct. This is the design doc's own largest single phase (§4's closing line) — 10 tasks reflects that (T9/T10 added post-hoc after T8's own integration testing found AC-7 unsatisfiable as originally scoped: no PHP symbol could reach `alive` under any real-world entry shape, since neither a prod-entry node-rooting mechanism nor top-level-script call-site resolution existed. T9 closes the first gap, T10 the second — both required, verified empirically against T8's own fixture before scoping, not assumed); if BUILD reveals any task is oversized, split it rather than compress scope.
