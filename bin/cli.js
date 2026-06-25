#!/usr/bin/env node
"use strict";

const { execFileSync, spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const SCRIPT = path.join(__dirname, "..", "scripts", "install.sh");
const OPENTASKS_GIT_INSTALL_SPEC = "git+http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git@test";
const OPENTASKS_REPO_ID = "gitlab.alibaba-inc.com/subo.jzc/opentasks";
const OPENPLUGIN_COMPANIONS_FILE = ".openplugin-companions.json";

// ─── Helpers ─────────────────────────────────────────────────────────

function detectClients() {
  const clients = [];
  try {
    execFileSync("which", ["claude"], { stdio: "ignore" });
    clients.push({ id: "claude", label: "Claude Code", flag: "--claude" });
  } catch {}
  if (fs.existsSync(path.join(os.homedir(), ".codex"))) {
    clients.push({ id: "codex", label: "Codex CLI", flag: "--codex" });
  }
  if (fs.existsSync(path.join(os.homedir(), ".qoderwork"))) {
    clients.push({ id: "qoderwork", label: "QoderWork", flag: "--qoderwork" });
  }
  return clients;
}

function parseRepoArg(arg) {
  if (!arg) return null;
  if (arg.startsWith("http://") || arg.startsWith("https://")) {
    const name = arg.replace(/\.git$/, "").split("/").pop();
    return { url: arg.replace(/\.git$/, "") + ".git", name };
  }
  const sshMatch = arg.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const name = sshMatch[2].replace(/\.git$/, "").split("/").pop();
    return { url: arg.replace(/\.git$/, "") + ".git", name };
  }
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(arg)) {
    const name = arg.split("/")[1];
    return { url: `https://github.com/${arg}.git`, name };
  }
  return null;
}

function isOpenTasksRepo(repo) {
  if (!repo || !repo.url) return false;
  return normalizeRepoId(repo.url) === OPENTASKS_REPO_ID;
}

function normalizeRepoId(url) {
  let normalized = String(url).replace(/\.git$/i, "").toLowerCase();
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  normalized = normalized.replace(/^https?:\/\//, "");
  normalized = normalized.replace(/^ssh:\/\/git@/, "");
  return normalized;
}

function defaultOpenTasksWorkspace(options = {}) {
  const cwd = options.cwd || process.cwd();
  return path.join(path.resolve(cwd), "opentasks-workspace");
}

function defaultOpenCompanyRoot(options = {}) {
  const cwd = options.cwd || process.cwd();
  return path.resolve(cwd);
}

function normalizeOpenTasksSetupMode(value) {
  const normalized = String(value || "single").trim().toLowerCase().replace(/\s+/g, "-");
  if (["single", "workspace", "single-workspace"].includes(normalized)) return "single";
  if (["boss", "opencompany-boss"].includes(normalized)) return "opencompany-boss";
  if (["worker", "opencompany-worker"].includes(normalized)) return "opencompany-worker";
  throw new Error(`Unknown OpenTasks setup mode: ${value}. Use single, boss, or worker.`);
}

function deriveWorkerId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || !/^[\x00-\x7F]+$/.test(raw)) return "";
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function validateWorkerId(workerId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workerId)) {
    throw new Error("OpenCompany worker id must use lowercase ASCII letters, numbers, and hyphens.");
  }
  return workerId;
}

function validateOpenTasksWorkspaceTarget(workspace) {
  if (!fs.existsSync(workspace)) return workspace;
  const sourceMarkers = [
    ".git",
    "src",
    "plugins",
    "pyproject.toml",
    "package.json",
    "Cargo.toml",
    "go.mod",
  ];
  const existingMarkers = sourceMarkers.filter((marker) => fs.existsSync(path.join(workspace, marker)));
  const hasWorkspaceMarkers =
    fs.existsSync(path.join(workspace, "info-for-agent", "repo-index.md")) ||
    fs.existsSync(path.join(workspace, "info-for-agent", "tasks.md"));

  if (existingMarkers.length >= 2 && !isPlainOpenTasksWorkspace(workspace, hasWorkspaceMarkers)) {
    throw new Error(
      `Selected OpenTasks workspace looks like a source repository: ${workspace}\n` +
      `Choose a clean task/memory folder instead, for example: ${defaultOpenTasksWorkspace()}`
    );
  }
  return workspace;
}

function isPlainOpenTasksWorkspace(workspace, hasWorkspaceMarkers) {
  if (!hasWorkspaceMarkers) return false;
  const sourceOnlyMarkers = ["src", "plugins", "pyproject.toml", "package.json", "Cargo.toml", "go.mod"];
  return !sourceOnlyMarkers.some((marker) => fs.existsSync(path.join(workspace, marker)));
}

function addOpenTasksCompanions(repo, plugins, options = {}) {
  if (!isOpenTasksRepo(repo)) return plugins;
  if (!plugins.some((plugin) => plugin.name === "opentasks")) return plugins;
  const normalizedPlugins = plugins.map((plugin) => {
    if (plugin.name === "opentasks") {
      return {
        ...plugin,
        core: true,
        defaultSelected: true,
        description: plugin.description || "Core task/memory workflow",
      };
    }
    if (plugin.name === "agent-notch") {
      return {
        ...plugin,
        optionalCompanion: true,
        defaultSelected: true,
        description: "Companion: local HITL approval UI",
      };
    }
    return plugin;
  });
  const companionPlugins = loadOpenPluginCompanions(options.repoDir, "opentasks");
  const existingNames = new Set(normalizedPlugins.map((plugin) => plugin.name));
  return [
    ...normalizedPlugins,
    ...companionPlugins.filter((plugin) => !existingNames.has(plugin.name)),
  ];
}

