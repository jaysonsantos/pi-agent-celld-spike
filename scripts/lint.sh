#!/usr/bin/env bash
# Runs every linter: the prek hooks, the type check, and the Helm lint.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

prek run --all-files
pnpm run typecheck
helm dependency build . >/dev/null
# The chart refuses to render without the key pair and the endpoint, so the lint gets placeholder values.
helm lint . --namespace pi-agent-celld-spike \
  --set secrets.s3AccessKeyId=lint --set secrets.s3SecretAccessKey=lint \
  --set bucket.endpoint=https://s3.example.com
