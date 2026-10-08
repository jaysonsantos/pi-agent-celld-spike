#!/usr/bin/env bash
# Removes the release and its namespace: celld, OpenSandbox, each sandbox, and each workspace volume.
# The bucket keeps the state of each feature. Pass --purge-bucket to remove those objects too.
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PURGE_FLAG="--purge-bucket"
BUCKET_URL="${BUCKET_URL:-s3://pi-agent-celld-spike}"

helm_release uninstall "$RELEASE_NAME" --wait || true
kubectl --kubeconfig "$SPIKE_KUBECONFIG" delete namespace "$RELEASE_NAMESPACE" --ignore-not-found --wait

if [[ "${1:-}" == "$PURGE_FLAG" ]]; then
  : "${S3_ENDPOINT:?set S3_ENDPOINT in .env}" "${S3_AWS_PROFILE:?set S3_AWS_PROFILE in .env}"
  aws --profile "$S3_AWS_PROFILE" --endpoint-url "$S3_ENDPOINT" s3 rm "$BUCKET_URL" --recursive
fi
