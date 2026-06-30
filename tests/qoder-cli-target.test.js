#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const cliPath = path.join(root, "bin", "cli.js");
const source = fs.readFileSync(cliPath, "utf8");

assert(/"--qoder"/.test(source), "CLI parser should recognize --qoder as its own flag");
assert(source.includes("wantQoder"), "CLI should track a separate wantQoder target");
assert(source.includes("WANT_QODER"), "CLI should pass WANT_QODER to install.sh");
assert(source.includes(".qoder"), "CLI should detect Qoder from ~/.qoder");

const help = spawnSync(process.execPath, [cliPath, "--help"], {
  cwd: root,
  encoding: "utf8"
});
assert.equal(help.status, 0, help.stderr);
assert(/--qoder\s+/.test(help.stdout), "help output should include standalone --qoder");
assert(help.stdout.includes("Qoder"), "help output should label Qoder");

console.log("qoder cli target tests passed");
