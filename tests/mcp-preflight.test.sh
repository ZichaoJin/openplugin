#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

make_plugin_repo() {
    local repo_dir="$1"
    local command_value="$2"
    local include_codex_manifest="${3:-false}"
    local codex_mcp_ref="${4:-}"

    mkdir -p "$repo_dir/plugins/test-plugin/.claude-plugin"
    cat > "$repo_dir/plugins/test-plugin/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Test plugin"
}
JSON
    cat > "$repo_dir/plugins/test-plugin/.mcp.json" <<JSON
{
  "mcpServers": {
    "test-server": {
      "command": "$command_value",
      "args": []
    }
  }
}
JSON

    if [[ "$include_codex_manifest" == "true" ]]; then
        mkdir -p "$repo_dir/plugins/test-plugin/.codex-plugin"
        if [[ -n "$codex_mcp_ref" ]]; then
            cat > "$repo_dir/plugins/test-plugin/.codex-plugin/plugin.json" <<JSON
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Test plugin",
  "mcpServers": "$codex_mcp_ref"
}
JSON
        else
            cat > "$repo_dir/plugins/test-plugin/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Test plugin"
}
JSON
        fi
    fi
}

make_root_plugin_repo() {
    local repo_dir="$1"

    mkdir -p "$repo_dir/.claude-plugin"
    cat > "$repo_dir/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "root-plugin",
  "version": "1.0.0",
  "description": "Root plugin"
}
JSON
    mkdir -p "$repo_dir/skills/root-plugin"
    cat > "$repo_dir/skills/root-plugin/SKILL.md" <<'MD'
---
name: root-plugin
description: Use when testing root plugin installation.
---

# Root Plugin
MD
    mkdir -p "$repo_dir/hooks"
    cat > "$repo_dir/hooks/hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
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
    cat > "$repo_dir/hooks/qoder-hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo qoder"
          }
        ]
      }
    ]
  }
}
JSON
    cat > "$repo_dir/hooks/qoderwork-hooks.json" <<'JSON'
{
  "hooks": {
    "PermissionRequest": [
      {
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
}

add_codex_hooks_to_plugin_repo() {
    local repo_dir="$1"

    mkdir -p "$repo_dir/plugins/test-plugin/hooks"
    cat > "$repo_dir/plugins/test-plugin/hooks/codex-hooks.json" <<'JSON'
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo permission"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo pre"
          }
        ]
      }
    ]
  }
}
JSON
}

test_github_tarball_download_uses_default_branch() {
    local tmp_dir out_file status fake_bin tarball
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/discover.out"
    fake_bin="$tmp_dir/bin"
    tarball="$tmp_dir/plugin-repo.tgz"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/src/repo" "python3"
    tar -czf "$tarball" -C "$tmp_dir/src" repo

    mkdir -p "$fake_bin"
    cat > "$fake_bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "ls-remote" && "$2" == "--symref" ]]; then
    printf 'ref: refs/heads/v1-foundation\tHEAD\n'
    printf '0123456789012345678901234567890123456789\tHEAD\n'
    exit 0
fi
printf 'unexpected git invocation: %s\n' "$*" >&2
exit 1
SH
    chmod +x "$fake_bin/git"

    cat > "$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
out=""
url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            out="$2"
            shift 2
            ;;
        -*)
            shift
            ;;
        *)
            url="$1"
            shift
            ;;
    esac
done
if [[ "$url" == *"/refs/heads/v1-foundation.tar.gz" ]]; then
    if [[ -n "$out" ]]; then
        cat "$TEST_TARBALL" > "$out"
    else
        cat "$TEST_TARBALL"
    fi
    exit 0
fi
if [[ -n "$out" ]]; then
    printf 'not a tar archive' > "$out"
else
    printf 'not a tar archive'
fi
exit 0
SH
    chmod +x "$fake_bin/curl"

    status=0
    PATH="$fake_bin:$PATH" \
    TEST_TARBALL="$tarball" \
    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/non-main-plugin.git" \
    MARKETPLACE_NAME="non-main-plugin" \
    CLONE_DIR="$tmp_dir/clone" \
    bash "$ROOT_DIR/scripts/install.sh" discover >"$out_file" 2>&1 || status=$?

    if [[ "$status" -ne 0 ]]; then
        echo "expected discover to use the GitHub default branch tarball"
        cat "$out_file"
        return 1
    fi

    grep -q '"test-plugin"' "$out_file"
}

run_install() {
    local tmp_dir="$1"
    local out_file="$2"
    local want_claude="${3:-false}"
    local want_codex="${4:-false}"
    local want_qoderwork="${5:-true}"

    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/test-marketplace.git" \
    MARKETPLACE_NAME="test-marketplace" \
    CLONE_DIR="$tmp_dir/clone" \
    PLUGIN_FILTER="test-plugin" \
    WANT_CLAUDE="$want_claude" \
    WANT_CODEX="$want_codex" \
    WANT_QODERWORK="$want_qoderwork" \
    bash "$ROOT_DIR/scripts/install.sh" install >"$out_file" 2>&1
}

