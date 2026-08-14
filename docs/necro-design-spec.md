# Necro — Design Specification

> **This is the design-intent reference, not a status report.** It records the
> decisions behind Necro; forward-looking sections (build order, "for MVP")
> describe original intent. For what's shipped vs. planned today, see the
> [roadmap](../website/src/content/docs/guide/roadmap.md) and `README.md`. As of
> this writing the engine ships dead-code, complexity, hotspot, and
> duplication analysis for both TypeScript/JavaScript and Python, plus `fix`,
> `baseline`/`// necro-ignore` suppression, `triage`, `refactor`, a read-only
> `mcp` server, and SARIF + `--fail-on` output for CI; more framework plugins
> (beyond Next.js and monorepo workspaces) remain planned.

**Necro.** A local, free, polyglot CLI that finds anti-pattern code across multiple axes (dead code, duplication, complexity, nesting, god functions/files, recursion) and proposes LLM-assisted fixes. This document is the reference for all decisions made to date.

The product is named for the death/forensic theme that maps onto its design: tiered verdicts are triage, evidence chains are an autopsy declaring cause of death per finding, the `test-only` verdict is code on life support, and `--fix` is exhumation. CLI command: `necro` (e.g. `necro scan src/`, `necro fix`, `necro --explain`).

> **Naming and namespacing**
> - **Brand:** Necro
> - **npm package:** scoped — `@manehorizons/necro` (or unscoped `necrojs` / `necro-ts`); the bare `necro` npm slug is taken by an unrelated package
> - **CLI command:** `necro` (the `bin` field is independent of the package name)
> - **GitHub org:** `necrotool` (bare `necro` org is taken; `necrotool`, `necroscan`, `getnecro` are free)
> - **Domain:** pending registrar check — `necrotool.dev` / `getnecro.dev` (`.dev`/`.sh` are the dev-tool norm)

> **CRAP is the metric, not the product.** *CRAP* (Change Risk Anti-Patterns) is an existing public software metric — `complexity² × (1 − coverage)³ + complexity` — already implemented by Crap4j, GMetrics, Qt Coco, and NDepend. Necro adopts the formula as one built-in scoring axis but is **not** named after it; the metric is generic and not ownable as a brand, the npm slug is taken, and "CRAP code tool" is unwinnable for SEO.

---

## 1. Positioning

### The gap

Every analysis axis already has a strong incumbent, but no tool combines them in a free, local, fix-capable, polyglot package.

| Category | Incumbents | Shape |
|---|---|---|
| Single-purpose OSS | knip (dead code), jscpd (duplication), vulture (Python dead code) | free, local, deep on one axis, no fix reasoning |
| Fast newcomer | Fallow | local, multi-axis, no AI, false-positive issues |
| Enterprise SaaS | CodeScene, SonarQube, Code Climate | multi-axis + churn, but cloud, paid, heavy |

**The empty cell Necro targets: free + local + multi-axis + LLM-assisted-fix + polyglot.**

### Honest competitive read

- **knip** is the real dead-code king, not Fallow. It is low-false-positive because it is plugin-aware — it knows how Jest, Storybook, Vitest, Webpack, etc. reference files, so it does not flag test setup as unused. Beating knip on raw dead-code accuracy is hard; the angle is *bundling* (dead code + complexity + duplication + fixes in one tool), not duelling on dead code alone.
- **Fallow** is Rust-native, sub-second, has no AI in the analyzer, and resolves dead-code confidence via a *paid* runtime layer. Its free static layer carries the false positives. This is the direct inspiration and the tool to surpass — but only on accuracy and reach, not speed.
- **CodeScene** already owns "complexity × churn" hotspots (their Hotspot Risk Score = complexity × churn × ownership) and adds the temporal dimension. Necro's churn scoring is **not novel** against CodeScene; the differentiation there is local + free + LLM-explains-and-fixes vs. their cloud + dashboard + detect-only.
- **ts-prune** is archived (redirects to knip). **tsr** uses the TypeScript compiler API for resolution and has also ended — both validate the compiler-API approach.

### Where Necro wins (and where it concedes)

| Axis | Fallow | Necro |
|---|---|---|
| Speed | wins (Rust, sub-second) | Node, slower — **concede** |
| False positives | paid runtime to resolve | free coverage + LLM triage — **win** |
| Languages | TS/JS locked (Rust-native) | polyglot by construction — **win** |
| Fix suggestions | safe-remove only | LLM refactors — **win** |
| Ecosystem (MCP/LSP/CI) | mature | greenfield — **concede early** |

