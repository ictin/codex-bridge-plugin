#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
EXT_DIR="$STATE_DIR/extensions/codex-bridge"
CONFIG_PATH="$STATE_DIR/openclaw.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install jq and retry." >&2
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found in PATH." >&2
  exit 1
fi

mkdir -p "$STATE_DIR/extensions"
mkdir -p "$EXT_DIR"

# Sync plugin files into OpenClaw extension directory.
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude '*.log' \
  "$REPO_DIR/" "$EXT_DIR/"

(
  cd "$EXT_DIR"
  npm ci
)

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "{}" > "$CONFIG_PATH"
fi

TMP_CONFIG="$(mktemp)"
jq '
  .plugins = (.plugins // {}) |
  .plugins.allow = (((.plugins.allow // []) + ["codex-bridge", "telegram"]) | unique) |
  .plugins.entries = (.plugins.entries // {}) |
  .plugins.entries["codex-bridge"] = ((.plugins.entries["codex-bridge"] // {}) * {"enabled": true}) |
  .channels = (.channels // {}) |
  .channels.telegram = (.channels.telegram // {}) |
  .channels.telegram.capabilities = (
    (.channels.telegram.capabilities // {}) |
    if type == "object" then . * {"inlineButtons": "all"} else {"inlineButtons": "all"} end
  )
' "$CONFIG_PATH" > "$TMP_CONFIG"

mv "$TMP_CONFIG" "$CONFIG_PATH"

openclaw gateway restart

echo "Installed codex-bridge to: $EXT_DIR"
echo "Updated config: $CONFIG_PATH"
echo "Verify with: openclaw plugins info codex-bridge --json"
