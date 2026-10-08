#!/usr/bin/env bash
# Deploys the worker from this machine into the bucket, without the deploy Job of the chart. The celld node in the
# cluster takes the new version in 30 seconds. Use it for a short edit and test cycle on the worker code.
#
# The vars come from the Job of the installed release, so the deployment has the same settings as the chart.
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$REPO_ROOT"

CELLD_BIN="${CELLD_BIN:-$REPO_ROOT/.tools/celld}"
SHIM_LISTEN="${SHIM_LISTEN:-127.0.0.1:19000}"
PROXY_LISTEN="${PROXY_LISTEN:-127.0.0.1:19100}"
BUCKET_URL="${BUCKET_URL:-s3://pi-agent-celld-spike/fleet}"
: "${S3_ENDPOINT:?set S3_ENDPOINT in .env}" "${S3_CREDENTIALS_FILE:?set S3_CREDENTIALS_FILE in .env}"
BUCKET_REGION="${BUCKET_REGION:-eu-central-1}"
# celld wants the config in the project root: `main` must be a path below the folder of the config.
DEPLOY_CONFIG="wrangler.deploy.json"

[[ -x "$CELLD_BIN" ]] || scripts/fetch-celld.sh

deploy_job="$(kube get jobs --selector app.kubernetes.io/component=deploy --sort-by .metadata.creationTimestamp --output name | tail -1)"
WORKER_VARS_JSON="$(kube get "$deploy_job" --output json |
  jq --raw-output '.spec.template.spec.containers[0].env[] | select(.name == "WORKER_VARS_JSON") | .value')"
export WORKER_VARS_JSON

# The shim gets the account key pair from the SOPS file; celld itself gets placeholders. The keys go from sops to
# the environment of the shim process only: no file and no command line holds them.
(
  eval "$(sops --decrypt --output-type json "$S3_CREDENTIALS_FILE" |
    jq --raw-output '@sh "export AWS_ACCESS_KEY_ID=\(.access_key) AWS_SECRET_ACCESS_KEY=\(.secret_key)"')"
  exec node src/gateway/main.ts --s3-upstream "$S3_ENDPOINT" --s3-listen "$SHIM_LISTEN" --proxy-listen "$PROXY_LISTEN"
) &
shim_pid=$!
trap 'kill "$shim_pid" 2>/dev/null || true' EXIT
until node --eval "fetch('http://$PROXY_LISTEN/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; do
  sleep 0.5
done

node src/jobs/render-wrangler.ts --source wrangler.jsonc --output "$DEPLOY_CONFIG"

AWS_ACCESS_KEY_ID=shim AWS_SECRET_ACCESS_KEY=shim CELLD_ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild" \
  "$CELLD_BIN" deploy --config "$REPO_ROOT/$DEPLOY_CONFIG" --bucket "$BUCKET_URL" \
  --endpoint "http://$SHIM_LISTEN" --region "$BUCKET_REGION"
