const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("DailyStudio website branding is used by the app and Windows/macOS packages", () => {
  const app = JSON.parse(read("package.json"));
  const websiteFavicon = fs.readFileSync(path.join(root, "public/dailystudio-favicon.png"));

  assert.deepEqual(fs.readFileSync(path.join(root, "build/icon.png")), websiteFavicon);
  assert.equal(app.build.win.icon, "build/icon.png");
  assert.equal(app.build.mac.icon, "build/icon.png");
  assert.match(read("index.html"), /rel="icon"[^>]+href="\.\/dailystudio-favicon\.png"/);
  assert.match(read("src/App.tsx"), /startup-logo" src="\.\/dailystudio-logo\.webp"/);
  assert.match(read("electron/main.cjs"), /path\.join\(app\.getAppPath\(\), "dist", "dailystudio-favicon\.png"\)/);
});
