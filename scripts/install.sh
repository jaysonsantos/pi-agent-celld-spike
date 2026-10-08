#!/usr/bin/env bash
# Installs or upgrades the chart. The key pair of the object store comes from a SOPS file and goes to Helm through a
# pipe, so it is never in a plain file or on a command line.
#
# An upgrade keeps the values of the last install (the model, the features), and the values of this call go on top.
# Without that, an upgrade with no --values file would put the release back on the scripted test model.
#
# Usage: scripts/install.sh [helm options, for example --values my-values.yaml]
# Environment:
#   S3_CREDENTIALS_FILE SOPS file with the key pair of the object store, in the keys access_key and secret_key
#   S3_ENDPOINT         URL of the object store; necessary at the first install, the release keeps it
#   SPIKE_LLM_API_KEY   key of the model endpoint; necessary one time when llm.api is not faux
#   RESET_VALUES=1      start from the defaults of values.yaml and forget the values of the last install
set -euo pipefail
# shellcheck source=scripts/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

: "${S3_CREDENTIALS_FILE:?set S3_CREDENTIALS_FILE in .env (see .env.example)}"

cd "$REPO_ROOT"
helm dependency build . >/dev/null

if [[ "${RESET_VALUES:-}" == "1" ]]; then
  values_mode="--reset-values"
else
  values_mode="--reset-then-reuse-values"
fi

endpoint_values=()
if [[ -n "${S3_ENDPOINT:-}" ]]; then
  endpoint_values=(--set-string "bucket.endpoint=$S3_ENDPOINT")
fi

sops --decrypt --output-type json "$S3_CREDENTIALS_FILE" |
  jq '{secrets: ({s3AccessKeyId: .access_key, s3SecretAccessKey: .secret_key}
        + (if (env.SPIKE_LLM_API_KEY // "") == "" then {} else {llmApiKey: env.SPIKE_LLM_API_KEY} end))}' |
  helm_release upgrade --install "$RELEASE_NAME" . --create-namespace "$values_mode" --values - \
    "${endpoint_values[@]}" "$@"

helm_release get values "$RELEASE_NAME" --all --output json |
  jq --raw-output '"model of the release: \(.llm.api) / \(.llm.model)", "features of the release: \(.features | keys | join(", "))"'
