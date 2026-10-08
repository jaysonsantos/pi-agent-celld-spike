#!/usr/bin/env bash
# Runs the unit tests, then renders the chart to make sure that each template is valid.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pnpm test
helm dependency build . >/dev/null
helm template pi-agent-celld-spike . --namespace pi-agent-celld-spike \
  --set secrets.s3AccessKeyId=test --set secrets.s3SecretAccessKey=test \
  --set bucket.endpoint=https://s3.example.com \
  --set-json 'features={"render-test":{"repo":"https://example.com/project.git","task":"Render the chart."}}' \
  >/dev/null
echo "the chart renders"