test_missing_mcp_command_blocks_install() {
    local tmp_dir out_file status
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "definitely-missing-openplugin-command"
    mkdir -p "$tmp_dir/home"

    status=0
    run_install "$tmp_dir" "$out_file" || status=$?

    if [[ "$status" -eq 0 ]]; then
        echo "expected install to fail when MCP command is missing"
        cat "$out_file"
        return 1
    fi

    grep -q "definitely-missing-openplugin-command" "$out_file"
    grep -q "test-server" "$out_file"
}

test_missing_absolute_mcp_command_blocks_install() {
    local tmp_dir out_file status
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "/definitely/missing/openplugin-command"
    mkdir -p "$tmp_dir/home"

    status=0
    run_install "$tmp_dir" "$out_file" || status=$?

    if [[ "$status" -eq 0 ]]; then
        echo "expected install to fail when MCP command path is missing"
        cat "$out_file"
        return 1
    fi

    grep -q "/definitely/missing/openplugin-command" "$out_file"
    grep -q "path does not exist" "$out_file"
}

test_codex_manifest_must_reference_mcp_config() {
    local tmp_dir out_file status
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "python3" "true"
    mkdir -p "$tmp_dir/home/.codex"

    status=0
    run_install "$tmp_dir" "$out_file" false true false || status=$?

    if [[ "$status" -eq 0 ]]; then
        echo "expected Codex install to fail when manifest does not declare mcpServers"
        cat "$out_file"
        return 1
    fi

    grep -q ".codex-plugin/plugin.json must declare mcpServers" "$out_file"
}

test_valid_mcp_command_allows_install() {
    local tmp_dir out_file
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "python3"
    mkdir -p "$tmp_dir/home"

    run_install "$tmp_dir" "$out_file"

    test -f "$tmp_dir/home/.qoderwork/mcp.json"
    grep -q '"test-server"' "$tmp_dir/home/.qoderwork/mcp.json"
}

test_codex_mcp_plugin_is_registered_without_hooks() {
    local tmp_dir out_file config_file
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    config_file="$tmp_dir/home/.codex/config.toml"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "python3" "true" "./.mcp.json"
    mkdir -p "$tmp_dir/home/.codex"

    run_install "$tmp_dir" "$out_file" false true false

    test -f "$config_file"
    grep -q '\[plugins."test-plugin@test-marketplace"\]' "$config_file"
    grep -q 'enabled = true' "$config_file"
}

test_codex_permission_request_hook_uses_codex_event_key() {
    local tmp_dir out_file config_file
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    config_file="$tmp_dir/home/.codex/config.toml"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "python3" "true" "./.mcp.json"
    add_codex_hooks_to_plugin_repo "$tmp_dir/clone/repo"
    mkdir -p "$tmp_dir/home/.codex"

    run_install "$tmp_dir" "$out_file" false true false

    grep -Fq '[hooks.state."test-plugin@test-marketplace:hooks/codex-hooks.json:permission_request:0:0"]' "$config_file"
    grep -Fq '[hooks.state."test-plugin@test-marketplace:hooks/codex-hooks.json:pre_tool_use:0:0"]' "$config_file"
    if grep -Fq 'hooks/codex-hooks.json:permissionrequest:0:0' "$config_file"; then
        echo "expected PermissionRequest to use permission_request, not permissionrequest"
        cat "$config_file"
        return 1
    fi
}

test_root_plugin_repo_installs_to_qoderwork() {
    local tmp_dir out_file
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_root_plugin_repo "$tmp_dir/clone/repo"
    mkdir -p "$tmp_dir/home"

    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/root-plugin.git" \
    MARKETPLACE_NAME="root-plugin" \
    CLONE_DIR="$tmp_dir/clone" \
    PLUGIN_FILTER="root-plugin" \
    WANT_CLAUDE="false" \
    WANT_CODEX="false" \
    WANT_QODERWORK="true" \
    bash "$ROOT_DIR/scripts/install.sh" install >"$out_file" 2>&1

    test -f "$tmp_dir/home/.qoderwork/plugins-custom/root-plugin/.claude-plugin/plugin.json"
    test -f "$tmp_dir/home/.qoderwork/plugins-custom/root-plugin/skills/root-plugin/SKILL.md"
    test -f "$tmp_dir/home/.qoderwork/plugins-custom/root-plugin/hooks/qoderwork-hooks.json"
    test ! -e "$tmp_dir/home/.qoderwork/plugins-custom/root-plugin/hooks/hooks.json"
    test ! -e "$tmp_dir/home/.qoderwork/plugins-custom/root-plugin/hooks/qoder-hooks.json"
}

