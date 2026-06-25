#!/bin/bash
# openplugin installer — generic plugin discovery + per-client installation
# Supports: Claude Code, Codex CLI, QoderWork
set -euo pipefail

# ─── Environment (set by cli.js) ─────────────────────────────────────
REPO_URL="${REPO_URL:?REPO_URL is required}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:?MARKETPLACE_NAME is required}"
PLUGIN_FILTER="${PLUGIN_FILTER:-}"
WANT_CLAUDE="${WANT_CLAUDE:-false}"
WANT_CODEX="${WANT_CODEX:-false}"
WANT_QODERWORK="${WANT_QODERWORK:-false}"

# ─── Colors ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()   { echo -e "${BLUE}[info]${NC}  $*"; }
ok()     { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()   { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()    { echo -e "${RED}[error]${NC} $*" >&2; }
banner() { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

# ─── Parse command ────────────────────────────────────────────────────
COMMAND="${1:?Usage: install.sh <discover|install|uninstall>}"

# ─── Dependency check (per command) ──────────────────────────────────
check_deps() {
    local missing=""
    for cmd in "$@"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing="$missing $cmd"
        fi
    done
    if [[ -n "$missing" ]]; then
        echo -e "${RED}[error]${NC} Missing required dependencies:${missing}" >&2
        echo "" >&2
        echo "  Install them with:" >&2
        if [[ "$(uname)" == "Darwin" ]]; then
            echo "    brew install${missing}" >&2
        elif command -v apt-get >/dev/null 2>&1; then
            echo "    sudo apt-get install -y${missing}" >&2
        elif command -v yum >/dev/null 2>&1; then
            echo "    sudo yum install -y${missing}" >&2
        else
            echo "    Use your package manager to install:${missing}" >&2
        fi
        exit 1
    fi
}

case "$COMMAND" in
    discover)       check_deps git python3 ;;
    install)        check_deps git python3 rsync ;;
    uninstall)      check_deps python3 ;;
esac

# ─── Client detection ────────────────────────────────────────────────
has_claude()     { command -v claude >/dev/null 2>&1; }
has_codex()      { [[ -d "${HOME}/.codex" ]]; }
has_qoderwork()  { [[ -d "${HOME}/.qoderwork" ]]; }

# ─── Repo clone / dev-mode detection ─────────────────────────────────
REPO_DIR=""
TMPDIR_CREATED=""

