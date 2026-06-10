#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SCRIPT = path.join(__dirname, "..", "scripts", "install.sh");

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
  if (arg.startsWith("http://")) {
    arg = arg.replace(/^http:\/\//, "https://");
  }
  if (arg.startsWith("https://")) {
    const name = arg.replace(/\.git$/, "").split("/").pop();
    return { url: arg.replace(/\.git$/, "") + ".git", name };
  }
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(arg)) {
    const name = arg.split("/")[1];
    return { url: `https://github.com/${arg}.git`, name };
  }
  return null;
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
    const selected = new Array(items.length).fill(true);
    let cursor = 0;

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      resolve(items.map((_, i) => i));
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
    npx openplugin <owner/repo>                          Install plugins (interactive)
    npx openplugin <owner/repo> --plugin <name>          Install specific plugin
    npx openplugin <owner/repo> --claude                 Install to Claude Code only
    npx openplugin <owner/repo> -y                       Skip prompts, install all
    npx openplugin remove <owner/repo>                   Uninstall plugins

  Options:
    --plugin <name>    Install a specific plugin (can be used multiple times)
    --claude           Install to Claude Code only
    --codex            Install to Codex CLI only
    --qoderwork        Install to QoderWork only
    -y, --yes          Skip interactive prompts
    -h, --help         Show help

  Examples:
    npx openplugin ZichaoJin/alibabacloud-agent-toolkit
    npx openplugin ZichaoJin/alibabacloud-agent-toolkit --plugin alibabacloud-core --codex
    npx openplugin remove ZichaoJin/alibabacloud-agent-toolkit
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
      `Error: expected owner/repo or GitHub URL, got: ${repoArg || "(nothing)"}\n` +
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
    discovered = JSON.parse(out.trim());
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
  if (pluginFilters.length > 0) {
    selectedPlugins = discovered.filter((p) => pluginFilters.includes(p.name));
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
    selectedPlugins = discovered;
  } else {
    const pluginItems = discovered.map((p) => ({
      label: p.name,
      description: p.description || "",
    }));
    const indices = await checkbox("Which plugins to install?", pluginItems);
    if (indices.length === 0) {
      console.error("No plugin selected.");
      process.exit(1);
    }
    selectedPlugins = indices.map((i) => discovered[i]);
  }

  // Phase 3: select clients
  const hasClientFlags = clientFlags.length > 0;
  let wantClaude, wantCodex, wantQoderwork;

  if (hasClientFlags) {
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

  if (!wantClaude && !wantCodex && !wantQoderwork) {
    console.error("No client selected.");
    process.exit(1);
  }

  // Phase 3.5: Alibaba Cloud telemetry consent
  let telemetryOptin = "";
  const alibabacloudNames = selectedPlugins
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
  try {
    execFileSync("bash", [SCRIPT, "install"], {
      stdio: "inherit",
      env: {
        ...sharedEnv,
        PLUGIN_FILTER: selectedPlugins.map((p) => p.name).join(","),
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

main();
