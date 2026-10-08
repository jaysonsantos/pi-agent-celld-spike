#!/usr/bin/env bash
# Takes the celld binary out of the release image and puts it in .tools/, for `pnpm dev` and scripts/deploy-local.sh.
# celld has no package for nix, and its image holds one static-linked glibc binary.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CELLD_IMAGE="${CELLD_IMAGE:-ghcr.io/denoland/celld:0.6.1}"
BINARY_IN_IMAGE="usr/local/bin/celld"
TOOLS_DIR=".tools"

case "$(uname -m)" in
  x86_64) platform="linux/amd64" ;;
  aarch64 | arm64) platform="linux/arm64" ;;
  *)
    echo "no celld image for $(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$TOOLS_DIR"
crane export --platform "$platform" "$CELLD_IMAGE" - | tar --extract --directory "$TOOLS_DIR" --strip-components 3 "$BINARY_IN_IMAGE"
"$TOOLS_DIR/celld" --version
