const fs = require("node:fs").promises;
const path = require("node:path");

async function writeFileAtomically(filePath, contents) {
  const temporaryPath = filePath + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".tmp";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { writeFileAtomically };
