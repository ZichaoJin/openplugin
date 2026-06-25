# openplugin

Install AI coding agent plugins from Git repositories with a single command.

Supports **Claude Code**, **Codex CLI**, and **QoderWork**.

## Usage

```bash
# Install plugins from a Git repository
npx -y openplugin@latest http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git

# GitHub owner/repo shorthand is also supported for public GitHub repositories
npx -y openplugin@latest <owner/repo>

# Install a specific plugin
npx -y openplugin@latest <owner/repo> --plugin <name>

# Install to a specific client only
npx -y openplugin@latest <owner/repo> --claude
npx -y openplugin@latest <owner/repo> --codex
npx -y openplugin@latest <owner/repo> --qoderwork

# Skip interactive prompts (install all plugins to all detected clients)
npx -y openplugin@latest <owner/repo> --yes

# Uninstall
npx -y openplugin@latest remove <owner/repo>
```

## How it works

1. Clones the specified Git repository
2. Discovers plugins under `plugins/<name>/.claude-plugin/` or a root-level `.claude-plugin/`
3. Lets you choose which plugins and clients to install to
4. Configures hooks, MCP servers, and plugin registration per client

## Options

| Option | Description |
|---|---|
| `--plugin <name>` | Install a specific plugin (can be used multiple times) |
| `--claude` | Install to Claude Code only |
| `--codex` | Install to Codex CLI only |
| `--qoderwork` | Install to QoderWork only |
| `-y, --yes` | Skip interactive prompts |
| `-h, --help` | Show help |

## Requirements

- Node.js 18+
- git
- At least one supported client installed (Claude Code, Codex CLI, or QoderWork)
- Runtime commands referenced by plugin MCP configs. For example, if a plugin's
  `.mcp.json` uses `"command": "uvx"`, install `uv` first so `uvx` is on `PATH`.

## Plugin repository structure

Repositories must follow this structure for plugin discovery:

```
plugins/
  <plugin-name>/
    .claude-plugin/
      plugin.json        # name, version, description
    .mcp.json            # MCP server configuration (optional)
    hooks/               # Hook definitions (optional)
```

Single-plugin repositories may also put plugin files at the repository root:

```
.claude-plugin/
  plugin.json
.codex-plugin/       # Optional
skills/              # Optional
hooks/               # Optional
```

When installing `http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git`, openplugin always installs the
`opentasks` core plugin and then lets you choose OpenTasks companions declared
by that repository in `plugins/opentasks/.openplugin-companions.json`.

If Langfuse is selected, openplugin installs it globally and non-interactively
with the same client targets chosen in the openplugin prompt. For example, a
Codex-only install runs:

```bash
npx -y skills add langfuse/skills --skill langfuse --global --yes --agent codex
```

Client target mapping for Langfuse skills is `Claude Code -> claude-code`,
`Codex CLI -> codex`, and `QoderWork -> qoder`.

MCP companions are registered for the clients selected in the openplugin
prompt. Command-based MCP companions can use tools such as `npx -y
@playwright/mcp@latest`; HTTP MCP companions use the URLs declared by the
downloaded repository manifest. Codex and QoderWork config files are backed up
before MCP entries are merged.

Openplugin does not collect or configure Langfuse credentials. Configure these
later if you want Langfuse tracing:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

The OpenTasks companion prompt is specific to OpenTasks installs; other
repositories are not modified or given extra choices. Companion MCP servers and
external skills come from the downloaded repository manifest rather than
openplugin's source code.

When the selected plugin set includes `opentasks`, openplugin also ensures the
`opentasks` CLI is available. If `OPENTASKS_BIN` is not set and `opentasks` is
not found, it installs the CLI with:

```bash
uv tool install git+http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git@test
```

After plugin installation, it asks for an OpenTasks setup mode:

- `single`: initialize one normal OpenTasks workspace with
  `opentasks workspace setup --path <workspace>`. This workspace stores tasks,
  memories, `repo-index.md`, and `repo-map.md`; source repositories can stay
  anywhere. It then offers a repository picker for the current git repo and
  nearby sibling git repos.
- `boss`: initialize an OpenCompany root with
  `opentasks company setup-boss --path <opencompany-root>`. This creates the
  `Boss/` workspace and `company.json`.
- `worker`: initialize an OpenCompany worker with
  `opentasks worker setup-machine --cwd <opencompany-root>/Workers/<aone-name>`.
  This creates or reuses the worker workspace and configures the local machine
  for that worker.

For non-interactive installs, `--yes` keeps the previous default and uses
`single`. You can choose OpenCompany non-interactively with environment
variables:

```bash
OPENTASKS_SETUP_MODE=boss OPENTASKS_COMPANY_ROOT=/path/to/opencompany \
  npx -y openplugin@latest http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git --yes

OPENTASKS_SETUP_MODE=worker OPENTASKS_COMPANY_ROOT=/path/to/opencompany \
OPENTASKS_AONE_NAME=HoneyBabyAgent \
  npx -y openplugin@latest http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git --yes
```

You can manage repositories later with natural language in an OpenTasks-enabled
agent, or with CLI commands:

```bash
opentasks repo add /path/to/repo --cwd ~/Desktop/opentasks-workspace
opentasks repo remove <repo-name> --cwd ~/Desktop/opentasks-workspace
```

This onboarding runs only for OpenTasks installs.

During installation, openplugin validates plugin MCP configs before copying them
to clients. It checks that `.mcp.json` is valid, local stdio commands are
available or executable, and Codex plugins declare `mcpServers` in
`.codex-plugin/plugin.json` when they ship MCP servers.

## License

Apache-2.0
