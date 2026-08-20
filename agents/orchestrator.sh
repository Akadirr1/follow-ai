#!/usr/bin/env bash
# Launch this project's coordinator.
#
# Save this as an Orca command so the coordinator can be started on demand,
# or run it by hand:
#
#     ./agents/orchestrator.sh
#
# Model and effort come from agents/roles.toml [roles.orchestrator].

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# python3 on macOS/Linux, python on Windows (Git Bash)
PY_BIN="$(command -v python3 || command -v python)"

read -r MODEL EFFORT <<<"$("$PY_BIN" - <<'PY'
import tomllib
r = tomllib.load(open("agents/roles.toml", "rb"))["roles"]["orchestrator"]
print(r.get("model") or "opus", r.get("effort") or "")
PY
)"

if [ -n "$EFFORT" ]; then
  export CLAUDE_EFFORT="$EFFORT"
fi

PROJECT="$(basename "$PWD")"

exec claude --model "$MODEL" \
  "You are the $PROJECT coordinator. Read AGENTS.md and agents/orchestrator.md, then run the session-start procedure in agents/orchestrator.md and report the reconciled state plus the task you propose. Do not change code."