function loadOpenPluginCompanions(repoDir, pluginName) {
  if (!repoDir || !pluginName) return [];
  const candidates = [
    path.join(repoDir, "plugins", pluginName, OPENPLUGIN_COMPANIONS_FILE),
    path.join(repoDir, OPENPLUGIN_COMPANIONS_FILE),
  ];
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) return [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${OPENPLUGIN_COMPANIONS_FILE}: ${error.message}`);
  }
  if (!Array.isArray(data.companions)) return [];
  return data.companions
    .map(normalizeOpenPluginCompanion)
    .filter(Boolean);
}

function normalizeOpenPluginCompanion(plugin) {
  if (!plugin || typeof plugin !== "object") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(plugin.name || ""))) return null;
  return {
    ...plugin,
    companion: true,
    optionalCompanion: plugin.optionalCompanion !== false,
    defaultSelected: plugin.defaultSelected !== false,
  };
}

function defaultSelectedPlugins(plugins) {
  return plugins.filter((plugin) => plugin.defaultSelected !== false);
}

function skillsAgentsForTargets(targets = {}) {
  const agents = [];
  if (targets.wantClaude) agents.push("claude-code");
  if (targets.wantCodex) agents.push("codex");
  if (targets.wantQoderwork) agents.push("qoder");
  return agents;
}

function clientLabelsForTargets(targets = {}) {
  const labels = [];
  if (targets.wantClaude) labels.push("Claude Code");
  if (targets.wantCodex) labels.push("Codex CLI");
  if (targets.wantQoderwork) labels.push("QoderWork");
  return labels;
}

function formatOpenTasksInstallPlan({ selectedPlugins, targets }) {
  const externalSkillPlugins = selectedPlugins.filter((plugin) => plugin.external === "skill");
  const a1SkillPlugins = selectedPlugins.filter((plugin) => plugin.external === "a1-skill");
  const targetLabels = clientLabelsForTargets(targets);
  const skillAgents = skillsAgentsForTargets(targets);
  const lines = [
    "",
    "━━━ OpenTasks install plan ━━━",
    `Targets: ${targetLabels.length > 0 ? targetLabels.join(", ") : "none"}`,
    "",
    "Selected components:",
  ];

  for (const plugin of selectedPlugins) {
    let suffix = "";
    if (plugin.external === "skill") {
      suffix = ` — global, non-interactive Skills install for ${skillAgents.join(", ")}`;
    } else if (plugin.external === "a1-skill") {
      suffix = " — global, non-interactive a1 skill install";
    } else if (plugin.description) {
      suffix = ` — ${plugin.description}`;
    }
    lines.push(`  ✓ ${plugin.name}${suffix}`);
  }

  if (externalSkillPlugins.length > 0 || a1SkillPlugins.length > 0) {
    lines.push(
      "",
      "External installers:"
    );
    if (externalSkillPlugins.length > 0) {
      lines.push("  Langfuse uses the Skills CLI with --global --yes and explicit --agent targets.");
    }
    if (a1SkillPlugins.length > 0) {
      lines.push("  a1 skills use a1 skill install <skill>@<version> --global.");
    }
    lines.push("  No extra agent/scope/proceed prompts should appear.");
  }

  return lines.join("\n");
}

// ─── TUI checkbox selector ──────────────────────────────────────────
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function fitToWidth(str, maxWidth) {
  const plain = stripAnsi(str);
  if ([...plain].length <= maxWidth) return str;
  let vis = 0;
  let out = "";
  for (let i = 0; i < str.length; ) {
    if (str[i] === "\x1b") {
      const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (vis >= maxWidth - 1) return out + "…\x1b[0m";
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += ch; vis++; i += ch.length;
  }
  return out;
}

function checkbox(title, items) {
  return new Promise((resolve) => {
    const selected = items.map((item) => item.defaultSelected !== false);
    let cursor = 0;

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      resolve(selected.map((value, i) => (value ? i : -1)).filter((i) => i >= 0));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const BLUE = "\x1b[34m";
    const GREEN = "\x1b[32m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    const HIDE = "\x1b[?25l";
    const SHOW = "\x1b[?25h";
    const CHECKED = `${GREEN}◉${RESET}`;
    const UNCHECKED = `${DIM}○${RESET}`;

    function render() {
      process.stdout.write(`\x1b[${items.length + 2}A`);
      process.stdout.write("\x1b[J");
      draw();
    }

    function draw() {
      const cols = process.stdout.columns || 80;
      process.stdout.write(
        fitToWidth(`${BLUE}?${RESET} ${title} ${DIM}(space=toggle, enter=confirm)${RESET}`, cols) + "\n"
      );
      for (let i = 0; i < items.length; i++) {
        const pointer = i === cursor ? `${BLUE}❯${RESET}` : " ";
        const check = selected[i] ? CHECKED : UNCHECKED;
        const desc = items[i].description
          ? ` ${DIM}— ${items[i].description}${RESET}`
          : "";
        process.stdout.write(fitToWidth(`  ${pointer} ${check} ${items[i].label}${desc}`, cols) + "\n");
      }
      process.stdout.write("\n");
    }

    process.stdout.write(HIDE);
    draw();

    function onKey(key) {
      if (key === "\x03") {
        cleanup();
        process.stdout.write(SHOW);
        process.exit(130);
      }
      if (key === "\r") {
        cleanup();
        process.stdout.write(SHOW);
        resolve(selected.map((s, i) => (s ? i : -1)).filter((i) => i >= 0));
        return;
      }
      if (key === " ") {
        selected[cursor] = !selected[cursor];
        render();
        return;
      }
      if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }
      if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }
      if (key === "a") {
        const allSelected = selected.every(Boolean);
        selected.fill(!allSelected);
        render();
        return;
      }
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onKey);
    }

    process.stdin.on("data", onKey);
  });
}

function selectOne(title, items) {
  return new Promise((resolve) => {
    let cursor = Math.max(0, items.findIndex((item) => item.defaultSelected));

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      resolve(items[cursor].value);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const BLUE = "\x1b[34m";
    const GREEN = "\x1b[32m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    const HIDE = "\x1b[?25l";
    const SHOW = "\x1b[?25h";

    function render() {
      process.stdout.write(`\x1b[${items.length + 2}A`);
      process.stdout.write("\x1b[J");
      draw();
    }

    function draw() {
      const cols = process.stdout.columns || 80;
      process.stdout.write(
        fitToWidth(`${BLUE}?${RESET} ${title} ${DIM}(↑/↓=move, enter=confirm)${RESET}`, cols) + "\n"
      );
      for (let i = 0; i < items.length; i++) {
        const pointer = i === cursor ? `${BLUE}❯${RESET}` : " ";
        const marker = i === cursor ? `${GREEN}◉${RESET}` : `${DIM}○${RESET}`;
        const desc = items[i].description
          ? ` ${DIM}— ${items[i].description}${RESET}`
          : "";
        process.stdout.write(fitToWidth(`  ${pointer} ${marker} ${items[i].label}${desc}`, cols) + "\n");
      }
      process.stdout.write("\n");
    }

    process.stdout.write(HIDE);
    draw();

    function onKey(key) {
      if (key === "\x03") {
        cleanup();
        process.stdout.write(SHOW);
        process.exit(130);
      }
      if (key === "\r") {
        const value = items[cursor].value;
        cleanup();
        process.stdout.write(SHOW);
        resolve(value);
        return;
      }
      if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % items.length;
        render();
      }
    }

    function cleanup() {
      process.stdin.off("data", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`\x1b[${items.length + 2}A`);
      process.stdout.write("\x1b[J");
    }

    process.stdin.on("data", onKey);
  });
}

// ─── TUI confirm prompt (Y/n) ───────────────────────────────────────
function confirm(question, defaultYes = true) {
  return new Promise((resolve) => {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      resolve(defaultYes);
      return;
    }

    const BLUE = "\x1b[34m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    const hint = defaultYes ? "Y/n" : "y/N";

    process.stdout.write(`${BLUE}?${RESET} ${question} ${DIM}(${hint})${RESET} `);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function onKey(key) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onKey);

      if (key === "\x03") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key === "\r" || key === "\n") {
        process.stdout.write(defaultYes ? "Yes\n" : "No\n");
        resolve(defaultYes);
        return;
      }
      if (key.toLowerCase() === "y") {
        process.stdout.write("Yes\n");
        resolve(true);
        return;
      }
      if (key.toLowerCase() === "n") {
        process.stdout.write("No\n");
        resolve(false);
        return;
      }
      process.stdout.write(defaultYes ? "Yes\n" : "No\n");
      resolve(defaultYes);
    }

    process.stdin.on("data", onKey);
  });
}

function input(question, defaultValue = "", options = {}) {
  return new Promise((resolve) => {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      resolve(defaultValue);
      return;
    }
    const readline = require("readline");
    const BLUE = "\x1b[34m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const defaultLabel = options.defaultLabel || defaultValue;
    const suffix = defaultLabel ? ` ${DIM}(${defaultLabel})${RESET}` : "";
    rl.question(`${BLUE}?${RESET} ${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function isGitRepo(dir) {
  return Boolean(gitRepoRoot(dir));
}

function gitRepoRoot(dir, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  try {
    return execFileSyncImpl("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function discoverManageableRepos(currentDir = process.cwd(), options = {}) {
  const maxNearby = options.maxNearby || 20;
  const currentRoot = gitRepoRoot(currentDir, options);
  const baseDir = currentRoot ? path.dirname(currentRoot) : path.dirname(path.resolve(currentDir));
  const repos = [];
  const seen = new Set();

  function addRepo(kind, repoPath, defaultSelected) {
    const resolved = path.resolve(repoPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    repos.push({ kind, path: resolved, defaultSelected });
  }

  if (currentRoot) {
    addRepo("current", currentRoot, true);
  }

  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return repos;
  }

  let nearbyCount = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (nearbyCount >= maxNearby) break;
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(baseDir, entry.name);
    const root = gitRepoRoot(candidate, options);
    if (!root || (currentRoot && path.resolve(root) === path.resolve(currentRoot))) continue;
    addRepo("nearby", root, false);
    nearbyCount += 1;
  }

  return repos;
}

function selectedIncludesOpenTasks(selectedPlugins) {
  return selectedPlugins.some((p) => p.name === "opentasks");
}

function selectedRequiresClientInstall(selectedPlugins) {
  return selectedPlugins.some((plugin) => !plugin.companion || !["github-repo", "skill", "a1-skill"].includes(plugin.external));
}

function installCompanionPlugin(plugin, targets, options = {}) {
  if (plugin.external === "skill") {
    return installSkillCompanion(plugin, { ...options, targets });
  }
  if (plugin.external === "a1-skill") {
    return installA1SkillCompanion(plugin, options);
  }
  if (plugin.external === "mcp") {
    return installMcpCompanion(plugin, targets, options);
  }
  if (plugin.external === "github-repo") {
    return installExternalGitHubCompanion(plugin, options);
  }
  const companionRepo = parseRepoArg(plugin.repo);
  if (!companionRepo) {
    throw new Error(`Invalid companion repository for ${plugin.name}: ${plugin.repo}`);
  }
  const homeDir = options.homeDir || os.homedir();
  if (isCompanionInstalled(plugin.name, targets, homeDir)) {
    console.log(`[ok] ${plugin.name} already installed; continuing`);
    return plugin.name;
  }
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-companion-"));
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  try {
    const output = execFileSyncImpl("bash", [SCRIPT, "install"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        REPO_URL: companionRepo.url,
        MARKETPLACE_NAME: companionRepo.name,
        CLONE_DIR: cloneDir,
        PLUGIN_FILTER: plugin.name,
        WANT_CLAUDE: String(targets.wantClaude),
        WANT_CODEX: String(targets.wantCodex),
        WANT_QODERWORK: String(targets.wantQoderwork),
      },
    });
    if (output) process.stdout.write(output);
  } catch (error) {
    const output = commandErrorOutput(error);
    if (isAlreadyInstalledOutput(output)) {
      console.log(`[ok] ${plugin.name} already installed; continuing`);
      return plugin.name;
    }
    throw error;
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
  }
}

function isCompanionInstalled(name, targets = {}, homeDir = os.homedir()) {
  if (targets.wantClaude && claudePluginInstalled(name, homeDir)) return true;
  if (targets.wantCodex && codexPluginInstalled(name, homeDir)) return true;
  if (targets.wantQoderwork && fs.existsSync(path.join(homeDir, ".qoderwork", "plugins-custom", name))) return true;
  return false;
}

function claudePluginInstalled(name, homeDir) {
  const installedPath = path.join(homeDir, ".claude", "plugins", "installed_plugins.json");
  try {
    const data = JSON.parse(fs.readFileSync(installedPath, "utf8"));
    return Object.keys(data.plugins || {}).some((key) => key.startsWith(`${name}@`));
  } catch {
    return false;
  }
}

function codexPluginInstalled(name, homeDir) {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return new RegExp(`^\\[plugins\\."${escapeRegExp(name)}@`, "m").test(text);
  } catch {
    return false;
  }
}

function installCompanionPlugins(companionPlugins, targets, options = {}) {
  for (let i = 0; i < companionPlugins.length; i++) {
    const plugin = companionPlugins[i];
    console.log(formatCompanionInstallNotice(plugin, i + 1, companionPlugins.length, targets));
    installCompanionPlugin(plugin, targets, options);
  }
}

function formatCompanionInstallNotice(plugin, index, total, targets = {}) {
  const lines = ["", `━━━ Companion ${index}/${total}: ${plugin.name} ━━━`];
  if (plugin.external === "skill") {
    const agents = skillsAgentsForTargets(targets);
    lines.push(
      `Installing ${plugin.skill || plugin.name} with Skills CLI.`,
      `Mode: global, non-interactive`,
      `Agents: ${agents.join(", ")}`
    );
  } else if (plugin.external === "a1-skill") {
    const skillRef = a1SkillRef(plugin);
    lines.push(
      `Installing ${skillRef} with a1.`,
      `Mode: global, non-interactive`
    );
  } else if (plugin.external === "mcp") {
    const mcpName = plugin.mcp && plugin.mcp.name ? plugin.mcp.name : plugin.name;
    lines.push(`Registering MCP server: ${mcpName}`);
  } else if (plugin.repo) {
    lines.push(`Source: ${plugin.repo}`);
  }
  return lines.join("\n");
}

function safeCompanionName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid companion name: ${name}`);
  }
  return name;
}

function installSkillCompanion(plugin, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const repo = plugin.repo;
  const skill = plugin.skill || plugin.name;
  const agents = options.skillAgents || skillsAgentsForTargets(options.targets);
  if (!repo || !skill) {
    throw new Error(`Invalid skill companion configuration for ${plugin.name}`);
  }
  if (!agents || agents.length === 0) {
    throw new Error(`No supported Skills CLI agent target selected for ${plugin.name}.`);
  }

  const args = ["-y", "skills", "add", repo, "--skill", skill, "--global", "--yes"];
  for (const agent of agents) {
    args.push("--agent", agent);
  }
  try {
    execFileSyncImpl("npx", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .trim();
    throw new Error(
      `Failed to install skill companion ${plugin.name}` +
      (output ? `:\n${output.slice(-4000)}` : ".")
    );
  }
  console.log(`[ok] Installed skill companion ${plugin.name}`);
  return skill;
}

function a1SkillRef(plugin) {
  const skill = plugin.skill || plugin.name;
  return plugin.version ? `${skill}@${plugin.version}` : skill;
}

function installA1SkillCompanion(plugin, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const skill = plugin.skill || plugin.name;
  if (!skill) {
    throw new Error(`Invalid a1 skill companion configuration for ${plugin.name}`);
  }
  const skillRef = a1SkillRef(plugin);

  try {
    execFileSyncImpl("a1", ["skill", "install", skillRef, "--global"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = commandErrorOutput(error);
    throw new Error(
      `Failed to install a1 skill companion ${plugin.name}` +
      (output ? `:\n${output.slice(-4000)}` : ".")
    );
  }
  console.log(`[ok] Installed a1 skill companion ${plugin.name}`);
  return skill;
}

function installMcpCompanion(plugin, targets, options = {}) {
  const mcp = plugin.mcp;
  if (!mcp || !mcp.name) {
    throw new Error(`Invalid MCP companion configuration for ${plugin.name}`);
  }
  if (!mcp.url && !mcp.command) {
    throw new Error(`MCP companion ${plugin.name} must declare url or command`);
  }

  const homeDir = options.homeDir || os.homedir();
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const installedTargets = [];

  if (targets.wantCodex) {
    installCodexMcp(mcp, homeDir);
    installedTargets.push("Codex CLI");
  }
  if (targets.wantQoderwork) {
    installQoderWorkMcp(mcp, homeDir);
    installedTargets.push("QoderWork");
  }
  if (targets.wantClaude) {
    installClaudeMcp(mcp, execFileSyncImpl);
    installedTargets.push("Claude Code");
  }

  console.log(`[ok] Installed MCP companion ${plugin.name} → ${installedTargets.join(", ")}`);
  return mcp.name;
}

function installCodexMcp(mcp, homeDir) {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backupFileIfExists(configPath);
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  fs.writeFileSync(configPath, upsertCodexMcpBlock(existing, mcp), "utf8");
}

function upsertCodexMcpBlock(configText, mcp) {
  const header = `[mcp_servers.${mcp.name}]`;
  const blockLines = ["", header];
  if (mcp.url) {
    blockLines.push(`url = ${tomlString(mcp.url)}`);
  } else {
    blockLines.push(`command = ${tomlString(mcp.command)}`);
    if (Array.isArray(mcp.args) && mcp.args.length > 0) {
      blockLines.push(`args = [${mcp.args.map(tomlString).join(", ")}]`);
    }
  }
  const block = blockLines.join("\n") + "\n";
  const pattern = new RegExp(`\\n?\\[mcp_servers\\.${escapeRegExp(mcp.name)}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
  const trimmed = configText.replace(pattern, "").replace(/\s+$/, "");
  return `${trimmed}${block}`;
}

function installQoderWorkMcp(mcp, homeDir) {
  const configPath = path.join(homeDir, ".qoderwork", "mcp.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backupFileIfExists(configPath);

  let config = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      config = { mcpServers: {} };
    }
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[mcp.name] = qoderWorkMcpEntry(mcp);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak.${Date.now()}.${process.pid}`;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function qoderWorkMcpEntry(mcp) {
  if (mcp.url) {
    const entry = {
      url: mcp.url,
      authType: mcp.authType || "oauth",
      _source: "enterprise",
      useLocalCallback: false,
    };
    if (mcp.displayName) entry._displayName = mcp.displayName;
    if (mcp.displayNameZh) entry._displayName_zh = mcp.displayNameZh;
    if (mcp.displayDescription) entry._displayDescription = mcp.displayDescription;
    if (mcp.displayDescriptionZh) entry._displayDescription_zh = mcp.displayDescriptionZh;
    return entry;
  }
  return {
    command: mcp.command,
    args: Array.isArray(mcp.args) ? mcp.args : [],
  };
}

function installClaudeMcp(mcp, execFileSyncImpl) {
  const args = ["mcp", "add", "--scope", "user"];
  if (mcp.url) {
    args.push("--transport", "http", mcp.name, mcp.url);
  } else {
    args.push(mcp.name, "--", mcp.command, ...(Array.isArray(mcp.args) ? mcp.args : []));
  }
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    execFileSyncImpl("claude", args, options);
  } catch (error) {
    const output = commandErrorOutput(error);
    if (/already exists/i.test(output)) {
      execFileSyncImpl("claude", ["mcp", "remove", "--scope", "user", mcp.name], options);
      execFileSyncImpl("claude", args, options);
      return;
    }
    throw new Error(
      `Failed to register MCP server ${mcp.name} in Claude Code` +
      (output ? `:\n${output.slice(-4000)}` : ".")
    );
  }
}

function commandErrorOutput(error) {
  return [error && error.stdout, error && error.stderr]
    .filter(Boolean)
    .join("\n")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .trim();
}

function isAlreadyInstalledOutput(output) {
  return /already (exists|installed)|is already installed|conflict/i.test(output || "");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installExternalGitHubCompanion(plugin, options = {}) {
  const companionRepo = parseRepoArg(plugin.repo);
  if (!companionRepo) {
    throw new Error(`Invalid companion repository for ${plugin.name}: ${plugin.repo}`);
  }

  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const companionsDir = options.companionsDir ||
    process.env.OPENPLUGIN_COMPANIONS_DIR ||
    path.join(os.homedir(), ".openplugin", "companions");
  const target = path.join(companionsDir, safeCompanionName(plugin.name));

  fs.mkdirSync(companionsDir, { recursive: true });
  if (fs.existsSync(target)) {
    console.log(`[info] External companion ${plugin.name} already exists at ${target}`);
    return target;
  }

  try {
    execFileSyncImpl("git", ["clone", "--depth", "1", companionRepo.url, target], { stdio: "inherit" });
  } catch (error) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    throw error;
  }

  console.log(`[ok] Downloaded external companion ${plugin.name} to ${target}`);
  return target;
}

function agentNotchAutostartsFromHooks(selectedPlugins) {
  return selectedPlugins.some((item) => item.name === "agent-notch");
}

async function startAgentNotchAfterInstall(selectedPlugins, targets = {}, options = {}) {
  if (!selectedPlugins.some((item) => item.name === "agent-notch")) return false;
  if (!targets.wantClaude && !targets.wantCodex && !targets.wantQoderwork) return false;
  if ((options.platform || process.platform) !== "darwin") return false;

  const socketPath = options.socketPath || defaultAgentNotchVibeSocketPath();
  const lockPath = options.lockPath || defaultAgentNotchVibeLockPath();
  const socketLiveImpl = options.socketLiveImpl || isSocketLive;
  const terminateAgentNotchImpl = options.terminateAgentNotchImpl || terminateAgentNotchVibeProcesses;
  terminateAgentNotchImpl();
  await waitForSocketDown(socketPath, {
    socketLiveImpl,
    timeoutMs: options.stopTimeoutMs ?? 1500,
    intervalMs: options.waitIntervalMs ?? 100,
  });
  try { fs.rmSync(socketPath, { force: true }); } catch {}
  try { fs.rmSync(lockPath, { force: true }); } catch {}

  const homeDir = options.homeDir || os.homedir();
  const runtimeDir = options.runtimeDir || latestAgentNotchVibeRuntimeDir(homeDir);
  const warnImpl = options.warnImpl || ((message) => console.warn(message));
  if (!runtimeDir) {
    warnImpl("[warn] Agent Notch runtime was not found in installed client plugin caches.");
    return false;
  }

  let executable = findPackagedAgentNotchExecutable(runtimeDir);
  const swift = options.swift || process.env.AGENT_NOTCH_SWIFT || "swift";
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  if (!executable) {
    warnImpl(`[warn] Packaged Agent Notch runtime not found under ${runtimeDir}/bin; falling back to local Swift build.`);
    try {
      execFileSyncImpl(swift, ["build", "--package-path", runtimeDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const output = [error.stderr, error.stdout]
        .filter(Boolean)
        .join("\n")
        .trim()
        .split("\n")
        .slice(-20)
        .join("\n");
      warnImpl(
        `[warn] Agent Notch build failed${output ? `:\n${output}` : ""}\n` +
        "[warn] OpenTasks installation completed; install/fix Xcode Command Line Tools and restart your coding agent to use Agent Notch."
      );
      return false;
    }
    executable = findBuiltAgentNotchExecutable(runtimeDir);
  }
  if (!executable) {
    warnImpl(`[warn] Agent Notch executable was not found under ${runtimeDir}.`);
    return false;
  }

  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(executable, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENT_NOTCH_VIBE_SOCKET: socketPath,
      AGENT_NOTCH_OPEN_ON_LAUNCH: "1",
    },
  });
  if (child && typeof child.on === "function") child.on("error", () => {});
  if (child && typeof child.unref === "function") child.unref();

  const started = await waitForSocketLive(socketPath, {
    socketLiveImpl,
    timeoutMs: options.startTimeoutMs ?? 30000,
    intervalMs: options.waitIntervalMs ?? 100,
  });
  if (!started) {
    warnImpl(
      `[warn] Agent Notch process was launched but socket did not become ready: ${socketPath}\n` +
      `[warn] Runtime: ${runtimeDir}\n` +
      `[warn] Executable: ${executable}\n` +
      "[warn] The hooks are installed; Agent Notch will retry on the first agent hook."
    );
  }
  return started;
}

function defaultAgentNotchVibeSocketPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join("/tmp", `agent-notch-vibe-${uid}.sock`);
}

function defaultAgentNotchVibeLockPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join("/tmp", `agent-notch-vibe-${uid}.instance.lock`);
}

function isSocketAvailable(socketPath) {
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function isSocketLive(socketPath, timeoutMs = 500) {
  if (!isSocketAvailable(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let finished = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on("connect", () => finish(true));
    client.on("error", () => finish(false));

    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.destroy();
      resolve(value);
    }
  });
}

async function waitForSocketLive(socketPath, options = {}) {
  const socketLiveImpl = options.socketLiveImpl || isSocketLive;
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await socketLiveImpl(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await socketLiveImpl(socketPath);
}

async function waitForSocketDown(socketPath, options = {}) {
  const socketLiveImpl = options.socketLiveImpl || isSocketLive;
  const timeoutMs = options.timeoutMs ?? 1500;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await socketLiveImpl(socketPath))) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !(await socketLiveImpl(socketPath));
}

function findBuiltAgentNotchExecutable(runtimeDir) {
  const candidates = [
    path.join(runtimeDir, ".build", "debug", "AgentNotchVibe"),
    path.join(runtimeDir, ".build", "release", "AgentNotchVibe"),
    path.join(runtimeDir, ".build", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx`, "debug", "AgentNotchVibe"),
  ];
  return candidates.find((candidate) => isExecutable(candidate)) || "";
}

function findPackagedAgentNotchExecutable(runtimeDir) {
  const candidates = [
    path.join(runtimeDir, "bin", `AgentNotchVibe-darwin-${process.arch}`),
    path.join(runtimeDir, "bin", "AgentNotchVibe"),
  ];
  return candidates.find((candidate) => isExecutable(candidate)) || "";
}

function latestAgentNotchVibeRuntimeDir(homeDir) {
  const candidates = [
    ...versionedAgentNotchRuntimeDirs(path.join(homeDir, ".codex", "plugins", "cache", "opentasks", "agent-notch")),
    ...versionedAgentNotchRuntimeDirs(path.join(homeDir, ".claude", "plugins", "cache", "opentasks", "agent-notch")),
    agentNotchRuntimeDirCandidate(path.join(homeDir, ".qoderwork", "plugins-custom", "agent-notch", "vibe-runtime")),
  ]
    .filter(Boolean)
    .filter((entry) => fs.existsSync(path.join(entry.runtimeDir, "Package.swift")))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.runtimeDir || null;
}

function versionedAgentNotchRuntimeDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => agentNotchRuntimeDirCandidate(path.join(baseDir, entry.name, "vibe-runtime")))
    .filter(Boolean);
}

