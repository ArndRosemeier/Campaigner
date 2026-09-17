#!/usr/bin/env bash
# THE gate for this repo — the ONE way to run the suite (AGENTS §Host hygiene 7).
#
# Owner directive, verbatim: "please make sure that you restrict the mem use to
# not more than 4gb or so since you are not the only worker here."
#
# What it enforces, and why each part exists:
#   * ONE suite at a time, via an ATOMIC lock (mkdir). `pgrep` is a snapshot, not
#     a lock: two agents can look in the same instant and both start.
#   * Foreign suites are never reaped, only waited for — the owner runs another
#     DSH project on this box, in the same user account.
#   * CHUNKED runs in SEPARATE PROCESS GROUPS. The growth that fills this box is
#     OFF-heap (pdfjs holds ArrayBuffers), so no heap cap can stop it; a fresh
#     process per chunk bounds it. Each chunk is launched with `setsid`, so its
#     own process group IS its own tree and the watchdog can address one chunk
#     without touching its sibling.
#   * AT MOST TWO CHUNKS CONCURRENTLY (docs/17 row 175), each with ONE worker —
#     the same total worker budget the config default already allows. The two
#     long poles are `tests_features_a` + `tests_features_b`: the old single
#     137-file features chunk was 44% framework overhead and over half the gate.
#     `GATE_PARALLEL_CHUNKS=1` forces sequential for a run that owns nothing else.
#   * A WATCHDOG samples the COMBINED RSS of every live chunk's process group
#     every second. At the RSS cap or below the available-memory floor it kills
#     ALL live chunks; a killed chunk is VOID and is re-run SEQUENTIALLY, never
#     counted. If the combined peak merely APPROACHES the cap while two chunks
#     run, the gate falls back to sequential BEFORE the kill line, loudly.
#   * FAIL-FAST ORDER + exactly TWO safe skips. The chunks a diff touches run
#     FIRST (a red surfaces in ~1-2 minutes, not ~12). Vitest is skipped
#     ENTIRELY only for a docs-only diff; only the affected chunks run for a diff
#     that touches test files ALONE. Every other diff runs the full set — no
#     other skipping, ever: a gate that guesses at coverage is the failure mode
#     this script refuses.
#   * TWO TIERS, because they answer two different questions (docs/22 §7).
#     `GATE_TESTS=0` is the COMPILE tier: typecheck by default (`GATE_CHECKS=lint`
#     or `all` adds eslint), no suite, exit 2 on success — plus `pnpm build` when
#     the diff touches the build's own inputs (`vite.config.*`, `tsconfig*.json`,
#     `package.json`, the lockfile, `index.html`, `public/`), because `tsc -b`
#     cannot prove `vite build` succeeds and the owner needs every pushed build
#     to stay testable (`GATE_BUILD=0` refuses that build deliberately, loudly).
#     The fast loop uses it before a push, because the deploy job runs
#     `pnpm build` (= `tsc -b && vite build`), so a TYPE error is what breaks a
#     deploy — not a failing test. The FULL run (the default; exit 0 = GREEN,
#     exit 1 = RED) is what makes a change VERIFIED, and it follows the push
#     rather than blocking it. A compile-tier result must never be reported as
#     "the gate passed": it did not run the suite, and it says so in its banner.
#
# Exit codes: 0 = full gate GREEN · 1 = RED · 2 = compile tier only (NOT
# verified) · 9 = the lock is held by another suite.
#
# Usage:
#   scripts/gate.sh                     # typecheck + lint + every chunk, summed
#   GATE_TESTS=0 scripts/gate.sh        # COMPILE ONLY: typecheck (26s), no suite
#   GATE_TESTS=0 GATE_CHECKS=all scripts/gate.sh   # compile tier + eslint (~2m)
#   scripts/gate.sh tests/lib           # only that chunk (still locked, capped)
#   GATE_PLAN_ONLY=1 scripts/gate.sh    # print the plan (mode, chunks, order), exit
#
# Env: GATE_RSS_CAP_MB (default 3000), GATE_AVAIL_FLOOR_MB (default 2500),
#      GATE_PARALLEL_CHUNKS (1|2, default 2), GATE_PARALLEL_FALLBACK_MB
#      (default 90% of the cap), GATE_MAX_VOID_RETRIES (default 1),
#      GATE_TESTS (1|0, default 1), GATE_CHECKS (typecheck|lint|all, default
#      typecheck, compile tier only), GATE_BUILD (1|0, default 1: build on a
#      build-config diff), GATE_DIFF_BASE (default origin/main),
#      GATE_LOGDIR (default <repo>/.gate-logs/gate-<pid> — IN THE WORKSPACE, so a
#      background run's evidence outlives the process; /tmp is per-call here),
#      GATE_LOCK (default <workspace>/.campaigner-lock — the ONE suite lock, on a
#      path shared by every shell AND every worktree, derived from the git common
#      dir; a /tmp lock is invisible across calls in this harness)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2
TOTAL_START=$(date +%s)
RSS_CAP_MB="${GATE_RSS_CAP_MB:-3000}"
AVAIL_FLOOR_MB="${GATE_AVAIL_FLOOR_MB:-2500}"
LOGDIR="${GATE_LOGDIR:-$PWD/.gate-logs/gate-$$-$(date -u +%Y%m%dT%H%M%S)-$RANDOM}"
# The lock MUST be on a path shared by every shell AND every worktree, and it
# must be derivable identically from the main tree and from a worktree.
#   * /tmp is out: per-call and read-only in this harness.
#   * $PWD is out: each worktree would get its own lock.
# `git rev-parse --git-common-dir` is the ONE path identical in both (the main
# tree's .git), so resolve it to an absolute path and take its parent — the repo
# root — giving <repo>/.campaigner-lock everywhere. GATE_LOCK overrides.
_common="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
case "$_common" in /*) ;; *) _common="$PWD/$_common" ;; esac
LOCK_BASE="$(dirname "$_common")"
[ -d "$LOCK_BASE" ] || LOCK_BASE="$PWD"
LOCK="${GATE_LOCK:-$LOCK_BASE/.campaigner-lock}"
DIFF_BASE="${GATE_DIFF_BASE:-origin/main}"
PARALLEL_REQUESTED="${GATE_PARALLEL_CHUNKS:-2}"
case "$PARALLEL_REQUESTED" in
  1 | 2) ;;
  *)
    echo "!! GATE_PARALLEL_CHUNKS must be 1 or 2 (got '$PARALLEL_REQUESTED')" >&2
    exit 2
    ;;
esac
# GATE_TESTS=0 is the COMPILE tier: typecheck + lint, and NO suite. It exists
# because the fast loop needs one honest question answered before a push — "does
# this still build?" — and the answer is `tsc -b`, not the suite: the deploy job
# runs `pnpm build` (= `tsc -b && vite build`), so a type error fails the deploy
# and the live site silently keeps the previous bundle. The suite answers a
# DIFFERENT question (did behaviour move?) and is not skipped, only DEFERRED to
# the full run that follows the push. It never prints GATE GREEN — a result that
# did not run the suite must never be quotable as one.
GATE_TESTS="${GATE_TESTS:-1}"
case "$GATE_TESTS" in
  0 | 1) ;;
  *)
    echo "!! GATE_TESTS must be 0 or 1 (got '$GATE_TESTS')" >&2
    exit 2
    ;;
esac
COMPILE_ONLY=0
[ "$GATE_TESTS" = "0" ] && COMPILE_ONLY=1
# Which checks the compile tier runs. `typecheck` is the DEFAULT because it is
# the deploy-critical one (the deploy job runs `pnpm build` = `tsc -b && vite
# build`) and it is fast: MEASURED 26s cold and warm on this box, against 94s for
# `eslint .`. Lint is a correctness aid, not a build gate — it runs in the full
# tier either way — so `GATE_CHECKS=lint` (or `all`) opts it in when a change is
# lint-heavy and the extra ~94s is worth it. It is refused outside the compile
# tier, where lint always runs.
GATE_CHECKS="${GATE_CHECKS:-typecheck}"
case "$GATE_CHECKS" in
  typecheck | lint | all) ;;
  *)
    echo "!! GATE_CHECKS must be typecheck, lint or all (got '$GATE_CHECKS')" >&2
    exit 2
    ;;
esac
if [ "$COMPILE_ONLY" != "1" ] && [ "$GATE_CHECKS" != "typecheck" ]; then
  echo "!! GATE_CHECKS only selects the compile tier (GATE_TESTS=0); the full gate always runs lint + typecheck (got '$GATE_CHECKS')" >&2
  exit 2
fi
SOFT_FALLBACK_MB="${GATE_PARALLEL_FALLBACK_MB:-$((RSS_CAP_MB * 9 / 10))}"
MAX_VOID_RETRIES="${GATE_MAX_VOID_RETRIES:-1}"

command -v setsid >/dev/null 2>&1 || {
  echo "!! GATE: setsid is required (per-chunk process groups)" >&2
  exit 2
}

self=$$
foreign() { pgrep -af 'vites[t]|playwrigh[t]' 2>/dev/null | grep -v 'bash -c' | grep -v " $self " | grep -v "^$self "; }

# Plan scratch lives in the WORKSPACE, not /tmp: the chunk jobs are separate
# processes and a per-call, read-only /tmp would leave them unable to read the
# file lists. The LOCK, by contrast, is trapped only once it is OURS: a trap that
# removed a lock we do not own would delete a sibling gate's lock.
mkdir -p "$PWD/.gate-logs"
PLAN_DIR="$(mktemp -d "$PWD/.gate-logs/plan-XXXXXX")" || {
  echo "!! GATE: cannot create a plan dir under $PWD/.gate-logs" >&2
  exit 2
}
JOBS_DIR="$PLAN_DIR/jobs"
mkdir -p "$JOBS_DIR"
trap 'rm -rf "$PLAN_DIR"' EXIT

CHUNKS=()
declare -A CHUNK_FILES=()
# A chunk NAME is used to build log paths, so two names that differ only in their
# leading `tests_` would silently share ONE log file and corrupt both counts
# (real: a caller chunk named `features_a` against `tests_features_a`). Normalize
# every name into its own filename, once, here.
chunk_slug() { printf '%s' "$1" | tr '[:upper:]/' '[:lower:]-'; }

register_chunk() {
  local name="$1"
  shift
  local f="$JOBS_DIR/$(chunk_slug "$name").files"
  : > "$f"
  local p
  for p in "$@"; do printf '%s\n' "$p" >> "$f"; done
  CHUNKS+=("$name")
  CHUNK_FILES["$name"]="$f"
}

# ---------------------------------------------------------------------------
# The canonical inventory: SEVEN disjoint chunks. tests/features is split
# round-robin (not first-half/second-half) because per-file cost varies and
# alphabetical order is arbitrary with respect to it.
# ---------------------------------------------------------------------------
plan_default_chunks() {
  local -a lib llm db domain features fa fb remainder
  mapfile -t lib < <(find tests/lib \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
  mapfile -t llm < <(find tests/llm \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
  mapfile -t db < <(find tests/db \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
  mapfile -t domain < <(find tests/domain \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
  mapfile -t features < <(find tests/features \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
  mapfile -t remainder < <(find tests \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null |
    grep -vE '^tests/(lib|llm|db|domain|features)/' | sort)
  local f i=0
  fa=()
  fb=()
  for f in "${features[@]}"; do
    if [ $((i % 2)) -eq 0 ]; then fa+=("$f"); else fb+=("$f"); fi
    i=$((i + 1))
  done
  register_chunk tests_lib "${lib[@]}"
  register_chunk tests_llm "${llm[@]}"
  register_chunk tests_db "${db[@]}"
  register_chunk tests_domain "${domain[@]}"
  register_chunk tests_features_a "${fa[@]}"
  register_chunk tests_features_b "${fb[@]}"
  register_chunk tests_remainder "${remainder[@]}"
}

# Every test file in EXACTLY ONE chunk: the union must equal the walk, and no
# path may appear twice. A file no chunk picks up is a defect, not a saving.
check_arithmetic() {
  local total walked dup_files
  total=$(find tests \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | wc -l)
  cat "${CHUNK_FILES[@]}" 2>/dev/null | sed '/^$/d' | sort > "$PLAN_DIR/covered.txt"
  walked=$(wc -l < "$PLAN_DIR/covered.txt")
  dup_files=$(uniq -d < "$PLAN_DIR/covered.txt" | wc -l)
  echo "chunk arithmetic: $walked of $total test files covered"
  if [ "$walked" -ne "$total" ] || [ "$dup_files" -ne 0 ]; then
    echo "!! CHUNK ARITHMETIC MISMATCH — a file runs twice or not at all"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Diff -> chunks. The only two skips are docs-only and test-files-only.
# ---------------------------------------------------------------------------
CHANGED=()
ORDER=()
MODE=""

# The ONE changed-file list (diff base → HEAD → working tree → untracked). Every
# consumer of "what did this diff touch" goes through here: the chunk plan and
# the compile tier's build-config check. A second spelling of it would drift.
changed_files() {
  {
    if git rev-parse --verify --quiet "$DIFF_BASE^{commit}" >/dev/null 2>&1; then
      git diff --name-only "$DIFF_BASE...HEAD"
    else
      echo "!! GATE: diff base '$DIFF_BASE' not found — cannot order or scope chunks; running the FULL set" >&2
    fi
    git diff --name-only HEAD
    git ls-files --others --exclude-standard
  } | sed '/^$/d' | sort -u
}

select_order() {
  mapfile -t CHANGED < <(changed_files)
  local f c n=0 docs_only=1 tests_only=1
  for f in "${CHANGED[@]}"; do
    n=$((n + 1))
    if [[ ! "$f" =~ ^docs/ && ! "$f" =~ ^[^/]+\.md$ ]]; then docs_only=0; fi
    if [[ ! "$f" =~ ^tests/.+\.test\.tsx?$ ]]; then tests_only=0; fi
  done
  if [ "$n" -eq 0 ]; then
    docs_only=0
    tests_only=0
  fi

  if [ "$docs_only" -eq 1 ]; then
    MODE=docs-only
    ORDER=()
    return 0
  fi

  if [ "$tests_only" -eq 1 ]; then
    for c in "${CHUNKS[@]}"; do
      local hit=0
      for f in "${CHANGED[@]}"; do
        if grep -qxF -- "$f" "$JOBS_DIR/$c.files"; then
          hit=1
          break
        fi
      done
      [ "$hit" -eq 1 ] && ORDER+=("$c")
    done
    if [ "${#ORDER[@]}" -eq 0 ]; then
      echo "!! GATE: test-files-only diff but no chunk contains the changed file(s) — running the full set"
      MODE=full
      ORDER=("${CHUNKS[@]}")
    else
      MODE=tests-only
    fi
    return 0
  fi

  MODE=full
  local -A touched=()
  for f in "${CHANGED[@]}"; do
    case "$f" in
      tests/*.test.ts | tests/*.test.tsx)
        for c in "${CHUNKS[@]}"; do
          grep -qxF -- "$f" "$JOBS_DIR/$c.files" && touched[$c]=1
        done
        ;;
      src/lib/*) touched[tests_lib]=1 ;;
      src/llm/*) touched[tests_llm]=1 ;;
      src/db/*) touched[tests_db]=1 ;;
      src/domain/*) touched[tests_domain]=1 ;;
      src/features/*)
        touched[tests_features_a]=1
        touched[tests_features_b]=1
        ;;
      src/*) touched[tests_remainder]=1 ;;
    esac
  done
  for c in "${CHUNKS[@]}"; do [ -n "${touched[$c]:-}" ] && ORDER+=("$c"); done
  for c in "${CHUNKS[@]}"; do [ -n "${touched[$c]:-}" ] || ORDER+=("$c"); done
  return 0
}

print_plan() {
  echo "gate plan: mode=$MODE diff-base=$DIFF_BASE changed=${#CHANGED[@]} file(s)"
  local f c i=0
  for f in "${CHANGED[@]}"; do
    i=$((i + 1))
    [ "$i" -le 40 ] && echo "  changed: $f"
  done
  [ "$i" -gt 40 ] && echo "  changed: … and $((i - 40)) more"
  if [ "$MODE" = docs-only ]; then
    echo "  selected chunks: (none — DOCUMENTATION-ONLY diff: vitest is skipped, lint + typecheck still run)"
  else
    for c in "${ORDER[@]}"; do
      echo "  selected: $c ($(grep -c . "$JOBS_DIR/$c.files") files)"
    done
  fi
}

CALLER_MISSING=0
if [ "$COMPILE_ONLY" = "1" ]; then
  MODE=compile-only
elif [ "$#" -gt 0 ]; then
  MODE=caller
  for chunk in "$@"; do
    if [ -d "$chunk" ]; then
      mapfile -t files < <(find "$chunk" \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
    elif [ -f "$chunk" ]; then
      files=("$chunk")
    else
      echo "$chunk: (absent)"
      CALLER_MISSING=1
      continue
    fi
    name="$(printf '%s' "$chunk" | tr '/' '_')"
    register_chunk "$name" "${files[@]}"
    ORDER+=("$name")
  done
else
  plan_default_chunks
fi

if [ "${GATE_PLAN_ONLY:-0}" = "1" ]; then
  [ "$MODE" = caller ] || select_order
  print_plan
  echo "PLAN ONLY — no lint, no typecheck, no vitest ran."
  exit 0
fi

status_arith=0
if [ "$MODE" = caller ]; then
  # In plan-only mode no chunk was selected, so "absent" never ran and cannot be
  # a finding; the plan is a print, not a verdict.
  if [ "${GATE_PLAN_ONLY:-0}" != "1" ] && [ "$CALLER_MISSING" -eq 1 ]; then status_arith=1; fi
elif [ "$MODE" != "compile-only" ]; then
  select_order
  check_arithmetic || status_arith=1
fi
print_plan

# The compile tier runs NO suite: it must never wait on (or hold) the suite lock,
# or a 27s typecheck would be refused for the ~12 minutes a full verification
# takes — backwards, since the compile tier is what a writer needs most. It
# reads nothing the lock protects, so contention is not a concern for it.
if [ "$COMPILE_ONLY" != "1" ]; then
  if [ -n "$(foreign)" ]; then
    echo "WAITING: another suite is already running (ours or the peer project's):"
    foreign | head -3
    exit 9
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "LOCK HELD: $(cat "$LOCK/owner" 2>/dev/null || echo unknown)"
    echo "(stale? a lock whose owner file is >30 min old with no vitest alive may be removed)"
    exit 9
  fi
  printf '%s %s %s\n' "$self" "$(date +%s)" "$PWD" > "$LOCK/owner"
  trap 'rm -rf "$LOCK" "$PLAN_DIR"' EXIT
fi
# The log dir is created only once the lock is OURS: a refused attempt (a foreign
# suite, or the lock held by a sibling) used to leave an empty log dir behind,
# and retry loops accumulated them by the hundred.
mkdir -p "$LOGDIR"
echo "gate: cap ${RSS_CAP_MB}MB RSS / floor ${AVAIL_FLOOR_MB}MB available; up to ${PARALLEL_REQUESTED} chunk(s) at once (soft fallback ${SOFT_FALLBACK_MB}MB, void retries ${MAX_VOID_RETRIES}); logs in $LOGDIR"

# ---------------------------------------------------------------------------
# Execution. The watchdog sums EVERY live chunk's process group; a trip kills
# all of them and re-queues them (void, never counted) to run sequentially.
# ---------------------------------------------------------------------------
status=0
[ "$status_arith" -eq 1 ] && status=1
peak_seen=0
combined_peak=0
VOIDED_COUNT=0
SELECTED_COUNT=${#ORDER[@]}
RUN_LOGS=()
FALLBACK_NOTE=""
declare -A JOB_PID JOB_PGID JOB_START JOB_LOG_FILE JOB_PEAK JOB_VOID JOB_RC JOB_TIME JOB_VOID_COUNT
LIVE=()

finish_chunk() {
  local name="$1" log="${JOB_LOG_FILE[$name]}" rc="${JOB_RC[$name]}" void="${JOB_VOID[$name]}" counts
  [ "${JOB_PEAK[$name]}" -gt "$peak_seen" ] && peak_seen="${JOB_PEAK[$name]}"
  counts=$(grep -E '^ *(Test Files|Tests) ' "$log" 2>/dev/null | tr '\n' ' ' | tr -s ' ')
  printf '%s: ' "$name"
  if [ "$void" = yes ]; then
    echo "VOID (watchdog killed it after ${JOB_TIME[$name]}s, peak ${JOB_PEAK[$name]}MB — re-run, it is not evidence)"
  elif [ "$rc" -ne 0 ]; then
    echo "${counts}FAILED (rc=$rc, peak ${JOB_PEAK[$name]}MB, ${JOB_TIME[$name]}s) — see $log"
    status=1
    RUN_LOGS+=("$log")
  else
    echo "${counts}ok (peak ${JOB_PEAK[$name]}MB, ${JOB_TIME[$name]}s)"
    RUN_LOGS+=("$log")
  fi
}

start_chunk() {
  local name="$1"
  local -a args=()
  mapfile -t args < "$JOBS_DIR/$(chunk_slug "$name").files"
  if [ "${#args[@]}" -eq 0 ]; then
    echo "!! GATE: chunk $name has no files — refusing to run an empty chunk"
    status=1
    return 1
  fi
  local log="$LOGDIR/$(chunk_slug "$name").log"
  setsid env NODE_OPTIONS="--max-old-space-size=1536" CAMPAIGNER_TEST_WORKERS=1 \
    pnpm exec vitest run "${args[@]}" > "$log" 2>&1 &
  local pid=$!
  local pgid="" tries=0
  while [ "$tries" -lt 25 ]; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ "$pgid" = "$pid" ] && break
    sleep 0.2
    tries=$((tries + 1))
  done
  if [ "$pgid" != "$pid" ]; then
    # setsid forks when the child is already a process-group leader; the tracked
    # pid would then be the short-lived parent and the chunk would run untracked.
    echo "!! GATE: chunk $name never got its own process group (pid=$pid pgid='${pgid}') — aborting rather than running untracked"
    kill -TERM "$pid" 2>/dev/null
    return 2
  fi
  JOB_PID[$name]=$pid
  JOB_PGID[$name]=$pid
  JOB_LOG_FILE[$name]=$log
  JOB_START[$name]=$(date +%s)
  JOB_PEAK[$name]=0
  JOB_VOID[$name]=no
  JOB_RC[$name]=pending
  : "${JOB_VOID_COUNT[$name]:=0}"
  return 0
}

# Sets SAMPLE_COMBINED_MB. MUST be called directly, never inside `$( )`: the
# per-chunk peak updates below are the point, and a command substitution runs in
# a subshell where they would be discarded (measured: combined peak 1303MB while
# every per-chunk peak stayed 0).
SAMPLE_COMBINED_MB=0
sample_combined_now() {
  local total=0 name pgid mb
  for name in "${LIVE[@]}"; do
    pgid="${JOB_PGID[$name]}"
    mb=$(ps -o rss= -g "$pgid" 2>/dev/null | awk '{s+=$1} END{print int(s/1024)}')
    [ -n "$mb" ] || mb=0
    [ "$mb" -gt "${JOB_PEAK[$name]}" ] && JOB_PEAK[$name]=$mb
    total=$((total + mb))
  done
  SAMPLE_COMBINED_MB=$total
}

kill_live() {
  local name pgid
  for name in "${LIVE[@]}"; do
    JOB_VOID[$name]=yes
    pgid="${JOB_PGID[$name]}"
    if [ -n "$pgid" ]; then kill -TERM "-$pgid" 2>/dev/null; fi
    kill -TERM "${JOB_PID[$name]}" 2>/dev/null
  done
  sleep 2
  for name in "${LIVE[@]}"; do
    pgid="${JOB_PGID[$name]}"
    if [ -n "$pgid" ]; then kill -KILL "-$pgid" 2>/dev/null; fi
    kill -KILL "${JOB_PID[$name]}" 2>/dev/null
  done
  for name in "${LIVE[@]}"; do
    wait "${JOB_PID[$name]}" 2>/dev/null
    JOB_TIME[$name]=$(( $(date +%s) - ${JOB_START[$name]} ))
    finish_chunk "$name"
    JOB_VOID_COUNT[$name]=$(( ${JOB_VOID_COUNT[$name]:-0} + 1 ))
    VOIDED_COUNT=$((VOIDED_COUNT + 1))
  done
  LIVE=()
}

requeue_after_void() {
  # $1 = "soft" | "hard" (only used for the note); reads VOIDED_NOW and next.
  local name i
  local -a retryable=()
  for name in "${VOIDED_NOW[@]}"; do
    if [ "${JOB_VOID_COUNT[$name]}" -le "$MAX_VOID_RETRIES" ]; then
      retryable+=("$name")
    else
      echo "!! GATE: chunk $name was VOID ${JOB_VOID_COUNT[$name]} time(s) — NOT retried; the gate cannot go green under the ${RSS_CAP_MB}MB cap"
      status=1
    fi
  done
  NEW_ORDER=()
  for name in "${retryable[@]}"; do NEW_ORDER+=("$name"); done
  for ((i = NEXT_IDX; i < ${#ORDER[@]}; i++)); do NEW_ORDER+=("${ORDER[$i]}"); done
  ORDER=("${NEW_ORDER[@]}")
}

run_plan() {
  local PARALLEL="$PARALLEL_REQUESTED"
  local next=0 name pid combined avail st
  local -a still voided_now
  VITEST_WALL=0
  local VITEST_START
  VITEST_START=$(date +%s)

  while [ "$next" -lt "${#ORDER[@]}" ] || [ "${#LIVE[@]}" -gt 0 ]; do
    while [ "${#LIVE[@]}" -lt "$PARALLEL" ] && [ "$next" -lt "${#ORDER[@]}" ]; do
      name="${ORDER[$next]}"
      start_chunk "$name"
      st=$?
      if [ "$st" -eq 0 ]; then
        LIVE+=("$name")
      elif [ "$st" -eq 2 ]; then
        kill_live
        echo "!! GATE aborted: an untracked chunk is not acceptable"
        return 2
      fi
      next=$((next + 1))
    done

    if [ "${#LIVE[@]}" -gt 0 ]; then
      still=()
      for name in "${LIVE[@]}"; do
        pid="${JOB_PID[$name]}"
        if kill -0 "$pid" 2>/dev/null; then
          still+=("$name")
        else
          wait "$pid" 2>/dev/null
          JOB_RC[$name]=$?
          JOB_TIME[$name]=$(( $(date +%s) - ${JOB_START[$name]} ))
          finish_chunk "$name"
        fi
      done
      LIVE=()
      [ "${#still[@]}" -gt 0 ] && LIVE=("${still[@]}")
    fi

    if [ "${#LIVE[@]}" -gt 0 ]; then
      sample_combined_now
      combined=$SAMPLE_COMBINED_MB
      [ "$combined" -gt "$combined_peak" ] && combined_peak=$combined
      avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
      if [ "$combined" -gt "$RSS_CAP_MB" ] || [ "$avail" -lt "$AVAIL_FLOOR_MB" ]; then
        echo "  !! WATCHDOG(hard): combined ${combined}MB (cap ${RSS_CAP_MB}MB) / available ${avail}MB (floor ${AVAIL_FLOOR_MB}MB) -> killing ${#LIVE[@]} live chunk(s)"
        voided_now=("${LIVE[@]}")
        kill_live
        VOIDED_NOW=("${voided_now[@]}")
        NEXT_IDX=$next
        requeue_after_void
        next=0
        PARALLEL=1
        continue
      fi
      if [ "$PARALLEL" -gt 1 ] && [ "$combined" -ge "$SOFT_FALLBACK_MB" ]; then
        echo "  !! WATCHDOG(soft): combined ${combined}MB approaches the ${RSS_CAP_MB}MB cap (soft limit ${SOFT_FALLBACK_MB}MB) -> falling back to SEQUENTIAL before the kill line"
        voided_now=("${LIVE[@]}")
        kill_live
        VOIDED_NOW=("${voided_now[@]}")
        NEXT_IDX=$next
        requeue_after_void
        next=0
        FALLBACK_NOTE="fell back to SEQUENTIAL after a ${combined}MB combined peak (soft limit ${SOFT_FALLBACK_MB}MB)"
        PARALLEL=1
        continue
      fi
    fi
    sleep 1
  done
  VITEST_WALL=$(( $(date +%s) - VITEST_START ))
  return 0
}

CHECKS_RUN=""
echo "=== typecheck ==="
TYPECHECK_START=$(date +%s)
pnpm typecheck > "$LOGDIR/typecheck.log" 2>&1 || {
  echo "TYPECHECK FAILED (see $LOGDIR/typecheck.log)"
  status=1
}
TOOLING_WALL=$(( $(date +%s) - TYPECHECK_START ))
CHECKS_RUN="typecheck"
# A BUILD-CONFIG DIFF MUST ALSO BUILD. `tsc -b` proves the types compile; it does
# NOT prove `vite build` succeeds, and the owner's requirement is that a pushed
# build stays testable ("no compile errors before push, thats really needed
# because i need to be able to still test the app"). A change to the build's own
# inputs is exactly where the two diverge, so the compile tier builds for those
# and only those. GATE_BUILD=0 skips it and says so.
BUILD_AFFECTING_RE='^(vite\.config\.|tsconfig[^/]*\.json$|package\.json$|pnpm-lock\.yaml$|index\.html$|public/)'
if [ "$COMPILE_ONLY" = "1" ]; then
  build_files="$(changed_files)"
  if printf '%s\n' "$build_files" | grep -qE "$BUILD_AFFECTING_RE"; then
    if [ "${GATE_BUILD:-1}" = "0" ]; then
      echo "=== build: SKIPPED — a build-config diff is present but GATE_BUILD=0 (deliberate; the pushed build is NOT proven) ==="
    else
      echo "=== build: build-config diff present — running 'pnpm build' (the deploy runs it too) ==="
      BUILD_START=$(date +%s)
      pnpm build > "$LOGDIR/build.log" 2>&1 || {
        echo "BUILD FAILED (see $LOGDIR/build.log)"
        status=1
      }
      TOOLING_WALL=$((TOOLING_WALL + $(date +%s) - BUILD_START))
      CHECKS_RUN="$CHECKS_RUN + build"
    fi
  fi
fi
if [ "$COMPILE_ONLY" != "1" ] || [ "$GATE_CHECKS" = "lint" ] || [ "$GATE_CHECKS" = "all" ]; then
  echo "=== lint ==="
  LINT_START=$(date +%s)
  pnpm lint > "$LOGDIR/lint.log" 2>&1 || {
    echo "LINT FAILED (see $LOGDIR/lint.log)"
    status=1
  }
  grep -cE "  error  " "$LOGDIR/lint.log" | sed 's/^/  lint errors: /'
  TOOLING_WALL=$((TOOLING_WALL + $(date +%s) - LINT_START))
  CHECKS_RUN="$CHECKS_RUN + lint"
else
  echo "=== lint: SKIPPED — compile tier runs typecheck by default (GATE_CHECKS=$GATE_CHECKS); add GATE_CHECKS=all for eslint, or use the full gate ==="
fi

VITEST_WALL=0
if [ "$COMPILE_ONLY" = "1" ]; then
  echo "=== vitest: SKIPPED — COMPILE TIER (GATE_TESTS=0): the suite did NOT run ==="
  echo "  this run answers only 'does it still build' (typecheck/lint). The FULL gate is a"
  echo "  SEPARATE, REAL run and is REQUIRED before this change is treated as verified."
  echo "  Exit 2 means exactly that — compiles/clean, NOT verified (never 'GATE GREEN')."
elif [ "$MODE" = docs-only ]; then
  echo "=== vitest: SKIPPED — DOCUMENTATION-ONLY diff (lint + typecheck still ran) ==="
elif [ "${#ORDER[@]}" -eq 0 ]; then
  echo "=== vitest: nothing selected — no chunk ran ==="
  status=1
else
  if [ "$PARALLEL_REQUESTED" -gt 1 ]; then
    echo "=== vitest: ${#ORDER[@]} chunk(s), up to 2 concurrent ==="
  else
    echo "=== vitest: ${#ORDER[@]} chunk(s), SEQUENTIAL ==="
  fi
  run_plan || status=1
fi

sum_counts() {
  local v total=0 log
  for log in "${RUN_LOGS[@]}"; do
    [ -f "$log" ] || continue
    v=$(grep -E "^ *$1 " "$log" | tail -1 | sed -nE 's/.*\(([0-9]+)\).*/\1/p')
    [ -n "$v" ] && total=$((total + v))
  done
  echo "$total"
}

