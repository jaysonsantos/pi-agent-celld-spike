#!/usr/bin/env bash
# Prints a short status of one feature: the pipeline, the sandbox, the busy agents, and the progress log.
#
# Usage: scripts/status.sh <feature> [number of log lines]
set -euo pipefail
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
FEATURE="${1:?feature name}"
LOG_LINES="${2:-12}"

"$SCRIPT_DIR/api.sh" GET "/features/$FEATURE" | jq --raw-output --argjson lines "$LOG_LINES" '
  "feature:   \(.feature) (exists: \(.exists))",
  "pipeline:  \(.pipeline // {} | "\(.status // "-") phase=\(.phase // "-") round=\(.round // "-") outcome=\(.outcome // "-") \(.result // .error // "")")",
  "sandbox:   \(.sandbox.id // "-") (generation \(.sandbox.generation))",
  "agents:    \([.conversations | to_entries[] | "\(.key)\(if .value.busy then "*" else "" end)\(if (.value.runningTools | length) > 0 then "[\(.value.runningTools | join(","))]" else "" end)"] | join(" "))",
  "model:     \(.featureModel // .model | "\(.provider)/\(.modelId)") (deployed: \(.model.provider)/\(.model.modelId))",
  (if .blocked then "BLOCKED:   \(.blocked)" else empty end),
  "object:    booted \(.persistence.bootedAt), \(.persistence.objectPrefix)",
  "log:",
  (.events[-$lines:][] | "  \(.at / 1000 | strftime("%H:%M:%S")) \(.phase): \(.message)")
'
