#!/usr/bin/env bash
# Shared settings of the scripts. Source this file; do not run it.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

# The settings of this machine are in .env (see .env.example). direnv loads that file into an interactive shell, and
# this function loads it for a script that runs without direnv. A variable that the caller set stays as it is.
load_env_file() {
  local line name
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    name="${line%%=*}"
    [[ -n "${!name:-}" ]] || export "$name=${line#*=}"
  done <"$1"
}
load_env_file "$REPO_ROOT/.env"

# The release, and the namespace that values.yaml fixes.
export RELEASE_NAME="${RELEASE_NAME:-pi-agent-celld-spike}"
export RELEASE_NAMESPACE="${RELEASE_NAMESPACE:-pi-agent-celld-spike}"

# Each script names the kubeconfig, so a different default context cannot get the release.
: "${SPIKE_KUBECONFIG:?set SPIKE_KUBECONFIG in .env to the kubeconfig of the cluster (see .env.example)}"
export SPIKE_KUBECONFIG

kube() {
  kubectl --kubeconfig "$SPIKE_KUBECONFIG" --namespace "$RELEASE_NAMESPACE" "$@"
}

helm_release() {
  helm --kubeconfig "$SPIKE_KUBECONFIG" --namespace "$RELEASE_NAMESPACE" "$@"
}