The defensible position: **the local, free, polyglot tool that finds anti-pattern code across all axes and proposes LLM fixes.** The LLM fix layer is the one thing no incumbent has — by choice (Fallow) or by model (SaaS). Lead with it.

---

## 2. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Language scope | Single-language MVP, polyglot over time | Prove the engine, then expand |
| 2 | First target language | TypeScript (Python next) | Biggest dead-code pain + user base |
| 3 | LLM integration | Hybrid — static always runs, LLM on-demand | Keeps analysis fast/free/deterministic; LLM cost scales with fixes requested, not codebase size |
| 4 | Distribution | Standalone CLI | Cross-language + own scoring, not boxed into one linter ecosystem |
| 5 | Implementation language | **Node** (not Rust) | Access to the TypeScript compiler API (via ts-morph) is the accuracy moat; Rust would force reimplementing TS semantics — exactly Fallow's hardest, most-mature component, on their turf |
| 6 | Parse strategy | Split by detector need | tree-sitter for syntactic detectors; TS compiler API for semantic/dead-code |
| 7 | False-positive strategy | Confidence tiers + evidence chains + coverage ingestion + LLM triage | Refuse to guess where pure-static tools must — structural FP advantage |
| 8 | First framework plugin | Test-runner | Biggest single FP class, framework-agnostic, simplest |
| 9 | Test config resolution | Shell-out (`--showConfig`) with static-parse fallback | Accuracy is the whole product; let the runner report its own config |
| 10 | `test-only` verdict | Report-only for MVP (emit suggestion, do not auto-apply) | Deleting tests is high-risk; needs the LLM-fix flow + strong confirms first |

**Why not Rust:** switching optimizes the one axis already conceded (speed) and damages the axis being won (TS accuracy). The TS compiler API is JavaScript-only and is the canonical, correct, Microsoft-maintained TS semantic engine. Node + compiler API = structural accuracy advantage. Revisit Rust only if performance becomes a real adoption blocker, and even then via a native addon for the hot path (parse + graph traversal), not a full rewrite.

---

## 3. Architecture

```
CLI (commander / oclif)
 └ engine
    ├ parse:    tree-sitter → native AST
    ├ lower:    AST → IR          ◄── per-language adapter, ONLY language-specific code
    ├ analyze:  detectors on IR   ◄── language-agnostic, reused forever
    ├ score:    CRAP + composite + churn
    ├ report:   terminal | json | sarif
    └ fix:
       ├ static fixers (deterministic)
       └ llm fixers (on-demand, hybrid)
```

**Core invariant:** language-specific code lives *only* in the `lower` step (and the per-language semantic adapter). Detectors must never special-case a language. Adding Python = write one Python→IR adapter + one Python symbol-graph adapter; detectors stay untouched. Guard this hard — a detector that special-cases JS is a leak.

### Two IRs

1. **Syntactic IR** — block tree + branch counts. Language-agnostic. Fed by tree-sitter. Serves nesting, cyclomatic, cognitive complexity, duplication, LOC, god-function detectors. Reused across all languages.
2. **Symbol graph** — references, exports, reachability. Per-language, fed by the language-native semantic tool (TS compiler API for TS; pyright/jedi or `ast`+`symtable` for Python later). Re-implemented per language, but only this part.

This split reconciles the extensibility bet (tree-sitter, uniform) with accuracy (semantic resolution where dead code needs it). tree-sitter alone cannot resolve symbols across files — it cannot follow re-exports, type-only imports, or barrel files — so dead code must use the compiler API.

### Syntactic IR shape (minimum)

```ts
Module   { path, imports[], exports[], functions[] }
Function { name, params[], body: Stmt[], loc, visibility }
Stmt = If | Loop | Switch | Call | Return | Block | Other
Call     { callee_ref, args_count }
```

Keep it lean — add nodes when a detector demands one, not before.

### TS stack libraries

| Concern | Library | Role |
|---|---|---|
| Semantic / dead code | **ts-morph** | wraps TS compiler API; `getReferences()`, symbol resolution — the dead-code engine |
| Syntactic detectors | **tree-sitter** + `tree-sitter-typescript` | nesting, complexity, duplication |
| CLI | **commander** (light) or **oclif** (plugin system, fits the "add plugins" future) | command surface |
| Churn | **simple-git** | `git log` for hotspot scoring |
| Duplication | **jscpd** | wrap it / reuse its token-hash approach — don't rebuild |
| LLM | **Anthropic SDK** | hybrid fix + triage |
| Bundling | **esbuild** | single distributable; lazy-load tree-sitter + ts-morph (both heavy) |

