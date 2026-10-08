#!/usr/bin/env bash
# Proves the recovery on the cluster with the scripted model (llm.api: faux). The script starts a feature, kills a
# pod while the implementer runs its 45 second command, and checks that the pipeline still ends with `accepted`.
#
# Usage: scripts/recovery-test.sh [harness|sandbox] [feature name]
#   harness  kills the celld pod without grace (default)
#   sandbox  kills the sandbox pod of the feature without grace
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$REPO_ROOT"

TARGET="${1:-harness}"
FEATURE="${2:-recovery-$TARGET-$(date +%H%M%S)}"
REQUEST_FILE="${REQUEST_FILE:-examples/python-binary-memcached-touch.json}"
HARNESS_POD="pi-agent-celld-spike-celld-0"
# The control-plane node of the cluster is slow, so each loop that calls kubectl pauses this long.
POLL_SECONDS=30
TIMEOUT_SECONDS=1500
SLOW_COMMAND_LAST_LINE="working 45"

status_json() {
  scripts/api.sh GET "/features/$FEATURE" 2>/dev/null || true
}

model="$(scripts/api.sh GET "/features/$FEATURE" | jq --raw-output .model.provider)"
if [[ "$model" != "faux" ]]; then
  echo "this test needs the scripted model, and the release uses: $model" >&2
  exit 2
fi

scripts/api.sh PUT "/features/$FEATURE" "$REQUEST_FILE" >/dev/null
echo "started $FEATURE"

killed=0
deadline=$(($(date +%s) + TIMEOUT_SECONDS))
while true; do
  status="$(status_json)"
  phase="$(jq --raw-output '.pipeline.phase // "-"' <<<"$status" 2>/dev/null || echo "-")"
  outcome="$(jq --raw-output '.pipeline.outcome // "-"' <<<"$status" 2>/dev/null || echo "-")"
  tools="$(jq --raw-output '.conversations.implementer.runningTools // [] | join(",")' <<<"$status" 2>/dev/null || echo "")"
  echo "$(date +%H:%M:%S) phase=$phase outcome=$outcome implementer=[$tools]"

  if [[ "$killed" == 0 && "$phase" == "implement" && "$tools" == *bash* ]]; then
    if [[ "$TARGET" == "sandbox" ]]; then
      pod="$(kube get pods --selector "feature=$FEATURE" --output name | head -1)"
    else
      pod="pod/$HARNESS_POD"
    fi
    echo ">>> kill $pod without grace"
    kube delete "$pod" --grace-period=0 --force >/dev/null 2>&1
    killed=1
  fi
  [[ "$outcome" != "-" ]] && break
  if (($(date +%s) > deadline)); then
    echo "FAIL: no result after $TIMEOUT_SECONDS seconds" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

verdict="$(jq --raw-output '.pipeline.result.verdict // "-"' <<<"$status")"
complete_runs="$(scripts/api.sh GET "/features/$FEATURE/transcript?role=implementer&limit=60" | grep --count --line-regexp "$SLOW_COMMAND_LAST_LINE" || true)"
echo "killed a pod: $killed, outcome: $outcome, verdict: $verdict, complete runs of the slow command: $complete_runs"

if [[ "$killed" == 1 && "$outcome" == "completed" && "$verdict" == "accepted" && "$complete_runs" -ge 1 ]]; then
  echo "PASS"
else
  echo "FAIL" >&2
  exit 1
fi
