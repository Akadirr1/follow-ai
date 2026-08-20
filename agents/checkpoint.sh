#!/usr/bin/env bash
# Zero-token state checkpoint. Run by Claude Code hooks, never by the model.
#
#   checkpoint.sh save    throttled append (Stop hook)
#   checkpoint.sh close   unthrottled append + session boundary (SessionEnd)
#   checkpoint.sh resume  print the tail so a fresh session lands oriented
#
# Never exits nonzero and never blocks: a checkpoint must not be able to break
# the session it is trying to protect.

set -u
cat >/dev/null 2>&1 || true          # drain the hook's JSON on stdin

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 0
JOURNAL="$ROOT/.orchestrator/journal.md"
STAMP="$ROOT/.orchestrator/.last"
THROTTLE=300                          # seconds; Stop fires far too often to log every turn

mkdir -p "$ROOT/.orchestrator" 2>/dev/null || exit 0

emit() {
  {
    printf '\n## %s — %s\n' "$(date '+%Y-%m-%d %H:%M')" "$1"
    printf -- '- branch: %s @ %s\n' \
      "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" \
      "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
    local dirty
    dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    printf -- '- uncommitted: %s file(s)\n' "${dirty:-?}"
    local tasks
    tasks="$(orca orchestration task-list 2>/dev/null | grep -vE '\[(completed|failed)\]' | head -8)"
    if [ -n "$tasks" ]; then
      printf -- '- open tasks:\n'
      printf '%s\n' "$tasks" | sed 's/^/    /'
    else
      printf -- '- open tasks: none\n'
    fi
  } >>"$JOURNAL" 2>/dev/null
  date +%s >"$STAMP" 2>/dev/null
}

case "${1:-save}" in
  save)
    now=$(date +%s)
    last=$(cat "$STAMP" 2>/dev/null || echo 0)
    [ $((now - last)) -lt "$THROTTLE" ] && exit 0
    emit "checkpoint"
    ;;
  close)
    emit "session end"
    ;;
  resume)
    [ -f "$JOURNAL" ] || exit 0
    printf 'Previous coordinator state (from .orchestrator/journal.md):\n\n'
    tail -n 24 "$JOURNAL"
    ;;
esac
exit 0
