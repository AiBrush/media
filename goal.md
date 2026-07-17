# Implement the code cleanup to SOTA (work the REQUIREMENTS backlog)

**Mission:** Drive `aibrush-media` to state-of-the-art for every feature family by implementing the fix backlog in `REQUIREMENTS.md` — 334 delta items across 33 disjoint shards — until the Definition of Done is 100% green. The docs are the spec; make the code match them and beat the 7 rival engines in aggregate.

**Read first:** `REQUIREMENTS.md` (backlog + §0 invariants, §1 priorities, §2 cross-cutting themes), `BUILD_INSTRUCTIONS.md` (Definition of Done + per-feature loop), `docs/architecture/README.md` (target-spec index), `docs/architecture/COVERAGE.md` (which `src` files each shard owns), `docs/decisions/`, `docs/measured-evidence.md`.

**Rules (non-negotiable):**
- ULTRATHINK, max effort, every step. Never stop until Done; if blocked, pick the SOTA option and log it in `docs/decisions/`.
- Spawn agents on the **Fable** model, max effort; orchestrate via the **Workflow** tool. Run **as many agents in parallel as possible** — one per feature family / sub-family.
- **Conflict rule:** each agent owns exactly one shard's `src` files (disjoint per COVERAGE.md) and edits nothing outside them. Parallel code-editing agents run in **git worktree isolation**; integrate at a barrier.
- Obey §0 invariants on every item: strict TS, zero `any`; every `VideoFrame`/`AudioData` `close()`d exactly once; no capability leak (no backend/codec named above the driver layer); typed errors; `main` green each commit.
- **No feature without a strict bit-exact/structural oracle on real fixtures + a fresh multi-sample benchmark.** Never fake, never a loose gate, never a fabricated number.
- Reach **SOTA per family:** read the family doc, study its named OSS exemplar (mediabunny / ffmpeg / mp4box / web-demuxer / hls.js …), adopt the best ideas, then beat it.

**Phase 0 — Plan the waves (one agent):** from REQUIREMENTS + COVERAGE emit a dependency-ordered plan — which shards change shared contracts (go first) vs which are independent (max parallel). Confirm file ownership is disjoint.

**Phase 1 — Wave 0 foundations (P0 cross-cutting; sequenced/small parallel):** land ripple-causing changes before dependents — driver contracts (S04), capability router (S01), execution + frame-lifetime (S02, theme T4), then unbounded-cache (T2) and capability-leak (T3) fixes. Gate green before fan-out.

**Phase 2 — Fan out per family (max parallel, worktree-isolated):** one Fable/max-effort agent per remaining shard, owning only its `src` files. For each `R-Sxx.*` item: ultrathink → write the failing validation test → implement to SOTA (per doc + exemplar) → pass → add the benchmark → run the gate → green. Touch no other shard's files.

**Phase 3 — Integrate & win (barrier):** merge worktrees; run the full gate (typecheck, lint, all tests, benchmarks); register/refresh the `../media-test` harness (13 families × 7 engines); resolve cross-shard integration; update the doc + decision log for any forced design change (same commit). Loop until all-green.

**Done when:** every REQUIREMENTS item is resolved or consciously deferred with a logged decision; each touched feature has a strict oracle + fresh benchmark; full gate green; **win in aggregate vs all 7 engines** on the current harness; zero `any`, frames close-once, no capability leaks; docs + decision log reconciled; `main` green. Then stop and report.