Don't reinvent duplication or complexity math. Wrap proven tools; the scoring + fix layer is the moat.

---

## 4. Detectors

| Detector | Method | Flag heuristic |
|---|---|---|
| Duplication | AST-normalize (strip names/whitespace), hash subtrees, find collisions (token-based, like jscpd) | clone groups above % threshold |
| Nesting depth | walk AST, track max block depth | > 3 |
| Cyclomatic complexity | count branches/loops/boolean ops per function | > 10 |
| Cognitive complexity | like cyclomatic but penalize nesting harder (Sonar model) | threshold; better human-pain proxy |
| God function/file | LOC + param count + responsibility count (distinct callee clusters) | long + many params |
| Dead code | symbol graph + reachability from entry points | tiered (see §5) |
| Recursion | call-graph cycle detection | flag, don't condemn — not always bad |

### Scoring

Each file/function emits a composite. CRAP score `comp² × (1 − cov)³ + comp` is one axis. Weight detectors, sort worst-first. **Hotspot = high complexity × high churn** (from `git log`) — churn data shows which hotspots actually hurt; complex code nobody touches is noise. (Note: this is CodeScene's established territory — differentiate on local/free/LLM, not on the idea.)

### Output modes

`--summary`, `--json`, `--sarif` (CI / GitHub integration), `--top N`.

---

## 5. False-positive layer (the core differentiator)

Dead code = "unreachable from any entry point." False-positive rate is entirely a function of two failures:

1. **Missed entry point** → whole subtree falsely flagged dead. The trust-killer.
2. **Missed reference edge** → one symbol falsely dead.

**The structural advantage:** pure-static tools (knip, Fallow) must make a binary alive/dead call and eat the false positive when unsure. Necro adds a third tier (`maybe`) plus two resolution channels (coverage, LLM). It wins on false positives by *refusing to guess* where static tools are forced to.

### Confidence tiers

| Tier | Condition | Action |
|---|---|---|
| `certain` | private scope, 0 refs, no taint nearby, coverage-miss (if available) | auto-fix eligible |
| `likely` | exported, 0 internal ref, not an entry, no taint | suggest, human y/n |
| `maybe` | taint nearby, OR public API, OR test-only ref | LLM triage / coverage resolves; never auto-fixed |

The `maybe` tier is the false-positive sink — ambiguous code is quarantined with reasons instead of being falsely killed.

### Mark-and-sweep, taint-aware

```
1. collect entry points         → mark ALIVE (roots)
2. walk static + plugin synthetic edges → mark reachable ALIVE
3. mark taint regions (dynamic import, reflection, string dispatch)
4. unmarked nodes = candidates
5. classify by confidence + emit evidence
```

### Framework-awareness plugin contract

A plugin contributes exactly three things; auto-detection makes it zero-config.

```ts
interface FrameworkPlugin {
  name: string
  detect(ctx: RepoContext): boolean                              // is the framework present?
  entryPatterns(ctx: RepoContext): EntrySpec[]                   // roots, alive by definition
  resolveEdges(ctx: RepoContext, graph: ModuleGraph): SyntheticEdge[]  // edges static graph can't see
  taintRules(ctx: RepoContext): TaintRule[]                      // regions to downgrade, not flag
}
```

`detect()` reads `package.json` dependencies + config-file presence (`next` → Next plugin, `@nestjs/core` → Nest plugin, `vitest`/`jest` → test plugin). When no plugin matches a framework, candidates degrade to `maybe` rather than being falsely killed.

### TypeScript false-positive trap table

| Trap | Why it false-positives | Handling |
|---|---|---|
| Barrel re-export `export * from` | re-export looks like a use | transitive pass-through edge; count only terminal consumer |
| Test-only usage | referenced solely in `*.test.ts` | tag edges by file-kind → `test-only` tier, not dead |
| Dynamic import `` import(`./${x}`) `` | target unresolvable | taint candidate dir → `maybe` |
| DI / decorators (`@Injectable`, `@Component`) | framework instantiates, no static caller | plugin synthetic edge: decorated class = entry |
| Framework template refs (Angular `.html`) | ref lives outside TS | plugin parses template, adds edges |
| Reflection / string dispatch `obj[name]()` | dynamic key | taint → `maybe` |
| Public API (`exports` in package.json) | external consumers invisible | mark entry, never dead; tier `public-unknown` |
| Config files (`vite.config.ts`, `eslint.config.js`) | consumed by tooling, not imported | plugin marks as entry |
| Type-only `import type` | used at type level, 0 runtime | separate tier: dead-at-runtime, alive-at-typecheck |
| JSX `<Foo/>` | element name is a ref | parser counts JSX identifiers as refs (TS API handles) |
| Monorepo cross-package | per-package analysis misses workspace edges | resolve workspace graph first — miss this = mass FP |

**Top three by damage: monorepo edges, missed entry points, barrel re-exports.** Getting those right already beats Fallow.

### Evidence chain (the trust artifact)

Every finding ships its reasoning so the user audits the verdict instead of trusting blind:

```
oldHelper()  src/utils/helper.ts:42   tier: certain
  ✓ 0 static references (TS compiler)
  ✓ 0 coverage hits (lcov)
  ✓ not in package.json exports
  ✓ no dynamic-import taint in scope
  → safe to remove

formatPayload()  src/api/fmt.ts:88     tier: maybe
  ✓ 0 static references
  ✗ dynamic import in src/api/ — target unresolvable
  ✗ referenced by string key in registry.ts:12
  → NOT auto-removed; LLM triage available
```

The second box is the whole pitch: a pure-static tool flags it dead and burns the user; Necro quarantines it with reasons.

---

## 6. Test-runner plugin (first plugin, fully spec'd)

The test-runner plugin does **two opposite jobs**:

1. **Don't flag test infrastructure as dead.** Test files, setup files, and config files are consumed by the runner, never imported by production code. Missing this flags the entire test suite as dead.
2. **Don't flag test-only production code as alive.** A util imported only by `*.test.ts` is reachable (tests use it) but production-dead. It deserves a third verdict, `test-only` — "prod-dead, only tests keep it warm" — a signal no incumbent surfaces cleanly.

### Two-color reachability

Edges carry a `kind`: `prod` | `test`. An edge from a test-matched file is `test`-kind.

```
1. mark PROD entries → BFS over prod edges only   → reachedByProd
2. mark TEST entries → BFS over prod + test edges  → reachedByAny
3. classify:
   in reachedByProd            → alive
   in reachedByAny, not Prod   → test-only (prod-dead)
   in neither                  → dead candidate
```

Prod-first, two passes (or one pass carrying a `{prod, test}` bitset per node). Three outputs from one plugin.

### Plugin implementation

```ts
const testRunnerPlugin: FrameworkPlugin = {
  name: "test-runner",

  detect(ctx) {
    return ctx.hasDep(["vitest", "jest", "@jest/core", "mocha", "@playwright/test"])
        || ctx.hasConfig(["vitest.config.*", "jest.config.*"])
        || ctx.packageJsonHas("jest")
  },

  entryPatterns(ctx) {
    const cfg = resolveTestConfig(ctx)   // shell-out + static fallback, see below
    return [
      ...cfg.testMatch,        // test files = entries
      ...cfg.setupFiles,       // setup = entries
      ...cfg.globalSetup,
      ...cfg.configFiles,      // vitest.config.ts itself = entry
      "**/__mocks__/**",       // jest auto-mock convention
    ].map(g => ({ glob: g, kind: "test" }))
  },

  resolveEdges(ctx, graph) {
    return matchAutoMocks(ctx, graph)    // jest __mocks__/foo ↔ foo, implicit
  },

  taintRules(ctx) {
    return [{ pattern: "jest.mock(<non-literal>)", action: "taint-scope" }]
  },
}
```

### Config resolution — read config, never assume

The #1 self-destruct: hardcoding `**/*.test.ts` when the repo uses `**/*.spec.ts` flags every test as dead. Read the actual config.

| Runner | Source | Fields that matter |
|---|---|---|
| jest | `jest.config.*` or `package.json#jest` | `testMatch`/`testRegex`, `roots`, `setupFiles`, `setupFilesAfterEach`, `globalSetup`, `moduleNameMapper` |
| vitest | `vitest.config.*` or `test` block in `vite.config.*` | `include`, `exclude`, `setupFiles`, `globalSetup`, `alias` |

**Resolution strategy (decided): shell-out with static fallback.** Config files are code that can compute values, so let the runner report its own resolved config (`jest --showConfig` emits JSON). Static parse is the fallback when the runner cannot run. Vitest has no clean `--showConfig` equivalent — parse the `vite.config` test block or sandbox-import it; this is the messy part, budget for it.

`moduleNameMapper` / `alias` affect how imports resolve — honor them or edges break into false positives. (This is the graph-builder's job; the plugin surfaces them.)

**Shell-out guards:**
- Needs the runner installed and executable — fails in minimal CI, so the static fallback must be real, not a stub.
- Sandbox and timeout the shell-out; treat any shell-out as untrusted-code-adjacent. Never auto-run without a consent flag in CI.
- Cache resolved config by config-file hash; don't re-shell every run.

### Failure modes to test against

| Case | Breaks if | Guard |
|---|---|---|
| custom `testMatch` (`.spec` not `.test`) | convention assumed | read config |
| colocated vs `__tests__/` dir | only one handled | both, from config |
| monorepo, per-package configs | resolved once at root | per-package resolution |
| type-tests (`.test-d.ts`, tsd) | counted as runtime | route to type-only tier |
| e2e separate config (playwright) | merged with unit | treat as separate project / entry set |
| `setupFiles` defines globals | global usage looks unreferenced | defer — edge case, `maybe` tier |

### Verdict handling

`test-only` is **report-only for MVP**: emit the suggestion text ("prod-dead — delete fn + test, or wire into prod") but do not auto-apply. Deleting tests is high-risk and needs the LLM-fix flow plus strong confirmation first.

---

## 7. Fix layer (hybrid LLM)

Sharp boundary: the static layer is deterministic, runs always, and never calls the LLM. The LLM layer triggers only on `--fix` or `--explain`, per-finding, opt-in.

```
findings (static) ──> user picks one ──> LLM receives:
   { code_slice, finding_type, surrounding_context }
   ──> proposed diff ──> preview ──> y/n ──> git apply
```

Cache LLM responses by code-hash (same code, same suggestion, no re-pay). This keeps analysis fast/free/CI-safe and offline-capable; deterministic findings stay testable, LLM output stays out of scoring.

### Fix safety tiers

| Tier | Example | Behavior |
|---|---|---|
| Safe-auto | remove `certain`-dead code, format | `--fix-safe`, diff preview, git-clean guard, dry-run default |
| Assisted | extract duplicate → shared function | suggest diff, ask y/n |
| Refactor-suggest | god function → split by callee cluster | propose split points, human approves |
| Hands-off | deep nesting → guard-clause/early-return | suggest pattern, human writes |

Every fix: preview diff, dry-run by default, git-clean check before write, never silent mutation.

---

## 8. Build order (MVP)

Reordered to lead with the differentiator (false-positive-free dead code):

1. CLI scaffold + config loader (`crap.config.*`, ignore globs)
2. module graph builder (ts-morph) → symbol graph
3. plugin registry + entry resolver
4. two-color reachability
5. **test-runner plugin** (§6)
6. evidence-chain reporter
7. coverage-report ingestion (lcov / c8) → kill a false-positive class without paid runtime
8. syntactic detectors (nesting, cyclomatic, cognitive, god-function) via tree-sitter
9. duplication (wrap jscpd)
10. CRAP score + churn hotspots
11. `--fix-safe` (certain-dead removal; diff preview; git-clean guard)
12. LLM triage on the `maybe` tier
13. LLM fix, one type first (god-function split = best demo)

Steps 1–6 produce a tool that finds dead code, surfaces the `test-only` verdict, and shows evidence — beating Fallow on the exact axis (false positives) that motivated the project, in the first vertical slice.

---

## 9. Open items / future

- **Coverage ingestion** (step 7): does the target codebase generate coverage reports? If yes, coverage ingestion is the killer free false-positive resolver and undercuts Fallow's paid runtime pitch. If no, LLM triage carries the false-positive load.
- **Entry-point override syntax:** config globs + inline (`// crap-entry`) escape hatch. Config-first for MVP.
- **Next / Nest plugins:** prove the synthetic-edge mechanism (DI decorators, route conventions).
- **Python support (phase 2):** new IR adapter + symbol-graph adapter; `vulture` is the tool to beat. Detectors reused unchanged.
- **Ecosystem:** MCP server, LSP, CI/SARIF — greenfield vs. Fallow's maturity; conceded early, revisit post-MVP.
- **Performance (v2):** if Node speed becomes an adoption blocker, native-addon the hot path (parse + graph traversal via napi-rs / neon), keep orchestration + TS-semantic + LLM in Node. Not a full Rust rewrite.
