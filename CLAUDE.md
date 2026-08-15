# necro

<!-- cadence:managed:start -->
## CADENCE

This project uses **CADENCE** — a disciplined draft → approve → build → settle
loop. Do not freelance multi-step work; run it through the loop.

- **Project:** necro
- **Config preset:** solo
- **Gate profile:** auto (gates scale with profile × tier — see https://github.com/thomas-powers-jr/cadence/blob/main/docs/concepts.md)

### Where state lives

- `.cadence/ROADMAP.md` — phases and milestones
- `.cadence/STATE.md` — current loop position, active draft/phase (derived; do not hand-edit)
- `.cadence/phases/<phase>/` — per-phase DRAFT / PROGRESS / SUMMARY
- `README.md` — this project's usage; CADENCE concepts + the gate universe: https://github.com/thomas-powers-jr/cadence/blob/main/docs/concepts.md

### The loop

1. `cadence draft new <phase> <num> --title=…` — scaffold a DRAFT
2. edit the DRAFT (Objective, Acceptance Criteria, Tasks, Boundaries)
3. `cadence draft approve <phase> <num>` — coherence + gate checks, enter BUILD
4. `cadence build task <id> --status=DONE` — record each task
5. `cadence settle run --auto` — derive AC verdicts, write SUMMARY, return to IDLE

Run `cadence progress` anytime for the next suggested step. Regenerate this
block with `cadence init --claude-md`; edits outside the markers are kept.
<!-- cadence:managed:end -->
