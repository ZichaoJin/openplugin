#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadCliForTest() {
  const originalExit = process.exit;
  process.exit = (code) => {
    throw new Error(`bin/cli.js must be importable for tests; attempted process.exit(${code})`);
  };
  try {
    return require("../bin/cli.js");
  } finally {
    process.exit = originalExit;
  }
}

const {
  addOpenTasksCompanions,
  defaultSelectedPlugins,
  discoverManageableRepos,
  ensureOpenTasksCliIfSelected,
  formatOpenTasksInstallPlan,
  formatOpenTasksInstallSummary,
  agentNotchAutostartsFromHooks,
  configureOpenTasksIfSelected,
  defaultAgentNotchVibeSocketPath,
  defaultOpenTasksWorkspace,
  installCompanionPlugin,
  parseRepoArg,
  requireOpenTasksCliIfSelected,
  selectedRequiresClientInstall,
  startAgentNotchAfterInstall,
  validateOpenTasksWorkspaceTarget,
} = loadCliForTest();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = updates[key];
    }
  }
  let restoreImmediately = true;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      restoreImmediately = false;
      return result.finally(() => restoreEnv(previous));
    }
    return result;
  } finally {
    if (restoreImmediately) {
      restoreEnv(previous);
    }
  }
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function testExplicitOpenTasksBinIsAccepted() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-opentasks-"));
  const binPath = path.join(tmpDir, "opentasks");
  fs.writeFileSync(binPath, "#!/usr/bin/env sh\nexit 0\n");
  fs.chmodSync(binPath, 0o755);

  withEnv({ PATH: "/definitely/missing/openplugin/path", OPENTASKS_BIN: binPath }, () => {
    assert.strictEqual(requireOpenTasksCliIfSelected([{ name: "opentasks" }]), binPath);
  });
}

function testDefaultOpenTasksWorkspaceLivesInCurrentDirectory() {
  assert.strictEqual(
    defaultOpenTasksWorkspace({ cwd: "/Users/example/projects/ai" }),
    path.join("/Users/example/projects/ai", "opentasks-workspace")
  );
}

