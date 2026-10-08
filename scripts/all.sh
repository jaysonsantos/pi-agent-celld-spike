#!/usr/bin/env bash
# The lint and the tests, as one command.
set -euo pipefail
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"

"$SCRIPT_DIR/lint.sh"
"$SCRIPT_DIR/test.sh"
