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

# ─── Client detection ────────────────────────────────────────────────
has_claude()     { command -v claude >/dev/null 2>&1; }
has_codex()      { [[ -d "${HOME}/.codex" ]]; }
has_qoderwork()  { [[ -d "${HOME}/.qoderwork" ]]; }

# ─── Repo clone / dev-mode detection ─────────────────────────────────
REPO_DIR=""
TMPDIR_CREATED=""

clone_repo() {
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

    info "Cloning ${REPO_URL} ..." >&2
    TMPDIR_CREATED="$(mktemp -d)"
    git clone --depth 1 --quiet "$REPO_URL" "$TMPDIR_CREATED/repo"
    REPO_DIR="$TMPDIR_CREATED/repo"
    ok "Downloaded to ${TMPDIR_CREATED}/repo" >&2
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
        result.append({
            "name": data.get("name", entry),
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

# Read version from a plugin directory
get_version() {
    local plugin_src="$1"
    python3 -c "import json; print(json.load(open('$plugin_src/.claude-plugin/plugin.json')).get('version','1.0.0'))" 2>/dev/null || echo "1.0.0"
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

    local hook_script="$dest/tools/codex/enable-codex-hooks.sh"
    if [[ -f "$hook_script" ]]; then
        info "  Enabling hooks for ${plugin_name}..."
        bash "$hook_script"
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
        "$plugin_src/" "$dest/"

    local hook_script="$dest/tools/qoderwork/enable-qoderwork-hooks.sh"
    if [[ -f "$hook_script" ]]; then
        info "  Enabling hooks for ${plugin_name}..."
        bash "$hook_script"
    fi

    # Merge MCP entries from plugin's .mcp.json into ~/.qoderwork/mcp.json
    if [[ -f "$plugin_src/.mcp.json" ]]; then
        info "  Configuring MCP for ${plugin_name}..."
        python3 - "${HOME}/.qoderwork/mcp.json" "$plugin_src/.mcp.json" <<'PYEOF'
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

for name, server in source.get("mcpServers", {}).items():
    config["mcpServers"][name] = server

with open(target_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF
    fi

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

    # Discover installed plugins by scanning plugins-custom directory
    local custom_dir="${HOME}/.qoderwork/plugins-custom"
    local removed_any=false
    local plugin_prefixes=()

    if [[ -d "$custom_dir" ]]; then
        for plugin_dir in "$custom_dir"/*/; do
            [[ -d "$plugin_dir" ]] || continue
            local pname
            pname="$(basename "$plugin_dir")"
            # Check if this plugin belongs to our marketplace by reading plugin.json
            local pjson="$plugin_dir/.claude-plugin/plugin.json"
            if [[ -f "$pjson" ]]; then
                local repo_match
                repo_match=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    repo = d.get('repository','') or d.get('homepage','')
    # Match if marketplace name appears in the repo URL
    print('yes' if sys.argv[2] in repo else 'no')
except: print('no')
" "$pjson" "$MARKETPLACE_NAME" 2>/dev/null || echo "no")
                if [[ "$repo_match" == "yes" ]]; then
                    rm -rf "$plugin_dir"
                    ok "Removed ${plugin_dir}"
                    plugin_prefixes+=("${pname}/")
                    removed_any=true
                fi
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

    # Remove MCP entries
    local mcp_config="${HOME}/.qoderwork/mcp.json"
    if [[ -f "$mcp_config" ]]; then
        info "Removing MCP server entries..."
        python3 - "$mcp_config" "$MARKETPLACE_NAME" <<'PYEOF'
import json, sys

path, marketplace = sys.argv[1:]
with open(path) as f:
    config = json.load(f)

servers = config.get("mcpServers", {})
to_remove = [k for k in servers if marketplace in k or k.startswith("alibabacloud")]
changed = False
for k in to_remove:
    del servers[k]
    changed = True

if changed:
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    print(f"Removed {len(to_remove)} MCP entries from {path}")
else:
    print("No MCP entries to remove.")
PYEOF
    fi

    ok "QoderWork: uninstalled. Restart QoderWork to apply."
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

        banner "Done"
        ok "Installation complete. Restart your coding agent to activate."
        ;;

    uninstall)
        banner "Uninstalling plugins from ${MARKETPLACE_NAME}"

        [[ "$WANT_CLAUDE" == "true" ]]    && uninstall_claude
        [[ "$WANT_CODEX" == "true" ]]     && uninstall_codex
        [[ "$WANT_QODERWORK" == "true" ]] && uninstall_qoderwork

        banner "Done"
        ok "Uninstallation complete."
        ;;

    *)
        err "Unknown command: $COMMAND"
        err "Usage: install.sh <discover|install|uninstall>"
        exit 1
        ;;
esac
