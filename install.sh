#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install opencode-slave into your OpenCode profile.

Usage:
  ./install.sh [options]

Options:
  --repo-url <url>      Git repository URL (used when not running from local checkout)
  --install-dir <path>  Install path for cloned repository
  --local               Force using current checkout as source
  --dry-run             Print commands without executing
  -h, --help            Show help

Environment variables:
  OPENCODE_SLAVE_REPO_URL
  OPENCODE_SLAVE_INSTALL_DIR
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: '$command_name' is required but not installed." >&2
    exit 1
  fi
}

run_step() {
  local step="$1"
  shift
  echo "==> $step"
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

REPO_URL="${OPENCODE_SLAVE_REPO_URL:-}"
INSTALL_DIR="${OPENCODE_SLAVE_INSTALL_DIR:-$HOME/.config/opencode/plugins/opencode-slave}"
USE_LOCAL=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --local)
      USE_LOCAL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SOURCE_AVAILABLE=0
if [[ -f "$SCRIPT_DIR/package.json" && -f "$SCRIPT_DIR/src/cli.js" ]]; then
  LOCAL_SOURCE_AVAILABLE=1
fi

SOURCE_DIR=""
MODE=""

if [[ "$USE_LOCAL" -eq 1 ]]; then
  if [[ "$LOCAL_SOURCE_AVAILABLE" -ne 1 ]]; then
    echo "Error: --local was requested but no local opencode-slave checkout was detected." >&2
    exit 1
  fi
  SOURCE_DIR="$SCRIPT_DIR"
  MODE="local"
elif [[ "$LOCAL_SOURCE_AVAILABLE" -eq 1 ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
  MODE="local"
else
  if [[ -z "$REPO_URL" ]]; then
    echo "Error: No local checkout detected and no repository URL provided." >&2
    echo "Set OPENCODE_SLAVE_REPO_URL or pass --repo-url." >&2
    exit 1
  fi
  MODE="remote"
fi

require_command npm

if [[ "$MODE" == "remote" ]]; then
  require_command git
  run_step "Creating install directory parent" mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR" ]]; then
    run_step "Removing previous installation" rm -rf "$INSTALL_DIR"
  fi
  run_step "Cloning repository" git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  SOURCE_DIR="$INSTALL_DIR"
fi

run_step "Installing npm dependencies" npm --prefix "$SOURCE_DIR" install
run_step "Installing OpenCode commands" npm --prefix "$SOURCE_DIR" run install:opencode

echo
echo "opencode-slave installed successfully."
echo "Source: $SOURCE_DIR"
echo "Try: /slave-status"