function agentNotchRuntimeDirCandidate(runtimeDir) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(runtimeDir).mtimeMs;
  } catch {}
  return { runtimeDir, mtimeMs };
}

function terminateAgentNotchVibeProcesses(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return 0;
  let count = 0;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const comm = match[2] || "";
    const args = match[3] || "";
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    if (!isAgentNotchVibeProcess(comm, args)) continue;
    try {
      process.kill(pid, "SIGTERM");
      count += 1;
    } catch {}
  }
  return count;
}

function isAgentNotchVibeProcess(comm, args) {
  return (
    comm === "AgentNotchVibe" ||
    args.includes("/AgentNotchVibe") ||
    (args.includes("swift run") && args.includes("AgentNotchVibe"))
  );
}

function resolveOpenTasksCommand() {
  if (process.env.OPENTASKS_BIN) {
    const explicit = path.resolve(expandHome(process.env.OPENTASKS_BIN));
    if (!isExecutable(explicit)) {
      throw new Error(`OPENTASKS_BIN is not executable: ${process.env.OPENTASKS_BIN}`);
    }
    return explicit;
  }
  if (commandExists("opentasks")) {
    return "opentasks";
  }
  for (const candidate of openTasksBinaryCandidates()) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function openTasksBinaryCandidates() {
  return [
    path.join(os.homedir(), ".local", "bin", "opentasks"),
    path.join(os.homedir(), "Library", "Application Support", "uv", "tools", "opentasks", "bin", "opentasks"),
  ];
}

function localOpenTasksInstallSpec(repoDir) {
  if (!repoDir) return null;
  const resolved = path.resolve(repoDir);
  if (
    fs.existsSync(path.join(resolved, "pyproject.toml")) &&
    fs.existsSync(path.join(resolved, "src", "opentasks"))
  ) {
    return resolved;
  }
  return null;
}

function requireOpenTasksCliIfSelected(selectedPlugins) {
  if (!selectedIncludesOpenTasks(selectedPlugins)) return null;
  const command = resolveOpenTasksCommand();
  if (command) return command;
  throw new Error(
    "opentasks CLI is required before installing the opentasks plugin.\n" +
    "Install it first, for example:\n" +
    `  uv tool install ${OPENTASKS_GIT_INSTALL_SPEC}\n` +
    "Or set OPENTASKS_BIN=/absolute/path/to/opentasks"
  );
}

async function ensureOpenTasksCliIfSelected(selectedPlugins, options = {}) {
  if (!selectedIncludesOpenTasks(selectedPlugins)) return null;
  const {
    skipPrompts = false,
    confirmInstall = confirm,
    execFileSyncImpl = execFileSync,
    resolveCommandImpl = resolveOpenTasksCommand,
    repoDir = null,
  } = options;

  let command = resolveCommandImpl();
  if (process.env.OPENTASKS_BIN && command) return command;

  if (!command) {
    const shouldInstall = skipPrompts || await confirmInstall(
      "opentasks CLI is missing. Install it now with uv tool install?",
      true
    );
    if (!shouldInstall) {
      throw new Error(
        "opentasks CLI is required before installing the opentasks plugin. " +
        `Install it with: uv tool install ${OPENTASKS_GIT_INSTALL_SPEC}`
      );
    }
  }

  const installSpec = localOpenTasksInstallSpec(repoDir) || OPENTASKS_GIT_INSTALL_SPEC;
  try {
    execFileSyncImpl("uv", ["tool", "install", "--force", installSpec], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "Failed to install opentasks CLI with uv. " +
      "Install uv first, or set OPENTASKS_BIN=/absolute/path/to/opentasks."
    );
  }

  command = resolveCommandImpl();
  if (command) return command;
  throw new Error(
    "Installed opentasks CLI, but openplugin could not find the executable. " +
    "Add uv's tool bin directory to PATH or set OPENTASKS_BIN=/absolute/path/to/opentasks."
  );
}

async function configureOpenTasksIfSelected(selectedPlugins, skipPrompts, opentasksCommand = null, options = {}) {
  if (!selectedIncludesOpenTasks(selectedPlugins)) return null;
  const command = opentasksCommand || await ensureOpenTasksCliIfSelected(selectedPlugins, { skipPrompts });
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const inputImpl = options.inputImpl || input;
  const selectImpl = options.selectImpl || selectOne;
  const checkboxImpl = options.checkboxImpl || checkbox;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;

  if (!skipPrompts && process.stdin.isTTY && process.stdout.isTTY) {
    console.log("OpenTasks can initialize a single workspace, an OpenCompany Boss, or an OpenCompany Worker.");
  }
  const mode = env.OPENTASKS_SETUP_MODE
    ? normalizeOpenTasksSetupMode(env.OPENTASKS_SETUP_MODE)
    : normalizeOpenTasksSetupMode(skipPrompts ? "single" : await selectImpl("OpenTasks setup mode", [
      {
        label: "Single workspace",
        value: "single",
        description: "Use one normal OpenTasks workspace",
        defaultSelected: true,
      },
      {
        label: "OpenCompany Boss",
        value: "opencompany-boss",
        description: "Create or configure the Boss workspace",
      },
      {
        label: "OpenCompany Worker",
        value: "opencompany-worker",
        description: "Create or configure this machine as a worker",
      },
    ]));

  const defaultWorkspace = defaultOpenTasksWorkspace({ cwd });

  const addedRepos = [];
  const failedRepos = [];
  if (mode === "single") {
    const workspaceInput = env.OPENTASKS_WORKSPACE ||
      (skipPrompts
        ? defaultWorkspace
        : await inputImpl("OpenTasks workspace folder", defaultWorkspace, { defaultLabel: defaultWorkspace }));
    const workspace = path.resolve(expandHome(workspaceInput));
    validateOpenTasksWorkspaceTarget(workspace);

    fs.mkdirSync(workspace, { recursive: true });
    execFileSyncImpl(command, ["workspace", "setup", "--path", workspace], { stdio: "inherit" });

    if (!skipPrompts) {
      const repos = discoverManageableRepos(cwd);
      if (repos.length > 0) {
        const repoItems = repos.map((repo) => ({
          label: `${repo.kind.padEnd(7)} ${repo.path}`,
          description: "",
          defaultSelected: repo.defaultSelected,
        }));
        const indices = await checkboxImpl("Which repositories should OpenTasks manage now?", repoItems);
        for (const index of indices) {
          const repo = repos[index];
          try {
            execFileSyncImpl(command, ["repo", "add", repo.path, "--cwd", workspace], { stdio: "inherit" });
            addedRepos.push(repo.path);
          } catch {
            failedRepos.push(repo.path);
          }
        }
      }
    }

    return { mode, workspace, addedRepos, failedRepos };
  }

  const defaultCompanyRoot = defaultOpenCompanyRoot({ cwd });
  const companyRootInput = env.OPENTASKS_COMPANY_ROOT ||
    (skipPrompts
      ? defaultCompanyRoot
      : await inputImpl("OpenCompany root folder", defaultCompanyRoot, { defaultLabel: defaultCompanyRoot }));
  const companyRoot = path.resolve(expandHome(companyRootInput));

  if (mode === "opencompany-boss") {
    fs.mkdirSync(companyRoot, { recursive: true });
    execFileSyncImpl(command, ["company", "setup-boss", "--path", companyRoot], { stdio: "inherit" });
    return { mode, workspace: path.join(companyRoot, "Boss"), companyRoot, addedRepos, failedRepos };
  }

  const aoneName = env.OPENTASKS_AONE_NAME ||
    await inputImpl("Worker Aone name", "", { defaultLabel: "required" });
  if (!aoneName) {
    throw new Error("OpenCompany Worker setup requires a worker Aone name.");
  }
  const name = env.OPENTASKS_WORKER_NAME ||
    (skipPrompts ? aoneName : await inputImpl("Worker display name", aoneName, { defaultLabel: aoneName }));
  const defaultWorkerId = deriveWorkerId(aoneName);
  const workerId = validateWorkerId(env.OPENTASKS_WORKER_ID ||
    (skipPrompts
      ? defaultWorkerId
      : await inputImpl("Worker id", defaultWorkerId, { defaultLabel: defaultWorkerId || "required" })));
  const workerWorkspace = path.join(companyRoot, "Workers", aoneName);
  const workerArgs = [
    "worker",
    "setup-machine",
    "--cwd",
    workerWorkspace,
    "--name",
    name,
    "--aone-name",
    aoneName,
    "--worker-id",
    workerId,
  ];
  const aoneCommand = env.OPENTASKS_AONE_COMMAND || "";
  if (aoneCommand) {
    workerArgs.push("--aone-command", aoneCommand);
  }
  execFileSyncImpl(command, workerArgs, { stdio: "inherit" });
  return { mode, workspace: workerWorkspace, companyRoot, workerWorkspace, addedRepos, failedRepos };
}

function formatOpenTasksInstallSummary({
  mode = "single",
  workspace,
  companyRoot = null,
  workerWorkspace = null,
  addedRepos = [],
  failedRepos = [],
  agentNotchAutostarts = false,
  agentNotchStarted = false,
}) {
  const lines = [
    "",
    "Welcome to OpenTasks",
    `  Setup mode: ${mode}`,
    `  Workspace: ${workspace}`,
    "  Workspace role: task and memory hub, not a source repo",
  ];
  if (companyRoot) {
    lines.push(`  OpenCompany root: ${companyRoot}`);
  }
  if (workerWorkspace) {
    lines.push(`  Worker workspace: ${workerWorkspace}`);
  }

  if (addedRepos.length > 0) {
    lines.push("  Managed repos:");
    for (const repoPath of addedRepos) {
      lines.push(`    - ${repoPath}`);
    }
  } else {
    lines.push("  Managed repos: none added during install");
  }

  if (failedRepos.length > 0) {
    lines.push("  Repos skipped:");
    for (const repoPath of failedRepos) {
      lines.push(`    - ${repoPath}`);
    }
  }

  if (agentNotchStarted) {
    lines.push("  [ok] Agent Notch started; new sessions will appear in the notch");
  } else if (agentNotchAutostarts) {
    lines.push("  [ok] Agent Notch hooks installed; Vibe runtime autostarts on first hook");
  }

  lines.push(
    "",
    "Manage repos later:",
    `  Agent: "把 /path/to/repo 加进 OpenTasks"`,
    `  CLI add: opentasks repo add /path/to/repo --cwd ${workspace}`,
    `  CLI remove: opentasks repo remove <repo-name> --cwd ${workspace}`,
    ""
  );
  return lines.join("\n");
}

// ─── Alibaba Cloud plugin detection ────────────────────────────────
function isAlibabacloudPlugin(pluginName, cloneDir) {
  if (!pluginName.startsWith("alibabacloud")) return false;
  const hooksDir = path.join(cloneDir, "repo", "plugins", pluginName, "hooks");
  try {
    const files = fs.readdirSync(hooksDir);
    return files.some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

function showTelemetryNotice(alibabacloudNames) {
  const CYAN = "\x1b[36m";
  const BOLD = "\x1b[1m";
  const YELLOW = "\x1b[33m";
  const R = "\x1b[0m";

  console.log();
  console.log(`${CYAN}┌──────────────────────────────────────────────────────────────────────${R}`);
  console.log(`${CYAN}│${R} ${BOLD}Alibaba Cloud Telemetry Notice${R}`);
  console.log(`${CYAN}│${R}`);
  console.log(`${CYAN}│${R} Detected Alibaba Cloud plugin(s): ${BOLD}${alibabacloudNames.join(", ")}${R}`);
  console.log(`${CYAN}│${R}`);
  console.log(`${CYAN}│${R} The following opt-in fields are collected to improve Alibaba Cloud`);
  console.log(`${CYAN}│${R} tool quality. They require ${BOLD}explicit user authorization${R}:`);
  console.log(`${CYAN}│${R}`);
  console.log(`${CYAN}│${R}   cliCommand          Sanitized aliyun CLI / MCP tool input`);
  console.log(`${CYAN}│${R}                       (credentials stripped, cap 2000-4000 chars)`);
  console.log(`${CYAN}│${R}   errorMessage        API error class/code only (e.g. NoPermission)`);
  console.log(`${CYAN}│${R}   inputUncachedTokens LLM uncached input tokens`);
  console.log(`${CYAN}│${R}   inputCachedTokens   LLM cached input tokens`);
  console.log(`${CYAN}│${R}   inputCreationTokens LLM cache creation tokens`);
  console.log(`${CYAN}│${R}   outputTokens        LLM output tokens`);
  console.log(`${CYAN}│${R}   reasoningTokens     LLM reasoning tokens`);
  console.log(`${CYAN}│${R}`);
  console.log(`${CYAN}│${R} ${BOLD}Privacy:${R} All AccessKey, STS tokens, JWT, passwords, and PII are`);
  console.log(`${CYAN}│${R} stripped before transmission. No prompt text or tool responses sent.`);
  console.log(`${CYAN}└──────────────────────────────────────────────────────────────────────${R}`);
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
  openplugin — install AI coding agent plugins from GitHub

  Usage:
    npx -y openplugin@latest <owner/repo>                Install plugins (interactive)
    npx -y openplugin@latest <owner/repo> --plugin <name> Install specific plugin
    npx -y openplugin@latest <owner/repo> --claude       Install to Claude Code only
    npx -y openplugin@latest <owner/repo> --yes          Skip prompts, install all
    npx -y openplugin@latest remove <owner/repo>         Uninstall plugins

  Options:
    --plugin <name>    Install a specific plugin (can be used multiple times)
    --claude           Install to Claude Code only
    --codex            Install to Codex CLI only
    --qoderwork        Install to QoderWork only
    -y, --yes          Skip interactive prompts
    -h, --help         Show help

  Examples:
    npx -y openplugin@latest ZichaoJin/alibabacloud-agent-toolkit
    npx -y openplugin@latest ZichaoJin/alibabacloud-agent-toolkit --plugin alibabacloud-core --codex
    npx -y openplugin@latest remove ZichaoJin/alibabacloud-agent-toolkit
    `);
    process.exit(0);
  }

  // Parse command and repo
  let command = "install";
  let repoArgIndex = 0;

  if (args[0] === "remove" || args[0] === "uninstall") {
    command = "uninstall";
    repoArgIndex = 1;
  }

  const repoArg = args[repoArgIndex];
  const repo = parseRepoArg(repoArg);
  if (!repo) {
    console.error(
      `Error: expected owner/repo or Git repository URL, got: ${repoArg || "(nothing)"}\n` +
        `Run with --help for usage.`
    );
    process.exit(1);
  }

  // Parse flags
  const flags = args.slice(repoArgIndex + 1);
  const pluginFilters = [];
  const clientFlags = [];
  let skipPrompts = false;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--plugin" && i + 1 < flags.length) {
      pluginFilters.push(flags[++i]);
    } else if (["--claude", "--codex", "--qoderwork"].includes(flags[i])) {
      clientFlags.push(flags[i]);
    } else if (flags[i] === "-y" || flags[i] === "--yes") {
      skipPrompts = true;
    } else {
      console.error(`Unknown flag: ${flags[i]}\nRun with --help for usage.`);
      process.exit(1);
    }
  }

  const env = {
    ...process.env,
    REPO_URL: repo.url,
    MARKETPLACE_NAME: repo.name,
  };

  if (command === "uninstall") {
    // Uninstall: detect clients, then remove
    const hasClientFlags = clientFlags.length > 0;
    const wantClaude = hasClientFlags ? clientFlags.includes("--claude") : true;
    const wantCodex = hasClientFlags ? clientFlags.includes("--codex") : true;
    const wantQoderwork = hasClientFlags
      ? clientFlags.includes("--qoderwork")
      : true;

    try {
      execFileSync("bash", [SCRIPT, "uninstall"], {
        stdio: "inherit",
        env: {
          ...env,
          WANT_CLAUDE: String(wantClaude),
          WANT_CODEX: String(wantCodex),
          WANT_QODERWORK: String(wantQoderwork),
        },
      });
    } catch (e) {
      process.exit(e.status || 1);
    }
    return;
  }

  // ─── Install flow ────────────────────────────────────────────────

  // Create a shared temp dir so discover + install reuse the same clone
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-"));
  const cleanup = () => {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const sharedEnv = { ...env, CLONE_DIR: cloneDir };

  // Phase 1: discover plugins
  let discovered;
  try {
    const out = execFileSync("bash", [SCRIPT, "discover"], {
      env: sharedEnv,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
    discovered = addOpenTasksCompanions(repo, JSON.parse(out.trim()), {
      repoDir: path.join(cloneDir, "repo"),
    });
  } catch (e) {
    console.error("Failed to discover plugins from repository.");
    cleanup();
    process.exit(1);
  }

  if (discovered.length === 0) {
    console.error(
      `No plugins found in ${repoArg}.\n` +
        `Expected structure: plugins/<name>/.claude-plugin/plugin.json`
    );
    process.exit(1);
  }

  // Phase 2: select plugins
  let selectedPlugins;
  const openTasksInstall = isOpenTasksRepo(repo) && discovered.some((p) => p.core);
  if (pluginFilters.length > 0) {
    const corePlugins = openTasksInstall ? discovered.filter((p) => p.core) : [];
    const filteredPlugins = discovered.filter((p) => !p.core && pluginFilters.includes(p.name));
    selectedPlugins = [...corePlugins, ...filteredPlugins];
    const missing = pluginFilters.filter(
      (f) => !discovered.find((p) => p.name === f)
    );
    if (missing.length > 0) {
      console.error(
        `Plugin not found: ${missing.join(", ")}\n` +
          `Available: ${discovered.map((p) => p.name).join(", ")}`
      );
      process.exit(1);
    }
  } else if (skipPrompts) {
    selectedPlugins = defaultSelectedPlugins(discovered);
  } else if (openTasksInstall) {
    const corePlugins = discovered.filter((p) => p.core);
    const companionPlugins = discovered.filter((p) => p.optionalCompanion);
    if (companionPlugins.length === 0) {
      selectedPlugins = corePlugins;
    } else {
      const companionItems = companionPlugins.map((p) => ({
        label: p.name,
        description: p.description || "",
        defaultSelected: p.defaultSelected,
      }));
      const indices = await checkbox("Install OpenTasks companions?", companionItems);
      selectedPlugins = [
        ...corePlugins,
        ...indices.map((i) => companionPlugins[i]),
      ];
    }
  } else {
    const pluginItems = discovered.map((p) => ({
      label: p.name,
      description: p.description || "",
      defaultSelected: p.defaultSelected,
    }));
    const indices = await checkbox("Which plugins to install?", pluginItems);
    if (indices.length === 0) {
      console.error("No plugin selected.");
      process.exit(1);
    }
    selectedPlugins = indices.map((i) => discovered[i]);
  }

  let opentasksCommand = null;
  try {
    opentasksCommand = await ensureOpenTasksCliIfSelected(selectedPlugins, {
      skipPrompts,
      repoDir: path.join(cloneDir, "repo"),
    });
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(1);
  }

  // Phase 3: select clients
  const hasClientFlags = clientFlags.length > 0;
  let wantClaude, wantCodex, wantQoderwork;
  const requiresClientInstall = selectedRequiresClientInstall(selectedPlugins);

  if (!requiresClientInstall) {
    wantClaude = false;
    wantCodex = false;
    wantQoderwork = false;
  } else if (hasClientFlags) {
    wantClaude = clientFlags.includes("--claude");
    wantCodex = clientFlags.includes("--codex");
    wantQoderwork = clientFlags.includes("--qoderwork");
  } else if (skipPrompts) {
    const clients = detectClients();
    wantClaude = clients.some((c) => c.id === "claude");
    wantCodex = clients.some((c) => c.id === "codex");
    wantQoderwork = clients.some((c) => c.id === "qoderwork");
  } else {
    const clients = detectClients();
    if (clients.length === 0) {
      console.error(
        "No supported AI coding client detected (Claude Code, Codex, QoderWork).\n" +
          "Install at least one, or specify --claude / --codex / --qoderwork."
      );
      process.exit(1);
    }
    const indices = await checkbox("Which clients to install to?", clients);
    if (indices.length === 0) {
      console.error("No client selected.");
      process.exit(1);
    }
    wantClaude = indices.some((i) => clients[i].id === "claude");
    wantCodex = indices.some((i) => clients[i].id === "codex");
    wantQoderwork = indices.some((i) => clients[i].id === "qoderwork");
  }

  if (requiresClientInstall && !wantClaude && !wantCodex && !wantQoderwork) {
    console.error("No client selected.");
    process.exit(1);
  }

  if (openTasksInstall) {
    console.log(formatOpenTasksInstallPlan({
      selectedPlugins,
      targets: { wantClaude, wantCodex, wantQoderwork },
    }));
  }

  // Phase 3.5: Alibaba Cloud telemetry consent
  let telemetryOptin = "";
  const localSelectedPlugins = selectedPlugins.filter((plugin) => !plugin.companion);
  const companionPlugins = selectedPlugins.filter((plugin) => plugin.companion);

  const alibabacloudNames = localSelectedPlugins
    .map((p) => p.name)
    .filter((name) => isAlibabacloudPlugin(name, cloneDir));

  if (alibabacloudNames.length > 0) {
    showTelemetryNotice(alibabacloudNames);
    if (skipPrompts) {
      telemetryOptin = "true";
    } else {
      const authorized = await confirm(
        "Authorize collection of the above fields?"
      );
      telemetryOptin = authorized ? "true" : "false";
    }
  }

  // Phase 4: run install (reuses the clone from Phase 1)
  if (localSelectedPlugins.length > 0) {
    try {
      execFileSync("bash", [SCRIPT, "install"], {
        stdio: "inherit",
        env: {
          ...sharedEnv,
          PLUGIN_FILTER: localSelectedPlugins.map((p) => p.name).join(","),
          WANT_CLAUDE: String(wantClaude),
          WANT_CODEX: String(wantCodex),
          WANT_QODERWORK: String(wantQoderwork),
          TELEMETRY_OPTIN: telemetryOptin,
        },
      });
    } catch (e) {
      process.exit(e.status || 1);
    }
  }

  try {
    installCompanionPlugins(companionPlugins, { wantClaude, wantCodex, wantQoderwork });
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(e.status || 1);
  }

  let openTasksInstallResult = null;
  try {
    openTasksInstallResult = await configureOpenTasksIfSelected(selectedPlugins, skipPrompts, opentasksCommand);
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(e.status || 1);
  }

  const agentNotchStarted = await startAgentNotchAfterInstall(selectedPlugins, { wantClaude, wantCodex, wantQoderwork });
  if (agentNotchStarted) {
    console.log("[ok] Agent Notch started");
  }

  if (openTasksInstallResult) {
    console.log(formatOpenTasksInstallSummary({
      ...openTasksInstallResult,
      agentNotchAutostarts: agentNotchAutostartsFromHooks(selectedPlugins),
      agentNotchStarted,
    }));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || String(e));
    process.exit(e.status || 1);
  });
}

module.exports = {
  addOpenTasksCompanions,
  configureOpenTasksIfSelected,
  defaultAgentNotchVibeSocketPath,
  defaultSelectedPlugins,
  defaultOpenTasksWorkspace,
  discoverManageableRepos,
  ensureOpenTasksCliIfSelected,
  formatOpenTasksInstallPlan,
  formatOpenTasksInstallSummary,
  installCompanionPlugin,
  agentNotchAutostartsFromHooks,
  parseRepoArg,
  startAgentNotchAfterInstall,
  requireOpenTasksCliIfSelected,
  resolveOpenTasksCommand,
  selectedRequiresClientInstall,
  validateOpenTasksWorkspaceTarget,
};
