#!/usr/bin/env bash
# run.sh — autonomous SOTA loop for @aibrush/media
# Continuously improves toward REQUIREMENTS.md using todo.md as live backlog.
# - Re-establishes baseline from latest media-test raw results (no fixture branching)
# - Picks highest-impact P0→P1 from todo.md (correctness > coverage > robustness > memory > speed > size)
# - Implements smallest clean fix, adds property/boundary/fuzz tests, runs gates
# - Uses todo.md as single source of truth — updates it each cycle, never creates history docs
# Usage: ./run.sh  |  bash run.sh --model opencode/muse-spark-1.2-contributor-free, opencode-go/qwen3.8-flash

set -euo pipefail

# ── palette ───────────────────────────────────────────────────────────────────────────────────
# Queried from terminfo via tput rather than hardcoded ANSI escapes, so the colors follow whatever
# the real terminal advertises. Auto-disabled when stdout is not a TTY (piping to a file or `tee`
# must stay clean), when TERM is dumb, or when NO_COLOR is set — see https://no-color.org.
# Set FORCE_COLOR=1 to keep colors through a pipe: ./run.sh 2>&1 | tee run.log
if { [[ -t 1 ]] || [[ -n "${FORCE_COLOR:-}" ]]; } \
   && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-dumb}" != "dumb" ]] \
   && command -v tput >/dev/null 2>&1; then
  C_RESET="$(tput sgr0   2>/dev/null || true)"; C_BOLD="$(tput bold    2>/dev/null || true)"
  C_DIM="$(tput dim      2>/dev/null || true)"; C_RED="$(tput setaf 1  2>/dev/null || true)"
  C_GREEN="$(tput setaf 2 2>/dev/null || true)"; C_YELLOW="$(tput setaf 3 2>/dev/null || true)"
  C_BLUE="$(tput setaf 4 2>/dev/null || true)"; C_MAGENTA="$(tput setaf 5 2>/dev/null || true)"
  C_CYAN="$(tput setaf 6 2>/dev/null || true)"
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""
  C_YELLOW=""; C_BLUE=""; C_MAGENTA=""; C_CYAN=""
fi
TAG="${C_DIM}${C_CYAN}[run.sh]${C_RESET}"

log()  { echo "${TAG} $*"; }
warn() { echo "${TAG} ${C_YELLOW}$*${C_RESET}" >&2; }
err()  { echo "${TAG} ${C_BOLD}${C_RED}$*${C_RESET}" >&2; }
rule() { echo "${C_BLUE}======================================================================${C_RESET}"; }

# ── opencode output rendering ─────────────────────────────────────────────────────────────────
# `opencode2 run` emits NO color of its own. Verified: no --color flag, FORCE_COLOR/CLICOLOR_FORCE
# ignored, and zero escape bytes even when attached to a real pty via script(1) — so there is
# nothing to simply "turn on". Its maintained structured surface is `--format json`, a live
# newline-delimited event stream (step_start / text / tool_use / step_finish), so we colorize THAT
# with jq rather than regex-painting its prose. Lines that are not JSON (e.g. stderr) pass through
# untouched. Falls back to opencode's own plain renderer when color is off or jq is unavailable.
OC_MAXLINES="${OC_MAXLINES:-10}"   # tool-output lines shown per call before truncating

IFS= read -r -d '' RENDER_JQ <<'JQ_EOF' || true
def clr(col; s): col + (s | tostring) + $reset;

