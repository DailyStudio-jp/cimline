const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/features/sessions/session-title.mjs"), "utf8");
const moduleSource = source.replace("export function getCliSessionTitle", "function getCliSessionTitle") + "\nmodule.exports = { getCliSessionTitle };";
const sessionTitle = { exports: {} };
vm.runInNewContext(moduleSource, { module: sessionTitle, exports: sessionTitle.exports }, { filename: "session-title.mjs" });
const { getCliSessionTitle } = sessionTitle.exports;

test("Codex title removes its activity spinner and project suffix", () => {
  assert.equal(getCliSessionTitle("⠋ Fix terminal session titles | cimline", { cli: "codex", cwd: "F:\\work\\cimline" }), "Fix terminal session titles");
});

test("Codex action-required title keeps the thread name", () => {
  assert.equal(getCliSessionTitle("[ ! ] Action Required | Review the pending changes | cimline", { cli: "codex", cwd: "F:\\work\\cimline" }), "Review the pending changes");
});

test("Claude title removes activity glyph and normalizes whitespace", () => {
  assert.equal(getCliSessionTitle("◐   Add image drag and drop support  ", { cli: "claude", cwd: "F:\\work\\cimline" }), "Add image drag and drop support");
});

test("generic CLI and shell titles do not replace the folder fallback", () => {
  assert.equal(getCliSessionTitle("Claude Code", { cli: "claude", cwd: "F:\\work\\cimline" }), null);
  assert.equal(getCliSessionTitle("PowerShell", { cli: "codex", cwd: "F:\\work\\cimline" }), null);
  assert.equal(getCliSessionTitle("cimline", { cli: "codex", cwd: "F:\\work\\cimline" }), null);
  assert.equal(getCliSessionTitle("⠋ parent-project", { cli: "codex", cwd: "F:\\work\\parent-project\\app" }), null);
});

test("Windows shell executable paths do not replace folder fallback for Claude or Codex", () => {
  const shellTitles = [
    String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    "pwsh.exe",
    "powershell.exe",
  ];
  for (const shellTitle of shellTitles) {
    assert.equal(getCliSessionTitle(shellTitle, { cli: "claude", cwd: "C:\\work\\cimline" }), null);
    assert.equal(getCliSessionTitle(shellTitle + " | cimline", { cli: "codex", cwd: "C:\\work\\cimline" }), null);
  }
});

test("macOS shell executable titles do not replace folder fallback for Claude or Codex", () => {
  const shellTitles = ["/bin/zsh", "/bin/bash", "zsh", "bash"];
  for (const shellTitle of shellTitles) {
    assert.equal(getCliSessionTitle(shellTitle, { cli: "claude", cwd: "/Users/test/cimline" }), null);
    assert.equal(getCliSessionTitle(shellTitle + " | cimline", { cli: "codex", cwd: "/Users/test/cimline" }), null);
  }
});

test("shell prompt and path titles do not become Claude session names", () => {
  for (const shellTitle of ["PS C:\\work\\cimline", "C:\\work\\cimline", "~/work/cimline", "user@MacBook: ~/work/cimline"]) {
    assert.equal(getCliSessionTitle(shellTitle, { cli: "claude", cwd: "/Users/test/cimline" }), null);
  }
});

test("invalid CLI types and empty titles are ignored", () => {
  assert.equal(getCliSessionTitle("A title", { cli: "shell" }), null);
  assert.equal(getCliSessionTitle(" \n ", { cli: "claude" }), null);
});
