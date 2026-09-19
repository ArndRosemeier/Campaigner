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
# Env:   BOARD=<path> (default docs/20-ORCHESTRATION.md), GATE_LOCK=<path>,
#        OPENCODE_API_URL=<url> (default the OpenCode Manager server)
set -uo pipefail

# This session's id is set by the harness, but a plain child shell or another
# box may not export it — and a bare `$DSH_SESSION_ID` under `set -u` killed the
# reconciler on the first SESSION record, before its verdict (the "a check that
# cannot look is not a check" failure this script exists to prevent). Default it
# empty ONCE here so every read is safe; the "am I named?" check still skips when
# it is genuinely absent.
DSH_SESSION_ID="${DSH_SESSION_ID:-}"

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "board.sh: not inside a git work tree"; exit 2; }
BOARD="${BOARD:-docs/20-ORCHESTRATION.md}"
[ -f "$BOARD" ] || { echo "board.sh: BOARD MISSING — $BOARD"; exit 2; }

# The suite lock the gate takes. It must resolve to the SAME path from every
# shell and every worktree: /tmp is a per-call, read-only tmpfs in this harness,
# and `$PWD/...` would differ per worktree. The git common dir is the one path
# identical in both — same derivation as gate.sh.
_common="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
case "$_common" in /*) ;; *) _common="$PWD/$_common" ;; esac
LOCK="${GATE_LOCK:-$(dirname "$_common")/.campaigner-lock}"
stale=0
note() { printf '  !! %s\n' "$1"; stale=1; }
field() { printf '%s\n' "$1" | grep -o "$2=[^ |]*" | head -1 | cut -d= -f2-; }
# A note is free text: `field` stops at the first space, which printed
# "IN-FLIGHT: row" for a compact record. Everything after `note=` is the note.
noteof() { printf '%s\n' "$1" | sed 's/.*note=//'; }
age_min() { find "$1" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1; }

# ── Live sessions: the OpenCode API (this harness) ──────────────────────────
# On this harness a "session" is an OpenCode session, NOT a DSH session dir: the
# server exposes GET /session with each session's id, slug, parentID, directory,
# agent and time.updated. That is the authority for "is a writer live" and for
# "is something live the board does not name". OPENCODE_API_URL overrides; the
# default is the reserved OpenCode Manager server port. If curl/jq are missing or
# the API is unreachable we SAY SO LOUDLY below — a check that cannot look is not
# a check (rows 231/232).
OPENCODE_API_URL="${OPENCODE_API_URL:-http://127.0.0.1:5551}"
oc_api_ok=0
oc_sessions="[]"
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  # Sessions are DIRECTORY-SCOPED: `GET /session` with NO directory returns the
  # server's own default project, NOT this repo's — MEASURED on 2026-09-19: a
  # just-spawned Campaigner child was ABSENT from the no-directory list but
  # present under `?directory=$PWD`. So query the main tree AND every in-repo
  # worktree (a `task`-launched writer can run under a worktree directory) and
  # merge. Reachability is decided by the MAIN query (an all-failed merge would
  # otherwise look like a reachable-but-empty API).
  if main_json="$(curl -fsS --max-time 5 --get --data-urlencode "directory=$PWD" "$OPENCODE_API_URL/session" 2>/dev/null)"; then
    oc_api_ok=1
    oc_sessions="$main_json"
    while IFS= read -r wt; do
      [ -z "$wt" ] && continue
      [ "$wt" = "$PWD" ] && continue
      if wt_json="$(curl -fsS --max-time 5 --get --data-urlencode "directory=$wt" "$OPENCODE_API_URL/session" 2>/dev/null)"; then
        oc_sessions="$(jq -s 'add // []' <<<"$oc_sessions
$wt_json" 2>/dev/null || printf '%s' "$oc_sessions")"
      fi
    done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  fi
fi
# A session named on the board may be spelled by id (`ses_…`) or slug; match
# either. Prints id<TAB>slug<TAB>agent<TAB>updated-epoch-seconds.
oc_find_session() {
  printf '%s' "$oc_sessions" | jq -r --arg w "$1" \
    '.[] | select(.id==$w or .slug==$w) | [.id,.slug,(.agent//"?"),(((.time.updated//0)/1000|floor)|tostring)] | @tsv' 2>/dev/null | head -1
}
# Child sessions (a `task` subagent carries a parentID) whose directory is under
# this repo and which were updated since an epoch-seconds cutoff. The CoS's own
# ROOT session has no parentID, so it never flags itself.
oc_recent_children() {
  printf '%s' "$oc_sessions" | jq -r --arg d "$1" --argjson t "$2" \
    '.[] | select((.parentID//"")!="" and ((.directory//"")|startswith($d)) and ((.time.updated//0) > ($t*1000))) | [.id,.slug,(.agent//"?"),(.title//"")] | @tsv' 2>/dev/null
}

# The session root is DERIVED from this repo's own path, never hardcoded to a
# box layout: the directory's name is this workspace's absolute path with each
# `/` turned into a `-`, so a box whose workspace lives elsewhere (or a moved
# workspace) silently pointed every session read at a directory that does not
# exist — the writer-liveness line, the session-log size budget and the
# unrecorded-live-state scan all went quiet while the board still printed
# RECONCILED. MEASURED: DSH writes a LEADING dash too (`/home/x/y` →
# `--home-x-y--`), which is why the head is matched loosely and the full suffixed
# path strictly; a fresh /tmp worktree legitimately has NO session dir, so a
# missing root is REPORTED (it disables the live-state scan) rather than treated
# as a defect, and the legacy box path stays a fallback.
sess_base="${DSH_HOME:-$HOME/.dsh}/sessions"
top="${PWD##*/}"; top="${top//[^A-Za-z0-9._-]/-}"
SESSROOT=""
for c in "$sess_base"/*-"$top"-- "$sess_base"/*-"$top" "$(dirname "$PWD")"/*/sessions/*-"$top"; do
  if [ -d "$c" ]; then SESSROOT="$c"; break; fi
done
if [ -z "$SESSROOT" ] && [ -d "$sess_base/--home-box-Harness-Campaigner--" ]; then
  SESSROOT="$sess_base/--home-box-Harness-Campaigner--"
fi
echo "=== sessions ==="
if [ "$oc_api_ok" -eq 1 ]; then
  echo "  source: OpenCode API $OPENCODE_API_URL ($(printf '%s' "$oc_sessions" | jq 'length' 2>/dev/null) session(s) server-wide)"
elif ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "  source: NONE — curl and/or jq is missing, so the OpenCode session API cannot be queried; the writer-liveness and unrecorded-live-state checks CANNOT LOOK, so their silence is not evidence"
elif [ -n "$SESSROOT" ]; then
  echo "  source: DSH session dir $SESSROOT (fallback — the OpenCode API at $OPENCODE_API_URL was unreachable)"
else
  echo "  source: NONE — the OpenCode API at $OPENCODE_API_URL is unreachable/unparseable and no DSH session dir exists; the writer-liveness and unrecorded-live-state checks CANNOT LOOK, so their silence is not evidence"
fi

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
      cosmodel="$(field "$line" model)"
      [ -n "$cosmodel" ] && suffix=" [model: $cosmodel]" || suffix=""
      # The board may name MORE THAN ONE live actor (two CoS sessions have run
      # this project at once). Each is printed; the "am I named?" verdict is made
      # once after the loop, so a second actor is information, not staleness.
      case "$cos" in
        "$DSH_SESSION_ID"|"session-$DSH_SESSION_ID")
          echo "  CoS session: $cos (this session)${suffix}"
          # Context budget as a MEASURED number: the predecessor's session log
          # grew to 35MB and could no longer be compacted. Handover is cheap on
          # purpose, so the size is reported where the actor is named.
          cur=""
          for c in "$SESSROOT/$DSH_SESSION_ID" "$SESSROOT/session-$DSH_SESSION_ID"; do [ -d "$c" ] && cur="$c"; done
          if [ -n "$cur" ]; then
            sz="$(du -sm "$cur" 2>/dev/null | cut -f1)"
            echo "  this session's log: ${sz:-?}MB (handover suggested past ~8MB — a session that cannot be compacted cannot be recovered)"
          fi
          ;;
        *) echo "  CoS session: $cos${suffix}";;
      esac
      ;;
    IN-FLIGHT|UNLANDED)
      branch="$(field "$line" branch)"; wt="$(field "$line" worktree)"; writer="$(field "$line" writer)"
      if [ -z "$branch$wt$writer" ]; then
        printf '  %s: %s\n' "$kind" "$(noteof "$line")"
        continue
      fi
      printf '%s row=%s state=%s\n' "$kind" "$(field "$line" row)" "$(field "$line" state)"
      inmodel="$(field "$line" model)"
      [ -n "$inmodel" ] && echo "  model: $inmodel"
      if [ -n "$branch" ]; then
        if git show-ref --verify --quiet "refs/heads/$branch"; then
          ahead="$(git log --oneline main.."$branch" 2>/dev/null | wc -l)"
          echo "  branch $branch: exists, $ahead commit(s) not in main"
          case "$writer" in
            ''|none*|dead*) [ "$ahead" -eq 0 ] && note "branch $branch has nothing main lacks — its safe-delete test passes";;
            *) [ "$ahead" -eq 0 ] && echo "    (no commits yet — a LIVE writer's branch, not a retirement candidate)";;
          esac
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
          # Uncommitted work is EXPECTED between a live writer's milestones and a
          # LOSS RISK only once nobody owns it — the same distinction the branch
          # check makes. A board that reds on every healthy in-flight slice is a
          # board nobody reads.
          case "$writer" in
            ''|none*|dead*) [ "$dirty" -gt 0 ] && note "worktree $wt has UNCOMMITTED work and NO live writer — a death there loses it";;
            *) [ "$dirty" -gt 0 ] && echo "    (in progress — the writer commits at every green milestone)";;
          esac
        else
          note "worktree $wt named on the board is gone"
        fi
      fi
      case "$writer" in
        ''|none*|dead*) echo "  writer: ${writer:-<unset>}";;
        *)
          if [ "$oc_api_ok" -eq 1 ]; then
            ws="$(oc_find_session "$writer")"
            if [ -n "$ws" ]; then
              w_id="$(printf '%s' "$ws" | cut -f1)"; w_agent="$(printf '%s' "$ws" | cut -f3)"; w_upd="$(printf '%s' "$ws" | cut -f4)"
              echo "  writer session (OpenCode): $w_id agent=$w_agent (updated $(( ( $(date +%s) - w_upd ) / 60 ))m ago — the live API is proof)"
            else
              note "writer $writer is named on the board but is NOT a session the OpenCode API knows — a stopped/typo'd id, or the wrong harness"
            fi
          else
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
    PROBE)
      # A read-only scoping/verification agent: no worktree, no branch, but still
      # live state a successor should know about — and its session id must count
      # as "named on the board" or the unrecorded-live-state check reports it.
      echo "  PROBE ${line#*| }"
      ;;
  esac
done < <(grep -E '^(SESSION|IN-FLIGHT|UNLANDED|AWAITING-OWNER|LANDED|RECOVERY|TRAP|PROBE) *\|' "$BOARD")

# Am I named at all? With one actor this catches a stale SESSION record; with two
# it is satisfied by either, so a second CoS session is information, not staleness.
if [ -n "${DSH_SESSION_ID:-}" ]; then
  mine="$(printf '%s' "$DSH_SESSION_ID" | sed 's/^session-//')"
  if ! grep -E '^SESSION *\|' "$BOARD" | grep -oE 'cos=[^ |]*' | cut -d= -f2- | sed 's/^session-//' | grep -qx "$mine"; then
    note "this session ($DSH_SESSION_ID) is named in NO SESSION record — either a successor owns this board, or the record is stale"
  fi
fi

# UNRECORDED LIVE STATE — the dispatch-window hole. A writer exists (its
# worktree, its session) from the moment it is dispatched, while the board is
# only written at a landing. The predecessor died in exactly that window, so the
# board is not the source of truth here: git and the live sessions are, and
# anything live that the board does not name is reported as a finding.
echo
echo "=== unrecorded live state (git + sessions vs the board) ==="
recorded="$(grep -oE '(worktree|branch|writer|cos|session)=[^ |]*' "$BOARD" | cut -d= -f2- | sed 's/^session-//' | sort -u)"
while read -r w; do
  [ -z "$w" ] && continue
  [ "$w" = "$PWD" ] && continue
  printf '%s\n' "$recorded" | grep -qx "$w" || note "worktree not named on the board (a writer may be live): $w"
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
recent=$(( $(date +%s) - 6*3600 ))
if [ "$oc_api_ok" -eq 1 ]; then
  # A child session (parentID set) under this repo updated in the last 6h and
  # not named on the board is a live writer/probe the board omits. The root CoS
  # session has no parentID, so it is never flagged.
  while IFS=$'\t' read -r oc_id oc_slug oc_agent oc_title; do
    [ -z "$oc_id" ] && continue
    printf '%s\n' "$recorded" | grep -qx "$oc_id" && continue
    printf '%s\n' "$recorded" | grep -qx "$oc_slug" && continue
    note "a child session under this repo was updated in the last 6h and is NOT named on the board: $oc_id ($oc_slug, agent $oc_agent) — $(printf '%s' "$oc_title" | cut -c1-80)"
  done < <(oc_recent_children "$PWD" "$recent")
else
  while read -r d; do
    # A board record may spell a session id with or without the `session-`
    # prefix; the directory uses the bare uuid, so normalize both sides.
    b="$(basename "$d" | sed 's/^session-//')"
    printf '%s\n' "$recorded" | grep -qx "$b" && continue
    # The LOG is the liveness signal, not the dir: a projection cache is rebuilt by
    # a mere recovery read, so a long-dead session can look freshly written. The
    # filename is GLOBBED: DSH writes `session.v3.jsonl.zstd` today, and the older
    # literal `session.jsonl.zstd` matched nothing, so the stat silently missed and
    # fell through to a slower mtime walk.
    last=""
    for f in "$d"/session*.jsonl.zst*; do
      [ -e "$f" ] || continue
      t="$(stat -c %Y "$f")"
      if [ -z "$last" ] || [ "$t" -gt "$last" ]; then last="$t"; fi
    done
    [ -n "$last" ] || last="$(age_min "$d")"
    [ -n "$last" ] && [ "$last" -ge "$recent" ] || continue
    note "session log written in the last 6h and NOT named on the board: $b (registry + its log are the authority)"
  done < <(find "$SESSROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
fi
[ "$stale" -eq 0 ] && echo "  nothing live that the board does not name"

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