function testRejectsSourceRepoAsOpenTasksWorkspaceTarget() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-workspace-target-"));
  const sourceRepo = path.join(tmpDir, "OpenTasks");

  try {
    fs.mkdirSync(path.join(sourceRepo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(sourceRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRepo, "pyproject.toml"), "[project]\nname='opentasks'\n", "utf8");

    assert.throws(
      () => validateOpenTasksWorkspaceTarget(sourceRepo),
      /looks like a source repository/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testAllowsExistingPlainOpenTasksWorkspaceTarget() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-workspace-target-"));
  const workspace = path.join(tmpDir, "opentasks-workspace");

  try {
    fs.mkdirSync(path.join(workspace, "info-for-agent"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "info-for-agent", "repo-index.md"), "", "utf8");
    assert.strictEqual(validateOpenTasksWorkspaceTarget(workspace), workspace);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testConfigureOpenTasksDefaultsToSingleWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-opentasks-config-"));
  const workspace = path.join(tmpDir, "opentasks-workspace");
  const calls = [];

  try {
    const result = await configureOpenTasksIfSelected([{ name: "opentasks" }], true, "opentasks", {
      cwd: tmpDir,
      execFileSyncImpl: (cmd, args) => calls.push([cmd, args]),
    });

    assert.strictEqual(result.mode, "single");
    assert.strictEqual(result.workspace, workspace);
    assert.deepStrictEqual(calls, [["opentasks", ["workspace", "setup", "--path", workspace]]]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testConfigureOpenTasksBossModeInitializesCompanyRoot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-opentasks-boss-"));
  const companyRoot = path.join(tmpDir, "opencompany");
  const calls = [];

  try {
    const result = await configureOpenTasksIfSelected([{ name: "opentasks" }], false, "opentasks", {
      cwd: tmpDir,
      env: { OPENTASKS_SETUP_MODE: "boss", OPENTASKS_COMPANY_ROOT: companyRoot },
      execFileSyncImpl: (cmd, args) => calls.push([cmd, args]),
      checkboxImpl: async () => [],
    });

    assert.strictEqual(result.mode, "opencompany-boss");
    assert.strictEqual(result.companyRoot, companyRoot);
    assert.strictEqual(result.workspace, path.join(companyRoot, "Boss"));
    assert.deepStrictEqual(calls, [["opentasks", ["company", "setup-boss", "--path", companyRoot]]]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testConfigureOpenTasksWorkerModeInitializesWorkerWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-opentasks-worker-"));
  const companyRoot = path.join(tmpDir, "opencompany");
  const calls = [];

  try {
    const result = await configureOpenTasksIfSelected([{ name: "opentasks" }], false, "opentasks", {
      cwd: tmpDir,
      env: {
        OPENTASKS_SETUP_MODE: "worker",
        OPENTASKS_COMPANY_ROOT: companyRoot,
        OPENTASKS_AONE_NAME: "HoneyBabyAgent",
      },
      execFileSyncImpl: (cmd, args) => calls.push([cmd, args]),
      checkboxImpl: async () => [],
    });

    const workerWorkspace = path.join(companyRoot, "Workers", "HoneyBabyAgent");
    assert.strictEqual(result.mode, "opencompany-worker");
    assert.strictEqual(result.companyRoot, companyRoot);
    assert.strictEqual(result.workspace, workerWorkspace);
    assert.deepStrictEqual(calls, [[
      "opentasks",
      [
        "worker",
        "setup-machine",
        "--cwd",
        workerWorkspace,
        "--name",
        "HoneyBabyAgent",
        "--aone-name",
        "HoneyBabyAgent",
        "--worker-id",
        "honeybabyagent",
      ],
    ]]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withOpenTasksCompanionManifest(companions, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-companions-"));
  const pluginDir = path.join(tmpDir, "plugins", "opentasks");

  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".openplugin-companions.json"),
      JSON.stringify({ companions }, null, 2),
      "utf8"
    );
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testGitLabHttpOpenTasksRepoArgIsPreserved() {
  assert.deepStrictEqual(
    parseRepoArg("http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git"),
    {
      url: "http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git",
      name: "opentasks",
    }
  );
}

function testGitLabSshOpenTasksRepoArgIsParsed() {
  assert.deepStrictEqual(
    parseRepoArg("git@gitlab.alibaba-inc.com:subo.jzc/opentasks.git"),
    {
      url: "git@gitlab.alibaba-inc.com:subo.jzc/opentasks.git",
      name: "opentasks",
    }
  );
}

async function testMissingCliAutoInstallsWhenOpenTasksSelected() {
  const calls = [];
  let resolveCount = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-local-opentasks-"));
  const repoDir = path.join(tmpDir, "repo");

  try {
    fs.mkdirSync(path.join(repoDir, "src", "opentasks"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "pyproject.toml"), "[project]\nname='opentasks'\n", "utf8");

    await withEnv({ PATH: "/definitely/missing/openplugin/path", OPENTASKS_BIN: undefined }, async () => {
      const command = await ensureOpenTasksCliIfSelected([{ name: "opentasks" }], {
        skipPrompts: true,
        repoDir,
        execFileSyncImpl: (cmd, args) => {
          calls.push([cmd, args]);
        },
        resolveCommandImpl: () => {
          resolveCount += 1;
          return resolveCount === 1 ? null : "opentasks";
        },
      });

      assert.strictEqual(command, "opentasks");
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.deepStrictEqual(calls, [["uv", ["tool", "install", "--force", repoDir]]]);
}

async function testExistingCliStillUpgradesWhenOpenTasksSelected() {
  const calls = [];

  await withEnv({ OPENTASKS_BIN: undefined }, async () => {
    const command = await ensureOpenTasksCliIfSelected([{ name: "opentasks" }], {
      skipPrompts: true,
      execFileSyncImpl: (cmd, args) => {
        calls.push([cmd, args]);
      },
      resolveCommandImpl: () => "opentasks",
    });

    assert.strictEqual(command, "opentasks");
  });

  assert.deepStrictEqual(calls, [["uv", ["tool", "install", "--force", "git+http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git"]]]);
}

async function testMissingCliFallsBackToGitInstallWhenLocalRepoUnavailable() {
  const calls = [];
  let resolveCount = 0;

  await withEnv({ PATH: "/definitely/missing/openplugin/path", OPENTASKS_BIN: undefined }, async () => {
    const command = await ensureOpenTasksCliIfSelected([{ name: "opentasks" }], {
      skipPrompts: true,
      repoDir: "/missing/opentasks/repo",
      execFileSyncImpl: (cmd, args) => {
        calls.push([cmd, args]);
      },
      resolveCommandImpl: () => {
        resolveCount += 1;
        return resolveCount === 1 ? null : "opentasks";
      },
    });

    assert.strictEqual(command, "opentasks");
  });

  assert.deepStrictEqual(calls, [["uv", ["tool", "install", "--force", "git+http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git"]]]);
}

async function testMissingCliInstallCanBeDeclined() {
  await withEnv({ PATH: "/definitely/missing/openplugin/path", OPENTASKS_BIN: undefined }, async () => {
    await assert.rejects(
      () => ensureOpenTasksCliIfSelected([{ name: "opentasks" }], {
        skipPrompts: false,
        confirmInstall: async () => false,
        resolveCommandImpl: () => null,
      }),
      /opentasks CLI is required/
    );
  });
}

function testOpenTasksRepoAddsSuperpowersCompanion() {
  const repo = { url: "http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git", name: "opentasks" };
  const plugins = withOpenTasksCompanionManifest([
    {
      name: "superpowers",
      description: "Companion: agent workflow skills",
      defaultSelected: true,
      repo: "obra/Superpowers",
    },
  ], (repoDir) => addOpenTasksCompanions(repo, [
      { name: "opentasks", description: "OpenTasks" },
      { name: "agent-notch", description: "Agent Notch" },
    ], { repoDir }));
  const opentasks = plugins.find((plugin) => plugin.name === "opentasks");
  const agentNotch = plugins.find((plugin) => plugin.name === "agent-notch");
  const superpowers = plugins.find((plugin) => plugin.name === "superpowers");

  assert(opentasks, "expected opentasks core to be present");
  assert.strictEqual(opentasks.core, true);
  assert.strictEqual(opentasks.defaultSelected, true);
  assert(agentNotch, "expected agent-notch companion to be present");
  assert.strictEqual(agentNotch.optionalCompanion, true);
  assert.strictEqual(agentNotch.defaultSelected, true);
  assert(superpowers, "expected superpowers companion to be listed for opentasks repo");
  assert.strictEqual(superpowers.companion, true);
  assert.strictEqual(superpowers.optionalCompanion, true);
  assert.strictEqual(superpowers.defaultSelected, true);
  assert.strictEqual(superpowers.repo, "obra/Superpowers");
}

function testOpenTasksRepoAddsOptionalLangfuseCompanion() {
  const repo = { url: "git@gitlab.alibaba-inc.com:subo.jzc/opentasks.git", name: "opentasks" };
  const plugins = withOpenTasksCompanionManifest([
    {
      name: "langfuse",
      description: "Companion: Langfuse agent skill",
      external: "skill",
      repo: "langfuse/skills",
      skill: "langfuse",
    },
    {
      name: "playwright",
      description: "Companion: browser automation MCP",
      external: "mcp",
      mcp: {
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
    },
    {
      name: "sample-code",
      description: "Companion: sample code MCP",
      external: "mcp",
      mcp: {
        name: "sample-code",
        url: "https://mcp.example.invalid/code",
      },
    },
    {
      name: "sample-board",
      description: "Companion: sample board MCP",
      external: "mcp",
      mcp: {
        name: "sample-board",
        url: "https://mcp.example.invalid/board",
      },
    },
    {
      name: "sample-release",
      description: "Companion: sample release MCP",
      external: "mcp",
      mcp: {
        name: "sample-release",
        url: "https://mcp.example.invalid/release",
      },
    },
    {
      name: "sample-doc-skill",
      description: "Companion: sample document skill",
      external: "a1-skill",
      skill: "sample-doc-skill",
      version: "1.2.3",
    },
  ], (repoDir) => addOpenTasksCompanions(repo, [{ name: "opentasks", description: "OpenTasks" }], { repoDir }));
  const langfuse = plugins.find((plugin) => plugin.name === "langfuse");
  const playwright = plugins.find((plugin) => plugin.name === "playwright");
  const sampleCode = plugins.find((plugin) => plugin.name === "sample-code");
  const sampleBoard = plugins.find((plugin) => plugin.name === "sample-board");
  const sampleRelease = plugins.find((plugin) => plugin.name === "sample-release");
  const sampleDocSkill = plugins.find((plugin) => plugin.name === "sample-doc-skill");

  assert(langfuse, "expected langfuse companion to be listed for opentasks repo");
  assert.strictEqual(langfuse.companion, true);
  assert.strictEqual(langfuse.optionalCompanion, true);
  assert.strictEqual(langfuse.defaultSelected, true);
  assert.strictEqual(langfuse.external, "skill");
  assert.strictEqual(langfuse.repo, "langfuse/skills");
  assert.strictEqual(langfuse.skill, "langfuse");
  assert(playwright, "expected playwright MCP companion to be listed for opentasks repo");
  assert.strictEqual(playwright.external, "mcp");
  assert.strictEqual(playwright.mcp.name, "playwright");
  assert.strictEqual(playwright.mcp.command, "npx");
  assert.deepStrictEqual(playwright.mcp.args, ["-y", "@playwright/mcp@latest"]);
  assert(sampleCode, "expected sample code MCP companion to be listed for opentasks repo");
  assert.strictEqual(sampleCode.external, "mcp");
  assert.strictEqual(sampleCode.mcp.name, "sample-code");
  assert.strictEqual(sampleCode.mcp.url, "https://mcp.example.invalid/code");
  assert(sampleBoard, "expected sample board MCP companion to be listed for opentasks repo");
  assert.strictEqual(sampleBoard.external, "mcp");
  assert.strictEqual(sampleBoard.mcp.name, "sample-board");
  assert.strictEqual(sampleBoard.mcp.url, "https://mcp.example.invalid/board");
  assert(sampleRelease, "expected sample release MCP companion to be listed for opentasks repo");
  assert.strictEqual(sampleRelease.external, "mcp");
  assert.strictEqual(sampleRelease.mcp.name, "sample-release");
  assert.strictEqual(sampleRelease.mcp.url, "https://mcp.example.invalid/release");
  assert(sampleDocSkill, "expected sample document skill companion to be listed for opentasks repo");
  assert.strictEqual(sampleDocSkill.external, "a1-skill");
  assert.strictEqual(sampleDocSkill.skill, "sample-doc-skill");
  assert.strictEqual(sampleDocSkill.version, "1.2.3");
}

function testDefaultSelectionIncludesOpenTasksAndCompanions() {
  const selected = defaultSelectedPlugins([
    { name: "opentasks", core: true, defaultSelected: true },
    { name: "agent-notch", optionalCompanion: true, defaultSelected: true },
    { name: "superpowers", companion: true, optionalCompanion: true, defaultSelected: true },
    { name: "langfuse", companion: true, optionalCompanion: true, external: "skill", defaultSelected: true },
    { name: "playwright", companion: true, optionalCompanion: true, external: "mcp", defaultSelected: true },
    { name: "sample-code", companion: true, optionalCompanion: true, external: "mcp", defaultSelected: true },
    { name: "sample-board", companion: true, optionalCompanion: true, external: "mcp", defaultSelected: true },
    { name: "sample-release", companion: true, optionalCompanion: true, external: "mcp", defaultSelected: true },
    { name: "sample-doc-skill", companion: true, optionalCompanion: true, external: "a1-skill", defaultSelected: true },
  ]);

  assert.deepStrictEqual(selected.map((plugin) => plugin.name), [
    "opentasks",
    "agent-notch",
    "superpowers",
    "langfuse",
    "playwright",
    "sample-code",
    "sample-board",
    "sample-release",
    "sample-doc-skill",
  ]);
}

function testLangfuseCompanionInstallsSkill() {
  const calls = [];
  const result = installCompanionPlugin(
    {
      name: "langfuse",
      companion: true,
      external: "skill",
      repo: "langfuse/skills",
      skill: "langfuse",
    },
    { wantClaude: true, wantCodex: true, wantQoderwork: false },
    {
      execFileSyncImpl: (cmd, args, options) => calls.push([cmd, args, options]),
    }
  );

  assert.strictEqual(result, "langfuse");
  assert.deepStrictEqual(calls, [
    [
      "npx",
      [
        "-y",
        "skills",
        "add",
        "langfuse/skills",
        "--skill",
        "langfuse",
        "--global",
        "--yes",
        "--agent",
        "claude-code",
        "--agent",
        "codex",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ],
  ]);
}

function testQoderWorkLangfuseCompanionUsesQoderSkillAgent() {
  const calls = [];
  installCompanionPlugin(
    {
      name: "langfuse",
      companion: true,
      external: "skill",
      repo: "langfuse/skills",
      skill: "langfuse",
    },
    { wantClaude: false, wantCodex: false, wantQoderwork: true },
    {
      execFileSyncImpl: (cmd, args) => calls.push([cmd, args]),
    }
  );

  assert.deepStrictEqual(calls[0][1].slice(-2), ["--agent", "qoder"]);
}

function testOpenTasksInstallPlanExplainsLangfuseNonInteractiveInstall() {
  const text = formatOpenTasksInstallPlan({
    selectedPlugins: [
      { name: "opentasks", core: true, description: "Core task/memory workflow" },
      { name: "agent-notch", optionalCompanion: true, description: "Companion: local HITL approval UI" },
      { name: "superpowers", companion: true, description: "Companion: agent workflow skills" },
      { name: "playwright", companion: true, external: "mcp", description: "Companion: browser automation MCP" },
      { name: "sample-board", companion: true, external: "mcp", description: "Companion: sample board MCP" },
      {
        name: "langfuse",
        companion: true,
        external: "skill",
        description: "Companion: Langfuse agent skill",
      },
    ],
    targets: { wantClaude: false, wantCodex: true, wantQoderwork: false },
  });

  assert(text.includes("OpenTasks install plan"));
  assert(text.includes("opentasks"));
  assert(text.includes("agent-notch"));
  assert(text.includes("langfuse"));
  assert(text.includes("global"));
  assert(text.includes("non-interactive"));
  assert(text.includes("Codex"));
  assert(text.includes("playwright"));
  assert(text.includes("sample-board"));
}

function testMcpCompanionInstallsPlaywrightToSelectedClients() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-mcp-companion-"));
  const calls = [];
  try {
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "config.toml"), "model = \"test\"\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".qoderwork"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "{\"mcpServers\":{}}\n", "utf8");

    installCompanionPlugin(
      {
        name: "playwright",
        companion: true,
        external: "mcp",
        mcp: {
          name: "playwright",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
        },
      },
      { wantClaude: true, wantCodex: true, wantQoderwork: true },
      {
        homeDir: tmpDir,
        execFileSyncImpl: (cmd, args, options) => calls.push([cmd, args, options]),
      }
    );

    const codexConfig = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf8");
    assert(codexConfig.includes("[mcp_servers.playwright]"));
    assert(codexConfig.includes('command = "npx"'));
    assert(codexConfig.includes('args = ["-y", "@playwright/mcp@latest"]'));

    const qoderMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "utf8"));
    assert.deepStrictEqual(qoderMcp.mcpServers.playwright, {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    });

    assert.deepStrictEqual(calls, [
      [
        "claude",
        ["mcp", "add", "--scope", "user", "playwright", "--", "npx", "-y", "@playwright/mcp@latest"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testMcpCompanionInstallsRemoteBoardToSelectedClients() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-mcp-companion-"));
  const calls = [];
  try {
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "config.toml"), "", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".qoderwork"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "{\"mcpServers\":{}}\n", "utf8");

    installCompanionPlugin(
      {
        name: "sample-board",
        companion: true,
        external: "mcp",
        mcp: {
          name: "sample-board",
          url: "https://mcp.example.invalid/board",
          authType: "oauth",
          displayName: "Sample Board",
          displayNameZh: "Sample Board",
          displayDescription: "Manage sample board items",
          displayDescriptionZh: "Manage sample board items",
        },
      },
      { wantClaude: true, wantCodex: true, wantQoderwork: true },
      {
        homeDir: tmpDir,
        execFileSyncImpl: (cmd, args, options) => calls.push([cmd, args, options]),
      }
    );

    const codexConfig = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf8");
    assert(codexConfig.includes("[mcp_servers.sample-board]"));
    assert(codexConfig.includes('url = "https://mcp.example.invalid/board"'));

    const qoderMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "utf8"));
    assert.strictEqual(qoderMcp.mcpServers["sample-board"].url, "https://mcp.example.invalid/board");
    assert.strictEqual(qoderMcp.mcpServers["sample-board"].authType, "oauth");
    assert.strictEqual(qoderMcp.mcpServers["sample-board"]._displayName_zh, "Sample Board");

    assert.deepStrictEqual(calls, [
      [
        "claude",
        [
          "mcp",
          "add",
          "--scope",
          "user",
          "--transport",
          "http",
          "sample-board",
          "https://mcp.example.invalid/board",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testMcpCompanionInstallsRemoteCodeToSelectedClients() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-mcp-companion-"));
  const calls = [];
  try {
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".codex", "config.toml"), "", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".qoderwork"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "{\"mcpServers\":{}}\n", "utf8");

    installCompanionPlugin(
      {
        name: "sample-code",
        companion: true,
        external: "mcp",
        mcp: {
          name: "sample-code",
          url: "https://mcp.example.invalid/code",
          authType: "oauth",
          displayName: "Sample Code",
          displayNameZh: "Sample Code",
          displayDescription: "Manage repositories, branches, merge requests, code search, and issues",
          displayDescriptionZh: "Manage repositories, branches, merge requests, code search, and issues",
        },
      },
      { wantClaude: true, wantCodex: true, wantQoderwork: true },
      {
        homeDir: tmpDir,
        execFileSyncImpl: (cmd, args, options) => calls.push([cmd, args, options]),
      }
    );

    const codexConfig = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf8");
    assert(codexConfig.includes("[mcp_servers.sample-code]"));
    assert(codexConfig.includes('url = "https://mcp.example.invalid/code"'));

    const qoderMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".qoderwork", "mcp.json"), "utf8"));
    assert.strictEqual(qoderMcp.mcpServers["sample-code"].url, "https://mcp.example.invalid/code");
    assert.strictEqual(qoderMcp.mcpServers["sample-code"].authType, "oauth");
    assert.strictEqual(qoderMcp.mcpServers["sample-code"]._displayName_zh, "Sample Code");

    assert.deepStrictEqual(calls, [
      [
        "claude",
        [
          "mcp",
          "add",
          "--scope",
          "user",
          "--transport",
          "http",
          "sample-code",
          "https://mcp.example.invalid/code",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testA1SkillCompanionInstallsDocumentSkill() {
  const calls = [];
  installCompanionPlugin(
    {
      name: "sample-doc-skill",
      companion: true,
      external: "a1-skill",
      skill: "sample-doc-skill",
      version: "1.2.3",
    },
    { wantClaude: true, wantCodex: true, wantQoderwork: true },
    {
      execFileSyncImpl: (cmd, args, options) => calls.push([cmd, args, options]),
    }
  );

  assert.deepStrictEqual(calls, [
    [
      "a1",
      ["skill", "install", "sample-doc-skill@1.2.3", "--global"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ],
  ]);
}

function testMcpCompanionReplacesExistingClaudeServer() {
  const calls = [];
  installCompanionPlugin(
    {
      name: "sample-board",
      companion: true,
      external: "mcp",
      mcp: {
        name: "sample-board",
        url: "https://mcp.example.invalid/board",
      },
    },
    { wantClaude: true, wantCodex: false, wantQoderwork: false },
    {
      execFileSyncImpl: (cmd, args, options) => {
        calls.push([cmd, args, options]);
        if (calls.length === 1) {
          const error = new Error("exists");
          error.stderr = "MCP server sample-board already exists in user config";
          throw error;
        }
      },
    }
  );

  assert.deepStrictEqual(calls.map((call) => call[1]), [
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "sample-board",
      "https://mcp.example.invalid/board",
    ],
    ["mcp", "remove", "--scope", "user", "sample-board"],
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "sample-board",
      "https://mcp.example.invalid/board",
    ],
  ]);
}

function testExternalOnlySelectionDoesNotRequireClientInstall() {
  assert.strictEqual(selectedRequiresClientInstall([
    { name: "langfuse", companion: true, external: "skill" },
  ]), false);
  assert.strictEqual(selectedRequiresClientInstall([
    { name: "sample-doc-skill", companion: true, external: "a1-skill" },
  ]), false);
  assert.strictEqual(selectedRequiresClientInstall([
    { name: "playwright", companion: true, external: "mcp" },
  ]), true);
  assert.strictEqual(selectedRequiresClientInstall([
    { name: "superpowers", companion: true },
  ]), true);
  assert.strictEqual(selectedRequiresClientInstall([
    { name: "opentasks" },
  ]), true);
}

function testSuperpowersCompanionAlreadyInstalledContinues() {
  const calls = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-installed-companion-"));

  fs.mkdirSync(path.join(tmpDir, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@superpowers-marketplace": [
          { scope: "user", installPath: "/tmp/superpowers", version: "5.1.0" },
        ],
      },
    }),
    "utf8"
  );

  installCompanionPlugin(
    { name: "superpowers", companion: true, repo: "obra/Superpowers" },
    { wantClaude: true, wantCodex: false, wantQoderwork: false },
    {
      homeDir: tmpDir,
      execFileSyncImpl: (cmd, args, options) => {
        calls.push([cmd, args, options]);
      },
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(calls.length, 0);
}

function testDiscoverManageableReposFindsCurrentAndNearbyRepos() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-repos-"));
  const current = path.join(tmpDir, "current");
  const sibling = path.join(tmpDir, "sibling");
  const plain = path.join(tmpDir, "plain");

  try {
    fs.mkdirSync(current);
    fs.mkdirSync(sibling);
    fs.mkdirSync(plain);
    require("child_process").execFileSync("git", ["init", current], { stdio: "ignore" });
    require("child_process").execFileSync("git", ["init", sibling], { stdio: "ignore" });

    const repos = discoverManageableRepos(current, { maxNearby: 10 });

    assert.deepStrictEqual(repos.map((repo) => fs.realpathSync(repo.path)), [
      fs.realpathSync(current),
      fs.realpathSync(sibling),
    ]);
    assert.deepStrictEqual(repos.map((repo) => repo.kind), ["current", "nearby"]);
    assert.deepStrictEqual(repos.map((repo) => repo.defaultSelected), [true, false]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testAgentNotchUsesHookAutostartInsteadOfLegacyWelcome() {
  assert.strictEqual(agentNotchAutostartsFromHooks([
    { name: "opentasks", core: true },
    { name: "agent-notch", version: "0.1.0+codex.20260618135823", optionalCompanion: true },
  ]), true);
  assert.strictEqual(agentNotchAutostartsFromHooks([
    { name: "opentasks", core: true },
  ]), false);
}

function testOpenTasksSummaryExplainsAgentNotchHookAutostart() {
  const text = formatOpenTasksInstallSummary({
    workspace: "/Users/example/OpenTasks",
    addedRepos: [],
    failedRepos: [],
    agentNotchAutostarts: true,
  });

  assert(text.includes("Welcome to OpenTasks"));
  assert(text.includes("Workspace: /Users/example/OpenTasks"));
  assert(text.includes("Managed repos: none added during install"));
  assert(text.includes("[ok] Agent Notch hooks installed; Vibe runtime autostarts on first hook"));
  assert(!text.includes("Agent Notch welcome opened"));
  assert(text.indexOf("[ok] Agent Notch hooks installed") < text.indexOf("Manage repos later:"));
  assert(text.includes('Agent: "把 /path/to/repo 加进 OpenTasks"'));
}

function testOpenTasksSummaryExplainsAgentNotchStartedAfterInstall() {
  const text = formatOpenTasksInstallSummary({
    workspace: "/Users/example/OpenTasks",
    addedRepos: [],
    failedRepos: [],
    agentNotchStarted: true,
    agentNotchAutostarts: true,
  });

  assert(text.includes("[ok] Agent Notch started; new sessions will appear in the notch"));
  assert(!text.includes("Vibe runtime autostarts on first hook"));
}

async function testAgentNotchStartsOnceAfterCodexInstall() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-start-"));
  const calls = [];
  const buildCalls = [];
  let liveChecks = 0;
  try {
    const runtime = path.join(
      tmpDir,
      ".codex",
      "plugins",
      "cache",
      "opentasks",
      "agent-notch",
      "0.1.0",
      "vibe-runtime"
    );
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, ".build", "debug", "AgentNotchVibe");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const result = await startAgentNotchAfterInstall(
      [{ name: "opentasks" }, { name: "agent-notch" }],
      { wantCodex: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        socketLiveImpl: () => Promise.resolve(liveChecks++ > 0),
        execFileSyncImpl: (cmd, args, options) => buildCalls.push([cmd, args, options]),
        spawnImpl: (cmd, args, options) => {
          calls.push([cmd, args, options]);
          return { unref() {} };
        },
        startTimeoutMs: 50,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, true);
    assert.deepStrictEqual(buildCalls.map((call) => [call[0], call[1]]), [
      ["swift", ["build", "--package-path", runtime]],
    ]);
    assert.deepStrictEqual(buildCalls[0][2].stdio, ["ignore", "pipe", "pipe"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], executable);
    assert.deepStrictEqual(calls[0][1], []);
    assert.strictEqual(calls[0][2].detached, true);
    assert.strictEqual(calls[0][2].env.AGENT_NOTCH_OPEN_ON_LAUNCH, "1");
    assert.strictEqual(calls[0][2].stdio, "ignore");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchStartsAfterClaudeOnlyInstall() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-claude-start-"));
  const calls = [];
  const buildCalls = [];
  let liveChecks = 0;
  try {
    const runtime = path.join(
      tmpDir,
      ".claude",
      "plugins",
      "cache",
      "opentasks",
      "agent-notch",
      "0.1.0",
      "vibe-runtime"
    );
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, ".build", "debug", "AgentNotchVibe");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantClaude: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        socketLiveImpl: () => Promise.resolve(liveChecks++ > 0),
        execFileSyncImpl: (cmd, args, options) => buildCalls.push([cmd, args, options]),
        spawnImpl: (cmd, args, options) => {
          calls.push([cmd, args, options]);
          return { unref() {} };
        },
        startTimeoutMs: 50,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, true);
    assert.deepStrictEqual(buildCalls.map((call) => [call[0], call[1]]), [
      ["swift", ["build", "--package-path", runtime]],
    ]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], executable);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchStartsPackagedBinaryWithoutSwiftBuild() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-packaged-start-"));
  const calls = [];
  let liveChecks = 0;
  try {
    const runtime = path.join(tmpDir, "runtime");
    fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, "bin", `AgentNotchVibe-darwin-${process.arch}`);
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantCodex: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        runtimeDir: runtime,
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        socketLiveImpl: () => Promise.resolve(liveChecks++ > 0),
        execFileSyncImpl: () => {
          throw new Error("swift build should not run when packaged binary exists");
        },
        spawnImpl: (cmd, args, options) => {
          calls.push([cmd, args, options]);
          return { unref() {} };
        },
        startTimeoutMs: 50,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], executable);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchStartTimeoutWarnsWithRuntimeDetails() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-timeout-"));
  const warnings = [];
  try {
    const runtime = path.join(tmpDir, "runtime");
    fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, "bin", `AgentNotchVibe-darwin-${process.arch}`);
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantClaude: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        runtimeDir: runtime,
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        socketLiveImpl: () => Promise.resolve(false),
        spawnImpl: () => ({ unref() {} }),
        warnImpl: (message) => warnings.push(message),
        startTimeoutMs: 5,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, false);
    assert.match(warnings.join("\n"), /socket did not become ready/);
    assert.match(warnings.join("\n"), new RegExp(escapeRegExp(runtime)));
    assert.match(warnings.join("\n"), new RegExp(escapeRegExp(executable)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchInstallClearsStaleProcessBeforeStart() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-stale-process-"));
  const terminated = [];
  let liveChecks = 0;
  try {
    const runtime = path.join(tmpDir, "runtime");
    fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, "bin", `AgentNotchVibe-darwin-${process.arch}`);
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);
    const lockPath = path.join(tmpDir, "agent-notch.instance.lock");
    fs.writeFileSync(lockPath, "stale\n", "utf8");

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantClaude: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        runtimeDir: runtime,
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        lockPath,
        socketLiveImpl: () => Promise.resolve(liveChecks++ > 0),
        terminateAgentNotchImpl: () => terminated.push("terminated"),
        spawnImpl: () => ({ unref() {} }),
        startTimeoutMs: 50,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, true);
    assert.deepStrictEqual(terminated, ["terminated"]);
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchInstallRestartsExistingUi() {
  const calls = [];
  const terminated = [];
  const liveChecks = [true, false, false, true];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-restart-"));
  try {
    const runtime = path.join(tmpDir, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");
    const executable = path.join(runtime, ".build", "debug", "AgentNotchVibe");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantCodex: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        runtimeDir: runtime,
        socketLiveImpl: () => Promise.resolve(liveChecks.shift() ?? true),
        terminateAgentNotchImpl: () => terminated.push("terminated"),
        execFileSyncImpl: () => {},
        spawnImpl: (cmd, args, options) => {
          calls.push([cmd, args, options]);
          return { unref() {} };
        },
        startTimeoutMs: 50,
        waitIntervalMs: 1,
      }
    );

    assert.strictEqual(result, true);
    assert.deepStrictEqual(terminated, ["terminated"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], executable);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testAgentNotchBuildFailureDoesNotFailInstall() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openplugin-agent-notch-build-fail-"));
  const warnings = [];
  try {
    const runtime = path.join(tmpDir, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "Package.swift"), "", "utf8");

    const result = await startAgentNotchAfterInstall(
      [{ name: "agent-notch" }],
      { wantCodex: true },
      {
        homeDir: tmpDir,
        platform: "darwin",
        runtimeDir: runtime,
        socketPath: path.join(tmpDir, "agent-notch.sock"),
        socketLiveImpl: () => Promise.resolve(false),
        execFileSyncImpl: () => {
          const error = new Error("build failed");
          error.stderr = "xcrun: error: unable to lookup item 'PlatformPath'";
          throw error;
        },
        warnImpl: (message) => warnings.push(message),
      }
    );

    assert.strictEqual(result, false);
    assert.match(warnings.join("\n"), /Agent Notch build failed/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testAgentNotchInstallStartUsesHookSocketPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  assert.strictEqual(
    defaultAgentNotchVibeSocketPath(),
    path.join("/tmp", `agent-notch-vibe-${uid}.sock`)
  );
}

function testNonOpenTasksRepoDoesNotAddCompanions() {
  const repo = { url: "https://github.com/example/other.git", name: "other" };
  const plugins = addOpenTasksCompanions(repo, [{ name: "other-plugin", description: "Other" }]);

  assert.deepStrictEqual(plugins.map((plugin) => plugin.name), ["other-plugin"]);
}

function testToolkitRepoDoesNotGetOpenTasksCompanions() {
  const repo = { url: "https://github.com/aliyun/alibabacloud-agent-toolkit.git", name: "alibabacloud-agent-toolkit" };
  const plugins = addOpenTasksCompanions(repo, [{ name: "alibabacloud-core", description: "Toolkit core" }]);

  assert.deepStrictEqual(plugins.map((plugin) => plugin.name), ["alibabacloud-core"]);
}

function testOpenTasksRepoWithoutOpenTasksPluginDoesNotAddCompanion() {
  const repo = { url: "http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git", name: "opentasks" };
  const plugins = withOpenTasksCompanionManifest([
    { name: "superpowers", description: "Companion: agent workflow skills", repo: "obra/Superpowers" },
  ], (repoDir) => addOpenTasksCompanions(repo, [{ name: "agent-notch", description: "Agent Notch" }], { repoDir }));

  assert.deepStrictEqual(plugins.map((plugin) => plugin.name), ["agent-notch"]);
}

function testOpenTasksRepoWithoutCompanionManifestDoesNotAddHardcodedCompanions() {
  const repo = { url: "http://gitlab.alibaba-inc.com/subo.jzc/opentasks.git", name: "opentasks" };
  const plugins = addOpenTasksCompanions(repo, [{ name: "opentasks", description: "OpenTasks" }]);

  assert.deepStrictEqual(plugins, [{
    name: "opentasks",
    description: "OpenTasks",
    core: true,
    defaultSelected: true,
  }]);
}

function testUnmanagedOpenTasksNamedRepoDoesNotAddCompanions() {
  const repo = { url: "https://github.com/example/opentasks.git", name: "opentasks" };
  const plugins = addOpenTasksCompanions(repo, [{ name: "opentasks", description: "OpenTasks" }]);

  assert.deepStrictEqual(plugins, [{ name: "opentasks", description: "OpenTasks" }]);
}

(async () => {
  testExplicitOpenTasksBinIsAccepted();
  testDefaultOpenTasksWorkspaceLivesInCurrentDirectory();
  testRejectsSourceRepoAsOpenTasksWorkspaceTarget();
  testAllowsExistingPlainOpenTasksWorkspaceTarget();
  await testConfigureOpenTasksDefaultsToSingleWorkspace();
  await testConfigureOpenTasksBossModeInitializesCompanyRoot();
  await testConfigureOpenTasksWorkerModeInitializesWorkerWorkspace();
  testGitLabHttpOpenTasksRepoArgIsPreserved();
  testGitLabSshOpenTasksRepoArgIsParsed();
  await testMissingCliAutoInstallsWhenOpenTasksSelected();
  await testExistingCliStillUpgradesWhenOpenTasksSelected();
  await testMissingCliFallsBackToGitInstallWhenLocalRepoUnavailable();
  await testMissingCliInstallCanBeDeclined();
  testOpenTasksRepoAddsSuperpowersCompanion();
  testOpenTasksRepoAddsOptionalLangfuseCompanion();
  testDefaultSelectionIncludesOpenTasksAndCompanions();
  testLangfuseCompanionInstallsSkill();
  testQoderWorkLangfuseCompanionUsesQoderSkillAgent();
  testOpenTasksInstallPlanExplainsLangfuseNonInteractiveInstall();
  testMcpCompanionInstallsPlaywrightToSelectedClients();
  testMcpCompanionInstallsRemoteCodeToSelectedClients();
  testMcpCompanionInstallsRemoteBoardToSelectedClients();
  testA1SkillCompanionInstallsDocumentSkill();
  testMcpCompanionReplacesExistingClaudeServer();
  testSuperpowersCompanionAlreadyInstalledContinues();
  testExternalOnlySelectionDoesNotRequireClientInstall();
  testDiscoverManageableReposFindsCurrentAndNearbyRepos();
  testAgentNotchUsesHookAutostartInsteadOfLegacyWelcome();
  testOpenTasksSummaryExplainsAgentNotchHookAutostart();
  testOpenTasksSummaryExplainsAgentNotchStartedAfterInstall();
  await testAgentNotchStartsOnceAfterCodexInstall();
  await testAgentNotchStartsAfterClaudeOnlyInstall();
  await testAgentNotchStartsPackagedBinaryWithoutSwiftBuild();
  await testAgentNotchStartTimeoutWarnsWithRuntimeDetails();
  await testAgentNotchInstallClearsStaleProcessBeforeStart();
  await testAgentNotchInstallRestartsExistingUi();
  await testAgentNotchBuildFailureDoesNotFailInstall();
  testAgentNotchInstallStartUsesHookSocketPath();
  testNonOpenTasksRepoDoesNotAddCompanions();
  testToolkitRepoDoesNotGetOpenTasksCompanions();
  testOpenTasksRepoWithoutOpenTasksPluginDoesNotAddCompanion();
  testOpenTasksRepoWithoutCompanionManifestDoesNotAddHardcodedCompanions();
  testUnmanagedOpenTasksNamedRepoDoesNotAddCompanions();
  console.log("opentasks CLI requirement tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
