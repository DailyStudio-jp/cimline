const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("DailyStudio high-resolution icon is used by the app and Windows/macOS packages", () => {
  const app = JSON.parse(read("package.json"));
  const appIcon = read("build/icon.svg");

  assert.equal(read("public/icon.svg"), appIcon);
  assert.equal(app.build.win.icon, "build/icon.svg");
  assert.equal(app.build.mac.icon, "build/icon.svg");
  assert.match(appIcon, /viewBox="0 0 512 512"/);
  assert.doesNotMatch(appIcon, /<image\b|data:image/);
  assert.match(appIcon, /M72 135/); // flag
  assert.match(appIcon, /M234 160/); // flask
  assert.match(appIcon, /M394 178/); // check mark
  assert.match(appIcon, /x="451" y="279"/); // tallest chart bar
  assert.match(read("index.html"), /rel="icon"[^>]+href="\.\/icon\.svg"/);
  assert.match(read("src/App.tsx"), /startup-logo" src="\.\/dailystudio-logo\.webp"/);
  assert.match(read("electron/main.cjs"), /data:image\/svg\+xml;base64/);
});