clone_repo() {
    # If caller already cloned for us, reuse it
    if [[ -n "${CLONE_DIR:-}" && -d "$CLONE_DIR/repo" ]]; then
        REPO_DIR="$CLONE_DIR/repo"
        info "Using cached clone: ${REPO_DIR}" >&2
        return
    fi

    # Dev mode: if this script is inside the repo, use local files
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local local_repo
    local_repo="$(cd "$script_dir/../.." 2>/dev/null && pwd)"

    if [[ -d "$local_repo/plugins" ]]; then
        local found_plugin=false
        for d in "$local_repo/plugins"/*/; do
            if [[ -f "$d/.claude-plugin/plugin.json" ]]; then
                found_plugin=true
                break
            fi
        done
        if [[ "$found_plugin" == "true" ]]; then
            REPO_DIR="$local_repo"
            info "Using local plugin source: ${REPO_DIR}/plugins/" >&2
            return
        fi
    fi

    # Download into CLONE_DIR if provided, otherwise create a temp dir
    local target="${CLONE_DIR:-}"
    if [[ -z "$target" ]]; then
        TMPDIR_CREATED="$(mktemp -d)"
        target="$TMPDIR_CREATED"
    fi

    # Use GitHub tarballs for faster download, resolving the default branch first.
    local repo_https="${REPO_URL%.git}"

    if [[ "$repo_https" == https://github.com/* ]] && command -v curl >/dev/null 2>&1; then
        if download_github_tarball "$repo_https" "$target"; then
            return
        fi
        warn "GitHub tarball download failed; falling back to git clone." >&2
    fi

    info "Cloning ${REPO_URL} ..." >&2
    rm -rf "$target/repo"
    git clone --depth 1 --quiet "$REPO_URL" "$target/repo"
    REPO_DIR="$target/repo"
    ok "Cloned to ${REPO_DIR}" >&2
}

cleanup_tmp() {
    if [[ -n "$TMPDIR_CREATED" && -d "$TMPDIR_CREATED" ]]; then
        rm -rf "$TMPDIR_CREATED"
    fi
}
trap cleanup_tmp EXIT

github_default_branch() {
    git ls-remote --symref "$REPO_URL" HEAD 2>/dev/null \
        | awk '/^ref:/ { sub("refs/heads/", "", $2); print $2; exit }'
}

download_github_tarball() {
    local repo_https="$1" target="$2"
    local default_branch archive tarball_url

    default_branch="$(github_default_branch || true)"
    if [[ -z "$default_branch" ]]; then
        return 1
    fi

    tarball_url="${repo_https}/archive/refs/heads/${default_branch}.tar.gz"
    archive="$(mktemp)"
    info "Downloading ${repo_https} (${default_branch}) ..." >&2
    mkdir -p "$target/repo"

    if ! curl -fsSL "$tarball_url" -o "$archive"; then
        rm -f "$archive"
        rm -rf "$target/repo"
        return 1
    fi

    if ! tar tzf "$archive" >/dev/null 2>&1; then
        rm -f "$archive"
        rm -rf "$target/repo"
        return 1
    fi

    tar xzf "$archive" --strip-components=1 -C "$target/repo"
    rm -f "$archive"
    REPO_DIR="$target/repo"
    ok "Downloaded to ${REPO_DIR}" >&2
    return 0
}

# ─── Plugin discovery ─────────────────────────────────────────────────
# Scans plugins/*/.claude-plugin/plugin.json and root-level plugin repos.
# Outputs JSON array to stdout: [{"name":"...","description":"...","version":"..."}]
discover_plugins() {
    python3 - "$REPO_DIR" <<'PYEOF'
import json, sys, os

repo_dir = sys.argv[1]
plugins_dir = os.path.join(repo_dir, "plugins")
result = []

def add_manifest(pjson, fallback_name):
    try:
        with open(pjson) as f:
            data = json.load(f)
        name = data.get("name", fallback_name)
        import re
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', name):
            print(f"Skipping plugin with unsafe name: {name!r}", file=sys.stderr)
            return
        if any(item["name"] == name for item in result):
            return
        result.append({
            "name": name,
            "description": data.get("description", ""),
            "version": data.get("version", "1.0.0"),
        })
    except (json.JSONDecodeError, IOError):
        return

root_manifest = os.path.join(repo_dir, ".claude-plugin", "plugin.json")
if os.path.isfile(root_manifest):
    add_manifest(root_manifest, os.path.basename(repo_dir))

if os.path.isdir(plugins_dir):
    for entry in sorted(os.listdir(plugins_dir)):
        pjson = os.path.join(plugins_dir, entry, ".claude-plugin", "plugin.json")
        if os.path.isfile(pjson):
            add_manifest(pjson, entry)

print(json.dumps(result))
PYEOF
}

plugin_manifest_name() {
    local manifest="$1" fallback="$2"
    python3 - "$manifest" "$fallback" <<'PYEOF'
import json, sys
manifest, fallback = sys.argv[1:]
try:
    with open(manifest) as f:
        print(json.load(f).get("name", fallback))
except Exception:
    print(fallback)
PYEOF
}

plugin_source_path() {
    local plugin_name="$1"
    local nested="$REPO_DIR/plugins/$plugin_name"
    if [[ -f "$nested/.claude-plugin/plugin.json" ]]; then
        printf '%s\n' "$nested"
        return 0
    fi

    local root_manifest="$REPO_DIR/.claude-plugin/plugin.json"
    if [[ -f "$root_manifest" ]]; then
        local root_name
        root_name="$(plugin_manifest_name "$root_manifest" "$(basename "$REPO_DIR")")"
        if [[ "$root_name" == "$plugin_name" ]]; then
            printf '%s\n' "$REPO_DIR"
            return 0
        fi
    fi

    return 1
}

# Filter discovered plugins by PLUGIN_FILTER (comma-separated names)
filter_plugins() {
    local all_json="$1"
    if [[ -z "$PLUGIN_FILTER" ]]; then
        echo "$all_json"
        return
    fi
    python3 -c "
import json, sys
plugins = json.loads(sys.argv[1])
allowed = set(sys.argv[2].split(','))
print(json.dumps([p for p in plugins if p['name'] in allowed]))
" "$all_json" "$PLUGIN_FILTER"
}

# Read version from a plugin directory (reads path from argv, not interpolated)
get_version() {
    local plugin_src="$1"
    python3 - "$plugin_src/.claude-plugin/plugin.json" <<'PYEOF' 2>/dev/null || echo "1.0.0"
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("version", "1.0.0"))
PYEOF
}

