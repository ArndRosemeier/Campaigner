#!/usr/bin/env bash
# The dispatcher's ONE way to commit a board (docs/20) change: the board pin and the
# compile tier must BOTH pass, or nothing is committed or pushed. Written after the
# dispatcher twice pushed a board line that failed the width pin (rows 407 and 408):
# the old chain printed the pin's failure and carried on, because only the compile
# tier's exit code gated the commit.
# Usage: bash scripts/board-commit.sh "<commit message>"
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
msg="${1:?usage: board-commit.sh <commit message>}"
node_modules/.bin/vitest run tests/architecture/one-board-rule.test.ts > .gate-logs/board-pin.log 2>&1
pin=$?
if [ "$pin" -ne 0 ]; then echo "REFUSED: the board pin is RED (exit $pin) - see .gate-logs/board-pin.log"; grep -E "×" .gate-logs/board-pin.log; exit 1; fi
GATE_TESTS=0 GATE_CHECKS=all GATE_LOGDIR=.gate-logs/board-commit bash scripts/gate.sh > .gate-logs/board-commit-run.txt 2>&1
tier=$?
if [ "$tier" -ne 2 ] && [ "$tier" -ne 0 ]; then echo "REFUSED: the compile tier exited $tier"; exit 1; fi
bash scripts/board.sh > .gate-logs/board-reconcile.log 2>&1
if ! grep -q "BOARD RECONCILED" .gate-logs/board-reconcile.log; then echo "REFUSED: the board does not reconcile"; grep -E "!!|STALE" .gate-logs/board-reconcile.log; exit 1; fi
git add docs/20-ORCHESTRATION.md
git -c user.name='Campaigner Dev' -c user.email='dev@campaigner.local' commit -q -m "$msg" -- docs/20-ORCHESTRATION.md || { echo "REFUSED: nothing to commit"; exit 1; }
git pull --rebase -q origin main && git push -q origin main && echo "PUSHED $(git log --oneline -1)"
