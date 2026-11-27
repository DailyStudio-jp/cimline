const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomically } = require("../electron/shared/file-utils.cjs");

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cimline-atomic-write-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("writeFileAtomically creates parent directories and writes UTF-8 contents", () => withTempDirectory(async (directory) => {
  const filePath = path.join(directory, "nested", "settings.json");
  const contents = "{\"theme\":\"ライト\"}";

  await writeFileAtomically(filePath, contents);

  assert.equal(await fs.readFile(filePath, "utf8"), contents);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["settings.json"]);
}));

test("writeFileAtomically replaces an existing file", () => withTempDirectory(async (directory) => {
  const filePath = path.join(directory, "sessions.json");
  await fs.writeFile(filePath, "old", "utf8");

  await writeFileAtomically(filePath, "new");

  assert.equal(await fs.readFile(filePath, "utf8"), "new");
  assert.deepEqual(await fs.readdir(directory), ["sessions.json"]);
}));

test("writeFileAtomically removes the temporary file when rename fails", () => withTempDirectory(async (directory) => {
  const destinationDirectory = path.join(directory, "already-a-directory");
  await fs.mkdir(destinationDirectory);

  await assert.rejects(writeFileAtomically(destinationDirectory, "cannot replace directory"));

  assert.deepEqual(await fs.readdir(directory), ["already-a-directory"]);
  assert.deepEqual(await fs.readdir(destinationDirectory), []);
}));