validate_plugin_mcp_config() {
    local plugin_name="$1" plugin_src="$2"

    [[ -f "$plugin_src/.mcp.json" ]] || return 0

    info "  Checking MCP config for ${plugin_name}..."
    python3 - "$plugin_src" "$plugin_name" "$WANT_CLAUDE" "$WANT_CODEX" <<'PYEOF'
import json
import os
import shutil
import sys
from urllib.parse import urlparse

plugin_src, plugin_name, want_claude, want_codex = sys.argv[1:]
mcp_path = os.path.join(plugin_src, ".mcp.json")
errors = []

def load_json(path, label):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        errors.append(f"{label} not found: {path}")
    except json.JSONDecodeError as exc:
        errors.append(f"{label} is invalid JSON: {path}:{exc.lineno}:{exc.colno} {exc.msg}")
    except OSError as exc:
        errors.append(f"failed to read {label}: {path}: {exc}")
    return None

def describe_server(server_name):
    return f"{plugin_name}/.mcp.json mcpServers.{server_name}"

def check_command(server_name, command):
    label = describe_server(server_name)
    if not isinstance(command, str) or not command.strip():
        errors.append(f"{label}.command must be a non-empty string")
        return

    command = command.strip()
    expanded = os.path.expanduser(command)

    if os.path.sep in expanded:
        command_path = expanded
        if not os.path.isabs(command_path):
            command_path = os.path.join(plugin_src, command_path)
        if not os.path.exists(command_path):
            errors.append(f"{label}.command path does not exist: {command}")
            return
        if not os.access(command_path, os.X_OK):
            errors.append(f"{label}.command is not executable: {command}")
            return
        return

    if shutil.which(command) is None:
        hint = ""
        if command == "uvx":
            hint = " Install uv first, for example: curl -LsSf https://astral.sh/uv/install.sh | sh"
        elif command == "npx":
            hint = " Install Node.js/npm so npx is available."
        errors.append(f"{label}.command is not available on PATH: {command}.{hint}")

def check_url(server_name, url):
    label = describe_server(server_name)
    if not isinstance(url, str) or not url.strip():
        errors.append(f"{label}.url must be a non-empty string")
        return
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        errors.append(f"{label}.url must be an http(s) URL: {url}")

def check_cwd(server_name, cwd):
    label = describe_server(server_name)
    if not isinstance(cwd, str) or not cwd.strip():
        errors.append(f"{label}.cwd must be a non-empty string when set")
        return
    expanded = os.path.expanduser(cwd)
    if not os.path.isabs(expanded):
        expanded = os.path.join(plugin_src, expanded)
    if not os.path.isdir(expanded):
        errors.append(f"{label}.cwd directory does not exist: {cwd}")

data = load_json(mcp_path, ".mcp.json")
if data is not None:
    servers = data.get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        errors.append(f"{plugin_name}/.mcp.json must contain a non-empty mcpServers object")
    else:
        for server_name, server in servers.items():
            if not isinstance(server_name, str) or not server_name.strip():
                errors.append(f"{plugin_name}/.mcp.json contains an empty MCP server name")
                continue
            label = describe_server(server_name)
            if not isinstance(server, dict):
                errors.append(f"{label} must be an object")
                continue

            has_command = "command" in server
            has_url = "url" in server
            if has_command:
                check_command(server_name, server.get("command"))
            if has_url:
                check_url(server_name, server.get("url"))
            if not has_command and not has_url:
                errors.append(f"{label} must set either command for stdio or url for HTTP transport")

            args = server.get("args")
            if args is not None and not isinstance(args, list):
                errors.append(f"{label}.args must be an array when set")

            env = server.get("env")
            if env is not None and not isinstance(env, dict):
                errors.append(f"{label}.env must be an object when set")

            cwd = server.get("cwd")
            if cwd is not None:
                check_cwd(server_name, cwd)

if want_claude == "true":
    claude_manifest = os.path.join(plugin_src, ".claude-plugin", "plugin.json")
    if not os.path.isfile(claude_manifest):
        errors.append(f"{plugin_name} has .mcp.json but no .claude-plugin/plugin.json for Claude Code")

if want_codex == "true":
    codex_manifest = os.path.join(plugin_src, ".codex-plugin", "plugin.json")
    manifest = load_json(codex_manifest, ".codex-plugin/plugin.json")
    if manifest is not None:
        mcp_ref = manifest.get("mcpServers")
        if mcp_ref is None:
            errors.append(f"{plugin_name}/.codex-plugin/plugin.json must declare mcpServers so Codex loads .mcp.json")
        elif isinstance(mcp_ref, str):
            ref_path = os.path.join(plugin_src, mcp_ref)
            if not os.path.isfile(ref_path):
                errors.append(f"{plugin_name}/.codex-plugin/plugin.json mcpServers path does not exist: {mcp_ref}")
        elif isinstance(mcp_ref, dict):
            if not mcp_ref:
                errors.append(f"{plugin_name}/.codex-plugin/plugin.json mcpServers object must not be empty")
        else:
            errors.append(f"{plugin_name}/.codex-plugin/plugin.json mcpServers must be a string path or object")

if errors:
    print("[error] MCP preflight failed:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# ─────────────────────────────────────────────────────────────────────
#  PER-PLUGIN INSTALL FUNCTIONS
# ─────────────────────────────────────────────────────────────────────

install_plugin_to_claude() {
    local plugin_name="$1" plugin_src="$2" version="$3"

    local dest="${HOME}/.claude/plugins/cache/${MARKETPLACE_NAME}/${plugin_name}/${version}"
    mkdir -p "$dest"

    info "  Copying ${plugin_name} → ${dest}"
    rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        "$plugin_src/" "$dest/"

    info "  Registering ${plugin_name}..."
    if ! claude plugin install "${plugin_name}@${MARKETPLACE_NAME}"; then
        err "Claude Code failed to install ${plugin_name}@${MARKETPLACE_NAME}."
        err "Check that the marketplace has .claude-plugin/marketplace.json and lists ${plugin_name}."
        return 1
    fi

    # Claude may normalize SemVer build metadata in cache paths. Re-copy into
    # the actual installPath recorded by Claude so openplugin's selected source
    # is the version that runs.
    local actual_dest
    actual_dest=$(python3 - "${plugin_name}@${MARKETPLACE_NAME}" <<'PYEOF' 2>/dev/null || true
import json, os, sys

key = sys.argv[1]
path = os.path.expanduser("~/.claude/plugins/installed_plugins.json")
try:
    with open(path) as f:
        data = json.load(f)
    entries = data.get("plugins", {}).get(key, [])
    if entries:
        print(entries[-1].get("installPath", ""))
except Exception:
    pass
PYEOF
)
    [[ -n "$actual_dest" ]] && dest="$actual_dest"
    mkdir -p "$dest"

    # Re-copy after registration (claude plugin install may modify files)
    rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        "$plugin_src/" "$dest/"

    ok "  ${plugin_name} (v${version}) → Claude Code"
}

prepare_claude_marketplace_cache() {
    local dest="${HOME}/.claude/plugins/cache/${MARKETPLACE_NAME}/.marketplace"
    mkdir -p "$dest"
    rsync -a --delete \
        --exclude '.git' \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        "$REPO_DIR/" "$dest/"
    printf '%s\n' "$dest"
}

install_plugin_to_codex() {
    local plugin_name="$1" plugin_src="$2" version="$3"

    local dest="${HOME}/.codex/plugins/cache/${MARKETPLACE_NAME}/${plugin_name}/${version}"
    mkdir -p "$dest"

    info "  Copying ${plugin_name} → ${dest}"
    rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        "$plugin_src/" "$dest/"

    # Register plugin and, when present, built-in Codex hook trust state.
    local hooks_json="$dest/hooks/codex-hooks.json"
    local config="${HOME}/.codex/config.toml"
    mkdir -p "$(dirname "$config")"
    [[ -f "$config" ]] || printf '' > "$config"

    # Backup
    local ts
    ts=$(date +%s).$$
    cp "$config" "$config.bak.$ts"
    info "  Backup: $config.bak.$ts"

    local hooks_arg=""
    if [[ -f "$hooks_json" ]]; then
        hooks_arg="$hooks_json"
        info "  Registering ${plugin_name} and enabling hooks..."
    else
        info "  Registering ${plugin_name}..."
    fi

    python3 - "$config" "$hooks_arg" "$MARKETPLACE_NAME" "$plugin_name" <<'PYEOF'
import hashlib, json, re, sys

config_path, hooks_path, marketplace, plugin_name = sys.argv[1:]

with open(config_path) as f:
    text = f.read()

# --- Helper: upsert a [section] with key=value pairs (idempotent) ---
def upsert_section(text, header, kv_pairs):
    pat = re.compile(rf'(\[{re.escape(header)}\][ \t]*\n)(.*?)(?=^\[|\Z)', re.S | re.M)
    m = pat.search(text)
    if m:
        body = m.group(2)
        for k, _ in kv_pairs:
            body = re.sub(rf'(?m)^{re.escape(k)}\s*=.*\n?', '', body)
        body = body.rstrip()
        addition = "".join(f"{k} = {v}\n" for k, v in kv_pairs)
        new_body = (body + "\n" if body else "") + addition
        return text[:m.start(2)] + new_body + text[m.end(2):]
    sep = "" if text.endswith("\n") or text == "" else "\n"
    body = "".join(f"{k} = {v}\n" for k, v in kv_pairs)
    return text + f"{sep}[{header}]\n{body}"

# Register plugin
text = upsert_section(text, f'plugins."{plugin_name}@{marketplace}"', [("enabled", "true")])

if hooks_path:
    # Enable feature flags
    text = upsert_section(text, "features", [("hooks", "true"), ("plugin_hooks", "true")])

    # Event name mapping (PascalCase → snake_case as Codex expects)
    EVENT_MAP = {
        "PermissionRequest": "permission_request",
        "PreToolUse": "pre_tool_use",
        "PostToolUse": "post_tool_use",
        "UserPromptSubmit": "user_prompt_submit",
        "SessionStart": "session_start",
        "Stop": "stop",
        "StopFailure": "stop_failure",
    }

    # Compute trust hashes for each hook command
    with open(hooks_path) as f:
        hooks = json.load(f)
    for evt_name, groups in hooks.get("hooks", {}).items():
        snake = EVENT_MAP.get(evt_name, evt_name.lower())
        for i, group in enumerate(groups or []):
            for j, h in enumerate(group.get("hooks") or []):
                cmd = h.get("command", "")
                if not cmd:
                    continue
                digest = "sha256:" + hashlib.sha256(cmd.encode("utf-8")).hexdigest()
                section = f'hooks.state."{plugin_name}@{marketplace}:hooks/codex-hooks.json:{snake}:{i}:{j}"'
                text = upsert_section(text, section, [
                    ("enabled", "true"),
                    ("trusted_hash", f'"{digest}"'),
                ])

with open(config_path, "w") as f:
    f.write(text)
print(f"  Updated: {config_path}")
PYEOF

    ok "  ${plugin_name} (v${version}) → Codex CLI"
}

install_plugin_to_qoderwork() {
    local plugin_name="$1" plugin_src="$2"

    local dest="${HOME}/.qoderwork/plugins-custom/${plugin_name}"
    mkdir -p "$dest"

    info "  Copying ${plugin_name} → ${dest}"
    rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        --exclude '.openplugin-meta.json' \
        "$plugin_src/" "$dest/"

    # Built-in QoderWork hook registration (no external script needed)
    local hooks_json="$dest/hooks/qoderwork-hooks.json"
    if [[ -f "$hooks_json" ]]; then
        local settings="${HOME}/.qoderwork/settings.json"
        mkdir -p "$(dirname "$settings")"

        if [[ -f "$settings" ]]; then
            local ts
            ts=$(date +%s).$$
            cp "$settings" "$settings.bak.$ts"
            info "  Backup: $settings.bak.$ts"
        else
            echo '{}' > "$settings"
        fi

        info "  Enabling hooks for ${plugin_name}..."
        python3 - "$settings" "$hooks_json" "$dest" "${plugin_name}/" <<'PYEOF'
import json, sys

settings_path, hooks_path, plugin_root, name_prefix = sys.argv[1:]

with open(settings_path) as f:
    text = f.read().strip() or "{}"
settings = json.loads(text)

with open(hooks_path) as f:
    template = json.load(f)
escaped_root = json.dumps(plugin_root)[1:-1]
template_str = json.dumps(template).replace("__PLUGIN_ROOT__", escaped_root)
template = json.loads(template_str)

settings.setdefault("hooks", {})
hooks_root = settings["hooks"]

plugin_name = name_prefix.rstrip("/")

def owned(h):
    if not isinstance(h, dict):
        return False
    name = h.get("name")
    if isinstance(name, str) and name.startswith(name_prefix):
        return True
    command = h.get("command")
    if not isinstance(command, str):
        return False
    return (
        plugin_root in command
        or f"/plugins-custom/{plugin_name}/" in command
        or f"{plugin_name}/hooks/scripts/" in command
    )

for event, new_groups in template.get("hooks", {}).items():
    existing = hooks_root.get(event)
    if not isinstance(existing, list):
        existing = []
    pruned = []
    for grp in existing:
        if not isinstance(grp, dict):
            pruned.append(grp); continue
        inner = grp.get("hooks") or []
        kept = [h for h in inner if not owned(h)]
        if kept:
            new_grp = dict(grp)
            new_grp["hooks"] = kept
            pruned.append(new_grp)
    pruned.extend(new_groups)
    hooks_root[event] = pruned

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(f"  Updated: {settings_path}")
PYEOF
    fi

    # Merge MCP entries from plugin's .mcp.json into ~/.qoderwork/mcp.json
    # (QoderWork wrapper mode: only reads global mcp.json, won't discover plugin .mcp.json)
    local mcp_keys=""
    if [[ -f "$plugin_src/.mcp.json" ]]; then
        local mcp_config="${HOME}/.qoderwork/mcp.json"

        # Backup mcp.json before modifying
        if [[ -f "$mcp_config" ]]; then
            local mcp_ts
            mcp_ts=$(date +%s).$$
            cp "$mcp_config" "$mcp_config.bak.$mcp_ts"
            info "  Backup: $mcp_config.bak.$mcp_ts"
        fi

        info "  Configuring MCP for ${plugin_name}..."
        mcp_keys=$(python3 - "${mcp_config}" "$plugin_src/.mcp.json" <<'PYEOF'
import json, sys, os

target_path, source_path = sys.argv[1:]

if os.path.isfile(target_path):
    with open(target_path) as f:
        config = json.load(f)
else:
    config = {"mcpServers": {}}

config.setdefault("mcpServers", {})

with open(source_path) as f:
    source = json.load(f)

keys = []
for name, server in source.get("mcpServers", {}).items():
    if name in config["mcpServers"] and config["mcpServers"][name] != server:
        print(f"Updating existing MCP server: {name}", file=sys.stderr)
    config["mcpServers"][name] = server
    keys.append(name)

with open(target_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")

print(",".join(keys))
PYEOF
)
    fi

    # Write metadata for clean uninstall (records marketplace + MCP keys)
    python3 - "$dest/.openplugin-meta.json" "$MARKETPLACE_NAME" "$mcp_keys" <<'PYEOF'
import json, sys
path, marketplace, mcp_keys_str = sys.argv[1:]
meta = {
    "marketplace": marketplace,
    "mcp_keys": [k for k in mcp_keys_str.split(",") if k],
}
with open(path, "w") as f:
    json.dump(meta, f, indent=2)
    f.write("\n")
PYEOF

    ok "  ${plugin_name} → QoderWork"
}

# ─────────────────────────────────────────────────────────────────────
#  UNINSTALL
# ─────────────────────────────────────────────────────────────────────

uninstall_claude() {
    banner "Claude Code — uninstall"

    if ! has_claude; then
        warn "claude CLI not found — skipping."
        return
    fi

    # Discover installed plugins by scanning cache directory
    local cache_dir="${HOME}/.claude/plugins/cache/${MARKETPLACE_NAME}"
    if [[ -d "$cache_dir" ]]; then
        for plugin_dir in "$cache_dir"/*/; do
            local pname
            pname="$(basename "$plugin_dir")"
            info "Uninstalling ${pname}..."
            claude plugin uninstall "${pname}@${MARKETPLACE_NAME}" 2>/dev/null || true
        done
        rm -rf "$cache_dir"
        ok "Removed plugin cache: ${cache_dir}"
    else
        info "No plugins found for ${MARKETPLACE_NAME}."
    fi

    info "Removing marketplace..."
    claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null || true

    ok "Claude Code: fully removed."
}

uninstall_codex() {
    banner "Codex CLI — uninstall"

    local cache_dir="${HOME}/.codex/plugins/cache/${MARKETPLACE_NAME}"
    if [[ -d "$cache_dir" ]]; then
        rm -rf "$cache_dir"
        ok "Removed ${cache_dir}"
    else
        info "Plugin files not found (not installed)."
    fi

    local config="${HOME}/.codex/config.toml"
    if [[ -f "$config" ]]; then
        info "Cleaning config.toml..."
        python3 - "$config" "$MARKETPLACE_NAME" <<'PYEOF'
import re, sys

path, marketplace = sys.argv[1:]
with open(path) as f:
    text = f.read()

esc = re.escape(marketplace)
patterns = [
    rf'\[hooks\.state\."(?:[^"]*@)?{esc}:hooks/[^"]*"\]\s*\n(?:(?!\[)[^\n]*\n)*',
    rf'\[plugins\."[^"]*@{esc}"[^\]]*\]\s*\n(?:(?!\[)[^\n]*\n)*',
    rf'\[marketplaces\.{esc}\]\s*\n(?:(?!\[)[^\n]*\n)*',
]

original = text
for pat in patterns:
    text = re.sub(pat, '', text)

text = re.sub(r'\n{3,}', '\n\n', text)

if text != original:
    with open(path, 'w') as f:
        f.write(text)
    print(f"Updated: {path}")
else:
    print("No entries to remove.")
PYEOF
    fi

    ok "Codex: fully removed."
}

uninstall_qoderwork() {
    banner "QoderWork — uninstall"

    # Scan plugins-custom: collect metadata BEFORE deleting
    local custom_dir="${HOME}/.qoderwork/plugins-custom"
    local removed_any=false
    local plugin_prefixes=()
    local all_mcp_keys=()

    if [[ -d "$custom_dir" ]]; then
        for plugin_dir in "$custom_dir"/*/; do
            [[ -d "$plugin_dir" ]] || continue
            local pname
            pname="$(basename "$plugin_dir")"

            # Match by .openplugin-meta.json (preferred) or fallback to plugin.json
            local meta="$plugin_dir/.openplugin-meta.json"
            local matched=false

            if [[ -f "$meta" ]]; then
                local meta_match
                meta_match=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    if d.get('marketplace') == sys.argv[2]:
        print(','.join(d.get('mcp_keys', [])))
    else:
        print('__NO_MATCH__')
except Exception: print('__NO_MATCH__')
" "$meta" "$MARKETPLACE_NAME" 2>/dev/null || echo "__NO_MATCH__")
                if [[ "$meta_match" != "__NO_MATCH__" ]]; then
                    matched=true
                    # Collect MCP keys from metadata
                    IFS=',' read -ra keys <<< "$meta_match"
                    for k in "${keys[@]}"; do
                        [[ -n "$k" ]] && all_mcp_keys+=("$k")
                    done
                fi
            fi

            # Fallback: match by plugin.json repository/homepage
            if [[ "$matched" == "false" ]]; then
                local pjson="$plugin_dir/.claude-plugin/plugin.json"
                if [[ -f "$pjson" ]]; then
                    local repo_match
                    repo_match=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    repo = d.get('repository','') or d.get('homepage','')
    print('yes' if sys.argv[2] in repo else 'no')
except Exception: print('no')
" "$pjson" "$MARKETPLACE_NAME" 2>/dev/null || echo "no")
                    if [[ "$repo_match" == "yes" ]]; then
                        matched=true
                        # Try to read MCP keys from .mcp.json before deletion
                        if [[ -f "$plugin_dir/.mcp.json" ]]; then
                            local fallback_keys
                            fallback_keys=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(','.join(d.get('mcpServers', {}).keys()))
except Exception: pass
" "$plugin_dir/.mcp.json" 2>/dev/null || true)
                            IFS=',' read -ra keys <<< "$fallback_keys"
                            for k in "${keys[@]}"; do
                                [[ -n "$k" ]] && all_mcp_keys+=("$k")
                            done
                        fi
                    fi
                fi
            fi

            if [[ "$matched" == "true" ]]; then
                rm -rf "$plugin_dir"
                ok "Removed ${plugin_dir}"
                plugin_prefixes+=("${pname}/")
                removed_any=true
            fi
        done
    fi

    if [[ "$removed_any" == "false" ]]; then
        info "No plugins found for ${MARKETPLACE_NAME}."
    fi

    # Remove hooks from settings.json
    local settings="${HOME}/.qoderwork/settings.json"
    if [[ -f "$settings" && ${#plugin_prefixes[@]} -gt 0 ]]; then
        info "Removing hooks from settings.json..."
        local prefixes_json
        prefixes_json=$(printf '%s\n' "${plugin_prefixes[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))")
        python3 - "$settings" "$prefixes_json" <<'PYEOF'
import json, sys

path, prefixes_json = sys.argv[1:]
prefixes = json.loads(prefixes_json)

with open(path) as f:
    settings = json.load(f)

hooks = settings.get("hooks", {})
if not isinstance(hooks, dict):
    sys.exit(0)

changed = False
for event, groups in list(hooks.items()):
    if not isinstance(groups, list):
        continue
    pruned = []
    for grp in groups:
        if not isinstance(grp, dict):
            pruned.append(grp)
            continue
        inner = grp.get("hooks") or []
        kept = [h for h in inner
                if not (isinstance(h, dict) and isinstance(h.get("name"), str)
                        and any(h["name"].startswith(p) for p in prefixes))]
        if kept:
            new_grp = dict(grp)
            new_grp["hooks"] = kept
            pruned.append(new_grp)
        else:
            changed = True
    if pruned != groups:
        changed = True
    if pruned:
        hooks[event] = pruned
    else:
        del hooks[event]
        changed = True

if changed:
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"Updated: {path}")
else:
    print("No hooks to remove.")
PYEOF
    fi

    # Remove MCP entries by exact keys (collected from metadata before deletion)
    local mcp_config="${HOME}/.qoderwork/mcp.json"
    if [[ -f "$mcp_config" && ${#all_mcp_keys[@]} -gt 0 ]]; then
        info "Removing MCP server entries..."
        local keys_json
        keys_json=$(printf '%s\n' "${all_mcp_keys[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
        python3 - "$mcp_config" "$keys_json" <<'PYEOF'
import json, sys

path, keys_json = sys.argv[1:]
keys = json.loads(keys_json)

with open(path) as f:
    config = json.load(f)

servers = config.get("mcpServers", {})
removed = [k for k in keys if k in servers]
for k in removed:
    del servers[k]

if removed:
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    print(f"Removed {len(removed)} MCP entries: {', '.join(removed)}")
else:
    print("No MCP entries to remove.")
PYEOF
    fi

    ok "QoderWork: uninstalled. Restart QoderWork to apply."
}

# ─────────────────────────────────────────────────────────────────────
#  TELEMETRY OPT-IN FILE MANAGEMENT
# ─────────────────────────────────────────────────────────────────────

OPTIN_FILE="${HOME}/.config/alibabacloud/telemetry-optin"

manage_telemetry_optin() {
    local optin="${TELEMETRY_OPTIN:-}"
    [[ -n "$optin" ]] || return 0

    if [[ "$optin" == "true" ]]; then
        mkdir -p "$(dirname "$OPTIN_FILE")"
        touch "$OPTIN_FILE"
        ok "Telemetry opt-in authorized. Marker: ${OPTIN_FILE}"
    else
        rm -f "$OPTIN_FILE"
        info "Telemetry opt-in declined. Opt-in fields will not be collected."
    fi
}

remove_telemetry_optin() {
    if [[ -f "$OPTIN_FILE" ]]; then
        rm -f "$OPTIN_FILE"
        ok "Removed telemetry opt-in marker: ${OPTIN_FILE}"
    fi
}

# ─────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────

case "$COMMAND" in
    discover)
        clone_repo
        discover_plugins
        ;;

    install)
        clone_repo

        # Get all plugins, then filter
        ALL_PLUGINS_JSON=$(discover_plugins)
        PLUGINS_JSON=$(filter_plugins "$ALL_PLUGINS_JSON")

        # Parse plugin names into array
        PLUGIN_NAMES=()
        while IFS= read -r name; do
            [[ -n "$name" ]] && PLUGIN_NAMES+=("$name")
        done < <(echo "$PLUGINS_JSON" | python3 -c "import json,sys; [print(p['name']) for p in json.loads(sys.stdin.read())]")

        if [[ ${#PLUGIN_NAMES[@]} -eq 0 ]]; then
            err "No plugins to install."
            exit 1
        fi

        banner "Installing ${#PLUGIN_NAMES[@]} plugin(s) from ${MARKETPLACE_NAME}"
        info "Plugins: ${PLUGIN_NAMES[*]}"
        info "Targets: $(
            [[ "$WANT_CLAUDE" == "true" ]]    && printf 'Claude Code  '
            [[ "$WANT_CODEX" == "true" ]]     && printf 'Codex  '
            [[ "$WANT_QODERWORK" == "true" ]] && printf 'QoderWork'
        )"

        # Claude: register and refresh marketplace once. Claude keeps a local
        # marketplace cache, so an existing marketplace must be updated before
        # installing newly added plugins such as agent-notch.
        if [[ "$WANT_CLAUDE" == "true" ]]; then
            if has_claude; then
                info "Registering marketplace..."
                claude_marketplace_source="$(prepare_claude_marketplace_cache)"
                claude plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
                claude plugin marketplace add "$claude_marketplace_source" 2>/dev/null || claude plugin marketplace add "$REPO_URL" 2>/dev/null || true
                claude plugin marketplace update "$MARKETPLACE_NAME" 2>/dev/null || true
            else
                warn "claude CLI not found — skipping Claude Code."
                WANT_CLAUDE=false
            fi
        fi

        # Install each plugin to each client
        for plugin_name in "${PLUGIN_NAMES[@]}"; do
            if ! local_src="$(plugin_source_path "$plugin_name")"; then
                err "Plugin source not found: ${plugin_name}"
                exit 1
            fi
            version=$(get_version "$local_src")

            banner "${plugin_name} (v${version})"
            validate_plugin_mcp_config "$plugin_name" "$local_src"

            [[ "$WANT_CLAUDE" == "true" ]]    && install_plugin_to_claude "$plugin_name" "$local_src" "$version"
            [[ "$WANT_CODEX" == "true" ]]     && install_plugin_to_codex "$plugin_name" "$local_src" "$version"
            [[ "$WANT_QODERWORK" == "true" ]] && install_plugin_to_qoderwork "$plugin_name" "$local_src"
        done

        # Manage telemetry opt-in file based on user consent
        manage_telemetry_optin

        banner "Done"
        ok "Installation complete. Restart your coding agent to activate."
        ;;

    uninstall)
        banner "Uninstalling plugins from ${MARKETPLACE_NAME}"

        [[ "$WANT_CLAUDE" == "true" ]]    && uninstall_claude
        [[ "$WANT_CODEX" == "true" ]]     && uninstall_codex
        [[ "$WANT_QODERWORK" == "true" ]] && uninstall_qoderwork

        # Clean up telemetry opt-in marker
        remove_telemetry_optin

        banner "Done"
        ok "Uninstallation complete."
        ;;

    *)
        err "Unknown command: $COMMAND"
        err "Usage: install.sh <discover|install|uninstall>"
        exit 1
        ;;
esac