# One-line summary of a tool call: prefer the field that actually identifies the work.
def brief:
  (.part.state.input // {}) as $in
  | (if   ($in.command  | type) == "string" then $in.command
     elif ($in.filePath | type) == "string" then $in.filePath
     elif ($in.path     | type) == "string" then $in.path
     elif ($in.pattern  | type) == "string" then $in.pattern
     elif ($in | length) == 0 then ""
     else ($in | tojson) end) as $s
  | if ($s | length) > 120 then ($s[0:117] + "...") else $s end;

# Tool output, bounded so one chatty test run cannot flood the loop console.
def outp:
  (.part.state.output // "") as $o
  | if ($o | length) == 0 then ""
    else ($o | rtrimstr("\n") | split("\n")) as $lines
      | ($maxlines | tonumber) as $max
      | (if ($lines | length) > $max
         then ($lines[0:$max] + ["... \(($lines | length) - $max) more line(s)"])
         else $lines end)
      | map("    " + clr($dim; .)) | join("\n") + "\n"
    end;

def render:
  if .type == "text" then
    (.part.text // "" | rtrimstr("\n")) as $t
    | if ($t | length) == 0 then ""
      else (($t | split("\n")) | map(clr($cyan; "| ") + .) | join("\n")) + "\n" end
  elif .type == "tool_use" then
    (.part.state.status // "pending") as $st
    | (.part.state.metadata.metadata.exit) as $exit
    | (if   $st == "completed" then clr($green;  "OK ")
       elif $st == "error"     then clr($red;    "ERR")
       else                         clr($yellow; "..." ) end) as $icon
    | $icon + " " + clr($bold + $magenta; (.part.tool // "tool"))
      + (if (brief | length) > 0 then " " + clr($blue; brief) else "" end)
      + (if $exit != null and $exit != 0 then " " + clr($red; "exit \($exit)") else "" end)
      + "\n"
      + (if $st == "error"
         then clr($red; "    " + ((.part.state.error // "failed") | tostring)) + "\n"
         else outp end)
  else "" end;

. as $line
| (try ($line | fromjson) catch null) as $event
| if $event == null
  then (if ($line | length) > 0 then $line + "\n" else "" end)
  else ($event | render) end
JQ_EOF

render_opencode() {
  jq -j -R --unbuffered \
    --arg reset "$C_RESET" --arg bold "$C_BOLD" --arg dim "$C_DIM" \
    --arg red "$C_RED" --arg green "$C_GREEN" --arg yellow "$C_YELLOW" \
    --arg blue "$C_BLUE" --arg magenta "$C_MAGENTA" --arg cyan "$C_CYAN" \
    --arg maxlines "$OC_MAXLINES" \
    "$RENDER_JQ"
}

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
    -h|--help) echo "${C_BOLD}Usage:${C_RESET} $0 [--model <id>]"; echo "  Loops opencode run with @todo.md + @REQUIREMENTS.md until SOTA gates pass."; exit 0 ;;
    *) err "unknown arg $1"; exit 2 ;;
  esac
done

if [[ ! -f "$TODO_MD" ]]; then err "ERROR: $TODO_MD not found"; exit 1; fi
if [[ ! -f "$REQUIREMENTS_MD" ]]; then err "ERROR: $REQUIREMENTS_MD not found"; exit 1; fi
if ! command -v opencode2 >/dev/null 2>&1 && ! command -v opencode >/dev/null 2>&1; then err "ERROR: opencode2 not found"; exit 1; fi
if ! command -v bun >/dev/null 2>&1; then err "ERROR: bun required (media + media-test)"; exit 1; fi

OPENCODE_BIN="$(command -v opencode2 || command -v opencode)"

# Pre-flight: ensure media builds and media-test vendor is in sync — silent unless fails
if ! ( cd "$ROOT_MEDIA" && bun run build > /tmp/media-build.log 2>&1 && bun run vendor-wasm > /tmp/media-vendor.log 2>&1 ); then
  err "✗ build failed"
  tail -n 20 /tmp/media-build.log 2>&1 || true
fi
log "${C_DIM}syncing vendor...${C_RESET}"
( cd "$ROOT_TEST" && bun run sync-vendor > /tmp/sync-vendor.log 2>&1 ) || true
# no pre-flight chatter — only model messages will show

CYCLE=0
while true; do
  CYCLE=$((CYCLE+1))
  OPEN_COUNT="$(grep -c "^\- \[ \]" "$TODO_MD" || true)"
  DONE_COUNT="$(grep -c "^\- \[x\]" "$TODO_MD" || true)"
  # Backlog drained is the goal state, so paint it green instead of the usual work-remaining yellow.
  if [[ "${OPEN_COUNT:-0}" -eq 0 ]]; then OPEN_COLOR="$C_GREEN"; else OPEN_COLOR="$C_YELLOW"; fi

  echo ""
  rule
  echo "${TAG} ${C_BOLD}${C_CYAN}CYCLE ${CYCLE}${C_RESET}  ${C_DIM}$(date -u +%Y-%m-%dT%H:%M:%SZ)${C_RESET}  model=${C_MAGENTA}${MODEL}${C_RESET}"
  echo "${TAG} todo open: ${OPEN_COLOR}${C_BOLD}${OPEN_COUNT}${C_RESET}   done: ${C_GREEN}${C_BOLD}${DONE_COUNT}${C_RESET}"
  rule

  # The prompt is the entire product spec — it forces the agent to:
  # 1) read todo.md + goal.md + REQUIREMENTS.md as ground truth,
  # 2) re-establish baseline from latest media-test results/raw + repo state,
  # 3) pick the highest-impact unchecked box from todo.md (not easiest test),
  # 4) implement smallest clean production fix (latest API only, no shims, no fixture branching),
  # 5) add generalized unit/property/boundary/malformed/randomized tests,
  # 6) run focused repo tests + relevant media-test cell/family + typecheck/docs/biome/build/budgets and inspect validity,
  # 7) update todo.md (check the box, add next), record before/after evidence, then immediately continue,
  # 8) at the end check if zero FAIL/ERROR and all bundle/memory/speed gates pass — answer NO and loop if not, else YES.
  # NOTE: assigned via `read -r -d ''`, NOT `PROMPT="$(cat <<'EOF' ...)"`. macOS bash 3.2 does not
  # skip heredoc bodies when scanning for the `)` that closes a command substitution, so the bare
  # `a)`/`b)`/`c)`/`d)` in the gate list below would close it early — the rest of the prompt then
  # gets re-parsed as shell code (running the backticked `bun run build`, `id`, `grep`, ...) and the
  # script dies at 127 under `set -e` before ever invoking opencode. `read` has no such parser path.
  IFS= read -r -d '' PROMPT <<'PROMPT_EOF' || true
LOOP — aibrush/media SOTA — single source: @todo.md

LOOP UNTIL `grep -c "^- \[ \]" todo.md` == 0
      AND `media-test/results/cache-chromium-*.json` → aibrush-media@dev 0 FAIL / 0 ERROR (valid)
      AND `bun run build && bun run check-budgets` PASS:

1. READ `todo.md` → pick top unchecked in `NEXT UP`
   Order: P0 correctness > P0 performance > P1 coverage
   (FAIL 0.1.x > NA 1.1.x > SSIM 1.2/1.3 > timeout 0.2 > bundle/perf > matrix)
   Never pick easiest — pick top.

2. FIX — smallest clean fix in `aibrush.lib/media/src` (latest API only)
   - No branching on fixture name / hash / size / ID / oracle / timing
   - No weakening of gate or oracle
   - General, parameterized by bytes/config/capability

3. TESTS — add 5 general variants for the fix:
   unit / property / boundary / malformed / randomized
   (no fixture-specific data)

4. GATES — must all pass, verify output not just exit code:
   a) `bun run typecheck`
   b) `bun run test --run` (focused + full 5826)
   c) MEDIA-TEST VERIFY:
      `cd aibrush.lib/media-test`
      `bash scripts/serve.sh` → http://127.0.0.1:5152
      then: `bash scripts/run.sh --browser chromium --feature <family> --engine aibrush-media --pillar functional --no-reuse --scenario <id>`
      → check 0 FAIL / 0 ERROR for that `id`, inspect SHA/rgba, wall vs winner
   d) `bun run build && bun run check-budgets` (50KiB eager / 250KiB typical / 1MiB heavy)

5. UPDATE `todo.md` IN PLACE:
   `- [ ] → - [x]` for that `id`, re-rank `NEXT UP`, no history docs.

6. REPORT:
   before→after PASS counts (from `cache-chromium-*.json`) + 5-10 `file:line` refs
   If not 0 FAIL/0 ERROR + budgets PASS → answer NO, next cycle immediately.
   Only YES when `grep -c "^- \[ \]" == 0` and full chromium cache re-run PASS and geomean leadership (90% within 5%, p95 ≤ winner).

Anti-overfit: treat `media-test` as external evaluator. Learn from mediabunny/ffmpeg/mp4box/remotion strategy, re-derive better (fewer copies, fused, zero-copy, bounded memory).
PROMPT_EOF

  set +e
  if [[ -n "$C_RESET" ]] && command -v jq >/dev/null 2>&1; then
    # PIPESTATUS[0] — plain $? would report jq's status, not opencode's.
    "$OPENCODE_BIN" run --format json --model "$MODEL" "$PROMPT" 2>&1 | render_opencode
    EXIT_CODE="${PIPESTATUS[0]}"
  else
    "$OPENCODE_BIN" run --model "$MODEL" "$PROMPT" 2>&1
    EXIT_CODE=$?
  fi
  set -e
  echo ""
  echo "${C_DIM}${C_YELLOW}=================================== Sleep For 5 Minutes ===================================${C_RESET}"
  echo ""

  sleep 300

  # Re-sync vendor silently for next baseline
  ( cd "$ROOT_MEDIA" && bun run build > /tmp/media-build.log 2>&1 && bun run vendor-wasm > /tmp/media-vendor.log 2>&1 ) || true
  ( cd "$ROOT_TEST" && bun run sync-vendor > /tmp/sync-vendor.log 2>&1 ) || true
done
