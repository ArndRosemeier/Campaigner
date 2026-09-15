#!/usr/bin/env bash
# scripts/board.sh — reconcile docs/20-ORCHESTRATION.md (the board) against reality.
#
# Read-only, takes no lock, safe at any time. The chief of staff runs this FIRST
# in a session (AGENTS.md §Chief of staff): the board is prose about state, and
# prose about state rots, so every claim it makes is CHECKED here instead of
# being believed. A stale board is a finding to report and fix, not a crash —
# the exit status stays 0 and the last line says which it is.
#
# Usage: bash scripts/board.sh
# Env:   BOARD=<path> (default docs/20-ORCHESTRATION.md), GATE_LOCK=<path>
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "board.sh: not inside a git work tree"; exit 2; }
BOARD="${BOARD:-docs/20-ORCHESTRATION.md}"
[ -f "$BOARD" ] || { echo "board.sh: BOARD MISSING — $BOARD"; exit 2; }

SESSROOT="${DSH_HOME:-$HOME/.dsh}/sessions/--home-box-Harness-Campaigner--"
LOCK="${GATE_LOCK:-/tmp/campaigner-suite.lock}"
stale=0
note() { printf '  !! %s\n' "$1"; stale=1; }
field() { printf '%s\n' "$1" | grep -o "$2=[^ |]*" | head -1 | cut -d= -f2-; }
age_min() { find "$1" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1; }

echo "=== git ==="
head_sha="$(git rev-parse --short HEAD)"
origin_sha="$(git rev-parse --short origin/main 2>/dev/null || echo none)"
reconciled="$(grep -m1 '^reconciled: ' "$BOARD" | sed 's/^reconciled: *//; s/ .*//')"
echo "HEAD=$head_sha  origin/main=$origin_sha  board reconciled=${reconciled:-<none>}"
behind="$(git log --oneline HEAD..origin/main 2>/dev/null | wc -l)"
ahead="$(git log --oneline origin/main..HEAD 2>/dev/null | wc -l)"
if [ "$behind" -gt 0 ]; then
  note "local main is $behind commit(s) BEHIND origin/main — a stale local tree, not a state of the world: pull before gating or before believing any board record (this is exactly how row 167 read as 'unlanded' while it was pushed and deployed)"
fi
[ "$ahead" -gt 0 ] && echo "  note: $ahead local commit(s) not pushed"
if [ -n "$reconciled" ] && ! git merge-base --is-ancestor "$reconciled" HEAD 2>/dev/null; then
  note "the board's reconciled SHA ($reconciled) is not an ancestor of HEAD — it predates the tree it describes"
fi

