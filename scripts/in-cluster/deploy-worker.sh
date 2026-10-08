#!/usr/bin/env bash
# Builds the worker and writes the deployment into the bucket with `celld deploy`. The deploy Job of the chart runs
# this script. celld calls esbuild for the bundle, so the script installs the packages of the lockfile first.
#
# Environment:
#   SOURCE_DIR         read-only copy of the worker sources and manifests
#   WORK_DIR           writable directory for the build
#   CELLD_BIN          path of the celld binary
#   CELLD_BUCKET       s3://bucket/prefix of the fleet
#   S3_ENDPOINT        endpoint of the S3 shim of the gateway sidecar
#   AWS_REGION         region of the bucket
#   WORKER_VARS_JSON   the vars of the worker, as one JSON object
set -euo pipefail

: "${SOURCE_DIR:?}" "${WORK_DIR:?}" "${CELLD_BIN:?}" "${CELLD_BUCKET:?}" "${S3_ENDPOINT:?}" "${AWS_REGION:?}"

# A ConfigMap volume holds symbolic links, so copy the files that they point to.
mkdir -p "$WORK_DIR"
cp --recursive --dereference "$SOURCE_DIR"/. "$WORK_DIR"/
cd "$WORK_DIR"

package_manager="$(node --print "require('./package.json').packageManager")"
echo "install the packages with ${package_manager}"
npx --yes "$package_manager" install --frozen-lockfile --prod

node src/jobs/render-wrangler.ts --source wrangler.jsonc --output wrangler.deploy.json

echo "deploy to ${CELLD_BUCKET}"
CELLD_ESBUILD="$WORK_DIR/node_modules/.bin/esbuild" "$CELLD_BIN" deploy \
  --config "$WORK_DIR/wrangler.deploy.json" \
  --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