echo "=== summary ==="
echo "mode: $MODE; requested parallelism: ${PARALLEL_REQUESTED} chunk(s)${FALLBACK_NOTE:+; $FALLBACK_NOTE}"
echo "checks: ${CHECKS_RUN}${COMPILE_ONLY:+ }"
echo "chunks completed (non-void): ${#RUN_LOGS[@]} of ${SELECTED_COUNT} selected; voided (re-run): ${VOIDED_COUNT}"
echo "summed: $(sum_counts 'Test Files') test files / $(sum_counts 'Tests') tests"
echo "wall: total $(( $(date +%s) - TOTAL_START ))s (tooling ${TOOLING_WALL}s, vitest ${VITEST_WALL}s)"
echo "peak RSS of any single chunk: ${peak_seen}MB (cap ${RSS_CAP_MB}MB)"
echo "combined peak RSS of concurrent chunks: ${combined_peak}MB (cap ${RSS_CAP_MB}MB)"
echo "per-chunk logs: $LOGDIR"
if [ "$COMPILE_ONLY" = "1" ]; then
  if [ "$status" -eq 0 ]; then
    echo "===== COMPILE TIER — ${CHECKS_RUN} clean; the suite did NOT run (exit 2) ====="
    status=2
  else
    echo "===== COMPILE TIER — DOES NOT COMPILE; nothing may be pushed ====="
  fi
else
  [ "$status" -eq 0 ] && echo "GATE GREEN" || echo "GATE RED"
fi
exit "$status"
