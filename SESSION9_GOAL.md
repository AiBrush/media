# SESSION 9 — GOAL (win on speed: SOTA performance vs every competitor)

## Scope (binding)

Correctness is won — **#1, 557 PASS / 0 FAIL / 0 ERROR** on Chromium. This session wins the **other** axis: **speed**. The fresh multi-engine timing export (2026-07-01, all 8 engines now timed) shows that on the **444** Chromium scenarios where we **and ≥1 rival both PASS the identical oracle**, **a rival is faster in 325 (73%)** — sometimes 100–1000×. We are #1 on *what* we do, near-last on *how fast*. Fix that until we are the fastest — or tied-fastest — engine on **every** contested feature.

**In scope:** wall-time (and honestly-measured throughput/peakMemory) on **Chromium** — the browser the leaderboard scores apples-to-apples. **Out of scope:** any new feature; any oracle change; WebKit/Firefox-specific tuning; the honest-NA cells (MP3 encode, HEVC Main10, H.264 two-pass).

## The work (one feature at a time)

1. **Generate the to-do backlog** — run `docs/perf/gen-deficits.mjs` on the latest export to write `docs/perf/performance-deficits.md`: every deficit cell, ranked, our ms vs the fastest rival's. Regenerate it every round; it is the living worklist and the speed gate.
2. **Close each deficit, top-down, one at a time.** Two root causes cover almost all:
   - **A — whole-file scanning** (we read the whole file where rivals seek to `moov`/index): all 6 catastrophic + most severe cells. Biggest wins.
   - **B — fixed per-op overhead** (init/worker/WebCodecs-config/copies dominate on tiny inputs): the 211-cell tail.
3. **Study competitors to learn technique** — read mediabunny/mp4box/web-demuxer/remotion source & behaviour, understand *why* they win, then re-implement the idea as our own SOTA TS. **Never copy their code; never fake; never weaken an oracle to win.**

## Definition of Done

Full detail: @BUILD_INSTRUCTIONS_SESSION9.md

- A cell is **done only when** our fresh **multi-sample (n≥5)** median wall ≤ the fastest rival's on the **same oracle-passing workload**. `gen-deficits.mjs` must report **0 losses** (any residual is an ADR-documented same-work-impossible tie, never an unexplained loss).
- Correctness **un-regressed** (still 557/0/0; no PASS→FAIL; oracle files byte-identical); no frame/memory leaks; typed errors only; force-software determinism intact.
- `bun run gate` exits 0; coverage ≥90%; budgets green with margin (lazy-split perf indices/caches); anti-cheat green.
- ADRs from the free range (118–120, 122+) for each non-trivial technique; `docs/notes/` design notes; both perf docs in sync; a fresh aggregate recorded showing us **#1 on speed** too.

One line: **make aibrush-media the fastest (or tied-fastest) engine on every contested Chromium cell — 0 deficits — with correctness un-regressed and `bun run gate` green.**