test_claude_marketplace_is_updated_before_plugin_install() {
    local tmp_dir out_file fake_bin claude_log
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/install.out"
    fake_bin="$tmp_dir/bin"
    claude_log="$tmp_dir/claude.log"
    trap 'rm -rf "$tmp_dir"' RETURN

    make_plugin_repo "$tmp_dir/clone/repo" "python3"
    mkdir -p "$tmp_dir/home" "$fake_bin"
    mkdir -p "$tmp_dir/clone/repo/.claude-plugin"
    cat > "$tmp_dir/clone/repo/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "test-marketplace",
  "owner": { "name": "Test" },
  "plugins": [
    {
      "name": "test-plugin",
      "version": "1.0.0",
      "description": "Test plugin",
      "source": "./plugins/test-plugin"
    }
  ]
}
JSON

    cat > "$fake_bin/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLAUDE_LOG"
case "$*" in
  "plugin marketplace remove "*|"plugin marketplace add "*|"plugin marketplace update "*|"plugin install "*)
    exit 0
    ;;
esac
exit 1
SH
    chmod +x "$fake_bin/claude"

    PATH="$fake_bin:$PATH" \
    CLAUDE_LOG="$claude_log" \
    HOME="$tmp_dir/home" \
    REPO_URL="https://github.com/example/test-marketplace.git" \
    MARKETPLACE_NAME="test-marketplace" \
    CLONE_DIR="$tmp_dir/clone" \
    PLUGIN_FILTER="test-plugin" \
    WANT_CLAUDE="true" \
    WANT_CODEX="false" \
    WANT_QODERWORK="false" \
    bash "$ROOT_DIR/scripts/install.sh" install >"$out_file" 2>&1

    grep -Fxq "plugin marketplace remove test-marketplace" "$claude_log"
    grep -Fxq "plugin marketplace add $tmp_dir/home/.claude/plugins/cache/test-marketplace/.marketplace" "$claude_log"
    grep -Fxq "plugin marketplace update test-marketplace" "$claude_log"
    grep -Fxq "plugin install test-plugin@test-marketplace" "$claude_log"
    test -f "$tmp_dir/home/.claude/plugins/cache/test-marketplace/.marketplace/.claude-plugin/marketplace.json"
    test -f "$tmp_dir/home/.claude/plugins/cache/test-marketplace/.marketplace/plugins/test-plugin/.claude-plugin/plugin.json"

    if [[ "$(grep -n "plugin marketplace update test-marketplace" "$claude_log" | cut -d: -f1)" -gt "$(grep -n "plugin install test-plugin@test-marketplace" "$claude_log" | cut -d: -f1)" ]]; then
        echo "expected marketplace update before plugin install"
        cat "$claude_log"
        return 1
    fi
}

test_qoderwork_uninstall_handles_empty_mcp_keys() {
    local tmp_dir out_file
    tmp_dir="$(mktemp -d)"
    out_file="$tmp_dir/uninstall.out"
    trap 'rm -rf "$tmp_dir"' RETURN

    mkdir -p "$tmp_dir/home/.qoderwork/plugins-custom/agent-notch/.claude-plugin"
    cat > "$tmp_dir/home/.qoderwork/plugins-custom/agent-notch/.openplugin-meta.json" <<'JSON'
{
  "marketplace": "opennotch",
  "mcp_keys": []
}
JSON
    cat > "$tmp_dir/home/.qoderwork/plugins-custom/agent-notch/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "agent-notch",
  "repository": "git@gitlab.alibaba-inc.com:subo.jzc/opennotch.git"
}
JSON
    cat > "$tmp_dir/home/.qoderwork/settings.json" <<'JSON'
{
  "hooks": {}
}
JSON

    HOME="$tmp_dir/home" \
    REPO_URL="git@gitlab.alibaba-inc.com:subo.jzc/opennotch.git" \
    MARKETPLACE_NAME="opennotch" \
    WANT_CLAUDE=false \
    WANT_CODEX=false \
    WANT_QODERWORK=true \
    bash "$ROOT_DIR/scripts/install.sh" uninstall >"$out_file" 2>&1

    test ! -d "$tmp_dir/home/.qoderwork/plugins-custom/agent-notch"
}

test_missing_mcp_command_blocks_install
test_missing_absolute_mcp_command_blocks_install
test_codex_manifest_must_reference_mcp_config
test_valid_mcp_command_allows_install
test_codex_mcp_plugin_is_registered_without_hooks
test_codex_permission_request_hook_uses_codex_event_key
test_root_plugin_repo_installs_to_qoderwork
test_claude_marketplace_is_updated_before_plugin_install
test_qoderwork_uninstall_handles_empty_mcp_keys
test_github_tarball_download_uses_default_branch
echo "mcp-preflight tests passed"
