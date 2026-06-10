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
    if [[ -n "${CLONE_DIR:-}" && -d "$CLONE_DIR/repo/plugins" ]]; then
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

    # Convert git URL to GitHub tarball URL for faster download
    local tarball_url=""
    local repo_https="${REPO_URL%.git}"
    if [[ "$repo_https" == https://github.com/* ]]; then
        tarball_url="${repo_https}/archive/refs/heads/main.tar.gz"
    fi

    if [[ -n "$tarball_url" ]] && command -v curl >/dev/null 2>&1; then
        info "Downloading ${repo_https} ..." >&2
        mkdir -p "$target/repo"
        curl -sL "$tarball_url" | tar xz --strip-components=1 -C "$target/repo"
        REPO_DIR="$target/repo"
        ok "Downloaded to ${REPO_DIR}" >&2
    else
        info "Cloning ${REPO_URL} ..." >&2
        git clone --depth 1 --quiet "$REPO_URL" "$target/repo"
        REPO_DIR="$target/repo"
        ok "Cloned to ${REPO_DIR}" >&2
    fi
}

cleanup_tmp() {
    if [[ -n "$TMPDIR_CREATED" && -d "$TMPDIR_CREATED" ]]; then
        rm -rf "$TMPDIR_CREATED"
    fi
}
trap cleanup_tmp EXIT

# ─── Plugin discovery ─────────────────────────────────────────────────
# Scans plugins/*/.claude-plugin/plugin.json
# Outputs JSON array to stdout: [{"name":"...","description":"...","version":"..."}]
discover_plugins() {
    python3 - "$REPO_DIR" <<'PYEOF'
import json, sys, os

repo_dir = sys.argv[1]
plugins_dir = os.path.join(repo_dir, "plugins")
result = []

if not os.path.isdir(plugins_dir):
    print("[]")
    sys.exit(0)

for entry in sorted(os.listdir(plugins_dir)):
    pjson = os.path.join(plugins_dir, entry, ".claude-plugin", "plugin.json")
    if not os.path.isfile(pjson):
        continue
    try:
        with open(pjson) as f:
            data = json.load(f)
        name = data.get("name", entry)
        import re
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*$', name):
            print(f"Skipping plugin with unsafe name: {name!r}", file=sys.stderr)
            continue
        result.append({
            "name": name,
            "description": data.get("description", ""),
            "version": data.get("version", "1.0.0"),
        })
    except (json.JSONDecodeError, IOError):
        continue

print(json.dumps(result))
PYEOF
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
    claude plugin install "${plugin_name}@${MARKETPLACE_NAME}" 2>/dev/null || true

    # Re-copy after registration (claude plugin install may modify files)
    rsync -a --delete \
        --exclude '__pycache__' \
        --exclude '.DS_Store' \
        "$plugin_src/" "$dest/"

    ok "  ${plugin_name} (v${version}) → Claude Code"
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

    # Built-in Codex hook registration (no external script needed)
    local hooks_json="$dest/hooks/codex-hooks.json"
    if [[ -f "$hooks_json" ]]; then
        local config="${HOME}/.codex/config.toml"
        mkdir -p "$(dirname "$config")"
        [[ -f "$config" ]] || printf '' > "$config"

        # Backup
        local ts
        ts=$(date +%s).$$
        cp "$config" "$config.bak.$ts"
        info "  Backup: $config.bak.$ts"

        info "  Enabling hooks for ${plugin_name}..."
        python3 - "$config" "$hooks_json" "$MARKETPLACE_NAME" "$plugin_name" <<'PYEOF'
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

# Enable feature flags
text = upsert_section(text, "features", [("hooks", "true"), ("plugin_hooks", "true")])

# Register plugin
text = upsert_section(text, f'plugins."{plugin_name}@{marketplace}"', [("enabled", "true")])

# Event name mapping (PascalCase → snake_case as Codex expects)
EVENT_MAP = {
    "PreToolUse": "pre_tool_use",
    "PostToolUse": "post_tool_use",
    "UserPromptSubmit": "user_prompt_submit",
    "Stop": "stop",
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
            section = f'hooks.state."{marketplace}:hooks/codex-hooks.json:{snake}:{i}:{j}"'
            text = upsert_section(text, section, [
                ("enabled", "true"),
                ("trusted_hash", f'"{digest}"'),
            ])

with open(config_path, "w") as f:
    f.write(text)
print(f"  Updated: {config_path}")
PYEOF
    fi

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

owned = lambda h: isinstance(h, dict) and isinstance(h.get("name"), str) \
    and h["name"].startswith(name_prefix)

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

        # Claude: register marketplace once
        if [[ "$WANT_CLAUDE" == "true" ]]; then
            if has_claude; then
                info "Registering marketplace..."
                claude plugin marketplace add "$REPO_URL" 2>/dev/null || true
            else
                warn "claude CLI not found — skipping Claude Code."
                WANT_CLAUDE=false
            fi
        fi

        # Install each plugin to each client
        for plugin_name in "${PLUGIN_NAMES[@]}"; do
            local_src="$REPO_DIR/plugins/$plugin_name"
            version=$(get_version "$local_src")

            banner "${plugin_name} (v${version})"

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
