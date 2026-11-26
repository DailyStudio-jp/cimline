const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const preloadSource = fs.readFileSync(path.join(__dirname, "../electron/preload.cjs"), "utf8");

function loadPreload(getPathForFile, invoke = async () => {}) {
  let exposedApi;
  const electronMock = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposedApi = api; } },
    ipcRenderer: { invoke, on: () => {}, removeListener: () => {} },
    webUtils: { getPathForFile },
  };
  vm.runInNewContext(preloadSource, {
    require: (name) => name === "electron" ? electronMock : require(name),
    process,
  }, { filename: "electron/preload.cjs" });
  return exposedApi;
}

test("preload sends legacy and separate agent-title updates through their IPC channels", async () => {
  const calls = [];
  const api = loadPreload((file) => file.path, async (...args) => calls.push(args));
  await api.setSessionTitle("session-1", "Fix terminal session title");
  await api.setAgentTitle("session-1", "Fix terminal session title");
  assert.deepEqual(calls, [
    ["sessions:set-title", "session-1", "Fix terminal session title"],
    ["sessions:set-agent-title", "session-1", "Fix terminal session title"],
  ]);
});

test("preload exposes theme and bounded zoom IPC methods", async () => {
  const calls = [];
  const api = loadPreload((file) => file.path, async (...args) => calls.push(args));
  await api.setTheme("light");
  await api.adjustZoom(0.1);
  assert.deepEqual(calls, [["settings:set-theme", "light"], ["settings:adjust-zoom", 0.1]]);
});

test("preload returns native paths for supported image extensions including Unicode names", () => {
  const api = loadPreload((file) => file.path);
  const result = api.getDroppedImagePaths([
    { name: "画面 1.PNG", path: "C:\\作業フォルダー\\画面 1.PNG" },
    { name: "photo.jpeg", path: "C:\\tmp\\photo.jpeg" },
    { name: "notes.txt", path: "C:\\tmp\\notes.txt" },
    { name: "photo.bmp", path: "C:\\tmp\\photo.bmp" },
    { name: "camera.heic", path: "C:\\tmp\\camera.heic" },
  ]);
  assert.deepEqual(Array.from(result), ["C:\\作業フォルダー\\画面 1.PNG", "C:\\tmp\\photo.jpeg"]);
});

test("preload rejects missing, oversized, and control-character paths", () => {
  const api = loadPreload((file) => file.path);
  const result = api.getDroppedImagePaths([
    { name: "missing.png", path: "" },
    { name: "large.png", path: "x".repeat(32769) },
    { name: "control.webp", path: "C:\\tmp\\control\n.webp" },
    { name: "good.gif", path: "C:\\tmp\\good.gif" },
  ]);
  assert.deepEqual(Array.from(result), ["C:\\tmp\\good.gif"]);
});

test("preload skips a file when Electron cannot resolve its native path", () => {
  const api = loadPreload((file) => {
    if (file.name === "broken.png") throw new Error("no native path");
    return file.path;
  });
  assert.deepEqual(Array.from(api.getDroppedImagePaths([
    { name: "broken.png", path: "" },
    { name: "good.webp", path: "C:\\tmp\\good.webp" },
  ])), ["C:\\tmp\\good.webp"]);
});

test("preload caps a multi-image drop at ten and safely rejects non-array input", () => {
  const api = loadPreload((file) => file.path);
  const files = Array.from({ length: 12 }, (_, index) => ({ name: `${index}.png`, path: `C:\\${index}.png` }));
  assert.equal(api.getDroppedImagePaths(files).length, 10);
  assert.deepEqual(Array.from(api.getDroppedImagePaths(null)), []);
});
