#!/usr/bin/env bash
# run.sh — autonomous SOTA loop for @aibrush/media
# Continuously improves toward REQUIREMENTS.md using todo.md as live backlog.
# - Re-establishes baseline from latest media-test raw results (no fixture branching)
# - Picks highest-impact P0→P1 from todo.md (correctness > coverage > robustness > memory > speed > size)
# - Implements smallest clean fix, adds property/boundary/fuzz tests, runs gates
# - Uses todo.md as single source of truth — updates it each cycle, never creates history docs
# Usage: ./run.sh  |  bash run.sh --model opencode/muse-spark-1.2-contributor-free

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_MEDIA="$SCRIPT_DIR"
ROOT_TEST="$SCRIPT_DIR/../media-test"
TODO_MD="$ROOT_MEDIA/todo.md"
REQUIREMENTS_MD="$ROOT_MEDIA/REQUIREMENTS.md"
GOAL_MD="$ROOT_MEDIA/goal.md"
MODEL="${MODEL:-opencode/muse-spark-1.2-contributor-free}"

# Parse --model flag if passed
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--model <id>]"; echo "  Loops opencode run with @todo.md + @REQUIREMENTS.md until SOTA gates pass."; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$TODO_MD" ]]; then echo "ERROR: $TODO_MD not found" >&2; exit 1; fi
if [[ ! -f "$REQUIREMENTS_MD" ]]; then echo "ERROR: $REQUIREMENTS_MD not found" >&2; exit 1; fi
if ! command -v opencode2 >/dev/null 2>&1 && ! command -v opencode >/dev/null 2>&1; then echo "ERROR: opencode2 not found" >&2; exit 1; fi
if ! command -v bun >/dev/null 2>&1; then echo "ERROR: bun required (media + media-test)" >&2; exit 1; fi

OPENCODE_BIN="$(command -v opencode2 || command -v opencode)"

# Pre-flight: ensure media builds and media-test vendor is in sync — silent unless fails
if ! ( cd "$ROOT_MEDIA" && bun run build > /tmp/media-build.log 2>&1 && bun run vendor-wasm > /tmp/media-vendor.log 2>&1 ); then
  echo "[run.sh] ✗ build failed"
  tail -n 20 /tmp/media-build.log 2>&1 || true
fi
echo "[run.sh] syncing vendor..."
( cd "$ROOT_TEST" && bun run sync-vendor > /tmp/sync-vendor.log 2>&1 ) || true
# no pre-flight chatter — only model messages will show

CYCLE=0
while true; do
  CYCLE=$((CYCLE+1))
  echo ""
  echo "======================================================================"
  echo "[run.sh] === CYCLE $CYCLE $(date -u +%Y-%m-%dT%H:%M:%SZ) model=$MODEL ==="
  echo "[run.sh] todo open items: $(grep -c "^\- \[ \]" "$TODO_MD" || true)  done: $(grep -c "^\- \[x\]" "$TODO_MD" || true)"

  # The prompt is the entire product spec — it forces the agent to:
  # 1) read todo.md + goal.md + REQUIREMENTS.md as ground truth,
  # 2) re-establish baseline from latest media-test results/raw + repo state,
  # 3) pick the highest-impact unchecked box from todo.md (not easiest test),
  # 4) implement smallest clean production fix (latest API only, no shims, no fixture branching),
  # 5) add generalized unit/property/boundary/malformed/randomized tests,
  # 6) run focused repo tests + relevant media-test cell/family + typecheck/docs/biome/build/budgets and inspect validity,
  # 7) update todo.md (check the box, add next), record before/after evidence, then immediately continue,
  # 8) at the end check if zero FAIL/ERROR and all bundle/memory/speed gates pass — answer NO and loop if not, else YES.
  PROMPT="$(cat <<'PROMPT_EOF'
You are the autonomous @aibrush/media SOTA loop. Read these as ground truth:

- @todo.md — the live continuous-improvement backlog (single source of truth, 115 lines, 5 phases + NEXT UP). Update it in place each cycle: check the box you just completed, add any new discovered gap, keep it sorted by impact (correctness > coverage > robustness > memory > speed > size). Never create progress/history docs.
- @goal.md — the 7-step feature-sized cycle + anti-overfitting rules.
- @REQUIREMENTS.md — the SOTA definition (broadest correct coverage, fastest correct execution, smallest route-specific bundle, bounded memory, reliable cross-browser).

Work ONE feature-sized cycle:

1. Re-establish baseline: `bun run sync-vendor` in /Users/tarek/Home/software/projects/aibrush/aibrush.lib/media-test (must run before every media-test — already done by run.sh, just verify `✓ synced`), then read latest `results/raw/*.json` + `git status`. Use todo.md as backlog, not easiest test.

2. From todo.md pick the highest-impact UNCHECKED box — Priority: P0 (Phase 1) > P1 (Phase 2) > Phase 3 > Phase 4. Prefer root-cause fixes.

3. Implement smallest clean fix in `aibrush.lib/media/src` (latest API only, no fixture branching).

4. Add generalized unit/property/boundary/malformed/randomized tests.

5. Run gates:
   - `bun run typecheck` + `vitest run` (focused)
   - relevant `media-test` cell via `bash scripts/run.sh --browser chromium --feature <family> --engine aibrush-media --pillar functional --no-reuse` (from /Users/tarek/Home/software/projects/aibrush/aibrush.lib/media-test)
   - `bun run build && bun run check-budgets`

6. Update todo.md (check the box, keep NEXT UP re-ranked). No history docs.

Anti-overfitting: Never branch on fixture names/hashes/sizes/IDs/expected outputs. Never weaken tests.

After the cycle: report before→after PASS counts and file:line refs (5-10 lines). Then check gate — if not zero FAIL/ERROR + bundle/memory/speed gates pass, answer exactly:

NO

and be ready for next cycle. Only answer YES when all gates pass.
PROMPT_EOF
)"

  set +e
  "$OPENCODE_BIN" run --model "$MODEL" "$PROMPT" 2>&1
  EXIT_CODE=$?
  set -e
  sleep 300

  # Re-sync vendor silently for next baseline
  ( cd "$ROOT_MEDIA" && bun run build > /tmp/media-build.log 2>&1 && bun run vendor-wasm > /tmp/media-vendor.log 2>&1 ) || true
  ( cd "$ROOT_TEST" && bun run sync-vendor > /tmp/sync-vendor.log 2>&1 ) || true
done
