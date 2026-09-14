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
#   * CHUNKED runs: 304 test files in one process is what fills RAM, and the
#     cumulative growth is OFF-heap (pdfjs ArrayBuffers), so a heap cap cannot
#     stop it. Each chunk gets a fresh process.
#   * A WATCHDOG samples this run's own process group every second and kills it
#     at the RSS cap or when the box's available memory gets low. Failing our
#     gate is acceptable; letting the kernel pick dsh as the victim is not.
#
# Usage:
#   scripts/gate.sh                 # lint + typecheck + every chunk, summed
#   scripts/gate.sh tests/lib       # only that chunk (still locked, still capped)
#
# Env: GATE_RSS_CAP_MB (default 3000), GATE_AVAIL_FLOOR_MB (default 2500),
#      GATE_LOGDIR (default /tmp/gate-<pid>)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2
RSS_CAP_MB="${GATE_RSS_CAP_MB:-3000}"
AVAIL_FLOOR_MB="${GATE_AVAIL_FLOOR_MB:-2500}"
LOGDIR="${GATE_LOGDIR:-/tmp/gate-$$}"
LOCK="${GATE_LOCK:-/tmp/campaigner-suite.lock}"
mkdir -p "$LOGDIR"
echo "gate: cap ${RSS_CAP_MB}MB RSS / floor ${AVAIL_FLOOR_MB}MB available; logs in $LOGDIR"

self=$$
foreign() { pgrep -af 'vites[t]|playwrigh[t]' 2>/dev/null | grep -v 'bash -c' | grep -v " $self " | grep -v "^$self "; }

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
trap 'rm -rf "$LOCK"' EXIT

avail_mb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
# RSS of the run's own process group: pnpm -> node -> workers all stay in it.
group_rss_mb() { ps -o rss= -g "$1" 2>/dev/null | awk '{s+=$1} END{print int(s/1024)}'; }

peak_seen=0
run_chunk() {
  local name="$1"; shift
  local log="$LOGDIR/$name.log"
  ( export NODE_OPTIONS="--max-old-space-size=1536" CAMPAIGNER_TEST_WORKERS=1
    pnpm exec vitest run "$@" ) > "$log" 2>&1 &
  local pid=$! peak=0 voided=no pgid
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  while kill -0 "$pid" 2>/dev/null; do
    local mb avail
    mb="$(group_rss_mb "${pgid:-$pid}")"; avail="$(avail_mb)"
    [ "$mb" -gt "$peak" ] && peak=$mb
    if [ "$mb" -gt "$RSS_CAP_MB" ] || [ "$avail" -lt "$AVAIL_FLOOR_MB" ]; then
      echo "  !! WATCHDOG: run ${mb}MB (cap ${RSS_CAP_MB}) / available ${avail}MB -> killing PID $pid"
      pkill -TERM -g "${pgid:-$pid}" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 2
      pkill -KILL -g "${pgid:-$pid}" 2>/dev/null; kill -KILL "$pid" 2>/dev/null
      voided=yes; break
    fi
    sleep 1
  done
  wait "$pid"; local rc=$?
  [ "$peak" -gt "$peak_seen" ] && peak_seen=$peak
  printf '%s: ' "$name"
  grep -E "^ *(Test Files|Tests) " "$log" | tr '\n' ' ' | tr -s ' '
  if [ "$voided" = yes ]; then echo "VOID (watchdog killed it — re-run, it is not evidence)"
  elif [ "$rc" -ne 0 ]; then echo "FAILED (rc=$rc, peak ${peak}MB) — see $log"
  else echo "ok (peak ${peak}MB)"; fi
  [ "$voided" = yes ] && return 9
  return "$rc"
}

status=0
echo "=== lint ==="; pnpm lint > "$LOGDIR/lint.log" 2>&1 || { echo "LINT FAILED (see $LOGDIR/lint.log)"; status=1; }
grep -cE "  error  " "$LOGDIR/lint.log" | sed 's/^/  lint errors: /'
echo "=== typecheck ==="; pnpm typecheck > "$LOGDIR/typecheck.log" 2>&1 || { echo "TYPECHECK FAILED (see $LOGDIR/typecheck.log)"; status=1; }

if [ "$#" -gt 0 ]; then CHUNKS=("$@")
else CHUNKS=(tests/lib tests/llm tests/db tests/domain tests/features tests); fi
# Every chunk above MUST contain test files. `src` was in this list once and
# contains none (the whole suite lives under `tests/`), so vitest exited 1 with
# "No test files found" and EVERY writer's gate read RED for a reason unrelated
# to their work — reported by a writer instead of worked around, which is why it
# was found. An explicitly requested path with no tests is still a real failure.
echo "=== vitest in ${#CHUNKS[@]} chunk(s) ==="
for chunk in "${CHUNKS[@]}"; do
  [ -e "$chunk" ] || { echo "$chunk: (absent, skipped)"; continue; }
  run_chunk "$(echo "$chunk" | tr '/' '_')" "$chunk" || status=1
done

echo "=== summary ==="
echo "peak RSS of any single chunk: ${peak_seen}MB (cap ${RSS_CAP_MB}MB)"
echo "per-chunk logs: $LOGDIR"
[ "$status" -eq 0 ] && echo "GATE GREEN" || echo "GATE RED"
exit "$status"
