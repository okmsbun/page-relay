const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("native global Side Panel replaces the action popup", async () => {
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(fs.existsSync(path.join(root, manifest.side_panel.default_path)));
  const calls = [];
  const context = vm.createContext({ console, chrome: { sidePanel: {
    setPanelBehavior: async (options) => calls.push(JSON.parse(JSON.stringify(options))),
  } } });
  vm.runInContext(fs.readFileSync(path.join(root, manifest.background.service_worker), "utf8"), context);
  assert.deepEqual(calls, [{ openPanelOnActionClick: true }]);
});

test("panel session pins its own window and does not register tab-switch capture handlers", async () => {
  const captures = [], queries = [];
  let activeId = 17;
  const context = vm.createContext({ chrome: {
    windows: { getCurrent: async () => ({ id: 4 }) },
    tabs: { query: async (options) => { queries.push(JSON.parse(JSON.stringify(options))); return [{ id: activeId, windowId: 4 }]; } },
  }, startPopupCapture: async (source) => captures.push(await source) });
  vm.runInContext(fs.readFileSync(path.join(root, "sidepanel-session.js"), "utf8"), context);
  await new Promise(setImmediate);
  activeId = 99; // A different foreground tab must not recapture or reset this session.
  await new Promise(setImmediate);
  assert.deepEqual(queries, [{ active: true, windowId: 4 }]);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, 17);
  assert.equal(captures[0].windowId, 4);
  assert.ok(Object.isFrozen(captures[0]));
});

test("manifest/action icons use supplied correctly sized PNGs and panel uses final branding", () => {
  for (const size of [16, 32, 48, 128, 1024]) {
    const file = `assets/icons/icon-${size}.png`;
    const png = fs.readFileSync(path.join(root, file));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    if (size !== 1024) {
      assert.equal(manifest.icons[size], file);
      assert.equal(manifest.action.default_icon[size], file);
    }
  }
  const html = fs.readFileSync(path.join(root, manifest.side_panel.default_path), "utf8");
  assert.match(html, /class="app-icon" src="assets\/icons\/icon-48.png"/);
  assert.match(html, /srcset="[^"]*icon-128.png 2x"/);
  assert.match(html, /rel="icon"[^>]+icon-32.png/);
});
