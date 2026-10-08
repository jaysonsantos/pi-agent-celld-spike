#!/usr/bin/env bash
# Calls the worker API through the proxy of the Kubernetes API server, so no port-forward is necessary.
#
# Usage:
#   scripts/api.sh GET /features/<name>
#   scripts/api.sh PUT /features/<name> examples/python-binary-memcached-touch.json
#   scripts/api.sh POST /features/<name>/abort
#   scripts/api.sh DELETE /features/<name>
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SERVICE="${SERVICE:-pi-agent-celld-spike-celld}"
METHOD="${1:?method: GET, PUT, POST, or DELETE}"
REQUEST_PATH="${2:?path, for example /features/my-feature}"
BODY_FILE="${3:-}"
PROXY_PATH="/api/v1/namespaces/${RELEASE_NAMESPACE}/services/http:${SERVICE}:http/proxy${REQUEST_PATH}"

case "$METHOD" in
  GET) kube get --raw "$PROXY_PATH" ;;
  PUT) kube replace --raw "$PROXY_PATH" --filename "${BODY_FILE:?a PUT needs a body file}" ;;
  POST)
    if [[ -n "$BODY_FILE" ]]; then
      kube create --raw "$PROXY_PATH" --filename "$BODY_FILE"
    else
      echo '{}' | kube create --raw "$PROXY_PATH" --filename -
    fi
    ;;
  DELETE) kube delete --raw "$PROXY_PATH" ;;
  *)
    echo "unknown method: $METHOD" >&2
    exit 2
    ;;
esac
