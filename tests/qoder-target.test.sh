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
            "command": "echo generic"
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
        "hooks": [
          {
            "type": "command",
            "command": "echo codex"
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

    cat > "$repo_dir/plugins/test-plugin/hooks/qoderwork-hooks.json" <<'JSON'
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "echo qoderwork"
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
    local tmp_dir out_file settings mcp installed installed_v2
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_qoder_plugin_repo "$tmp_dir/clone/repo"
    mkdir -p "$tmp_dir/home/.qoder"

    run_qoder_install "$tmp_dir" "$out_file"

    settings="$tmp_dir/home/.qoder/settings.json"
    mcp="$tmp_dir/home/.qoder/mcp.json"
    installed="$tmp_dir/home/.qoder/plugins/installed_plugins.json"
    installed_v2="$tmp_dir/home/.qoder/plugins/installed_plugins-v2.json"

    test -f "$settings"
    test -f "$mcp"
    grep -Fq 'AGENT_HITL_CLIENT=qoder' "$settings"
    grep -Fq "$tmp_dir/home/.qoder/plugins-custom/test-plugin" "$settings"
    grep -Fq '"test-server"' "$mcp"
    grep -Fq '"test-plugin@test-marketplace": true' "$settings"
    grep -Fq '"test-plugin@test-marketplace"' "$installed"
    grep -Fq '"test-plugin@test-marketplace"' "$installed_v2"
    grep -Fq '"source": "marketplace"' "$installed_v2"
    test -f "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/qoder-hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/codex-hooks.json"
    test ! -e "$tmp_dir/home/.qoder/plugins-custom/test-plugin/hooks/qoderwork-hooks.json"

    python3 - "$settings" "$tmp_dir/home/.qoder/plugins-custom/test-plugin" <<'PYEOF'
import json, sys

settings_path, plugin_dir = sys.argv[1:]

with open(settings_path) as f:
    settings = json.load(f)
settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append({
    "matcher": "*",
    "hooks": [{
        "type": "command",
        "name": "test-plugin/stale",
        "command": f"node {plugin_dir}/hooks/scripts/stale.js",
        "timeout": 5
    }]
})
settings["hooks"].setdefault("Stop", []).append({
    "matcher": "*",
    "hooks": [{
        "type": "command",
        "command": f"bash {plugin_dir}/hooks/scripts/unnamed-stale.sh",
        "timeout": 5
    }]
})
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF

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
    if grep -Fq 'test-plugin' "$settings" "$installed" "$installed_v2"; then
        echo "qoder uninstall must remove stale settings and registry entries"
        cat "$settings"
        cat "$installed"
        cat "$installed_v2"
        return 1
    fi
    if grep -Fq '"test-server"' "$mcp"; then
        echo "qoder uninstall must remove qoder mcp entries"
        cat "$tmp_dir/uninstall.out"
        return 1
    fi
}

test_qoder_uninstall_removes_orphaned_opennotch_state() {
    local tmp_dir out_file settings installed installed_v2
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/uninstall-opennotch.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    mkdir -p "$tmp_dir/home/.qoder/plugins"
    settings="$tmp_dir/home/.qoder/settings.json"
    installed="$tmp_dir/home/.qoder/plugins/installed_plugins.json"
    installed_v2="$tmp_dir/home/.qoder/plugins/installed_plugins-v2.json"

    cat >"$settings" <<JSON
{
  "enabledPlugins": {
    "agent-notch@opennotch": true,
    "other@market": true
  },
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "name": "agent-notch/permission-request",
            "command": "AGENT_HITL_CLIENT=qoder /bin/bash \\"$tmp_dir/home/.qoder/plugins-custom/agent-notch/hooks/scripts/agent-notch-hook.sh\\"",
            "timeout": 600
          },
          {
            "type": "command",
            "name": "other/permission-request",
            "command": "echo keep",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node $tmp_dir/home/.qoder/plugins-custom/agent-notch/hooks/scripts/hitl-island-hook.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
    cat >"$installed" <<JSON
{"plugins":{"agent-notch@opennotch":{"installPath":"$tmp_dir/home/.qoder/plugins-custom/agent-notch"},"other@market":{"installPath":"/keep"}}}
JSON
    cat >"$installed_v2" <<JSON
{"plugins":{"agent-notch@opennotch":[{"installPath":"$tmp_dir/home/.qoder/plugins-custom/agent-notch"}],"other@market":[{"installPath":"/keep"}]}}
JSON

    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/opennotch.git" \
    MARKETPLACE_NAME="opennotch" \
    WANT_CLAUDE=false \
    WANT_CODEX=false \
    WANT_QODER=true \
    WANT_QODERWORK=false \
    bash "$ROOT_DIR/scripts/install.sh" uninstall >"$out_file" 2>&1

    if grep -Fq 'agent-notch' "$settings" "$installed" "$installed_v2"; then
        echo "opennotch uninstall must remove orphaned Agent Notch state"
        cat "$settings"
        cat "$installed"
        cat "$installed_v2"
        return 1
    fi
    grep -Fq 'other@market' "$settings"
    grep -Fq 'other@market' "$installed"
    grep -Fq 'other@market' "$installed_v2"
}

test_qoder_install_uses_qoder_hooks_and_home
test_qoder_uninstall_removes_orphaned_opennotch_state
echo "qoder target tests passed"