echo
echo "=== records ==="
while IFS= read -r line; do
  kind="$(printf '%s' "${line%%|*}" | tr -d ' ')"
  case "$kind" in
    SESSION)
      cos="$(field "$line" cos)"
      if [ -n "${DSH_SESSION_ID:-}" ] && [ "$cos" != "$DSH_SESSION_ID" ]; then
        note "the board names CoS session $cos, but THIS session is $DSH_SESSION_ID — update the SESSION record"
      else
        echo "  CoS session: $cos (this session)"
      fi
      # Context budget as a MEASURED number: the predecessor's session log grew
      # to 35MB and could no longer be compacted. Handover is cheap on purpose.
      cur=""
      for c in "$SESSROOT/$DSH_SESSION_ID" "$SESSROOT/session-$DSH_SESSION_ID"; do [ -d "$c" ] && cur="$c"; done
      if [ -n "$cur" ]; then
        sz="$(du -sm "$cur" 2>/dev/null | cut -f1)"
        echo "  this session's log: ${sz:-?}MB (handover suggested past ~8MB — a session that cannot be compacted cannot be recovered)"
      fi
      ;;
    IN-FLIGHT|UNLANDED)
      branch="$(field "$line" branch)"; wt="$(field "$line" worktree)"; writer="$(field "$line" writer)"
      if [ -z "$branch$wt$writer" ]; then
        printf '  %s: %s\n' "$kind" "$(field "$line" note)"
        continue
      fi
      printf '%s row=%s state=%s\n' "$kind" "$(field "$line" row)" "$(field "$line" state)"
      if [ -n "$branch" ]; then
        if git show-ref --verify --quiet "refs/heads/$branch"; then
          ahead="$(git log --oneline main.."$branch" 2>/dev/null | wc -l)"
          echo "  branch $branch: exists, $ahead commit(s) not in main"
          [ "$ahead" -eq 0 ] && note "branch $branch has nothing main lacks — its safe-delete test passes"
        elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
          echo "  branch $branch: not local, exists on origin"
        else
          note "branch $branch named on the board does not exist"
        fi
      fi
      if [ -n "$wt" ]; then
        if [ -d "$wt" ]; then
          dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l)"
          echo "  worktree $wt: present, $dirty uncommitted path(s)"
          [ "$dirty" -gt 0 ] && note "worktree $wt has UNCOMMITTED work — a death there loses it"
        else
          note "worktree $wt named on the board is gone"
        fi
      fi
      case "$writer" in
        ''|none*|dead*) echo "  writer: ${writer:-<unset>}";;
        *)
          d=""
          for c in "$SESSROOT/$writer" "$SESSROOT/session-$writer"; do [ -d "$c" ] && d="$c"; done
          if [ -n "$d" ]; then
            last="$(age_min "$d")"
            if [ -n "$last" ]; then
              echo "  writer log: $(basename "$d") (last write $(( ( $(date +%s) - last ) / 60 ))m ago — age is evidence, the live registry is proof)"
            else
              echo "  writer log: $(basename "$d") (no files)"
            fi
          else
            echo "  writer: $writer (no session dir under $SESSROOT)"
          fi
          ;;
      esac
      ;;
    AWAITING-OWNER)
      printf '  %s\n' "$(echo "$line" | sed 's/^AWAITING-OWNER *| *//')"
      ;;
    TRAP)
      printf '  TRAP %s\n' "$(echo "$line" | sed 's/^TRAP *| *//')"
      ;;
    LANDED)
      sha="$(field "$line" sha)"
      if [ -n "$sha" ] && git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
        echo "  row=$(field "$line" row) sha=$sha: on origin/main"
      else
        note "the board claims row=$(field "$line" row) landed as $sha, which is NOT on origin/main"
      fi
      ;;
    RECOVERY)
      p="$(field "$line" context)"
      if [ -n "$p" ]; then
        [ -e "$p" ] && echo "  recovery artifact present: $p" || note "recovery artifact missing: $p"
      fi
      ;;
  esac
done < <(grep -E '^(SESSION|IN-FLIGHT|UNLANDED|AWAITING-OWNER|LANDED|RECOVERY|TRAP) *\|' "$BOARD")

echo
echo "=== host ==="
uptime | sed 's/^ */  /'
awk '/MemAvailable/{printf "  MemAvailable: %d MB\n", $2/1024}' /proc/meminfo
p="vites""t"
found="$(pgrep -af "$p" 2>/dev/null | grep -v 'bash -c' | grep -v "^$$ " || true)"
if [ -n "$found" ]; then
  echo "  suites running:"; printf '%s\n' "$found" | cut -c1-180 | sed 's/^ */    /'
else
  echo "  suites running: none"
fi
if [ -d "$LOCK" ]; then
  owner="$(cat "$LOCK/owner" 2>/dev/null || echo unknown)"
  lock_age=0
  [ -e "$LOCK/owner" ] && lock_age=$(( ( $(date +%s) - $(stat -c %Y "$LOCK/owner") ) / 60 ))
  echo "  suite lock: HELD (${owner}) for ${lock_age}m"
  [ "$lock_age" -gt 30 ] && echo "    note: owner file is ${lock_age}m old — if no suite is alive this is a STALE lock (rm -rf it)"
else
  echo "  suite lock: free"
fi
echo "  /tmp/gate-* dirs: $(find /tmp -maxdepth 1 -name 'gate-*' -type d 2>/dev/null | wc -l) (scratch left by retired gate runs)"

echo
if [ "$stale" -eq 0 ]; then echo "BOARD RECONCILED"; else echo "BOARD STALE — fix $BOARD before dispatching"; fi
exit 0
