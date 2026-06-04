# openplugin

Install AI coding agent plugins from GitHub with a single command.

Supports **Claude Code**, **Codex CLI**, and **QoderWork**.

## Usage

```bash
# Install plugins from a GitHub repository
npx openplugin <owner/repo>

# Install a specific plugin
npx openplugin <owner/repo> --plugin <name>

# Install to a specific client only
npx openplugin <owner/repo> --claude
npx openplugin <owner/repo> --codex
npx openplugin <owner/repo> --qoderwork

# Skip interactive prompts (install all plugins to all detected clients)
npx openplugin <owner/repo> -y

# Uninstall
npx openplugin remove <owner/repo>
```

## How it works

1. Clones the specified GitHub repository
2. Discovers plugins under `plugins/<name>/.claude-plugin/`
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

## License

Apache-2.0
