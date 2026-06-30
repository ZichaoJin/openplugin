#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

make_qoder_plugin_repo() {
    local repo_dir="$1"

    mkdir -p "$repo_dir/plugins/test-plugin/.claude-plugin"
    cat > "$repo_dir/plugins/test-plugin/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Test plugin"
}
JSON

    mkdir -p "$repo_dir/plugins/test-plugin/hooks"
    cat > "$repo_dir/plugins/test-plugin/hooks/hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_HITL_CLIENT=auto /bin/bash \"__PLUGIN_ROOT__/hooks/scripts/test.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
    cat > "$repo_dir/plugins/test-plugin/hooks/codex-hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_HITL_CLIENT=codex /bin/bash \"__PLUGIN_ROOT__/hooks/scripts/test.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
    cat > "$repo_dir/plugins/test-plugin/hooks/qoderwork-hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_HITL_CLIENT=qoderwork /bin/bash \"__PLUGIN_ROOT__/hooks/scripts/test.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
    cat > "$repo_dir/plugins/test-plugin/hooks/qoder-hooks.json" <<'JSON'
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "test-plugin/permission-request",
            "command": "AGENT_HITL_CLIENT=qoder /bin/bash \"__PLUGIN_ROOT__/hooks/scripts/test.sh\"",
            "timeout": 600,
            "statusMessage": "test"
          }
        ]
      }
    ]
  }
}
JSON

    cat > "$repo_dir/plugins/test-plugin/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "test-server": {
      "command": "python3",
      "args": ["-m", "http.server"]
    }
  }
}
JSON
}

run_qoder_install() {
    local tmp_dir="$1"
    local out_file="$2"

    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/test-marketplace.git" \
    MARKETPLACE_NAME="test-marketplace" \
    CLONE_DIR="$tmp_dir/clone" \
    PLUGIN_FILTER="test-plugin" \
    WANT_CLAUDE=false \
    WANT_CODEX=false \
    WANT_QODER=true \
    WANT_QODERWORK=false \
    bash "$ROOT_DIR/scripts/install.sh" install >"$out_file" 2>&1
}

run_qoder_uninstall() {
    local tmp_dir="$1"
    local out_file="$2"

    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/test-marketplace.git" \
    MARKETPLACE_NAME="test-marketplace" \
    WANT_CLAUDE=false \
    WANT_CODEX=false \
    WANT_QODER=true \
    WANT_QODERWORK=false \
    bash "$ROOT_DIR/scripts/install.sh" uninstall >"$out_file" 2>&1
}

test_qoder_install_uses_qoder_hooks_and_home() {
    local tmp_dir out_file settings mcp
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_qoder_plugin_repo "$tmp_dir/clone/repo"
    mkdir -p "$tmp_dir/home/.qoder"

    run_qoder_install "$tmp_dir" "$out_file"

    settings="$tmp_dir/home/.qoder/settings.json"
    mcp="$tmp_dir/home/.qoder/mcp.json"

    test -f "$settings"
    test -f "$mcp"
    grep -Fq 'AGENT_HITL_CLIENT=qoder' "$settings"
    grep -Fq "$tmp_dir/home/.qoder/plugins-custom/test-plugin" "$settings"
    grep -Fq '"test-server"' "$mcp"
    test -f "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/qoder-hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/codex-hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/qoderwork-hooks.json"
    if grep -Fq 'AGENT_HITL_CLIENT=auto' "$settings"; then
        echo "qoder install must not register generic auto hooks"
        cat "$settings"
        return 1
    fi

    if [[ -e "$tmp_dir/home/.qoderwork/settings.json" || -e "$tmp_dir/home/.qoderwork/mcp.json" ]]; then
        echo "qoder install must not write qoderwork config"
        cat "$out_file"
        return 1
    fi

    run_qoder_uninstall "$tmp_dir" "$tmp_dir/uninstall.out"

    if [[ -d "$tmp_dir/home/.qoder/plugins-custom/test-plugin" ]]; then
        echo "qoder uninstall must remove qoder plugin directory"
        cat "$tmp_dir/uninstall.out"
        return 1
    fi
    if grep -Fq 'AGENT_HITL_CLIENT=qoder' "$settings"; then
        echo "qoder uninstall must remove qoder hooks"
        cat "$tmp_dir/uninstall.out"
        return 1
    fi
    if grep -Fq '"test-server"' "$mcp"; then
        echo "qoder uninstall must remove qoder mcp entries"
        cat "$tmp_dir/uninstall.out"
        return 1
    fi
}

test_qoder_install_uses_qoder_hooks_and_home
echo "qoder target tests passed"
