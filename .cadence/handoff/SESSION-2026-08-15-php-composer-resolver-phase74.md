---
cadence_handoff: 1
generated_at: 2026-08-15T15:29:38.353Z
label: php-composer-resolver-phase74
loop_position: IDLE
active_phase: 74-php-composer-resolver
active_draft: 
tier: 
git_branch: main
git_dirty: true
git_head: f92370c
git_ahead: 4
git_behind: 0
context_packet: .cadence/intelligence/context/handoff.json
---

# Session Handoff — 2026-08-15 (php-composer-resolver-phase74)

## TL;DR for the next session
- Phase 74-01 (PHP composer-autoload resolver, `php-support-design.md` §4 Phase B) shipped, settled, and committed (`f92370c`) — 6 tasks, 57 new tests, full suite 909 green, typecheck/lint clean.
- Real-repo measurement (AC-4): guzzle 355/360 (98.6%), phpunit 7164/7263 (98.6%), both clear the 95% floor — reached only after fixing real locality-measurement bugs found by actually running the harness against the real checkouts, not assumed.
- Settle needed `--force` after two `--deep` verifier runs: a mix of real findings (fixed in the DRAFT text) and false ones (disproven with file:line citations, documented in `74-01-SUMMARY.md`'s `## Decisions` section rather than silently bypassed).
- Also set `verification.testCommand: "npm test"` in `.cadence/config.json` (repo-wide change) so future `--deep` settles get real executed test evidence instead of a skip.
- **Blocker — the single next action needs a human decision first**: `php-support-design.md` §5.7 asks whether Phase C should extend `model.ts`'s hardcoded two-way TS/Python file partition a third time for PHP, or generalize to a `LanguageGraphPlugin` interface. Not yet answered — do not start drafting Phase C until this is resolved.
- 4 commits ahead of `origin/main`, not pushed (this session never pushes without asking).

## State on handoff   ·  pre-filled — verify, don't retype
- Branch `main` (dirty), 4 ahead / 0 behind origin
- HEAD `f92370c`
- Recent commits:
```
f92370c feat(74): PHP composer-autoload resolver — namespace/class → file (php-support-design.md §4 Phase B)
7b5192b chore(cadence): stamp session handoff — 2026-08-15
fd25070 docs: sync README/website with shipped v1.7.0 state
4a539a1 feat(72): PHP syntactic axis — complexity/duplication/hotspots (rec-20260814-003)
909d2d2 chore(release): create a GitHub Release on every npm publish
4f0c5f2 feat: rename npm scope to @thomas-powers-jr and release v1.7.0
fcfd9e0 chore(cadence): stamp session handoff — 2026-08-15
1e621ed feat(71): flip Python to default-on now that the accuracy floor is cleared (rec-20260814-002)
```
- Uncommitted (diff --stat):
```
.cadence/STATE.md                                  |  6 +--
 .../74-php-composer-resolver/74-01-SUMMARY.json    | 60 +++++++++++++++++++---
 .cadence/state.json                                | 11 ++--
 3 files changed, 61 insertions(+), 16 deletions(-)
```
- Loop: IDLE · phase 74-php-composer-resolver · tier (none)

## CADENCE context   ·  pre-filled from `cadence context handoff`
- Top recommendations:
  - rec-20260814-005 — Security review of the LLM/auto-fix pipeline (candidate/raw-idea)
  - rec-20260814-008 — Lift the Python certain-tier cap (classify.ts AC-6) with tier-stratified validation (candidate/needs-evidence)
  - rec-20260814-004 — Cross-language and fuzzy (Type-3) clone detection (candidate/raw-idea)
  - rec-20260814-006 — test-only auto-apply and cascading re-analysis after fix (candidate/raw-idea)
  - rec-20260814-007 — Recency-weighted churn and ownership scoring for hotspots (candidate/raw-idea)
- Open assumptions:
  - (none)
- Active decisions:
  - (none)
- Files in play:
  - (none)

## What landed this session
- Drafted 74-01 (phase 73 was claimed mid-session by a concurrent worktree — `necro-worktrees/73-drop-node-20-support` — so this landed as phase 74 per `cadence draft new`'s own collision-guard suggestion).
- T1 `src/graph/php/composer-manifest.ts` — composer.json `psr-4`/`psr-0`/`classmap`/`files` + `autoload-dev` parsing, best-effort empty on missing/malformed, never throws.
- T2 `src/graph/php/composer-autoload.ts` — psr-4/psr-0 path-derived FQCN↔file map (longest-prefix-first, mirroring `module-resolver.ts`'s own discipline), classmap scan filtered from the already-discovered file set (not an independent fs walk).
- T3 `src/graph/php/declared-symbols.ts` — namespace-tracking declaration walk (braceless/braced/global forms), class/interface/trait/enum extraction, walks the whole tree (catches conditionally-declared polyfill-pattern classes).
- T4 `src/graph/php/import-parser.ts` — namespace/`use`-import parser, all 5 verified `use`-clause grammar shapes (simple/single-segment/aliased/grouped/function-const).
- T5 `src/graph/php/resolve-import.ts` — PHP's actual class-name resolution rules (leading-backslash always fully-qualified; first-segment-vs-imports substitution, covering both single- and multi-segment forms with one rule; current-namespace fallback; **no** global-namespace fallback for unqualified classes, unlike PHP's function/const rule).
- T6 `src/bench/php-import-resolution-rate.ts` harness (not wired into CI, mirrors Python's own precedent) + fixture-tree end-to-end suite + AC-5 regression guard (`model.ts` doesn't import the new resolver modules yet).
- Grammar facts (`namespace_definition`, all 5 `namespace_use_declaration` shapes, the 4 top-level declaration node types, qualified-name structure) verified live against `tree-sitter-php.wasm` this session via throwaway scratchpad probes — **not committed**, not assumed by analogy to JS/Python.
- Settled with `--force` after documenting a disproof of 4 false deep-verify findings (file:line citations against actual passing tests / PROGRESS.json content) in `74-01-SUMMARY.md`'s `## Decisions` section.
- Committed as `f92370c`.

## Carry-forward gotchas
- **Most important**: `php-support-design.md` §5.7's architecture question (hardcode a third PHP branch in `model.ts` vs. generalize to a `LanguageGraphPlugin` interface) is now more concretely motivated by this session's own T2 work — a *second* copy-pasted "exclude this language's files" pattern was added (`isPythonFile`/`isPhpFile` both checked in the same boolean expression in `model.ts:132-146`, roughly), sharpening the two-vs-generalize tradeoff. **Ask the user before scoping Phase C's draft** — don't guess.
- PSR-0 (legacy composer autoload) has a genuine, *inherent*, documented path→FQCN ambiguity for namespace-style prefixes with an underscored final segment. Do **not** attempt to "fix" this reactively if a future verifier flags it again — a first fix attempt during this session was shown (via advisor consult) to be actively *wrong*, not just incomplete, and was reverted. See `composer-autoload.ts`'s `psr0Fqcn` doc comment and `74-01-DRAFT.md`'s AC-1 correction note for the full reasoning before touching this again.
- Two real, durable Phase C carry-forwards surfaced by the real-repo measurement (not resolver bugs — genuine multi-class-per-file / `files`-autoload-side-effect patterns pure PSR-4 path derivation can't resolve by construction, correctly counted as failures): guzzle's `tests/Psr17SpyFactory.php` declares `SpyStream`/`SpyResponse` as *extra* classes alongside its filename-matching one; phpunit's `PHPUnit\Event\AbstractEventTestCase` is declared inside a `files`-autoload script. Phase C's design should explicitly decide whether psr-4-scoped files also get content-scanned as a fallback when direct path lookup fails.
- `deep-verify` (host-cli provider) produced several **false** findings across two `--deep` runs this session (test-coverage claims directly contradicted by passing tests visible in the diff; a PROGRESS.json content claim contradicted by that same file's visible content) — confirmed not a `diffCapBytes` truncation issue (diff was 103KB vs. the 262KB cap). If a future settle is refused with a claim that doesn't match visible source/tests, check primary sources before trusting the verifier's specific wording — it can hallucinate specifics even when the general shape of a concern (or a *different* AC's finding in the same run) is worth taking seriously.
- `verification.testCommand` is now set to `npm test` in `.cadence/config.json` (this session's own change, previously unset) — future `--deep`/`--auto` settles will actually execute the full suite as a gate, not skip `build-test-must-pass`.
- Multiple concurrent Claude Code sessions are active in this same repo (a `necro-worktrees/73-drop-node-20-support` worktree claimed phase 73 mid-session, via CADENCE's own phase-collision guard) — check `git log`/mtimes/`ListAgents` before assuming any unexpected working-tree change is wrong.

## Next action
**Action:** Ask the user for `php-support-design.md` §5.7's decision — extend `model.ts`'s hardcoded two-way TS/Python file partition to a third PHP branch (cheap, consistent with precedent, the design doc's own recommendation) vs. generalize now to a `LanguageGraphPlugin` interface (a larger, riskier refactor whose only regression gate is "the existing TS+Python suite, including both accuracy-gate tests, stays green — nothing changed"). Once answered, draft the next PHP phase (Phase C — PHP symbol graph + reachability integration, `php-support-design.md` §4) scoping: symbol tables, reference edges (incl. trait/interface edges, typed-property/param-directed `->` resolution), magic-method/dynamic-dispatch taint patterns (§2.2.3, resolve the AST-vs-regex question §5.3), tier cap, the §5.7 language-partition decision just made, PHP entry-point resolution (composer `bin`, `public/index.php`, PHPUnit test globs, library quarantine per §5.4), and `fix`/`verify-removal` refusal for PHP symbols. This is design doc's own largest single phase — plan for a multi-task DRAFT, following the same rigor this session used (live grammar probes before writing ACs, not assumed by analogy; re-verify current file:line locations fresh, don't trust this doc's). Run `cadence draft new <phase> 01 --title="..."` — check for a worktree phase-collision first (phase 73 was already claimed mid-session; there may be others by now).
**Verify:** `cadence settle run --auto --deep` returns all ACs passing, full suite green, loop back to IDLE.
**If it fails:** if `deep-verify` flags something, verify the claim against actual source/tests before accepting it (this session found 4 false positives in one settle attempt — see gotchas above) — fix genuinely real gaps in the DRAFT/implementation, document any disproofs with file:line citations in `SUMMARY.md`'s `## Decisions` section rather than silently forcing past, and only use `--force` after that documentation is written. If §5.7's question can't get a clean answer from the user in reasonable time, default to the design doc's own recommendation (extend the two-way split) and flag the generalization explicitly as a separate, later refactor phase rather than blocking on it indefinitely.
